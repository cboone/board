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
async function setup(sourceOperations, reportOperations = null) {
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
  const request = (path, method = 'GET', headers = {}, body) =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { Cookie: cookies, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  let tokenAcquisitions = 0;
  const apiAuth = {
    ...auth,
    async acquireToken(...arguments_) {
      tokenAcquisitions += 1;
      return auth.acquireToken(...arguments_);
    },
  };
  const api = createApi({
    auth: apiAuth,
    sourceOperations: operations,
    reportOperations,
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
    tokenAcquisitions: () => tokenAcquisitions,
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

test('saved report reads and setup decisions stay on Board storage without acquiring a GitHub token', async () => {
  const calls = [];
  const jobId = 'd'.repeat(64);
  const decision = {
    policyId: 'setup-v1',
    discussionRevision: 1,
    decisionId: 'e'.repeat(64),
    decision: 'acknowledge',
    authorizedThroughMicrousd: 25_000_000,
    authorizedOperations: ['generate', 'refresh'],
  };
  const reportOperations = {
    async listReports(input) {
      calls.push(['list', input]);
      return { items: [], nextCursor: null };
    },
    async getReport(input) {
      calls.push(['report', input]);
      return { marker: 'private-report' };
    },
    async pollJob(input) {
      calls.push(['job', input]);
      return { marker: 'private-job' };
    },
    async decideSetupBudget(input) {
      calls.push(['decision', input]);
      return { ok: true };
    },
  };
  const ctx = await setup(undefined, reportOperations);
  const responses = [
    await ctx.api(ctx.request('/api/reports?cursor=opaque-cursor')),
    await ctx.api(ctx.request('/api/repositories/17/report')),
    await ctx.api(ctx.request(`/api/report-jobs/${jobId}`)),
    await ctx.api(
      ctx.request(
        '/api/setup-budget-decision',
        'POST',
        { ...ctx.csrf, 'Content-Type': 'application/json' },
        decision,
      ),
    ),
  ];
  assert.deepEqual(
    await Promise.all(responses.map((response) => response.json())),
    [
      { items: [], nextCursor: null },
      { marker: 'private-report' },
      { marker: 'private-job' },
      { ok: true },
    ],
  );
  assert.ok(responses.every((response) => response.status === 200));
  assert.ok(
    responses.every(
      (response) => response.headers.get('cache-control') === 'no-store',
    ),
  );
  assert.equal(ctx.tokenAcquisitions(), 0);
  assert.equal(ctx.networkCalls(), 2);
  assert.deepEqual(
    calls.map(([name, input]) => [
      name,
      input.ownerId,
      input.repositoryId ?? input.jobId ?? input.cursor ?? null,
    ]),
    [
      ['list', 99961, 'opaque-cursor'],
      ['report', 99961, 17],
      ['job', 99961, jobId],
      ['decision', 99961, null],
    ],
  );
  assert.deepEqual(calls[3][1].decision, decision);
  assert.ok(calls.every(([, input]) => ctx.budgets.includes(input.budget)));
});

test('analysis admission validates its bounded body before GitHub work and returns 202 after pinning access', async () => {
  let sourceCalls = 0;
  let admitted;
  const sourceOperations = {
    async listRepositories() {
      throw new Error('Unexpected listing');
    },
    async checkRepositoryAccess(input) {
      sourceCalls += 1;
      assert.equal(input.repositoryId, 17);
      return {
        ...repo,
        defaultBranch: 'main',
        defaultTip: 'a'.repeat(40),
      };
    },
  };
  const job = {
    id: 'b'.repeat(64),
    operation: 'generate',
    state: 'queued',
    createdAt: '2026-09-18T12:00:00.000Z',
    errorCode: null,
    reportId: null,
  };
  const reportOperations = {
    async admitJob(input) {
      admitted = input;
      return { job };
    },
  };
  const ctx = await setup(sourceOperations, reportOperations);
  const headers = { ...ctx.csrf, 'Content-Type': 'application/json' };
  const invalid = await ctx.api(
    ctx.request('/api/repositories/17/report-jobs', 'POST', headers, {
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
      operation: 'generate',
      expectedCurrentReportId: null,
      unexpected: true,
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal(sourceCalls, 0);
  assert.equal(ctx.tokenAcquisitions(), 0);

  const response = await ctx.api(
    ctx.request('/api/repositories/17/report-jobs', 'POST', headers, {
      idempotencyKey: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF',
      operation: 'generate',
      expectedCurrentReportId: null,
    }),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { job });
  assert.equal(sourceCalls, 1);
  assert.equal(ctx.tokenAcquisitions(), 1);
  assert.equal(admitted.ownerId, 99961);
  assert.equal(admitted.authorizationEpoch, ctx.session.authorizationEpoch);
  assert.equal(admitted.repository.id, 17);
  assert.deepEqual(admitted.request, {
    idempotencyKey: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
    operation: 'generate',
    expectedCurrentReportId: null,
  });
  assert.equal(admitted.budget, ctx.budgets[1]);
});

test('report routes reject malformed URLs, JSON, CSRF and operation tuples before delegated work', async () => {
  let reportCalls = 0;
  const reportOperations = new Proxy(
    {},
    {
      get() {
        return async () => {
          reportCalls += 1;
          return {};
        };
      },
    },
  );
  const ctx = await setup(undefined, reportOperations);
  const jsonHeaders = { ...ctx.csrf, 'Content-Type': 'application/json' };
  const cases = [
    ctx.request('/api/reports?cursor=one&cursor=two'),
    ctx.request('/api/repositories/17/report?raw=true'),
    ctx.request('/api/report-jobs/not-a-job'),
    ctx.request('/api/repositories/17/report-jobs', 'POST', jsonHeaders, {
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
      operation: 'refresh',
      expectedCurrentReportId: null,
    }),
    ctx.request('/api/setup-budget-decision', 'POST', jsonHeaders, {
      policyId: 'setup-v1',
      discussionRevision: 1,
      decisionId: 'a'.repeat(64),
      decision: 'stop',
      authorizedThroughMicrousd: 1,
      authorizedOperations: [],
    }),
    ctx.request(
      '/api/repositories/17/report-jobs',
      'POST',
      { Origin: ORIGIN, 'Content-Type': 'application/json' },
      {
        idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
        operation: 'generate',
        expectedCurrentReportId: null,
      },
    ),
  ];
  for (const request of cases) {
    const response = await ctx.api(request);
    assert.ok([400, 403].includes(response.status));
  }
  assert.equal(reportCalls, 0);
  assert.equal(ctx.tokenAcquisitions(), 0);
});

test('stored source checks use the report coordinator while the API projects only safe summary fields', async () => {
  let checked;
  const value = summary();
  value.provenance.files[0].contents = 'private-file-content';
  const ctx = await setup(undefined, {
    async checkSource(input) {
      checked = input;
      return {
        summary: value,
        sourceSnapshot: { body: 'private-issue-body' },
      };
    },
  });
  const response = await ctx.api(
    ctx.request('/api/repositories/17/check', 'POST', ctx.csrf),
  );
  assert.equal(response.status, 200);
  const serialized = JSON.stringify(await response.json());
  assert.ok(!serialized.includes('private-file-content'));
  assert.ok(!serialized.includes('private-issue-body'));
  assert.equal(checked.ownerId, 99961);
  assert.equal(checked.repositoryId, 17);
  assert.equal(checked.accessToken, 'synthetic-access');
  assert.equal(checked.budget, ctx.budgets[0]);
});

test('a revoked session cannot return a private report read that finishes later', async () => {
  let ctx;
  const reportOperations = {
    async getReport() {
      await ctx.auth.logout({ session: ctx.session });
      return { report: 'private-report-body' };
    },
  };
  ctx = await setup(undefined, reportOperations);
  const response = await ctx.api(ctx.request('/api/repositories/17/report'));
  assert.equal(response.status, 401);
  assert.ok(!JSON.stringify(await response.json()).includes('private-report'));
  assert.equal(ctx.tokenAcquisitions(), 0);
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
