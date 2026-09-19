import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyJobRecovery,
  ownsFinalization,
  ownsPaidAttempt,
  projectJobMachine,
  transitionJob,
} from '../lib/job-machine.mjs';
import { createAnalysisJob } from '../lib/jobs.mjs';

const hash = (character) => character.repeat(64);
const TIMES = Object.freeze({
  created: '2026-09-18T12:00:00.000Z',
  reserved: '2026-09-18T12:01:00.000Z',
  dispatchable: '2026-09-18T12:02:00.000Z',
  collecting: '2026-09-18T12:03:00.000Z',
  counting: '2026-09-18T12:04:00.000Z',
  primary: '2026-09-18T12:05:00.000Z',
  response: '2026-09-18T12:06:00.000Z',
  validating: '2026-09-18T12:07:00.000Z',
  rejected: '2026-09-18T12:08:00.000Z',
  accounted: '2026-09-18T12:09:00.000Z',
  afterAttempt: '2026-09-18T12:16:00.000Z',
  correctiveResponse: '2026-09-18T12:17:00.000Z',
  correctiveValidating: '2026-09-18T12:18:00.000Z',
  correctiveCandidate: '2026-09-18T12:26:00.000Z',
  version: '2026-09-18T12:27:00.000Z',
  published: '2026-09-18T12:28:00.000Z',
  settled: '2026-09-18T12:29:00.000Z',
  succeeded: '2026-09-18T12:30:00.000Z',
});

const accounting = (sequence, status = 'pending') => ({
  status,
  ledgerRevision: sequence,
  accountingSequence: sequence,
  accountingDigest: hash(String((sequence % 9) + 1)),
  transitionId: hash(String(((sequence + 1) % 9) + 1)),
});

const usage = Object.freeze({
  terminalClass: 'complete-response',
  terminalStopReason: 'end_turn',
  inputTokens: 1000,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 100,
  costMicrousd: 4000,
});

function created() {
  return createAnalysisJob({
    ownerId: 99961,
    repositoryId: 17,
    idempotencyKey: '018f0f11-1111-7111-8111-111111111111',
    operation: 'generate',
    expectedCurrentReportId: null,
    authorizationEpoch: 2,
    admissionDeployId: 'deploy-1',
    at: TIMES.created,
    deadlineAt: '2026-09-18T12:30:00.000Z',
  });
}

function reserved(job = created()) {
  return transitionJob(job, {
    type: 'reservation-committed',
    at: TIMES.reserved,
    deadlineAt: '2026-09-18T12:30:00.000Z',
    pricePolicyId: 'setup-v1',
    reservationMicrousd: [10_000, 10_000],
    accounting: accounting(1),
  });
}

function dispatchable(job = reserved()) {
  return transitionJob(job, {
    type: 'dispatch-installed',
    at: TIMES.dispatchable,
    deadlineAt: '2026-09-18T12:30:00.000Z',
    capabilityHash: hash('a'),
  });
}

test('dispatch capability rotation preserves the exact live dispatch fence', () => {
  const job = dispatchable();
  const rotated = transitionJob(job, {
    type: 'dispatch-rotated',
    at: TIMES.collecting,
    deadlineAt: job.stateDeadlineAt,
    previousCapabilityHash: hash('a'),
    capabilityHash: hash('9'),
  });
  assert.equal(rotated.state, 'dispatchable');
  assert.equal(rotated.stateVersion, job.stateVersion + 1);
  assert.equal(rotated.stateDeadlineAt, job.stateDeadlineAt);
  assert.equal(rotated.dispatchCapabilityHash, hash('9'));
  assert.deepEqual(rotated.accounting, job.accounting);
  assert.deepEqual(rotated.attempts, job.attempts);

  for (const event of [
    {
      type: 'dispatch-rotated',
      at: TIMES.collecting,
      deadlineAt: job.stateDeadlineAt,
      previousCapabilityHash: hash('8'),
      capabilityHash: hash('9'),
    },
    {
      type: 'dispatch-rotated',
      at: TIMES.collecting,
      deadlineAt: job.stateDeadlineAt,
      previousCapabilityHash: hash('a'),
      capabilityHash: hash('a'),
    },
    {
      type: 'dispatch-rotated',
      at: '2026-09-18T12:30:00.000Z',
      deadlineAt: job.stateDeadlineAt,
      previousCapabilityHash: hash('a'),
      capabilityHash: hash('9'),
    },
    {
      type: 'dispatch-rotated',
      at: TIMES.collecting,
      deadlineAt: '2026-09-18T12:31:00.000Z',
      previousCapabilityHash: hash('a'),
      capabilityHash: hash('9'),
    },
  ]) {
    assert.throws(() => transitionJob(job, event), {
      code: 'service_unavailable',
    });
  }
  assert.throws(
    () =>
      transitionJob(reserved(), {
        type: 'dispatch-rotated',
        at: TIMES.collecting,
        deadlineAt: job.stateDeadlineAt,
        previousCapabilityHash: hash('a'),
        capabilityHash: hash('9'),
      }),
    { code: 'service_unavailable' },
  );
});

function collecting(job = dispatchable(), tokenHash = hash('b')) {
  return transitionJob(job, {
    type: 'free-lease-claimed',
    at: TIMES.collecting,
    phase: 'collecting',
    tokenHash,
    expiresAt: '2026-09-18T12:10:00.000Z',
  });
}

function counting(job = collecting(), tokenHash = hash('b')) {
  return transitionJob(job, {
    type: 'free-lease-claimed',
    at: TIMES.counting,
    phase: 'counting',
    tokenHash,
    expiresAt: '2026-09-18T12:11:00.000Z',
  });
}

function primaryInFlight(job = counting()) {
  return transitionJob(job, {
    type: 'primary-started',
    at: TIMES.primary,
    freeTokenHash: hash('b'),
    attemptTokenHash: hash('c'),
    deadlineAt: '2026-09-18T12:15:00.000Z',
    sourceFingerprint: hash('d'),
  });
}

function primaryComplete(job = primaryInFlight()) {
  return transitionJob(job, {
    type: 'response-completed',
    at: TIMES.response,
    number: 1,
    attemptTokenHash: hash('c'),
    deadlineAt: '2026-09-18T12:12:00.000Z',
    usage,
  });
}

function validatingPrimary(job = primaryComplete()) {
  return transitionJob(job, {
    type: 'finalization-claimed',
    at: TIMES.validating,
    number: 1,
    attemptTokenHash: hash('c'),
    finalizationTokenHash: hash('e'),
    expiresAt: '2026-09-18T12:20:00.000Z',
  });
}

test('primary path crosses each durable boundary before later work', () => {
  let job = validatingPrimary();
  assert.equal(job.state, 'validating-primary');
  assert.equal(job.attempts[0].state, 'response-complete');
  assert.deepEqual(
    {
      completedAt: job.attempts[0].completedAt,
      terminalClass: job.attempts[0].terminalClass,
      inputTokens: job.attempts[0].inputTokens,
      outputTokens: job.attempts[0].outputTokens,
      costMicrousd: job.attempts[0].costMicrousd,
    },
    {
      completedAt: TIMES.response,
      terminalClass: 'complete-response',
      inputTokens: 1000,
      outputTokens: 100,
      costMicrousd: 4000,
    },
  );
  assert.equal(
    ownsFinalization(job, {
      number: 1,
      tokenHash: hash('e'),
      at: TIMES.afterAttempt,
    }),
    true,
  );
  job = transitionJob(job, {
    type: 'candidate-staged',
    at: TIMES.afterAttempt,
    number: 1,
    attemptTokenHash: hash('c'),
    finalizationTokenHash: hash('e'),
    candidateDigest: hash('f'),
  });
  job = transitionJob(job, {
    type: 'version-confirmed',
    at: '2026-09-18T12:17:00.000Z',
    number: 1,
    attemptTokenHash: hash('c'),
    finalizationTokenHash: hash('e'),
    candidateDigest: hash('f'),
    deadlineAt: '2026-09-18T12:35:00.000Z',
  });
  assert.equal(
    ownsPaidAttempt(job, {
      number: 1,
      tokenHash: hash('c'),
      at: '2026-09-18T12:18:00.000Z',
    }),
    false,
  );
  job = transitionJob(job, {
    type: 'report-published',
    at: TIMES.published,
    deadlineAt: '2026-09-18T12:40:00.000Z',
    pointerRevision: 3,
    cleanupCandidateKey: null,
  });
  job = transitionJob(job, {
    type: 'accounting-recorded',
    at: TIMES.settled,
    deadlineAt: '2026-09-18T12:40:00.000Z',
    attemptTokenHash: null,
    finalizationTokenHash: null,
    attemptUpdates: [
      { number: 1, state: 'settled' },
      { number: 2, state: 'released' },
    ],
    accounting: accounting(2, 'complete'),
  });
  job = transitionJob(job, { type: 'succeeded', at: TIMES.succeeded });
  assert.equal(job.state, 'succeeded');
  assert.equal(job.stateDeadlineAt, null);
  assert.deepEqual(
    job.attempts.map(({ state }) => state),
    ['settled', 'released'],
  );
  assert.equal(job.terminal.errorCode, null);
});

test('expired published bookkeeping resumes with a fresh nonpaid deadline', () => {
  let job = transitionJob(validatingPrimary(), {
    type: 'candidate-staged',
    at: TIMES.afterAttempt,
    number: 1,
    attemptTokenHash: hash('c'),
    finalizationTokenHash: hash('e'),
    candidateDigest: hash('f'),
  });
  job = transitionJob(job, {
    type: 'version-confirmed',
    at: '2026-09-18T12:17:00.000Z',
    number: 1,
    attemptTokenHash: hash('c'),
    finalizationTokenHash: hash('e'),
    candidateDigest: hash('f'),
    deadlineAt: '2026-09-18T12:25:00.000Z',
  });
  job = transitionJob(job, {
    type: 'report-published',
    at: '2026-09-18T12:24:00.000Z',
    deadlineAt: '2026-09-18T12:30:00.000Z',
    pointerRevision: 3,
    cleanupCandidateKey: null,
  });
  job = transitionJob(job, {
    type: 'accounting-recorded',
    at: '2026-09-18T12:31:00.000Z',
    deadlineAt: '2026-09-18T12:40:00.000Z',
    attemptTokenHash: null,
    finalizationTokenHash: null,
    attemptUpdates: [
      { number: 1, state: 'settled' },
      { number: 2, state: 'released' },
    ],
    accounting: accounting(2, 'complete'),
  });
  assert.equal(job.state, 'published');
  assert.equal(job.stateDeadlineAt, '2026-09-18T12:40:00.000Z');
  assert.equal(job.accounting.status, 'complete');
});

test('terminal no-entry recovery records complete accounting without ledger facts', () => {
  let job = transitionJob(created(), {
    type: 'terminated',
    at: '2026-09-18T12:30:00.000Z',
    status: 'failed',
    errorCode: 'source_timeout',
    attemptTokenHash: null,
    finalizationTokenHash: null,
    freeTokenHash: null,
    recovery: true,
  });
  job = transitionJob(job, {
    type: 'accounting-recorded',
    at: '2026-09-18T12:31:00.000Z',
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
  });
  assert.equal(job.accounting.status, 'complete');
  assert.deepEqual(
    job.attempts.map(({ state }) => state),
    ['unreserved', 'unreserved'],
  );
  assert.deepEqual(
    classifyJobRecovery(job, { at: '2026-09-18T12:32:00.000Z' }),
    { action: 'verify-terminal-accounting' },
  );
});

test('only collecting and counting leases renew, with takeover only after expiry', () => {
  let job = collecting();
  job = transitionJob(job, {
    type: 'free-lease-claimed',
    at: '2026-09-18T12:04:00.000Z',
    phase: 'collecting',
    tokenHash: hash('b'),
    expiresAt: '2026-09-18T12:12:00.000Z',
  });
  assert.throws(
    () =>
      transitionJob(job, {
        type: 'free-lease-claimed',
        at: '2026-09-18T12:05:00.000Z',
        phase: 'collecting',
        tokenHash: hash('9'),
        expiresAt: '2026-09-18T12:13:00.000Z',
      }),
    { code: 'service_unavailable' },
  );
  job = transitionJob(job, {
    type: 'free-lease-claimed',
    at: '2026-09-18T12:12:00.000Z',
    phase: 'collecting',
    tokenHash: hash('9'),
    expiresAt: '2026-09-18T12:14:00.000Z',
  });
  assert.equal(job.freeLease.tokenHash, hash('9'));
  assert.throws(
    () =>
      transitionJob(primaryInFlight(), {
        type: 'free-lease-claimed',
        at: TIMES.response,
        phase: 'collecting',
        tokenHash: hash('b'),
        expiresAt: '2026-09-18T12:20:00.000Z',
      }),
    { code: 'service_unavailable' },
  );
});

test('lost paid-boundary acknowledgement continues only for the matching live token', () => {
  const job = primaryInFlight();
  assert.equal(
    ownsPaidAttempt(job, {
      number: 1,
      tokenHash: hash('c'),
      at: TIMES.response,
    }),
    true,
  );
  assert.equal(
    ownsPaidAttempt(job, {
      number: 1,
      tokenHash: hash('9'),
      at: TIMES.response,
    }),
    false,
  );
  assert.equal(
    ownsPaidAttempt(job, {
      number: 1,
      tokenHash: hash('c'),
      at: '2026-09-18T12:15:00.000Z',
    }),
    false,
  );
  assert.throws(
    () =>
      transitionJob(job, {
        type: 'response-completed',
        at: TIMES.response,
        number: 1,
        attemptTokenHash: hash('9'),
        deadlineAt: '2026-09-18T12:12:00.000Z',
        usage,
      }),
    { code: 'service_unavailable' },
  );
});

test('post-response termination requires both paid and finalization ownership', () => {
  const job = validatingPrimary();
  const event = {
    type: 'terminated',
    at: TIMES.rejected,
    status: 'failed',
    errorCode: 'analysis_output_invalid',
    attemptTokenHash: hash('c'),
    finalizationTokenHash: hash('e'),
    freeTokenHash: null,
    recovery: false,
  };
  assert.throws(
    () =>
      transitionJob(job, {
        ...event,
        attemptTokenHash: hash('9'),
      }),
    { code: 'service_unavailable' },
  );
  assert.equal(transitionJob(job, event).state, 'failed');
});

test('corrective attempt requires the original finalizer and settled primary usage', () => {
  let job = transitionJob(validatingPrimary(), {
    type: 'primary-rejected',
    at: TIMES.rejected,
    attemptTokenHash: hash('c'),
    finalizationTokenHash: hash('e'),
    classification: 'analysis_output_invalid',
  });
  const correctiveEvent = {
    type: 'corrective-started',
    at: TIMES.afterAttempt,
    primaryAttemptTokenHash: hash('c'),
    finalizationTokenHash: hash('e'),
    correctiveAttemptTokenHash: hash('6'),
    deadlineAt: '2026-09-18T12:25:00.000Z',
  };
  assert.throws(() => transitionJob(job, correctiveEvent), {
    code: 'service_unavailable',
  });
  const settlementEvent = {
    type: 'accounting-recorded',
    at: TIMES.accounted,
    deadlineAt: '2026-09-18T12:20:00.000Z',
    attemptTokenHash: hash('c'),
    finalizationTokenHash: hash('e'),
    attemptUpdates: [{ number: 1, state: 'settled' }],
    accounting: accounting(2),
  };
  assert.throws(
    () =>
      transitionJob(job, {
        ...settlementEvent,
        finalizationTokenHash: hash('9'),
      }),
    { code: 'service_unavailable' },
  );
  job = transitionJob(job, settlementEvent);
  assert.throws(
    () =>
      transitionJob(job, {
        ...correctiveEvent,
        finalizationTokenHash: hash('9'),
      }),
    { code: 'service_unavailable' },
  );
  job = transitionJob(job, correctiveEvent);
  assert.equal(job.state, 'corrective-in-flight');
  assert.deepEqual(
    job.attempts.map(({ state }) => state),
    ['settled', 'in-flight'],
  );
  assert.equal(job.finalizationLease, null);
  assert.throws(() => transitionJob(job, correctiveEvent), {
    code: 'service_unavailable',
  });
});

test('corrective completion uses a separate finalization token and can publish', () => {
  let job = transitionJob(
    transitionJob(
      transitionJob(validatingPrimary(), {
        type: 'primary-rejected',
        at: TIMES.rejected,
        attemptTokenHash: hash('c'),
        finalizationTokenHash: hash('e'),
        classification: 'analysis_output_invalid',
      }),
      {
        type: 'accounting-recorded',
        at: TIMES.accounted,
        deadlineAt: '2026-09-18T12:20:00.000Z',
        attemptTokenHash: hash('c'),
        finalizationTokenHash: hash('e'),
        attemptUpdates: [{ number: 1, state: 'settled' }],
        accounting: accounting(2),
      },
    ),
    {
      type: 'corrective-started',
      at: TIMES.afterAttempt,
      primaryAttemptTokenHash: hash('c'),
      finalizationTokenHash: hash('e'),
      correctiveAttemptTokenHash: hash('6'),
      deadlineAt: '2026-09-18T12:25:00.000Z',
    },
  );
  job = transitionJob(job, {
    type: 'response-completed',
    at: TIMES.correctiveResponse,
    number: 2,
    attemptTokenHash: hash('6'),
    deadlineAt: '2026-09-18T12:22:00.000Z',
    usage,
  });
  job = transitionJob(job, {
    type: 'finalization-claimed',
    at: TIMES.correctiveValidating,
    number: 2,
    attemptTokenHash: hash('6'),
    finalizationTokenHash: hash('7'),
    expiresAt: '2026-09-18T12:30:00.000Z',
  });
  job = transitionJob(job, {
    type: 'candidate-staged',
    at: TIMES.correctiveCandidate,
    number: 2,
    attemptTokenHash: hash('6'),
    finalizationTokenHash: hash('7'),
    candidateDigest: hash('8'),
  });
  assert.equal(job.state, 'validating-corrective');
  assert.equal(job.publication.candidateDigest, hash('8'));
});

test('recovery classification never replays paid work', () => {
  assert.deepEqual(
    classifyJobRecovery(dispatchable(), {
      at: '2026-09-18T12:31:00.000Z',
    }),
    { action: 'fence-pre-provider' },
  );
  assert.deepEqual(
    classifyJobRecovery(collecting(), {
      at: '2026-09-18T12:10:00.000Z',
    }),
    { action: 'reclaim-or-fence-free-work' },
  );
  assert.deepEqual(
    classifyJobRecovery(primaryInFlight(), {
      at: '2026-09-18T12:15:00.000Z',
    }),
    { action: 'fence-paid-ambiguous', attemptNumber: 1 },
  );
  assert.deepEqual(
    classifyJobRecovery(primaryComplete(), {
      at: '2026-09-18T12:12:00.000Z',
    }),
    { action: 'fence-failed-and-settle-known-usage', attemptNumber: 1 },
  );
  const invalid = transitionJob(validatingPrimary(), {
    type: 'primary-rejected',
    at: TIMES.rejected,
    attemptTokenHash: hash('c'),
    finalizationTokenHash: hash('e'),
    classification: 'analysis_output_invalid',
  });
  assert.deepEqual(
    classifyJobRecovery(invalid, {
      at: '2026-09-18T12:20:00.000Z',
    }),
    {
      action: 'fence-primary-invalid-and-release-corrective',
      attemptNumber: 1,
    },
  );
});

test('an expired staged version advances without provider or owner-token replay', () => {
  let job = transitionJob(validatingPrimary(), {
    type: 'candidate-staged',
    at: TIMES.afterAttempt,
    number: 1,
    attemptTokenHash: hash('c'),
    finalizationTokenHash: hash('e'),
    candidateDigest: hash('f'),
  });
  assert.deepEqual(
    classifyJobRecovery(job, {
      at: '2026-09-18T12:20:00.000Z',
      versionDigest: hash('f'),
    }),
    { action: 'advance-version-written', attemptNumber: 1 },
  );
  job = transitionJob(job, {
    type: 'recovered-version-confirmed',
    at: '2026-09-18T12:20:00.000Z',
    candidateDigest: hash('f'),
    deadlineAt: '2026-09-18T12:35:00.000Z',
  });
  assert.equal(job.state, 'version-written');
  assert.equal(job.finalizationLease, null);
});

test('expired in-flight work becomes terminal before unknown accounting', () => {
  let job = transitionJob(primaryInFlight(), {
    type: 'terminated',
    at: '2026-09-18T12:15:00.000Z',
    status: 'ambiguous',
    errorCode: 'analysis_ambiguous',
    attemptTokenHash: null,
    finalizationTokenHash: null,
    freeTokenHash: null,
    recovery: true,
  });
  assert.equal(job.state, 'ambiguous');
  assert.equal(job.accounting.status, 'pending');
  assert.equal(job.attempts[0].state, 'in-flight');
  job = transitionJob(job, {
    type: 'accounting-recorded',
    at: '2026-09-18T12:16:00.000Z',
    deadlineAt: null,
    attemptTokenHash: null,
    finalizationTokenHash: null,
    attemptUpdates: [
      { number: 1, state: 'unknown' },
      { number: 2, state: 'released' },
    ],
    accounting: accounting(2, 'unknown'),
  });
  assert.equal(job.accounting.status, 'unknown');
  assert.deepEqual(
    job.attempts.map(({ state }) => state),
    ['unknown', 'released'],
  );
});

test('strict machine rejects unknown events, raw fields and impossible states', () => {
  assert.throws(
    () => transitionJob(created(), { type: 'unknown', rawOutput: 'private' }),
    { code: 'service_unavailable' },
  );
  const impossible = structuredClone(primaryComplete());
  impossible.attempts[0].inputTokens = null;
  assert.throws(() => projectJobMachine(impossible), {
    code: 'service_unavailable',
  });
  assert.ok(!JSON.stringify(primaryComplete()).includes('rawOutput'));
});
