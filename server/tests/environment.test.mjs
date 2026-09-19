import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readEnvironment,
  readPublicOrigin,
  requirePublishedDeploy,
  requireProductionContext,
  requireCanonicalOrigin,
} from '../lib/environment.mjs';

const env = () => ({
  BOARD_APP_ORIGIN: 'https://tracker-boards.example',
  BOARD_OWNER_ID: '99961',
  GITHUB_APP_ID: '4995264',
  GITHUB_APP_CLIENT_ID: 'synthetic-client',
  GITHUB_APP_CLIENT_SECRET: 'synthetic-secret',
  BOARD_TOKEN_KEY_ID: 'current',
  BOARD_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
});
test('configuration enforces the fixed numeric owner and complete bounded keyring', () => {
  assert.equal(readEnvironment(env()).ownerId, 99961);
  for (const changes of [
    { BOARD_OWNER_ID: '1' },
    { GITHUB_APP_ID: '9007199254740992' },
    { BOARD_TOKEN_ENCRYPTION_KEY: 'a'.repeat(44) },
    { BOARD_PREVIOUS_TOKEN_KEY_ID: 'previous' },
    {
      BOARD_PREVIOUS_TOKEN_KEY_ID: 'current',
      BOARD_PREVIOUS_TOKEN_ENCRYPTION_KEY: env().BOARD_TOKEN_ENCRYPTION_KEY,
    },
  ])
    assert.throws(() => readEnvironment({ ...env(), ...changes }), {
      code: 'service_unavailable',
    });
  const config = readEnvironment({
    ...env(),
    BOARD_PREVIOUS_TOKEN_KEY_ID: 'previous',
    BOARD_PREVIOUS_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  });
  assert.equal(config.keyring.keys.size, 2);
  assert.equal(
    config.callbackUrl,
    'https://tracker-boards.example/api/auth/callback',
  );
});
test('public guards reject unknown deployment contexts and noncanonical HTTPS origins', () => {
  for (const context of [
    undefined,
    {},
    { deploy: { context: 'deploy-preview' } },
    { deploy: { context: 'Production' } },
  ])
    assert.throws(() => requireProductionContext(context), {
      code: 'forbidden',
    });
  requireProductionContext({ deploy: { context: 'production' } });
  for (const context of [
    { deploy: { context: 'production' } },
    { deploy: { context: 'production', published: false, id: 'deploy-1' } },
    { deploy: { context: 'production', published: true, id: '../deploy' } },
  ])
    assert.throws(() => requirePublishedDeploy(context), {
      code: 'forbidden',
    });
  assert.equal(
    requirePublishedDeploy({
      deploy: { context: 'production', published: true, id: 'deploy-1' },
    }),
    'deploy-1',
  );
  for (const origin of [
    'http://example.com',
    'https://user@example.com',
    'https://example.com/path',
    'https://example.com/?secret=1',
    'https://example.com/#a',
  ])
    assert.throws(() => readPublicOrigin({ BOARD_APP_ORIGIN: origin }));
  assert.equal(
    readPublicOrigin({ BOARD_APP_ORIGIN: 'https://example.com/' }),
    'https://example.com',
  );
  assert.throws(
    () =>
      requireCanonicalOrigin(
        new Request('https://other.example/api/session'),
        'https://example.com',
      ),
    { code: 'forbidden' },
  );
});
