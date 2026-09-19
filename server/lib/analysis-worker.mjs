import { createHash, randomBytes as nativeRandomBytes } from 'node:crypto';
import {
  ANALYSIS_INPUT_LIMITS,
  prepareAnalysisInput,
} from './analysis-input.mjs';
import {
  ANALYSIS_RESULT_CLASSIFICATION,
  AnalysisResultValidationError,
  assembleSuccessfulAnalysisResult,
} from './analysis-result.mjs';
import {
  analysisInputFromCountRequest,
  analysisPriorForSource,
  buildAnalysisRequestPair,
} from './analysis-request.mjs';
import {
  ANTHROPIC_POLICY,
  AnthropicAttemptError,
  AnthropicRefusalError,
  buildCorrectiveAnalysisInput,
  buildCountRequest,
  buildMessageRequest,
} from './anthropic.mjs';
import { BoardError } from './errors.mjs';
import { ownsFinalization, ownsPaidAttempt } from './job-machine.mjs';
import { TERMINAL_JOB_STATES, matchesDispatchCapability } from './jobs.mjs';
import {
  createAnalysisDurableServices,
  createAnalysisReconciler,
} from './analysis-reconciler.mjs';
import { createOperationBudget } from './source-limits.mjs';
import { SETUP_SPEND_LIMITS } from './spend.mjs';
import { ANALYSIS_DELTA_SCHEMA } from '../../src/domain/analysis-wire.js';

export const ANALYSIS_WORKER_LIMITS = Object.freeze({
  invocationMs: 900_000,
  providerCutoffMs: 810_000,
  finalizationMarginMs: 90_000,
  collectionMs: 90_000,
  countMs: 60_000,
  attemptMs: 300_000,
});

const HEX_64 = /^[a-f0-9]{64}$/u;
const unavailable = () => new BoardError('service_unavailable');

function clockMilliseconds(now) {
  const value = now();
  const milliseconds =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) throw unavailable();
  return milliseconds;
}

function timestampAt(milliseconds) {
  if (!Number.isSafeInteger(milliseconds)) throw unavailable();
  return new Date(milliseconds).toISOString();
}

function transitionTime(job, now) {
  return timestampAt(
    Math.max(clockMilliseconds(now), Date.parse(job.updatedAt)),
  );
}

function expiresAt(at, maximum, hardDeadline) {
  const milliseconds = Math.min(Date.parse(at) + maximum, hardDeadline);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= Date.parse(at))
    throw unavailable();
  return timestampAt(milliseconds);
}

function randomToken(randomBytes, domain) {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw unavailable();
  const value = bytes.toString('base64url');
  return Object.freeze({
    value,
    hash: createHash('sha256').update(`${domain}\0${value}`).digest('hex'),
  });
}

function deadlineSignal(signal, milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1)
    throw new BoardError('source_timeout');
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function safeFailureCode(error, fallback = 'analysis_unavailable') {
  const allowed = new Set([
    'analysis_input_too_large',
    'analysis_output_invalid',
    'analysis_provider_rate_limited',
    'analysis_provider_unavailable',
    'analysis_preflight_required',
    'analysis_sensitive_input',
    'analysis_unavailable',
    'pricing_review_required',
    'provider_rate_limited',
    'provider_unavailable',
    'source_authorization_required',
    'source_incomplete',
    'source_limit_exceeded',
    'source_timeout',
    'source_unavailable',
    'source_unstable',
  ]);
  if (error instanceof BoardError && allowed.has(error.code)) return error.code;
  return fallback;
}

const TERMINAL = new Set(TERMINAL_JOB_STATES);

function knownUsageCostMicrousd(error) {
  if (!(error instanceof AnthropicAttemptError)) return null;
  const usage = error.usage;
  const keys = [
    'inputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'outputTokens',
    'inferenceGeo',
    'serviceTier',
  ];
  if (
    usage === null ||
    typeof usage !== 'object' ||
    Array.isArray(usage) ||
    Object.getPrototypeOf(usage) !== Object.prototype ||
    Reflect.ownKeys(usage).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(usage, key)) ||
    !Number.isSafeInteger(usage?.inputTokens) ||
    usage.inputTokens < 0 ||
    usage?.cacheCreationInputTokens !== 0 ||
    usage?.cacheReadInputTokens !== 0 ||
    !Number.isSafeInteger(usage?.outputTokens) ||
    usage.outputTokens < 0 ||
    usage?.inferenceGeo !== ANTHROPIC_POLICY.inferenceGeo ||
    usage?.serviceTier !== ANTHROPIC_POLICY.responseServiceTier
  )
    return null;
  const inputCost = usage.inputTokens * SETUP_SPEND_LIMITS.inputRateMicrousd;
  const outputCost = usage.outputTokens * SETUP_SPEND_LIMITS.outputRateMicrousd;
  const total = inputCost + outputCost;
  return Number.isSafeInteger(inputCost) &&
    Number.isSafeInteger(outputCost) &&
    Number.isSafeInteger(total)
    ? total
    : null;
}

function paidFailure(error, reservationMicrousd) {
  const knownCostMicrousd = knownUsageCostMicrousd(error);
  const exceedsReservation =
    Number.isSafeInteger(reservationMicrousd) &&
    knownCostMicrousd !== null &&
    knownCostMicrousd > reservationMicrousd;
  if (
    (error instanceof AnthropicAttemptError &&
      error.pricingReviewRequired === true) ||
    exceedsReservation
  )
    return {
      kind: 'ambiguous',
      status: 'ambiguous',
      errorCode: 'pricing_review_required',
      knownCostMicrousd,
    };
  if (error instanceof AnthropicAttemptError)
    return {
      kind: 'ambiguous',
      status: 'ambiguous',
      errorCode: 'analysis_ambiguous',
      knownCostMicrousd: null,
    };
  if (
    error instanceof AnthropicRefusalError &&
    [
      'analysis_provider_rate_limited',
      'analysis_provider_unavailable',
    ].includes(error.code)
  )
    return {
      kind: 'refusal',
      status: 'failed',
      errorCode: error.code,
      knownCostMicrousd: null,
    };
  return {
    kind: 'ambiguous',
    status: 'ambiguous',
    errorCode: 'analysis_ambiguous',
    knownCostMicrousd: null,
  };
}

function usageRecord(response, reservationMicrousd) {
  if (response?.model !== ANTHROPIC_POLICY.model)
    throw new AnthropicAttemptError('pricing_review_required', {
      pricingReviewRequired: true,
    });
  const usage = response?.usage;
  const values = [
    usage?.inputTokens,
    usage?.cacheCreationInputTokens,
    usage?.cacheReadInputTokens,
    usage?.outputTokens,
  ];
  if (
    ![null, 'analysis_output_invalid'].includes(response?.validationError) ||
    typeof response?.stopReason !== 'string' ||
    (response.stopReason !== 'end_turn' && response.validationError === null) ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    usage.cacheCreationInputTokens !== 0 ||
    usage.cacheReadInputTokens !== 0 ||
    usage.inferenceGeo !== ANTHROPIC_POLICY.inferenceGeo ||
    usage.serviceTier !== ANTHROPIC_POLICY.responseServiceTier
  )
    throw new AnthropicAttemptError('analysis_ambiguous');
  const costMicrousd =
    usage.inputTokens * SETUP_SPEND_LIMITS.inputRateMicrousd +
    usage.outputTokens * SETUP_SPEND_LIMITS.outputRateMicrousd;
  if (!Number.isSafeInteger(costMicrousd))
    throw new AnthropicAttemptError('pricing_review_required', {
      pricingReviewRequired: true,
    });
  if (
    usage.inputTokens > SETUP_SPEND_LIMITS.attemptInputTokens ||
    usage.outputTokens > SETUP_SPEND_LIMITS.attemptOutputTokens ||
    costMicrousd > reservationMicrousd
  )
    throw new AnthropicAttemptError('pricing_review_required', {
      usage: {
        inputTokens: usage.inputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        outputTokens: usage.outputTokens,
        inferenceGeo: usage.inferenceGeo,
        serviceTier: usage.serviceTier,
      },
      pricingReviewRequired: true,
    });
  return Object.freeze({
    terminalClass:
      response.validationError === null
        ? 'complete-response'
        : 'invalid-response',
    terminalStopReason:
      response.stopReason === 'end_turn' ? 'end_turn' : 'other',
    inputTokens: usage.inputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    outputTokens: usage.outputTokens,
    costMicrousd,
  });
}

function reservationMatches(job, reservation) {
  return (
    reservation !== null &&
    reservation.policyId === job.pricePolicyId &&
    reservation.pricingReviewRequired === false &&
    JSON.stringify(reservation.reservationMicrousd) ===
      JSON.stringify(
        job.attempts.map((attempt) => attempt.reservationMicrousd),
      ) &&
    JSON.stringify(reservation.accounting) === JSON.stringify(job.accounting) &&
    reservation.attempts.every(
      (attempt, index) =>
        attempt.number === index + 1 &&
        attempt.state === 'reserved' &&
        attempt.ceilingMicrousd === job.attempts[index].reservationMicrousd,
    )
  );
}

function claimMatches(state, job) {
  return (
    state?.activeJob?.jobId === job.jobId &&
    state.activeJob.operation === job.operation &&
    state.activeJob.expectedCurrentReportId === job.expectedCurrentReportId &&
    state.activeJob.admittedAt === job.createdAt
  );
}

function assertWorkerServices({
  auth,
  source,
  anthropic,
  jobs,
  reports,
  spend,
}) {
  const requirements = [
    [auth, ['acquireJobToken', 'recheckJobAuthorization']],
    [source, ['checkRepository']],
    [anthropic, ['retrieveModel', 'countTokens', 'createMessage']],
    [jobs, ['readJob', 'applyTransition', 'applyPaidBoundaryTransition']],
    [
      reports,
      [
        'readRepositoryState',
        'readReportEnvelope',
        'writeImmutableReportVersion',
      ],
    ],
    [
      spend,
      [
        'requirePreflight',
        'readReservation',
        'readPaidReservation',
        'settleAttempt',
        'markAttemptUnknown',
      ],
    ],
  ];
  if (
    requirements.some(([service, names]) =>
      names.some((name) => typeof service?.[name] !== 'function'),
    )
  )
    throw unavailable();
}

function assertProviderRequestBounds(analysisInput) {
  try {
    for (const request of [
      buildCountRequest(analysisInput, ANALYSIS_DELTA_SCHEMA),
      buildMessageRequest(analysisInput, ANALYSIS_DELTA_SCHEMA),
    ])
      if (
        Buffer.byteLength(JSON.stringify(request), 'utf8') >
        ANTHROPIC_POLICY.requestBytes
      )
        throw new BoardError('analysis_input_too_large');
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError('analysis_input_too_large');
  }
}

/** Execute one capability-bound background analysis without persisting raw input. */
export function createAnalysisWorker(input) {
  const now = input?.now ?? Date.now;
  const randomBytes = input?.randomBytes ?? nativeRandomBytes;
  const auth = input?.auth;
  const source = input?.sourceOperations;
  const anthropic = input?.anthropicClient;
  const prepareInput = input?.prepareInput ?? prepareAnalysisInput;
  const assembleResult =
    input?.assembleResult ?? assembleSuccessfulAnalysisResult;
  const services = createAnalysisDurableServices(input ?? {});
  const { jobs, reports, spend } = services;
  const reconciler =
    input?.reconciler ?? createAnalysisReconciler({ ...services, now });
  const deployId = input?.deployId;
  const sourceBudgetFactory =
    input?.sourceBudgetFactory ??
    (({ signal, operationMs, startedAt }) =>
      createOperationBudget({
        now: () => clockMilliseconds(now),
        signal,
        limits: { operationMs },
        startedAt,
      }));
  if (
    typeof now !== 'function' ||
    typeof randomBytes !== 'function' ||
    typeof prepareInput !== 'function' ||
    typeof assembleResult !== 'function' ||
    typeof deployId !== 'string' ||
    deployId.length < 1 ||
    typeof sourceBudgetFactory !== 'function'
  )
    throw unavailable();
  assertWorkerServices({ auth, source, anthropic, jobs, reports, spend });

  async function readJob(jobId, budget) {
    const current = await jobs.readJob({ jobId, budget });
    if (current === null || current.value?.jobId !== jobId) throw unavailable();
    return current;
  }

  async function apply(current, event, budget) {
    return jobs.applyTransition({
      jobId: current.value.jobId,
      expectedEtag: current.etag,
      event,
      budget,
    });
  }

  async function applyPaidBoundary(current, event, budget) {
    return jobs.applyPaidBoundaryTransition({
      jobId: current.value.jobId,
      current,
      event,
      budget,
    });
  }

  async function liveClaim(job, budget) {
    const stored = await reports.readRepositoryState({
      repositoryId: job.repositoryId,
      budget,
    });
    return (
      claimMatches(stored?.state, job) &&
      (stored.state.current?.reportId ?? null) === job.expectedCurrentReportId
    );
  }

  async function retainKnownUnknownExposure(
    current,
    number,
    attemptTokenHash,
    knownCostMicrousd,
    budget,
  ) {
    if (knownCostMicrousd === null) return;
    const attempt = current.value.attempts[number - 1];
    if (
      attempt?.tokenHash !== attemptTokenHash ||
      !Number.isSafeInteger(knownCostMicrousd) ||
      knownCostMicrousd < 0
    )
      throw unavailable();
    const paidState =
      number === 1 ? 'primary-in-flight' : 'corrective-in-flight';
    const retained = await spend.markAttemptUnknown({
      jobId: current.value.jobId,
      attemptNumber: number,
      actualCostMicrousd: knownCostMicrousd,
      unknownExposureMicrousd: Math.max(
        attempt.reservationMicrousd,
        knownCostMicrousd,
      ),
      pricingReviewRequired: true,
      at: transitionTime(current.value, now),
      budget,
      revalidate: async () => {
        const fresh = await readJob(current.value.jobId, budget);
        const freshAttempt = fresh.value.attempts[number - 1];
        return (
          freshAttempt?.tokenHash === attemptTokenHash &&
          ((fresh.value.state === paidState &&
            freshAttempt.state === 'in-flight') ||
            (TERMINAL.has(fresh.value.state) &&
              ['in-flight', 'unknown'].includes(freshAttempt.state)))
        );
      },
    });
    if (
      retained.attempt.state !== 'unknown' ||
      retained.attempt.actualCostMicrousd < knownCostMicrousd ||
      retained.attempt.unknownExposureMicrousd < knownCostMicrousd
    )
      throw unavailable();
  }

  async function terminateOwned(
    current,
    {
      status,
      errorCode,
      freeTokenHash = null,
      attemptTokenHash = null,
      finalizationTokenHash = null,
    },
    budget,
  ) {
    const at = transitionTime(current.value, now);
    if (Date.parse(at) >= Date.parse(current.value.stateDeadlineAt))
      return reconciler.reconcile({ jobId: current.value.jobId, budget });
    const result = await apply(
      current,
      {
        type: 'terminated',
        at,
        status,
        errorCode,
        attemptTokenHash,
        finalizationTokenHash,
        freeTokenHash,
        recovery: false,
      },
      budget,
    );
    if (['updated', 'recovered'].includes(result.status))
      return reconciler.accountTerminal(result, budget);
    return reconciler.reconcile({ jobId: current.value.jobId, budget });
  }

  async function failFree(current, tokenHash, error, budget) {
    const fresh = await readJob(current.value.jobId, budget);
    if (
      ['collecting', 'counting'].includes(fresh.value.state) &&
      fresh.value.freeLease.tokenHash === tokenHash &&
      clockMilliseconds(now) < Date.parse(fresh.value.freeLease.expiresAt)
    )
      return terminateOwned(
        fresh,
        {
          status: 'failed',
          errorCode: safeFailureCode(error),
          freeTokenHash: tokenHash,
        },
        budget,
      );
    return reconciler.reconcile({ jobId: fresh.value.jobId, budget });
  }

  async function readOwnedFreeLease(current, tokenHash, phase, budget) {
    const fresh = await readJob(current.value.jobId, budget);
    if (
      fresh.value.state !== phase ||
      fresh.value.freeLease?.tokenHash !== tokenHash ||
      clockMilliseconds(now) >= Date.parse(fresh.value.stateDeadlineAt)
    )
      return null;
    return fresh;
  }

  function freeLeaseWindow(current, runtime) {
    const startedAt = clockMilliseconds(now);
    const deadline = Math.min(
      Date.parse(current.value.stateDeadlineAt),
      runtime.providerCutoff,
    );
    const operationMs = deadline - startedAt;
    if (
      !Number.isSafeInteger(deadline) ||
      !Number.isSafeInteger(operationMs) ||
      operationMs < 1
    )
      throw new BoardError('source_timeout');
    return { startedAt, operationMs };
  }

  async function provePaidAdmission(
    current,
    freeTokenHash,
    lease,
    runtime,
    budget,
  ) {
    const fresh = await readJob(current.value.jobId, budget);
    if (
      fresh.value.state !== 'counting' ||
      fresh.value.freeLease.tokenHash !== freeTokenHash ||
      clockMilliseconds(now) >= Date.parse(fresh.value.freeLease.expiresAt) ||
      !(await liveClaim(fresh.value, budget))
    )
      return null;
    const reservation = await spend.readPaidReservation({
      jobId: fresh.value.jobId,
      at: transitionTime(fresh.value, now),
      requiredThrough: timestampAt(runtime.providerCutoff),
      budget,
    });
    if (!reservationMatches(fresh.value, reservation)) return null;
    if (clockMilliseconds(now) >= Date.parse(reservation.pricingValidThrough))
      throw new BoardError('pricing_review_required');
    await spend.requirePreflight({ budget });
    await auth.recheckJobAuthorization({
      ownerId: fresh.value.ownerId,
      authorizationEpoch: fresh.value.authorizationEpoch,
      generation: lease.generation,
      budget,
    });
    return fresh;
  }

  async function proveCorrectiveAdmission(
    current,
    primaryTokenHash,
    finalizationTokenHash,
    lease,
    runtime,
    budget,
  ) {
    const fresh = await readJob(current.value.jobId, budget);
    if (
      fresh.value.state !== 'primary-invalid' ||
      !ownsFinalization(fresh.value, {
        number: 1,
        tokenHash: finalizationTokenHash,
        at: transitionTime(fresh.value, now),
      }) ||
      fresh.value.attempts[0].tokenHash !== primaryTokenHash ||
      fresh.value.attempts[0].state !== 'settled' ||
      fresh.value.attempts[1].state !== 'reserved' ||
      !(await liveClaim(fresh.value, budget))
    )
      return null;
    const reservation = await spend.readPaidReservation({
      jobId: fresh.value.jobId,
      at: transitionTime(fresh.value, now),
      requiredThrough: timestampAt(runtime.providerCutoff),
      budget,
    });
    if (
      reservation === null ||
      reservation.policyId !== fresh.value.pricePolicyId ||
      reservation.pricingReviewRequired !== false ||
      JSON.stringify(reservation.reservationMicrousd) !==
        JSON.stringify(
          fresh.value.attempts.map((attempt) => attempt.reservationMicrousd),
        ) ||
      JSON.stringify(reservation.accounting) !==
        JSON.stringify(fresh.value.accounting) ||
      reservation.attempts[0]?.state !== 'settled' ||
      reservation.attempts[0]?.actualCostMicrousd !==
        fresh.value.attempts[0].costMicrousd ||
      reservation.attempts[0]?.unknownExposureMicrousd !== 0 ||
      reservation.attempts[1]?.state !== 'reserved' ||
      reservation.attempts[1]?.ceilingMicrousd !==
        fresh.value.attempts[1].reservationMicrousd
    )
      throw unavailable();
    if (clockMilliseconds(now) >= Date.parse(reservation.pricingValidThrough))
      throw new BoardError('pricing_review_required');
    await spend.requirePreflight({ budget });
    await auth.recheckJobAuthorization({
      ownerId: fresh.value.ownerId,
      authorizationEpoch: fresh.value.authorizationEpoch,
      generation: lease.generation,
      budget,
    });
    return fresh;
  }

  function paidWindow(runtime) {
    const at = clockMilliseconds(now);
    const attemptEnd = at + ANALYSIS_WORKER_LIMITS.attemptMs;
    return (
      Number.isSafeInteger(attemptEnd) &&
      attemptEnd <= runtime.providerCutoff &&
      attemptEnd + ANALYSIS_WORKER_LIMITS.finalizationMarginMs <=
        runtime.hardEnd
    );
  }

  async function countTokensBounded({
    analysisInput,
    runtime,
    signal,
    deadlineAt = null,
  }) {
    const countRemaining =
      ANALYSIS_WORKER_LIMITS.countMs - runtime.countSpentMs;
    if (countRemaining < 1)
      throw new BoardError('analysis_provider_unavailable');
    const remaining =
      deadlineAt === null
        ? countRemaining
        : Math.min(
            countRemaining,
            Date.parse(deadlineAt) - clockMilliseconds(now),
          );
    const started = clockMilliseconds(now);
    try {
      return await anthropic.countTokens({
        analysisInput,
        schema: ANALYSIS_DELTA_SCHEMA,
        signal: deadlineSignal(signal, remaining),
      });
    } finally {
      const elapsed = Math.max(0, clockMilliseconds(now) - started);
      runtime.countSpentMs = Math.min(
        ANALYSIS_WORKER_LIMITS.countMs,
        runtime.countSpentMs + elapsed,
      );
    }
  }

  async function crossPrimary(
    current,
    freeTokenHash,
    sourceFingerprint,
    runtime,
    budget,
  ) {
    if (!paidWindow(runtime)) return null;
    const token = randomToken(randomBytes, 'board-primary-attempt-v1');
    const at = transitionTime(current.value, now);
    const result = await applyPaidBoundary(
      current,
      {
        type: 'primary-started',
        at,
        freeTokenHash,
        attemptTokenHash: token.hash,
        deadlineAt: expiresAt(
          at,
          ANALYSIS_WORKER_LIMITS.attemptMs,
          runtime.providerCutoff,
        ),
        sourceFingerprint,
      },
      budget,
    );
    if (
      !['updated', 'recovered'].includes(result.status) ||
      !ownsPaidAttempt(result.value, {
        number: 1,
        tokenHash: token.hash,
        at: transitionTime(result.value, now),
      })
    )
      return null;
    return { current: result, token };
  }

  async function recordResponse(
    current,
    number,
    tokenHash,
    response,
    runtime,
    budget,
  ) {
    const at = transitionTime(current.value, now);
    const usage = usageRecord(
      response,
      current.value.attempts[number - 1].reservationMicrousd,
    );
    if (Date.parse(at) >= Date.parse(current.value.stateDeadlineAt))
      return null;
    const result = await apply(
      current,
      {
        type: 'response-completed',
        at,
        number,
        attemptTokenHash: tokenHash,
        deadlineAt: expiresAt(
          at,
          ANALYSIS_WORKER_LIMITS.finalizationMarginMs,
          runtime.hardEnd,
        ),
        usage,
      },
      budget,
    );
    return ['updated', 'recovered'].includes(result.status) ? result : null;
  }

  async function recordProviderRefusal(
    current,
    number,
    tokenHash,
    errorCode,
    runtime,
    budget,
  ) {
    if (
      ![
        'analysis_provider_rate_limited',
        'analysis_provider_unavailable',
      ].includes(errorCode)
    )
      throw unavailable();
    const at = transitionTime(current.value, now);
    if (Date.parse(at) >= Date.parse(current.value.stateDeadlineAt))
      return null;
    const result = await apply(
      current,
      {
        type: 'response-completed',
        at,
        number,
        attemptTokenHash: tokenHash,
        deadlineAt: expiresAt(
          at,
          ANALYSIS_WORKER_LIMITS.finalizationMarginMs,
          runtime.hardEnd,
        ),
        usage: {
          terminalClass: 'provider-refusal',
          terminalStopReason: errorCode,
          inputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 0,
          costMicrousd: 0,
        },
      },
      budget,
    );
    return ['updated', 'recovered'].includes(result.status) ? result : null;
  }

  async function claimFinalization(
    current,
    number,
    attemptTokenHash,
    runtime,
    budget,
  ) {
    const token = randomToken(randomBytes, `board-finalization-${number}-v1`);
    const at = transitionTime(current.value, now);
    const result = await apply(
      current,
      {
        type: 'finalization-claimed',
        at,
        number,
        attemptTokenHash,
        finalizationTokenHash: token.hash,
        expiresAt: expiresAt(
          at,
          ANALYSIS_WORKER_LIMITS.finalizationMarginMs,
          runtime.hardEnd,
        ),
      },
      budget,
    );
    if (
      !['updated', 'recovered'].includes(result.status) ||
      !ownsFinalization(result.value, {
        number,
        tokenHash: token.hash,
        at: transitionTime(result.value, now),
      })
    )
      return null;
    return { current: result, token };
  }

  async function settlePrimary(
    current,
    attemptTokenHash,
    finalizationTokenHash,
    budget,
  ) {
    const revalidate = async () => {
      const fresh = await readJob(current.value.jobId, budget);
      return (
        fresh.value.state === 'primary-invalid' &&
        ownsFinalization(fresh.value, {
          number: 1,
          tokenHash: finalizationTokenHash,
          at: transitionTime(fresh.value, now),
        }) &&
        (await liveClaim(fresh.value, budget))
      );
    };
    const settled = await spend.settleAttempt({
      jobId: current.value.jobId,
      attemptNumber: 1,
      actualCostMicrousd: current.value.attempts[0].costMicrousd,
      at: transitionTime(current.value, now),
      budget,
      revalidate,
    });
    const fresh = await readJob(current.value.jobId, budget);
    if (fresh.value.state !== 'primary-invalid') return null;
    const result = await apply(
      fresh,
      {
        type: 'accounting-recorded',
        at: transitionTime(fresh.value, now),
        deadlineAt: fresh.value.stateDeadlineAt,
        attemptTokenHash,
        finalizationTokenHash,
        attemptUpdates: [{ number: 1, state: 'settled' }],
        accounting: settled.accounting,
      },
      budget,
    );
    return ['updated', 'recovered'].includes(result.status) ? result : null;
  }

  async function finalizationOwner(
    current,
    number,
    finalizationTokenHash,
    budget,
  ) {
    const fresh = await readJob(current.value.jobId, budget);
    return ownsFinalization(fresh.value, {
      number,
      tokenHash: finalizationTokenHash,
      at: transitionTime(fresh.value, now),
    })
      ? fresh
      : null;
  }

  async function failValidation(
    current,
    number,
    attemptTokenHash,
    finalizationTokenHash,
    budget,
  ) {
    return terminateOwned(
      current,
      {
        status: 'failed',
        errorCode: 'analysis_output_invalid',
        attemptTokenHash,
        finalizationTokenHash,
      },
      budget,
    );
  }

  async function publishCandidate({
    current,
    candidate,
    number,
    attemptTokenHash,
    finalizationTokenHash,
    lease,
    runtime,
    budget,
  }) {
    const publicationJobId = current.value.jobId;
    current = await finalizationOwner(
      current,
      number,
      finalizationTokenHash,
      budget,
    );
    if (current === null)
      return reconciler.reconcile({
        jobId: publicationJobId,
        budget,
      });
    const staged = await apply(
      current,
      {
        type: 'candidate-staged',
        at: transitionTime(current.value, now),
        number,
        attemptTokenHash,
        finalizationTokenHash,
        candidateDigest: candidate.candidateDigest,
      },
      budget,
    );
    if (!['updated', 'recovered'].includes(staged.status))
      return reconciler.reconcile({ jobId: current.value.jobId, budget });
    const authorized = await finalizationOwner(
      staged,
      number,
      finalizationTokenHash,
      budget,
    );
    if (authorized === null)
      return reconciler.reconcile({ jobId: staged.value.jobId, budget });
    try {
      await auth.recheckJobAuthorization({
        ownerId: authorized.value.ownerId,
        authorizationEpoch: authorized.value.authorizationEpoch,
        generation: lease.generation,
        budget,
      });
    } catch (error) {
      if (
        !(error instanceof BoardError) ||
        !['source_authorization_required', 'provider_unavailable'].includes(
          error.code,
        )
      )
        throw error;
      return terminateOwned(
        authorized,
        {
          status: 'failed',
          errorCode: 'source_authorization_required',
          attemptTokenHash,
          finalizationTokenHash,
        },
        budget,
      );
    }
    const publicationAt = transitionTime(authorized.value, now);
    if (
      Date.parse(publicationAt) >=
        Date.parse(authorized.value.stateDeadlineAt) ||
      !ownsFinalization(authorized.value, {
        number,
        tokenHash: finalizationTokenHash,
        at: publicationAt,
      })
    )
      return reconciler.reconcile({ jobId: authorized.value.jobId, budget });
    const written = await reports.writeImmutableReportVersion({
      versionKey: authorized.value.publication.versionKey,
      version: candidate.value,
      budget,
    });
    if (written.candidateDigest !== candidate.candidateDigest)
      throw unavailable();
    const at = transitionTime(authorized.value, now);
    if (Date.parse(at) >= Date.parse(authorized.value.stateDeadlineAt))
      return reconciler.reconcile({ jobId: authorized.value.jobId, budget });
    const confirmed = await apply(
      authorized,
      {
        type: 'version-confirmed',
        at,
        number,
        attemptTokenHash,
        finalizationTokenHash,
        candidateDigest: candidate.candidateDigest,
        deadlineAt: expiresAt(
          at,
          ANALYSIS_WORKER_LIMITS.finalizationMarginMs,
          runtime.hardEnd,
        ),
      },
      budget,
    );
    if (!['updated', 'recovered'].includes(confirmed.status))
      return reconciler.reconcile({ jobId: current.value.jobId, budget });
    return reconciler.reconcile({ jobId: current.value.jobId, budget });
  }

  async function run({
    jobId,
    capability,
    budget,
    signal,
    invocationStartedAt,
  }) {
    if (
      typeof jobId !== 'string' ||
      !HEX_64.test(jobId) ||
      typeof capability !== 'string' ||
      !budget
    )
      throw new BoardError('invalid_request');
    const observedAt = clockMilliseconds(now);
    const invocationStart =
      invocationStartedAt === undefined ? observedAt : invocationStartedAt;
    if (
      !Number.isSafeInteger(invocationStart) ||
      invocationStart < 0 ||
      invocationStart > observedAt ||
      !Number.isSafeInteger(
        invocationStart + ANALYSIS_WORKER_LIMITS.invocationMs,
      )
    )
      throw new BoardError('invalid_request');
    const runtime = {
      invocationStart,
      providerCutoff: invocationStart + ANALYSIS_WORKER_LIMITS.providerCutoffMs,
      hardEnd: invocationStart + ANALYSIS_WORKER_LIMITS.invocationMs,
      countSpentMs: 0,
    };
    let current = await readJob(jobId, budget);
    if (
      current.value.admissionDeployId !== deployId ||
      !matchesDispatchCapability(
        current.value.dispatchCapabilityHash,
        capability,
      )
    )
      throw new BoardError('forbidden');

    current = await reconciler.reconcile({ jobId, budget });
    if (current.value.state !== 'dispatchable') return current.value;

    const freeToken = randomToken(randomBytes, 'board-free-work-v1');
    const collectionAt = transitionTime(current.value, now);
    const claimed = await apply(
      current,
      {
        type: 'free-lease-claimed',
        at: collectionAt,
        phase: 'collecting',
        tokenHash: freeToken.hash,
        expiresAt: expiresAt(
          collectionAt,
          ANALYSIS_WORKER_LIMITS.collectionMs,
          runtime.providerCutoff,
        ),
      },
      budget,
    );
    if (!['updated', 'recovered'].includes(claimed.status))
      return (await reconciler.reconcile({ jobId, budget })).value;
    current = claimed;

    let lease;
    let gathered;
    let priorVersion = null;
    try {
      lease = await auth.acquireJobToken({
        ownerId: current.value.ownerId,
        authorizationEpoch: current.value.authorizationEpoch,
        budget,
      });
      if (current.value.operation === 'refresh') {
        const stored = await reports.readReportEnvelope({
          repositoryId: current.value.repositoryId,
          reportId: current.value.expectedCurrentReportId,
          budget,
        });
        if (stored === null) throw new BoardError('source_incomplete');
        priorVersion = stored.envelope;
      }
      const owned = await readOwnedFreeLease(
        current,
        freeToken.hash,
        'collecting',
        budget,
      );
      if (owned === null)
        return (await reconciler.reconcile({ jobId, budget })).value;
      current = owned;
      const collectionWindow = freeLeaseWindow(current, runtime);
      const collectionSignal = deadlineSignal(
        signal,
        collectionWindow.operationMs,
      );
      gathered = await source.checkRepository({
        ownerId: current.value.ownerId,
        repositoryId: current.value.repositoryId,
        accessToken: lease.accessToken,
        signal: collectionSignal,
        budget: sourceBudgetFactory({
          signal: collectionSignal,
          ...collectionWindow,
          deadlineAt: current.value.stateDeadlineAt,
        }),
      });
    } catch (error) {
      return (await failFree(current, freeToken.hash, error, budget)).value;
    }

    if (clockMilliseconds(now) >= Date.parse(current.value.stateDeadlineAt))
      return (await reconciler.reconcile({ jobId, budget })).value;
    const countAt = transitionTime(current.value, now);
    const counting = await apply(
      current,
      {
        type: 'free-lease-claimed',
        at: countAt,
        phase: 'counting',
        tokenHash: freeToken.hash,
        expiresAt: expiresAt(
          countAt,
          ANALYSIS_WORKER_LIMITS.countMs,
          runtime.providerCutoff,
        ),
      },
      budget,
    );
    if (!['updated', 'recovered'].includes(counting.status))
      return (await reconciler.reconcile({ jobId, budget })).value;
    current = counting;

    let prepared;
    try {
      const countWindow = freeLeaseWindow(current, runtime);
      const countSignal = deadlineSignal(signal, countWindow.operationMs);
      await anthropic.retrieveModel({ signal: countSignal });
      const currentRepository = gathered.summary?.repo;
      const priorAnalysis = analysisPriorForSource(
        priorVersion,
        currentRepository,
      );
      prepared = await prepareInput({
        sourceSnapshot: gathered.sourceSnapshot,
        limitations: gathered.summary.provenance.limitations,
        priorAnalysis,
        requestFactory: buildAnalysisRequestPair,
        countClient: async (request) =>
          countTokensBounded({
            analysisInput: analysisInputFromCountRequest(request),
            runtime,
            signal: countSignal,
            deadlineAt: current.value.stateDeadlineAt,
          }),
      });
      if (clockMilliseconds(now) >= Date.parse(current.value.stateDeadlineAt))
        throw new BoardError('source_timeout');
    } catch (error) {
      return (await failFree(current, freeToken.hash, error, budget)).value;
    }

    let admitted;
    try {
      admitted = await provePaidAdmission(
        current,
        freeToken.hash,
        lease,
        runtime,
        budget,
      );
    } catch (error) {
      return (await failFree(current, freeToken.hash, error, budget)).value;
    }
    if (admitted === null || !paidWindow(runtime))
      return (
        await failFree(
          current,
          freeToken.hash,
          new BoardError('analysis_unavailable'),
          budget,
        )
      ).value;
    const primary = await crossPrimary(
      admitted,
      freeToken.hash,
      gathered.summary.fingerprint.value,
      runtime,
      budget,
    );
    if (primary === null)
      return (await reconciler.reconcile({ jobId, budget })).value;
    current = primary.current;

    let response;
    try {
      response = await anthropic.createMessage({
        analysisInput: prepared.analysisInput,
        schema: ANALYSIS_DELTA_SCHEMA,
        signal: deadlineSignal(
          signal,
          Math.max(
            1,
            Date.parse(current.value.stateDeadlineAt) - clockMilliseconds(now),
          ),
        ),
      });
    } catch (error) {
      const fresh = await readJob(jobId, budget);
      const failure = paidFailure(
        error,
        fresh.value.attempts[0].reservationMicrousd,
      );
      await retainKnownUnknownExposure(
        fresh,
        1,
        primary.token.hash,
        failure.knownCostMicrousd,
        budget,
      );
      if (
        fresh.value.state !== 'primary-in-flight' ||
        !ownsPaidAttempt(fresh.value, {
          number: 1,
          tokenHash: primary.token.hash,
          at: transitionTime(fresh.value, now),
        })
      )
        return (await reconciler.reconcile({ jobId, budget })).value;
      if (failure.kind === 'refusal') {
        const refused = await recordProviderRefusal(
          fresh,
          1,
          primary.token.hash,
          failure.errorCode,
          runtime,
          budget,
        );
        if (refused === null)
          return (await reconciler.reconcile({ jobId, budget })).value;
        return (
          await terminateOwned(
            refused,
            {
              status: failure.status,
              errorCode: failure.errorCode,
              attemptTokenHash: primary.token.hash,
            },
            budget,
          )
        ).value;
      }
      return (
        await terminateOwned(
          fresh,
          {
            status: failure.status,
            errorCode: failure.errorCode,
            attemptTokenHash: primary.token.hash,
          },
          budget,
        )
      ).value;
    }

    let completed;
    try {
      completed = await recordResponse(
        current,
        1,
        primary.token.hash,
        response,
        runtime,
        budget,
      );
    } catch (error) {
      if (!(error instanceof AnthropicAttemptError)) throw error;
      const fresh = await readJob(jobId, budget);
      const failure = paidFailure(
        error,
        fresh.value.attempts[0].reservationMicrousd,
      );
      await retainKnownUnknownExposure(
        fresh,
        1,
        primary.token.hash,
        failure.knownCostMicrousd,
        budget,
      );
      if (
        fresh.value.state !== 'primary-in-flight' ||
        !ownsPaidAttempt(fresh.value, {
          number: 1,
          tokenHash: primary.token.hash,
          at: transitionTime(fresh.value, now),
        })
      )
        return (await reconciler.reconcile({ jobId, budget })).value;
      return (
        await terminateOwned(
          fresh,
          {
            status: failure.status,
            errorCode: failure.errorCode,
            attemptTokenHash: primary.token.hash,
          },
          budget,
        )
      ).value;
    }
    if (completed === null)
      return (await reconciler.reconcile({ jobId, budget })).value;
    const primaryFinalization = await claimFinalization(
      completed,
      1,
      primary.token.hash,
      runtime,
      budget,
    );
    if (primaryFinalization === null)
      return (await reconciler.reconcile({ jobId, budget })).value;
    current = primaryFinalization.current;

    let candidate;
    let primaryInvalid = response.validationError !== null;
    if (!primaryInvalid) {
      try {
        candidate = assembleResult({
          analysisDelta: response.delta,
          analysisInput: prepared.analysisInput,
          analysisSelection: prepared.analysisSelection,
          inventory: gathered.sourceSnapshot.inventory,
          sourceSummary: gathered.summary,
          job: current.value,
          generatedAt: transitionTime(current.value, now),
          priorVersion,
        });
      } catch (error) {
        if (error instanceof AnalysisResultValidationError)
          primaryInvalid = true;
        else
          return (
            await terminateOwned(
              current,
              {
                status: 'failed',
                errorCode: safeFailureCode(error),
                attemptTokenHash: primary.token.hash,
                finalizationTokenHash: primaryFinalization.token.hash,
              },
              budget,
            )
          ).value;
      }
    }

    if (!primaryInvalid)
      return (
        await publishCandidate({
          current,
          candidate,
          number: 1,
          attemptTokenHash: primary.token.hash,
          finalizationTokenHash: primaryFinalization.token.hash,
          lease,
          runtime,
          budget,
        })
      ).value;

    if (response.stopReason !== 'end_turn')
      return (
        await failValidation(
          current,
          1,
          primary.token.hash,
          primaryFinalization.token.hash,
          budget,
        )
      ).value;

    const stillFinalizingPrimary = await finalizationOwner(
      current,
      1,
      primaryFinalization.token.hash,
      budget,
    );
    if (stillFinalizingPrimary === null)
      return (await reconciler.reconcile({ jobId, budget })).value;
    current = stillFinalizingPrimary;
    const rejected = await apply(
      current,
      {
        type: 'primary-rejected',
        at: transitionTime(current.value, now),
        attemptTokenHash: primary.token.hash,
        finalizationTokenHash: primaryFinalization.token.hash,
        classification: ANALYSIS_RESULT_CLASSIFICATION,
      },
      budget,
    );
    if (!['updated', 'recovered'].includes(rejected.status))
      return (await reconciler.reconcile({ jobId, budget })).value;
    const primarySettled = await settlePrimary(
      rejected,
      primary.token.hash,
      primaryFinalization.token.hash,
      budget,
    );
    if (primarySettled === null)
      return (await reconciler.reconcile({ jobId, budget })).value;
    current = primarySettled;

    if (!paidWindow(runtime))
      return (
        await failValidation(
          current,
          1,
          primary.token.hash,
          primaryFinalization.token.hash,
          budget,
        )
      ).value;

    let correctiveInput;
    try {
      correctiveInput = buildCorrectiveAnalysisInput({
        analysisInput: prepared.analysisInput,
        validationErrors: [{ code: ANALYSIS_RESULT_CLASSIFICATION }],
      });
      assertProviderRequestBounds(correctiveInput);
      const remaining = Math.min(
        ANALYSIS_WORKER_LIMITS.countMs,
        Date.parse(current.value.stateDeadlineAt) - clockMilliseconds(now),
      );
      const correctiveCount = await countTokensBounded({
        analysisInput: correctiveInput,
        runtime,
        signal: deadlineSignal(signal, remaining),
      });
      if (
        !Number.isSafeInteger(correctiveCount) ||
        correctiveCount < 0 ||
        correctiveCount > ANALYSIS_INPUT_LIMITS.inputTokens
      )
        throw new BoardError('analysis_input_too_large');
    } catch (error) {
      if (
        !(error instanceof BoardError) ||
        error.code !== 'analysis_output_invalid'
      ) {
        const owned = await finalizationOwner(
          current,
          1,
          primaryFinalization.token.hash,
          budget,
        );
        if (owned === null)
          return (await reconciler.reconcile({ jobId, budget })).value;
        return (
          await terminateOwned(
            owned,
            {
              status: 'failed',
              errorCode: safeFailureCode(error),
              attemptTokenHash: primary.token.hash,
              finalizationTokenHash: primaryFinalization.token.hash,
            },
            budget,
          )
        ).value;
      }
      return (
        await failValidation(
          current,
          1,
          primary.token.hash,
          primaryFinalization.token.hash,
          budget,
        )
      ).value;
    }

    if (!paidWindow(runtime))
      return (
        await failValidation(
          current,
          1,
          primary.token.hash,
          primaryFinalization.token.hash,
          budget,
        )
      ).value;

    const correctiveToken = randomToken(
      randomBytes,
      'board-corrective-attempt-v1',
    );
    let stillOwnsCorrection;
    try {
      stillOwnsCorrection = await proveCorrectiveAdmission(
        current,
        primary.token.hash,
        primaryFinalization.token.hash,
        lease,
        runtime,
        budget,
      );
    } catch (error) {
      const owned = await finalizationOwner(
        current,
        1,
        primaryFinalization.token.hash,
        budget,
      );
      if (owned === null)
        return (await reconciler.reconcile({ jobId, budget })).value;
      return (
        await terminateOwned(
          owned,
          {
            status: 'failed',
            errorCode: safeFailureCode(error),
            attemptTokenHash: primary.token.hash,
            finalizationTokenHash: primaryFinalization.token.hash,
          },
          budget,
        )
      ).value;
    }
    if (stillOwnsCorrection === null)
      return (await reconciler.reconcile({ jobId, budget })).value;
    current = stillOwnsCorrection;
    if (!paidWindow(runtime))
      return (
        await failValidation(
          current,
          1,
          primary.token.hash,
          primaryFinalization.token.hash,
          budget,
        )
      ).value;
    const correctiveAt = transitionTime(current.value, now);
    const correctiveStarted = await applyPaidBoundary(
      current,
      {
        type: 'corrective-started',
        at: correctiveAt,
        primaryAttemptTokenHash: primary.token.hash,
        finalizationTokenHash: primaryFinalization.token.hash,
        correctiveAttemptTokenHash: correctiveToken.hash,
        deadlineAt: expiresAt(
          correctiveAt,
          ANALYSIS_WORKER_LIMITS.attemptMs,
          runtime.providerCutoff,
        ),
      },
      budget,
    );
    if (
      !['updated', 'recovered'].includes(correctiveStarted.status) ||
      !ownsPaidAttempt(correctiveStarted.value, {
        number: 2,
        tokenHash: correctiveToken.hash,
        at: transitionTime(correctiveStarted.value, now),
      })
    )
      return (await reconciler.reconcile({ jobId, budget })).value;
    current = correctiveStarted;

    let correctiveResponse;
    try {
      correctiveResponse = await anthropic.createMessage({
        analysisInput: correctiveInput,
        schema: ANALYSIS_DELTA_SCHEMA,
        signal: deadlineSignal(
          signal,
          Math.max(
            1,
            Date.parse(current.value.stateDeadlineAt) - clockMilliseconds(now),
          ),
        ),
      });
    } catch (error) {
      const fresh = await readJob(jobId, budget);
      const failure = paidFailure(
        error,
        fresh.value.attempts[1].reservationMicrousd,
      );
      await retainKnownUnknownExposure(
        fresh,
        2,
        correctiveToken.hash,
        failure.knownCostMicrousd,
        budget,
      );
      if (
        fresh.value.state !== 'corrective-in-flight' ||
        !ownsPaidAttempt(fresh.value, {
          number: 2,
          tokenHash: correctiveToken.hash,
          at: transitionTime(fresh.value, now),
        })
      )
        return (await reconciler.reconcile({ jobId, budget })).value;
      if (failure.kind === 'refusal') {
        const refused = await recordProviderRefusal(
          fresh,
          2,
          correctiveToken.hash,
          failure.errorCode,
          runtime,
          budget,
        );
        if (refused === null)
          return (await reconciler.reconcile({ jobId, budget })).value;
        return (
          await terminateOwned(
            refused,
            {
              status: failure.status,
              errorCode: failure.errorCode,
              attemptTokenHash: correctiveToken.hash,
            },
            budget,
          )
        ).value;
      }
      return (
        await terminateOwned(
          fresh,
          {
            status: failure.status,
            errorCode: failure.errorCode,
            attemptTokenHash: correctiveToken.hash,
          },
          budget,
        )
      ).value;
    }

    let correctiveCompleted;
    try {
      correctiveCompleted = await recordResponse(
        current,
        2,
        correctiveToken.hash,
        correctiveResponse,
        runtime,
        budget,
      );
    } catch (error) {
      if (!(error instanceof AnthropicAttemptError)) throw error;
      const fresh = await readJob(jobId, budget);
      const failure = paidFailure(
        error,
        fresh.value.attempts[1].reservationMicrousd,
      );
      await retainKnownUnknownExposure(
        fresh,
        2,
        correctiveToken.hash,
        failure.knownCostMicrousd,
        budget,
      );
      if (
        fresh.value.state !== 'corrective-in-flight' ||
        !ownsPaidAttempt(fresh.value, {
          number: 2,
          tokenHash: correctiveToken.hash,
          at: transitionTime(fresh.value, now),
        })
      )
        return (await reconciler.reconcile({ jobId, budget })).value;
      return (
        await terminateOwned(
          fresh,
          {
            status: failure.status,
            errorCode: failure.errorCode,
            attemptTokenHash: correctiveToken.hash,
          },
          budget,
        )
      ).value;
    }
    if (correctiveCompleted === null)
      return (await reconciler.reconcile({ jobId, budget })).value;
    const correctiveFinalization = await claimFinalization(
      correctiveCompleted,
      2,
      correctiveToken.hash,
      runtime,
      budget,
    );
    if (correctiveFinalization === null)
      return (await reconciler.reconcile({ jobId, budget })).value;
    current = correctiveFinalization.current;

    if (
      correctiveResponse.stopReason !== 'end_turn' ||
      correctiveResponse.validationError !== null
    )
      return (
        await failValidation(
          current,
          2,
          correctiveToken.hash,
          correctiveFinalization.token.hash,
          budget,
        )
      ).value;
    try {
      candidate = assembleResult({
        analysisDelta: correctiveResponse.delta,
        analysisInput: prepared.analysisInput,
        analysisSelection: prepared.analysisSelection,
        inventory: gathered.sourceSnapshot.inventory,
        sourceSummary: gathered.summary,
        job: current.value,
        generatedAt: transitionTime(current.value, now),
        priorVersion,
      });
    } catch (error) {
      if (!(error instanceof AnalysisResultValidationError))
        return (
          await terminateOwned(
            current,
            {
              status: 'failed',
              errorCode: safeFailureCode(error),
              attemptTokenHash: correctiveToken.hash,
              finalizationTokenHash: correctiveFinalization.token.hash,
            },
            budget,
          )
        ).value;
      return (
        await failValidation(
          current,
          2,
          correctiveToken.hash,
          correctiveFinalization.token.hash,
          budget,
        )
      ).value;
    }
    return (
      await publishCandidate({
        current,
        candidate,
        number: 2,
        attemptTokenHash: correctiveToken.hash,
        finalizationTokenHash: correctiveFinalization.token.hash,
        lease,
        runtime,
        budget,
      })
    ).value;
  }

  return Object.freeze({ run });
}
