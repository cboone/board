import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi, projectSummary } from '../lib/api.mjs';
import { createHandler, config as routeConfig } from '../functions/api.mjs';
import { createAuth } from '../lib/auth.mjs';
import { BoardError } from '../lib/errors.mjs';
import {
  ORIGIN,
  testConfig,
  testCrypto,
  memoryStorage,
  budget,
  tokenResponse,
  deferred,
} from './auth-helpers.mjs';

const repo = {
  id: 17,
  fullName: 'cboone/synthetic-repo',
  name: 'synthetic-repo',
  private: true,
  url: 'https://github.com/cboone/synthetic-repo',
};
function summary() {
  const at = '2026-09-18T12:00:00.000Z';
  return {
    status: 'complete',
    repo,
    sync: {
      at,
      timeZone: 'UTC',
      branch: 'main',
      commit: 'a'.repeat(40),
      openPullRequests: 0,
    },
    fingerprint: {
      algorithm: 'sha256',
      value: 'b'.repeat(64),
      scope: 'core-and-collected-context',
    },
    provenance: {
      observedFrom: at,
      observedTo: at,
      consistency: 'two-pass-matched',
      inputs: [{ name: 'issues', status: 'complete' }],
      files: [{ path: 'README.md', blobId: 'c'.repeat(40) }],
      references: { verified: 0, unverified: 1 },
      limitations: ['External references remain unverified.'],
    },
    counts: Object.fromEntries(
      [
        'openIssues',
        'openPullRequests',
        'milestones',
        'labels',
        'branches',
        'unmergedBranches',
        'issueComments',
        'treeEntries',
        'selectedFiles',
      ].map((name) => [name, 0]),
    ),
  };
}
async function setup(sourceOperations) {
  const now = () => Date.parse('2026-09-18T12:00:00.000Z');
  const config = testConfig();
  const storage = memoryStorage();
  const crypto = testCrypto(config);
  let networkCalls = 0;
  const auth = createAuth({
    config,
    storage,
    crypto,
    now,
    fetchImpl: async (url) => {
      networkCalls++;
      if (url.endsWith('/access_token')) return Response.json(tokenResponse());
      if (url.endsWith('/user'))
        return Response.json({ id: 99961, login: 'cboone' });
      throw new Error('Unexpected network');
    },
  });
  const authorize = async () => {
    const start = await auth.startOAuth(
      new Request(`${ORIGIN}/api/auth/start`),
      { budget: budget(now) },
    );
    const state = new URL(start.location).searchParams.get('state');
    return auth.completeOAuth(
      new Request(
        `${ORIGIN}/api/auth/callback?state=${state}&code=synthetic-code`,
        { headers: { Cookie: start.cookies[0].split(';')[0] } },
      ),
      { budget: budget(now) },
    );
  };
  const done = await authorize();
  const cookies = done.cookies[1].split(';')[0];
  const request = (path, method = 'GET', headers = {}) =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { Cookie: cookies, ...headers },
    });
  const session = await auth.requireAuthorizedOwner(request('/api/session'));
  const operations = sourceOperations ?? {
    listRepositories: async () => ({
      repositories: [repo],
      sourceAuthorization: 'ready',
    }),
    checkRepository: async () => ({
      summary: summary(),
      sourceSnapshot: { issueBodies: 'never-serialize-raw-body' },
    }),
  };
  const budgets = [];
  const api = createApi({
    auth,
    sourceOperations: operations,
    createOperationBudget: () => {
      const value = budget(now);
      budgets.push(value);
      return value;
    },
  });
  return {
    auth,
    api,
    storage,
    crypto,
    request,
    session,
    authorize,
    budgets,
    csrf: { Origin: ORIGIN, 'X-CSRF-Token': session.csrfToken },
    networkCalls: () => networkCalls,
  };
}

test('bootstrap is no-store and never contacts providers; repository list records only source capability', async () => {
  const ctx = await setup();
  const bootstrap = await ctx.api(ctx.request('/api/session'));
  assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await bootstrap.json(), {
    auth: true,
    user: { id: 99961, login: 'cboone' },
    csrfToken: ctx.session.csrfToken,
    sourceAuthorization: 'unverified',
  });
  assert.equal(ctx.networkCalls(), 2);
  const listed = await ctx.api(ctx.request('/api/repositories'));
  assert.deepEqual(await listed.json(), { repositories: [repo] });
  assert.equal(
    (await ctx.auth.bootstrap(ctx.request('/api/session'))).sourceAuthorization,
    'ready',
  );
  const unsigned = await ctx.api(new Request(`${ORIGIN}/api/session`));
  assert.deepEqual(await unsigned.json(), { auth: false });
});

test('source check shares the token budget and serializes only the explicit nested summary', async () => {
  let received;
  const original = summary();
  original.accessToken = 'unexpected-sensitive-token';
  original.repo.body = 'unexpected-raw-repository-body';
  original.sync.refreshToken = 'unexpected-sensitive-token';
  original.fingerprint.rawBody = 'unexpected-raw-body';
  original.provenance.files[0].contents = 'unexpected-raw-file';
  original.counts.internal = 'unexpected-private-count';
  const ctx = await setup({
    listRepositories: async () => {
      throw new Error('Unexpected listing');
    },
    checkRepository: async (args) => {
      received = args;
      return {
        summary: original,
        sourceSnapshot: { raw: 'unexpected-raw-source' },
      };
    },
  });
  const response = await ctx.api(
    ctx.request('/api/repositories/17/check', 'POST', ctx.csrf),
  );
  assert.equal(response.status, 200);
  assert.equal(received.budget, ctx.budgets[0]);
  assert.equal(received.ownerId, 99961);
  assert.equal(received.repositoryId, 17);
  const serialized = JSON.stringify(await response.json());
  assert.ok(!serialized.includes('unexpected'));
  assert.ok(!serialized.includes('sourceSnapshot'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('summary projection preserves valid literal branch characters and rejects unsafe control or path components', () => {
  for (const branch of [
    'topic/#1',
    'topic/<tag>',
    'topic/é',
    'feature/nested/topic',
  ]) {
    const value = summary();
    value.sync.branch = branch;
    assert.equal(projectSummary(value, repo.id).sync.branch, branch);
  }
  for (const branch of [
    'topic/\u0001work',
    'topic/../work',
    'topic//work',
    'topic work',
  ]) {
    const value = summary();
    value.sync.branch = branch;
    assert.throws(() => projectSummary(value, repo.id), {
      code: 'internal_error',
    });
  }
});

test('repository projection preserves complete eligible inventories beyond the issue-count boundary', async () => {
  const repositories = Array.from({ length: 1001 }, (_, index) => ({
    id: index + 1,
    name: `synthetic-${index}`,
    fullName: `cboone/synthetic-${index}`,
    private: index % 2 === 0,
    url: `https://github.com/cboone/synthetic-${index}`,
  }));
  let sourceBudget;
  const ctx = await setup({
    listRepositories: async ({ budget }) => {
      sourceBudget = budget;
      return { repositories, sourceAuthorization: 'ready' };
    },
  });
  const response = await ctx.api(ctx.request('/api/repositories'));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).repositories, repositories);
  assert.equal(sourceBudget, ctx.budgets[0]);
  assert.equal(sourceBudget.limits.repositories, 10000);
});

test('successful direct checks update known source authorization from unverified or installation-required to ready', async () => {
  for (const initial of ['unverified', 'installation-required']) {
    const ctx = await setup();
    const stored = await ctx.storage.read('account/99961');
    await ctx.storage.write(
      'account/99961',
      { ...stored.value, sourceAuthorization: initial },
      { onlyIfMatch: stored.etag },
    );
    const response = await ctx.api(
      ctx.request('/api/repositories/17/check', 'POST', ctx.csrf),
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await ctx.auth.bootstrap(ctx.request('/api/session')))
        .sourceAuthorization,
      'ready',
    );
  }
});

test('invalid IDs, methods, arbitrary URL inputs and CSRF are rejected before source work', async () => {
  let sourceCalls = 0;
  const ctx = await setup({
    listRepositories: async () => {
      sourceCalls++;
    },
    checkRepository: async () => {
      sourceCalls++;
    },
  });
  for (const path of [
    '/api/repositories/0/check',
    '/api/repositories/9007199254740992/check',
    '/api/repositories/https%3A%2F%2Fother.example/check',
    '/api/repositories/17/check?url=https://other.example',
  ])
    assert.equal(
      (await ctx.api(ctx.request(path, 'POST', ctx.csrf))).status,
      400,
    );
  assert.equal((await ctx.api(ctx.request('/api/auth/logout'))).status, 400);
  assert.equal(
    (await ctx.api(ctx.request('/api/repositories/17/check', 'POST'))).status,
    403,
  );
  assert.equal(
    (
      await ctx.api(
        ctx.request('/api/repositories/17/check', 'POST', {
          ...ctx.csrf,
          Origin: 'https://other.example',
        }),
      )
    ).status,
    403,
  );
  assert.equal(sourceCalls, 0);
  assert.equal(
    (await ctx.api(new Request(`${ORIGIN}/api/repositories`))).status,
    401,
  );
});

test('logout revokes the server session before returning its cookie clear and result', async () => {
  const ctx = await setup();
  const response = await ctx.api(
    ctx.request('/api/auth/logout', 'POST', ctx.csrf),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(
    response.headers.get('set-cookie'),
    /^__Host-board_session=;.*Max-Age=0$/,
  );
  await assert.rejects(
    ctx.auth.requireAuthorizedOwner(ctx.request('/api/session')),
    { code: 'session_required' },
  );
});

test('logout during source gathering prevents the pending private summary from being returned', async () => {
  const entered = deferred();
  const gate = deferred();
  const ctx = await setup({
    checkRepository: async () => {
      entered.resolve();
      await gate.promise;
      return { summary: summary(), sourceSnapshot: { raw: 'private-source' } };
    },
  });
  const pending = ctx.api(
    ctx.request('/api/repositories/17/check', 'POST', ctx.csrf),
  );
  await entered.promise;
  await ctx.auth.logout({ session: ctx.session });
  gate.resolve();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.ok(!JSON.stringify(await response.json()).includes('synthetic-repo'));
});

test('new OAuth credentials prevent a pending private repository list from returning stale results', async () => {
  const entered = deferred();
  const gate = deferred();
  const ctx = await setup({
    listRepositories: async () => {
      entered.resolve();
      await gate.promise;
      return { repositories: [repo], sourceAuthorization: 'ready' };
    },
  });
  const pending = ctx.api(ctx.request('/api/repositories'));
  await entered.promise;
  await ctx.authorize();
  gate.resolve();
  const response = await pending;
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, 'provider_unavailable');
  assert.ok(!JSON.stringify(body).includes('synthetic-repo'));
  const lease = await ctx.auth.acquireToken({ session: ctx.session });
  assert.equal(lease.generation, 2);
  assert.equal((await ctx.storage.read('account/99961')).value.state, 'active');
});

test('source authorization rejection prevents a pending private check from returning stale results', async () => {
  const entered = deferred();
  const gate = deferred();
  const ctx = await setup({
    checkRepository: async () => {
      entered.resolve();
      await gate.promise;
      return { summary: summary(), sourceSnapshot: { raw: 'private-source' } };
    },
  });
  const lease = await ctx.auth.acquireToken({ session: ctx.session });
  const pending = ctx.api(
    ctx.request('/api/repositories/17/check', 'POST', ctx.csrf),
  );
  await entered.promise;
  assert.equal(await ctx.auth.noteTokenRejected({ lease }), true);
  gate.resolve();
  const response = await pending;
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, 'provider_unavailable');
  assert.ok(!JSON.stringify(body).includes('synthetic-repo'));
  assert.ok(!JSON.stringify(body).includes('private-source'));
  const bootstrap = await ctx.auth.bootstrap(ctx.request('/api/session'));
  assert.equal(bootstrap.auth, true);
  assert.equal(bootstrap.sourceAuthorization, 'reauthorization-required');
});

test('credentials superseded after source authorization commits are rejected by the final lease check', async () => {
  const ctx = await setup();
  const write = ctx.storage.write.bind(ctx.storage);
  let sourceAuthorizationCommitted = false;
  ctx.storage.write = async (key, value, condition) => {
    const result = await write(key, value, condition);
    if (
      key === 'account/99961' &&
      value.generation === 1 &&
      value.sourceAuthorization === 'ready' &&
      result.modified
    )
      sourceAuthorizationCommitted = true;
    return result;
  };
  const read = ctx.storage.read.bind(ctx.storage);
  let supersededDuringFinalCheck = false;
  ctx.storage.read = async (key) => {
    if (
      key === ctx.session.key &&
      sourceAuthorizationCommitted &&
      !supersededDuringFinalCheck
    ) {
      supersededDuringFinalCheck = true;
      await ctx.authorize();
    }
    return read(key);
  };

  const response = await ctx.api(
    ctx.request('/api/repositories/17/check', 'POST', ctx.csrf),
  );
  assert.equal(sourceAuthorizationCommitted, true);
  assert.equal(supersededDuringFinalCheck, true);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, 'provider_unavailable');
  assert.ok(!JSON.stringify(body).includes('synthetic-repo'));
  const lease = await ctx.auth.acquireToken({ session: ctx.session });
  assert.equal(lease.generation, 2);
});

test('current source-token rejection is 403 while superseded rejection leaves newer credentials usable', async () => {
  for (const newer of [false, true]) {
    const ctx = await setup({
      listRepositories: async () => {
        if (newer) {
          const current = await ctx.storage.read('account/99961');
          const cryptoContext = {
            purpose: 'github-token-pair',
            recordKey: 'account/99961',
            schemaVersion: 1,
            ownerId: 99961,
          };
          const pair = ctx.crypto.decrypt(
            current.value.tokenEnvelope,
            cryptoContext,
          );
          await ctx.storage.write(
            'account/99961',
            {
              ...current.value,
              generation: 2,
              tokenEnvelope: ctx.crypto.encrypt(
                {
                  ...pair,
                  generation: 2,
                  accessToken: 'newer-authorized-access',
                },
                cryptoContext,
              ),
            },
            { onlyIfMatch: current.etag },
          );
        }
        throw new BoardError('source_authorization_required');
      },
    });
    const response = await ctx.api(ctx.request('/api/repositories'));
    assert.equal(response.status, newer ? 502 : 403);
    assert.equal(
      (await ctx.auth.bootstrap(ctx.request('/api/session'))).auth,
      true,
    );
    assert.equal(
      (await ctx.storage.read('account/99961')).value.state,
      newer ? 'active' : 'reauthorization-required',
    );
    if (newer)
      assert.equal(
        (
          await ctx.auth.acquireToken({
            session: ctx.session,
            budget: ctx.budgets[0],
          })
        ).accessToken,
        'newer-authorized-access',
      );
  }
});

test('failed logout CAS never clears its cookie or claims confirmed server sign-out', async () => {
  const ctx = await setup();
  const write = ctx.storage.write.bind(ctx.storage);
  let attempts = 0;
  ctx.storage.write = async (key, value, condition) => {
    if (key.startsWith('session/') && value.revokedAt !== undefined) {
      attempts++;
      return { modified: false };
    }
    return write(key, value, condition);
  };
  const result = await ctx.api(
    ctx.request('/api/auth/logout', 'POST', ctx.csrf),
  );
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(attempts, 8);
  assert.equal(
    (await ctx.auth.bootstrap(ctx.request('/api/session'))).auth,
    true,
  );
});

test('unavailable or inaccessible sources preserve owner authorization for saved-report stubs', async () => {
  for (const condition of [
    'archived',
    'transferred',
    'deleted',
    'inaccessible',
    'installation-removed',
  ]) {
    let sourceCalls = 0;
    const ctx = await setup({
      checkRepository: async () => {
        sourceCalls++;
        throw new BoardError(
          condition === 'installation-removed'
            ? 'source_authorization_required'
            : 'source_unavailable',
        );
      },
    });
    const checked = await ctx.api(
      ctx.request('/api/repositories/17/check', 'POST', ctx.csrf),
    );
    assert.equal(
      checked.status,
      condition === 'installation-removed' ? 403 : 404,
    );
    const storedReport = {
      ownerId: 99961,
      repositoryId: 17,
      content: 'synthetic-saved-report',
    };
    const session = await ctx.auth.requireAuthorizedOwner(
      ctx.request('/api/session'),
    );
    assert.equal(session.ownerId, storedReport.ownerId);
    assert.equal((await ctx.auth.recheckOwner({ session })).id, 99961);
    assert.equal(
      sourceCalls,
      1,
      'historical owner checks do not consult the unavailable source',
    );
  }
});

test('malformed source summaries and unknown provider exceptions return sanitized no-store errors', async () => {
  for (const variant of ['summary', 'exception']) {
    const ctx = await setup({
      checkRepository: async () => {
        if (variant === 'exception')
          throw new Error('private repository name and raw provider body');
        const value = summary();
        value.counts.openIssues = -1;
        return { summary: value };
      },
    });
    const response = await ctx.api(
      ctx.request('/api/repositories/17/check', 'POST', ctx.csrf),
    );
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred.',
        retryable: false,
      },
    });
  }
});

const environment = () => ({
  BOARD_APP_ORIGIN: ORIGIN,
  BOARD_OWNER_ID: '99961',
  GITHUB_APP_ID: '4995264',
  GITHUB_APP_CLIENT_ID: 'synthetic-client',
  GITHUB_APP_CLIENT_SECRET: 'synthetic-secret',
  BOARD_TOKEN_KEY_ID: 'current',
  BOARD_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
});
test('native entry guards exact deploy.context and canonical origin before secrets or store opening', async () => {
  let secretReads = 0;
  let storeOpens = 0;
  let providerCalls = 0;
  const env = {
    BOARD_APP_ORIGIN: ORIGIN,
    get GITHUB_APP_CLIENT_SECRET() {
      secretReads++;
      throw new Error('Must not read secret');
    },
  };
  const handler = createHandler({
    env,
    storageFactory: async () => {
      storeOpens++;
      throw new Error('Must not open store');
    },
    fetchImpl: async () => {
      providerCalls++;
      throw new Error('Must not call provider');
    },
  });
  assert.deepEqual(routeConfig, { path: '/api/*' });
  for (const context of [
    undefined,
    { deploy: {} },
    { deploy: { context: 'deploy-preview' } },
    { deploy: { context: 'branch-deploy' } },
    { deploy: { context: 'unknown' } },
  ])
    assert.equal(
      (await handler(new Request(`${ORIGIN}/api/session`), context)).status,
      403,
    );
  assert.equal(
    (
      await handler(new Request('https://other.example/api/session'), {
        deploy: { context: 'production' },
      })
    ).status,
    403,
  );
  assert.equal(secretReads, 0);
  assert.equal(storeOpens, 0);
  assert.equal(providerCalls, 0);
});

test('production bootstrap uses validated configuration and injected storage without a provider call', async () => {
  let opens = 0;
  const handler = createHandler({
    env: environment(),
    storageFactory: async () => {
      opens++;
      return memoryStorage();
    },
    fetchImpl: async () => {
      throw new Error('Bootstrap must not call GitHub');
    },
  });
  const response = await handler(new Request(`${ORIGIN}/api/session`), {
    deploy: { context: 'production' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { auth: false });
  assert.equal(opens, 1);
});
