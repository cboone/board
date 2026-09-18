import { BoardError } from './errors.mjs';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new BoardError('source_timeout'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new BoardError('source_timeout'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', aborted);
      });
  });
}

function apiUrl(path) {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\s\\]/u.test(path)
  )
    throw new BoardError('invalid_request');
  const url = new URL(path, API_ORIGIN);
  if (url.origin !== API_ORIGIN || url.hash || url.username || url.password)
    throw new BoardError('invalid_request');
  return url;
}

function nextPage(link, initial, previous) {
  if (!link) return null;
  const candidates = link
    .split(',')
    .filter((part) => /rel\s*=\s*"[^"]*\bnext\b[^"]*"/u.test(part));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw new BoardError('source_incomplete');
  const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/u.exec(candidates[0]);
  if (!match) throw new BoardError('source_incomplete');
  let next;
  try {
    next = new URL(match[1]);
  } catch {
    throw new BoardError('source_incomplete');
  }
  if (
    next.origin !== API_ORIGIN ||
    next.pathname !== initial.pathname ||
    next.username ||
    next.password ||
    next.hash ||
    next.searchParams.getAll('page').length !== 1 ||
    !/^[1-9]\d*$/u.test(next.searchParams.get('page') ?? '') ||
    !Number.isSafeInteger(Number(next.searchParams.get('page'))) ||
    Number(next.searchParams.get('page')) <= previous
  )
    throw new BoardError('source_incomplete');
  const expected = [...initial.searchParams]
    .filter(([key]) => key !== 'page')
    .sort();
  const actual = [...next.searchParams]
    .filter(([key]) => key !== 'page')
    .sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new BoardError('source_incomplete');
  return next;
}

function providerError(response, bytes) {
  let secondaryRateLimit = false;
  if (response.status === 403) {
    try {
      const body = JSON.parse(new TextDecoder().decode(bytes));
      secondaryRateLimit =
        typeof body.message === 'string' &&
        /(?:secondary rate limit|api rate limit exceeded)/iu.test(body.message);
    } catch {
      /* Invalid provider error text does not cross the boundary. */
    }
  }
  if (response.status === 401)
    return new BoardError('source_authorization_required');
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (secondaryRateLimit ||
        response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.has('retry-after')))
  )
    return new BoardError('provider_rate_limited', { retryable: true });
  if (response.status === 403) return new BoardError('forbidden');
  if (response.status === 404) return new BoardError('source_unavailable');
  if (response.status >= 500)
    return new BoardError('provider_unavailable', { retryable: true });
  return new BoardError('source_incomplete');
}

async function bodyBytes(response, signal, budget) {
  if (!response.body) throw new BoardError('source_incomplete');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) {
        finished = true;
        break;
      }
      if (!(value instanceof Uint8Array))
        throw new BoardError('source_incomplete');
      budget.takeBytes(value.byteLength);
      length += value.byteLength;
      if (length > budget.limits.responseBytes)
        throw new BoardError('source_limit_exceeded');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A client is scoped to one operation, including its single read-only retry. */
export function createGithubClient({
  accessToken,
  budget,
  signal,
  fetchImpl = fetch,
}) {
  if (
    typeof accessToken !== 'string' ||
    !accessToken ||
    /[\r\n]/u.test(accessToken)
  )
    throw new BoardError('source_authorization_required');
  budget.assertActive();
  const operationSignal = AbortSignal.any(
    [
      signal,
      budget.signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(budget.remainingMs()))),
    ].filter(Boolean),
  );
  let active = 0;
  let retries = 0;
  const queue = [];
  const acquire = async () => {
    budget.assertActive();
    if (active < budget.limits.concurrency) {
      active += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject, aborted: null };
      entry.aborted = () => {
        const index = queue.indexOf(entry);
        if (index !== -1) queue.splice(index, 1);
        reject(new BoardError('source_timeout'));
      };
      if (operationSignal.aborted) {
        entry.aborted();
        return;
      }
      operationSignal.addEventListener('abort', entry.aborted, { once: true });
      queue.push(entry);
    });
    budget.assertActive();
  };
  const release = () => {
    const entry = queue.shift();
    if (entry) {
      operationSignal.removeEventListener('abort', entry.aborted);
      entry.resolve();
    } else active -= 1;
  };
  const pause = async (milliseconds) => {
    if (milliseconds >= budget.remainingMs())
      throw new BoardError('provider_rate_limited', { retryable: true });
    let timer;
    try {
      await abortable(
        new Promise((resolve) => {
          timer = setTimeout(resolve, milliseconds);
        }),
        operationSignal,
      );
    } finally {
      clearTimeout(timer);
    }
  };
  const request = async (path, { method = 'GET', body } = {}) => {
    const url = apiUrl(path);
    if (method !== 'GET' && !(method === 'POST' && url.pathname === '/graphql'))
      throw new BoardError('invalid_request');
    for (;;) {
      await acquire();
      let response;
      let failure;
      try {
        budget.takeRequest();
        const requestSignal = AbortSignal.any([
          operationSignal,
          AbortSignal.timeout(
            Math.max(
              1,
              Math.ceil(
                Math.min(budget.limits.requestMs, budget.remainingMs()),
              ),
            ),
          ),
        ]);
        try {
          response = await abortable(
            fetchImpl(url.href, {
              method,
              redirect: 'error',
              signal: requestSignal,
              headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': API_VERSION,
                Authorization: 'Bearer ' + accessToken,
                ...(body === undefined
                  ? {}
                  : { 'Content-Type': 'application/json' }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            requestSignal,
          );
          const bytes = await bodyBytes(response, requestSignal, budget);
          if (!response.ok) throw providerError(response, bytes);
          let data;
          try {
            data = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            );
          } catch {
            throw new BoardError('source_incomplete');
          }
          budget.assertActive();
          return { data, headers: response.headers };
        } catch (error) {
          if (error instanceof BoardError) throw error;
          if (requestSignal.aborted || operationSignal.aborted)
            throw new BoardError('source_timeout');
          throw new BoardError('provider_unavailable', { retryable: true });
        }
      } catch (error) {
        failure = error;
      } finally {
        release();
      }
      if (
        !(failure instanceof BoardError) ||
        !['provider_unavailable', 'provider_rate_limited'].includes(
          failure.code,
        ) ||
        retries >= budget.limits.transportRetries
      )
        throw failure;
      budget.assertActive();
      retries += 1;
      if (failure.code === 'provider_rate_limited') {
        const after = response?.headers.get('retry-after');
        const reset = response?.headers.get('x-ratelimit-reset');
        let delay;
        if (after !== null && after !== undefined && /^\d+$/u.test(after))
          delay = Number(after) * 1000;
        else if (reset && /^\d+$/u.test(reset))
          delay = Math.max(
            0,
            Number(reset) * 1000 - (budget.deadline - budget.remainingMs()),
          );
        if (!Number.isSafeInteger(delay) || delay < 0) throw failure;
        await pause(delay);
      }
    }
  };
  return Object.freeze({
    async get(path) {
      return (await request(path)).data;
    },
    async graphql(query, variables) {
      if (typeof query !== 'string' || !/^\s*query\b/u.test(query))
        throw new BoardError('invalid_request');
      const { data } = await request('/graphql', {
        method: 'POST',
        body: { query, variables },
      });
      if (!data || typeof data !== 'object')
        throw new BoardError('source_incomplete');
      if (data.errors) {
        if (!Array.isArray(data.errors))
          throw new BoardError('source_incomplete');
        if (data.errors.some((error) => error.type === 'RATE_LIMITED'))
          throw new BoardError('provider_rate_limited', { retryable: true });
        if (data.errors.some((error) => error.type === 'FORBIDDEN'))
          throw new BoardError('forbidden');
        if (data.errors.some((error) => error.type === 'NOT_FOUND'))
          throw new BoardError('source_unavailable');
        throw new BoardError('source_incomplete');
      }
      if (!data.data || typeof data.data !== 'object')
        throw new BoardError('source_incomplete');
      return data.data;
    },
    async paginate(path, { key, limit, identity = (item) => item.id } = {}) {
      const initial = apiUrl(path);
      initial.searchParams.set('per_page', String(budget.limits.pageSize));
      if (initial.searchParams.has('page'))
        throw new BoardError('invalid_request');
      const seen = new Set();
      const items = [];
      let total;
      let url = initial;
      let previous = 1;
      while (url) {
        const { data, headers } = await request(url.pathname + url.search);
        const page = key === undefined ? data : data?.[key];
        if (!Array.isArray(page) || page.length > budget.limits.pageSize)
          throw new BoardError('source_incomplete');
        if (key !== undefined && Object.hasOwn(data, 'total_count')) {
          const count = data.total_count;
          if (!Number.isSafeInteger(count) || count < 0)
            throw new BoardError('source_incomplete');
          if (total !== undefined && total !== count)
            throw new BoardError('source_unstable');
          total = count;
          if (total > limit) throw new BoardError('source_limit_exceeded');
        }
        for (const item of page) {
          const id = identity(item);
          if (
            !(typeof id === 'string' && id.length > 0) &&
            !(Number.isSafeInteger(id) && id > 0)
          )
            throw new BoardError('source_incomplete');
          if (seen.has(id)) throw new BoardError('source_unstable');
          seen.add(id);
          items.push(item);
          if (items.length > limit)
            throw new BoardError('source_limit_exceeded');
        }
        url = nextPage(headers.get('link'), initial, previous);
        if (url) previous = Number(url.searchParams.get('page'));
      }
      if (total !== undefined && total !== items.length)
        throw new BoardError('source_unstable');
      return items;
    },
  });
}
