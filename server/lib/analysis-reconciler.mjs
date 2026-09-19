import { BoardError } from './errors.mjs';
import { classifyJobRecovery } from './job-machine.mjs';
import { createJobStore } from './job-store.mjs';
import { TERMINAL_JOB_STATES } from './jobs.mjs';
import {
  clearRepositoryJob,
  readCurrentReportEnvelope,
  readReportEnvelope,
  readRepositoryState,
  repairCatalogRepository,
  rotateRepositoryReport,
  writeImmutableReportVersion,
} from './report-store.mjs';
import { successfulReportVersionDigest } from './report-versions.mjs';
import {
  fenceSetupReservation,
  listSetupSpendReservations,
  markSetupAttemptUnknown,
  readSetupSpendReservation,
  releaseSetupAttempt,
  removeCompletedSetupSpend,
  settleSetupAttempt,
} from './spend-store.mjs';

export const ANALYSIS_RECONCILIATION_LIMITS = Object.freeze({
  transitions: 16,
  bookkeepingMs: 90_000,
});

const TERMINAL = new Set(TERMINAL_JOB_STATES);
const PROVIDER_REFUSALS = new Set([
  'analysis_provider_rate_limited',
  'analysis_provider_unavailable',
]);
const HEX_64 = /^[a-f0-9]{64}$/u;
const unavailable = () => new BoardError('service_unavailable');
const clone = (value) => structuredClone(value);

function timestamp(value) {
  const result =
    typeof value === 'number' && Number.isFinite(value)
      ? new Date(value).toISOString()
      : value;
  if (
    typeof result !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw unavailable();
  return result;
}

function transitionAt(job, now) {
  const current = timestamp(now());
  return Date.parse(current) < Date.parse(job.updatedAt)
    ? job.updatedAt
    : current;
}

function deadline(
  at,
  milliseconds = ANALYSIS_RECONCILIATION_LIMITS.bookkeepingMs,
) {
  const value = Date.parse(at) + milliseconds;
  if (!Number.isSafeInteger(value)) throw unavailable();
  return new Date(value).toISOString();
}

function exactJob(result, jobId) {
  if (
    result === null ||
    !result ||
    !result.value ||
    result.value.jobId !== jobId ||
    typeof result.etag !== 'string'
  )
    throw unavailable();
  return result;
}

function transitionWon(result) {
  return ['updated', 'recovered'].includes(result.status);
}

function lastAttempt(job) {
  if (!TERMINAL.has(job.state) || job.terminal === null) throw unavailable();
  return Object.freeze({
    jobId: job.jobId,
    operation: job.operation,
    status: job.state,
    completedAt: job.terminal.completedAt,
    errorCode: job.terminal.errorCode,
  });
}

function claimMatches(state, job) {
  return (
    state?.activeJob?.jobId === job.jobId &&
    state.activeJob.operation === job.operation &&
    state.activeJob.expectedCurrentReportId === job.expectedCurrentReportId &&
    state.activeJob.admittedAt === job.createdAt
  );
}

function completedClaimMatches(state, job) {
  const attempt = state?.lastAnalysisAttempt;
  return (
    state?.activeJob === null &&
    attempt?.jobId === job.jobId &&
    attempt.operation === job.operation &&
    attempt.status === job.state &&
    attempt.completedAt === job.terminal?.completedAt &&
    attempt.errorCode === job.terminal?.errorCode
  );
}

function pointerFor(envelope, versionKey) {
  return Object.freeze({
    reportId: envelope.reportId,
    versionKey,
    generatedAt: envelope.generatedAt,
    sourceFingerprint: envelope.source.fingerprint.value,
  });
}

function attemptUpdate(jobAttempt, ledgerAttempt) {
  if (
    jobAttempt.state === 'response-complete' &&
    ledgerAttempt.state === 'settled'
  )
    return { number: jobAttempt.number, state: 'settled' };
  if (jobAttempt.state === 'reserved' && ledgerAttempt.state === 'released')
    return { number: jobAttempt.number, state: 'released' };
  if (jobAttempt.state === 'in-flight' && ledgerAttempt.state === 'unknown')
    return { number: jobAttempt.number, state: 'unknown' };
  if (
    jobAttempt.state === 'unreserved' ||
    jobAttempt.state === ledgerAttempt.state ||
    (jobAttempt.state === 'settled' && ledgerAttempt.state === 'settled') ||
    (jobAttempt.state === 'released' && ledgerAttempt.state === 'released') ||
    (jobAttempt.state === 'unknown' && ledgerAttempt.state === 'unknown')
  )
    return null;
  throw unavailable();
}

function assertServices({ jobs, reports, spend, now }) {
  const requiredJobs = ['readJob', 'applyTransition'];
  const requiredReports = [
    'readRepositoryState',
    'readReportEnvelope',
    'rotateRepositoryReport',
    'clearRepositoryJob',
    'repairCatalogRepository',
  ];
  const requiredSpend = [
    'readReservation',
    'listReservations',
    'fenceReservation',
    'settleAttempt',
    'releaseAttempt',
    'markAttemptUnknown',
    'removeCompleted',
  ];
  if (
    requiredJobs.some((name) => typeof jobs?.[name] !== 'function') ||
    requiredReports.some((name) => typeof reports?.[name] !== 'function') ||
    requiredSpend.some((name) => typeof spend?.[name] !== 'function') ||
    typeof now !== 'function'
  )
    throw unavailable();
}

export function createAnalysisDurableServices(input) {
  if (input.jobs || input.reports || input.spend)
    return { jobs: input.jobs, reports: input.reports, spend: input.spend };
  if (
    !input.jobStorage ||
    !input.reportStorage ||
    !input.spendStorage ||
    typeof input.deployId !== 'string' ||
    input.deployId.length < 1
  )
    throw unavailable();
  const reports = Object.freeze({
    readRepositoryState: (options) =>
      readRepositoryState({ ...options, storage: input.reportStorage }),
    readReportEnvelope: (options) =>
      readReportEnvelope({ ...options, storage: input.reportStorage }),
    readCurrentReportEnvelope: (options) =>
      readCurrentReportEnvelope({ ...options, storage: input.reportStorage }),
    writeImmutableReportVersion: (options) =>
      writeImmutableReportVersion({ ...options, storage: input.reportStorage }),
    rotateRepositoryReport: (options) =>
      rotateRepositoryReport({ ...options, storage: input.reportStorage }),
    clearRepositoryJob: (options) =>
      clearRepositoryJob({ ...options, storage: input.reportStorage }),
    repairCatalogRepository: (options) =>
      repairCatalogRepository({ ...options, storage: input.reportStorage }),
  });
  const spendBase = {
    storage: input.spendStorage,
    deployId: input.deployId,
    ...(input.pricingAttestation === undefined
      ? {}
      : { pricingAttestation: input.pricingAttestation }),
  };
  const spend = Object.freeze({
    readReservation: (options) =>
      readSetupSpendReservation({ ...spendBase, ...options }),
    listReservations: (options) =>
      listSetupSpendReservations({ ...spendBase, ...options }),
    fenceReservation: (options) =>
      fenceSetupReservation({ ...spendBase, ...options }),
    settleAttempt: (options) =>
      settleSetupAttempt({ ...spendBase, ...options }),
    releaseAttempt: (options) =>
      releaseSetupAttempt({ ...spendBase, ...options }),
    markAttemptUnknown: (options) =>
      markSetupAttemptUnknown({ ...spendBase, ...options }),
    removeCompleted: (options) =>
      removeCompletedSetupSpend({ ...spendBase, ...options }),
  });
  return {
    jobs: createJobStore({ storage: input.jobStorage }),
    reports,
    spend,
  };
}

/**
 * Create the bounded, nonpaid recovery coordinator. The supplied services are
 * narrow adapters over the durable job, report, and setup-spend stores. No
 * source or model client is accepted here, so recovery cannot perform paid or
 * repository work.
 */
export function createAnalysisReconciler(input) {
  const now = input?.now ?? Date.now;
  const versionDigest = input?.versionDigest ?? successfulReportVersionDigest;
  const { jobs, reports, spend } = createAnalysisDurableServices(input ?? {});
  if (typeof versionDigest !== 'function') throw unavailable();
  assertServices({ jobs, reports, spend, now });

  async function readJob(jobId, budget) {
    if (typeof jobId !== 'string' || !HEX_64.test(jobId)) throw unavailable();
    return exactJob(await jobs.readJob({ jobId, budget }), jobId);
  }

  async function repositoryState(job, budget) {
    const stored = await reports.readRepositoryState({
      repositoryId: job.repositoryId,
      budget,
    });
    return stored?.state ?? null;
  }

  async function revalidateBookkeeping(jobId, budget) {
    const current = await readJob(jobId, budget);
    const state = await repositoryState(current.value, budget);
    return (
      state !== null &&
      (TERMINAL.has(current.value.state) ||
        (current.value.state === 'published' &&
          claimMatches(state, current.value)))
    );
  }

  async function apply(current, event, budget) {
    return jobs.applyTransition({
      jobId: current.value.jobId,
      expectedEtag: current.etag,
      event,
      budget,
    });
  }

  async function terminateExpired(current, { status, errorCode }, budget) {
    const at = transitionAt(current.value, now);
    const result = await apply(
      current,
      {
        type: 'terminated',
        at,
        status,
        errorCode,
        attemptTokenHash: null,
        finalizationTokenHash: null,
        freeTokenHash: null,
        recovery: true,
      },
      budget,
    );
    return transitionWon(result)
      ? result
      : readJob(current.value.jobId, budget);
  }

  async function terminateUnowned(current, { status, errorCode }, budget) {
    const at = transitionAt(current.value, now);
    const expired = Date.parse(at) >= Date.parse(current.value.stateDeadlineAt);
    const result = await apply(
      current,
      {
        type: 'terminated',
        at,
        status,
        errorCode,
        attemptTokenHash: null,
        finalizationTokenHash: null,
        freeTokenHash: null,
        recovery: expired,
      },
      budget,
    );
    return transitionWon(result)
      ? result
      : readJob(current.value.jobId, budget);
  }

  async function mutateLedger(current, reservation, budget) {
    const observed = clone(reservation);
    const revalidate = () => revalidateBookkeeping(current.value.jobId, budget);
    for (const jobAttempt of current.value.attempts) {
      let ledgerAttempt = observed.attempts[jobAttempt.number - 1];
      if (!ledgerAttempt) throw unavailable();
      let result = null;
      if (ledgerAttempt.state === 'reserved') {
        const input = {
          jobId: current.value.jobId,
          attemptNumber: jobAttempt.number,
          at: transitionAt(current.value, now),
          budget,
          revalidate,
        };
        if (jobAttempt.state === 'response-complete') {
          if (!Number.isSafeInteger(jobAttempt.costMicrousd))
            throw unavailable();
          result = await spend.settleAttempt({
            ...input,
            actualCostMicrousd: jobAttempt.costMicrousd,
          });
        } else if (jobAttempt.state === 'in-flight') {
          const pricingReviewRequired =
            current.value.terminal?.errorCode === 'pricing_review_required';
          result = await spend.markAttemptUnknown({
            ...input,
            actualCostMicrousd: pricingReviewRequired
              ? jobAttempt.reservationMicrousd
              : 0,
            unknownExposureMicrousd: jobAttempt.reservationMicrousd,
            pricingReviewRequired,
          });
        } else if (['unreserved', 'reserved'].includes(jobAttempt.state)) {
          result = await spend.releaseAttempt(input);
        } else {
          throw unavailable();
        }
      }
      if (result !== null) {
        observed.attempts[jobAttempt.number - 1] = {
          ...ledgerAttempt,
          ...result.attempt,
        };
        observed.accounting = result.accounting;
        ledgerAttempt = observed.attempts[jobAttempt.number - 1];
      }
      attemptUpdate(jobAttempt, ledgerAttempt);
    }
    return observed;
  }

  async function accountTerminal(current, budget) {
    let job = current;
    if (!TERMINAL.has(job.value.state)) throw unavailable();
    let reservation = await spend.readReservation({
      jobId: job.value.jobId,
      budget,
    });
    if (!['complete', 'unknown'].includes(job.value.accounting.status)) {
      if (reservation === null) {
        const fenced = await spend.fenceReservation({
          jobId: job.value.jobId,
          operation: job.value.operation,
          at: transitionAt(job.value, now),
          budget,
          revalidate: () => revalidateBookkeeping(job.value.jobId, budget),
        });
        if (fenced.status === 'existing') {
          reservation = await spend.readReservation({
            jobId: job.value.jobId,
            budget,
          });
          if (reservation === null) throw unavailable();
        } else if (fenced.status === 'fenced') {
          const result = await apply(
            job,
            {
              type: 'accounting-recorded',
              at: transitionAt(job.value, now),
              deadlineAt: null,
              attemptTokenHash: null,
              finalizationTokenHash: null,
              attemptUpdates: [],
              accounting: {
                status: 'complete',
                ledgerRevision: null,
                accountingSequence: null,
                accountingDigest: null,
                transitionId: null,
              },
            },
            budget,
          );
          job = transitionWon(result)
            ? result
            : await readJob(job.value.jobId, budget);
        } else throw unavailable();
      }
    } else if (
      job.value.accounting.status === 'unknown' &&
      reservation === null
    )
      throw unavailable();

    if (reservation !== null) {
      const settled = await mutateLedger(job, reservation, budget);
      const updates = job.value.attempts
        .map((attempt, index) =>
          attemptUpdate(attempt, settled.attempts[index]),
        )
        .filter(Boolean);
      if (
        updates.length > 0 ||
        JSON.stringify(settled.accounting) !==
          JSON.stringify(job.value.accounting)
      ) {
        const result = await apply(
          job,
          {
            type: 'accounting-recorded',
            at: transitionAt(job.value, now),
            deadlineAt: null,
            attemptTokenHash: null,
            finalizationTokenHash: null,
            attemptUpdates: updates,
            accounting: settled.accounting,
          },
          budget,
        );
        job = transitionWon(result)
          ? result
          : await readJob(job.value.jobId, budget);
      }
    }

    if (
      job.value.accounting.status === 'complete' &&
      job.value.accounting.ledgerRevision !== null
    )
      await spend.removeCompleted({
        jobId: job.value.jobId,
        accounting: job.value.accounting,
        at: transitionAt(job.value, now),
        budget,
      });

    const state = await repositoryState(job.value, budget);
    let clearedState = state;
    if (claimMatches(state, job.value)) {
      const cleared = await reports.clearRepositoryJob({
        repositoryId: job.value.repositoryId,
        jobId: job.value.jobId,
        lastAnalysisAttempt: lastAttempt(job.value),
        budget,
      });
      clearedState = cleared.state;
    } else if (completedClaimMatches(state, job.value)) clearedState = state;
    await reports.repairCatalogRepository({
      repositoryState: clearedState,
      at: transitionAt(job.value, now),
      budget,
    });
    return job;
  }

  async function accountPublished(current, budget) {
    let job = current;
    if (job.value.state !== 'published') throw unavailable();
    if (job.value.accounting.status !== 'complete') {
      const reservation = await spend.readReservation({
        jobId: job.value.jobId,
        budget,
      });
      if (reservation === null) throw unavailable();
      const settled = await mutateLedger(job, reservation, budget);
      const updates = job.value.attempts
        .map((attempt, index) =>
          attemptUpdate(attempt, settled.attempts[index]),
        )
        .filter(Boolean);
      const at = transitionAt(job.value, now);
      const result = await apply(
        job,
        {
          type: 'accounting-recorded',
          at,
          deadlineAt: deadline(at),
          attemptTokenHash: null,
          finalizationTokenHash: null,
          attemptUpdates: updates,
          accounting: settled.accounting,
        },
        budget,
      );
      job = transitionWon(result)
        ? result
        : await readJob(job.value.jobId, budget);
    }
    if (job.value.state === 'published') {
      const result = await apply(
        job,
        { type: 'succeeded', at: transitionAt(job.value, now) },
        budget,
      );
      job = transitionWon(result)
        ? result
        : await readJob(job.value.jobId, budget);
    }
    return accountTerminal(job, budget);
  }

  async function storedCandidate(job, budget) {
    if (job.publication.candidateDigest === null) return null;
    const stored = await reports.readReportEnvelope({
      repositoryId: job.repositoryId,
      reportId: job.publication.reportId,
      budget,
    });
    if (
      stored === null ||
      stored.envelope.jobId !== job.jobId ||
      stored.key !== job.publication.versionKey
    )
      return null;
    return versionDigest(stored.envelope) === job.publication.candidateDigest
      ? stored
      : null;
  }

  async function publishVersion(current, budget) {
    let job = current;
    const stored = await storedCandidate(job.value, budget);
    if (stored === null)
      return terminateUnowned(
        job,
        { status: 'superseded', errorCode: 'superseded' },
        budget,
      );
    const before = await repositoryState(job.value, budget);
    if (!claimMatches(before, job.value))
      return terminateUnowned(
        job,
        { status: 'superseded', errorCode: 'superseded' },
        budget,
      );
    const alreadyRotated =
      before.current?.reportId === stored.envelope.reportId &&
      (before.previous?.reportId ?? null) === job.value.expectedCurrentReportId;
    const awaitingRotation =
      (before.current?.reportId ?? null) === job.value.expectedCurrentReportId;
    if (!alreadyRotated && !awaitingRotation)
      return terminateUnowned(
        job,
        { status: 'superseded', errorCode: 'superseded' },
        budget,
      );
    if (!alreadyRotated) {
      const cleanupCandidateKey = before.previous?.versionKey ?? null;
      if (
        cleanupCandidateKey !== null &&
        job.value.publication.cleanupCandidateKey === null
      ) {
        const at = transitionAt(job.value, now);
        const recorded = await apply(
          job,
          {
            type: 'cleanup-candidate-recorded',
            at,
            deadlineAt: deadline(at),
            cleanupCandidateKey,
          },
          budget,
        );
        job = transitionWon(recorded)
          ? recorded
          : await readJob(job.value.jobId, budget);
        if (job.value.state !== 'version-written') return job;
      }
      if (job.value.publication.cleanupCandidateKey !== cleanupCandidateKey)
        return terminateUnowned(
          job,
          { status: 'superseded', errorCode: 'superseded' },
          budget,
        );
    }
    let rotated;
    try {
      rotated = await reports.rotateRepositoryReport({
        repositoryId: job.value.repositoryId,
        jobId: job.value.jobId,
        expectedCurrentReportId: job.value.expectedCurrentReportId,
        current: pointerFor(stored.envelope, stored.key),
        budget,
      });
    } catch (error) {
      if (error instanceof BoardError && error.code === 'report_state_changed')
        return terminateUnowned(
          job,
          { status: 'superseded', errorCode: 'superseded' },
          budget,
        );
      throw error;
    }
    const at = transitionAt(job.value, now);
    const result = await apply(
      job,
      {
        type: 'report-published',
        at,
        deadlineAt: deadline(at),
        pointerRevision: rotated.state.revision,
      },
      budget,
    );
    return transitionWon(result) ? result : readJob(job.value.jobId, budget);
  }

  async function reconcileOne({ jobId, repositoryId = null, budget }) {
    let current = await readJob(jobId, budget);
    if (repositoryId !== null && current.value.repositoryId !== repositoryId)
      throw unavailable();
    for (
      let step = 0;
      step < ANALYSIS_RECONCILIATION_LIMITS.transitions;
      step += 1
    ) {
      const at = transitionAt(current.value, now);
      const candidate = await storedCandidate(current.value, budget);
      if (current.value.state === 'published' && candidate === null)
        throw unavailable();
      const classification = classifyJobRecovery(current.value, {
        at,
        versionDigest:
          candidate === null ? null : versionDigest(candidate.envelope),
      });
      if (
        classification.action.startsWith('wait-') ||
        (classification.action === 'reclaim-or-fence-free-work' &&
          Date.parse(at) < Date.parse(current.value.stateDeadlineAt))
      )
        return current;

      if (classification.action === 'reclaim-or-fence-free-work')
        current = await terminateExpired(
          current,
          { status: 'failed', errorCode: 'source_timeout' },
          budget,
        );
      else if (classification.action === 'fence-pre-provider')
        current = await terminateExpired(
          current,
          { status: 'failed', errorCode: 'analysis_unavailable' },
          budget,
        );
      else if (classification.action === 'fence-paid-ambiguous')
        current = await terminateExpired(
          current,
          { status: 'ambiguous', errorCode: 'analysis_ambiguous' },
          budget,
        );
      else if (
        classification.action === 'fence-failed-and-settle-known-usage' ||
        classification.action === 'fence-primary-invalid-and-release-corrective'
      ) {
        const attempt =
          classification.attemptNumber === undefined
            ? null
            : current.value.attempts[classification.attemptNumber - 1];
        const refusalCode =
          attempt?.terminalClass === 'provider-refusal' &&
          PROVIDER_REFUSALS.has(attempt.terminalStopReason)
            ? attempt.terminalStopReason
            : null;
        current = await terminateExpired(
          current,
          {
            status: 'failed',
            errorCode: refusalCode ?? 'analysis_output_invalid',
          },
          budget,
        );
      } else if (classification.action === 'advance-version-written') {
        const result = await apply(
          current,
          {
            type: 'recovered-version-confirmed',
            at,
            candidateDigest: current.value.publication.candidateDigest,
            deadlineAt: deadline(at),
          },
          budget,
        );
        current = transitionWon(result) ? result : await readJob(jobId, budget);
      } else if (classification.action === 'resume-publication')
        current = await publishVersion(current, budget);
      else if (classification.action === 'resume-success-finalization')
        return accountPublished(current, budget);
      else if (
        classification.action === 'resume-terminal-accounting' ||
        classification.action === 'verify-terminal-accounting'
      )
        return accountTerminal(current, budget);
      else throw unavailable();

      current = await readJob(jobId, budget);
    }
    throw unavailable();
  }

  async function reconcile({
    ownerId = 99961,
    jobId = null,
    repositoryId = null,
    budget,
  }) {
    if (ownerId !== 99961 || !budget) throw new BoardError('forbidden');
    if (jobId !== null && repositoryId !== null) throw unavailable();
    if (jobId === null && repositoryId === null) {
      const reservations = await spend.listReservations({ budget });
      if (!Array.isArray(reservations) || reservations.length > 4)
        throw unavailable();
      const swept = [];
      for (const reservation of reservations) {
        if (
          typeof reservation?.jobId !== 'string' ||
          !HEX_64.test(reservation.jobId)
        )
          throw unavailable();
        swept.push(await reconcileOne({ jobId: reservation.jobId, budget }));
      }
      return swept;
    }
    if (jobId === null) {
      if (!Number.isSafeInteger(repositoryId) || repositoryId < 1)
        throw unavailable();
      const state = await reports.readRepositoryState({ repositoryId, budget });
      if (state === null || state.state.activeJob === null) return null;
      jobId = state.state.activeJob.jobId;
    }
    return reconcileOne({ jobId, repositoryId, budget });
  }

  return Object.freeze({
    reconcile,
    accountTerminal,
    accountPublished,
    publishVersion,
  });
}
