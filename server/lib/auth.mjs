import {
  createHash,
  timingSafeEqual,
  randomBytes as nativeRandomBytes,
} from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BoardError, normalizeError } from './errors.mjs';

const ACCOUNT_KEY = 'account/99961';
const SESSION_COOKIE = '__Host-board_session';
const OAUTH_COOKIE = '__Host-board_oauth';
const OAUTH_MS = 10 * 60 * 1000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const IDLE_MS = 8 * 60 * 60 * 1000;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const CAS_ATTEMPTS = 8;
const SOURCE_STATES = [
  'ready',
  'reauthorization-required',
  'installation-required',
  'unverified',
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 8192) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\r\n\0]/.test(value);
const opaque = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').length === 32 &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
const same = (left, right) => {
  if (
    typeof left !== 'string' ||
    typeof right !== 'string' ||
    left.length > 256 ||
    right.length > 256
  )
    return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const context = (purpose, recordKey) => ({
  purpose,
  recordKey,
  schemaVersion: 1,
  ownerId: 99961,
});

function cookie(request, name) {
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
function cookieHeader(name, value, maxAge) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
const clearCookie = (name) => cookieHeader(name, '', 0);
const csrfToken = (sessionToken) =>
  createHash('sha256')
    .update(`board-csrf-v1:${sessionToken}`)
    .digest('base64url');

function validSession(record, at, expectedEpoch, expectedCsrf) {
  return (
    record?.schemaVersion === 1 &&
    record.ownerId === 99961 &&
    integer(record.issuedAt) &&
    integer(record.lastSeenAt) &&
    integer(record.absoluteExpiresAt) &&
    record.issuedAt <= record.lastSeenAt &&
    record.lastSeenAt <= at &&
    record.absoluteExpiresAt === record.issuedAt + ABSOLUTE_MS &&
    record.revokedAt === undefined &&
    record.absoluteExpiresAt > at &&
    record.lastSeenAt + IDLE_MS > at &&
    integer(record.authorizationEpoch) &&
    record.authorizationEpoch > 0 &&
    (expectedEpoch === undefined ||
      record.authorizationEpoch === expectedEpoch) &&
    same(record.csrfVerifier, expectedCsrf)
  );
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new BoardError('source_timeout'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new BoardError('source_timeout'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

function validateAccount(record) {
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.ownerId !== 99961 ||
    !integer(record.generation) ||
    record.generation < 1 ||
    !integer(record.authorizationEpoch) ||
    record.authorizationEpoch < 1 ||
    record.user?.id !== 99961 ||
    !text(record.user.login, 128) ||
    !SOURCE_STATES.includes(record.sourceAuthorization) ||
    !['active', 'refreshing', 'reauthorization-required'].includes(record.state)
  )
    throw new BoardError('service_unavailable');
  if (
    record.state === 'active' &&
    (!record.tokenEnvelope ||
      !integer(record.accessExpiresAt) ||
      !integer(record.refreshExpiresAt))
  )
    throw new BoardError('service_unavailable');
  if (
    record.publicationClaim !== undefined &&
    (record.state !== 'active' ||
      !opaque(record.publicationClaim?.attemptId) ||
      record.publicationClaim.generation !== record.generation - 1 ||
      !integer(record.publicationClaim.startedAt) ||
      !integer(record.publicationClaim.deadlineAt) ||
      record.publicationClaim.deadlineAt <= record.publicationClaim.startedAt)
  )
    throw new BoardError('service_unavailable');
  if (
    record.publicationAcknowledgedAt !== undefined &&
    (!record.publicationClaim ||
      !integer(record.publicationAcknowledgedAt) ||
      record.publicationAcknowledgedAt < record.publicationClaim.startedAt ||
      record.publicationAcknowledgedAt >= record.publicationClaim.deadlineAt)
  )
    throw new BoardError('service_unavailable');
  if (
    record.state === 'refreshing' &&
    (!opaque(record.claim?.attemptId) ||
      record.claim?.generation !== record.generation ||
      !integer(record.claim?.startedAt) ||
      !integer(record.claim?.deadlineAt) ||
      record.claim.deadlineAt <= record.claim.startedAt ||
      record.tokenEnvelope !== undefined)
  )
    throw new BoardError('service_unavailable');
  if (
    record.state === 'reauthorization-required' &&
    record.tokenEnvelope !== undefined
  )
    throw new BoardError('service_unavailable');
  return record;
}

function validatePair(pair, generation) {
  if (
    !pair ||
    !text(pair.accessToken) ||
    !text(pair.refreshToken) ||
    pair.tokenType !== 'bearer' ||
    pair.generation !== generation ||
    !integer(pair.accessExpiresAt) ||
    !integer(pair.refreshExpiresAt) ||
    typeof pair.scope !== 'string' ||
    pair.scope.length > 4096
  )
    throw new BoardError('service_unavailable');
  return pair;
}

function tokenPair(response, generation, at) {
  const seconds = (value) =>
    Number.isSafeInteger(value) &&
    value > 0 &&
    Number.isSafeInteger(at + value * 1000);
  if (
    !response ||
    !text(response.access_token) ||
    !text(response.refresh_token) ||
    typeof response.token_type !== 'string' ||
    response.token_type.toLowerCase() !== 'bearer' ||
    !seconds(response.expires_in) ||
    !seconds(response.refresh_token_expires_in) ||
    (response.scope !== undefined &&
      (typeof response.scope !== 'string' || response.scope.length > 4096))
  )
    throw new BoardError('source_authorization_required');
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    tokenType: 'bearer',
    generation,
    accessExpiresAt: at + response.expires_in * 1000,
    refreshExpiresAt: at + response.refresh_token_expires_in * 1000,
    scope: response.scope ?? '',
  };
}

export function createAuth({
  config,
  storage,
  crypto,
  fetchImpl = fetch,
  now = Date.now,
  randomBytes = nativeRandomBytes,
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
}) {
  const random = () => {
    const bytes = randomBytes(32);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32)
      throw new BoardError('service_unavailable');
    return bytes.toString('base64url');
  };
  const assert = (budget) => budget?.assertActive();
  const storageOperation = async (action, budget) => {
    assert(budget);
    const pending = action();
    let result;
    if (budget) {
      const timeout = AbortSignal.timeout(Math.max(1, budget.remainingMs()));
      const signal = budget.signal
        ? AbortSignal.any([budget.signal, timeout])
        : timeout;
      result = await abortable(pending, signal);
    } else {
      result = await pending;
    }
    assert(budget);
    return result;
  };
  const read = async (key, budget) => {
    return storageOperation(() => storage.read(key, { budget }), budget);
  };
  const write = async (key, value, condition, budget) => {
    return storageOperation(
      () => storage.write(key, value, condition, { budget }),
      budget,
    );
  };
  const accountRead = async (budget) => {
    const result = await read(ACCOUNT_KEY, budget);
    if (result) validateAccount(result.value);
    return result;
  };

  async function providerJson(url, init, budget) {
    assert(budget);
    budget.takeRequest();
    const timeout = Math.max(
      1,
      Math.min(budget.limits.requestMs, budget.remainingMs()),
    );
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = budget.signal
      ? AbortSignal.any([budget.signal, timeoutSignal])
      : timeoutSignal;
    try {
      const response = await abortable(
        fetchImpl(url, { ...init, redirect: 'error', signal }),
        signal,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new BoardError('provider_unavailable');
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const next = await abortable(reader.read(), signal);
          assert(budget);
          if (signal.aborted) throw new BoardError('source_timeout');
          if (next.done) break;
          bytes += next.value.byteLength;
          budget.takeBytes(next.value.byteLength);
          if (bytes > budget.limits.responseBytes)
            throw new BoardError('source_limit_exceeded');
          chunks.push(Buffer.from(next.value));
        }
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      }
      if (!response.ok) {
        let secondaryRateLimit = false;
        if (response.status === 403) {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            secondaryRateLimit =
              typeof body?.message === 'string' &&
              /(?:secondary rate limit|api rate limit exceeded)/iu.test(
                body.message,
              );
          } catch {
            /* Provider text is never serialized. */
          }
        }
        if (
          response.status === 429 ||
          (response.status === 403 &&
            (secondaryRateLimit ||
              response.headers.get('x-ratelimit-remaining') === '0' ||
              response.headers.has('retry-after')))
        )
          throw new BoardError('provider_rate_limited');
        if (response.status === 401 || response.status === 400)
          throw new BoardError('source_authorization_required');
        if (response.status === 403) throw new BoardError('forbidden');
        throw new BoardError('provider_unavailable');
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new BoardError('provider_unavailable');
      }
      if (value?.error) throw new BoardError('source_authorization_required');
      return value;
    } catch (error) {
      if (signal.aborted) throw new BoardError('source_timeout');
      if (error instanceof BoardError) throw error;
      throw new BoardError('provider_unavailable');
    }
  }

  async function exchange(parameters, budget) {
    return providerJson(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          ...parameters,
        }).toString(),
      },
      budget,
    );
  }

  async function requireAuthorizedOwner(
    request,
    { budget, touch = true } = {},
  ) {
    const token = cookie(request, SESSION_COOKIE);
    if (!opaque(token)) throw new BoardError('session_required');
    const key = `session/${hash(token)}`;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const stored = await read(key, budget);
      const record = stored?.value;
      const at = now();
      if (!validSession(record, at, undefined, hash(csrfToken(token))))
        throw new BoardError('session_required');
      const account = await accountRead(budget);
      if (
        !account ||
        account.value.authorizationEpoch !== record.authorizationEpoch
      )
        throw new BoardError('session_required');
      const session = {
        key,
        ownerId: config.ownerId,
        authorizationEpoch: record.authorizationEpoch,
        csrfToken: csrfToken(token),
        user: { id: account.value.user.id, login: account.value.user.login },
      };
      if (!touch || record.lastSeenAt === at) return session;
      const updated = await write(
        key,
        { ...record, lastSeenAt: at },
        { onlyIfMatch: stored.etag },
        budget,
      );
      if (updated.modified) return session;
    }
    throw new BoardError('service_unavailable');
  }

  async function recheckOwner({ session, lease, budget }) {
    const record = (await read(session.key, budget))?.value;
    const account = await accountRead(budget);
    const at = now();
    if (
      !validSession(
        record,
        at,
        session.authorizationEpoch,
        hash(session.csrfToken),
      ) ||
      !account ||
      account.value.authorizationEpoch !== session.authorizationEpoch
    )
      throw new BoardError('session_required');
    if (
      lease &&
      (lease.ownerId !== config.ownerId ||
        !integer(lease.generation) ||
        account.value.generation !== lease.generation ||
        account.value.state !== 'active')
    )
      throw new BoardError('provider_unavailable');
    return { id: account.value.user.id, login: account.value.user.login };
  }

  function requireCsrf(request, session) {
    if (
      request.headers.get('origin') !== config.origin ||
      !same(request.headers.get('X-CSRF-Token'), session.csrfToken)
    )
      throw new BoardError('forbidden');
  }

  async function bootstrap(request, { budget } = {}) {
    let session;
    try {
      session = await requireAuthorizedOwner(request, { budget });
    } catch (error) {
      if (error instanceof BoardError && error.code === 'session_required')
        return { auth: false };
      throw error;
    }
    const account = await accountRead(budget);
    await recheckOwner({ session, budget });
    return {
      auth: true,
      user: session.user,
      csrfToken: session.csrfToken,
      sourceAuthorization: account.value.sourceAuthorization,
    };
  }

  async function cleanup({ budget, limit = 20 } = {}) {
    for (const prefix of ['oauth/', 'session/']) {
      assert(budget);
      const keys = await storageOperation(
        () => storage.listKeys({ prefix, limit, budget }),
        budget,
      );
      for (const key of keys) {
        const record = (await read(key, budget))?.value;
        const fixedExpiry =
          prefix === 'oauth/' ? record?.expiresAt : record?.absoluteExpiresAt;
        if (integer(fixedExpiry) && fixedExpiry <= now()) {
          assert(budget);
          await storageOperation(() => storage.delete(key, { budget }), budget);
        }
      }
    }
  }

  async function startOAuth(request, { budget } = {}) {
    void request;
    await cleanup({ budget });
    const state = random();
    const verifier = random();
    const binding = random();
    const key = `oauth/${hash(state)}`;
    const createdAt = now();
    const record = {
      schemaVersion: 1,
      ownerId: config.ownerId,
      bindingHash: hash(binding),
      createdAt,
      expiresAt: createdAt + OAUTH_MS,
      state: 'pending',
      verifierEnvelope: crypto.encrypt(verifier, context('oauth-pkce', key)),
    };
    if (!(await write(key, record, { onlyIfNew: true }, budget)).modified)
      throw new BoardError('service_unavailable');
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      login: 'cboone',
    }).toString();
    return {
      location: url.toString(),
      cookies: [cookieHeader(OAUTH_COOKIE, binding, OAUTH_MS / 1000)],
    };
  }

  async function completeOAuth(request, { budget } = {}) {
    const cleared = clearCookie(OAUTH_COOKIE);
    try {
      const params = new URL(request.url).searchParams;
      const state = params.get('state');
      const code = params.get('code');
      const binding = cookie(request, OAUTH_COOKIE);
      if (
        params.getAll('state').length !== 1 ||
        params.getAll('code').length !== 1 ||
        params.has('error') ||
        !opaque(state) ||
        !opaque(binding) ||
        !text(code, 4096)
      )
        throw new BoardError('invalid_request');
      const key = `oauth/${hash(state)}`;
      const stored = await read(key, budget);
      const record = stored?.value;
      if (
        !record ||
        record.schemaVersion !== 1 ||
        record.ownerId !== config.ownerId ||
        record.state !== 'pending' ||
        !integer(record.createdAt) ||
        record.createdAt > now() ||
        record.expiresAt !== record.createdAt + OAUTH_MS ||
        record.expiresAt <= now() ||
        !same(record.bindingHash, hash(binding))
      )
        throw new BoardError('invalid_request');
      const verifier = crypto.decrypt(
        record.verifierEnvelope,
        context('oauth-pkce', key),
      );
      if (!opaque(verifier)) throw new BoardError('service_unavailable');
      const { verifierEnvelope: removed, ...claimed } = record;
      void removed;
      if (
        !(
          await write(
            key,
            { ...claimed, state: 'claimed' },
            { onlyIfMatch: stored.etag },
            budget,
          )
        ).modified
      )
        throw new BoardError('invalid_request');
      const originalAccount = await accountRead(budget);
      const generation = (originalAccount?.value.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation))
        throw new BoardError('service_unavailable');
      const response = await exchange(
        { code, code_verifier: verifier, redirect_uri: config.callbackUrl },
        budget,
      );
      const pair = tokenPair(response, generation, now());
      const user = await providerJson(
        'https://api.github.com/user',
        {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${pair.accessToken}`,
            'X-GitHub-Api-Version': '2026-03-10',
          },
        },
        budget,
      );
      if (user?.id !== config.ownerId || !text(user.login, 128))
        throw new BoardError('forbidden');
      const account = {
        schemaVersion: 1,
        ownerId: config.ownerId,
        user: { id: user.id, login: user.login },
        authorizationEpoch: originalAccount?.value.authorizationEpoch ?? 1,
        generation,
        state: 'active',
        sourceAuthorization: 'unverified',
        accessExpiresAt: pair.accessExpiresAt,
        refreshExpiresAt: pair.refreshExpiresAt,
        lastIdentityAt: now(),
        tokenEnvelope: crypto.encrypt(
          pair,
          context('github-token-pair', ACCOUNT_KEY),
        ),
      };
      const saved = await write(
        ACCOUNT_KEY,
        account,
        originalAccount
          ? { onlyIfMatch: originalAccount.etag }
          : { onlyIfNew: true },
        budget,
      );
      if (!saved.modified)
        throw new BoardError('source_authorization_required');
      const sessionToken = random();
      const issuedAt = now();
      const sessionRecord = {
        schemaVersion: 1,
        ownerId: config.ownerId,
        authorizationEpoch: account.authorizationEpoch,
        csrfVerifier: hash(csrfToken(sessionToken)),
        issuedAt,
        lastSeenAt: issuedAt,
        absoluteExpiresAt: issuedAt + ABSOLUTE_MS,
      };
      if (
        !(
          await write(
            `session/${hash(sessionToken)}`,
            sessionRecord,
            { onlyIfNew: true },
            budget,
          )
        ).modified
      )
        throw new BoardError('service_unavailable');
      return {
        location: `${config.origin}/`,
        cookies: [
          cleared,
          cookieHeader(SESSION_COOKIE, sessionToken, ABSOLUTE_MS / 1000),
        ],
      };
    } catch (error) {
      const code = normalizeError(error).code;
      return {
        location: `${config.origin}/?auth_error=${encodeURIComponent(code)}`,
        cookies: [cleared],
      };
    }
  }

  function withoutPair(record, additions) {
    const {
      tokenEnvelope: removed,
      claim: removedClaim,
      publicationClaim: removedPublication,
      publicationAcknowledgedAt: removedAcknowledgement,
      ...rest
    } = record;
    void removed;
    void removedClaim;
    void removedPublication;
    void removedAcknowledgement;
    return { ...rest, ...additions };
  }

  async function markClaimUncertain(attemptId, generation, budget) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const current = await accountRead(budget);
      const refreshing =
        current?.value.state === 'refreshing' &&
        current.value.generation === generation &&
        current.value.claim.attemptId === attemptId;
      const publishing =
        current?.value.state === 'active' &&
        current.value.generation === generation + 1 &&
        current.value.publicationAcknowledgedAt === undefined &&
        current.value.publicationClaim?.attemptId === attemptId;
      if (!refreshing && !publishing) return false;
      const result = await write(
        ACCOUNT_KEY,
        withoutPair(current.value, {
          state: 'reauthorization-required',
          sourceAuthorization: 'reauthorization-required',
        }),
        { onlyIfMatch: current.etag },
        budget,
      );
      if (result.modified) return true;
    }
    throw new BoardError('service_unavailable');
  }

  async function acquireToken({ session, budget }) {
    await recheckOwner({ session, budget });
    let collisions = 0;
    while (true) {
      assert(budget);
      const stored = await accountRead(budget);
      if (
        !stored ||
        stored.value.authorizationEpoch !== session.authorizationEpoch
      )
        throw new BoardError('session_required');
      const record = stored.value;
      if (record.state === 'reauthorization-required')
        throw new BoardError('source_authorization_required');
      if (record.state === 'refreshing') {
        if (record.claim.deadlineAt <= now()) {
          if (
            await markClaimUncertain(
              record.claim.attemptId,
              record.generation,
              budget,
            )
          )
            throw new BoardError('source_authorization_required');
          continue;
        }
        try {
          await sleep(
            Math.max(1, Math.min(50, budget.remainingMs())),
            budget.signal,
          );
        } catch {
          throw new BoardError('source_timeout');
        }
        continue;
      }
      if (
        record.publicationClaim &&
        record.publicationAcknowledgedAt === undefined
      ) {
        if (record.publicationClaim.deadlineAt <= now()) {
          if (
            await markClaimUncertain(
              record.publicationClaim.attemptId,
              record.publicationClaim.generation,
              budget,
            )
          )
            throw new BoardError('source_authorization_required');
          continue;
        }
        try {
          await sleep(
            Math.max(1, Math.min(50, budget.remainingMs())),
            budget.signal,
          );
        } catch {
          throw new BoardError('source_timeout');
        }
        continue;
      }
      const pair = validatePair(
        crypto.decrypt(
          record.tokenEnvelope,
          context('github-token-pair', ACCOUNT_KEY),
        ),
        record.generation,
      );
      if (
        pair.accessExpiresAt !== record.accessExpiresAt ||
        pair.refreshExpiresAt !== record.refreshExpiresAt
      )
        throw new BoardError('service_unavailable');
      if (pair.accessExpiresAt - now() >= REFRESH_WINDOW_MS)
        return {
          ownerId: config.ownerId,
          accessToken: pair.accessToken,
          generation: record.generation,
        };
      if (pair.refreshExpiresAt <= now()) {
        const result = await write(
          ACCOUNT_KEY,
          withoutPair(record, {
            state: 'reauthorization-required',
            sourceAuthorization: 'reauthorization-required',
          }),
          { onlyIfMatch: stored.etag },
          budget,
        );
        if (result.modified)
          throw new BoardError('source_authorization_required');
        if (++collisions >= CAS_ATTEMPTS)
          throw new BoardError('service_unavailable');
        continue;
      }
      const attemptId = random();
      const claimed = withoutPair(record, {
        state: 'refreshing',
        claim: {
          attemptId,
          generation: record.generation,
          startedAt: now(),
          deadlineAt: budget.deadline,
        },
      });
      const result = await write(
        ACCOUNT_KEY,
        claimed,
        { onlyIfMatch: stored.etag },
        budget,
      );
      if (!result.modified) {
        if (++collisions >= CAS_ATTEMPTS)
          throw new BoardError('service_unavailable');
        continue;
      }
      let publicationAcknowledged = false;
      try {
        if (!Number.isSafeInteger(record.generation + 1))
          throw new BoardError('service_unavailable');
        const refreshed = tokenPair(
          await exchange(
            { grant_type: 'refresh_token', refresh_token: pair.refreshToken },
            budget,
          ),
          record.generation + 1,
          now(),
        );
        const active = withoutPair(record, {
          state: 'active',
          generation: refreshed.generation,
          accessExpiresAt: refreshed.accessExpiresAt,
          refreshExpiresAt: refreshed.refreshExpiresAt,
          tokenEnvelope: crypto.encrypt(
            refreshed,
            context('github-token-pair', ACCOUNT_KEY),
          ),
          publicationClaim: claimed.claim,
        });
        const published = await write(
          ACCOUNT_KEY,
          active,
          { onlyIfMatch: result.etag },
          budget,
        );
        if (!published.modified) continue;
        // Preserve the original claim and record only a timely durable ACK of
        // the complete pair. A late confirmation cannot erase expiry evidence;
        // later readers can distinguish its transport from pair publication.
        const confirmed = { ...active, publicationAcknowledgedAt: now() };
        const confirmation = await write(
          ACCOUNT_KEY,
          confirmed,
          { onlyIfMatch: published.etag },
          budget,
        );
        if (!confirmation.modified) continue;
        publicationAcknowledged = true;
        await recheckOwner({ session, budget });
        return {
          ownerId: config.ownerId,
          accessToken: refreshed.accessToken,
          generation: refreshed.generation,
        };
      } catch (error) {
        if (publicationAcknowledged) throw error;
        // A failed exchange or publication is never replayed. An expired claim
        // remains recoverable only by requiring a new OAuth authorization.
        try {
          await markClaimUncertain(attemptId, record.generation, budget);
        } catch {
          /* Claim expiry remains authoritative if storage is unavailable. */
        }
        if (error instanceof BoardError && error.code === 'session_required')
          throw error;
        throw new BoardError('source_authorization_required');
      }
    }
  }

  async function noteTokenRejected({ lease, budget }) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const current = await accountRead(budget);
      if (
        !current ||
        current.value.generation !== lease.generation ||
        current.value.state !== 'active'
      )
        return false;
      if (
        (
          await write(
            ACCOUNT_KEY,
            withoutPair(current.value, {
              state: 'reauthorization-required',
              sourceAuthorization: 'reauthorization-required',
            }),
            { onlyIfMatch: current.etag },
            budget,
          )
        ).modified
      )
        return true;
    }
    throw new BoardError('service_unavailable');
  }

  async function recordSourceAuthorization({
    lease,
    sourceAuthorization,
    budget,
  }) {
    if (!['ready', 'installation-required'].includes(sourceAuthorization))
      throw new BoardError('internal_error');
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const current = await accountRead(budget);
      if (
        !current ||
        current.value.generation !== lease.generation ||
        current.value.state !== 'active'
      )
        return false;
      if (current.value.sourceAuthorization === sourceAuthorization)
        return true;
      if (
        (
          await write(
            ACCOUNT_KEY,
            { ...current.value, sourceAuthorization },
            { onlyIfMatch: current.etag },
            budget,
          )
        ).modified
      )
        return true;
    }
    throw new BoardError('service_unavailable');
  }

  async function logout({ session, budget }) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const stored = await read(session.key, budget);
      if (!stored || stored.value.revokedAt !== undefined)
        return { cookies: [clearCookie(SESSION_COOKIE)] };
      if (
        (
          await write(
            session.key,
            { ...stored.value, revokedAt: now() },
            { onlyIfMatch: stored.etag },
            budget,
          )
        ).modified
      )
        return { cookies: [clearCookie(SESSION_COOKIE)] };
    }
    throw new BoardError('service_unavailable');
  }

  async function revokeAuthorization({ ownerId, expectedGeneration, budget }) {
    if (ownerId !== config.ownerId) throw new BoardError('forbidden');
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const stored = await accountRead(budget);
      if (!stored || stored.value.generation !== expectedGeneration)
        return false;
      const updated = withoutPair(stored.value, {
        authorizationEpoch: stored.value.authorizationEpoch + 1,
        state: 'reauthorization-required',
        sourceAuthorization: 'reauthorization-required',
      });
      if (!Number.isSafeInteger(updated.authorizationEpoch))
        throw new BoardError('service_unavailable');
      if (
        (
          await write(
            ACCOUNT_KEY,
            updated,
            { onlyIfMatch: stored.etag },
            budget,
          )
        ).modified
      )
        return true;
    }
    throw new BoardError('service_unavailable');
  }

  return Object.freeze({
    bootstrap,
    startOAuth,
    completeOAuth,
    requireAuthorizedOwner,
    requireCsrf,
    acquireToken,
    recheckOwner,
    logout,
    noteTokenRejected,
    recordSourceAuthorization,
    revokeAuthorization,
    cleanup,
  });
}
