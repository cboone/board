import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_LIMITS, createOperationBudget } from '../lib/source-limits.mjs';
import { REPORT_LIMITS } from '../../src/domain/report-contract.js';

test('source admission shares the actual report issue boundary', () => {
  assert.equal(SOURCE_LIMITS.issues, REPORT_LIMITS.issues);
  assert.equal(SOURCE_LIMITS.issues, 1000);
  assert.equal(SOURCE_LIMITS.repositories, 10000);
  assert.ok(Object.isFrozen(SOURCE_LIMITS));
});
test('requests and streamed bytes consume one immutable operation budget', () => {
  const budget = createOperationBudget({
    limits: { requests: 2, totalBytes: 5 },
  });
  assert.ok(Object.isFrozen(budget));
  assert.ok(Object.isFrozen(budget.limits));
  budget.takeRequest();
  budget.takeRequest();
  budget.takeBytes(3);
  budget.takeBytes(2);
  assert.throws(() => budget.takeRequest(), { code: 'source_limit_exceeded' });
  assert.throws(() => budget.takeBytes(1), { code: 'source_limit_exceeded' });
});
test('deadline includes time spent by a caller before source reads', () => {
  let current = 1000;
  const budget = createOperationBudget({
    now: () => current,
    limits: { operationMs: 45 },
  });
  current += 44;
  assert.equal(budget.remainingMs(), 1);
  current += 1;
  assert.throws(() => budget.takeRequest(), { code: 'source_timeout' });
  assert.throws(() => budget.takeBytes(0), { code: 'source_timeout' });
});
test('an explicit invocation start includes composition time in the deadline', () => {
  let current = 1040;
  const budget = createOperationBudget({
    now: () => current,
    startedAt: 1000,
    limits: { operationMs: 45 },
  });
  assert.equal(budget.deadline, 1045);
  assert.equal(budget.remainingMs(), 5);
  current = 1045;
  assert.throws(() => budget.assertActive(), { code: 'source_timeout' });
  for (const startedAt of [-1, 1046, 0.5])
    assert.throws(
      () =>
        createOperationBudget({
          now: () => current,
          startedAt,
        }),
      { code: 'invalid_request' },
    );
});
test('external abort fails without resetting counters or deadline', () => {
  const controller = new AbortController();
  const budget = createOperationBudget({ signal: controller.signal });
  controller.abort();
  assert.throws(() => budget.assertActive(), { code: 'source_timeout' });
});
test('invalid bounds cannot loosen the shared report or GitHub page boundary', () => {
  for (const limits of [
    { issues: 1001 },
    { pageSize: 101 },
    { concurrency: 0 },
    { requests: NaN },
  ])
    assert.throws(() => createOperationBudget({ limits }), {
      code: 'invalid_request',
    });
  const budget = createOperationBudget();
  for (const value of [-1, NaN, 0.5])
    assert.throws(() => budget.takeBytes(value), { code: 'source_incomplete' });
});
