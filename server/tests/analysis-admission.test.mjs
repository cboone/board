import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalysisAdmission } from '../lib/analysis-admission.mjs';
import { transitionJob } from '../lib/job-machine.mjs';
import { deriveAnalysisJobIdentity } from '../lib/jobs.mjs';
import { repositoryStateKey } from '../lib/report-store.mjs';
import {
  SETUP_SPEND_LEDGER_KEY,
  applyCurrentSetupDiscussionDecision,
  markSetupAttemptUnknown,
} from '../lib/spend-store.mjs';

const NOW = '2026-09-19T04:30:00.000Z';
const DEADLINE = '2026-09-19T05:30:00.000Z';
const OWNER_ID = 99961;
const budget = Object.freeze({ name: 'admission-test-budget' });
const repository = (id) => ({
  id,
  fullName: `cboone/repo-${id}`,
  name: `repo-${id}`,
  private: id % 2 === 0,
  url: `https://github.com/cboone/repo-${id}`,
  defaultBranch: 'main',
  defaultTip: String(id % 10).repeat(40),
});
const request = (overrides = {}) => ({
  ownerId: OWNER_ID,
  repository: repository(17),
  idempotencyKey: '018f0f11-1111-7111-8111-111111111111',
  operation: 'generate',
  expectedCurrentReportId: null,
  authorizationEpoch: 2,
  deadlineAt: DEADLINE,
  budget,
  ...overrides,
});

function memoryStorage(name, log) {
  const records = new Map();
  const lostWrites = new Set();
  let sequence = 0;
  let writes = 0;
  return {
    async read(key, options) {
      assert.deepEqual(options, { budget });
      log.push({ store: name, action: 'read', key });
      const current = records.get(key);
      return current === undefined
        ? null
        : { value: structuredClone(current.value), etag: current.etag };
    },
    async write(key, value, condition, options) {
      assert.deepEqual(options, { budget });
      writes += 1;
      log.push({ store: name, action: 'write', key, condition });
      const current = records.get(key);
      if (
        (condition.onlyIfNew === true && current !== undefined) ||
        (condition.onlyIfMatch !== undefined &&
          current?.etag !== condition.onlyIfMatch)
      )
        return { modified: false };
      sequence += 1;
      const etag = `"${name}-${sequence}"`;
      records.set(key, { value: structuredClone(value), etag });
      if (lostWrites.delete(writes))
        throw new Error('synthetic lost acknowledgement');
      return { modified: true, etag };
    },
    loseWrite(number) {
      lostWrites.add(number);
    },
    value(key) {
      return records.has(key) ? structuredClone(records.get(key).value) : null;
    },
    put(key, value) {
      sequence += 1;
      records.set(key, {
        value: structuredClone(value),
        etag: `"${name}-${sequence}"`,
      });
    },
    keys() {
      return [...records.keys()];
    },
  };
}

function fixture({ now = NOW, fetchImpl } = {}) {
  const log = [];
  const reportStorage = memoryStorage('reports', log);
  const jobStorage = memoryStorage('jobs', log);
  const spendStorage = memoryStorage('spend', log);
  const dispatches = [];
  let randomCalls = 0;
  const resolvedFetch =
    fetchImpl ??
    (async (url, init) => {
      dispatches.push({ url: String(url), init: structuredClone(init) });
      return new Response(null, { status: 202 });
    });
  const admission = createAnalysisAdmission({
    reportStorage,
    jobStorage,
    spendStorage,
    deployId: 'deploy-1',
    origin: 'https://tracker-boards.example',
    fetchImpl: resolvedFetch,
    randomBytes: (size) => {
      randomCalls += 1;
      return Buffer.alloc(size, randomCalls);
    },
    now: () => now,
  });
  return {
    admission,
    reportStorage,
    jobStorage,
    spendStorage,
    dispatches,
    log,
    randomCalls: () => randomCalls,
  };
}

function identity(input) {
  return deriveAnalysisJobIdentity({
    ownerId: input.ownerId,
    repositoryId: input.repository.id,
    idempotencyKey: input.idempotencyKey,
  });
}

test('admission orders durable stores, dispatches only a capability, and returns a safe job', async () => {
  const board = fixture();
  const input = request();
  const result = await board.admission.admit(input);
  assert.deepEqual(Object.keys(result), [
    'id',
    'operation',
    'state',
    'createdAt',
    'errorCode',
    'reportId',
  ]);
  assert.equal(result.state, 'queued');
  assert.equal(board.dispatches.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(board.dispatches[0].init.body)), [
    'jobId',
    'capability',
  ]);
  assert.equal(
    board.dispatches[0].init.headers.Origin,
    'https://tracker-boards.example',
  );

  const writes = board.log
    .filter(({ action }) => action === 'write')
    .map(({ store, key }) => `${store}:${key}`);
  assert.deepEqual(writes, [
    'reports:owners/99961/catalog',
    `reports:${repositoryStateKey(17)}`,
    `spend:${SETUP_SPEND_LEDGER_KEY}`,
    `jobs:jobs/${result.id}`,
    `reports:${repositoryStateKey(17)}`,
    `spend:${SETUP_SPEND_LEDGER_KEY}`,
    `jobs:jobs/${result.id}`,
    `jobs:jobs/${result.id}`,
  ]);
  const dispatchedCapability = JSON.parse(
    board.dispatches[0].init.body,
  ).capability;
  const stored = board.jobStorage.value(`jobs/${result.id}`);
  assert.equal(stored.state, 'dispatchable');
  assert.equal(JSON.stringify(stored).includes(dispatchedCapability), false);
  assert.equal(
    Object.keys(board.spendStorage.value(SETUP_SPEND_LEDGER_KEY).active).length,
    1,
  );
});

test('identical concurrent and repeated admission never duplicate spend or dispatch', async () => {
  const board = fixture();
  const input = request();
  const [first, second] = await Promise.all([
    board.admission.admit(input),
    board.admission.admit(input),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(board.dispatches.length, 1);
  assert.equal(
    board.spendStorage.value(SETUP_SPEND_LEDGER_KEY).accountingSequence,
    1,
  );
  const randomCalls = board.randomCalls();
  const repeated = await board.admission.admit(input);
  assert.equal(repeated.id, first.id);
  assert.equal(board.dispatches.length, 1);
  assert.equal(board.randomCalls(), randomCalls);
  assert.equal(
    board.spendStorage.value(SETUP_SPEND_LEDGER_KEY).accountingSequence,
    1,
  );
  const reauthorized = await board.admission.admit(
    request({ authorizationEpoch: 3 }),
  );
  assert.equal(reauthorized.id, first.id);
  assert.equal(board.dispatches.length, 1);
  assert.equal(board.randomCalls(), randomCalls);
});

test('a competing idempotency key fences its inert loser and preserves the winner', async () => {
  const board = fixture();
  const winner = request();
  const admitted = await board.admission.admit(winner);
  const loser = request({
    idempotencyKey: '018f0f11-2222-7222-8222-222222222222',
  });
  await assert.rejects(board.admission.admit(loser), {
    code: 'analysis_in_progress',
  });
  const loserId = identity(loser).jobId;
  const loserJob = board.jobStorage.value(`jobs/${loserId}`);
  assert.equal(loserJob.state, 'superseded');
  assert.equal(loserJob.accounting.status, 'complete');
  assert.equal(loserJob.accounting.ledgerRevision, null);
  const state = board.reportStorage.value(repositoryStateKey(17));
  assert.equal(state.activeJob.jobId, admitted.id);
  assert.equal(state.lastAnalysisAttempt, null);
  assert.deepEqual(
    Object.keys(board.spendStorage.value(SETUP_SPEND_LEDGER_KEY).active),
    [admitted.id],
  );
});

test('a discussion-gated reservation is fenced, cleared, and mapped safely', async () => {
  const board = fixture();
  await board.admission.admit(request());
  const blocked = request({
    repository: repository(18),
    idempotencyKey: '018f0f11-3333-7333-8333-333333333333',
  });
  await assert.rejects(board.admission.admit(blocked), {
    code: 'budget_discussion_required',
  });
  const jobId = identity(blocked).jobId;
  const job = board.jobStorage.value(`jobs/${jobId}`);
  assert.equal(job.state, 'budget-blocked');
  assert.equal(job.terminal.errorCode, 'budget_discussion_required');
  assert.equal(job.accounting.status, 'complete');
  assert.equal(job.accounting.ledgerRevision, null);
  const state = board.reportStorage.value(repositoryStateKey(18));
  assert.equal(state.activeJob, null);
  assert.equal(
    state.lastAnalysisAttempt.errorCode,
    'budget_discussion_required',
  );
  assert.equal(board.dispatches.length, 1);
  assert.deepEqual(
    Object.keys(board.spendStorage.value(SETUP_SPEND_LEDGER_KEY).active),
    [identity(request()).jobId],
  );
});

test('a stopped setup policy maps to analysis unavailable and clears the claim', async () => {
  const board = fixture();
  await board.admission.admit(request());
  const gated = request({
    repository: repository(18),
    idempotencyKey: '018f0f11-4444-7444-8444-444444444444',
  });
  await assert.rejects(board.admission.admit(gated), {
    code: 'budget_discussion_required',
  });
  const ledger = board.spendStorage.value(SETUP_SPEND_LEDGER_KEY);
  const discussion = ledger.discussions[ledger.activePolicyId];
  await applyCurrentSetupDiscussionDecision({
    storage: board.spendStorage,
    budget,
    deployId: 'deploy-1',
    policyId: ledger.activePolicyId,
    discussionRevision: discussion.currentRevision,
    decisionId: 'f'.repeat(64),
    decision: 'stop',
    authorizedThroughMicrousd: 0,
    authorizedOperations: [],
    at: NOW,
  });
  const stopped = request({
    repository: repository(19),
    idempotencyKey: '018f0f11-5555-7555-8555-555555555555',
  });
  await assert.rejects(board.admission.admit(stopped), {
    code: 'analysis_unavailable',
  });
  const state = board.reportStorage.value(repositoryStateKey(19));
  assert.equal(state.activeJob, null);
  assert.equal(state.lastAnalysisAttempt.status, 'budget-blocked');
  assert.equal(state.lastAnalysisAttempt.errorCode, 'analysis_unavailable');
  assert.equal(board.dispatches.length, 1);
});

test('lost acknowledgements recover each admission boundary without duplicate effects', async () => {
  const board = fixture();
  for (const number of [1, 2, 3]) board.jobStorage.loseWrite(number);
  board.reportStorage.loseWrite(3);
  for (const number of [1, 2]) board.spendStorage.loseWrite(number);
  const result = await board.admission.admit(request());
  assert.equal(result.state, 'queued');
  assert.equal(board.dispatches.length, 1);
  assert.equal(board.randomCalls(), 1);
  assert.equal(
    board.spendStorage.value(SETUP_SPEND_LEDGER_KEY).accountingSequence,
    1,
  );
  assert.equal(
    board.jobStorage.value(`jobs/${result.id}`).state,
    'dispatchable',
  );
});

test('dispatch uncertainty retries the same capability once and leaves one durable job', async () => {
  const calls = [];
  const board = fixture({
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      throw new Error('synthetic uncertain dispatch');
    },
  });
  const input = request();
  const admitted = await board.admission.admit(input);
  assert.equal(admitted.state, 'queued');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(board.randomCalls(), 1);
  assert.equal(
    board.jobStorage.value(`jobs/${admitted.id}`).state,
    'dispatchable',
  );
  await board.admission.admit(input);
  assert.equal(calls.length, 2);
  assert.equal(board.randomCalls(), 1);
  assert.equal(
    board.spendStorage.value(SETUP_SPEND_LEDGER_KEY).accountingSequence,
    1,
  );
});

test('expired reviewed pricing terminally clears admission without dispatch', async () => {
  const board = fixture({ now: '2026-09-27T04:30:00.000Z' });
  const input = request({ deadlineAt: '2026-09-27T05:30:00.000Z' });
  await assert.rejects(board.admission.admit(input), {
    code: 'pricing_review_required',
  });
  const jobId = identity(input).jobId;
  const job = board.jobStorage.value(`jobs/${jobId}`);
  assert.equal(job.state, 'budget-blocked');
  assert.equal(job.accounting.status, 'complete');
  assert.equal(
    board.reportStorage.value(repositoryStateKey(17)).activeJob,
    null,
  );
  assert.equal(board.dispatches.length, 0);
});

test('admission rejects a pinned identity whose name does not match fullName', async () => {
  const board = fixture();
  await assert.rejects(
    board.admission.admit(
      request({
        repository: { ...repository(17), name: 'another-name' },
      }),
    ),
    { code: 'service_unavailable' },
  );
  assert.deepEqual(board.reportStorage.keys(), []);
  assert.deepEqual(board.jobStorage.keys(), []);
  assert.deepEqual(board.spendStorage.keys(), []);
});

test('repeated admission clears an ambiguous claim without releasing unknown exposure', async () => {
  const board = fixture();
  const input = request();
  const admitted = await board.admission.admit(input);
  const key = `jobs/${admitted.id}`;
  let job = board.jobStorage.value(key);
  job = transitionJob(job, {
    type: 'free-lease-claimed',
    at: '2026-09-19T04:31:00.000Z',
    phase: 'collecting',
    tokenHash: '1'.repeat(64),
    expiresAt: '2026-09-19T04:40:00.000Z',
  });
  job = transitionJob(job, {
    type: 'free-lease-claimed',
    at: '2026-09-19T04:32:00.000Z',
    phase: 'counting',
    tokenHash: '1'.repeat(64),
    expiresAt: '2026-09-19T04:40:00.000Z',
  });
  job = transitionJob(job, {
    type: 'primary-started',
    at: '2026-09-19T04:33:00.000Z',
    freeTokenHash: '1'.repeat(64),
    attemptTokenHash: '2'.repeat(64),
    deadlineAt: '2026-09-19T04:40:00.000Z',
    sourceFingerprint: '3'.repeat(64),
  });
  job = transitionJob(job, {
    type: 'terminated',
    at: '2026-09-19T04:41:00.000Z',
    status: 'ambiguous',
    errorCode: 'analysis_ambiguous',
    attemptTokenHash: null,
    finalizationTokenHash: null,
    freeTokenHash: null,
    recovery: true,
  });
  const unknown = await markSetupAttemptUnknown({
    storage: board.spendStorage,
    budget,
    deployId: 'deploy-1',
    jobId: admitted.id,
    attemptNumber: 1,
    actualCostMicrousd: 0,
    unknownExposureMicrousd: job.attempts[0].reservationMicrousd,
    at: '2026-09-19T04:41:00.000Z',
    revalidate: async () => true,
  });
  job = transitionJob(job, {
    type: 'accounting-recorded',
    at: '2026-09-19T04:41:00.000Z',
    deadlineAt: null,
    attemptTokenHash: null,
    finalizationTokenHash: null,
    attemptUpdates: [{ number: 1, state: 'unknown' }],
    accounting: unknown.accounting,
  });
  board.jobStorage.put(key, job);

  const repeated = await board.admission.admit(input);
  assert.equal(repeated.state, 'ambiguous');
  assert.equal(
    board.reportStorage.value(repositoryStateKey(17)).activeJob,
    null,
  );
  const ledger = board.spendStorage.value(SETUP_SPEND_LEDGER_KEY);
  assert.equal(ledger.active[admitted.id].attempts[0].state, 'unknown');
  assert.equal(ledger.active[admitted.id].attempts[1].state, 'reserved');
});
