import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubClient } from '../lib/github.mjs';
import { createOperationBudget } from '../lib/source-limits.mjs';
import { json } from './source-fixtures.mjs';

const token = 'sample-token';
function client(fetchImpl, limits = {}) {
  const budget = createOperationBudget({ limits });
  return createGithubClient({ accessToken: token, budget, fetchImpl });
}
test('native reads pin API version, disable redirects, and keep tokens in server headers', async () => {
  let captured;
  const api = client(async (url, init) => {
    captured = { url, init };
    return json({ ok: true });
  });
  assert.deepEqual(await api.get('/user/installations'), { ok: true });
  assert.equal(captured.url, 'https://api.github.com/user/installations');
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(captured.init.headers.Authorization, 'Bearer ' + token);
  assert.equal(captured.init.method, 'GET');
  for (const path of [
    'https://other.test/path',
    '//other.test/path',
    '/path#fragment',
    '/path\\other',
  ])
    await assert.rejects(() => api.get(path), { code: 'invalid_request' });
});
test('REST pagination traverses beyond 100 and preserves endpoint filters', async () => {
  let calls = 0;
  const api = client(async (input) => {
    calls += 1;
    const url = new URL(input);
    assert.equal(url.searchParams.get('state'), 'open');
    assert.equal(url.searchParams.get('per_page'), '100');
    return calls === 1
      ? json(
          Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
          {
            headers: {
              link: '<https://api.github.com/repos/cboone/widgets/issues?state=open&per_page=100&page=2>; rel="next"',
            },
          },
        )
      : json([{ id: 101 }]);
  });
  const values = await api.paginate('/repos/cboone/widgets/issues?state=open', {
    limit: 1000,
  });
  assert.equal(values.length, 101);
  assert.equal(calls, 2);
});
test('wrapped installation pages traverse independently', async () => {
  let calls = 0;
  const api = client(async () =>
    ++calls === 1
      ? json(
          { installations: [{ id: 1 }] },
          {
            headers: {
              link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"',
            },
          },
        )
      : json({ installations: [{ id: 2 }] }),
  );
  assert.equal(
    (
      await api.paginate('/user/installations', {
        key: 'installations',
        limit: 10,
      })
    ).length,
    2,
  );
});
test('wrapped collection totals cannot silently hide missing pages or changing membership', async () => {
  const missing = client(async () =>
    json({ total_count: 2, installations: [{ id: 1 }] }),
  );
  await assert.rejects(
    () =>
      missing.paginate('/user/installations', {
        key: 'installations',
        limit: 10,
      }),
    { code: 'source_unstable' },
  );
  let calls = 0;
  const moving = client(async () =>
    ++calls === 1
      ? json(
          { total_count: 2, installations: [{ id: 1 }] },
          {
            headers: {
              link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"',
            },
          },
        )
      : json({ total_count: 3, installations: [{ id: 2 }] }),
  );
  await assert.rejects(
    () =>
      moving.paginate('/user/installations', {
        key: 'installations',
        limit: 10,
      }),
    { code: 'source_unstable' },
  );
  const stable = client(async () =>
    json({ total_count: 1, installations: [{ id: 1 }] }),
  );
  assert.equal(
    (
      await stable.paginate('/user/installations', {
        key: 'installations',
        limit: 10,
      })
    ).length,
    1,
  );
});
test('concurrency slots stay occupied while response streams are still reading', async () => {
  let streams = 0;
  let maximum = 0;
  const api = client(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            streams += 1;
            maximum = Math.max(maximum, streams);
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('{}'));
              controller.close();
              streams -= 1;
            }, 3);
          },
        }),
      ),
    { concurrency: 2 },
  );
  await Promise.all(
    Array.from({ length: 8 }, (_, index) => api.get('/items/' + index)),
  );
  assert.equal(maximum, 2);
});
for (const [name, next] of [
  [
    'another origin',
    'https://other.test/repos/cboone/widgets/issues?state=open&per_page=100&page=2',
  ],
  [
    'another resource',
    'https://api.github.com/repos/cboone/widgets/pulls?state=open&per_page=100&page=2',
  ],
  [
    'changed filter',
    'https://api.github.com/repos/cboone/widgets/issues?state=closed&per_page=100&page=2',
  ],
  [
    'new query input',
    'https://api.github.com/repos/cboone/widgets/issues?state=open&per_page=100&evil=1&page=2',
  ],
  [
    'repeated page',
    'https://api.github.com/repos/cboone/widgets/issues?state=open&per_page=100&page=1',
  ],
  [
    'unsafe page number',
    'https://api.github.com/repos/cboone/widgets/issues?state=open&per_page=100&page=9007199254740992',
  ],
  [
    'credential URL',
    'https://name@api.github.com/repos/cboone/widgets/issues?state=open&per_page=100&page=2',
  ],
])
  test('pagination rejects ' + name + ' before fetching it', async () => {
    let calls = 0;
    const api = client(async () => {
      calls += 1;
      return json([{ id: 1 }], {
        headers: { link: '<' + next + '>; rel="next"' },
      });
    });
    await assert.rejects(
      () =>
        api.paginate('/repos/cboone/widgets/issues?state=open', { limit: 10 }),
      { code: 'source_incomplete' },
    );
    assert.equal(calls, 1);
  });
for (const conflicting of [false, true])
  test(
    'repeated paginated identity fails even when ' +
      (conflicting ? 'conflicting' : 'identical'),
    async () => {
      let calls = 0;
      const api = client(async () =>
        ++calls === 1
          ? json([{ id: 1, title: 'First' }], {
              headers: {
                link: '<https://api.github.com/items?per_page=100&page=2>; rel="next"',
              },
            })
          : json([{ id: 1, title: conflicting ? 'Changed' : 'First' }]),
      );
      await assert.rejects(() => api.paginate('/items', { limit: 10 }), {
        code: 'source_unstable',
      });
    },
  );
for (const [status, headers, code] of [
  [401, {}, 'source_authorization_required'],
  [403, {}, 'forbidden'],
  [404, {}, 'source_unavailable'],
  [403, { 'x-ratelimit-remaining': '0' }, 'provider_rate_limited'],
  [403, { 'retry-after': '100' }, 'provider_rate_limited'],
  [429, {}, 'provider_rate_limited'],
  [503, {}, 'provider_unavailable'],
])
  test('provider status ' + status + ' maps to safe ' + code, async () => {
    const api = client(
      async () =>
        json({ message: 'Private provider details' }, { status, headers }),
      { transportRetries: 0 },
    );
    await assert.rejects(
      () => api.get('/items'),
      (error) => error.code === code && !error.message.includes('Private'),
    );
  });
test('one transport retry consumes the original operation request budget', async () => {
  let calls = 0;
  const api = client(
    async () => {
      if (++calls === 1) throw new TypeError('Transport');
      return json({ ok: true });
    },
    { requests: 2 },
  );
  assert.deepEqual(await api.get('/items'), { ok: true });
  await assert.rejects(() => api.get('/items'), {
    code: 'source_limit_exceeded',
  });
  assert.equal(calls, 2);
});
test('the read-only retry allowance is shared across requests', async () => {
  let calls = 0;
  const api = client(async () => {
    calls += 1;
    return json({}, { status: 503 });
  });
  await assert.rejects(() => api.get('/items'), {
    code: 'provider_unavailable',
  });
  await assert.rejects(() => api.get('/items'), {
    code: 'provider_unavailable',
  });
  assert.equal(calls, 3);
});
test('rate backoff beyond the original deadline returns without waiting', async () => {
  let calls = 0;
  const api = client(async () => {
    calls += 1;
    return json({}, { status: 429, headers: { 'retry-after': '1000' } });
  });
  await assert.rejects(() => api.get('/items'), {
    code: 'provider_rate_limited',
  });
  assert.equal(calls, 1);
});
test('secondary rate limits without a remaining-zero header retain the rate-limit category', async () => {
  const api = client(async () =>
    json(
      { message: 'You have exceeded a secondary rate limit. Private context.' },
      {
        status: 403,
        headers: { 'x-ratelimit-remaining': '100' },
      },
    ),
  );
  await assert.rejects(
    () => api.get('/items'),
    (error) =>
      error.code === 'provider_rate_limited' &&
      !error.message.includes('Private'),
  );
});
test('rate backoff that fits the same deadline consumes exactly one retry', async () => {
  let calls = 0;
  const api = client(async () =>
    ++calls === 1
      ? json({}, { status: 429, headers: { 'retry-after': '0' } })
      : json({ ok: true }),
  );
  assert.deepEqual(await api.get('/items'), { ok: true });
  assert.equal(calls, 2);
});
test('invalid JSON and invalid UTF-8 cannot become successful provider data', async () => {
  for (const response of [
    new Response('invalid'),
    new Response(new Uint8Array([0xff])),
  ]) {
    const api = client(async () => response);
    await assert.rejects(() => api.get('/items'), {
      code: 'source_incomplete',
    });
  }
});
test('the per-request deadline applies before response headers arrive', async () => {
  const api = client(async () => new Promise(() => {}), { requestMs: 10 });
  await assert.rejects(() => api.get('/items'), { code: 'source_timeout' });
});
test('per-response and cumulative bytes are enforced during streaming', async () => {
  const large = () => json({ text: '0123456789' });
  await assert.rejects(
    () => client(large, { responseBytes: 10 }).get('/items'),
    { code: 'source_limit_exceeded' },
  );
  const api = client(large, { totalBytes: 30 });
  await api.get('/items');
  await assert.rejects(() => api.get('/items'), {
    code: 'source_limit_exceeded',
  });
});
test('request timeout covers the complete response stream', async () => {
  let cancelled = false;
  const api = client(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"text":"'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    { requestMs: 15 },
  );
  await assert.rejects(() => api.get('/items'), { code: 'source_timeout' });
  assert.ok(cancelled);
});
test('external cancellation terminates queued and active reads', async () => {
  const controller = new AbortController();
  const budget = createOperationBudget({
    signal: controller.signal,
    limits: { concurrency: 1 },
  });
  const api = createGithubClient({
    accessToken: token,
    budget,
    fetchImpl: async () => new Promise(() => {}),
  });
  const pending = [api.get('/one'), api.get('/two')];
  controller.abort();
  const results = await Promise.allSettled(pending);
  assert.ok(
    results.every(
      (result) =>
        result.status === 'rejected' && result.reason.code === 'source_timeout',
    ),
  );
});
test('request scheduler limits concurrency through response completion', async () => {
  let active = 0;
  let maximum = 0;
  const api = client(
    async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return json({});
    },
    { concurrency: 4 },
  );
  await Promise.all(
    Array.from({ length: 12 }, (_, index) => api.get('/items/' + index)),
  );
  assert.equal(maximum, 4);
});
test('GraphQL accepts read-only queries and rejects partial/error envelopes', async () => {
  const api = client(async () =>
    json({
      data: { repository: null },
      errors: [{ type: 'FORBIDDEN', message: 'private' }],
    }),
  );
  await assert.rejects(() => api.graphql('mutation Delete { delete }', {}), {
    code: 'invalid_request',
  });
  await assert.rejects(() => api.graphql('query Read { repository }', {}), {
    code: 'forbidden',
  });
});
