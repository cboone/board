import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKGROUND_INVOCATION_LIMITS,
  createDispatchCapability,
  dispatchBackgroundJob,
  parseBackgroundInvocation,
} from '../lib/background.mjs';

const origin = 'https://tracker-boards.example';
const jobId = 'a'.repeat(64);
const capability = Buffer.alloc(32, 7).toString('base64url');
const request = (body, options = {}) =>
  new Request(`${origin}/.netlify/functions/report-job`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...options.headers,
    },
    body,
  });

test('dispatch capabilities require exactly thirty-two random bytes', () => {
  assert.equal(
    createDispatchCapability(() => Buffer.alloc(32, 7)),
    capability,
  );
  assert.throws(() => createDispatchCapability(() => Buffer.alloc(31, 7)), {
    code: 'service_unavailable',
  });
});

test('background invocation accepts only the exact credential-free contract', async () => {
  assert.deepEqual(
    await parseBackgroundInvocation(
      request(JSON.stringify({ jobId, capability })),
      origin,
    ),
    { jobId, capability },
  );
  for (const invalid of [
    request(JSON.stringify({ jobId, capability, rawSource: 'private' })),
    request(JSON.stringify({ jobId: 'bad', capability })),
    request(JSON.stringify({ jobId, capability: 'bad' })),
    request(JSON.stringify({ jobId, capability }), {
      headers: { Cookie: 'private=session' },
    }),
    new Request(`${origin}/.netlify/functions/report-job?retry=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ jobId, capability }),
    }),
  ])
    await assert.rejects(parseBackgroundInvocation(invalid, origin));
});

test('background body parsing enforces the byte limit before JSON projection', async () => {
  await assert.rejects(
    parseBackgroundInvocation(
      request(' '.repeat(BACKGROUND_INVOCATION_LIMITS.bodyBytes + 1)),
      origin,
    ),
    { code: 'invalid_request' },
  );
  await assert.rejects(parseBackgroundInvocation(request('{'), origin), {
    code: 'invalid_request',
  });
});

test('dispatch posts only the job capability and requires the native 202 acknowledgement', async () => {
  const calls = [];
  const accepted = await dispatchBackgroundJob({
    origin,
    jobId,
    capability,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 202 });
    },
  });
  assert.deepEqual(accepted, { accepted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${origin}/.netlify/functions/report-job`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { jobId, capability });
  assert.equal(calls[0].init.headers.Origin, origin);
  assert.equal(calls[0].init.credentials, undefined);
  assert.equal(calls[0].init.redirect, 'error');

  for (const outcome of [
    async () => new Response(null, { status: 200 }),
    async () => {
      throw new Error('synthetic uncertain dispatch');
    },
  ])
    await assert.rejects(
      dispatchBackgroundJob({
        origin,
        jobId,
        capability,
        fetchImpl: outcome,
      }),
      { code: 'service_unavailable' },
    );
});
