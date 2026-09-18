import { AsyncLocalStorage } from 'node:async_hooks';
import { BoardError } from './errors.mjs';

const validEtag = (etag) =>
  typeof etag === 'string' && etag.length > 0 && etag.length <= 1024;
const keyCheck = (key) => {
  if (
    typeof key !== 'string' ||
    !/^(?:account\/99961|(?:oauth|session)\/[a-f0-9]{64})$/.test(key)
  )
    throw new BoardError('service_unavailable');
};
const unavailable = () => new BoardError('service_unavailable');

export function createStorage({ store }) {
  return Object.freeze({
    async read(key) {
      keyCheck(key);
      try {
        const result = await store.getWithMetadata(key, {
          type: 'json',
          consistency: 'strong',
        });
        if (result === null) return null;
        if (!result || !validEtag(result.etag) || result.data === undefined)
          throw unavailable();
        return { value: result.data, etag: result.etag };
      } catch {
        throw unavailable();
      }
    },
    async write(key, value, condition) {
      keyCheck(key);
      if (
        !condition ||
        (condition.onlyIfNew !== true && !validEtag(condition.onlyIfMatch)) ||
        (condition.onlyIfNew === true && condition.onlyIfMatch !== undefined)
      )
        throw unavailable();
      try {
        const options =
          condition.onlyIfNew === true
            ? { onlyIfNew: true }
            : { onlyIfMatch: condition.onlyIfMatch };
        const result = await store.setJSON(key, value, options);
        if (
          !result ||
          typeof result.modified !== 'boolean' ||
          (result.modified && !validEtag(result.etag))
        )
          throw unavailable();
        return result.modified
          ? { modified: true, etag: result.etag }
          : { modified: false };
      } catch {
        throw unavailable();
      }
    },
    async listKeys({ prefix, limit = 20 }) {
      if (
        !['oauth/', 'session/'].includes(prefix) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw unavailable();
      try {
        const keys = [];
        for await (const page of store.list({ prefix, paginate: true })) {
          if (!page || !Array.isArray(page.blobs)) throw unavailable();
          for (const blob of page.blobs) {
            keyCheck(blob.key);
            if (!blob.key.startsWith(prefix)) throw unavailable();
            keys.push(blob.key);
            if (keys.length === limit) return keys;
          }
        }
        return keys;
      } catch {
        throw unavailable();
      }
    },
    async delete(key) {
      keyCheck(key);
      if (key.startsWith('account/')) throw unavailable();
      try {
        await store.delete(key);
      } catch {
        throw unavailable();
      }
    },
  });
}

export async function createProductionStorage({
  loadBlobs = () => import('@netlify/blobs'),
  fetchImpl = fetch,
} = {}) {
  try {
    const operations = new AsyncLocalStorage();
    const runOperation = (budget, action) => {
      if (!budget) throw unavailable();
      return operations.run({ budget, failure: null }, async () => {
        const operation = operations.getStore();
        try {
          budget.assertActive();
          const result = await action();
          if (operation.failure) throw operation.failure;
          budget.assertActive();
          return result;
        } catch (error) {
          throw operation.failure ?? error;
        }
      });
    };
    const boundedFetch = async (input, init) => {
      const operation = operations.getStore();
      try {
        if (!operation || operation.failure)
          throw operation?.failure ?? unavailable();
        const { budget } = operation;
        budget.assertActive();
        const timeout = AbortSignal.timeout(
          Math.max(1, Math.min(budget.limits.requestMs, budget.remainingMs())),
        );
        const signal = budget.signal
          ? AbortSignal.any([budget.signal, timeout])
          : timeout;
        const response = await abortable(
          fetchImpl(input, { ...init, redirect: 'error', signal }),
          signal,
        );
        // Blobs retries thrown fetch errors, 429, 5xx and signed-URL 403
        // internally. An ETag-free, nonretryable response stops hidden retries;
        // runOperation restores the original safe failure afterward.
        if (
          response.status === 429 ||
          response.status >= 500 ||
          response.status === 403
        ) {
          void response.body?.cancel().catch(() => {});
          throw unavailable();
        }
        const reader = response.body?.getReader();
        const chunks = [];
        let bytes = 0;
        if (reader) {
          try {
            while (true) {
              const result = await abortable(reader.read(), signal);
              budget.assertActive();
              if (result.done) break;
              bytes += result.value.byteLength;
              if (bytes > budget.limits.responseBytes) throw unavailable();
              chunks.push(Buffer.from(result.value));
            }
          } catch (error) {
            void reader.cancel().catch(() => {});
            throw error;
          }
        }
        if (signal.aborted) throw new BoardError('source_timeout');
        return new Response(reader ? Buffer.concat(chunks) : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        if (operation)
          operation.failure =
            error instanceof BoardError ? error : unavailable();
        return new Response(null, { status: 408 });
      }
    };
    const { getStore } = await loadBlobs();
    const adapter = createStorage({
      store: getStore({
        name: 'board-auth',
        consistency: 'strong',
        fetch: boundedFetch,
      }),
    });
    return Object.freeze({
      read: (key, { budget } = {}) =>
        runOperation(budget, () => adapter.read(key)),
      write: (key, value, condition, { budget } = {}) =>
        runOperation(budget, () => adapter.write(key, value, condition)),
      listKeys: ({ prefix, limit, budget }) =>
        runOperation(budget, () => adapter.listKeys({ prefix, limit })),
      delete: (key, { budget } = {}) =>
        runOperation(budget, () => adapter.delete(key)),
    });
  } catch {
    throw unavailable();
  }
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
