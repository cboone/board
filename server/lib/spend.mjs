import { createHash } from 'node:crypto';
import { BoardError } from './errors.mjs';

export const SETUP_SPEND_LIMITS = Object.freeze({
  maxBytes: 262_144,
  maxActiveJobs: 4,
  maxPolicies: 16,
  maxDecisionsPerPolicy: 32,
  capMicrousd: 25_000_000,
  discussionMicrousd: 20_000_000,
  attemptInputTokens: 1_000_000,
  attemptOutputTokens: 16_384,
  inputRateMicrousd: 5,
  outputRateMicrousd: 25,
  attemptCostMicrousd: 5_409_600,
  maximumAttempts: 2,
});

const HEX_64 = /^[a-f0-9]{64}$/u;
const POLICY_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const OPERATIONS = new Set(['generate', 'refresh']);
const ATTEMPT_STATES = new Set(['reserved', 'settled', 'released', 'unknown']);
const DECISIONS = new Set(['acknowledged', 'stopped']);
const fail = () => {
  throw new BoardError('service_unavailable');
};
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const text = (value, max = 4096) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\r\n\0]/u.test(value);
const iso = (value) => {
  if (
    !text(value, 40) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail();
  return value;
};
const exact = (value, keys) => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
  return value;
};
const checkedAdd = (...values) => {
  let result = 0;
  for (const value of values) {
    if (!integer(value) || !Number.isSafeInteger(result + value)) fail();
    result += value;
  }
  return result;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const digest = (domain, value) =>
  createHash('sha256')
    .update(`${domain}\0${JSON.stringify(canonical(value))}`)
    .digest('hex');
const clone = (value) => structuredClone(value);
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function projectPolicy(value, expectedId) {
  exact(value, [
    'model',
    'effort',
    'inferenceGeo',
    'serviceTier',
    'maximumAttempts',
    'inputRateMicrousd',
    'outputRateMicrousd',
    'attemptInputCeiling',
    'attemptOutputCeiling',
    'attemptCostCeilingMicrousd',
    'capMicrousd',
    'discussionMicrousd',
    'featurePolicyHash',
    'pricingSource',
    'pricingVerifiedAt',
    'pricingValidThrough',
    'deployId',
  ]);
  if (
    !POLICY_ID.test(expectedId) ||
    value.model !== 'claude-opus-5' ||
    value.effort !== 'high' ||
    value.inferenceGeo !== 'global' ||
    value.serviceTier !== 'standard_only' ||
    value.maximumAttempts !== SETUP_SPEND_LIMITS.maximumAttempts ||
    value.inputRateMicrousd !== SETUP_SPEND_LIMITS.inputRateMicrousd ||
    value.outputRateMicrousd !== SETUP_SPEND_LIMITS.outputRateMicrousd ||
    value.attemptInputCeiling !== SETUP_SPEND_LIMITS.attemptInputTokens ||
    value.attemptOutputCeiling !== SETUP_SPEND_LIMITS.attemptOutputTokens ||
    value.attemptCostCeilingMicrousd !==
      SETUP_SPEND_LIMITS.attemptCostMicrousd ||
    value.capMicrousd !== SETUP_SPEND_LIMITS.capMicrousd ||
    value.discussionMicrousd !== SETUP_SPEND_LIMITS.discussionMicrousd ||
    !HEX_64.test(value.featurePolicyHash) ||
    !text(value.pricingSource, 1024) ||
    !text(value.deployId, 128)
  )
    fail();
  const verified = iso(value.pricingVerifiedAt);
  const validThrough = iso(value.pricingValidThrough);
  if (Date.parse(validThrough) <= Date.parse(verified)) fail();
  return clone(value);
}

function projectAttempt(value, number) {
  exact(value, [
    'number',
    'ceilingMicrousd',
    'state',
    'actualCostMicrousd',
    'unknownExposureMicrousd',
    'recordedAt',
  ]);
  if (
    value.number !== number ||
    value.ceilingMicrousd !== SETUP_SPEND_LIMITS.attemptCostMicrousd ||
    !ATTEMPT_STATES.has(value.state) ||
    !integer(value.actualCostMicrousd) ||
    !integer(value.unknownExposureMicrousd) ||
    (value.recordedAt !== null && !text(value.recordedAt, 40))
  )
    fail();
  if (
    value.state === 'reserved' &&
    (value.actualCostMicrousd !== 0 ||
      value.unknownExposureMicrousd !== 0 ||
      value.recordedAt !== null)
  )
    fail();
  if (
    value.state === 'settled' &&
    (value.actualCostMicrousd > value.ceilingMicrousd ||
      value.unknownExposureMicrousd !== 0 ||
      value.recordedAt === null)
  )
    fail();
  if (
    value.state === 'released' &&
    (value.actualCostMicrousd !== 0 ||
      value.unknownExposureMicrousd !== 0 ||
      value.recordedAt === null)
  )
    fail();
  if (
    value.state === 'unknown' &&
    (value.unknownExposureMicrousd <
      Math.max(value.ceilingMicrousd, value.actualCostMicrousd) ||
      value.recordedAt === null)
  )
    fail();
  if (value.recordedAt !== null) iso(value.recordedAt);
  return clone(value);
}

function projectActive(value, jobId, policyIds) {
  exact(value, [
    'policyId',
    'createdAt',
    'accountingState',
    'lastLedgerRevision',
    'lastAccountingSequence',
    'lastAccountingDigest',
    'lastTransitionId',
    'attempts',
  ]);
  if (
    !HEX_64.test(jobId) ||
    !policyIds.has(value.policyId) ||
    !['pending', 'unknown'].includes(value.accountingState) ||
    !positive(value.lastLedgerRevision) ||
    !positive(value.lastAccountingSequence) ||
    !HEX_64.test(value.lastAccountingDigest) ||
    !HEX_64.test(value.lastTransitionId) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length !== SETUP_SPEND_LIMITS.maximumAttempts
  )
    fail();
  iso(value.createdAt);
  return {
    ...clone(value),
    attempts: value.attempts.map((attempt, index) =>
      projectAttempt(attempt, index + 1),
    ),
  };
}

function projectDiscussion(value, policyId) {
  exact(value, [
    'status',
    'currentRevision',
    'triggeredAt',
    'triggerExposureMicrousd',
    'decisions',
  ]);
  if (
    !['required', 'acknowledged', 'stopped'].includes(value.status) ||
    !positive(value.currentRevision) ||
    !integer(value.triggerExposureMicrousd) ||
    !Array.isArray(value.decisions) ||
    value.decisions.length > SETUP_SPEND_LIMITS.maxDecisionsPerPolicy
  )
    fail();
  iso(value.triggeredAt);
  const decisions = value.decisions.map((decision) => {
    exact(decision, [
      'triggerRevision',
      'decidedAt',
      'observedExposureMicrousd',
      'decisionId',
      'decision',
      'authorizedThroughMicrousd',
      'authorizedOperations',
    ]);
    if (
      !positive(decision.triggerRevision) ||
      decision.triggerRevision > value.currentRevision ||
      !integer(decision.observedExposureMicrousd) ||
      !HEX_64.test(decision.decisionId) ||
      !DECISIONS.has(decision.decision) ||
      !integer(decision.authorizedThroughMicrousd) ||
      decision.authorizedThroughMicrousd > SETUP_SPEND_LIMITS.capMicrousd ||
      !Array.isArray(decision.authorizedOperations) ||
      new Set(decision.authorizedOperations).size !==
        decision.authorizedOperations.length ||
      decision.authorizedOperations.some((item) => !OPERATIONS.has(item))
    )
      fail();
    iso(decision.decidedAt);
    return clone(decision);
  });
  if (
    decisions.some(
      (decision, index) =>
        decisions.findIndex(
          (item) => item.decisionId === decision.decisionId,
        ) !== index,
    )
  )
    fail();
  if (!POLICY_ID.test(policyId)) fail();
  return { ...clone(value), decisions };
}

export function projectSpendLedger(value) {
  exact(value, [
    'schemaVersion',
    'currency',
    'revision',
    'activePolicyId',
    'policies',
    'settledMicrousd',
    'accountingSequence',
    'accountingDigest',
    'active',
    'discussions',
    'pricingReviewRequired',
    'updatedAt',
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.currency !== 'USD' ||
    !integer(value.revision) ||
    !POLICY_ID.test(value.activePolicyId) ||
    !integer(value.settledMicrousd) ||
    !integer(value.accountingSequence) ||
    !HEX_64.test(value.accountingDigest) ||
    typeof value.pricingReviewRequired !== 'boolean' ||
    value.policies === null ||
    typeof value.policies !== 'object' ||
    Array.isArray(value.policies) ||
    value.active === null ||
    typeof value.active !== 'object' ||
    Array.isArray(value.active) ||
    value.discussions === null ||
    typeof value.discussions !== 'object' ||
    Array.isArray(value.discussions)
  )
    fail();
  iso(value.updatedAt);
  const policyEntries = Object.entries(value.policies);
  if (
    policyEntries.length < 1 ||
    policyEntries.length > SETUP_SPEND_LIMITS.maxPolicies
  )
    fail();
  const policies = Object.fromEntries(
    policyEntries.map(([id, policy]) => [id, projectPolicy(policy, id)]),
  );
  if (!Object.hasOwn(policies, value.activePolicyId)) fail();
  const policyIds = new Set(Object.keys(policies));
  const activeEntries = Object.entries(value.active);
  if (activeEntries.length > SETUP_SPEND_LIMITS.maxActiveJobs) fail();
  const active = Object.fromEntries(
    activeEntries.map(([id, entry]) => [
      id,
      projectActive(entry, id, policyIds),
    ]),
  );
  const discussions = Object.fromEntries(
    Object.entries(value.discussions).map(([id, discussion]) => {
      if (!policyIds.has(id)) fail();
      return [id, projectDiscussion(discussion, id)];
    }),
  );
  const projected = {
    ...clone(value),
    policies,
    active,
    discussions,
  };
  if (byteLength(projected) > SETUP_SPEND_LIMITS.maxBytes) fail();
  exposureMicrousd(projected);
  return projected;
}

export function createSetupPolicy({
  deployId,
  pricingSource,
  pricingVerifiedAt,
  pricingValidThrough,
  policyId = 'setup-opus-5-global-standard-v1',
}) {
  const policy = {
    model: 'claude-opus-5',
    effort: 'high',
    inferenceGeo: 'global',
    serviceTier: 'standard_only',
    maximumAttempts: SETUP_SPEND_LIMITS.maximumAttempts,
    inputRateMicrousd: SETUP_SPEND_LIMITS.inputRateMicrousd,
    outputRateMicrousd: SETUP_SPEND_LIMITS.outputRateMicrousd,
    attemptInputCeiling: SETUP_SPEND_LIMITS.attemptInputTokens,
    attemptOutputCeiling: SETUP_SPEND_LIMITS.attemptOutputTokens,
    attemptCostCeilingMicrousd: SETUP_SPEND_LIMITS.attemptCostMicrousd,
    capMicrousd: SETUP_SPEND_LIMITS.capMicrousd,
    discussionMicrousd: SETUP_SPEND_LIMITS.discussionMicrousd,
    featurePolicyHash: digest('board-feature-policy-v1', {
      caching: false,
      tools: false,
      premium: false,
      inferenceGeo: 'global',
      serviceTier: 'standard_only',
    }),
    pricingSource,
    pricingVerifiedAt,
    pricingValidThrough,
    deployId,
  };
  return { policyId, policy: projectPolicy(policy, policyId) };
}

export function createSetupLedger({ policyId, policy, at }) {
  const projectedPolicy = projectPolicy(policy, policyId);
  const ledger = {
    schemaVersion: 1,
    currency: 'USD',
    revision: 0,
    activePolicyId: policyId,
    policies: { [policyId]: projectedPolicy },
    settledMicrousd: 0,
    accountingSequence: 0,
    accountingDigest: digest('board-accounting-genesis-v1', {
      policyId,
      currency: 'USD',
    }),
    active: {},
    discussions: {},
    pricingReviewRequired: false,
    updatedAt: iso(at),
  };
  return projectSpendLedger(ledger);
}

export function exposureMicrousd(ledger) {
  let exposure = ledger.settledMicrousd;
  for (const entry of Object.values(ledger.active)) {
    for (const attempt of entry.attempts) {
      const amount =
        attempt.state === 'reserved'
          ? attempt.ceilingMicrousd
          : attempt.state === 'unknown'
            ? attempt.unknownExposureMicrousd
            : 0;
      exposure = checkedAdd(exposure, amount);
    }
  }
  return exposure;
}

function accountingTransition(ledger, jobId, transition, mutate) {
  const next = clone(ledger);
  const nextRevision = checkedAdd(next.revision, 1);
  const nextSequence = checkedAdd(next.accountingSequence, 1);
  const transitionId = digest('board-accounting-transition-id-v1', {
    jobId,
    nextSequence,
    transition,
  });
  const nextDigest = digest('board-accounting-chain-v1', {
    previous: next.accountingDigest,
    transitionId,
    nextSequence,
  });
  mutate(next, { nextRevision, nextSequence, nextDigest, transitionId });
  next.revision = nextRevision;
  next.accountingSequence = nextSequence;
  next.accountingDigest = nextDigest;
  const entry = next.active[jobId];
  if (entry) {
    entry.lastLedgerRevision = nextRevision;
    entry.lastAccountingSequence = nextSequence;
    entry.lastAccountingDigest = nextDigest;
    entry.lastTransitionId = transitionId;
  }
  return {
    ledger: projectSpendLedger(next),
    accounting: {
      ledgerRevision: nextRevision,
      accountingSequence: nextSequence,
      accountingDigest: nextDigest,
      transitionId,
    },
  };
}

function currentDecision(ledger, policyId) {
  const discussion = ledger.discussions[policyId];
  if (!discussion || discussion.status === 'required') return null;
  return discussion.decisions.findLast(
    (decision) => decision.triggerRevision === discussion.currentRevision,
  );
}

export function reserveSetupJob(
  input,
  {
    jobId,
    operation,
    at,
    expectedRevision,
    expectedPolicyId,
    expectedDeployId,
  },
) {
  const ledger = projectSpendLedger(input);
  const reservationAt = iso(at);
  const policy = ledger.policies[ledger.activePolicyId];
  if (
    !HEX_64.test(jobId) ||
    !OPERATIONS.has(operation) ||
    ledger.revision !== expectedRevision ||
    ledger.pricingReviewRequired ||
    expectedPolicyId !== ledger.activePolicyId ||
    expectedDeployId !== policy.deployId ||
    Date.parse(reservationAt) < Date.parse(policy.pricingVerifiedAt) ||
    Date.parse(reservationAt) >= Date.parse(policy.pricingValidThrough)
  )
    fail();
  if (Object.hasOwn(ledger.active, jobId))
    return { status: 'existing', ledger };
  if (Object.keys(ledger.active).length >= SETUP_SPEND_LIMITS.maxActiveJobs)
    return { status: 'capacity', ledger };
  const policyId = ledger.activePolicyId;
  if (ledger.discussions[policyId]?.status === 'stopped')
    return { status: 'stopped', ledger };
  const proposed = checkedAdd(
    ...Array.from(
      { length: SETUP_SPEND_LIMITS.maximumAttempts },
      () => SETUP_SPEND_LIMITS.attemptCostMicrousd,
    ),
  );
  const proposedExposure = checkedAdd(exposureMicrousd(ledger), proposed);
  if (proposedExposure > SETUP_SPEND_LIMITS.capMicrousd)
    return { status: 'budget-exhausted', ledger };
  if (proposedExposure >= SETUP_SPEND_LIMITS.discussionMicrousd) {
    const decision = currentDecision(ledger, policyId);
    if (
      !decision ||
      decision.decision !== 'acknowledged' ||
      decision.authorizedThroughMicrousd < proposedExposure ||
      !decision.authorizedOperations.includes(operation)
    ) {
      const next = clone(ledger);
      const prior = next.discussions[policyId];
      if (prior?.status === 'stopped') return { status: 'stopped', ledger };
      next.revision = checkedAdd(next.revision, 1);
      next.discussions[policyId] = {
        status: 'required',
        currentRevision: (prior?.currentRevision ?? 0) + 1,
        triggeredAt: iso(at),
        triggerExposureMicrousd: proposedExposure,
        decisions: prior?.decisions ?? [],
      };
      next.updatedAt = at;
      return {
        status: 'discussion-required',
        ledger: projectSpendLedger(next),
      };
    }
  }
  const createdAt = reservationAt;
  return {
    status: 'reserved',
    ...accountingTransition(
      ledger,
      jobId,
      { kind: 'reserve', policyId, operation, proposed },
      (next, facts) => {
        next.active[jobId] = {
          policyId,
          createdAt,
          accountingState: 'pending',
          lastLedgerRevision: facts.nextRevision,
          lastAccountingSequence: facts.nextSequence,
          lastAccountingDigest: facts.nextDigest,
          lastTransitionId: facts.transitionId,
          attempts: Array.from(
            { length: SETUP_SPEND_LIMITS.maximumAttempts },
            (_, index) => ({
              number: index + 1,
              ceilingMicrousd: SETUP_SPEND_LIMITS.attemptCostMicrousd,
              state: 'reserved',
              actualCostMicrousd: 0,
              unknownExposureMicrousd: 0,
              recordedAt: null,
            }),
          ),
        };
        next.updatedAt = at;
      },
    ),
  };
}

export function updateSetupAttempt(
  input,
  {
    jobId,
    attemptNumber,
    state,
    actualCostMicrousd = 0,
    unknownExposureMicrousd = 0,
    at,
    expectedRevision,
  },
) {
  const ledger = projectSpendLedger(input);
  const entry = ledger.active[jobId];
  if (
    !entry ||
    ledger.revision !== expectedRevision ||
    !positive(attemptNumber) ||
    !['settled', 'released', 'unknown'].includes(state)
  )
    fail();
  const current = entry.attempts[attemptNumber - 1];
  if (!current || current.state !== 'reserved') fail();
  const recordedAt = iso(at);
  const ceiling = current.ceilingMicrousd;
  if (
    !integer(actualCostMicrousd) ||
    !integer(unknownExposureMicrousd) ||
    (state === 'settled' &&
      (actualCostMicrousd > ceiling || unknownExposureMicrousd !== 0)) ||
    (state === 'released' &&
      (actualCostMicrousd !== 0 || unknownExposureMicrousd !== 0)) ||
    (state === 'unknown' &&
      unknownExposureMicrousd < Math.max(ceiling, actualCostMicrousd))
  )
    fail();
  return accountingTransition(
    ledger,
    jobId,
    {
      kind: 'attempt',
      attemptNumber,
      state,
      actualCostMicrousd,
      unknownExposureMicrousd,
    },
    (next) => {
      const attempt = next.active[jobId].attempts[attemptNumber - 1];
      Object.assign(attempt, {
        state,
        actualCostMicrousd,
        unknownExposureMicrousd,
        recordedAt,
      });
      if (state === 'settled')
        next.settledMicrousd = checkedAdd(
          next.settledMicrousd,
          actualCostMicrousd,
        );
      next.active[jobId].accountingState = next.active[jobId].attempts.some(
        (item) => item.state === 'unknown',
      )
        ? 'unknown'
        : 'pending';
      next.updatedAt = at;
    },
  );
}

export function removeCompletedSetupJob(
  input,
  { jobId, expectedRevision, at },
) {
  const ledger = projectSpendLedger(input);
  const entry = ledger.active[jobId];
  if (!entry || ledger.revision !== expectedRevision) fail();
  if (
    entry.attempts.some(
      (attempt) => !['settled', 'released'].includes(attempt.state),
    )
  )
    fail();
  const next = clone(ledger);
  delete next.active[jobId];
  next.revision = checkedAdd(next.revision, 1);
  next.updatedAt = iso(at);
  return projectSpendLedger(next);
}

export function decideSetupDiscussion(
  input,
  {
    policyId,
    triggerRevision,
    decisionId,
    decision,
    authorizedThroughMicrousd,
    authorizedOperations,
    observedExposureMicrousd,
    at,
    expectedRevision,
  },
) {
  const ledger = projectSpendLedger(input);
  const discussion = ledger.discussions[policyId];
  if (
    ledger.revision !== expectedRevision ||
    !discussion ||
    discussion.status !== 'required' ||
    discussion.currentRevision !== triggerRevision ||
    !HEX_64.test(decisionId) ||
    !DECISIONS.has(decision) ||
    !integer(observedExposureMicrousd) ||
    observedExposureMicrousd !== exposureMicrousd(ledger) ||
    !integer(authorizedThroughMicrousd) ||
    authorizedThroughMicrousd > SETUP_SPEND_LIMITS.capMicrousd ||
    !Array.isArray(authorizedOperations) ||
    new Set(authorizedOperations).size !== authorizedOperations.length ||
    authorizedOperations.some((item) => !OPERATIONS.has(item)) ||
    discussion.decisions.length >= SETUP_SPEND_LIMITS.maxDecisionsPerPolicy ||
    Object.values(ledger.discussions).some((item) =>
      item.decisions.some((entry) => entry.decisionId === decisionId),
    )
  )
    fail();
  if (
    decision === 'acknowledged' &&
    authorizedThroughMicrousd < observedExposureMicrousd
  )
    fail();
  if (
    decision === 'stopped' &&
    (authorizedThroughMicrousd !== 0 || authorizedOperations.length !== 0)
  )
    fail();
  const next = clone(ledger);
  const target = next.discussions[policyId];
  target.status = decision;
  target.decisions.push({
    triggerRevision,
    decidedAt: iso(at),
    observedExposureMicrousd,
    decisionId,
    decision,
    authorizedThroughMicrousd,
    authorizedOperations: [...authorizedOperations],
  });
  next.revision = checkedAdd(next.revision, 1);
  next.updatedAt = at;
  return projectSpendLedger(next);
}
