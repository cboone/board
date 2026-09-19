import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAuth } from '../lib/auth.mjs';
import { BoardError } from '../lib/errors.mjs';
import { createOperationBudget } from '../lib/source-limits.mjs';
import {
  ORIGIN,
  testConfig,
  testCrypto,
  memoryStorage,
  budget,
  tokenResponse,
  deferred,
} from './auth-helpers.mjs';

const ACCOUNT = 'account/99961';
const pairContext = {
  purpose: 'github-token-pair',
  recordKey: ACCOUNT,
  schemaVersion: 1,
  ownerId: 99961,
};
const request = (cookies, options = {}) =>
  new Request(`${ORIGIN}/api/session`, {
    ...options,
    headers: { Cookie: cookies, ...options.headers },
  });
function setup(options = {}) {
  const clock = { value: Date.parse('2026-09-18T12:00:00.000Z') };
  const now = () => clock.value;
  const config = testConfig();
  const storage = options.storage ?? memoryStorage();
  const crypto = testCrypto(config);
  const calls = [];
  const fetchImpl =
    options.fetchImpl ??
    (async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://github.com/login/oauth/access_token')
        return Response.json(tokenResponse());
      if (url === 'https://api.github.com/user')
        return Response.json({ id: 99961, login: 'cboone' });
      throw new Error('Unexpected provider request');
    });
  const auth = createAuth({
    config,
    storage,
    crypto,
    fetchImpl,
    now,
    sleep: options.sleep ?? ((ms) => delay(Math.min(ms, 1))),
  });
  return {
    auth,
    storage,
    config,
    crypto,
    clock,
    now,
    calls,
    budget: () => budget(now),
  };
}
async function transaction(ctx) {
  const result = await ctx.auth.startOAuth(request(''), {
    budget: ctx.budget(),
  });
  const authorize = new URL(result.location);
  const cookies = result.cookies[0].split(';')[0];
  const callback = new Request(
    `${ORIGIN}/api/auth/callback?state=${authorize.searchParams.get('state')}&code=synthetic-code`,
    { headers: { Cookie: cookies } },
  );
  return { result, authorize, cookies, callback };
}
async function login(ctx) {
  const txn = await transaction(ctx);
  const result = await ctx.auth.completeOAuth(txn.callback, {
    budget: ctx.budget(),
  });
  assert.equal(result.location, `${ORIGIN}/`);
  const header = result.cookies.find((value) =>
    value.startsWith('__Host-board_session='),
  );
  return { cookies: header.split(';')[0], header };
}
async function expireAccess(ctx) {
  const stored = await ctx.storage.read(ACCOUNT);
  const pair = ctx.crypto.decrypt(stored.value.tokenEnvelope, pairContext);
  pair.accessExpiresAt = ctx.now() + 1000;
  await ctx.storage.write(
    ACCOUNT,
    {
      ...stored.value,
      accessExpiresAt: pair.accessExpiresAt,
      tokenEnvelope: ctx.crypto.encrypt(pair, pairContext),
    },
    { onlyIfMatch: stored.etag },
  );
}

test('OAuth uses S256, browser binding, encrypted verifier and secure opaque session with stable CSRF', async () => {
  const ctx = setup();
  const txn = await transaction(ctx);
  assert.equal(
    txn.authorize.searchParams.get('redirect_uri'),
    `${ORIGIN}/api/auth/callback`,
  );
  assert.equal(txn.authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(
    txn.result.cookies[0],
    /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
  );
  const pending = [...ctx.storage.records.values()][0].value;
  assert.ok(pending.verifierEnvelope);
  assert.ok(!JSON.stringify(pending).includes('synthetic-secret'));
  const result = await ctx.auth.completeOAuth(txn.callback, {
    budget: ctx.budget(),
  });
  assert.equal(result.location, `${ORIGIN}/`);
  const sessionCookie = result.cookies[1];
  assert.match(
    sessionCookie,
    /^__Host-board_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800$/,
  );
  const sessionRequest = request(sessionCookie.split(';')[0]);
  const first = await ctx.auth.bootstrap(sessionRequest, {
    budget: ctx.budget(),
  });
  ctx.clock.value += 1000;
  const second = await ctx.auth.bootstrap(sessionRequest, {
    budget: ctx.budget(),
  });
  assert.equal(first.csrfToken, second.csrfToken);
  assert.deepEqual(first.user, { id: 99961, login: 'cboone' });
  assert.equal(
    ctx.calls.length,
    2,
    'bootstrap never fetches identity or refreshes',
  );
  const body = new URLSearchParams(ctx.calls[0].init.body);
  assert.equal(ctx.calls[1].init.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(body.get('redirect_uri'), `${ORIGIN}/api/auth/callback`);
  assert.match(body.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(
    !JSON.stringify([...ctx.storage.records.values()]).includes(
      'synthetic-access',
    ),
  );
  const claimed = [...ctx.storage.records.values()].find(
    (stored) => stored.value.state === 'claimed',
  ).value;
  assert.equal(claimed.verifierEnvelope, undefined);
});

test('wrong binding, expired state, duplicate parameters and provider denial cannot exchange a code', async () => {
  for (const variant of ['binding', 'expired', 'duplicate', 'denied']) {
    const ctx = setup();
    const txn = await transaction(ctx);
    let callback = txn.callback;
    if (variant === 'binding')
      callback = new Request(txn.callback.url, {
        headers: { Cookie: '__Host-board_oauth=' + 'A'.repeat(43) },
      });
    if (variant === 'expired') ctx.clock.value += 600000;
    if (variant === 'duplicate')
      callback = new Request(txn.callback.url + '&state=other', {
        headers: { Cookie: txn.cookies },
      });
    if (variant === 'denied')
      callback = new Request(
        txn.callback.url + '&error=provider-private-text',
        { headers: { Cookie: txn.cookies } },
      );
    const result = await ctx.auth.completeOAuth(callback, {
      budget: ctx.budget(),
    });
    assert.equal(
      new URL(result.location).searchParams.get('auth_error'),
      'invalid_request',
    );
    assert.equal(ctx.calls.length, 0);
    assert.ok(result.cookies[0].endsWith('Max-Age=0'));
    assert.ok(!result.location.includes('provider-private-text'));
  }
});

test('concurrent duplicate callbacks atomically exchange at most once', async () => {
  const entered = deferred();
  const response = deferred();
  let exchanges = 0;
  const ctx = setup({
    fetchImpl: async (url) => {
      if (url.endsWith('/access_token')) {
        exchanges++;
        entered.resolve();
        return response.promise;
      }
      return Response.json({ id: 99961, login: 'cboone' });
    },
  });
  const txn = await transaction(ctx);
  const first = ctx.auth.completeOAuth(txn.callback, { budget: ctx.budget() });
  await entered.promise;
  const second = await ctx.auth.completeOAuth(txn.callback, {
    budget: ctx.budget(),
  });
  assert.equal(
    new URL(second.location).searchParams.get('auth_error'),
    'invalid_request',
  );
  response.resolve(Response.json(tokenResponse()));
  assert.equal((await first).location, `${ORIGIN}/`);
  assert.equal(exchanges, 1);
});

test('wrong owner and incomplete token responses never create account credentials or a session', async () => {
  for (const variant of [
    'owner',
    'missing-refresh',
    'negative-expiry',
    'type',
  ]) {
    const ctx = setup({
      fetchImpl: async (url) =>
        url.endsWith('/user')
          ? Response.json({ id: 1, login: 'another-user' })
          : Response.json(
              tokenResponse(
                variant === 'missing-refresh'
                  ? { refresh_token: undefined }
                  : variant === 'negative-expiry'
                    ? { expires_in: -1 }
                    : variant === 'type'
                      ? { token_type: 'other' }
                      : {},
              ),
            ),
    });
    const txn = await transaction(ctx);
    const result = await ctx.auth.completeOAuth(txn.callback, {
      budget: ctx.budget(),
    });
    assert.ok(new URL(result.location).searchParams.has('auth_error'));
    assert.equal(ctx.storage.records.has(ACCOUNT), false);
    assert.equal(
      [...ctx.storage.records.keys()].some((key) => key.startsWith('session/')),
      false,
    );
  }
});

test('OAuth identity rate responses retain primary and secondary rate categories without leaking provider text or retrying the code', async () => {
  for (const variant of ['primary', 'secondary', 'retry-after', 'permission']) {
    let exchanges = 0;
    let identityReads = 0;
    const ctx = setup({
      fetchImpl: async (url) => {
        if (url.endsWith('/access_token')) {
          exchanges++;
          return Response.json(tokenResponse());
        }
        identityReads++;
        const headers =
          variant === 'primary'
            ? {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': '9999999999',
              }
            : variant === 'retry-after'
              ? { 'retry-after': '60' }
              : {};
        return Response.json(
          {
            message:
              variant === 'secondary'
                ? 'A secondary rate limit is active for synthetic-sensitive-provider-detail.'
                : 'Synthetic-sensitive-provider-detail.',
          },
          { status: 403, headers },
        );
      },
    });
    const txn = await transaction(ctx);
    const result = await ctx.auth.completeOAuth(txn.callback, {
      budget: ctx.budget(),
    });
    assert.equal(
      new URL(result.location).searchParams.get('auth_error'),
      variant === 'permission' ? 'forbidden' : 'provider_rate_limited',
    );
    assert.ok(!result.location.includes('sensitive'));
    assert.equal(exchanges, 1);
    assert.equal(identityReads, 1);
    assert.equal(ctx.storage.records.has(ACCOUNT), false);
    assert.equal(
      (await ctx.auth.completeOAuth(txn.callback, { budget: ctx.budget() }))
        .cookies.length,
      1,
    );
    assert.equal(
      exchanges,
      1,
      'a callback error cannot replay the claimed authorization code',
    );
  }
});

test('transport ambiguity during OAuth is terminal and cannot replay its claimed code', async () => {
  let calls = 0;
  const ctx = setup({
    fetchImpl: async () => {
      calls++;
      throw new Error('provider-sensitive-details');
    },
  });
  const txn = await transaction(ctx);
  const first = await ctx.auth.completeOAuth(txn.callback, {
    budget: ctx.budget(),
  });
  const second = await ctx.auth.completeOAuth(txn.callback, {
    budget: ctx.budget(),
  });
  assert.equal(
    new URL(first.location).searchParams.get('auth_error'),
    'provider_unavailable',
  );
  assert.equal(
    new URL(second.location).searchParams.get('auth_error'),
    'invalid_request',
  );
  assert.equal(calls, 1);
});

test('idle and absolute expiration, revocation and fixation reject owner sessions', async () => {
  for (const variant of ['idle', 'absolute', 'logout', 'fixation']) {
    const ctx = setup();
    const signed = await login(ctx);
    const original = request(signed.cookies);
    if (variant === 'idle') ctx.clock.value += 8 * 60 * 60 * 1000;
    if (variant === 'absolute') {
      for (let i = 0; i < 21; i++) {
        ctx.clock.value += 7 * 60 * 60 * 1000;
        await ctx.auth.requireAuthorizedOwner(original, {
          budget: ctx.budget(),
        });
      }
      ctx.clock.value += 21 * 60 * 60 * 1000;
    }
    if (variant === 'logout')
      await ctx.auth.logout({
        session: await ctx.auth.requireAuthorizedOwner(original),
        budget: ctx.budget(),
      });
    const current =
      variant === 'fixation'
        ? request('__Host-board_session=' + 'A'.repeat(43))
        : original;
    await assert.rejects(
      ctx.auth.requireAuthorizedOwner(current, { budget: ctx.budget() }),
      { code: 'session_required' },
    );
    assert.deepEqual(
      await ctx.auth.bootstrap(current, { budget: ctx.budget() }),
      { auth: false },
    );
  }
});

test('CSRF requires both the exact canonical Origin and stable session-bound header', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
  );
  ctx.auth.requireCsrf(
    request(signed.cookies, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'X-CSRF-Token': session.csrfToken },
    }),
    session,
  );
  for (const headers of [
    { Origin: 'https://other.example', 'X-CSRF-Token': session.csrfToken },
    { Origin: ORIGIN, 'X-CSRF-Token': 'wrong' },
    { Origin: ORIGIN, 'X-CSRF-Token': 'é'.repeat(43) },
    { 'X-CSRF-Token': session.csrfToken },
  ])
    assert.throws(
      () =>
        ctx.auth.requireCsrf(
          request(signed.cookies, { method: 'POST', headers }),
          session,
        ),
      { code: 'forbidden' },
    );
});

test('two sessions share one refresh and waiters receive only the durably published complete pair', async () => {
  const gate = deferred();
  const entered = deferred();
  let refreshes = 0;
  const ctx = setup({
    fetchImpl: async (url, init) => {
      if (url.endsWith('/user'))
        return Response.json({ id: 99961, login: 'cboone' });
      if (
        new URLSearchParams(init.body).get('grant_type') === 'refresh_token'
      ) {
        refreshes++;
        entered.resolve();
        return gate.promise;
      }
      return Response.json(tokenResponse());
    },
  });
  const first = await login(ctx);
  const second = await login(ctx);
  await expireAccess(ctx);
  const a = await ctx.auth.requireAuthorizedOwner(request(first.cookies));
  const b = await ctx.auth.requireAuthorizedOwner(request(second.cookies));
  const refreshBudget = ctx.budget();
  const p1 = ctx.auth.acquireToken({ session: a, budget: refreshBudget });
  await entered.promise;
  const claim = (await ctx.storage.read(ACCOUNT)).value;
  assert.equal(claim.state, 'refreshing');
  assert.equal(claim.tokenEnvelope, undefined);
  const p2 = ctx.auth.acquireToken({ session: b, budget: ctx.budget() });
  gate.resolve(
    Response.json(
      tokenResponse({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
      }),
    ),
  );
  const leases = await Promise.all([p1, p2]);
  assert.deepEqual(leases, [
    { ownerId: 99961, accessToken: 'rotated-access', generation: 3 },
    { ownerId: 99961, accessToken: 'rotated-access', generation: 3 },
  ]);
  assert.equal(refreshes, 1);
  assert.equal(refreshBudget.requests, 1);
  assert.ok(refreshBudget.bytes > 0);
  const active = (await ctx.storage.read(ACCOUNT)).value;
  assert.equal(
    ctx.crypto.decrypt(active.tokenEnvelope, pairContext).refreshToken,
    'rotated-refresh',
  );
});

test('uncertain refresh never retries old tokens and preserves authenticated historical reads', async () => {
  let refreshes = 0;
  const ctx = setup({
    fetchImpl: async (url, init) => {
      if (url.endsWith('/user'))
        return Response.json({ id: 99961, login: 'cboone' });
      if (new URLSearchParams(init.body).get('grant_type')) {
        refreshes++;
        throw new Error('Ambiguous provider response');
      }
      return Response.json(tokenResponse());
    },
  });
  const signed = await login(ctx);
  await expireAccess(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
  );
  await assert.rejects(
    ctx.auth.acquireToken({ session, budget: ctx.budget() }),
    { code: 'source_authorization_required' },
  );
  await assert.rejects(
    ctx.auth.acquireToken({ session, budget: ctx.budget() }),
    { code: 'source_authorization_required' },
  );
  assert.equal(refreshes, 1);
  const bootstrap = await ctx.auth.bootstrap(request(signed.cookies), {
    budget: ctx.budget(),
  });
  assert.equal(bootstrap.auth, true);
  assert.equal(bootstrap.sourceAuthorization, 'reauthorization-required');
  assert.equal((await ctx.auth.recheckOwner({ session })).id, 99961);
});

test('storage failure after provider rotation never replays the pair or reports a partial success', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  await expireAccess(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
  );
  const write = ctx.storage.write.bind(ctx.storage);
  let failures = 0;
  ctx.storage.write = async (key, value, condition) => {
    if (key === ACCOUNT && value.state === 'active' && value.generation === 2) {
      failures++;
      throw new BoardError('service_unavailable');
    }
    return write(key, value, condition);
  };
  await assert.rejects(
    ctx.auth.acquireToken({ session, budget: ctx.budget() }),
    { code: 'source_authorization_required' },
  );
  assert.equal(failures, 1);
  assert.equal(
    (await ctx.storage.read(ACCOUNT)).value.state,
    'reauthorization-required',
  );
  assert.equal((await ctx.auth.bootstrap(request(signed.cookies))).auth, true);
});

test('expired refresh claims require new authorization without any provider replay', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
  );
  const stored = await ctx.storage.read(ACCOUNT);
  const { tokenEnvelope, ...rest } = stored.value;
  void tokenEnvelope;
  await ctx.storage.write(
    ACCOUNT,
    {
      ...rest,
      state: 'refreshing',
      claim: {
        attemptId: Buffer.alloc(32, 4).toString('base64url'),
        generation: 1,
        startedAt: ctx.now() - 1000,
        deadlineAt: ctx.now() - 1,
      },
    },
    { onlyIfMatch: stored.etag },
  );
  await assert.rejects(
    ctx.auth.acquireToken({ session, budget: ctx.budget() }),
    { code: 'source_authorization_required' },
  );
  assert.equal(ctx.calls.length, 2);
  assert.equal(
    (await ctx.storage.read(ACCOUNT)).value.tokenEnvelope,
    undefined,
  );
});

test('late refresh publication and late token rejection cannot replace a newer OAuth login', async () => {
  const gate = deferred();
  const entered = deferred();
  let logins = 0;
  const ctx = setup({
    fetchImpl: async (url, init) => {
      if (url.endsWith('/user'))
        return Response.json({ id: 99961, login: 'cboone' });
      if (new URLSearchParams(init.body).get('grant_type')) {
        entered.resolve();
        return gate.promise;
      }
      logins++;
      return Response.json(
        tokenResponse({ access_token: `login-access-${logins}` }),
      );
    },
  });
  const signed = await login(ctx);
  await expireAccess(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
  );
  const pending = ctx.auth.acquireToken({ session, budget: ctx.budget() });
  await entered.promise;
  await login(ctx);
  gate.resolve(
    Response.json(tokenResponse({ access_token: 'superseded-refresh-access' })),
  );
  const lease = await pending;
  assert.equal(lease.accessToken, 'login-access-2');
  assert.equal(
    await ctx.auth.noteTokenRejected({
      lease: { ownerId: 99961, accessToken: 'old-access', generation: 1 },
      budget: ctx.budget(),
    }),
    false,
  );
  assert.equal((await ctx.storage.read(ACCOUNT)).value.state, 'active');
});

test('known account authorization revocation invalidates every session while installation loss preserves them', async () => {
  const ctx = setup();
  const a = await login(ctx);
  const b = await login(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(request(a.cookies));
  const lease = await ctx.auth.acquireToken({ session, budget: ctx.budget() });
  await ctx.auth.recordSourceAuthorization({
    lease,
    sourceAuthorization: 'installation-required',
    budget: ctx.budget(),
  });
  assert.equal((await ctx.auth.bootstrap(request(a.cookies))).auth, true);
  assert.equal(
    (await ctx.auth.bootstrap(request(b.cookies))).sourceAuthorization,
    'installation-required',
  );
  assert.equal(
    await ctx.auth.revokeAuthorization({
      ownerId: 99961,
      expectedGeneration: 2,
      budget: ctx.budget(),
    }),
    true,
  );
  for (const signed of [a, b])
    await assert.rejects(
      ctx.auth.requireAuthorizedOwner(request(signed.cookies)),
      { code: 'session_required' },
    );
});

test('logout racing an idle touch cannot restore its revoked session', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
  );
  ctx.clock.value += 1000;
  const entered = deferred();
  const gate = deferred();
  const write = ctx.storage.write.bind(ctx.storage);
  let paused = false;
  ctx.storage.write = async (key, value, condition) => {
    if (
      key.startsWith('session/') &&
      value.revokedAt === undefined &&
      !paused
    ) {
      paused = true;
      entered.resolve();
      await gate.promise;
    }
    return write(key, value, condition);
  };
  const touch = ctx.auth.requireAuthorizedOwner(request(signed.cookies));
  await entered.promise;
  const out = await ctx.auth.logout({ session });
  assert.ok(out.cookies[0].endsWith('Max-Age=0'));
  gate.resolve();
  await assert.rejects(touch, { code: 'session_required' });
  await assert.rejects(ctx.auth.recheckOwner({ session }), {
    code: 'session_required',
  });
});

test('maintenance removes only bounded coordination records with immutable expiration', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  ctx.clock.value += 8 * 60 * 60 * 1000;
  await ctx.auth.cleanup({ budget: ctx.budget(), limit: 1 });
  assert.equal(
    [...ctx.storage.records.keys()].some((key) => key.startsWith('oauth/')),
    false,
  );
  assert.equal(
    [...ctx.storage.records.keys()].some((key) => key.startsWith('session/')),
    true,
    'idle expiry alone must not race an unconditional delete',
  );
  assert.equal(ctx.storage.records.has(ACCOUNT), true);
  ctx.clock.value += 7 * 24 * 60 * 60 * 1000;
  await ctx.auth.cleanup({ budget: ctx.budget(), limit: 1 });
  assert.equal(
    [...ctx.storage.records.keys()].some((key) => key.startsWith('session/')),
    false,
  );
  assert.equal(ctx.storage.records.has(ACCOUNT), true);
  assert.ok(signed.cookies);
});

test('provider timeout covers a stalled response body and malformed source never leaks text', async () => {
  const ctx = setup({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
        }),
      ),
  });
  const txn = await transaction(ctx);
  const operation = createOperationBudget({
    now: Date.now,
    limits: { requestMs: 10, operationMs: 1000 },
  });
  const keepAlive = delay(50);
  const result = await ctx.auth.completeOAuth(txn.callback, {
    budget: operation,
  });
  assert.equal(
    new URL(result.location).searchParams.get('auth_error'),
    'source_timeout',
  );
  await keepAlive;
});

test('storage coordination is bounded by the same operation deadline', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  ctx.storage.read = async () => new Promise(() => {});
  const operation = createOperationBudget({ limits: { operationMs: 10 } });
  const keepAlive = delay(50);
  await assert.rejects(
    ctx.auth.requireAuthorizedOwner(request(signed.cookies), {
      budget: operation,
    }),
    { code: 'source_timeout' },
  );
  await keepAlive;
});

test('historical owner authorization is independent of source eligibility and rejects unsigned or other-owner requests', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  const saved = {
    ownerId: 99961,
    repositoryId: 17,
    content: 'synthetic-private-historical-report',
  };
  const readHistorical = async (incoming) => {
    const session = await ctx.auth.requireAuthorizedOwner(incoming);
    if (saved.ownerId !== session.ownerId || saved.repositoryId !== 17)
      throw new BoardError('forbidden');
    await ctx.auth.recheckOwner({ session });
    return saved.content;
  };
  assert.equal(await readHistorical(request(signed.cookies)), saved.content);
  await assert.rejects(readHistorical(request('')), {
    code: 'session_required',
  });
  const sessionKey = [...ctx.storage.records.keys()].find((key) =>
    key.startsWith('session/'),
  );
  const stored = await ctx.storage.read(sessionKey);
  await ctx.storage.write(
    sessionKey,
    { ...stored.value, ownerId: 1 },
    { onlyIfMatch: stored.etag },
  );
  await assert.rejects(readHistorical(request(signed.cookies)), {
    code: 'session_required',
  });
  assert.equal(
    ctx.calls.length,
    2,
    'historical reads never refresh or ask GitHub for eligibility',
  );
});

test('an older OAuth exchange cannot overwrite a subsequently published login', async () => {
  const entered = deferred();
  const gate = deferred();
  let exchanges = 0;
  const ctx = setup({
    fetchImpl: async (url) => {
      if (url.endsWith('/user'))
        return Response.json({ id: 99961, login: 'cboone' });
      exchanges++;
      if (exchanges === 1) {
        entered.resolve();
        return gate.promise;
      }
      return Response.json(
        tokenResponse({ access_token: 'subsequent-login-access' }),
      );
    },
  });
  const earlier = await transaction(ctx);
  const pending = ctx.auth.completeOAuth(earlier.callback, {
    budget: ctx.budget(),
  });
  await entered.promise;
  const latest = await login(ctx);
  gate.resolve(
    Response.json(tokenResponse({ access_token: 'older-login-access' })),
  );
  assert.equal(
    new URL((await pending).location).searchParams.get('auth_error'),
    'source_authorization_required',
  );
  const session = await ctx.auth.requireAuthorizedOwner(
    request(latest.cookies),
  );
  assert.equal(
    (await ctx.auth.acquireToken({ session, budget: ctx.budget() }))
      .accessToken,
    'subsequent-login-access',
  );
  assert.equal(
    [...ctx.storage.records.keys()].filter((key) => key.startsWith('session/'))
      .length,
    1,
  );
});

test('fresh valid tokens do not refresh and provider lifetimes remain response-derived', async () => {
  const ctx = setup({
    fetchImpl: async (url) =>
      url.endsWith('/user')
        ? Response.json({ id: 99961, login: 'cboone' })
        : Response.json(
            tokenResponse({ expires_in: 1200, refresh_token_expires_in: 3600 }),
          ),
  });
  const signed = await login(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
  );
  const record = (await ctx.storage.read(ACCOUNT)).value;
  assert.equal(record.accessExpiresAt, ctx.now() + 1200000);
  assert.equal(record.refreshExpiresAt, ctx.now() + 3600000);
  const operation = ctx.budget();
  assert.equal(
    (await ctx.auth.acquireToken({ session, budget: operation })).accessToken,
    'synthetic-access',
  );
  assert.equal(operation.requests, 0);
});

test('a first publication committing after the refresh deadline remains unusable and cannot replay old tokens', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  await expireAccess(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
  );
  const gate = deferred();
  const entered = deferred();
  const committed = deferred();
  const write = ctx.storage.write.bind(ctx.storage);
  ctx.storage.write = async (key, value, condition) => {
    if (
      key === ACCOUNT &&
      value.state === 'active' &&
      value.generation === 2 &&
      value.publicationClaim
    ) {
      entered.resolve();
      await gate.promise;
      const result = await write(key, value, condition);
      committed.resolve();
      return result;
    }
    return write(key, value, condition);
  };
  const controller = new AbortController();
  const operation = createOperationBudget({
    now: ctx.now,
    signal: controller.signal,
  });
  const pending = ctx.auth.acquireToken({ session, budget: operation });
  await entered.promise;
  ctx.clock.value += 45000;
  controller.abort();
  await assert.rejects(pending, { code: 'source_authorization_required' });
  gate.resolve();
  await committed.promise;
  assert.ok((await ctx.storage.read(ACCOUNT)).value.publicationClaim);
  await assert.rejects(
    ctx.auth.acquireToken({ session, budget: ctx.budget() }),
    { code: 'source_authorization_required' },
  );
  const record = (await ctx.storage.read(ACCOUNT)).value;
  assert.equal(record.state, 'reauthorization-required');
  assert.equal(record.tokenEnvelope, undefined);
  assert.equal(record.publicationClaim, undefined);
  assert.equal(
    ctx.calls.length,
    3,
    'one code exchange, one identity read, one refresh',
  );
  assert.equal((await ctx.auth.bootstrap(request(signed.cookies))).auth, true);
});

test('an unconfirmed published pair is withheld until its claimant confirms storage acknowledgement', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  await expireAccess(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
  );
  const gate = deferred();
  const entered = deferred();
  const write = ctx.storage.write.bind(ctx.storage);
  ctx.storage.write = async (key, value, condition) => {
    if (
      key === ACCOUNT &&
      value.state === 'active' &&
      value.generation === 2 &&
      value.publicationAcknowledgedAt !== undefined
    ) {
      entered.resolve();
      await gate.promise;
    }
    return write(key, value, condition);
  };
  const first = ctx.auth.acquireToken({ session, budget: ctx.budget() });
  await entered.promise;
  assert.ok((await ctx.storage.read(ACCOUNT)).value.publicationClaim);
  let returned = false;
  const waiter = ctx.auth
    .acquireToken({ session, budget: ctx.budget() })
    .then((lease) => {
      returned = true;
      return lease;
    });
  await delay(5);
  assert.equal(returned, false);
  gate.resolve();
  const [a, b] = await Promise.all([first, waiter]);
  assert.equal(a.generation, 2);
  assert.deepEqual(b, a);
  const confirmed = (await ctx.storage.read(ACCOUNT)).value;
  assert.ok(confirmed.publicationClaim);
  assert.equal(confirmed.publicationAcknowledgedAt, ctx.now());
});

test('logout after refresh acknowledgement rejects only the revoked session', async () => {
  const ctx = setup();
  const first = await login(ctx);
  const second = await login(ctx);
  await expireAccess(ctx);
  const firstSession = await ctx.auth.requireAuthorizedOwner(
    request(first.cookies),
  );
  const secondSession = await ctx.auth.requireAuthorizedOwner(
    request(second.cookies),
  );
  const write = ctx.storage.write.bind(ctx.storage);
  let loggedOut = false;
  ctx.storage.write = async (key, value, condition) => {
    if (
      key === ACCOUNT &&
      value.state === 'active' &&
      value.generation === 3 &&
      value.publicationAcknowledgedAt !== undefined
    ) {
      const result = await write(key, value, condition);
      if (result.modified && !loggedOut) {
        loggedOut = true;
        await ctx.auth.logout({ session: firstSession, budget: ctx.budget() });
      }
      return result;
    }
    return write(key, value, condition);
  };

  await assert.rejects(
    ctx.auth.acquireToken({ session: firstSession, budget: ctx.budget() }),
    { code: 'session_required' },
  );
  const confirmed = (await ctx.storage.read(ACCOUNT)).value;
  assert.equal(confirmed.state, 'active');
  assert.equal(confirmed.generation, 3);
  assert.ok(confirmed.tokenEnvelope);
  assert.ok(confirmed.publicationClaim);
  assert.equal(confirmed.publicationAcknowledgedAt, ctx.now());
  assert.equal(
    (
      await ctx.auth.acquireToken({
        session: secondSession,
        budget: ctx.budget(),
      })
    ).generation,
    3,
  );
  assert.equal(
    ctx.calls.length,
    5,
    'the surviving session reuses the acknowledged pair without another refresh',
  );
});

test('late acknowledgement publication retains timely durable-pair evidence and cannot cross newer CAS fences', async () => {
  for (const fence of ['none', 'reauthorization', 'oauth', 'revocation']) {
    const ctx = setup();
    const signed = await login(ctx);
    await expireAccess(ctx);
    const session = await ctx.auth.requireAuthorizedOwner(
      request(signed.cookies),
    );
    const gate = deferred();
    const entered = deferred();
    const committed = deferred();
    const write = ctx.storage.write.bind(ctx.storage);
    let acknowledgement;
    ctx.storage.write = async (key, value, condition) => {
      if (
        key === ACCOUNT &&
        value.state === 'active' &&
        value.generation === 2 &&
        value.publicationAcknowledgedAt !== undefined
      ) {
        acknowledgement = value;
        entered.resolve();
        await gate.promise;
        const result = await write(key, value, condition);
        committed.resolve(result);
        return result;
      }
      return write(key, value, condition);
    };
    const controller = new AbortController();
    const operation = createOperationBudget({
      now: ctx.now,
      signal: controller.signal,
    });
    const pending = ctx.auth.acquireToken({ session, budget: operation });
    await entered.promise;
    assert.ok(
      acknowledgement.publicationAcknowledgedAt <
        acknowledgement.publicationClaim.deadlineAt,
    );
    ctx.clock.value += 45000;
    controller.abort();
    await assert.rejects(pending, { code: 'source_authorization_required' });
    assert.equal(
      (await ctx.auth.bootstrap(request(signed.cookies))).auth,
      true,
    );
    if (fence === 'reauthorization')
      await assert.rejects(
        ctx.auth.acquireToken({ session, budget: ctx.budget() }),
        { code: 'source_authorization_required' },
      );
    if (fence === 'oauth') await login(ctx);
    if (fence === 'revocation')
      await ctx.auth.revokeAuthorization({
        ownerId: 99961,
        expectedGeneration: 2,
        budget: ctx.budget(),
      });
    gate.resolve();
    const committedResult = await committed.promise;
    assert.equal(committedResult.modified, fence === 'none');
    const current = (await ctx.storage.read(ACCOUNT)).value;
    if (fence === 'none') {
      assert.ok(
        current.publicationClaim,
        'the late acknowledgement cannot remove the original claim evidence',
      );
      assert.equal(
        current.publicationAcknowledgedAt,
        acknowledgement.publicationAcknowledgedAt,
      );
      assert.equal(
        (await ctx.auth.acquireToken({ session, budget: ctx.budget() }))
          .generation,
        2,
      );
    }
    if (fence === 'reauthorization') {
      assert.equal(current.state, 'reauthorization-required');
      assert.equal(current.tokenEnvelope, undefined);
    }
    if (fence === 'oauth')
      assert.equal(
        (await ctx.auth.acquireToken({ session, budget: ctx.budget() }))
          .generation,
        3,
      );
    if (fence === 'revocation')
      await assert.rejects(
        ctx.auth.requireAuthorizedOwner(request(signed.cookies)),
        { code: 'session_required' },
      );
    assert.equal(
      ctx.calls.length,
      fence === 'oauth' ? 5 : 3,
      'no late confirmation replays a provider refresh',
    );
  }
});

test('job token authority survives browser sign-out but remains bound to the admitted epoch', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
    {
      budget: ctx.budget(),
    },
  );
  const lease = await ctx.auth.acquireJobToken({
    ownerId: 99961,
    authorizationEpoch: session.authorizationEpoch,
    budget: ctx.budget(),
  });
  assert.equal(lease.accessToken, 'synthetic-access');
  assert.equal(lease.generation, 1);

  await ctx.auth.logout({ session, budget: ctx.budget() });
  assert.deepEqual(
    await ctx.auth.recheckJobAuthorization({
      ownerId: 99961,
      authorizationEpoch: session.authorizationEpoch,
      generation: lease.generation,
      budget: ctx.budget(),
    }),
    { id: 99961, login: 'cboone' },
  );
  assert.equal(
    (
      await ctx.auth.acquireJobToken({
        ownerId: 99961,
        authorizationEpoch: session.authorizationEpoch,
        budget: ctx.budget(),
      })
    ).generation,
    1,
  );
});

test('job token authority refreshes through the shared protocol and fences stale generations', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
    {
      budget: ctx.budget(),
    },
  );
  await expireAccess(ctx);

  const lease = await ctx.auth.acquireJobToken({
    ownerId: 99961,
    authorizationEpoch: session.authorizationEpoch,
    budget: ctx.budget(),
  });
  assert.equal(lease.generation, 2);
  assert.equal(lease.accessToken, 'synthetic-access');
  assert.equal(ctx.calls.length, 3);
  await assert.rejects(
    ctx.auth.recheckJobAuthorization({
      ownerId: 99961,
      authorizationEpoch: session.authorizationEpoch,
      generation: 1,
      budget: ctx.budget(),
    }),
    { code: 'provider_unavailable' },
  );
  await ctx.auth.recheckJobAuthorization({
    ownerId: 99961,
    authorizationEpoch: session.authorizationEpoch,
    generation: 2,
    budget: ctx.budget(),
  });
});

test('GitHub authorization revocation fences an admitted job without using a browser session', async () => {
  const ctx = setup();
  const signed = await login(ctx);
  const session = await ctx.auth.requireAuthorizedOwner(
    request(signed.cookies),
    {
      budget: ctx.budget(),
    },
  );
  await ctx.auth.revokeAuthorization({
    ownerId: 99961,
    expectedGeneration: 1,
    budget: ctx.budget(),
  });
  await assert.rejects(
    ctx.auth.acquireJobToken({
      ownerId: 99961,
      authorizationEpoch: session.authorizationEpoch,
      budget: ctx.budget(),
    }),
    { code: 'source_authorization_required' },
  );
  await assert.rejects(
    ctx.auth.recheckJobAuthorization({
      ownerId: 99961,
      authorizationEpoch: session.authorizationEpoch,
      generation: 1,
      budget: ctx.budget(),
    }),
    { code: 'source_authorization_required' },
  );
});
