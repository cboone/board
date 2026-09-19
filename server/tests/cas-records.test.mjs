import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProjectedRecord,
  readProjectedRecord,
  updateProjectedRecord,
} from '../lib/cas-records.mjs';

const budget = Object.freeze({});
const project = (value) => {
  if (
    !value ||
    Object.keys(value).join(',') !== 'schemaVersion,revision,value' ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.value !== 'string'
  )
    throw new Error('invalid');
  return structuredClone(value);
};
const record = (revision = 0, value = 'initial') => ({
  schemaVersion: 1,
  revision,
  value,
});

function memoryStorage(initial = null) {
  let current = initial;
  let sequence = initial === null ? 0 : 1;
  const etag = () => `"etag-${sequence}"`;
  return {
    async read(_key, options) {
      assert.deepEqual(options, { budget });
      return current === null
        ? null
        : { value: structuredClone(current), etag: etag() };
    },
    async write(_key, value, condition, options) {
      assert.deepEqual(options, { budget });
      if (
        (condition.onlyIfNew && current !== null) ||
        (condition.onlyIfMatch && condition.onlyIfMatch !== etag())
      )
        return { modified: false };
      current = structuredClone(value);
      sequence += 1;
      return { modified: true, etag: etag() };
    },
    value: () => structuredClone(current),
  };
}

const input = (storage) => ({
  storage,
  key: 'records/one',
  project,
  budget,
});

test('projected reads and creates distinguish exact idempotency from conflict', async () => {
  const storage = memoryStorage();
  assert.equal(await readProjectedRecord(input(storage)), null);
  assert.equal(
    (await createProjectedRecord({ ...input(storage), value: record() }))
      .status,
    'created',
  );
  assert.equal(
    (await createProjectedRecord({ ...input(storage), value: record() }))
      .status,
    'existing',
  );
  assert.equal(
    (
      await createProjectedRecord({
        ...input(storage),
        value: record(0, 'different'),
      })
    ).status,
    'conflict',
  );
});

test('a lost create acknowledgement succeeds only after exact strong readback', async () => {
  const storage = memoryStorage();
  const original = storage.write;
  storage.write = async (...arguments_) => {
    await original(...arguments_);
    throw new Error('lost acknowledgement');
  };
  const result = await createProjectedRecord({
    ...input(storage),
    value: record(),
  });
  assert.equal(result.status, 'existing');
  assert.deepEqual(result.value, record());
});

test('conditional updates resolve conflicts and committed lost acknowledgements', async () => {
  const storage = memoryStorage(record());
  let injected = false;
  const original = storage.write;
  storage.write = async (...arguments_) => {
    if (!injected) {
      injected = true;
      await original(
        arguments_[0],
        record(1, 'concurrent'),
        arguments_[2],
        arguments_[3],
      );
      return { modified: false };
    }
    await original(...arguments_);
    throw new Error('lost acknowledgement');
  };
  const result = await updateProjectedRecord({
    ...input(storage),
    update: (current) => record(current.revision + 1, current.value + '-next'),
  });
  assert.equal(result.status, 'updated');
  assert.deepEqual(result.value, record(2, 'concurrent-next'));
  assert.deepEqual(storage.value(), result.value);
});

test('conditional updates stop after the explicit conflict bound', async () => {
  const storage = memoryStorage(record());
  storage.write = async () => ({ modified: false });
  let reads = 0;
  const originalRead = storage.read;
  storage.read = async (...arguments_) => {
    reads += 1;
    return originalRead(...arguments_);
  };
  const result = await updateProjectedRecord({
    ...input(storage),
    maximumConflicts: 2,
    update: (current) => record(current.revision + 1, 'next'),
  });
  assert.equal(result.status, 'conflict');
  assert.equal(reads, 3);
});
