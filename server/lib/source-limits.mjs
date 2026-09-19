import { REPORT_LIMITS } from '../../src/domain/report-contract.js';
import { BoardError } from './errors.mjs';

export const SOURCE_LIMITS = Object.freeze({
  pageSize: 100,
  repositories: 10000,
  issues: REPORT_LIMITS.issues,
  pullRequests: 1000,
  branches: 500,
  milestones: 2000,
  labels: 5000,
  comments: 20000,
  treeEntries: 100000,
  files: 40,
  fileBytes: 64 * 1024,
  totalFileBytes: 2 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  requests: 300,
  concurrency: 4,
  requestMs: 15000,
  operationMs: 45000,
  transportRetries: 1,
});

/** One budget covers token coordination, both observations, and every retry. */
export function createOperationBudget({
  now = Date.now,
  signal,
  limits = SOURCE_LIMITS,
  startedAt,
} = {}) {
  const effective = Object.freeze({ ...SOURCE_LIMITS, ...limits });
  for (const [key, value] of Object.entries(effective)) {
    if (
      !Number.isSafeInteger(value) ||
      value < (key === 'transportRetries' ? 0 : 1)
    )
      throw new BoardError('invalid_request');
  }
  if (effective.issues > REPORT_LIMITS.issues || effective.pageSize > 100)
    throw new BoardError('invalid_request');
  const current = now();
  const start = startedAt ?? current;
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > current ||
    !Number.isSafeInteger(start + effective.operationMs)
  )
    throw new BoardError('invalid_request');
  const deadline = start + effective.operationMs;
  let requests = 0;
  let bytes = 0;
  const remainingMs = () => Math.max(0, deadline - now());
  const assertActive = () => {
    if (signal?.aborted || remainingMs() === 0)
      throw new BoardError('source_timeout');
  };
  return Object.freeze({
    limits: effective,
    deadline,
    signal,
    remainingMs,
    assertActive,
    takeRequest() {
      assertActive();
      requests += 1;
      if (requests > effective.requests)
        throw new BoardError('source_limit_exceeded');
    },
    takeBytes(count) {
      assertActive();
      if (!Number.isSafeInteger(count) || count < 0)
        throw new BoardError('source_incomplete');
      bytes += count;
      if (!Number.isSafeInteger(bytes) || bytes > effective.totalBytes)
        throw new BoardError('source_limit_exceeded');
    },
  });
}
