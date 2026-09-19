import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobStore } from '../lib/job-store.mjs';
import {
  ANALYSIS_JOB_STORAGE_LIMITS,
  hashDispatchCapability,
} from '../lib/jobs.mjs';

const times = Object.freeze({
  created: '2026-09-18T12:00:00.000Z',
  later: '2026-09-18T12:00:01.000Z',
  reserved: '2026-09-18T12:01:00.000Z',
  deadline: '2026-09-18T12:30:00.000Z',
});
const hash = (character) => character.repeat(64);
const capability = (byte) => Buffer.alloc(32, byte).toString('base64url');
const budget = Object.freeze({ assertActive() {} });
const request = Object.freeze({
  ownerId: 99961,
  repositoryId: 17,
  idempotencyKey: '018f0f11-1111-7111-8111-111111111111',
  operation: 'generate',
  expectedCurrentReportId: null,
  authorizationEpoch: 2,
  admissionDeployId: 'deploy-1',
  at: times.created,
  deadlineAt: times.deadline,
  budget,
});
const accounting = Object.freeze({
  status: 'pending',
  ledgerRevision: 1,
  accountingSequence: 1,
  accountingDigest: hash('a'),
  transitionId: hash('b'),
});

function memoryStorage() {
  const records = new Map();
  let serial = 0;
  return {
    records,
    readCount: 0,
    failAfterWrite: false,
    conflictWrite: null,
    async read(key) {
      this.readCount += 1;
      return records.has(key) ? structuredClone(records.get(key)) : null;
    },
    async write(key, value, condition) {
      const current = records.get(key);
      if (this.conflictWrite) {
        const replacement = this.conflictWrite;
        this.conflictWrite = null;
        records.set(key, {
          value: structuredClone(replacement),
          etag: `"etag-${++serial}"`,
        });
        return { modified: false };
      }
      if (
        (condition.onlyIfNew && current) ||
        (condition.onlyIfMatch !== undefined &&
          current?.etag !== condition.onlyIfMatch)
      )
        return { modified: false };
      const etag = `"etag-${++serial}"`;
      records.set(key, { value: structuredClone(value), etag });
      if (this.failAfterWrite) {
        this.failAfterWrite = false;
        throw new Error('synthetic lost acknowledgement');
      }
      return { modified: true, etag };
    },
  };
}

test('creates one deterministic job and accepts only the original idempotency tuple', async () => {
  const storage = memoryStorage();
  const jobs = createJobStore({ storage });
  const created = await jobs.createOrReadJob(request);
  assert.equal(created.status, 'created');
  assert.match(created.value.jobId, /^[a-f0-9]{64}$/u);
  assert.equal(storage.records.size, 1);

  const repeated = await jobs.createOrReadJob({
    ...request,
    at: times.later,
  });
  assert.equal(repeated.status, 'existing');
  assert.equal(repeated.value.createdAt, times.created);
  await assert.rejects(
    jobs.createOrReadJob({
      ...request,
      operation: 'refresh',
      expectedCurrentReportId: hash('c'),
    }),
    { code: 'idempotency_conflict' },
  );
});

test('recovers an exact lost create acknowledgement by strong read', async () => {
  const storage = memoryStorage();
  storage.failAfterWrite = true;
  const created = await createJobStore({ storage }).createOrReadJob(request);
  assert.equal(created.status, 'recovered');
  assert.equal(created.value.repositoryId, request.repositoryId);
});

test('applies a transition once and resolves a lost conditional acknowledgement', async () => {
  const storage = memoryStorage();
  const jobs = createJobStore({ storage });
  const created = await jobs.createOrReadJob(request);
  storage.failAfterWrite = true;
  const result = await jobs.applyTransition({
    jobId: created.value.jobId,
    budget,
    event: {
      type: 'reservation-committed',
      at: times.reserved,
      deadlineAt: times.deadline,
      pricePolicyId: 'setup-opus-5-global-standard-v1',
      reservationMicrousd: [5_409_600, 5_409_600],
      accounting,
    },
  });
  assert.equal(result.status, 'recovered');
  assert.equal(result.value.state, 'reserved');
  assert.equal(result.value.stateVersion, 1);
});

test('returns a conflict instead of replaying an event across another state', async () => {
  const storage = memoryStorage();
  const jobs = createJobStore({ storage });
  const created = await jobs.createOrReadJob(request);
  const reserved = await jobs.applyTransition({
    jobId: created.value.jobId,
    budget,
    event: {
      type: 'reservation-committed',
      at: times.reserved,
      deadlineAt: times.deadline,
      pricePolicyId: 'setup-opus-5-global-standard-v1',
      reservationMicrousd: [5_409_600, 5_409_600],
      accounting,
    },
  });
  const concurrent = structuredClone(reserved.value);
  concurrent.updatedAt = '2026-09-18T12:02:00.000Z';
  concurrent.stateDeadlineAt = times.deadline;
  concurrent.state = 'dispatchable';
  concurrent.stateVersion += 1;
  concurrent.dispatchCapabilityHash = hashDispatchCapability(capability(1));
  storage.conflictWrite = concurrent;
  const result = await jobs.applyTransition({
    jobId: created.value.jobId,
    budget,
    expectedEtag: reserved.etag,
    event: {
      type: 'dispatch-installed',
      at: '2026-09-18T12:02:00.000Z',
      deadlineAt: times.deadline,
      capabilityHash: hashDispatchCapability(capability(2)),
    },
  });
  assert.equal(result.status, 'conflict');
  assert.equal(
    result.value.dispatchCapabilityHash,
    concurrent.dispatchCapabilityHash,
  );
});

test('safe polling and dispatch authorization expose no capability or internal accounting', async () => {
  const storage = memoryStorage();
  const jobs = createJobStore({ storage });
  const created = await jobs.createOrReadJob(request);
  const reserved = await jobs.applyTransition({
    jobId: created.value.jobId,
    budget,
    event: {
      type: 'reservation-committed',
      at: times.reserved,
      deadlineAt: times.deadline,
      pricePolicyId: 'setup-opus-5-global-standard-v1',
      reservationMicrousd: [5_409_600, 5_409_600],
      accounting,
    },
  });
  const dispatchCapability = capability(3);
  const dispatched = await jobs.applyTransition({
    jobId: created.value.jobId,
    budget,
    expectedEtag: reserved.etag,
    event: {
      type: 'dispatch-installed',
      at: '2026-09-18T12:02:00.000Z',
      deadlineAt: times.deadline,
      capabilityHash: hashDispatchCapability(dispatchCapability),
    },
  });
  const safe = await jobs.safeJob({
    jobId: created.value.jobId,
    ownerId: 99961,
    budget,
  });
  assert.deepEqual(Object.keys(safe), [
    'id',
    'operation',
    'state',
    'createdAt',
    'errorCode',
    'reportId',
  ]);
  assert.equal(JSON.stringify(safe).includes(dispatchCapability), false);
  assert.equal(
    (
      await jobs.authorizeDispatch({
        jobId: created.value.jobId,
        capability: dispatchCapability,
        budget,
      })
    ).value.state,
    'dispatchable',
  );
  await assert.rejects(
    jobs.authorizeDispatch({
      jobId: created.value.jobId,
      capability: capability(4),
      budget,
    }),
    { code: 'forbidden' },
  );
  await jobs.applyTransition({
    jobId: created.value.jobId,
    budget,
    expectedEtag: dispatched.etag,
    event: {
      type: 'free-lease-claimed',
      at: '2026-09-18T12:03:00.000Z',
      phase: 'collecting',
      tokenHash: hash('c'),
      expiresAt: '2026-09-18T12:10:00.000Z',
    },
  });
  await assert.rejects(
    jobs.authorizeDispatch({
      jobId: created.value.jobId,
      capability: dispatchCapability,
      budget,
    }),
    { code: 'forbidden' },
  );
});

test('preflights maximum terminal width before paid state and rejects oversized stored jobs', async () => {
  const storage = memoryStorage();
  const jobs = createJobStore({ storage });
  const maximumInteger = Number.MAX_SAFE_INTEGER;
  const created = await jobs.createOrReadJob({
    ...request,
    repositoryId: maximumInteger,
    operation: 'refresh',
    expectedCurrentReportId: hash('f'),
    authorizationEpoch: maximumInteger,
    admissionDeployId: String.fromCharCode(0xd800).repeat(128),
  });
  let current = await jobs.applyTransition({
    jobId: created.value.jobId,
    budget,
    expectedEtag: created.etag,
    event: {
      type: 'reservation-committed',
      at: times.reserved,
      deadlineAt: times.deadline,
      pricePolicyId: `p${'x'.repeat(127)}`,
      reservationMicrousd: [maximumInteger, maximumInteger],
      accounting: {
        status: 'pending',
        ledgerRevision: maximumInteger,
        accountingSequence: maximumInteger,
        accountingDigest: hash('a'),
        transitionId: hash('b'),
      },
    },
  });
  current = await jobs.applyTransition({
    jobId: created.value.jobId,
    budget,
    expectedEtag: current.etag,
    event: {
      type: 'dispatch-installed',
      at: '2026-09-18T12:02:00.000Z',
      deadlineAt: times.deadline,
      capabilityHash: hash('c'),
    },
  });
  current = await jobs.applyTransition({
    jobId: created.value.jobId,
    budget,
    expectedEtag: current.etag,
    event: {
      type: 'free-lease-claimed',
      at: '2026-09-18T12:03:00.000Z',
      phase: 'collecting',
      tokenHash: hash('d'),
      expiresAt: '2026-09-18T12:10:00.000Z',
    },
  });
  current = await jobs.applyTransition({
    jobId: created.value.jobId,
    budget,
    expectedEtag: current.etag,
    event: {
      type: 'free-lease-claimed',
      at: '2026-09-18T12:04:00.000Z',
      phase: 'counting',
      tokenHash: hash('d'),
      expiresAt: '2026-09-18T12:11:00.000Z',
    },
  });
  const readsBeforeRejectedPaidTransitions = storage.readCount;
  for (const type of ['primary-started', 'corrective-started'])
    await assert.rejects(
      jobs.applyTransition({
        jobId: created.value.jobId,
        budget,
        expectedEtag: current.etag,
        event: { type },
      }),
      { code: 'service_unavailable' },
    );
  assert.equal(storage.readCount, readsBeforeRejectedPaidTransitions);
  const readsBeforePaidBoundary = storage.readCount;
  current = await jobs.applyPaidBoundaryTransition({
    jobId: created.value.jobId,
    budget,
    current,
    event: {
      type: 'primary-started',
      at: '2026-09-18T12:05:00.000Z',
      freeTokenHash: hash('d'),
      attemptTokenHash: hash('e'),
      deadlineAt: '2026-09-18T12:15:00.000Z',
      sourceFingerprint: hash('1'),
    },
  });
  assert.equal(storage.readCount, readsBeforePaidBoundary);
  assert.equal(current.value.state, 'primary-in-flight');
  assert.ok(
    Buffer.byteLength(JSON.stringify(current.value), 'utf8') <
      ANALYSIS_JOB_STORAGE_LIMITS.recordBytes,
  );

  const key = `jobs/${created.value.jobId}`;
  storage.records.set(key, {
    value: {
      ...current.value,
      providerBody: 'x'.repeat(ANALYSIS_JOB_STORAGE_LIMITS.recordBytes),
    },
    etag: '"oversized"',
  });
  await assert.rejects(jobs.readJob({ jobId: created.value.jobId, budget }), {
    code: 'service_unavailable',
  });
});
