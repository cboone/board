import { BoardError } from './errors.mjs';
import { canonicalStringify } from './fingerprint.mjs';

export const CAS_RECORD_LIMITS = Object.freeze({ conflicts: 8 });

const unavailable = () => new BoardError('service_unavailable');
const same = (left, right) =>
  canonicalStringify(left) === canonicalStringify(right);
const projected = (project, value) => {
  try {
    return project(value);
  } catch (error) {
    throw error instanceof BoardError ? error : unavailable();
  }
};

function options(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.storage?.read !== 'function' ||
    typeof value.storage?.write !== 'function' ||
    typeof value.key !== 'string' ||
    typeof value.project !== 'function' ||
    !value.budget
  )
    throw unavailable();
  return value;
}

export async function readProjectedRecord(input) {
  const { storage, key, project, budget } = options(input);
  const record = await storage.read(key, { budget });
  if (record === null) return null;
  return { value: projected(project, record.value), etag: record.etag };
}

async function resolveCreate(input, expected) {
  const current = await readProjectedRecord(input);
  if (current === null) return { status: 'absent' };
  return same(current.value, expected)
    ? { status: 'existing', ...current }
    : { status: 'conflict', ...current };
}

export async function createProjectedRecord(input) {
  const selected = options(input);
  const value = projected(selected.project, input.value);
  try {
    const write = await selected.storage.write(
      selected.key,
      value,
      { onlyIfNew: true },
      { budget: selected.budget },
    );
    if (write.modified) return { status: 'created', value, etag: write.etag };
  } catch {}
  return resolveCreate(selected, value);
}

export async function updateProjectedRecord(input) {
  const selected = options(input);
  if (typeof input.update !== 'function') throw unavailable();
  const maximum = input.maximumConflicts ?? CAS_RECORD_LIMITS.conflicts;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32)
    throw unavailable();
  let current = await readProjectedRecord(selected);
  if (current === null) return { status: 'absent' };
  for (let conflict = 0; conflict < maximum; conflict += 1) {
    let updated;
    try {
      updated = input.update(structuredClone(current.value));
    } catch (error) {
      throw error instanceof BoardError ? error : unavailable();
    }
    const expected = projected(selected.project, updated);
    if (same(expected, current.value))
      return { status: 'unchanged', ...current };
    let write;
    try {
      write = await selected.storage.write(
        selected.key,
        expected,
        { onlyIfMatch: current.etag },
        { budget: selected.budget },
      );
      if (write.modified)
        return { status: 'updated', value: expected, etag: write.etag };
    } catch {}
    const observed = await readProjectedRecord(selected);
    if (observed === null) throw unavailable();
    if (same(observed.value, expected))
      return { status: 'updated', ...observed };
    current = observed;
  }
  return { status: 'conflict', ...current };
}
