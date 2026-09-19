import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createStorage, createProductionStorage } from '../lib/storage.mjs';
import { createOperationBudget } from '../lib/source-limits.mjs';

const key = 'session/' + 'a'.repeat(64);
test('adapter requests strong JSON reads and preserves exact opaque ETags for atomic writes', async () => {
  const calls = [];
  const store = {
    getWithMetadata: async (...args) => {
      calls.push(args);
      return { data: { value: 1 }, etag: 'W/"quoted"' };
    },
    setJSON: async (...args) => {
      calls.push(args);
      return { modified: false };
    },
  };
  const adapter = createStorage({ store });
  assert.deepEqual(await adapter.read(key), {
    value: { value: 1 },
    etag: 'W/"quoted"',
  });
  assert.deepEqual(calls[0], [key, { type: 'json', consistency: 'strong' }]);
  assert.deepEqual(
    await adapter.write(key, {}, { onlyIfMatch: 'W/"quoted"' }),
    { modified: false },
  );
  assert.equal(calls[1][2].onlyIfMatch, 'W/"quoted"');
  store.setJSON = async () => ({ modified: true, etag: '"next"' });
  assert.deepEqual(await adapter.write(key, {}, { onlyIfNew: true }), {
    modified: true,
    etag: '"next"',
  });
  store.setJSON = async () => ({ modified: true });
  await assert.rejects(adapter.write(key, {}, { onlyIfNew: true }), {
    code: 'service_unavailable',
  });
});
test('coordination listing stops at its limit and account records cannot be deleted', async () => {
  let pages = 0;
  const adapter = createStorage({
    store: {
      async *list(options) {
        assert.deepEqual(options, { prefix: 'session/', paginate: true });
        pages++;
        yield { blobs: [{ key }, { key: 'session/' + 'b'.repeat(64) }] };
        pages++;
        throw new Error('Must not fetch next page');
      },
      delete: async () => {},
    },
  });
  assert.deepEqual(await adapter.listKeys({ prefix: 'session/', limit: 1 }), [
    key,
  ]);
  assert.equal(pages, 1);
  await assert.rejects(adapter.delete('account/99961'), {
    code: 'service_unavailable',
  });
});
test('fixed report, job and spend stores reject cross-namespace keys and unsafe deletion', async () => {
  const calls = [];
  const store = {
    getWithMetadata: async (key) => {
      calls.push(['read', key]);
      return null;
    },
    delete: async (key) => calls.push(['delete', key]),
  };
  const reports = createStorage({ store, storeName: 'board-reports' });
  const jobs = createStorage({ store, storeName: 'board-jobs' });
  const spend = createStorage({ store, storeName: 'board-spend' });
  await reports.read('owners/99961/catalog');
  await reports.read('owners/99961/repositories/17/state');
  await reports.read(`owners/99961/repositories/17/versions/${'a'.repeat(64)}`);
  await jobs.read(`jobs/${'b'.repeat(64)}`);
  await spend.read('setup/v1');
  await spend.read(`setup/preflight/v1/${'d'.repeat(64)}`);
  await spend.read('production/policy.v1/2026-09');
  await reports.delete(
    `owners/99961/repositories/17/versions/${'c'.repeat(64)}`,
  );
  for (const [adapter, unsafeKey] of [
    [reports, 'account/99961'],
    [jobs, `jobs/${'A'.repeat(64)}`],
    [spend, 'production/../2026-09'],
  ])
    await assert.rejects(adapter.read(unsafeKey), {
      code: 'service_unavailable',
    });
  await assert.rejects(reports.delete('owners/99961/repositories/17/state'), {
    code: 'service_unavailable',
  });
  await assert.rejects(jobs.delete(`jobs/${'b'.repeat(64)}`), {
    code: 'service_unavailable',
  });
  await assert.rejects(spend.listKeys({ prefix: 'production/', limit: 1 }), {
    code: 'service_unavailable',
  });
  assert.equal(calls.filter(([operation]) => operation === 'delete').length, 1);
});
test('production SDK import and store open happen only when explicitly requested', async () => {
  let loaded = 0;
  const result = await createProductionStorage({
    loadBlobs: async () => {
      loaded++;
      return {
        getStore(options) {
          assert.equal(options.name, 'board-auth');
          assert.equal(options.consistency, 'strong');
          assert.equal(typeof options.fetch, 'function');
          return {};
        },
      };
    },
  });
  assert.equal(loaded, 1);
  assert.equal(typeof result.read, 'function');
  await assert.rejects(
    createProductionStorage({
      loadBlobs: async () => {
        throw new Error('provider sensitive text');
      },
    }),
    { code: 'service_unavailable' },
  );
});
test('production storage opens only fixed namespaces', async () => {
  const opened = [];
  const loadBlobs = async () => ({
    getStore(options) {
      opened.push(options.name);
      return {};
    },
  });
  for (const storeName of [
    'board-auth',
    'board-reports',
    'board-jobs',
    'board-spend',
  ])
    await createProductionStorage({ storeName, loadBlobs });
  assert.deepEqual(opened, [
    'board-auth',
    'board-reports',
    'board-jobs',
    'board-spend',
  ]);
  await assert.rejects(
    createProductionStorage({ storeName: 'board-untrusted', loadBlobs }),
    { code: 'service_unavailable' },
  );
});

async function syntheticSdk(options) {
  const { getStore } = await import('@netlify/blobs');
  return {
    getStore: (input) =>
      getStore({
        ...input,
        siteID: 'synthetic-site',
        token: 'synthetic-platform-token',
        apiURL: 'https://synthetic-storage.example',
        ...options,
      }),
  };
}

test('installed SDK uses injected bounded fetch, strong reads and exact conditional ETags without real services', async () => {
  const calls = [];
  const adapter = await createProductionStorage({
    loadBlobs: () => syntheticSdk(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(new URL(url).origin, 'https://synthetic-storage.example');
      if (
        new Headers(init.headers).get('accept') ===
        'application/json;type=signed-url'
      )
        return Response.json({
          url: 'https://synthetic-storage.example/signed',
        });
      if (init.method === 'get')
        return Response.json(
          { schemaVersion: 1 },
          { headers: { etag: 'W/"read-etag"' } },
        );
      assert.equal(init.headers['if-match'], 'W/"read-etag"');
      return new Response(null, { headers: { etag: '"write-etag"' } });
    },
  });
  const budget = createOperationBudget();
  assert.deepEqual(await adapter.read(key, { budget }), {
    value: { schemaVersion: 1 },
    etag: 'W/"read-etag"',
  });
  assert.deepEqual(
    await adapter.write(key, {}, { onlyIfMatch: 'W/"read-etag"' }, { budget }),
    { modified: true, etag: '"write-etag"' },
  );
  assert.equal(calls.length, 4);
  assert.ok(
    calls.every(
      ({ init }) =>
        init.signal instanceof AbortSignal && init.redirect === 'error',
    ),
  );
});

test('SDK transport failures stop hidden retries and cannot masquerade as modified conditional writes', async () => {
  let calls = 0;
  const adapter = await createProductionStorage({
    loadBlobs: () => syntheticSdk(),
    fetchImpl: async (_url, init) => {
      calls++;
      if (
        new Headers(init.headers).get('accept') ===
        'application/json;type=signed-url'
      )
        return Response.json({
          url: 'https://synthetic-storage.example/signed',
        });
      return new Response('synthetic-private-storage-error', {
        status: 500,
        headers: { etag: '"misleading"' },
      });
    },
  });
  await assert.rejects(
    adapter.write(
      key,
      {},
      { onlyIfNew: true },
      { budget: createOperationBudget() },
    ),
    { code: 'service_unavailable' },
  );
  assert.equal(
    calls,
    2,
    'the installed SDK must not enter its five-retry loop',
  );
  assert.throws(() => adapter.read(key), { code: 'service_unavailable' });
});

test('SDK timeout covers streamed bodies and external abort prevents later SDK requests', async () => {
  let calls = 0;
  const controller = new AbortController();
  const adapter = await createProductionStorage({
    loadBlobs: () => syntheticSdk(),
    fetchImpl: async (_url, init) => {
      calls++;
      if (
        new Headers(init.headers).get('accept') ===
        'application/json;type=signed-url'
      )
        return Response.json({
          url: 'https://synthetic-storage.example/signed',
        });
      return new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
        }),
      );
    },
  });
  const budget = createOperationBudget({
    signal: controller.signal,
    limits: { requestMs: 10, operationMs: 1000 },
  });
  const keepAlive = delay(50);
  await assert.rejects(adapter.read(key, { budget }), {
    code: 'source_timeout',
  });
  assert.equal(calls, 2);
  controller.abort();
  await assert.rejects(
    adapter.write(key, {}, { onlyIfNew: true }, { budget }),
    { code: 'source_timeout' },
  );
  assert.equal(calls, 2);
  await keepAlive;
});
