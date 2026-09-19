import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SETUP_SPEND_LEDGER_KEY,
  applyCurrentSetupDiscussionDecision,
  applySetupDiscussionDecision,
  ensureSetupSpendLedger,
  fenceSetupReservation,
  markSetupAttemptUnknown,
  readSetupSpendReservation,
  readSetupSpendSummary,
  releaseSetupAttempt,
  removeCompletedSetupSpend,
  reserveSetupSpend,
  settleSetupAttempt,
} from '../lib/spend-store.mjs';
import {
  REVIEWED_SETUP_PRICING_ATTESTATION,
  SETUP_SPEND_LIMITS,
  exposureMicrousd,
} from '../lib/spend.mjs';

const budget = Object.freeze({ name: 'synthetic-budget' });
const deployId = 'deploy-1';
const id = (character) => character.repeat(64);
const at = (hour) =>
  `2026-09-${hour < 20 ? '19' : '20'}T${String(hour % 20).padStart(2, '0')}:30:00.000Z`;
const context = (storage) => ({
  storage,
  budget,
  deployId,
  pricingAttestation: REVIEWED_SETUP_PRICING_ATTESTATION,
});
const authorize = async () => true;

function memoryStorage() {
  let current = null;
  let sequence = 0;
  let lose = false;
  const metrics = { reads: 0, writes: 0 };
  const etag = () => `"etag-${sequence}"`;
  return {
    async read(key, options) {
      assert.equal(key, SETUP_SPEND_LEDGER_KEY);
      assert.deepEqual(options, { budget });
      metrics.reads += 1;
      return current === null
        ? null
        : { value: structuredClone(current), etag: etag() };
    },
    async write(key, value, condition, options) {
      assert.equal(key, SETUP_SPEND_LEDGER_KEY);
      assert.deepEqual(options, { budget });
      metrics.writes += 1;
      if (
        (condition.onlyIfNew === true && current !== null) ||
        (condition.onlyIfMatch !== undefined &&
          condition.onlyIfMatch !== etag())
      )
        return { modified: false };
      current = structuredClone(value);
      sequence += 1;
      if (lose) {
        lose = false;
        throw new Error('synthetic lost acknowledgement');
      }
      return { modified: true, etag: etag() };
    },
    loseNextAcknowledgement() {
      lose = true;
    },
    value() {
      return structuredClone(current);
    },
    metrics,
  };
}

async function setup(storage) {
  return ensureSetupSpendLedger({
    ...context(storage),
    at: at(4),
  });
}

test('ledger creation resolves a lost acknowledgement and exposes only a safe summary', async () => {
  const storage = memoryStorage();
  storage.loseNextAcknowledgement();
  assert.deepEqual(await setup(storage), { status: 'existing', revision: 0 });
  assert.deepEqual(await setup(storage), { status: 'existing', revision: 0 });

  const summary = await readSetupSpendSummary({
    ...context(storage),
    at: at(5),
  });
  assert.deepEqual(Object.keys(summary), [
    'mode',
    'status',
    'policyId',
    'model',
    'exposureMicrousd',
    'settledMicrousd',
    'capMicrousd',
    'discussionMicrousd',
    'remainingMicrousd',
    'pricingValidThrough',
    'activeJobCount',
    'discussion',
  ]);
  assert.equal(summary.mode, 'setup');
  assert.equal(summary.status, 'available');
  assert.equal(summary.exposureMicrousd, 0);
  assert.equal(summary.capMicrousd, 25_000_000);
  assert.ok(!JSON.stringify(summary).includes('accountingDigest'));
  assert.ok(!JSON.stringify(summary).includes('deploy-1'));

  await assert.rejects(
    readSetupSpendSummary({
      ...context(storage),
      deployId: 'another-deploy',
      at: at(5),
    }),
    { code: 'service_unavailable' },
  );
});

test('concurrent reservations revalidate after CAS conflict and install one threshold gate', async () => {
  const storage = memoryStorage();
  await setup(storage);
  const validations = [];
  const revalidate = async (details) => {
    validations.push(details);
    return true;
  };
  const results = await Promise.all([
    reserveSetupSpend({
      ...context(storage),
      jobId: id('a'),
      operation: 'generate',
      at: at(5),
      revalidate,
    }),
    reserveSetupSpend({
      ...context(storage),
      jobId: id('b'),
      operation: 'refresh',
      at: at(6),
      revalidate,
    }),
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [
    'discussion-required',
    'reserved',
  ]);
  assert.ok(validations.length >= 3);
  assert.ok(
    validations.every(
      (details) =>
        details.kind === 'reservation' &&
        !Object.hasOwn(details, 'accountingDigest'),
    ),
  );
  const ledger = storage.value();
  assert.equal(Object.keys(ledger.active).length, 1);
  assert.equal(ledger.accountingSequence, 1);
  assert.equal(ledger.revision, 2);
  assert.equal(ledger.discussions[ledger.activePolicyId].currentRevision, 1);

  const writes = storage.metrics.writes;
  const gated = await reserveSetupSpend({
    ...context(storage),
    jobId: id('c'),
    operation: 'generate',
    at: at(7),
    revalidate,
  });
  assert.equal(gated.status, 'discussion-required');
  assert.equal(storage.metrics.writes, writes);
});

test('reservation and attempt accounting are idempotent across lost acknowledgements', async () => {
  const storage = memoryStorage();
  await setup(storage);
  let validations = 0;
  const revalidate = async () => {
    validations += 1;
    return true;
  };

  storage.loseNextAcknowledgement();
  const reserved = await reserveSetupSpend({
    ...context(storage),
    jobId: id('a'),
    operation: 'generate',
    at: at(5),
    revalidate,
  });
  assert.equal(reserved.status, 'reserved');
  assert.deepEqual(reserved.reservationMicrousd, [5_409_600, 5_409_600]);
  assert.equal(reserved.accounting.status, 'pending');
  const reservationValidations = validations;
  assert.equal(
    (
      await reserveSetupSpend({
        ...context(storage),
        jobId: id('a'),
        operation: 'generate',
        at: at(6),
        revalidate,
      })
    ).status,
    'existing',
  );
  assert.equal(validations, reservationValidations + 1);

  storage.loseNextAcknowledgement();
  const settled = await settleSetupAttempt({
    ...context(storage),
    jobId: id('a'),
    attemptNumber: 1,
    actualCostMicrousd: 123_456,
    at: at(7),
    revalidate,
  });
  assert.equal(settled.status, 'updated');
  assert.equal(settled.accounting.status, 'pending');
  const settlementValidations = validations;
  assert.equal(
    (
      await settleSetupAttempt({
        ...context(storage),
        jobId: id('a'),
        attemptNumber: 1,
        actualCostMicrousd: 123_456,
        at: at(8),
        revalidate,
      })
    ).status,
    'existing',
  );
  assert.equal(validations, settlementValidations);

  const released = await releaseSetupAttempt({
    ...context(storage),
    jobId: id('a'),
    attemptNumber: 2,
    at: at(9),
    revalidate,
  });
  assert.equal(released.accounting.status, 'complete');
  assert.equal(storage.value().settledMicrousd, 123_456);
  assert.equal(storage.value().accountingSequence, 3);

  storage.loseNextAcknowledgement();
  assert.equal(
    (
      await removeCompletedSetupSpend({
        ...context(storage),
        jobId: id('a'),
        accounting: released.accounting,
        at: at(10),
      })
    ).status,
    'removed',
  );
  assert.equal(
    (
      await removeCompletedSetupSpend({
        ...context(storage),
        jobId: id('a'),
        accounting: released.accounting,
        at: at(11),
      })
    ).status,
    'absent',
  );
  assert.equal(storage.value().accountingSequence, 3);
  assert.equal(storage.value().revision, 4);
});

test('reservation reads expose exact immutable worker accounting without creating entries', async () => {
  const storage = memoryStorage();
  await setup(storage);
  assert.equal(
    await readSetupSpendReservation({
      ...context(storage),
      jobId: id('a'),
    }),
    null,
  );
  const writes = storage.metrics.writes;

  await reserveSetupSpend({
    ...context(storage),
    jobId: id('a'),
    operation: 'generate',
    at: at(5),
    revalidate: authorize,
  });
  const reserved = await readSetupSpendReservation({
    ...context(storage),
    jobId: id('a'),
  });
  assert.deepEqual(Object.keys(reserved), [
    'policyId',
    'reservationMicrousd',
    'attempts',
    'accounting',
  ]);
  assert.deepEqual(reserved.reservationMicrousd, [5_409_600, 5_409_600]);
  assert.deepEqual(
    reserved.attempts.map(({ number, ceilingMicrousd, state }) => ({
      number,
      ceilingMicrousd,
      state,
    })),
    [
      { number: 1, ceilingMicrousd: 5_409_600, state: 'reserved' },
      { number: 2, ceilingMicrousd: 5_409_600, state: 'reserved' },
    ],
  );
  assert.equal(reserved.accounting.status, 'pending');
  assert.equal(Object.isFrozen(reserved), true);
  assert.equal(Object.isFrozen(reserved.reservationMicrousd), true);
  assert.equal(Object.isFrozen(reserved.attempts), true);
  assert.equal(Object.isFrozen(reserved.attempts[0]), true);
  assert.equal(storage.metrics.writes, writes + 1);

  await settleSetupAttempt({
    ...context(storage),
    jobId: id('a'),
    attemptNumber: 1,
    actualCostMicrousd: 123_456,
    at: at(6),
    revalidate: authorize,
  });
  await markSetupAttemptUnknown({
    ...context(storage),
    jobId: id('a'),
    attemptNumber: 2,
    actualCostMicrousd: 0,
    unknownExposureMicrousd: SETUP_SPEND_LIMITS.attemptCostMicrousd,
    at: at(7),
    revalidate: authorize,
  });
  const accounted = await readSetupSpendReservation({
    ...context(storage),
    jobId: id('a'),
  });
  assert.equal(accounted.attempts[0].state, 'settled');
  assert.equal(accounted.attempts[0].actualCostMicrousd, 123_456);
  assert.equal(accounted.attempts[1].state, 'unknown');
  assert.equal(
    accounted.attempts[1].unknownExposureMicrousd,
    SETUP_SPEND_LIMITS.attemptCostMicrousd,
  );
  assert.equal(accounted.accounting.status, 'unknown');
  assert.ok(!Object.hasOwn(accounted, 'createdAt'));
  assert.ok(!JSON.stringify(accounted).includes('deploy-1'));

  await assert.rejects(
    readSetupSpendReservation({
      ...context(storage),
      deployId: 'another-deploy',
      jobId: id('a'),
    }),
    { code: 'service_unavailable' },
  );
});

test('reservation fencing advances only logical revision and resolves a lost acknowledgement', async () => {
  const storage = memoryStorage();
  await setup(storage);
  const before = storage.value();
  storage.loseNextAcknowledgement();
  assert.deepEqual(
    await fenceSetupReservation({
      ...context(storage),
      jobId: id('f'),
      operation: 'generate',
      at: at(5),
      revalidate: authorize,
    }),
    { status: 'fenced', revision: before.revision + 1 },
  );
  const after = storage.value();
  assert.deepEqual(after, { ...before, revision: before.revision + 1 });
});

test('reservation fencing prevents a delayed reservation from committing', async () => {
  const storage = memoryStorage();
  await setup(storage);
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  let resume;
  const paused = new Promise((resolve) => {
    resume = resolve;
  });
  let first = true;
  const reservation = reserveSetupSpend({
    ...context(storage),
    jobId: id('a'),
    operation: 'generate',
    at: at(5),
    revalidate: async ({ kind }) => {
      if (kind === 'reservation' && first) {
        first = false;
        entered();
        await paused;
        return true;
      }
      return false;
    },
  });
  await waiting;
  assert.equal(
    (
      await fenceSetupReservation({
        ...context(storage),
        jobId: id('a'),
        operation: 'generate',
        at: at(6),
        revalidate: authorize,
      })
    ).status,
    'fenced',
  );
  resume();
  await assert.rejects(reservation, { code: 'service_unavailable' });
  assert.equal(Object.hasOwn(storage.value().active, id('a')), false);
});

test('reservation fencing returns exact facts when a delayed reservation wins', async () => {
  const storage = memoryStorage();
  await setup(storage);
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  let resume;
  const paused = new Promise((resolve) => {
    resume = resolve;
  });
  let first = true;
  const fencing = fenceSetupReservation({
    ...context(storage),
    jobId: id('a'),
    operation: 'generate',
    at: at(5),
    revalidate: async ({ kind }) => {
      if (kind === 'reservation-fence' && first) {
        first = false;
        entered();
        await paused;
      }
      return true;
    },
  });
  await waiting;
  const reserved = await reserveSetupSpend({
    ...context(storage),
    jobId: id('a'),
    operation: 'generate',
    at: at(6),
    revalidate: authorize,
  });
  assert.equal(reserved.status, 'reserved');
  resume();
  const observed = await fencing;
  assert.equal(observed.status, 'existing');
  assert.equal(observed.policyId, reserved.policyId);
  assert.deepEqual(observed.reservationMicrousd, reserved.reservationMicrousd);
  assert.deepEqual(observed.accounting, reserved.accounting);
});

test('unknown exposure is idempotent and prevents completed-entry removal', async () => {
  const storage = memoryStorage();
  await setup(storage);
  await reserveSetupSpend({
    ...context(storage),
    jobId: id('a'),
    operation: 'generate',
    at: at(5),
    revalidate: authorize,
  });
  const unknown = await markSetupAttemptUnknown({
    ...context(storage),
    jobId: id('a'),
    attemptNumber: 1,
    actualCostMicrousd: 0,
    unknownExposureMicrousd: SETUP_SPEND_LIMITS.attemptCostMicrousd,
    at: at(6),
    revalidate: authorize,
  });
  assert.equal(unknown.accounting.status, 'unknown');
  assert.equal(
    (
      await markSetupAttemptUnknown({
        ...context(storage),
        jobId: id('a'),
        attemptNumber: 1,
        actualCostMicrousd: 0,
        unknownExposureMicrousd: SETUP_SPEND_LIMITS.attemptCostMicrousd,
        at: at(7),
        revalidate: authorize,
      })
    ).status,
    'existing',
  );
  await releaseSetupAttempt({
    ...context(storage),
    jobId: id('a'),
    attemptNumber: 2,
    at: at(8),
    revalidate: authorize,
  });
  await assert.rejects(
    removeCompletedSetupSpend({
      ...context(storage),
      jobId: id('a'),
      accounting: { ...unknown.accounting, status: 'complete' },
      at: at(9),
    }),
    { code: 'service_unavailable' },
  );
  assert.equal(Object.hasOwn(storage.value().active, id('a')), true);
});

test('discussion decisions are exact, lost-ack safe and never raise the cap', async () => {
  const storage = memoryStorage();
  await setup(storage);
  await reserveSetupSpend({
    ...context(storage),
    jobId: id('a'),
    operation: 'generate',
    at: at(5),
    revalidate: authorize,
  });
  const gated = await reserveSetupSpend({
    ...context(storage),
    jobId: id('b'),
    operation: 'refresh',
    at: at(6),
    revalidate: authorize,
  });
  assert.equal(gated.status, 'discussion-required');
  const ledger = storage.value();
  const discussion = ledger.discussions[ledger.activePolicyId];
  const decision = {
    ...context(storage),
    policyId: ledger.activePolicyId,
    triggerRevision: discussion.currentRevision,
    decisionId: id('d'),
    decision: 'acknowledged',
    authorizedThroughMicrousd: 25_000_000,
    authorizedOperations: ['refresh'],
    observedExposureMicrousd: exposureMicrousd(ledger),
    expectedRevision: ledger.revision,
    at: at(7),
  };
  storage.loseNextAcknowledgement();
  assert.equal(
    (await applySetupDiscussionDecision(decision)).status,
    'updated',
  );
  assert.equal(
    (
      await applySetupDiscussionDecision({
        ...decision,
        at: at(8),
      })
    ).status,
    'existing',
  );
  await assert.rejects(
    applySetupDiscussionDecision({
      ...decision,
      at: at(8),
      authorizedOperations: ['generate'],
    }),
    { code: 'service_unavailable' },
  );

  assert.equal(
    (
      await reserveSetupSpend({
        ...context(storage),
        jobId: id('b'),
        operation: 'refresh',
        at: at(9),
        revalidate: authorize,
      })
    ).status,
    'reserved',
  );
  const exhausted = await reserveSetupSpend({
    ...context(storage),
    jobId: id('c'),
    operation: 'refresh',
    at: at(10),
    revalidate: authorize,
  });
  assert.equal(exhausted.status, 'budget-exhausted');
  assert.ok(exhausted.spend.exposureMicrousd <= 25_000_000);
});

test('discussion decisions are revision-bound and a stop remains permanent', async () => {
  const storage = memoryStorage();
  await setup(storage);
  await reserveSetupSpend({
    ...context(storage),
    jobId: id('a'),
    operation: 'generate',
    at: at(5),
    revalidate: authorize,
  });
  await reserveSetupSpend({
    ...context(storage),
    jobId: id('b'),
    operation: 'refresh',
    at: at(6),
    revalidate: authorize,
  });
  const ledger = storage.value();
  const discussion = ledger.discussions[ledger.activePolicyId];
  const decision = {
    ...context(storage),
    policyId: ledger.activePolicyId,
    triggerRevision: discussion.currentRevision,
    decisionId: id('e'),
    decision: 'stopped',
    authorizedThroughMicrousd: 0,
    authorizedOperations: [],
    observedExposureMicrousd: exposureMicrousd(ledger),
    expectedRevision: ledger.revision,
    at: at(7),
  };
  assert.equal(
    (
      await applySetupDiscussionDecision({
        ...decision,
        expectedRevision: decision.expectedRevision - 1,
      })
    ).status,
    'conflict',
  );
  assert.equal(
    (await applySetupDiscussionDecision(decision)).status,
    'updated',
  );
  assert.equal(
    (
      await reserveSetupSpend({
        ...context(storage),
        jobId: id('c'),
        operation: 'generate',
        at: at(8),
        revalidate: authorize,
      })
    ).status,
    'stopped',
  );
  assert.equal(
    (
      await readSetupSpendSummary({
        ...context(storage),
        at: at(9),
      })
    ).status,
    'stopped',
  );
});

test('current discussion decisions bind private revision and exposure internally', async () => {
  const storage = memoryStorage();
  await setup(storage);
  await reserveSetupSpend({
    ...context(storage),
    jobId: id('a'),
    operation: 'generate',
    at: at(5),
    revalidate: authorize,
  });
  await reserveSetupSpend({
    ...context(storage),
    jobId: id('b'),
    operation: 'refresh',
    at: at(6),
    revalidate: authorize,
  });
  const ledger = storage.value();
  const discussion = ledger.discussions[ledger.activePolicyId];
  const decision = {
    ...context(storage),
    policyId: ledger.activePolicyId,
    discussionRevision: discussion.currentRevision,
    decisionId: id('f'),
    decision: 'acknowledge',
    authorizedThroughMicrousd: 25_000_000,
    authorizedOperations: ['refresh'],
    at: at(7),
  };
  storage.loseNextAcknowledgement();
  const applied = await applyCurrentSetupDiscussionDecision(decision);
  assert.equal(applied.status, 'updated');
  assert.equal(applied.spend.status, 'available');
  assert.equal(
    (
      await applyCurrentSetupDiscussionDecision({
        ...decision,
        at: at(8),
      })
    ).status,
    'existing',
  );
  await assert.rejects(
    applyCurrentSetupDiscussionDecision({
      ...decision,
      authorizedOperations: ['generate'],
      at: at(8),
    }),
    { code: 'service_unavailable' },
  );
  const stale = await applyCurrentSetupDiscussionDecision({
    ...decision,
    discussionRevision: decision.discussionRevision + 1,
    decisionId: id('1'),
    at: at(8),
  });
  assert.equal(stale.status, 'conflict');
  assert.ok(!Object.hasOwn(stale.spend, 'revision'));
  assert.ok(!Object.hasOwn(stale.spend, 'observedExposureMicrousd'));
});
