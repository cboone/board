import assert from 'node:assert/strict';
import test from 'node:test';
import { createCrypto } from '../lib/crypto.mjs';

const context = {
  purpose: 'github-token-pair',
  recordKey: 'account/99961',
  schemaVersion: 1,
  ownerId: 99961,
};
const keys = new Map([
  ['old', Buffer.alloc(32, 2)],
  ['new', Buffer.alloc(32, 3)],
]);
test('authenticated encryption binds purpose, key, schema, owner and envelope without exposing plaintext', () => {
  const crypto = createCrypto({ keyring: { currentId: 'new', keys } });
  const value = {
    accessToken: 'synthetic-sensitive-access',
    refreshToken: 'synthetic-sensitive-refresh',
  };
  const envelope = crypto.encrypt(value, context);
  assert.deepEqual(crypto.decrypt(envelope, context), value);
  assert.ok(!JSON.stringify(envelope).includes('sensitive'));
  assert.notEqual(crypto.encrypt(value, context).nonce, envelope.nonce);
  for (const changed of [
    { purpose: 'oauth-pkce' },
    { recordKey: 'oauth/other' },
    { schemaVersion: 2 },
    { ownerId: 1 },
  ])
    assert.throws(() => crypto.decrypt(envelope, { ...context, ...changed }), {
      code: 'service_unavailable',
    });
  for (const changed of [
    { keyId: 'old' },
    { tag: Buffer.alloc(16).toString('base64url') },
    { nonce: 'bad' },
    { version: 2 },
    { ciphertext: `${envelope.ciphertext}=` },
  ])
    assert.throws(() => crypto.decrypt({ ...envelope, ...changed }, context), {
      code: 'service_unavailable',
    });
});
test('previous key decrypts while all new writes use current key', () => {
  const old = createCrypto({ keyring: { currentId: 'old', keys } }).encrypt(
    'pkce-verifier',
    { ...context, purpose: 'oauth-pkce' },
  );
  const current = createCrypto({ keyring: { currentId: 'new', keys } });
  assert.equal(
    current.decrypt(old, { ...context, purpose: 'oauth-pkce' }),
    'pkce-verifier',
  );
  assert.equal(current.encrypt('value', context).keyId, 'new');
  assert.throws(() =>
    createCrypto({
      keyring: { currentId: 'new', keys: new Map([['new', keys.get('new')]]) },
    }).decrypt(old, { ...context, purpose: 'oauth-pkce' }),
  );
});
