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

export const SETUP_POLICY_ID = 'setup-opus-5-global-standard-v1';
export const SETUP_PRICING_SOURCE =
  'https://platform.claude.com/docs/en/about-claude/pricing';

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
const checkedMultiply = (left, right) => {
  if (!integer(left) || !integer(right)) fail();
  const result = left * right;
  if (!Number.isSafeInteger(result)) fail();
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
const MAXIMUM_WIDTH_INTEGER = Number.MAX_SAFE_INTEGER;
const MAXIMUM_WIDTH_TIMESTAMP = '9999-12-31T23:59:59.999Z';

function maximumWidthLedger(value) {
  const projected = clone(value);
  projected.revision = MAXIMUM_WIDTH_INTEGER;
  projected.settledMicrousd = MAXIMUM_WIDTH_INTEGER;
  projected.accountingSequence = MAXIMUM_WIDTH_INTEGER;
  projected.pricingReviewRequired = false;
  for (const entry of Object.values(projected.active)) {
    entry.lastLedgerRevision = MAXIMUM_WIDTH_INTEGER;
    entry.lastAccountingSequence = MAXIMUM_WIDTH_INTEGER;
    for (const attempt of entry.attempts) {
      attempt.actualCostMicrousd = MAXIMUM_WIDTH_INTEGER;
      attempt.unknownExposureMicrousd = MAXIMUM_WIDTH_INTEGER;
      attempt.recordedAt = MAXIMUM_WIDTH_TIMESTAMP;
    }
  }
  for (const discussion of Object.values(projected.discussions)) {
    discussion.status = 'acknowledged';
    discussion.currentRevision = MAXIMUM_WIDTH_INTEGER;
    discussion.triggerExposureMicrousd = MAXIMUM_WIDTH_INTEGER;
    for (const decision of discussion.decisions) {
      decision.triggerRevision = MAXIMUM_WIDTH_INTEGER;
      decision.observed.settledMicrousd = MAXIMUM_WIDTH_INTEGER;
      decision.observed.reservedMicrousd = MAXIMUM_WIDTH_INTEGER;
      decision.observed.unknownMicrousd = MAXIMUM_WIDTH_INTEGER;
      decision.authorizedThroughMicrousd = MAXIMUM_WIDTH_INTEGER;
      decision.decision = 'acknowledged';
    }
  }
  return projected;
}

function preflightBytes(value) {
  return byteLength(maximumWidthLedger(value));
}

function deploymentPolicyId(pricingAttestation, deployId) {
  if (!text(deployId, 128)) fail();
  return `${SETUP_POLICY_ID}.${digest('board-setup-policy-deploy-v1', {
    pricingAttestation,
    deployId,
  })}`;
}

const SETUP_FEATURE_POLICY = Object.freeze({
  caching: false,
  tools: false,
  premium: false,
  inferenceGeo: 'global',
  serviceTier: 'standard_only',
});
export const SETUP_FEATURE_POLICY_HASH = digest(
  'board-feature-policy-v1',
  SETUP_FEATURE_POLICY,
);

function projectPricingAttestationShape(value) {
  exact(value, [
    'schemaVersion',
    'policyId',
    'model',
    'inputRateMicrousd',
    'outputRateMicrousd',
    'featurePolicyHash',
    'pricingSource',
    'pricingVerifiedAt',
    'pricingValidThrough',
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.policyId !== SETUP_POLICY_ID ||
    value.model !== 'claude-opus-5' ||
    !positive(value.inputRateMicrousd) ||
    !positive(value.outputRateMicrousd) ||
    value.featurePolicyHash !== SETUP_FEATURE_POLICY_HASH ||
    value.pricingSource !== SETUP_PRICING_SOURCE
  )
    fail();
  const verified = iso(value.pricingVerifiedAt);
  const validThrough = iso(value.pricingValidThrough);
  if (Date.parse(validThrough) <= Date.parse(verified)) fail();
  return Object.freeze(clone(value));
}

// Retain prior exact entries when appending a newly reviewed current attestation.
const REVIEWED_SETUP_PRICING_ATTESTATION_VALUES = [
  {
    schemaVersion: 1,
    policyId: SETUP_POLICY_ID,
    model: 'claude-opus-5',
    inputRateMicrousd: 5,
    outputRateMicrousd: 25,
    featurePolicyHash: SETUP_FEATURE_POLICY_HASH,
    pricingSource: SETUP_PRICING_SOURCE,
    pricingVerifiedAt: '2026-09-19T05:35:41.000Z',
    pricingValidThrough: '2026-09-26T05:35:41.000Z',
  },
];

export const REVIEWED_SETUP_PRICING_ATTESTATIONS = Object.freeze(
  REVIEWED_SETUP_PRICING_ATTESTATION_VALUES.map(projectPricingAttestationShape),
);
export const REVIEWED_SETUP_PRICING_ATTESTATION =
  REVIEWED_SETUP_PRICING_ATTESTATIONS.at(-1);

export function projectSetupPricingAttestation(value) {
  const projected = projectPricingAttestationShape(value);
  if (
    !REVIEWED_SETUP_PRICING_ATTESTATIONS.some(
      (attestation) =>
        JSON.stringify(canonical(attestation)) ===
        JSON.stringify(canonical(projected)),
    )
  )
    fail();
  return projected;
}

export function createSetupPricingAttestation(value) {
  exact(value, ['pricingVerifiedAt', 'pricingValidThrough']);
  return projectSetupPricingAttestation({
    ...REVIEWED_SETUP_PRICING_ATTESTATION,
    pricingVerifiedAt: value.pricingVerifiedAt,
    pricingValidThrough: value.pricingValidThrough,
  });
}

function reviewedPolicyValue(pricingAttestation, deployId) {
  if (!text(deployId, 128)) fail();
  const attemptCostCeilingMicrousd = checkedAdd(
    checkedMultiply(
      SETUP_SPEND_LIMITS.attemptInputTokens,
      pricingAttestation.inputRateMicrousd,
    ),
    checkedMultiply(
      SETUP_SPEND_LIMITS.attemptOutputTokens,
      pricingAttestation.outputRateMicrousd,
    ),
  );
  return {
    policyId: deploymentPolicyId(pricingAttestation, deployId),
    policy: {
      model: 'claude-opus-5',
      effort: 'high',
      inferenceGeo: 'global',
      serviceTier: 'standard_only',
      maximumAttempts: SETUP_SPEND_LIMITS.maximumAttempts,
      inputRateMicrousd: pricingAttestation.inputRateMicrousd,
      outputRateMicrousd: pricingAttestation.outputRateMicrousd,
      attemptInputCeiling: SETUP_SPEND_LIMITS.attemptInputTokens,
      attemptOutputCeiling: SETUP_SPEND_LIMITS.attemptOutputTokens,
      attemptCostCeilingMicrousd,
      capMicrousd: SETUP_SPEND_LIMITS.capMicrousd,
      discussionMicrousd: SETUP_SPEND_LIMITS.discussionMicrousd,
      featurePolicyHash: pricingAttestation.featurePolicyHash,
      pricingSource: pricingAttestation.pricingSource,
      pricingVerifiedAt: pricingAttestation.pricingVerifiedAt,
      pricingValidThrough: pricingAttestation.pricingValidThrough,
      deployId,
    },
  };
}

function reviewedPolicyMatches(value, expectedId) {
  return REVIEWED_SETUP_PRICING_ATTESTATIONS.some((attestation) => {
    const expected = reviewedPolicyValue(attestation, value.deployId);
    return (
      expected.policyId === expectedId &&
      JSON.stringify(canonical(expected.policy)) ===
        JSON.stringify(canonical(value))
    );
  });
}

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
    value.attemptInputCeiling !== SETUP_SPEND_LIMITS.attemptInputTokens ||
    value.attemptOutputCeiling !== SETUP_SPEND_LIMITS.attemptOutputTokens ||
    value.capMicrousd !== SETUP_SPEND_LIMITS.capMicrousd ||
    value.discussionMicrousd !== SETUP_SPEND_LIMITS.discussionMicrousd ||
    value.featurePolicyHash !== SETUP_FEATURE_POLICY_HASH ||
    value.pricingSource !== SETUP_PRICING_SOURCE ||
    !text(value.deployId, 128) ||
    !reviewedPolicyMatches(value, expectedId)
  )
    fail();
  const verified = iso(value.pricingVerifiedAt);
  const validThrough = iso(value.pricingValidThrough);
  if (Date.parse(validThrough) <= Date.parse(verified)) fail();
  return clone(value);
}

function projectAttempt(value, number, ceilingMicrousd) {
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
    value.ceilingMicrousd !== ceilingMicrousd ||
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

function projectActive(value, jobId, policies) {
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
    !Object.hasOwn(policies, value.policyId) ||
    !['pending', 'unknown'].includes(value.accountingState) ||
    !positive(value.lastLedgerRevision) ||
    !positive(value.lastAccountingSequence) ||
    !HEX_64.test(value.lastAccountingDigest) ||
    !HEX_64.test(value.lastTransitionId) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length !== policies[value.policyId].maximumAttempts
  )
    fail();
  iso(value.createdAt);
  return {
    ...clone(value),
    attempts: value.attempts.map((attempt, index) =>
      projectAttempt(
        attempt,
        index + 1,
        policies[value.policyId].attemptCostCeilingMicrousd,
      ),
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
    value.triggerExposureMicrousd > SETUP_SPEND_LIMITS.capMicrousd ||
    !Array.isArray(value.decisions) ||
    value.decisions.length > SETUP_SPEND_LIMITS.maxDecisionsPerPolicy
  )
    fail();
  iso(value.triggeredAt);
  const decisions = value.decisions.map((decision, index) => {
    exact(decision, [
      'triggerRevision',
      'decidedAt',
      'observed',
      'decisionId',
      'decision',
      'authorizedThroughMicrousd',
      'authorizedOperations',
    ]);
    exact(decision.observed, [
      'settledMicrousd',
      'reservedMicrousd',
      'unknownMicrousd',
    ]);
    const observedExposureMicrousd =
      decision.observed.settledMicrousd +
      decision.observed.reservedMicrousd +
      decision.observed.unknownMicrousd;
    if (
      decision.triggerRevision !== index + 1 ||
      !integer(decision.observed.settledMicrousd) ||
      !integer(decision.observed.reservedMicrousd) ||
      !integer(decision.observed.unknownMicrousd) ||
      !Number.isSafeInteger(observedExposureMicrousd) ||
      !HEX_64.test(decision.decisionId) ||
      !DECISIONS.has(decision.decision) ||
      !integer(decision.authorizedThroughMicrousd) ||
      decision.authorizedThroughMicrousd > SETUP_SPEND_LIMITS.capMicrousd ||
      !Array.isArray(decision.authorizedOperations) ||
      new Set(decision.authorizedOperations).size !==
        decision.authorizedOperations.length ||
      decision.authorizedOperations.some((item) => !OPERATIONS.has(item)) ||
      (decision.decision === 'acknowledged' &&
        decision.authorizedThroughMicrousd < observedExposureMicrousd) ||
      (decision.decision === 'stopped' &&
        (decision.authorizedThroughMicrousd !== 0 ||
          decision.authorizedOperations.length !== 0))
    )
      fail();
    iso(decision.decidedAt);
    return clone(decision);
  });
  if (
    decisions.length !==
      (value.status === 'required'
        ? value.currentRevision - 1
        : value.currentRevision) ||
    decisions.some(
      (decision, index) =>
        decision.decision === 'stopped' &&
        (value.status !== 'stopped' || index !== decisions.length - 1),
    ) ||
    decisions.some(
      (decision, index) =>
        decisions.findIndex(
          (item) => item.decisionId === decision.decisionId,
        ) !== index,
    )
  )
    fail();
  const current = decisions.findLast(
    (decision) => decision.triggerRevision === value.currentRevision,
  );
  if (
    (value.status === 'required' && current !== undefined) ||
    (value.status !== 'required' && current?.decision !== value.status)
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
      projectActive(entry, id, policies),
    ]),
  );
  const discussions = Object.fromEntries(
    Object.entries(value.discussions).map(([id, discussion]) => {
      if (!policyIds.has(id)) fail();
      return [id, projectDiscussion(discussion, id)];
    }),
  );
  const decisionIds = Object.values(discussions).flatMap(({ decisions }) =>
    decisions.map(({ decisionId }) => decisionId),
  );
  if (new Set(decisionIds).size !== decisionIds.length) fail();
  const projected = {
    ...clone(value),
    policies,
    active,
    discussions,
  };
  if (
    byteLength(projected) > SETUP_SPEND_LIMITS.maxBytes ||
    preflightBytes(projected) > SETUP_SPEND_LIMITS.maxBytes
  )
    fail();
  exposureMicrousd(projected);
  const requiresPricingReview = Object.values(active).some((entry) =>
    entry.attempts.some(
      (attempt) =>
        attempt.state === 'unknown' &&
        attempt.actualCostMicrousd > attempt.ceilingMicrousd,
    ),
  );
  if (requiresPricingReview && !projected.pricingReviewRequired) fail();
  return projected;
}

export function setupSpendLedgerPreflightBytes(value) {
  return preflightBytes(projectSpendLedger(value));
}

function setupPolicyValue(pricingAttestation, deployId) {
  const attestation = projectSetupPricingAttestation(pricingAttestation);
  if (
    JSON.stringify(canonical(attestation)) !==
      JSON.stringify(canonical(REVIEWED_SETUP_PRICING_ATTESTATION)) ||
    attestation.inputRateMicrousd !== SETUP_SPEND_LIMITS.inputRateMicrousd ||
    attestation.outputRateMicrousd !== SETUP_SPEND_LIMITS.outputRateMicrousd ||
    !text(deployId, 128)
  )
    fail();
  const expected = reviewedPolicyValue(attestation, deployId);
  if (
    expected.policy.attemptCostCeilingMicrousd !==
    SETUP_SPEND_LIMITS.attemptCostMicrousd
  )
    fail();
  return expected;
}

export function createSetupPolicy({ deployId, pricingAttestation }) {
  const { policyId, policy } = setupPolicyValue(pricingAttestation, deployId);
  return { policyId, policy: projectPolicy(policy, policyId) };
}

function setupPolicyMatches(value, pricingAttestation, deployId) {
  const expected = setupPolicyValue(pricingAttestation, deployId);
  return (
    expected.policyId === value.policyId &&
    JSON.stringify(canonical(expected.policy)) ===
      JSON.stringify(canonical(value.policy))
  );
}

/*
 * A reviewed pricing attestation is immutable deploy input. The deployment ID
 * remains runtime-specific, while every price and billed-feature fact comes
 * from the attestation contract above.
 */
export function assertSetupPolicyBinding({
  policyId,
  policy,
  pricingAttestation,
  deployId,
}) {
  if (
    !setupPolicyMatches(
      { policyId, policy: projectPolicy(policy, policyId) },
      pricingAttestation,
      deployId,
    )
  )
    fail();
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

/**
 * Install and select one immutable deploy policy without changing monetary
 * accounting or removing policy-scoped decisions from earlier deploys.
 */
export function activateSetupPolicy(
  input,
  { policyId, policy, at, expectedRevision },
) {
  const ledger = projectSpendLedger(input);
  const projectedPolicy = projectPolicy(policy, policyId);
  const activatedAt = iso(at);
  if (ledger.revision !== expectedRevision) fail();
  const existing = ledger.policies[policyId];
  if (
    existing &&
    JSON.stringify(canonical(existing)) !==
      JSON.stringify(canonical(projectedPolicy))
  )
    fail();
  if (ledger.activePolicyId === policyId) {
    if (!existing) fail();
    return ledger;
  }
  if (
    Date.parse(activatedAt) < Date.parse(ledger.updatedAt) ||
    (!existing &&
      Object.keys(ledger.policies).length >= SETUP_SPEND_LIMITS.maxPolicies)
  )
    fail();
  const next = clone(ledger);
  next.revision = checkedAdd(next.revision, 1);
  if (!existing) next.policies[policyId] = projectedPolicy;
  next.activePolicyId = policyId;
  next.updatedAt = activatedAt;
  return projectSpendLedger(next);
}

export function spendBreakdownMicrousd(ledger) {
  let reservedMicrousd = 0;
  let unknownMicrousd = 0;
  for (const entry of Object.values(ledger.active)) {
    for (const attempt of entry.attempts) {
      if (attempt.state === 'reserved')
        reservedMicrousd = checkedAdd(
          reservedMicrousd,
          attempt.ceilingMicrousd,
        );
      else if (attempt.state === 'unknown')
        unknownMicrousd = checkedAdd(
          unknownMicrousd,
          attempt.unknownExposureMicrousd,
        );
    }
  }
  return Object.freeze({
    settledMicrousd: ledger.settledMicrousd,
    reservedMicrousd,
    unknownMicrousd,
  });
}

export function exposureMicrousd(ledger) {
  const observed = spendBreakdownMicrousd(ledger);
  return checkedAdd(
    observed.settledMicrousd,
    observed.reservedMicrousd,
    observed.unknownMicrousd,
  );
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
    expectedPricingAttestation,
  },
) {
  const ledger = projectSpendLedger(input);
  const reservationAt = iso(at);
  const policy = ledger.policies[ledger.activePolicyId];
  assertSetupPolicyBinding({
    policyId: ledger.activePolicyId,
    policy,
    pricingAttestation: expectedPricingAttestation,
    deployId: expectedDeployId,
  });
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
  const discussion = ledger.discussions[policyId];
  if (discussion?.status === 'stopped') return { status: 'stopped', ledger };
  if (discussion?.status === 'required')
    return { status: 'discussion-required', ledger };
  const proposed = checkedAdd(
    ...Array.from(
      { length: policy.maximumAttempts },
      () => policy.attemptCostCeilingMicrousd,
    ),
  );
  const proposedExposure = checkedAdd(exposureMicrousd(ledger), proposed);
  if (proposedExposure > SETUP_SPEND_LIMITS.capMicrousd)
    return { status: 'budget-exhausted', ledger };
  const decision = currentDecision(ledger, policyId);
  if (
    (proposedExposure >= SETUP_SPEND_LIMITS.discussionMicrousd && !decision) ||
    (decision &&
      (decision.authorizedThroughMicrousd < proposedExposure ||
        !decision.authorizedOperations.includes(operation)))
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
            { length: policy.maximumAttempts },
            (_, index) => ({
              number: index + 1,
              ceilingMicrousd: policy.attemptCostCeilingMicrousd,
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
    pricingReviewRequired = false,
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
  const upgradesUnknown = current?.state === 'unknown' && state === 'unknown';
  if (!current || (current.state !== 'reserved' && !upgradesUnknown)) fail();
  const recordedAt = iso(at);
  const ceiling = current.ceilingMicrousd;
  if (
    !integer(actualCostMicrousd) ||
    !integer(unknownExposureMicrousd) ||
    typeof pricingReviewRequired !== 'boolean' ||
    (pricingReviewRequired && state !== 'unknown') ||
    (state === 'settled' &&
      (actualCostMicrousd > ceiling || unknownExposureMicrousd !== 0)) ||
    (state === 'released' &&
      (actualCostMicrousd !== 0 || unknownExposureMicrousd !== 0)) ||
    (state === 'unknown' &&
      unknownExposureMicrousd < Math.max(ceiling, actualCostMicrousd)) ||
    (upgradesUnknown &&
      (actualCostMicrousd < current.actualCostMicrousd ||
        unknownExposureMicrousd < current.unknownExposureMicrousd ||
        Date.parse(recordedAt) < Date.parse(current.recordedAt)))
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
      pricingReviewRequired,
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
      if (pricingReviewRequired || actualCostMicrousd > ceiling)
        next.pricingReviewRequired = true;
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
    observed: spendBreakdownMicrousd(ledger),
    decisionId,
    decision,
    authorizedThroughMicrousd,
    authorizedOperations: [...authorizedOperations],
  });
  next.revision = checkedAdd(next.revision, 1);
  next.updatedAt = at;
  return projectSpendLedger(next);
}
