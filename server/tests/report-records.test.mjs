import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REPORT_STORAGE_LIMITS,
  beginSourceCheck,
  catalogMembershipDigest,
  claimRepositoryJob,
  clearRepositoryJob,
  createReportCatalog,
  createRepositoryState,
  finishSourceCheck,
  pageReportCatalog,
  projectReportCatalog,
  projectRepositoryState,
  repairCatalogCurrent,
  rotateRepositoryReport,
  upsertCatalogRepository,
} from '../lib/report-records.mjs';

const at = (minute = 0) =>
  `2026-09-18T12:${String(minute).padStart(2, '0')}:00.000Z`;
const repository = (id) => ({
  id,
  fullName: `cboone/repo-${id}`,
  name: `repo-${id}`,
  private: id % 2 === 0,
  url: `https://github.com/cboone/repo-${id}`,
});
const jobId = 'a'.repeat(64);
const reportId = 'b'.repeat(64);
const pointer = (repositoryId, id = reportId) => ({
  reportId: id,
  versionKey: `owners/99961/repositories/${repositoryId}/versions/${id}`,
  generatedAt: at(4),
  sourceFingerprint: 'c'.repeat(64),
});
const serializedBytes = (value) =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

test('repository state claims, rotates and clears one exact job while preserving current and previous', () => {
  const initial = createRepositoryState(repository(17));
  const claimed = claimRepositoryJob(initial, {
    jobId,
    operation: 'generate',
    expectedCurrentReportId: null,
    admittedAt: at(1),
  });
  const first = rotateRepositoryReport(claimed, {
    jobId,
    expectedCurrentReportId: null,
    current: pointer(17),
  });
  const cleared = clearRepositoryJob(first, {
    jobId,
    lastAnalysisAttempt: {
      jobId,
      operation: 'generate',
      status: 'succeeded',
      completedAt: at(5),
      errorCode: null,
    },
  });
  assert.equal(cleared.current.reportId, reportId);
  assert.equal(cleared.previous, null);
  assert.equal(cleared.activeJob, null);

  const refreshJob = 'd'.repeat(64);
  const refresh = claimRepositoryJob(cleared, {
    jobId: refreshJob,
    operation: 'refresh',
    expectedCurrentReportId: reportId,
    admittedAt: at(6),
  });
  const nextId = 'e'.repeat(64);
  const rotated = rotateRepositoryReport(refresh, {
    jobId: refreshJob,
    expectedCurrentReportId: reportId,
    current: pointer(17, nextId),
  });
  assert.equal(rotated.current.reportId, nextId);
  assert.equal(rotated.previous.reportId, reportId);
});

test('failed or stale publication cannot rotate a newer successful report', () => {
  const state = createRepositoryState(repository(17));
  assert.throws(
    () =>
      rotateRepositoryReport(state, {
        jobId,
        expectedCurrentReportId: null,
        current: pointer(17),
      }),
    { code: 'report_state_changed' },
  );
  const claimed = claimRepositoryJob(state, {
    jobId,
    operation: 'generate',
    expectedCurrentReportId: null,
    admittedAt: at(1),
  });
  assert.throws(
    () =>
      rotateRepositoryReport(claimed, {
        jobId,
        expectedCurrentReportId: 'f'.repeat(64),
        current: pointer(17),
      }),
    { code: 'report_state_changed' },
  );
});

test('repository completion binds the active job, operation, and publication state', () => {
  const claimed = claimRepositoryJob(createRepositoryState(repository(17)), {
    jobId,
    operation: 'generate',
    expectedCurrentReportId: null,
    admittedAt: at(1),
  });
  const attempt = {
    jobId,
    operation: 'generate',
    status: 'failed',
    completedAt: at(5),
    errorCode: 'analysis_provider_unavailable',
  };
  assert.throws(
    () =>
      clearRepositoryJob(claimed, {
        jobId,
        lastAnalysisAttempt: { ...attempt, jobId: 'f'.repeat(64) },
      }),
    { code: 'service_unavailable' },
  );
  assert.throws(
    () =>
      clearRepositoryJob(claimed, {
        jobId,
        lastAnalysisAttempt: { ...attempt, operation: 'refresh' },
      }),
    { code: 'service_unavailable' },
  );
  assert.throws(
    () =>
      clearRepositoryJob(claimed, {
        jobId,
        lastAnalysisAttempt: {
          ...attempt,
          status: 'succeeded',
          errorCode: null,
        },
      }),
    { code: 'service_unavailable' },
  );
  assert.equal(
    clearRepositoryJob(claimed, { jobId, lastAnalysisAttempt: attempt })
      .lastAnalysisAttempt.errorCode,
    'analysis_provider_unavailable',
  );
  assert.equal(
    clearRepositoryJob(claimed, {
      jobId,
      lastAnalysisAttempt: {
        ...attempt,
        status: 'budget-blocked',
        errorCode: 'analysis_unavailable',
      },
    }).lastAnalysisAttempt.errorCode,
    'analysis_unavailable',
  );
});

test('source check sequence prevents stale completions and preserves the saved report', () => {
  const initial = {
    ...createRepositoryState(repository(17)),
    current: pointer(17),
  };
  const checking = beginSourceCheck(projectRepositoryState(initial), {
    startedAt: at(1),
  });
  const newer = beginSourceCheck(checking, { startedAt: at(2) });
  assert.throws(
    () =>
      finishSourceCheck(newer, {
        sequence: 1,
        completedAt: at(3),
        status: 'failed',
        errorCode: 'provider_unavailable',
      }),
    { code: 'source_unstable' },
  );
  const unavailable = finishSourceCheck(newer, {
    sequence: 2,
    completedAt: at(3),
    status: 'source-unavailable',
    errorCode: 'source_unavailable',
  });
  assert.equal(unavailable.current.reportId, reportId);
  assert.equal(unavailable.sourceCheck.status, 'source-unavailable');

  const rateLimited = finishSourceCheck(
    beginSourceCheck(projectRepositoryState(initial), { startedAt: at(1) }),
    {
      sequence: 1,
      completedAt: at(2),
      status: 'failed',
      errorCode: 'provider_rate_limited',
    },
  );
  assert.equal(rateLimited.sourceCheck.errorCode, 'provider_rate_limited');
});

test('catalog membership is sorted, bounded, digest-stable across summary repair and paged by validated cursor', () => {
  let catalog = createReportCatalog(at(0));
  for (let id = 51; id >= 1; id -= 1)
    catalog = upsertCatalogRepository(catalog, {
      repository: repository(id),
      at: at(1),
    });
  assert.equal(catalog.repositories[0].repositoryId, 1);
  assert.equal(catalog.repositories.at(-1).repositoryId, 51);
  const digest = catalogMembershipDigest(catalog);
  const first = pageReportCatalog(catalog);
  assert.equal(first.repositories.length, REPORT_STORAGE_LIMITS.catalogPage);
  assert.ok(first.nextCursor);
  const second = pageReportCatalog(catalog, { cursor: first.nextCursor });
  assert.deepEqual(
    second.repositories.map(({ repositoryId }) => repositoryId),
    [51],
  );
  const state = {
    ...createRepositoryState(repository(1)),
    current: pointer(1),
  };
  const repaired = repairCatalogCurrent(catalog, {
    repositoryState: projectRepositoryState(state),
    at: at(2),
  });
  assert.equal(catalogMembershipDigest(repaired), digest);
  assert.equal(repaired.membershipRevision, catalog.membershipRevision);
  assert.equal(repaired.repositories[0].current.reportId, reportId);
});

test('membership-changing cursors and unknown durable properties fail closed', () => {
  let catalog = upsertCatalogRepository(createReportCatalog(at(0)), {
    repository: repository(1),
    at: at(1),
  });
  for (let id = 2; id <= 51; id += 1)
    catalog = upsertCatalogRepository(catalog, {
      repository: repository(id),
      at: at(1),
    });
  const cursor = pageReportCatalog(catalog).nextCursor;
  const changed = upsertCatalogRepository(catalog, {
    repository: repository(52),
    at: at(2),
  });
  assert.throws(() => pageReportCatalog(changed, { cursor }), {
    code: 'report_catalog_changed',
  });
  assert.throws(
    () => projectReportCatalog({ ...catalog, rawIssueBody: 'private' }),
    { code: 'service_unavailable' },
  );
  assert.throws(
    () =>
      projectRepositoryState({
        ...createRepositoryState(repository(1)),
        repository: { ...repository(1), body: 'private' },
      }),
    { code: 'service_unavailable' },
  );
});

test('repository state bounds the maximum legal record and rejects malformed byte boundaries', () => {
  const maximumInteger = Number.MAX_SAFE_INTEGER;
  const maximumRepository = {
    id: maximumInteger,
    fullName: `cboone/${'r'.repeat(249)}`,
    name: 'r'.repeat(249),
    private: true,
    url: `https://github.com/cboone/${'r'.repeat(249)}`,
  };
  const maximumPointer = (id, fingerprint) => ({
    reportId: id,
    versionKey: `owners/99961/repositories/${maximumInteger}/versions/${id}`,
    generatedAt: at(9),
    sourceFingerprint: fingerprint,
  });
  const maximum = projectRepositoryState({
    ...createRepositoryState(maximumRepository),
    revision: maximumInteger,
    current: maximumPointer('a'.repeat(64), 'b'.repeat(64)),
    previous: maximumPointer('c'.repeat(64), 'd'.repeat(64)),
    activeJob: {
      jobId: 'e'.repeat(64),
      operation: 'refresh',
      expectedCurrentReportId: 'a'.repeat(64),
      admittedAt: at(1),
    },
    sourceCheck: {
      sequence: maximumInteger,
      startedAt: at(1),
      completedAt: at(9),
      status: 'complete',
      summary: {
        status: 'complete',
        repositoryId: maximumInteger,
        fingerprint: 'f'.repeat(64),
        sync: {
          at: at(8),
          branch: String.fromCharCode(0xd800).repeat(256),
          commit: '1'.repeat(64),
          openPullRequests: maximumInteger,
        },
        counts: Object.fromEntries(
          [
            'openIssues',
            'openPullRequests',
            'milestones',
            'labels',
            'branches',
            'unmergedBranches',
            'issueComments',
            'treeEntries',
            'selectedFiles',
          ].map((key) => [key, maximumInteger]),
        ),
      },
      errorCode: null,
    },
    lastAnalysisAttempt: {
      jobId: '2'.repeat(64),
      operation: 'refresh',
      status: 'budget-blocked',
      completedAt: at(9),
      errorCode: 'analysis_provider_rate_limited',
    },
  });
  assert.equal(serializedBytes(maximum), 4407);
  assert.ok(
    serializedBytes(maximum) < REPORT_STORAGE_LIMITS.repositoryStateBytes,
  );

  const emptyMalformed = { ...maximum, rawIssueBody: '' };
  const padding =
    REPORT_STORAGE_LIMITS.repositoryStateBytes -
    serializedBytes(emptyMalformed);
  assert.ok(padding > 0);
  const exactBoundary = {
    ...maximum,
    rawIssueBody: 'x'.repeat(padding),
  };
  assert.equal(
    serializedBytes(exactBoundary),
    REPORT_STORAGE_LIMITS.repositoryStateBytes,
  );
  assert.throws(() => projectRepositoryState(exactBoundary), {
    code: 'service_unavailable',
  });
  const overBoundary = {
    ...exactBoundary,
    rawIssueBody: `${exactBoundary.rawIssueBody}x`,
  };
  assert.equal(
    serializedBytes(overBoundary),
    REPORT_STORAGE_LIMITS.repositoryStateBytes + 1,
  );
  assert.throws(() => projectRepositoryState(overBoundary), {
    code: 'service_unavailable',
  });
});
