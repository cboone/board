import { BoardError } from './errors.mjs';
import { canonicalStringify } from './fingerprint.mjs';
import {
  createProjectedRecord,
  readProjectedRecord,
  updateProjectedRecord,
} from './cas-records.mjs';
import {
  REPORT_STORAGE_LIMITS,
  beginSourceCheck as beginSourceCheckRecord,
  claimRepositoryJob as claimRepositoryJobRecord,
  clearRepositoryJob as clearRepositoryJobRecord,
  createReportCatalog,
  createRepositoryState,
  finishSourceCheck as finishSourceCheckRecord,
  pageReportCatalog,
  projectReportCatalog,
  projectRepositoryIdentity,
  projectRepositoryState,
  repairCatalogCurrent,
  rotateRepositoryReport as rotateRepositoryReportRecord,
  upsertCatalogRepository,
} from './report-records.mjs';
import {
  projectSuccessfulReportVersion,
  successfulReportVersionKey,
  writeSuccessfulReportVersion,
} from './report-versions.mjs';

export const REPORT_CATALOG_KEY = 'owners/99961/catalog';

const HEX_64 = /^[a-f0-9]{64}$/u;
const unavailable = () => new BoardError('service_unavailable');
const same = (left, right) =>
  canonicalStringify(left) === canonicalStringify(right);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export function repositoryStateKey(repositoryId) {
  if (!positive(repositoryId)) throw unavailable();
  return `owners/99961/repositories/${repositoryId}/state`;
}

function catalogOptions(storage, budget) {
  return {
    storage,
    budget,
    key: REPORT_CATALOG_KEY,
    project: projectReportCatalog,
  };
}

function stateOptions(storage, budget, repositoryId) {
  return {
    storage,
    budget,
    key: repositoryStateKey(repositoryId),
    project: projectRepositoryState,
  };
}

function resultRecord(result, field) {
  if (
    !result ||
    !['created', 'existing', 'updated', 'unchanged'].includes(result.status)
  )
    throw unavailable();
  return {
    status: result.status,
    [field]: result.value,
    etag: result.etag,
  };
}

function catalogEntry(catalog, repositoryId) {
  return catalog.repositories.find(
    (entry) => entry.repositoryId === repositoryId,
  );
}

function catalogCurrent(state) {
  return state.current === null
    ? null
    : {
        reportId: state.current.reportId,
        generatedAt: state.current.generatedAt,
        sourceFingerprint: state.current.sourceFingerprint,
      };
}

function catalogEntryMatchesState(entry, state) {
  return (
    entry !== undefined &&
    same(entry.repository, state.repository) &&
    same(entry.current, catalogCurrent(state))
  );
}

function safeCatalogUpsert(catalog, repository, at) {
  const existing = catalogEntry(catalog, repository.id);
  if (existing && same(existing.repository, repository)) return catalog;
  try {
    return upsertCatalogRepository(catalog, { repository, at });
  } catch (error) {
    if (
      existing &&
      error instanceof BoardError &&
      error.code === 'service_unavailable'
    )
      return catalog;
    if (error instanceof BoardError && error.code === 'service_unavailable')
      throw new BoardError('report_catalog_full');
    throw error;
  }
}

async function confirmCatalogMembership(options, repositoryId) {
  const confirmed = await readProjectedRecord(options);
  if (
    confirmed === null ||
    catalogEntry(confirmed.value, repositoryId) === undefined
  )
    throw unavailable();
  return confirmed;
}

/** Ensure the bounded discovery root contains this repository exactly once. */
export async function ensureCatalogRepository({
  storage,
  budget,
  repository,
  at,
}) {
  const identity = projectRepositoryIdentity(repository);
  const empty = createReportCatalog(at);
  const options = catalogOptions(storage, budget);
  const current = await readProjectedRecord(options);
  if (current === null) {
    const value = safeCatalogUpsert(empty, identity, at);
    const created = await createProjectedRecord({ ...options, value });
    if (['created', 'existing'].includes(created.status)) {
      const confirmed = await confirmCatalogMembership(options, identity.id);
      return {
        status: created.status,
        catalog: confirmed.value,
        etag: confirmed.etag,
      };
    }
    if (created.status === 'absent') throw unavailable();
  }
  const updated = await updateProjectedRecord({
    ...options,
    update: (catalog) => safeCatalogUpsert(catalog, identity, at),
  });
  const selected = resultRecord(updated, 'catalog');
  const confirmed = await confirmCatalogMembership(options, identity.id);
  return {
    ...selected,
    catalog: confirmed.value,
    etag: confirmed.etag,
  };
}

/** Strong-read a repository state by its validated numeric identity. */
export async function readRepositoryState({ storage, budget, repositoryId }) {
  const record = await readProjectedRecord(
    stateOptions(storage, budget, repositoryId),
  );
  if (record === null) return null;
  if (record.value.repository.id !== repositoryId) throw unavailable();
  return { state: record.value, etag: record.etag };
}

function withRepositoryIdentity(state, repository) {
  if (state.repository.id !== repository.id) throw unavailable();
  if (same(state.repository, repository)) return state;
  return projectRepositoryState({
    ...state,
    repository,
    revision: state.revision + 1,
  });
}

/** Create admission state once, or CAS-refresh its last trusted identity. */
export async function readOrCreateRepositoryState({
  storage,
  budget,
  repository,
}) {
  const identity = projectRepositoryIdentity(repository);
  const options = stateOptions(storage, budget, identity.id);
  const current = await readProjectedRecord(options);
  if (current === null) {
    const created = await createProjectedRecord({
      ...options,
      value: createRepositoryState(identity),
    });
    if (['created', 'existing'].includes(created.status))
      return resultRecord(created, 'state');
    if (created.status === 'absent') throw unavailable();
  }
  const updated = await updateProjectedRecord({
    ...options,
    update: (state) => withRepositoryIdentity(state, identity),
  });
  return resultRecord(updated, 'state');
}

async function updateRepositoryState({
  storage,
  budget,
  repositoryId,
  update,
}) {
  const result = await updateProjectedRecord({
    ...stateOptions(storage, budget, repositoryId),
    update,
  });
  return resultRecord(result, 'state');
}

/** Claim the repository's one active job, recognizing an exact replay. */
export async function claimRepositoryJob({
  storage,
  budget,
  repositoryId,
  jobId,
  operation,
  expectedCurrentReportId,
  admittedAt,
}) {
  const claim = {
    jobId,
    operation,
    expectedCurrentReportId,
    admittedAt,
  };
  return updateRepositoryState({
    storage,
    budget,
    repositoryId,
    update: (state) => {
      if (state.activeJob !== null) {
        if (same(state.activeJob, claim)) return state;
        throw new BoardError('analysis_in_progress');
      }
      return claimRepositoryJobRecord(state, claim);
    },
  });
}

/** Rotate current/previous only for the admitted active job and exact basis. */
export async function rotateRepositoryReport({
  storage,
  budget,
  repositoryId,
  jobId,
  expectedCurrentReportId,
  current,
}) {
  return updateRepositoryState({
    storage,
    budget,
    repositoryId,
    update: (state) => {
      if (
        state.activeJob?.jobId === jobId &&
        state.activeJob.expectedCurrentReportId === expectedCurrentReportId &&
        same(state.current, current) &&
        (state.previous?.reportId ?? null) === expectedCurrentReportId
      )
        return state;
      return rotateRepositoryReportRecord(state, {
        jobId,
        expectedCurrentReportId,
        current,
      });
    },
  });
}

/** Clear only the matching active job, recognizing an exact completed replay. */
export async function clearRepositoryJob({
  storage,
  budget,
  repositoryId,
  jobId,
  lastAnalysisAttempt,
}) {
  return updateRepositoryState({
    storage,
    budget,
    repositoryId,
    update: (state) => {
      if (
        state.activeJob === null &&
        state.lastAnalysisAttempt !== null &&
        state.lastAnalysisAttempt.jobId === jobId &&
        same(state.lastAnalysisAttempt, lastAnalysisAttempt)
      )
        return state;
      return clearRepositoryJobRecord(state, {
        jobId,
        lastAnalysisAttempt,
      });
    },
  });
}

/** CAS-start a newer source-check sequence. */
export async function beginSourceCheck({
  storage,
  budget,
  repositoryId,
  startedAt,
}) {
  return updateRepositoryState({
    storage,
    budget,
    repositoryId,
    update: (state) => beginSourceCheckRecord(state, { startedAt }),
  });
}

/** Publish only the matching source-check sequence, with exact replay support. */
export async function finishSourceCheck({
  storage,
  budget,
  repositoryId,
  sequence,
  completedAt,
  status,
  summary = null,
  errorCode = null,
}) {
  const completion = {
    sequence,
    completedAt,
    status,
    summary,
    errorCode,
  };
  return updateRepositoryState({
    storage,
    budget,
    repositoryId,
    update: (state) => {
      if (
        state.sourceCheck !== null &&
        state.sourceCheck.sequence === completion.sequence &&
        state.sourceCheck.completedAt === completion.completedAt &&
        state.sourceCheck.status === completion.status &&
        same(state.sourceCheck.summary, completion.summary) &&
        state.sourceCheck.errorCode === completion.errorCode
      )
        return state;
      return finishSourceCheckRecord(state, completion);
    },
  });
}

/** Repair one existing catalog summary without changing membership. */
export async function repairCatalogRepository({
  storage,
  budget,
  repositoryState,
  at,
}) {
  createReportCatalog(at);
  const state = projectRepositoryState(repositoryState);
  const options = catalogOptions(storage, budget);
  let skippedCapacity = false;
  const result = await updateProjectedRecord({
    ...options,
    update: (catalog) => {
      const entry = catalogEntry(catalog, state.repository.id);
      if (!entry) throw unavailable();
      if (catalogEntryMatchesState(entry, state)) return catalog;
      try {
        return repairCatalogCurrent(catalog, { repositoryState: state, at });
      } catch (error) {
        if (
          error instanceof BoardError &&
          error.code === 'service_unavailable'
        ) {
          skippedCapacity = true;
          return catalog;
        }
        throw error;
      }
    },
  });
  const selected = resultRecord(result, 'catalog');
  return {
    ...selected,
    status: skippedCapacity
      ? 'skipped-capacity'
      : selected.status === 'updated'
        ? 'repaired'
        : 'unchanged',
  };
}

function catalogListItem(state) {
  return {
    repositoryId: state.repository.id,
    repository: state.repository,
    current: state.current,
    sourceCheck: state.sourceCheck,
    activeJob: state.activeJob,
    lastAnalysisAttempt: state.lastAnalysisAttempt,
  };
}

/**
 * Read one catalog page, then project its at-most-50 strong state reads. Stale
 * summaries are repaired separately and never determine the returned items.
 */
export async function readCatalogPage({ storage, budget, cursor = null, at }) {
  createReportCatalog(at);
  const stored = await readProjectedRecord(catalogOptions(storage, budget));
  if (stored === null)
    return {
      items: [],
      nextCursor: null,
      examined: 0,
      repairAttempts: 0,
      repairs: 0,
    };
  const page = pageReportCatalog(stored.value, { cursor });
  if (page.repositories.length > REPORT_STORAGE_LIMITS.catalogPage)
    throw unavailable();
  const states = [];
  for (const entry of page.repositories) {
    const record = await readProjectedRecord({
      storage,
      budget,
      key: entry.stateKey,
      project: projectRepositoryState,
    });
    if (record === null) {
      states.push({ entry, state: null });
      continue;
    }
    if (record.value.repository.id !== entry.repositoryId) throw unavailable();
    states.push({ entry, state: record.value });
  }
  let repairAttempts = 0;
  let repairs = 0;
  for (const { entry, state } of states) {
    if (
      state === null ||
      catalogEntryMatchesState(entry, state) ||
      repairAttempts === REPORT_STORAGE_LIMITS.catalogRepairs
    )
      continue;
    repairAttempts += 1;
    const result = await repairCatalogRepository({
      storage,
      budget,
      repositoryState: state,
      at,
    });
    if (result.status === 'repaired') repairs += 1;
  }
  return {
    items: states
      .filter(({ state }) => state !== null && state.current !== null)
      .map(({ state }) => catalogListItem(state)),
    nextCursor: page.nextCursor,
    examined: page.repositories.length,
    repairAttempts,
    repairs,
  };
}

/** Strong-read and validate one immutable version by exact storage identity. */
export async function readReportEnvelope({
  storage,
  budget,
  repositoryId,
  reportId,
}) {
  if (!positive(repositoryId) || !HEX_64.test(reportId)) throw unavailable();
  const key = `owners/99961/repositories/${repositoryId}/versions/${reportId}`;
  const record = await readProjectedRecord({
    storage,
    budget,
    key,
    project: projectSuccessfulReportVersion,
  });
  if (record === null) return null;
  if (
    record.value.repositoryId !== repositoryId ||
    record.value.reportId !== reportId
  )
    throw unavailable();
  return { key, envelope: record.value, etag: record.etag };
}

function pointerMatchesEnvelope(pointer, envelope) {
  return (
    pointer.reportId === envelope.reportId &&
    pointer.versionKey === successfulReportVersionKey(envelope) &&
    pointer.generatedAt === envelope.generatedAt &&
    pointer.sourceFingerprint === envelope.source.fingerprint.value
  );
}

/** Read the current pointer and envelope, then idempotently repair its catalog. */
export async function readCurrentReportEnvelope({
  storage,
  budget,
  repositoryId,
  at,
}) {
  createReportCatalog(at);
  const storedState = await readRepositoryState({
    storage,
    budget,
    repositoryId,
  });
  if (storedState === null)
    return { state: null, envelope: null, catalogRepair: 'not-applicable' };
  let envelope = null;
  if (storedState.state.current !== null) {
    const storedVersion = await readReportEnvelope({
      storage,
      budget,
      repositoryId,
      reportId: storedState.state.current.reportId,
    });
    if (
      storedVersion === null ||
      !pointerMatchesEnvelope(storedState.state.current, storedVersion.envelope)
    )
      throw unavailable();
    envelope = storedVersion.envelope;
  }
  const repair = await repairCatalogRepository({
    storage,
    budget,
    repositoryState: storedState.state,
    at,
  });
  return {
    state: storedState.state,
    envelope,
    catalogRepair: repair.status,
  };
}

/** Write one deterministic immutable version with exact read-back proof. */
export async function writeImmutableReportVersion({
  storage,
  budget,
  versionKey,
  version,
}) {
  return writeSuccessfulReportVersion({
    storage,
    budget,
    version,
    versionKey,
  });
}

/** Bind a board-reports storage adapter and operation budget for callers. */
export function createReportStore({ storage, budget }) {
  const bind =
    (operation) =>
    (input = {}) =>
      operation({ ...input, storage, budget });
  return Object.freeze({
    ensureCatalogRepository: bind(ensureCatalogRepository),
    readCatalogPage: bind(readCatalogPage),
    readRepositoryState: bind(readRepositoryState),
    readOrCreateRepositoryState: bind(readOrCreateRepositoryState),
    claimRepositoryJob: bind(claimRepositoryJob),
    rotateRepositoryReport: bind(rotateRepositoryReport),
    clearRepositoryJob: bind(clearRepositoryJob),
    beginSourceCheck: bind(beginSourceCheck),
    finishSourceCheck: bind(finishSourceCheck),
    repairCatalogRepository: bind(repairCatalogRepository),
    readReportEnvelope: bind(readReportEnvelope),
    readCurrentReportEnvelope: bind(readCurrentReportEnvelope),
    writeImmutableReportVersion: bind(writeImmutableReportVersion),
  });
}
