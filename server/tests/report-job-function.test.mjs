import assert from 'node:assert/strict';
import test from 'node:test';
import {
  config as routeConfig,
  createHandler,
} from '../functions/report-job.mjs';
import { BoardError } from '../lib/errors.mjs';
import { hashDispatchCapability } from '../lib/jobs.mjs';

const ORIGIN = 'https://tracker-boards.example';
const JOB_ID = 'a'.repeat(64);
const CAPABILITY = Buffer.alloc(32, 7).toString('base64url');
const KEY = Buffer.alloc(32, 8).toString('base64');

const invocation = (url = `${ORIGIN}/.netlify/functions/report-job`) =>
  new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
    },
    body: JSON.stringify({ jobId: JOB_ID, capability: CAPABILITY }),
  });

const published = {
  deploy: { context: 'production', published: true, id: 'deploy-1' },
};

const authorizedJobStore =
  (capability = CAPABILITY) =>
  () => ({
    async authorizeDispatch({ jobId, capability: presentedCapability }) {
      assert.equal(jobId, JOB_ID);
      if (
        hashDispatchCapability(presentedCapability) !==
        hashDispatchCapability(capability)
      )
        throw new BoardError('forbidden');
      return {
        value: {
          state: 'dispatchable',
          admissionDeployId: 'deploy-1',
          dispatchCapabilityHash: hashDispatchCapability(capability),
        },
        etag: 'synthetic-job-etag',
      };
    },
  });

test('background entry rejects unpublished and malformed invocations before secrets or stores', async () => {
  let secretReads = 0;
  let storeOpens = 0;
  let workerCreations = 0;
  const env = {
    BOARD_APP_ORIGIN: ORIGIN,
    get GITHUB_APP_CLIENT_SECRET() {
      secretReads += 1;
      throw new Error('Must not read an authentication secret.');
    },
    get ANTHROPIC_API_KEY() {
      secretReads += 1;
      throw new Error('Must not read an analysis secret.');
    },
  };
  const handler = createHandler({
    env,
    storageFactory: async () => {
      storeOpens += 1;
      throw new Error('Must not open storage.');
    },
    workerFactory: () => {
      workerCreations += 1;
      throw new Error('Must not create a worker.');
    },
  });

  assert.deepEqual(routeConfig, { background: true });
  for (const context of [
    undefined,
    { deploy: { context: 'deploy-preview' } },
    { deploy: { context: 'branch-deploy' } },
    { deploy: { context: 'production', published: false, id: 'deploy-1' } },
  ]) {
    assert.equal(await handler(invocation(), context), undefined);
  }
  for (const request of [
    invocation('https://other.example/.netlify/functions/report-job'),
    new Request(`${ORIGIN}/.netlify/functions/report-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ jobId: 'bad', capability: CAPABILITY }),
    }),
  ]) {
    assert.equal(await handler(request, published), undefined);
  }
  assert.equal(secretReads, 0);
  assert.equal(storeOpens, 0);
  assert.equal(workerCreations, 0);
});

test('a valid-shaped wrong capability opens only the job store and reads no secret', async () => {
  let secretReads = 0;
  const storeNames = [];
  const env = {
    BOARD_APP_ORIGIN: ORIGIN,
    get GITHUB_APP_CLIENT_SECRET() {
      secretReads += 1;
      throw new Error('Must not read an authentication secret.');
    },
    get ANTHROPIC_API_KEY() {
      secretReads += 1;
      throw new Error('Must not read an analysis secret.');
    },
  };
  const handler = createHandler({
    env,
    storageFactory: async ({ storeName }) => {
      storeNames.push(storeName);
      return { storeName };
    },
    jobStoreFactory: authorizedJobStore(
      Buffer.alloc(32, 9).toString('base64url'),
    ),
    workerFactory: () => {
      assert.fail('A wrong capability must not create a worker.');
    },
  });

  assert.equal(await handler(invocation(), published), undefined);
  assert.equal(secretReads, 0);
  assert.deepEqual(storeNames, ['board-jobs']);
});

test('a replayed valid capability opens only the job store after dispatch ends', async () => {
  let secretReads = 0;
  const storeNames = [];
  let authorizationCalls = 0;
  const env = {
    BOARD_APP_ORIGIN: ORIGIN,
    get GITHUB_APP_CLIENT_SECRET() {
      secretReads += 1;
      throw new Error('Must not read an authentication secret.');
    },
    get ANTHROPIC_API_KEY() {
      secretReads += 1;
      throw new Error('Must not read an analysis secret.');
    },
  };
  const handler = createHandler({
    env,
    storageFactory: async ({ storeName }) => {
      storeNames.push(storeName);
      return { storeName };
    },
    jobStoreFactory: () => ({
      async authorizeDispatch({ jobId, capability }) {
        authorizationCalls += 1;
        assert.equal(jobId, JOB_ID);
        assert.equal(capability, CAPABILITY);
        throw new BoardError('forbidden');
      },
    }),
    workerFactory: () => {
      assert.fail('A replayed capability must not create a worker.');
    },
  });

  assert.equal(await handler(invocation(), published), undefined);
  assert.equal(authorizationCalls, 1);
  assert.equal(secretReads, 0);
  assert.deepEqual(storeNames, ['board-jobs']);
});

test('background entry composes isolated stores and passes only the parsed capability to the worker', async () => {
  const storeNames = [];
  const stores = new Map();
  let anthropicKey;
  let workerInput;
  let runInput;
  let markRunStarted;
  let releaseRun;
  const runStarted = new Promise((resolve) => {
    markRunStarted = resolve;
  });
  const runBlocked = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const env = {
    BOARD_APP_ORIGIN: ORIGIN,
    BOARD_OWNER_ID: '99961',
    GITHUB_APP_ID: '4995264',
    GITHUB_APP_CLIENT_ID: 'synthetic-client',
    GITHUB_APP_CLIENT_SECRET: 'synthetic-client-secret',
    BOARD_TOKEN_KEY_ID: 'current',
    BOARD_TOKEN_ENCRYPTION_KEY: KEY,
    ANTHROPIC_API_KEY: 'synthetic-anthropic-key',
  };
  const handler = createHandler({
    env,
    now: () => Date.parse('2026-09-19T12:00:00.000Z'),
    storageFactory: async ({ storeName }) => {
      storeNames.push(storeName);
      const value = { storeName };
      stores.set(storeName, value);
      return value;
    },
    authFactory: (input) => ({ kind: 'auth', input }),
    sourceFactory: (input) => ({ kind: 'source', input }),
    anthropicFactory: ({ apiKey }) => {
      anthropicKey = apiKey;
      return { kind: 'anthropic' };
    },
    jobStoreFactory: authorizedJobStore(),
    workerFactory: (input) => {
      workerInput = input;
      return {
        async run(input_) {
          runInput = input_;
          markRunStarted();
          await runBlocked;
        },
      };
    },
  });

  const request = invocation();
  let completed = false;
  const completion = handler(request, published);
  void completion.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  await runStarted;
  await Promise.resolve();
  assert.equal(completed, false);
  releaseRun();
  assert.equal(await completion, undefined);
  assert.deepEqual(storeNames.sort(), [
    'board-auth',
    'board-jobs',
    'board-reports',
    'board-spend',
  ]);
  assert.equal(anthropicKey, env.ANTHROPIC_API_KEY);
  assert.equal(workerInput.deployId, 'deploy-1');
  assert.equal(workerInput.reportStorage, stores.get('board-reports'));
  assert.equal(workerInput.jobStorage, stores.get('board-jobs'));
  assert.equal(workerInput.spendStorage, stores.get('board-spend'));
  assert.equal(workerInput.auth.kind, 'auth');
  assert.equal(workerInput.sourceOperations.kind, 'source');
  assert.equal(workerInput.anthropicClient.kind, 'anthropic');
  assert.equal(runInput.jobId, JOB_ID);
  assert.equal(runInput.capability, CAPABILITY);
  assert.equal(runInput.budget.limits.operationMs, 900_000);
  assert.equal(runInput.signal, request.signal);
  assert.equal(
    runInput.invocationStartedAt,
    Date.parse('2026-09-19T12:00:00.000Z'),
  );
});

test('an unclassified worker failure rejects with a fixed message for platform retry', async () => {
  const handler = createHandler({
    env: {
      BOARD_APP_ORIGIN: ORIGIN,
      BOARD_OWNER_ID: '99961',
      GITHUB_APP_ID: '4995264',
      GITHUB_APP_CLIENT_ID: 'synthetic-client',
      GITHUB_APP_CLIENT_SECRET: 'synthetic-client-secret',
      BOARD_TOKEN_KEY_ID: 'current',
      BOARD_TOKEN_ENCRYPTION_KEY: KEY,
      ANTHROPIC_API_KEY: 'synthetic-anthropic-key',
    },
    storageFactory: async ({ storeName }) => ({ storeName }),
    authFactory: () => ({}),
    sourceFactory: () => ({}),
    anthropicFactory: () => ({}),
    jobStoreFactory: authorizedJobStore(),
    workerFactory: () => ({
      async run() {
        throw new Error('private unexpected failure detail');
      },
    }),
  });

  await assert.rejects(handler(invocation(), published), (error) => {
    assert.equal(error.message, 'Board background execution failed.');
    assert.equal(error.message.includes('private'), false);
    return true;
  });
});
