import { BoardError } from './errors.mjs';
import {
  createDispatchCapability,
  dispatchBackgroundJob,
} from './background.mjs';
import { createJobStore } from './job-store.mjs';
import { TERMINAL_JOB_STATES, hashDispatchCapability } from './jobs.mjs';
import {
  claimRepositoryJob,
  clearRepositoryJob,
  ensureCatalogRepository,
  readOrCreateRepositoryState,
  readRepositoryState,
} from './report-store.mjs';
import {
  ensureSetupSpendLedger,
  fenceSetupReservation,
  readSetupSpendSummary,
  releaseSetupAttempt,
  removeCompletedSetupSpend,
  reserveSetupSpend,
} from './spend-store.mjs';

const OWNER_ID = 99961;
const HEX_40 = /^[a-f0-9]{40}$/u;
const TERMINAL = new Set(TERMINAL_JOB_STATES);
const PRE_PROVIDER = new Set(['created', 'reserved', 'dispatchable']);
const REJECTION_CODES = Object.freeze({
  'discussion-required': 'budget_discussion_required',
  'budget-exhausted': 'budget_exhausted',
  'pricing-review-required': 'pricing_review_required',
  'pricing-expired': 'pricing_review_required',
  stopped: 'analysis_unavailable',
  capacity: 'analysis_unavailable',
  conflict: 'analysis_unavailable',
});

const unavailable = () => new BoardError('service_unavailable');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const iso = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));

function clockTimestamp(now) {
  const value = now();
  const timestamp =
    typeof value === 'number' && Number.isFinite(value)
      ? new Date(value).toISOString()
      : value;
  if (!iso(timestamp)) throw unavailable();
  return timestamp;
}

function transitionTimestamp(job, now) {
  const current = clockTimestamp(now);
  return Date.parse(current) < Date.parse(job.updatedAt)
    ? job.updatedAt
    : current;
}

function boundedDispatchSignal(input) {
  const signals = [];
  for (const signal of [input.signal, input.budget?.signal]) {
    if (signal && !signals.includes(signal)) signals.push(signal);
  }
  if (
    typeof input.budget?.remainingMs === 'function' &&
    Number.isSafeInteger(input.budget?.limits?.requestMs)
  ) {
    const remaining = Math.floor(input.budget.remainingMs());
    signals.push(
      remaining <= 0
        ? AbortSignal.abort()
        : AbortSignal.timeout(
            Math.min(input.budget.limits.requestMs, remaining),
          ),
    );
  }
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function pinnedIdentity(repository) {
  const keys = [
    'id',
    'fullName',
    'name',
    'private',
    'url',
    'defaultBranch',
    'defaultTip',
  ];
  const fullName =
    typeof repository?.fullName === 'string'
      ? repository.fullName.split('/')
      : [];
  if (
    !exact(repository, keys) ||
    !Number.isSafeInteger(repository.id) ||
    repository.id < 1 ||
    typeof repository.fullName !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.fullName) ||
    fullName[0].toLowerCase() !== 'cboone' ||
    typeof repository.name !== 'string' ||
    repository.name !== fullName[1] ||
    typeof repository.private !== 'boolean' ||
    repository.url !== `https://github.com/${repository.fullName}` ||
    typeof repository.defaultBranch !== 'string' ||
    !repository.defaultBranch ||
    /[\s\u0000-\u001f\u007f-\u009f]/u.test(repository.defaultBranch) ||
    repository.defaultBranch
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    !HEX_40.test(repository.defaultTip)
  )
    throw unavailable();
  return Object.freeze({
    id: repository.id,
    fullName: repository.fullName,
    name: repository.name,
    private: repository.private,
    url: repository.url,
  });
}

function claimMatches(state, job) {
  return (
    state !== null &&
    same(state.repository, {
      id: job.repositoryId,
      fullName: state.repository.fullName,
      name: state.repository.name,
      private: state.repository.private,
      url: state.repository.url,
    }) &&
    same(state.activeJob, {
      jobId: job.jobId,
      operation: job.operation,
      expectedCurrentReportId: job.expectedCurrentReportId,
      admittedAt: job.createdAt,
    })
  );
}

function identityMatches(state, identity) {
  return state !== null && same(state.repository, identity);
}

function reservationMatches(job, reservation) {
  return (
    job.pricePolicyId === reservation.policyId &&
    same(
      job.attempts.map((attempt) => attempt.reservationMicrousd),
      reservation.reservationMicrousd,
    ) &&
    same(job.accounting, reservation.accounting)
  );
}

function terminalAttempt(job) {
  if (!TERMINAL.has(job.state) || job.terminal === null) throw unavailable();
  return Object.freeze({
    jobId: job.jobId,
    operation: job.operation,
    status: job.state,
    completedAt: job.terminal.completedAt,
    errorCode: job.terminal.errorCode,
  });
}

function spendContext(configuration, input) {
  return {
    storage: configuration.spendStorage,
    budget: input.budget,
    deployId: configuration.deployId,
    ...(configuration.pricingAttestation === undefined
      ? {}
      : { pricingAttestation: configuration.pricingAttestation }),
  };
}

/** Coordinate one synchronous, pre-provider admission across the durable stores. */
export function createAnalysisAdmission({
  reportStorage,
  jobStorage,
  spendStorage,
  deployId,
  origin,
  pricingAttestation,
  fetchImpl = fetch,
  randomBytes,
  now = Date.now,
}) {
  if (
    !reportStorage ||
    !jobStorage ||
    !spendStorage ||
    typeof deployId !== 'string' ||
    !deployId ||
    typeof origin !== 'string' ||
    typeof fetchImpl !== 'function' ||
    typeof now !== 'function' ||
    (randomBytes !== undefined && typeof randomBytes !== 'function')
  )
    throw unavailable();

  const configuration = {
    reportStorage,
    spendStorage,
    deployId,
    origin,
    pricingAttestation,
  };
  const jobs = createJobStore({ storage: jobStorage });

  async function readState(input, repositoryId) {
    return (
      (
        await readRepositoryState({
          storage: reportStorage,
          budget: input.budget,
          repositoryId,
        })
      )?.state ?? null
    );
  }

  async function readJob(input, jobId) {
    const current = await jobs.readJob({ jobId, budget: input.budget });
    if (current === null) throw unavailable();
    return current;
  }

  async function revalidateReservation(input, identity, details) {
    const current = await readJob(input, details.jobId);
    const state = await readState(input, identity.id);
    if (
      !identityMatches(state, identity) ||
      !claimMatches(state, current.value) ||
      current.value.ownerId !== input.ownerId ||
      current.value.repositoryId !== identity.id ||
      current.value.operation !== input.operation ||
      current.value.expectedCurrentReportId !== input.expectedCurrentReportId ||
      current.value.admissionDeployId !== deployId ||
      current.value.authorizationEpoch !== input.authorizationEpoch
    )
      return false;
    if (details.kind === 'reservation')
      return (
        current.value.state === 'created' &&
        current.value.accounting.status === 'unreserved' &&
        Date.parse(clockTimestamp(now)) <
          Date.parse(current.value.stateDeadlineAt)
      );
    return (
      details.kind === 'existing-reservation' &&
      ['created', 'reserved'].includes(current.value.state) &&
      ['unreserved', 'pending'].includes(current.value.accounting.status)
    );
  }

  async function terminate(input, current, status, errorCode) {
    if (TERMINAL.has(current.value.state)) return { won: true, current };
    if (!PRE_PROVIDER.has(current.value.state)) return { won: false, current };
    const at = transitionTimestamp(current.value, now);
    const result = await jobs.applyTransition({
      jobId: current.value.jobId,
      budget: input.budget,
      expectedEtag: current.etag,
      event: {
        type: 'terminated',
        at,
        status,
        errorCode,
        attemptTokenHash: null,
        finalizationTokenHash: null,
        freeTokenHash: null,
        recovery: Date.parse(at) >= Date.parse(current.value.stateDeadlineAt),
      },
    });
    if (['updated', 'recovered'].includes(result.status))
      return { won: true, current: result };
    if (TERMINAL.has(result.value.state)) return { won: true, current: result };
    return { won: false, current: result };
  }

  async function terminalRevalidation(input, identity, jobId, claimRequired) {
    const current = await readJob(input, jobId);
    const state = await readState(input, identity.id);
    if (!TERMINAL.has(current.value.state) || !identityMatches(state, identity))
      return false;
    return claimRequired
      ? claimMatches(state, current.value)
      : state.activeJob?.jobId !== jobId;
  }

  async function recordTerminalAccounting(
    input,
    current,
    accounting,
    attemptUpdates,
  ) {
    if (current.value.accounting.status === 'complete') return current;
    const result = await jobs.applyTransition({
      jobId: current.value.jobId,
      budget: input.budget,
      expectedEtag: current.etag,
      event: {
        type: 'accounting-recorded',
        at: transitionTimestamp(current.value, now),
        deadlineAt: null,
        attemptTokenHash: null,
        finalizationTokenHash: null,
        attemptUpdates,
        accounting,
      },
    });
    if (['updated', 'recovered'].includes(result.status)) return result;
    if (
      TERMINAL.has(result.value.state) &&
      same(result.value.accounting, accounting)
    )
      return result;
    throw unavailable();
  }

  async function cleanupTerminal(input, identity, current, claimRequired) {
    let job = current;
    if (!TERMINAL.has(job.value.state)) throw unavailable();
    const context = spendContext(configuration, input);
    let completedAccounting = job.value.accounting;
    if (completedAccounting.status === 'unknown') {
      if (claimRequired)
        await clearRepositoryJob({
          storage: reportStorage,
          budget: input.budget,
          repositoryId: identity.id,
          jobId: job.value.jobId,
          lastAnalysisAttempt: terminalAttempt(job.value),
        });
      return job;
    }
    if (
      completedAccounting.status === 'pending' &&
      job.value.attempts.some(
        (attempt) => !['reserved', 'released'].includes(attempt.state),
      )
    )
      return job;
    if (completedAccounting.status !== 'complete') {
      const fence = await fenceSetupReservation({
        ...context,
        jobId: job.value.jobId,
        operation: job.value.operation,
        at: transitionTimestamp(job.value, now),
        revalidate: () =>
          terminalRevalidation(input, identity, job.value.jobId, claimRequired),
      });
      if (fence.status === 'fenced') {
        completedAccounting = {
          status: 'complete',
          ledgerRevision: null,
          accountingSequence: null,
          accountingDigest: null,
          transitionId: null,
        };
        job = await recordTerminalAccounting(
          input,
          job,
          completedAccounting,
          [],
        );
      } else if (fence.status === 'existing') {
        let accounting = fence.accounting;
        for (const attemptNumber of [1, 2]) {
          const released = await releaseSetupAttempt({
            ...context,
            jobId: job.value.jobId,
            attemptNumber,
            at: transitionTimestamp(job.value, now),
            revalidate: () =>
              terminalRevalidation(
                input,
                identity,
                job.value.jobId,
                claimRequired,
              ),
          });
          accounting = released.accounting;
        }
        if (accounting.status !== 'complete') throw unavailable();
        completedAccounting = accounting;
        const attemptUpdates = job.value.attempts
          .filter((attempt) => attempt.state === 'reserved')
          .map((attempt) => ({ number: attempt.number, state: 'released' }));
        job = await recordTerminalAccounting(
          input,
          job,
          accounting,
          attemptUpdates,
        );
      } else {
        throw unavailable();
      }
    }
    if (completedAccounting.ledgerRevision !== null)
      await removeCompletedSetupSpend({
        ...context,
        jobId: job.value.jobId,
        accounting: completedAccounting,
        at: transitionTimestamp(job.value, now),
      });
    if (claimRequired)
      await clearRepositoryJob({
        storage: reportStorage,
        budget: input.budget,
        repositoryId: identity.id,
        jobId: job.value.jobId,
        lastAnalysisAttempt: terminalAttempt(job.value),
      });
    return job;
  }

  async function safe(input, jobId) {
    return jobs.safeJob({
      jobId,
      ownerId: input.ownerId,
      budget: input.budget,
    });
  }

  async function dispatchCapability(input, jobId, capability) {
    const signal = boundedDispatchSignal(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await dispatchBackgroundJob({
          origin,
          jobId,
          capability,
          fetchImpl,
          signal,
        });
        break;
      } catch {
        // The second uncertain result leaves the one durable capability for
        // nonpaid deadline recovery; it never creates another reservation.
      }
    }
    return safe(input, jobId);
  }

  async function rejectReservation(input, identity, current, code) {
    const terminal = await terminate(input, current, 'budget-blocked', code);
    if (!terminal.won) return safe(input, current.value.jobId);
    await cleanupTerminal(input, identity, terminal.current, true);
    throw new BoardError(code);
  }

  async function cleanupOwnedFailure(input, identity, jobId) {
    const current = await readJob(input, jobId);
    const state = await readState(input, identity.id);
    if (!claimMatches(state, current.value)) return;
    if (TERMINAL.has(current.value.state)) {
      await cleanupTerminal(input, identity, current, true);
      return;
    }
    if (!PRE_PROVIDER.has(current.value.state)) return;
    const terminal = await terminate(
      input,
      current,
      'failed',
      'analysis_unavailable',
    );
    if (terminal.won)
      await cleanupTerminal(input, identity, terminal.current, true);
  }

  async function admit(input) {
    if (
      !input ||
      typeof input !== 'object' ||
      input.ownerId !== OWNER_ID ||
      !input.budget ||
      !Number.isSafeInteger(input.authorizationEpoch) ||
      input.authorizationEpoch < 1 ||
      !iso(input.deadlineAt)
    )
      throw new BoardError('invalid_request');
    const identity = pinnedIdentity(input.repository);
    const admittedAt = clockTimestamp(now);
    await ensureCatalogRepository({
      storage: reportStorage,
      budget: input.budget,
      repository: identity,
      at: admittedAt,
    });
    await readOrCreateRepositoryState({
      storage: reportStorage,
      budget: input.budget,
      repository: identity,
    });
    await ensureSetupSpendLedger({
      ...spendContext(configuration, input),
      at: admittedAt,
    });
    let current = await jobs.createOrReadJob({
      ownerId: input.ownerId,
      repositoryId: identity.id,
      idempotencyKey: input.idempotencyKey,
      operation: input.operation,
      expectedCurrentReportId: input.expectedCurrentReportId,
      authorizationEpoch: input.authorizationEpoch,
      admissionDeployId: deployId,
      at: admittedAt,
      deadlineAt: input.deadlineAt,
      budget: input.budget,
    });
    if (
      current.value.admissionDeployId !== deployId ||
      current.value.authorizationEpoch !== input.authorizationEpoch
    )
      return safe(input, current.value.jobId);

    if (TERMINAL.has(current.value.state)) {
      const state = await readState(input, identity.id);
      if (claimMatches(state, current.value))
        await cleanupTerminal(input, identity, current, true);
      return safe(input, current.value.jobId);
    }

    try {
      await claimRepositoryJob({
        storage: reportStorage,
        budget: input.budget,
        repositoryId: identity.id,
        jobId: current.value.jobId,
        operation: current.value.operation,
        expectedCurrentReportId: current.value.expectedCurrentReportId,
        admittedAt: current.value.createdAt,
      });
    } catch (error) {
      const state = await readState(input, identity.id);
      if (claimMatches(state, current.value)) {
        // The conditional write committed and only its acknowledgement was lost.
      } else {
        const terminal = await terminate(
          input,
          current,
          'superseded',
          'superseded',
        );
        if (terminal.won)
          await cleanupTerminal(input, identity, terminal.current, false);
        throw error instanceof BoardError ? error : unavailable();
      }
    }

    let preserveDispatchable = false;
    try {
      current = await readJob(input, current.value.jobId);
      if (TERMINAL.has(current.value.state)) {
        if (current.value.accounting.status !== 'complete')
          await cleanupTerminal(input, identity, current, true);
        return safe(input, current.value.jobId);
      }
      if (!PRE_PROVIDER.has(current.value.state))
        return safe(input, current.value.jobId);
      if (current.value.state === 'dispatchable') {
        preserveDispatchable = true;
        const capability = createDispatchCapability(randomBytes);
        const capabilityHash = hashDispatchCapability(capability);
        const rotated = await jobs.applyTransition({
          jobId: current.value.jobId,
          budget: input.budget,
          expectedEtag: current.etag,
          event: {
            type: 'dispatch-rotated',
            at: transitionTimestamp(current.value, now),
            deadlineAt: current.value.stateDeadlineAt,
            previousCapabilityHash: current.value.dispatchCapabilityHash,
            capabilityHash,
          },
        });
        current = rotated;
        if (
          !['updated', 'recovered'].includes(rotated.status) ||
          rotated.value.state !== 'dispatchable' ||
          rotated.value.dispatchCapabilityHash !== capabilityHash
        )
          return safe(input, rotated.value.jobId);
        return dispatchCapability(input, rotated.value.jobId, capability);
      }

      const summary = await readSetupSpendSummary({
        ...spendContext(configuration, input),
        at: clockTimestamp(now),
      });
      if (summary.status === 'pricing-expired')
        return rejectReservation(
          input,
          identity,
          current,
          REJECTION_CODES[summary.status],
        );

      const reservation = await reserveSetupSpend({
        ...spendContext(configuration, input),
        jobId: current.value.jobId,
        operation: current.value.operation,
        at: clockTimestamp(now),
        revalidate: (details) =>
          revalidateReservation(input, identity, details),
      });
      if (Object.hasOwn(REJECTION_CODES, reservation.status))
        return rejectReservation(
          input,
          identity,
          current,
          REJECTION_CODES[reservation.status],
        );
      if (!['reserved', 'existing'].includes(reservation.status))
        throw unavailable();

      current = await readJob(input, current.value.jobId);
      if (current.value.state === 'created') {
        const result = await jobs.applyTransition({
          jobId: current.value.jobId,
          budget: input.budget,
          expectedEtag: current.etag,
          event: {
            type: 'reservation-committed',
            at: transitionTimestamp(current.value, now),
            deadlineAt: input.deadlineAt,
            pricePolicyId: reservation.policyId,
            reservationMicrousd: reservation.reservationMicrousd,
            accounting: reservation.accounting,
          },
        });
        current = result;
        if (
          result.status === 'conflict' &&
          !reservationMatches(result.value, reservation)
        ) {
          if (TERMINAL.has(result.value.state))
            await cleanupTerminal(input, identity, result, true);
          return safe(input, result.value.jobId);
        }
      }
      if (!reservationMatches(current.value, reservation)) throw unavailable();
      if (current.value.state !== 'reserved')
        return safe(input, current.value.jobId);

      const capability = createDispatchCapability(randomBytes);
      const capabilityHash = hashDispatchCapability(capability);
      const installed = await jobs.applyTransition({
        jobId: current.value.jobId,
        budget: input.budget,
        expectedEtag: current.etag,
        event: {
          type: 'dispatch-installed',
          at: transitionTimestamp(current.value, now),
          deadlineAt: input.deadlineAt,
          capabilityHash,
        },
      });
      current = installed;
      if (
        !['updated', 'recovered'].includes(installed.status) ||
        installed.value.state !== 'dispatchable' ||
        installed.value.dispatchCapabilityHash !== capabilityHash
      )
        return safe(input, installed.value.jobId);
      preserveDispatchable = true;
      return dispatchCapability(input, installed.value.jobId, capability);
    } catch (error) {
      if (!preserveDispatchable)
        await cleanupOwnedFailure(input, identity, current.value.jobId);
      throw error instanceof BoardError ? error : unavailable();
    }
  }

  return Object.freeze({ admit });
}
