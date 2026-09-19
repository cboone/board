import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAnalysisJob,
  deriveAnalysisJobIdentity,
  hashDispatchCapability,
  matchesDispatchCapability,
  projectAnalysisJob,
  projectSafeJob,
} from '../lib/jobs.mjs';

const input = {
  ownerId: 99961,
  repositoryId: 17,
  idempotencyKey: '018f0f11-1111-7111-8111-111111111111',
  operation: 'generate',
  expectedCurrentReportId: null,
  authorizationEpoch: 2,
  admissionDeployId: 'deploy-1',
  at: '2026-09-18T12:00:00.000Z',
  deadlineAt: '2026-09-18T12:02:00.000Z',
};

test('global idempotency identity is stable and repository-independent while report keys remain repository-bound', () => {
  const first = deriveAnalysisJobIdentity(input);
  const second = deriveAnalysisJobIdentity({ ...input, repositoryId: 18 });
  assert.equal(first.jobId, second.jobId);
  assert.equal(first.reportId, second.reportId);
  assert.notEqual(first.versionKey, second.versionKey);
  assert.match(first.jobId, /^[a-f0-9]{64}$/u);
  assert.equal(
    deriveAnalysisJobIdentity({
      ...input,
      idempotencyKey: input.idempotencyKey.toUpperCase(),
    }).jobId,
    first.jobId,
  );
});

test('inert jobs preallocate deterministic publication and accounting shapes without raw source', () => {
  const job = createAnalysisJob(input);
  assert.equal(job.state, 'created');
  assert.equal(job.accounting.status, 'unreserved');
  assert.deepEqual(Object.values(job.accounting).slice(1), [
    null,
    null,
    null,
    null,
  ]);
  assert.deepEqual(
    job.attempts.map(({ number, state, reservationMicrousd }) => ({
      number,
      state,
      reservationMicrousd,
    })),
    [
      { number: 1, state: 'unreserved', reservationMicrousd: 0 },
      { number: 2, state: 'unreserved', reservationMicrousd: 0 },
    ],
  );
  assert.equal(job.publication.basisReportId, null);
  assert.equal(JSON.stringify(job).includes('body'), false);
  assert.deepEqual(projectSafeJob(job), {
    id: job.jobId,
    operation: 'generate',
    state: 'created',
    createdAt: input.at,
    updatedAt: input.at,
    terminal: null,
  });
});

test('refresh requires an exact basis report while generate forbids one', () => {
  assert.throws(
    () =>
      createAnalysisJob({
        ...input,
        operation: 'refresh',
        expectedCurrentReportId: null,
      }),
    { code: 'service_unavailable' },
  );
  assert.throws(
    () =>
      createAnalysisJob({
        ...input,
        expectedCurrentReportId: 'a'.repeat(64),
      }),
    { code: 'service_unavailable' },
  );
  const job = createAnalysisJob({
    ...input,
    operation: 'refresh',
    expectedCurrentReportId: 'a'.repeat(64),
  });
  assert.equal(job.publication.basisReportId, 'a'.repeat(64));
});

test('strict job projection rejects unknown fields, raw text and inconsistent terminal or accounting shapes', () => {
  const job = createAnalysisJob(input);
  const candidates = [
    { ...job, rawPrompt: 'private source' },
    {
      ...job,
      terminal: { status: 'failed', completedAt: input.at, errorCode: null },
    },
    {
      ...job,
      accounting: {
        ...job.accounting,
        status: 'complete',
      },
    },
    {
      ...job,
      attempts: [
        { ...job.attempts[0], rawOutput: 'private output' },
        job.attempts[1],
      ],
    },
  ];
  for (const [index, candidate] of candidates.entries())
    assert.throws(
      () => projectAnalysisJob(candidate),
      { code: 'service_unavailable' },
      `candidate ${index}`,
    );
});

test('dispatch capability hashing is exact and never exposes the raw capability', () => {
  const capability = Buffer.alloc(32, 7).toString('base64url');
  const hash = hashDispatchCapability(capability);
  assert.match(hash, /^[a-f0-9]{64}$/u);
  assert.equal(matchesDispatchCapability(hash, capability), true);
  assert.equal(
    matchesDispatchCapability(hash, Buffer.alloc(32, 8).toString('base64url')),
    false,
  );
  assert.equal(matchesDispatchCapability(hash, 'not-a-capability'), false);
});

test('projector rejects impossible attempt, state, lease, terminal and publication combinations', () => {
  const initial = createAnalysisJob(input);
  const accounting = {
    status: 'pending',
    ledgerRevision: 1,
    accountingSequence: 1,
    accountingDigest: '1'.repeat(64),
    transitionId: '2'.repeat(64),
  };
  const paidBase = {
    ...initial,
    updatedAt: '2026-09-18T12:01:00.000Z',
    state: 'primary-response-complete',
    stateVersion: 6,
    stateDeadlineAt: '2026-09-18T12:10:00.000Z',
    dispatchCapabilityHash: '3'.repeat(64),
    pricePolicyId: 'setup-v1',
    sourceFingerprint: '4'.repeat(64),
    accounting,
  };
  const incompleteAttempt = {
    ...initial.attempts[0],
    reservationMicrousd: 10_000,
    state: 'response-complete',
  };
  const completeAttempt = {
    ...incompleteAttempt,
    tokenHash: '5'.repeat(64),
    startedAt: '2026-09-18T12:02:00.000Z',
    deadlineAt: '2026-09-18T12:09:00.000Z',
    completedAt: '2026-09-18T12:03:00.000Z',
    terminalClass: 'complete-response',
    terminalStopReason: 'end_turn',
    inputTokens: 100,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 10,
    costMicrousd: 1000,
  };
  const reservedCorrection = {
    ...initial.attempts[1],
    reservationMicrousd: 10_000,
    state: 'reserved',
  };
  for (const candidate of [
    paidBase,
    {
      ...paidBase,
      attempts: [incompleteAttempt, reservedCorrection],
    },
    {
      ...initial,
      freeLease: {
        tokenHash: '6'.repeat(64),
        expiresAt: initial.stateDeadlineAt,
      },
    },
    {
      ...initial,
      publication: { ...initial.publication, pointerRevision: 1 },
    },
    {
      ...paidBase,
      state: 'succeeded',
      stateDeadlineAt: null,
      attempts: [
        { ...completeAttempt, state: 'settled' },
        { ...reservedCorrection, state: 'released' },
      ],
      publication: {
        ...initial.publication,
        candidateDigest: '7'.repeat(64),
        pointerRevision: 1,
        publishedAt: '2026-09-18T12:05:00.000Z',
      },
      accounting: { ...accounting, status: 'complete' },
      terminal: {
        status: 'succeeded',
        completedAt: '2026-09-18T12:06:00.000Z',
        errorCode: 'analysis_output_invalid',
      },
    },
  ])
    assert.throws(() => projectAnalysisJob(candidate), {
      code: 'service_unavailable',
    });
});
