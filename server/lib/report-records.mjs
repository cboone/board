import { createHash } from 'node:crypto';
import { BoardError } from './errors.mjs';

export const REPORT_STORAGE_LIMITS = Object.freeze({
  repositoryStateBytes: 8 * 1024,
  catalogEntries: 1000,
  catalogBytes: 1_048_576,
  catalogPage: 50,
  catalogRepairs: 5,
  catalogPagesPerPass: 20,
  reportEnvelopeBytes: 5 * 1024 * 1024,
});

const HEX_64 = /^[a-f0-9]{64}$/u;
const OPERATIONS = new Set(['generate', 'refresh']);
const SOURCE_CHECK_STATES = new Set([
  'checking',
  'complete',
  'failed',
  'source-unavailable',
]);
const ANALYSIS_STATES = new Set([
  'succeeded',
  'failed',
  'ambiguous',
  'superseded',
  'budget-blocked',
]);
const SAFE_ERRORS = new Set([
  'analysis_ambiguous',
  'analysis_input_too_large',
  'analysis_output_invalid',
  'analysis_provider_rate_limited',
  'analysis_provider_unavailable',
  'analysis_sensitive_input',
  'analysis_unavailable',
  'budget_discussion_required',
  'budget_exhausted',
  'pricing_review_required',
  'provider_rate_limited',
  'provider_unavailable',
  'source_authorization_required',
  'source_incomplete',
  'source_limit_exceeded',
  'source_timeout',
  'source_unavailable',
  'source_unstable',
  'superseded',
]);
const fail = () => {
  throw new BoardError('service_unavailable');
};
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const text = (value, max = 4096) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\r\n\0]/u.test(value);
const nullable = (value, check) => value === null || check(value);
const exact = (value, keys) => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
  return value;
};
const iso = (value) => {
  if (
    !text(value, 40) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail();
  return value;
};
const clone = (value) => structuredClone(value);
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const digest = (domain, value) =>
  createHash('sha256')
    .update(`${domain}\0${JSON.stringify(value)}`)
    .digest('hex');

export function projectRepositoryIdentity(value) {
  exact(value, ['id', 'fullName', 'name', 'private', 'url']);
  if (
    !positive(value.id) ||
    !text(value.fullName, 256) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.fullName) ||
    value.fullName.split('/')[0].toLowerCase() !== 'cboone' ||
    value.name !== value.fullName.split('/')[1] ||
    typeof value.private !== 'boolean' ||
    value.url !== `https://github.com/${value.fullName}`
  )
    fail();
  return clone(value);
}

function projectReportPointer(value, repositoryId) {
  if (value === null) return null;
  exact(value, ['reportId', 'versionKey', 'generatedAt', 'sourceFingerprint']);
  if (
    !HEX_64.test(value.reportId) ||
    value.versionKey !==
      `owners/99961/repositories/${repositoryId}/versions/${value.reportId}` ||
    !HEX_64.test(value.sourceFingerprint)
  )
    fail();
  iso(value.generatedAt);
  return clone(value);
}

function projectActiveJob(value) {
  if (value === null) return null;
  exact(value, ['jobId', 'operation', 'expectedCurrentReportId', 'admittedAt']);
  if (
    !HEX_64.test(value.jobId) ||
    !OPERATIONS.has(value.operation) ||
    !nullable(value.expectedCurrentReportId, (item) => HEX_64.test(item)) ||
    (value.operation === 'generate' &&
      value.expectedCurrentReportId !== null) ||
    (value.operation === 'refresh' && value.expectedCurrentReportId === null)
  )
    fail();
  iso(value.admittedAt);
  return clone(value);
}

function projectSafeSourceSummary(value, repositoryId) {
  exact(value, ['status', 'repositoryId', 'fingerprint', 'sync', 'counts']);
  exact(value.sync, ['at', 'branch', 'commit', 'openPullRequests']);
  exact(value.counts, [
    'openIssues',
    'openPullRequests',
    'milestones',
    'labels',
    'branches',
    'unmergedBranches',
    'issueComments',
    'treeEntries',
    'selectedFiles',
  ]);
  if (
    value.status !== 'complete' ||
    value.repositoryId !== repositoryId ||
    !HEX_64.test(value.fingerprint) ||
    !text(value.sync.branch, 256) ||
    /[\s\u0000-\u001f\u007f-\u009f]/u.test(value.sync.branch) ||
    value.sync.branch
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.sync.commit) ||
    !integer(value.sync.openPullRequests) ||
    Object.values(value.counts).some((count) => !integer(count))
  )
    fail();
  iso(value.sync.at);
  return clone(value);
}

function projectSourceCheck(value, repositoryId) {
  if (value === null) return null;
  exact(value, [
    'sequence',
    'startedAt',
    'completedAt',
    'status',
    'summary',
    'errorCode',
  ]);
  if (
    !positive(value.sequence) ||
    !SOURCE_CHECK_STATES.has(value.status) ||
    !nullable(value.completedAt, (item) => Boolean(iso(item))) ||
    !nullable(value.errorCode, (item) => SAFE_ERRORS.has(item))
  )
    fail();
  iso(value.startedAt);
  if (value.status === 'checking') {
    if (
      value.completedAt !== null ||
      value.summary !== null ||
      value.errorCode !== null
    )
      fail();
  } else {
    if (value.completedAt === null) fail();
    if (value.status === 'complete') {
      if (value.errorCode !== null) fail();
      projectSafeSourceSummary(value.summary, repositoryId);
    } else if (value.summary !== null || value.errorCode === null) fail();
  }
  return {
    ...clone(value),
    summary:
      value.summary === null
        ? null
        : projectSafeSourceSummary(value.summary, repositoryId),
  };
}

function projectLastAttempt(value) {
  if (value === null) return null;
  exact(value, ['jobId', 'operation', 'status', 'completedAt', 'errorCode']);
  if (
    !HEX_64.test(value.jobId) ||
    !OPERATIONS.has(value.operation) ||
    !ANALYSIS_STATES.has(value.status) ||
    !nullable(value.errorCode, (item) => SAFE_ERRORS.has(item)) ||
    (value.status === 'succeeded'
      ? value.errorCode !== null
      : value.errorCode === null)
  )
    fail();
  iso(value.completedAt);
  return clone(value);
}

export function projectRepositoryState(value) {
  exact(value, [
    'schemaVersion',
    'ownerId',
    'repository',
    'revision',
    'current',
    'previous',
    'activeJob',
    'sourceCheck',
    'lastAnalysisAttempt',
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.ownerId !== 99961 ||
    !integer(value.revision)
  )
    fail();
  const repository = projectRepositoryIdentity(value.repository);
  const current = projectReportPointer(value.current, repository.id);
  const previous = projectReportPointer(value.previous, repository.id);
  if (current && previous && current.reportId === previous.reportId) fail();
  const projected = {
    ...clone(value),
    repository,
    current,
    previous,
    activeJob: projectActiveJob(value.activeJob),
    sourceCheck: projectSourceCheck(value.sourceCheck, repository.id),
    lastAnalysisAttempt: projectLastAttempt(value.lastAnalysisAttempt),
  };
  if (byteLength(projected) > REPORT_STORAGE_LIMITS.repositoryStateBytes)
    fail();
  return projected;
}

export function createRepositoryState(repository) {
  return projectRepositoryState({
    schemaVersion: 1,
    ownerId: 99961,
    repository: projectRepositoryIdentity(repository),
    revision: 0,
    current: null,
    previous: null,
    activeJob: null,
    sourceCheck: null,
    lastAnalysisAttempt: null,
  });
}

function projectCatalogCurrent(value) {
  if (value === null) return null;
  exact(value, ['reportId', 'generatedAt', 'sourceFingerprint']);
  if (!HEX_64.test(value.reportId) || !HEX_64.test(value.sourceFingerprint))
    fail();
  iso(value.generatedAt);
  return clone(value);
}

function projectCatalogEntry(value) {
  exact(value, [
    'repositoryId',
    'repository',
    'stateKey',
    'createdAt',
    'current',
  ]);
  const repository = projectRepositoryIdentity(value.repository);
  if (
    value.repositoryId !== repository.id ||
    value.stateKey !== `owners/99961/repositories/${repository.id}/state`
  )
    fail();
  iso(value.createdAt);
  return {
    ...clone(value),
    repository,
    current: projectCatalogCurrent(value.current),
  };
}

export function projectReportCatalog(value) {
  exact(value, [
    'schemaVersion',
    'ownerId',
    'revision',
    'membershipRevision',
    'updatedAt',
    'repositories',
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.ownerId !== 99961 ||
    !integer(value.revision) ||
    !integer(value.membershipRevision) ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > REPORT_STORAGE_LIMITS.catalogEntries
  )
    fail();
  iso(value.updatedAt);
  const repositories = value.repositories.map(projectCatalogEntry);
  for (let index = 0; index < repositories.length; index += 1) {
    if (
      index > 0 &&
      repositories[index - 1].repositoryId >= repositories[index].repositoryId
    )
      fail();
  }
  const projected = { ...clone(value), repositories };
  if (byteLength(projected) > REPORT_STORAGE_LIMITS.catalogBytes) fail();
  return projected;
}

export function createReportCatalog(at) {
  return projectReportCatalog({
    schemaVersion: 1,
    ownerId: 99961,
    revision: 0,
    membershipRevision: 0,
    updatedAt: iso(at),
    repositories: [],
  });
}

export function catalogMembershipDigest(input) {
  const catalog = projectReportCatalog(input);
  return digest(
    'board-report-catalog-membership-v1',
    catalog.repositories.map(({ repositoryId, stateKey, createdAt }) => ({
      repositoryId,
      stateKey,
      createdAt,
    })),
  );
}

export function upsertCatalogRepository(input, { repository, at }) {
  const catalog = projectReportCatalog(input);
  const identity = projectRepositoryIdentity(repository);
  const next = clone(catalog);
  const existing = next.repositories.find(
    (entry) => entry.repositoryId === identity.id,
  );
  if (existing) {
    existing.repository = identity;
  } else {
    if (next.repositories.length === REPORT_STORAGE_LIMITS.catalogEntries)
      throw new BoardError('report_catalog_full');
    next.repositories.push({
      repositoryId: identity.id,
      repository: identity,
      stateKey: `owners/99961/repositories/${identity.id}/state`,
      createdAt: iso(at),
      current: null,
    });
    next.repositories.sort(
      (left, right) => left.repositoryId - right.repositoryId,
    );
    next.membershipRevision += 1;
  }
  next.revision += 1;
  next.updatedAt = at;
  return projectReportCatalog(next);
}

export function repairCatalogCurrent(input, { repositoryState, at }) {
  const catalog = projectReportCatalog(input);
  const state = projectRepositoryState(repositoryState);
  const next = clone(catalog);
  const entry = next.repositories.find(
    (item) => item.repositoryId === state.repository.id,
  );
  if (!entry) fail();
  entry.repository = state.repository;
  entry.current = state.current
    ? {
        reportId: state.current.reportId,
        generatedAt: state.current.generatedAt,
        sourceFingerprint: state.current.sourceFingerprint,
      }
    : null;
  next.revision += 1;
  next.updatedAt = iso(at);
  return projectReportCatalog(next);
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
function decodeCursor(value) {
  try {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 1024 ||
      Buffer.from(value, 'base64url').toString('base64url') !== value
    )
      fail();
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    exact(decoded, [
      'schemaVersion',
      'membershipRevision',
      'membershipDigest',
      'lastRepositoryId',
    ]);
    if (
      decoded.schemaVersion !== 1 ||
      !integer(decoded.membershipRevision) ||
      !HEX_64.test(decoded.membershipDigest) ||
      !positive(decoded.lastRepositoryId)
    )
      fail();
    return decoded;
  } catch {
    fail();
  }
}

export function pageReportCatalog(input, { cursor = null } = {}) {
  const catalog = projectReportCatalog(input);
  const membershipDigest = catalogMembershipDigest(catalog);
  const decoded = cursor === null ? null : decodeCursor(cursor);
  if (
    decoded &&
    (decoded.membershipRevision !== catalog.membershipRevision ||
      decoded.membershipDigest !== membershipDigest)
  )
    throw new BoardError('report_catalog_changed');
  const start = decoded
    ? catalog.repositories.findIndex(
        (entry) => entry.repositoryId > decoded.lastRepositoryId,
      )
    : 0;
  const effectiveStart = start === -1 ? catalog.repositories.length : start;
  const repositories = catalog.repositories.slice(
    effectiveStart,
    effectiveStart + REPORT_STORAGE_LIMITS.catalogPage,
  );
  const hasMore =
    effectiveStart + repositories.length < catalog.repositories.length;
  const last = repositories.at(-1);
  return {
    repositories,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            schemaVersion: 1,
            membershipRevision: catalog.membershipRevision,
            membershipDigest,
            lastRepositoryId: last.repositoryId,
          })
        : null,
  };
}

export function claimRepositoryJob(
  input,
  { jobId, operation, expectedCurrentReportId, admittedAt },
) {
  const state = projectRepositoryState(input);
  if (state.activeJob !== null || !HEX_64.test(jobId)) fail();
  if (
    (operation === 'generate' &&
      (expectedCurrentReportId !== null || state.current !== null)) ||
    (operation === 'refresh' &&
      (state.current === null ||
        expectedCurrentReportId !== state.current.reportId))
  )
    throw new BoardError('report_state_changed');
  const next = clone(state);
  next.activeJob = {
    jobId,
    operation,
    expectedCurrentReportId,
    admittedAt: iso(admittedAt),
  };
  next.revision += 1;
  return projectRepositoryState(next);
}

export function rotateRepositoryReport(
  input,
  { jobId, expectedCurrentReportId, current },
) {
  const state = projectRepositoryState(input);
  const projectedCurrent = projectReportPointer(current, state.repository.id);
  if (
    state.activeJob?.jobId !== jobId ||
    state.activeJob.expectedCurrentReportId !== expectedCurrentReportId ||
    (state.current?.reportId ?? null) !== expectedCurrentReportId
  )
    throw new BoardError('report_state_changed');
  if (projectedCurrent.reportId === expectedCurrentReportId)
    throw new BoardError('report_state_changed');
  const next = clone(state);
  next.previous = next.current;
  next.current = projectedCurrent;
  next.revision += 1;
  return projectRepositoryState(next);
}

export function clearRepositoryJob(input, { jobId, lastAnalysisAttempt }) {
  const state = projectRepositoryState(input);
  if (state.activeJob?.jobId !== jobId) fail();
  const projectedAttempt = projectLastAttempt(lastAnalysisAttempt);
  if (
    projectedAttempt.jobId !== state.activeJob.jobId ||
    projectedAttempt.operation !== state.activeJob.operation
  )
    fail();
  const published =
    state.current !== null &&
    state.current.reportId !== state.activeJob.expectedCurrentReportId;
  if (
    (projectedAttempt.status === 'succeeded' && !published) ||
    (projectedAttempt.status !== 'succeeded' &&
      projectedAttempt.status !== 'superseded' &&
      published)
  )
    fail();
  const next = clone(state);
  next.activeJob = null;
  next.lastAnalysisAttempt = projectedAttempt;
  next.revision += 1;
  return projectRepositoryState(next);
}

export function beginSourceCheck(input, { startedAt }) {
  const state = projectRepositoryState(input);
  const checkedAt = iso(startedAt);
  if (
    state.sourceCheck !== null &&
    Date.parse(checkedAt) < Date.parse(state.sourceCheck.startedAt)
  )
    throw new BoardError('source_unstable');
  const next = clone(state);
  next.sourceCheck = {
    sequence: (next.sourceCheck?.sequence ?? 0) + 1,
    startedAt: checkedAt,
    completedAt: null,
    status: 'checking',
    summary: null,
    errorCode: null,
  };
  next.revision += 1;
  return projectRepositoryState(next);
}

export function finishSourceCheck(
  input,
  { sequence, completedAt, status, summary = null, errorCode = null },
) {
  const state = projectRepositoryState(input);
  if (
    state.sourceCheck?.status !== 'checking' ||
    state.sourceCheck.sequence !== sequence ||
    status === 'checking'
  )
    throw new BoardError('source_unstable');
  const next = clone(state);
  next.sourceCheck = {
    ...next.sourceCheck,
    completedAt: iso(completedAt),
    status,
    summary,
    errorCode,
  };
  next.revision += 1;
  return projectRepositoryState(next);
}
