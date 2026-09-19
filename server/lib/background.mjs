import { randomBytes as nativeRandomBytes } from 'node:crypto';
import { BoardError } from './errors.mjs';

export const BACKGROUND_INVOCATION_LIMITS = Object.freeze({ bodyBytes: 4096 });

const HEX_64 = /^[a-f0-9]{64}$/u;
const unavailable = () => new BoardError('service_unavailable');
const opaque = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{43}$/u.test(value) &&
  Buffer.from(value, 'base64url').length === 32 &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function createDispatchCapability(randomBytes = nativeRandomBytes) {
  const value = randomBytes(32);
  if (!Buffer.isBuffer(value) || value.length !== 32) throw unavailable();
  return value.toString('base64url');
}

async function readBoundedBody(request) {
  const stated = request.headers.get('content-length');
  if (
    stated !== null &&
    (!/^(?:0|[1-9]\d*)$/u.test(stated) ||
      Number(stated) > BACKGROUND_INVOCATION_LIMITS.bodyBytes)
  )
    throw new BoardError('invalid_request');
  const reader = request.body?.getReader();
  if (!reader) throw new BoardError('invalid_request');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > BACKGROUND_INVOCATION_LIMITS.bodyBytes)
        throw new BoardError('invalid_request');
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error instanceof BoardError
      ? error
      : new BoardError('invalid_request');
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BoardError('invalid_request');
  }
  return value;
}

export async function parseBackgroundInvocation(request, origin) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    throw new BoardError('forbidden');
  }
  if (
    request.method !== 'POST' ||
    url.origin !== origin ||
    url.pathname !== '/.netlify/functions/report-job' ||
    url.search !== '' ||
    request.headers.get('origin') !== origin ||
    request.headers.get('content-type') !== 'application/json' ||
    request.headers.has('cookie') ||
    request.headers.has('authorization') ||
    request.headers.has('x-csrf-token')
  )
    throw new BoardError('forbidden');
  const value = await readBoundedBody(request);
  if (
    !exact(value, ['jobId', 'capability']) ||
    typeof value.jobId !== 'string' ||
    !HEX_64.test(value.jobId) ||
    !opaque(value.capability)
  )
    throw new BoardError('invalid_request');
  return Object.freeze({ jobId: value.jobId, capability: value.capability });
}

export async function dispatchBackgroundJob({
  origin,
  jobId,
  capability,
  fetchImpl = fetch,
  signal,
}) {
  if (
    typeof origin !== 'string' ||
    !HEX_64.test(jobId) ||
    !opaque(capability) ||
    typeof fetchImpl !== 'function'
  )
    throw unavailable();
  const body = JSON.stringify({ jobId, capability });
  if (Buffer.byteLength(body, 'utf8') > BACKGROUND_INVOCATION_LIMITS.bodyBytes)
    throw unavailable();
  let response;
  try {
    response = await fetchImpl(
      new URL('/.netlify/functions/report-job', origin),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
        },
        body,
        redirect: 'error',
        signal,
      },
    );
  } catch {
    throw unavailable();
  }
  void response.body?.cancel().catch(() => {});
  if (response.status !== 202) throw unavailable();
  return Object.freeze({ accepted: true });
}
