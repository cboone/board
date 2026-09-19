import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SETUP_SPEND_LIMITS,
  createSetupLedger,
  createSetupPolicy,
  decideSetupDiscussion,
  exposureMicrousd,
  projectSpendLedger,
  removeCompletedSetupJob,
  reserveSetupJob as reserveSetupJobRaw,
  updateSetupAttempt,
} from '../lib/spend.mjs';

const at = (hour = 0) =>
  `2026-09-18T${String(hour).padStart(2, '0')}:00:00.000Z`;
const id = (character) => character.repeat(64);
const reserveSetupJob = (ledger, options) =>
  reserveSetupJobRaw(ledger, {
    expectedPolicyId: ledger.activePolicyId,
    expectedDeployId: 'deploy-1',
    ...options,
  });
function setup() {
  const { policyId, policy } = createSetupPolicy({
    deployId: 'deploy-1',
    pricingSource: 'https://platform.claude.com/docs/en/about-claude/pricing',
    pricingVerifiedAt: at(0),
    pricingValidThrough: '2026-09-25T00:00:00.000Z',
  });
  return createSetupLedger({ policyId, policy, at: at(0) });
}

test('setup policy fixes Opus 5 high-effort global standard pricing and cap', () => {
  const ledger = setup();
  const policy = ledger.policies[ledger.activePolicyId];
  assert.equal(policy.model, 'claude-opus-5');
  assert.equal(policy.effort, 'high');
  assert.equal(policy.inferenceGeo, 'global');
  assert.equal(policy.serviceTier, 'standard_only');
  assert.equal(policy.attemptCostCeilingMicrousd, 5_409_600);
  assert.equal(policy.capMicrousd, 25_000_000);
  assert.equal(exposureMicrousd(ledger), 0);
});

test('reservation accounts for both attempts once and stores per-entry recovery facts', () => {
  const result = reserveSetupJob(setup(), {
    jobId: id('a'),
    operation: 'generate',
    at: at(1),
    expectedRevision: 0,
  });
  assert.equal(result.status, 'reserved');
  assert.equal(result.ledger.revision, 1);
  assert.equal(result.ledger.accountingSequence, 1);
  assert.equal(
    exposureMicrousd(result.ledger),
    2 * SETUP_SPEND_LIMITS.attemptCostMicrousd,
  );
  const entry = result.ledger.active[id('a')];
  assert.equal(entry.lastLedgerRevision, result.accounting.ledgerRevision);
  assert.equal(
    entry.lastAccountingSequence,
    result.accounting.accountingSequence,
  );
  assert.equal(entry.lastAccountingDigest, result.accounting.accountingDigest);
  assert.equal(entry.lastTransitionId, result.accounting.transitionId);
  assert.equal(
    reserveSetupJob(result.ledger, {
      jobId: id('a'),
      operation: 'generate',
      at: at(1),
      expectedRevision: 1,
    }).status,
    'existing',
  );
});

test('known attempt costs settle once, unused reservations release, and complete entries remove outside the digest', () => {
  const reserved = reserveSetupJob(setup(), {
    jobId: id('a'),
    operation: 'refresh',
    at: at(1),
    expectedRevision: 0,
  }).ledger;
  const settled = updateSetupAttempt(reserved, {
    jobId: id('a'),
    attemptNumber: 1,
    state: 'settled',
    actualCostMicrousd: 123_456,
    at: at(2),
    expectedRevision: 1,
  }).ledger;
  const released = updateSetupAttempt(settled, {
    jobId: id('a'),
    attemptNumber: 2,
    state: 'released',
    at: at(3),
    expectedRevision: 2,
  }).ledger;
  assert.equal(exposureMicrousd(released), 123_456);
  const digest = released.accountingDigest;
  const sequence = released.accountingSequence;
  const removed = removeCompletedSetupJob(released, {
    jobId: id('a'),
    expectedRevision: 3,
    at: at(4),
  });
  assert.equal(removed.revision, 4);
  assert.equal(removed.accountingSequence, sequence);
  assert.equal(removed.accountingDigest, digest);
  assert.equal(removed.settledMicrousd, 123_456);
  assert.deepEqual(removed.active, {});
});

test('unknown exposure is conservative, retained, and cannot be removed', () => {
  const reserved = reserveSetupJob(setup(), {
    jobId: id('a'),
    operation: 'generate',
    at: at(1),
    expectedRevision: 0,
  }).ledger;
  const unknown = updateSetupAttempt(reserved, {
    jobId: id('a'),
    attemptNumber: 1,
    state: 'unknown',
    actualCostMicrousd: 7_000_000,
    unknownExposureMicrousd: 7_000_000,
    at: at(2),
    expectedRevision: 1,
  }).ledger;
  assert.equal(unknown.active[id('a')].accountingState, 'unknown');
  assert.equal(
    exposureMicrousd(unknown),
    7_000_000 + SETUP_SPEND_LIMITS.attemptCostMicrousd,
  );
  assert.throws(
    () =>
      removeCompletedSetupJob(unknown, {
        jobId: id('a'),
        expectedRevision: 2,
        at: at(3),
      }),
    { code: 'service_unavailable' },
  );
});

test('second full reservation raises a revision-bound discussion gate before exposure reaches twenty dollars', () => {
  const first = reserveSetupJob(setup(), {
    jobId: id('a'),
    operation: 'generate',
    at: at(1),
    expectedRevision: 0,
  }).ledger;
  const gated = reserveSetupJob(first, {
    jobId: id('b'),
    operation: 'refresh',
    at: at(2),
    expectedRevision: 1,
  });
  assert.equal(gated.status, 'discussion-required');
  assert.equal(Object.hasOwn(gated.ledger.active, id('b')), false);
  assert.equal(gated.ledger.accountingSequence, 1);
  const discussion = gated.ledger.discussions[gated.ledger.activePolicyId];
  assert.equal(discussion.status, 'required');
  assert.ok(discussion.triggerExposureMicrousd >= 20_000_000);
  const decided = decideSetupDiscussion(gated.ledger, {
    policyId: gated.ledger.activePolicyId,
    triggerRevision: discussion.currentRevision,
    decisionId: id('d'),
    decision: 'acknowledged',
    authorizedThroughMicrousd: 25_000_000,
    authorizedOperations: ['refresh'],
    observedExposureMicrousd: exposureMicrousd(gated.ledger),
    at: at(3),
    expectedRevision: gated.ledger.revision,
  });
  const second = reserveSetupJob(decided, {
    jobId: id('b'),
    operation: 'refresh',
    at: at(4),
    expectedRevision: decided.revision,
  });
  assert.equal(second.status, 'reserved');
  assert.ok(exposureMicrousd(second.ledger) <= 25_000_000);
});

test('stopped discussion is permanent and malformed or oversized ledgers fail closed', () => {
  const first = reserveSetupJob(setup(), {
    jobId: id('a'),
    operation: 'generate',
    at: at(1),
    expectedRevision: 0,
  }).ledger;
  const gated = reserveSetupJob(first, {
    jobId: id('b'),
    operation: 'refresh',
    at: at(2),
    expectedRevision: 1,
  }).ledger;
  const discussion = gated.discussions[gated.activePolicyId];
  const stopped = decideSetupDiscussion(gated, {
    policyId: gated.activePolicyId,
    triggerRevision: discussion.currentRevision,
    decisionId: id('e'),
    decision: 'stopped',
    authorizedThroughMicrousd: 0,
    authorizedOperations: [],
    observedExposureMicrousd: exposureMicrousd(gated),
    at: at(3),
    expectedRevision: gated.revision,
  });
  assert.equal(
    reserveSetupJob(stopped, {
      jobId: id('b'),
      operation: 'refresh',
      at: at(4),
      expectedRevision: stopped.revision,
    }).status,
    'stopped',
  );
  assert.throws(() => projectSpendLedger({ ...stopped, unexpected: true }), {
    code: 'service_unavailable',
  });
  assert.throws(
    () =>
      projectSpendLedger({
        ...stopped,
        policies: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [
            `policy-${index}`,
            stopped.policies[stopped.activePolicyId],
          ]),
        ),
      }),
    { code: 'service_unavailable' },
  );
});
