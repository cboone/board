import { createCrypto } from '../lib/crypto.mjs';

export const ORIGIN = 'https://tracker-boards.example';
export function testConfig() {
  return {
    origin: ORIGIN,
    callbackUrl: `${ORIGIN}/api/auth/callback`,
    ownerId: 99961,
    appId: 4995264,
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    keyring: {
      currentId: 'current',
      keys: new Map([['current', Buffer.alloc(32, 8)]]),
    },
  };
}
export function memoryStorage() {
  const records = new Map();
  let serial = 0;
  const events = [];
  return {
    records,
    events,
    async read(key) {
      events.push(['read', key]);
      return records.has(key) ? structuredClone(records.get(key)) : null;
    },
    async write(key, value, condition) {
      events.push(['write', key, structuredClone(value), condition]);
      const current = records.get(key);
      if (
        (condition.onlyIfNew && current) ||
        (condition.onlyIfMatch !== undefined &&
          current?.etag !== condition.onlyIfMatch)
      )
        return { modified: false };
      const etag = `"opaque-${++serial}"`;
      records.set(key, { value: structuredClone(value), etag });
      return { modified: true, etag };
    },
    async listKeys({ prefix, limit }) {
      return [...records.keys()]
        .filter((key) => key.startsWith(prefix))
        .slice(0, limit);
    },
    async delete(key) {
      events.push(['delete', key]);
      records.delete(key);
    },
  };
}
export function testCrypto(config = testConfig()) {
  return createCrypto({ keyring: config.keyring });
}
export function budget(now = Date.now) {
  let requests = 0;
  let bytes = 0;
  const deadline = now() + 45000;
  return {
    limits: {
      repositories: 10000,
      requestMs: 15000,
      responseBytes: 8 * 1024 * 1024,
    },
    deadline,
    remainingMs: () => Math.max(0, deadline - now()),
    assertActive() {
      if (now() >= deadline) throw new Error('Unexpected expired test budget');
    },
    takeRequest() {
      requests += 1;
    },
    takeBytes(count) {
      bytes += count;
    },
    get requests() {
      return requests;
    },
    get bytes() {
      return bytes;
    },
  };
}
export const tokenResponse = (overrides = {}) => ({
  access_token: 'synthetic-access',
  refresh_token: 'synthetic-refresh',
  token_type: 'bearer',
  expires_in: 28800,
  refresh_token_expires_in: 15897600,
  scope: '',
  ...overrides,
});
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
