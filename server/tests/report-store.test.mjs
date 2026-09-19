import assert from 'node:assert/strict';
import test from 'node:test';
import { ANALYSIS_INPUT_LIMITS } from '../lib/analysis-input.mjs';
import { deriveAnalysisJobIdentity } from '../lib/jobs.mjs';
import {
  createReportCatalog,
  createRepositoryState,
  projectRepositoryState,
  upsertCatalogRepository,
} from '../lib/report-records.mjs';
import {
  REPORT_ANALYSIS_SCHEMA_VERSION,
  REPORT_ASSEMBLER_VERSION,
  REPORT_PROMPT_VERSION,
  SUCCESSFUL_REPORT_VERSION_SCHEMA_VERSION,
} from '../lib/report-versions.mjs';
import {
  REPORT_CATALOG_KEY,
  beginSourceCheck,
  claimRepositoryJob,
  clearRepositoryJob,
  ensureCatalogRepository,
  finishSourceCheck,
  readCatalogPage,
  readCurrentReportEnvelope,
  readOrCreateRepositoryState,
  readReportEnvelope,
  readRepositoryState,
  repositoryStateKey,
  rotateRepositoryReport,
  writeImmutableReportVersion,
} from '../lib/report-store.mjs';
import { createInitialComparison } from '../../src/domain/report-comparison.js';

const budget = Object.freeze({ name: 'synthetic-budget' });
const at = (minute = 0) =>
  `2026-09-18T12:${String(minute).padStart(2, '0')}:00.000Z`;
const repository = (id) => ({
  id,
  fullName: `cboone/repo-${id}`,
  name: `repo-${id}`,
  private: id % 2 === 0,
  url: `https://github.com/cboone/repo-${id}`,
});
const pointer = (repositoryId, reportId = 'b'.repeat(64)) => ({
  reportId,
  versionKey: `owners/99961/repositories/${repositoryId}/versions/${reportId}`,
  generatedAt: at(4),
  sourceFingerprint: 'c'.repeat(64),
});

function memoryStorage(initial = []) {
  const records = new Map();
  const lost = new Set();
  const metrics = { reads: [], writes: [], lists: 0 };
  let sequence = 0;
  const seed = (key, value) => {
    sequence += 1;
    records.set(key, {
      value: structuredClone(value),
      etag: `"etag-${sequence}"`,
    });
  };
  for (const [key, value] of initial) seed(key, value);
  return {
    async read(key, options) {
      assert.deepEqual(options, { budget });
      metrics.reads.push(key);
      const current = records.get(key);
      return current === undefined
        ? null
        : { value: structuredClone(current.value), etag: current.etag };
    },
    async write(key, value, condition, options) {
      assert.deepEqual(options, { budget });
      metrics.writes.push({ key, condition: structuredClone(condition) });
      const current = records.get(key);
      if (
        (condition.onlyIfNew === true && current !== undefined) ||
        (condition.onlyIfMatch !== undefined &&
          current?.etag !== condition.onlyIfMatch)
      )
        return { modified: false };
      seed(key, value);
      if (lost.delete(key)) throw new Error('synthetic lost acknowledgement');
      return { modified: true, etag: records.get(key).etag };
    },
    async listKeys() {
      metrics.lists += 1;
      throw new Error('report persistence must not list keys');
    },
    loseNextAcknowledgement(key) {
      lost.add(key);
    },
    seed,
    value(key) {
      return records.has(key) ? structuredClone(records.get(key).value) : null;
    },
    metrics,
  };
}

test('concurrent catalog ensures merge membership without listing or duplication', async () => {
  const storage = memoryStorage();
  await Promise.all([
    ensureCatalogRepository({
      storage,
      budget,
      repository: repository(2),
      at: at(0),
    }),
    ensureCatalogRepository({
      storage,
      budget,
      repository: repository(1),
      at: at(0),
    }),
  ]);
  const catalog = storage.value(REPORT_CATALOG_KEY);
  assert.deepEqual(
    catalog.repositories.map(({ repositoryId }) => repositoryId),
    [1, 2],
  );
  assert.equal(catalog.membershipRevision, 2);
  const repeated = await ensureCatalogRepository({
    storage,
    budget,
    repository: repository(1),
    at: at(1),
  });
  assert.equal(repeated.status, 'unchanged');
  assert.equal(repeated.catalog.membershipRevision, 2);
  assert.equal(storage.metrics.lists, 0);
});

test('catalog and state creation recover only from exact lost acknowledgements', async () => {
  const storage = memoryStorage();
  storage.loseNextAcknowledgement(REPORT_CATALOG_KEY);
  const catalog = await ensureCatalogRepository({
    storage,
    budget,
    repository: repository(17),
    at: at(0),
  });
  assert.equal(catalog.status, 'existing');
  assert.equal(catalog.catalog.repositories.length, 1);

  const stateKey = repositoryStateKey(17);
  storage.loseNextAcknowledgement(stateKey);
  const state = await readOrCreateRepositoryState({
    storage,
    budget,
    repository: repository(17),
  });
  assert.equal(state.status, 'existing');
  assert.equal(state.state.repository.id, 17);
  assert.equal(storage.metrics.lists, 0);
});

test('claim, rotation and clear are CAS fenced, replayable and lost-ack safe', async () => {
  const storage = memoryStorage();
  await readOrCreateRepositoryState({
    storage,
    budget,
    repository: repository(17),
  });
  const stateKey = repositoryStateKey(17);
  const jobId = 'a'.repeat(64);
  storage.loseNextAcknowledgement(stateKey);
  const claimed = await claimRepositoryJob({
    storage,
    budget,
    repositoryId: 17,
    jobId,
    operation: 'generate',
    expectedCurrentReportId: null,
    admittedAt: at(1),
  });
  assert.equal(claimed.status, 'updated');
  const claimRevision = claimed.state.revision;
  const replayedClaim = await claimRepositoryJob({
    storage,
    budget,
    repositoryId: 17,
    jobId,
    operation: 'generate',
    expectedCurrentReportId: null,
    admittedAt: at(1),
  });
  assert.equal(replayedClaim.status, 'unchanged');
  assert.equal(replayedClaim.state.revision, claimRevision);
  await assert.rejects(
    claimRepositoryJob({
      storage,
      budget,
      repositoryId: 17,
      jobId: 'f'.repeat(64),
      operation: 'generate',
      expectedCurrentReportId: null,
      admittedAt: at(1),
    }),
    { code: 'analysis_in_progress' },
  );

  const current = pointer(17);
  storage.loseNextAcknowledgement(stateKey);
  const rotated = await rotateRepositoryReport({
    storage,
    budget,
    repositoryId: 17,
    jobId,
    expectedCurrentReportId: null,
    current,
  });
  assert.equal(rotated.state.current.reportId, current.reportId);
  const rotationRevision = rotated.state.revision;
  const replayedRotation = await rotateRepositoryReport({
    storage,
    budget,
    repositoryId: 17,
    jobId,
    expectedCurrentReportId: null,
    current,
  });
  assert.equal(replayedRotation.status, 'unchanged');
  assert.equal(replayedRotation.state.revision, rotationRevision);

  const lastAnalysisAttempt = {
    jobId,
    operation: 'generate',
    status: 'succeeded',
    completedAt: at(5),
    errorCode: null,
  };
  storage.loseNextAcknowledgement(stateKey);
  const cleared = await clearRepositoryJob({
    storage,
    budget,
    repositoryId: 17,
    jobId,
    lastAnalysisAttempt,
  });
  assert.equal(cleared.state.activeJob, null);
  const clearRevision = cleared.state.revision;
  const replayedClear = await clearRepositoryJob({
    storage,
    budget,
    repositoryId: 17,
    jobId,
    lastAnalysisAttempt,
  });
  assert.equal(replayedClear.status, 'unchanged');
  assert.equal(replayedClear.state.revision, clearRevision);
});

test('source check sequencing rejects stale completion and replays the exact winner', async () => {
  const storage = memoryStorage([
    [repositoryStateKey(17), createRepositoryState(repository(17))],
  ]);
  const first = await beginSourceCheck({
    storage,
    budget,
    repositoryId: 17,
    startedAt: at(1),
  });
  const second = await beginSourceCheck({
    storage,
    budget,
    repositoryId: 17,
    startedAt: at(2),
  });
  assert.equal(first.state.sourceCheck.sequence, 1);
  assert.equal(second.state.sourceCheck.sequence, 2);
  await assert.rejects(
    finishSourceCheck({
      storage,
      budget,
      repositoryId: 17,
      sequence: 1,
      completedAt: at(3),
      status: 'failed',
      errorCode: 'provider_unavailable',
      repository: {
        ...repository(17),
        name: 'stale-name',
        fullName: 'cboone/stale-name',
        url: 'https://github.com/cboone/stale-name',
      },
    }),
    { code: 'source_unstable' },
  );
  assert.equal(
    (await readRepositoryState({ storage, budget, repositoryId: 17 })).state
      .repository.name,
    repository(17).name,
  );
  storage.loseNextAcknowledgement(repositoryStateKey(17));
  const currentRepository = {
    ...repository(17),
    name: 'current-name',
    fullName: 'cboone/current-name',
    url: 'https://github.com/cboone/current-name',
  };
  const finished = await finishSourceCheck({
    storage,
    budget,
    repositoryId: 17,
    sequence: 2,
    completedAt: at(3),
    status: 'failed',
    errorCode: 'provider_unavailable',
    repository: currentRepository,
  });
  assert.equal(finished.state.sourceCheck.status, 'failed');
  assert.deepEqual(finished.state.repository, currentRepository);
  const revision = finished.state.revision;
  const replayed = await finishSourceCheck({
    storage,
    budget,
    repositoryId: 17,
    sequence: 2,
    completedAt: at(3),
    status: 'failed',
    errorCode: 'provider_unavailable',
    repository: currentRepository,
  });
  assert.equal(replayed.status, 'unchanged');
  assert.equal(replayed.state.revision, revision);
});

test('catalog page examines fifty states, returns state-derived items and repairs only five summaries', async () => {
  let catalog = createReportCatalog(at(0));
  const initial = [];
  for (let id = 1; id <= 51; id += 1) {
    catalog = upsertCatalogRepository(catalog, {
      repository: repository(id),
      at: at(0),
    });
    let state = createRepositoryState(repository(id));
    if (id <= 6)
      state = projectRepositoryState({ ...state, current: pointer(id) });
    initial.push([repositoryStateKey(id), state]);
  }
  initial.push([REPORT_CATALOG_KEY, catalog]);
  const storage = memoryStorage(initial);
  const page = await readCatalogPage({
    storage,
    budget,
    at: at(6),
  });
  assert.equal(page.examined, 50);
  assert.equal(page.items.length, 6);
  assert.equal(page.repairAttempts, 5);
  assert.equal(page.repairs, 5);
  assert.ok(page.nextCursor);
  assert.equal(
    storage.metrics.reads.filter((key) => key.endsWith('/state')).length,
    50,
  );
  const repaired = storage.value(REPORT_CATALOG_KEY);
  assert.deepEqual(
    repaired.repositories.slice(0, 6).map(({ current }) => current !== null),
    [true, true, true, true, true, false],
  );
  assert.equal(storage.metrics.lists, 0);

  const second = await readCatalogPage({
    storage,
    budget,
    cursor: page.nextCursor,
    at: at(7),
  });
  assert.equal(second.examined, 1);
  assert.deepEqual(second.items, []);
  assert.equal(second.nextCursor, null);
});

function reportVersion() {
  const repositoryId = 17;
  const identity = deriveAnalysisJobIdentity({
    ownerId: 99961,
    repositoryId,
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  });
  const generatedAt = at(4);
  const sync = {
    at: at(2),
    timeZone: 'UTC',
    branch: 'main',
    commit: 'a'.repeat(40),
    openPullRequests: 0,
  };
  const item = {
    id: 9001,
    number: 1,
    title: 'Define report persistence',
    milestone: null,
    createdAt: at(0),
    updatedAt: at(1),
    assignees: [],
    inProgress: null,
  };
  const inventory = {
    board: 'backlog-triage',
    title: 'repo-17 backlog',
    repo: 'cboone/repo-17',
    sync: structuredClone(sync),
    issues: [structuredClone(item)],
  };
  const report = {
    ...structuredClone(inventory),
    summary: 'Start the persistence issue.',
    lanes: [{ key: 'L1', name: 'Persistence', mode: 'any', issues: [1] }],
    startNow: [{ issue: 1, why: 'The issue is ready.' }],
  };
  const fingerprint = {
    algorithm: 'sha256',
    value: 'c'.repeat(64),
    scope: 'core-and-collected-context',
  };
  return {
    schemaVersion: SUCCESSFUL_REPORT_VERSION_SCHEMA_VERSION,
    reportId: identity.reportId,
    jobId: identity.jobId,
    ownerId: 99961,
    repositoryId,
    generatedAt,
    report,
    inventory,
    comparison: createInitialComparison({
      reportId: identity.reportId,
      generatedAt,
      source: { fingerprint },
      report,
    }),
    source: {
      fingerprint,
      sync: structuredClone(sync),
      counts: {
        openIssues: 1,
        openPullRequests: 0,
        milestones: 0,
        labels: 0,
        branches: 1,
        unmergedBranches: 0,
        issueComments: 0,
        treeEntries: 0,
        selectedFiles: 0,
      },
      provenance: {
        repository: repository(repositoryId),
        observedFrom: at(1),
        observedTo: at(2),
        consistency: 'two-pass-matched',
        inputs: [
          { name: 'core-inventory', status: 'complete' },
          { name: 'issue-comments', status: 'complete' },
          { name: 'repository-tree', status: 'complete' },
          { name: 'selected-file-context', status: 'complete' },
          { name: 'references', status: 'complete' },
          { name: 'branch-ancestry', status: 'complete' },
        ],
        files: [],
        references: { verified: 0, unverified: 0 },
        limitations: [
          'Matching observations are not an atomic GitHub snapshot.',
        ],
        analysisSelection: {
          version: 'analysis-selection-v1',
          wireVersion: 'analysis-input-v1',
          sourceSafetyPolicyVersion: 'source-safety-v1',
          sourcePathExtractorVersion: 1,
          mandatoryManifestHash: 'd'.repeat(64),
          selectedComments: [],
          selectedFiles: [],
          omissions: [],
          selectedCounts: { comments: 0, files: 0, total: 0 },
          omittedCounts: { comments: 0, files: 0, total: 0 },
          countAttempts: [
            {
              prefixLength: 0,
              inputTokens: 1000,
              countRequestBytes: 4000,
              messageRequestBytes: 4100,
            },
          ],
          limits: { ...ANALYSIS_INPUT_LIMITS },
          limited: false,
          limitations: [],
        },
      },
    },
    analysis: {
      model: 'claude-opus-5',
      effort: 'high',
      promptVersion: REPORT_PROMPT_VERSION,
      schemaVersion: REPORT_ANALYSIS_SCHEMA_VERSION,
      wireVersion: 1,
      assemblerVersion: REPORT_ASSEMBLER_VERSION,
      pricingPolicyId: 'setup-opus-5-global-standard-v1',
      attempts: [
        {
          number: 1,
          terminalClass: 'complete',
          inputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 20,
          rates: { inputRateMicrousd: 5, outputRateMicrousd: 25 },
          inferenceGeo: 'global',
          serviceTier: 'standard',
          costMicrousd: 550,
        },
      ],
    },
  };
}

test('immutable write, guarded rotation and direct read verify the complete envelope and repair the catalog', async () => {
  const storage = memoryStorage();
  const version = reportVersion();
  await ensureCatalogRepository({
    storage,
    budget,
    repository: repository(17),
    at: at(0),
  });
  await readOrCreateRepositoryState({
    storage,
    budget,
    repository: repository(17),
  });
  await claimRepositoryJob({
    storage,
    budget,
    repositoryId: 17,
    jobId: version.jobId,
    operation: 'generate',
    expectedCurrentReportId: null,
    admittedAt: at(1),
  });
  const versionKey = `owners/99961/repositories/17/versions/${version.reportId}`;
  storage.loseNextAcknowledgement(versionKey);
  const written = await writeImmutableReportVersion({
    storage,
    budget,
    versionKey,
    version,
  });
  assert.equal(written.status, 'recovered');
  await rotateRepositoryReport({
    storage,
    budget,
    repositoryId: 17,
    jobId: version.jobId,
    expectedCurrentReportId: null,
    current: {
      reportId: version.reportId,
      versionKey,
      generatedAt: version.generatedAt,
      sourceFingerprint: version.source.fingerprint.value,
    },
  });
  const current = await readCurrentReportEnvelope({
    storage,
    budget,
    repositoryId: 17,
    at: at(5),
  });
  assert.equal(current.envelope.reportId, version.reportId);
  assert.equal(current.catalogRepair, 'repaired');
  const direct = await readReportEnvelope({
    storage,
    budget,
    repositoryId: 17,
    reportId: version.reportId,
  });
  assert.equal(direct.envelope.jobId, version.jobId);
  assert.equal(
    storage.value(REPORT_CATALOG_KEY).repositories[0].current.reportId,
    version.reportId,
  );

  const different = structuredClone(version);
  different.analysis.attempts[0].terminalClass = 'accepted';
  await assert.rejects(
    writeImmutableReportVersion({
      storage,
      budget,
      versionKey,
      version: different,
    }),
    { code: 'service_unavailable' },
  );
  assert.equal(storage.metrics.lists, 0);
});
