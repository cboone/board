import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoardError, errorEnvelope, errorResponse } from '../lib/errors.mjs';

test('source authorization is a source-only 403 and session failures are 401', () => {
  assert.equal(new BoardError('source_authorization_required').status, 403);
  assert.equal(new BoardError('session_required').status, 401);
  assert.equal(new BoardError('provider_unavailable').retryable, true);
});

test('analysis admission exposes the reviewed stable browser codes', () => {
  for (const code of [
    'report_state_changed',
    'analysis_in_progress',
    'analysis_unavailable',
  ]) {
    const error = new BoardError(code);
    assert.equal(error.code, code);
    assert.equal(error.status, code === 'analysis_unavailable' ? 503 : 409);
  }
});

test('unknown exceptions and provider text never become browser messages', async () => {
  const raw = new Error('private-repository-name provider-secret');
  const response = errorResponse(raw);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(
    JSON.stringify(await response.json()),
    /private-repository|provider-secret/,
  );
  const known = new BoardError('provider_unavailable', { cause: raw });
  known.message = raw.message;
  assert.doesNotMatch(JSON.stringify(errorEnvelope(known)), /provider-secret/);
  assert.equal(
    new BoardError('unknown-private-message').code,
    'internal_error',
  );
});

test('mutated error codes and statuses cannot bypass the safe taxonomy', async () => {
  const error = new BoardError('forbidden');
  error.status = 200;
  assert.equal(errorResponse(error).status, 403);
  error.code = 'private-provider-response';
  const response = errorResponse(error);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'internal_error');
});
