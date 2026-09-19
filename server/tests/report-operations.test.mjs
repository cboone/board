import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalysisAdmission } from '../lib/analysis-admission.mjs';
import { ANALYSIS_INPUT_LIMITS } from '../lib/analysis-input.mjs';
import { createAnalysisReconciler } from '../lib/analysis-reconciler.mjs';
import { BoardError } from '../lib/errors.mjs';
import { transitionJob } from '../lib/job-machine.mjs';
import { createAnalysisJob, deriveAnalysisJobIdentity } from '../lib/jobs.mjs';
import {
  REPORT_OPERATION_LIMITS,
  createReportOperations,
} from '../lib/report-operations.mjs';
import {
  REPORT_CATALOG_KEY,
  claimRepositoryJob,
  ensureCatalogRepository,
  readOrCreateRepositoryState,
  readRepositoryState,
  repairCatalogRepository,
  repositoryStateKey,
} from '../lib/report-store.mjs';
import {
  createRepositoryState,
  projectRepositoryState,
} from '../lib/report-records.mjs';
import {
  REPORT_ANALYSIS_SCHEMA_VERSION,
  REPORT_ASSEMBLER_VERSION,
  REPORT_PROMPT_VERSION,
  SUCCESSFUL_REPORT_VERSION_SCHEMA_VERSION,
  successfulReportVersionKey,
} from '../lib/report-versions.mjs';
import {
  SETUP_SPEND_LEDGER_KEY,
  ensureSetupSpendLedger,
  listSetupSpendReservations,
  readSetupSpendReservation,
  reserveSetupSpend,
} from '../lib/spend-store.mjs';
import { createInitialComparison } from '../../src/domain/report-comparison.js';

const OWNER_ID = 99961;
const NOW = '2026-09-19T12:00:00.000Z';
const budget = Object.freeze({ name: 'report-operations-budget' });
const repository = Object.freeze({
  id: 17,
  fullName: 'cboone/widgets',
  name: 'widgets',
  private: true,
  url: 'https://github.com/cboone/widgets',
});
const jobIdentity = deriveAnalysisJobIdentity({
  ownerId: OWNER_ID,
  repositoryId: repository.id,
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
});
const activeIdentity = deriveAnalysisJobIdentity({
  ownerId: OWNER_ID,
  repositoryId: repository.id,
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174001',
});

function memoryStorage() {
  const records = new Map();
  let revision = 0;
  const put = (key, value) => {
    revision += 1;
    records.set(key, {
      value: structuredClone(value),
      etag: `"etag-${revision}"`,
    });
  };
  return {
    records,
    seed: put,
    remove(key) {
      records.delete(key);
    },
    value(key) {
      return records.has(key) ? structuredClone(records.get(key).value) : null;
    },
    async read(key, options) {
      assert.deepEqual(options, { budget });
      const record = records.get(key);
      return record === undefined ? null : structuredClone(record);
    },
    async write(key, value, condition, options) {
      assert.deepEqual(options, { budget });
      const current = records.get(key);
      if (
        (condition.onlyIfNew === true && current !== undefined) ||
        (condition.onlyIfMatch !== undefined &&
          current?.etag !== condition.onlyIfMatch)
      )
        return { modified: false };
      put(key, value);
      return { modified: true, etag: records.get(key).etag };
    },
  };
}

function traceStorageWrites(storage, store, writes) {
  return {
    ...storage,
    async write(key, value, condition, options) {
      const before = storage.value(key);
      const result = await storage.write(key, value, condition, options);
      if (result.modified)
        writes.push({
          store,
          key,
          before,
          after: structuredClone(value),
        });
      return result;
    },
  };
}

function issue() {
  return {
    id: 9001,
    number: 1,
    title: 'Define the report boundary',
    milestone: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-18T19:00:00.000Z',
    assignees: [],
    inProgress: null,
  };
}

function analysisSelection() {
  return {
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
        inputTokens: 1200,
        countRequestBytes: 4096,
        messageRequestBytes: 4200,
      },
    ],
    limits: { ...ANALYSIS_INPUT_LIMITS },
    limited: false,
    limitations: [],
  };
}

function reportVersion() {
  const sync = {
    at: '2026-09-19T11:59:00.000Z',
    timeZone: 'UTC',
    branch: 'main',
    commit: 'a'.repeat(40),
    openPullRequests: 0,
  };
  const inventory = {
    board: 'backlog-triage',
    title: 'widgets backlog',
    repo: repository.fullName,
    repoUrl: repository.url,
    sync: structuredClone(sync),
    issues: [issue()],
  };
  const report = {
    ...structuredClone(inventory),
    summary: 'Start the report boundary issue.',
    lanes: [
      {
        key: 'L1',
        name: 'Report contract',
        mode: 'any',
        issues: [1],
      },
    ],
    startNow: [{ issue: 1, why: 'The issue has no dependencies.' }],
  };
  const fingerprint = {
    algorithm: 'sha256',
    value: 'c'.repeat(64),
    scope: 'core-and-collected-context',
  };
  return {
    schemaVersion: SUCCESSFUL_REPORT_VERSION_SCHEMA_VERSION,
    reportId: jobIdentity.reportId,
    jobId: jobIdentity.jobId,
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    generatedAt: NOW,
    report,
    inventory,
    comparison: createInitialComparison({
      reportId: jobIdentity.reportId,
      generatedAt: NOW,
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
        labels: 1,
        branches: 1,
        unmergedBranches: 0,
        issueComments: 0,
        treeEntries: 1,
        selectedFiles: 0,
      },
      provenance: {
        repository,
        observedFrom: '2026-09-19T11:58:58.000Z',
        observedTo: '2026-09-19T11:59:00.000Z',
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
        analysisSelection: analysisSelection(),
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

function sourceSummary(selectedRepository = repository) {
  return {
    status: 'complete',
    repo: selectedRepository,
    sync: {
      at: NOW,
      timeZone: 'UTC',
      branch: 'main',
      commit: 'e'.repeat(40),
      openPullRequests: 0,
    },
    fingerprint: {
      algorithm: 'sha256',
      value: 'f'.repeat(64),
      scope: 'core-and-collected-context',
    },
    provenance: {
      observedFrom: '2026-09-19T11:59:58.000Z',
      observedTo: NOW,
      consistency: 'two-pass-matched',
      inputs: [{ name: 'core-inventory', status: 'complete' }],
      files: [],
      references: { verified: 0, unverified: 0 },
      limitations: [],
    },
    counts: {
      openIssues: 1,
      openPullRequests: 0,
      milestones: 0,
      labels: 1,
      branches: 1,
      unmergedBranches: 0,
      issueComments: 0,
      treeEntries: 1,
      selectedFiles: 0,
    },
  };
}

async function fixture({
  sourceOperations,
  reconcile,
  admission,
  now = () => NOW,
} = {}) {
  const reportStorage = memoryStorage();
  const jobStorage = memoryStorage();
  const spendStorage = memoryStorage();
  const reconciliations = [];
  const decisions = [];
  const admissions = [];
  await ensureSetupSpendLedger({
    storage: spendStorage,
    budget,
    deployId: 'deploy-1',
    at: NOW,
  });
  const operations = createReportOperations({
    reportStorage,
    jobStorage,
    spendStorage,
    sourceOperations:
      sourceOperations ??
      Object.freeze({
        async checkRepository(input) {
          if (input.onRepositoryPinned)
            await input.onRepositoryPinned(repository);
          return { summary: sourceSummary() };
        },
      }),
    admission:
      admission ??
      (async (input) => {
        admissions.push(input);
        return {
          id: activeIdentity.jobId,
          operation: input.operation,
          state: 'queued',
          createdAt: NOW,
          errorCode: null,
          reportId: null,
        };
      }),
    reconcile: async (input) => {
      reconciliations.push(input);
      return reconcile?.(input);
    },
    deployId: 'deploy-1',
    applySpendDecision: async (input) => {
      decisions.push(input);
      return {
        status: 'updated',
        spend: { mode: 'setup', status: 'available' },
      };
    },
    now,
  });
  return {
    operations,
    reportStorage,
    jobStorage,
    spendStorage,
    reconciliations,
    decisions,
    admissions,
  };
}

async function seedSavedReport(board, { active = true } = {}) {
  const version = reportVersion();
  const current = {
    reportId: version.reportId,
    versionKey: successfulReportVersionKey(version),
    generatedAt: version.generatedAt,
    sourceFingerprint: version.source.fingerprint.value,
  };
  const activeJob = active
    ? createAnalysisJob({
        ownerId: OWNER_ID,
        repositoryId: repository.id,
        idempotencyKey: '123e4567-e89b-42d3-a456-426614174001',
        operation: 'refresh',
        expectedCurrentReportId: current.reportId,
        authorizationEpoch: 2,
        admissionDeployId: 'deploy-1',
        at: NOW,
        deadlineAt: '2026-09-19T12:15:00.000Z',
      })
    : null;
  const state = projectRepositoryState({
    ...createRepositoryState(repository),
    revision: 2,
    current,
    activeJob:
      activeJob === null
        ? null
        : {
            jobId: activeJob.jobId,
            operation: activeJob.operation,
            expectedCurrentReportId: activeJob.expectedCurrentReportId,
            admittedAt: activeJob.createdAt,
          },
  });
  await ensureCatalogRepository({
    storage: board.reportStorage,
    budget,
    repository,
    at: NOW,
  });
  board.reportStorage.seed(repositoryStateKey(repository.id), state);
  board.reportStorage.seed(current.versionKey, version);
  await repairCatalogRepository({
    storage: board.reportStorage,
    budget,
    repositoryState: state,
    at: NOW,
  });
  if (activeJob) board.jobStorage.seed(`jobs/${activeJob.jobId}`, activeJob);
  return { version, state, activeJob };
}

test('projects catalog and direct report data without storage, job, or ledger internals', async () => {
  const board = await fixture();
  const seeded = await seedSavedReport(board);
  const catalog = await board.operations.listReports({
    ownerId: OWNER_ID,
    cursor: null,
    budget,
  });
  assert.deepEqual(Object.keys(catalog), ['items', 'nextCursor']);
  assert.equal(catalog.items.length, 1);
  assert.deepEqual(Object.keys(catalog.items[0]), [
    'repository',
    'current',
    'sourceStatus',
    'activeJob',
  ]);
  assert.deepEqual(Object.keys(catalog.items[0].current), [
    'reportId',
    'generatedAt',
    'sourceFingerprint',
  ]);
  assert.deepEqual(Object.keys(catalog.items[0].activeJob), [
    'id',
    'operation',
    'state',
    'createdAt',
    'errorCode',
    'reportId',
  ]);
  assert.equal(catalog.items[0].sourceStatus, 'ready');
  assert.equal(board.reconciliations.length, 0);

  const direct = await board.operations.getReport({
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    budget,
  });
  assert.deepEqual(Object.keys(direct), [
    'repository',
    'current',
    'previous',
    'report',
    'inventory',
    'comparison',
    'source',
    'analysis',
    'sourceCheck',
    'lastAnalysisAttempt',
    'activeJob',
    'spendMode',
  ]);
  assert.deepEqual(direct.current, catalog.items[0].current);
  assert.deepEqual(direct.report, seeded.version.report);
  assert.deepEqual(direct.spendMode, {
    available: true,
    mode: 'setup',
    reason: null,
  });
  const serialized = JSON.stringify(direct);
  for (const forbidden of [
    'versionKey',
    'dispatchCapabilityHash',
    'stateDeadlineAt',
    SETUP_SPEND_LEDGER_KEY,
    'capMicrousd',
    'remainingMicrousd',
  ])
    assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(board.reconciliations, [
    {
      ownerId: OWNER_ID,
      repositoryId: repository.id,
      budget,
    },
  ]);
});

test('keeps a saved catalog entry when its claimed job is missing', async () => {
  const board = await fixture();
  const seeded = await seedSavedReport(board);
  board.jobStorage.remove(`jobs/${seeded.activeJob.jobId}`);
  const catalog = await board.operations.listReports({
    ownerId: OWNER_ID,
    cursor: null,
    budget,
  });
  assert.equal(catalog.items.length, 1);
  assert.deepEqual(catalog.items[0].current, {
    reportId: seeded.version.reportId,
    generatedAt: seeded.version.generatedAt,
    sourceFingerprint: seeded.version.source.fingerprint.value,
  });
  assert.equal(catalog.items[0].activeJob, null);
});

test('returns a stored empty state and rejects a repository with no state', async () => {
  const board = await fixture();
  board.reportStorage.seed(
    repositoryStateKey(repository.id),
    createRepositoryState(repository),
  );
  const empty = await board.operations.getReport({
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    budget,
  });
  for (const key of [
    'current',
    'previous',
    'report',
    'inventory',
    'comparison',
    'source',
    'analysis',
    'activeJob',
  ])
    assert.equal(empty[key], null);
  await assert.rejects(
    board.operations.getReport({
      ownerId: OWNER_ID,
      repositoryId: 18,
      budget,
    }),
    { code: 'report_not_found' },
  );
});

test('keeps a historical source-unavailable report readable without a spend ledger', async () => {
  const board = await fixture();
  const seeded = await seedSavedReport(board, { active: false });
  const historical = projectRepositoryState({
    ...seeded.state,
    revision: seeded.state.revision + 1,
    sourceCheck: {
      sequence: 1,
      startedAt: '2026-09-19T11:59:58.000Z',
      completedAt: '2026-09-19T11:59:59.000Z',
      status: 'source-unavailable',
      summary: null,
      errorCode: 'source_unavailable',
    },
  });
  board.reportStorage.seed(repositoryStateKey(repository.id), historical);
  board.spendStorage.remove(SETUP_SPEND_LEDGER_KEY);
  const direct = await board.operations.getReport({
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    budget,
  });
  assert.deepEqual(direct.report, seeded.version.report);
  assert.deepEqual(direct.spendMode, {
    available: false,
    mode: 'disabled',
    reason: 'source_unavailable',
  });
  assert.equal(board.spendStorage.value(SETUP_SPEND_LEDGER_KEY), null);
});

test('keeps a saved report readable and rotates an older deploy policy', async () => {
  const board = await fixture();
  const seeded = await seedSavedReport(board, { active: false });
  const priorLedger = board.spendStorage.value(SETUP_SPEND_LEDGER_KEY);
  const operations = createReportOperations({
    reportStorage: board.reportStorage,
    jobStorage: board.jobStorage,
    spendStorage: board.spendStorage,
    sourceOperations: {
      async checkRepository() {
        throw new Error('source must not be read');
      },
    },
    admission: async () => {
      throw new Error('admission must not run');
    },
    reconcile: async () => {},
    deployId: 'deploy-2',
    now: () => NOW,
  });
  const direct = await operations.getReport({
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    budget,
  });
  assert.deepEqual(direct.report, seeded.version.report);
  assert.deepEqual(direct.spendMode, {
    available: true,
    mode: 'setup',
    reason: null,
  });
  const currentLedger = board.spendStorage.value(SETUP_SPEND_LEDGER_KEY);
  assert.notEqual(currentLedger.activePolicyId, priorLedger.activePolicyId);
  assert.deepEqual(
    currentLedger.policies[priorLedger.activePolicyId],
    priorLedger.policies[priorLedger.activePolicyId],
  );
  assert.equal(currentLedger.accountingDigest, priorLedger.accountingDigest);
  assert.equal(
    currentLedger.accountingSequence,
    priorLedger.accountingSequence,
  );
});

test('keeps a saved report readable when nonpaid reconciliation is unavailable', async () => {
  const board = await fixture();
  const seeded = await seedSavedReport(board, { active: false });
  const operations = createReportOperations({
    reportStorage: board.reportStorage,
    jobStorage: board.jobStorage,
    spendStorage: board.spendStorage,
    sourceOperations: {
      async checkRepository() {
        throw new Error('source must not be read');
      },
    },
    admission: async () => {
      throw new Error('admission must not run');
    },
    reconcile: async () => {
      throw new BoardError('service_unavailable');
    },
    deployId: 'deploy-1',
    now: () => NOW,
  });
  const direct = await operations.getReport({
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    budget,
  });
  assert.deepEqual(direct.report, seeded.version.report);
  assert.deepEqual(direct.spendMode, {
    available: false,
    mode: 'disabled',
    reason: 'analysis_unavailable',
  });
});

test('keeps a saved report readable when reconciliation cannot read its claimed job', async () => {
  const board = await fixture();
  const seeded = await seedSavedReport(board);
  board.jobStorage.remove(`jobs/${seeded.activeJob.jobId}`);
  const operations = createReportOperations({
    reportStorage: board.reportStorage,
    jobStorage: board.jobStorage,
    spendStorage: board.spendStorage,
    sourceOperations: {
      async checkRepository() {
        throw new Error('source must not be read');
      },
    },
    admission: async () => {
      throw new Error('admission must not run');
    },
    reconcile: async () => {
      throw new BoardError('service_unavailable');
    },
    deployId: 'deploy-1',
    now: () => NOW,
  });
  const direct = await operations.getReport({
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    budget,
  });
  assert.deepEqual(direct.report, seeded.version.report);
  assert.equal(direct.activeJob, null);
  assert.deepEqual(direct.spendMode, {
    available: false,
    mode: 'disabled',
    reason: 'analysis_unavailable',
  });
});

test('polling authorizes the owner, reconciles, and returns only the six-key safe job', async () => {
  const board = await fixture();
  const { activeJob } = await seedSavedReport(board);
  const result = await board.operations.pollJob({
    ownerId: OWNER_ID,
    jobId: activeJob.jobId,
    budget,
  });
  assert.deepEqual(Object.keys(result), ['job']);
  assert.deepEqual(Object.keys(result.job), [
    'id',
    'operation',
    'state',
    'createdAt',
    'errorCode',
    'reportId',
  ]);
  assert.deepEqual(board.reconciliations.at(-1), {
    ownerId: OWNER_ID,
    jobId: activeJob.jobId,
    budget,
  });
});

test('stores only the safe source projection and records fixed failures', async () => {
  const raw = 'private-source-sentinel';
  const responses = [
    { summary: { ...sourceSummary(), raw }, sourceSnapshot: { raw } },
    new BoardError('provider_unavailable'),
    new BoardError('source_unavailable'),
    new BoardError('forbidden'),
  ];
  const board = await fixture({
    sourceOperations: {
      async checkRepository() {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
    },
  });
  board.reportStorage.seed(
    repositoryStateKey(repository.id),
    createRepositoryState(repository),
  );
  const input = {
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    accessToken: 'synthetic-access-token',
    signal: new AbortController().signal,
    budget,
  };
  const checked = await board.operations.checkSource(input);
  assert.deepEqual(Object.keys(checked), ['summary']);
  assert.equal(Object.hasOwn(checked.summary, 'raw'), false);
  assert.equal(JSON.stringify(checked).includes(raw), false);
  let stored = board.reportStorage.value(repositoryStateKey(repository.id));
  assert.equal(stored.sourceCheck.status, 'complete');
  assert.equal(stored.sourceCheck.summary.fingerprint, 'f'.repeat(64));
  assert.equal(JSON.stringify(stored).includes(raw), false);

  await assert.rejects(board.operations.checkSource(input), {
    code: 'provider_unavailable',
  });
  stored = board.reportStorage.value(repositoryStateKey(repository.id));
  assert.equal(stored.sourceCheck.status, 'failed');
  assert.equal(stored.sourceCheck.errorCode, 'provider_unavailable');

  await assert.rejects(board.operations.checkSource(input), {
    code: 'source_unavailable',
  });
  stored = board.reportStorage.value(repositoryStateKey(repository.id));
  assert.equal(stored.sourceCheck.status, 'source-unavailable');
  assert.equal(stored.sourceCheck.errorCode, 'source_unavailable');
  await assert.rejects(board.operations.checkSource(input), {
    code: 'source_unavailable',
  });
  stored = board.reportStorage.value(repositoryStateKey(repository.id));
  assert.equal(stored.sourceCheck.status, 'source-unavailable');
  assert.equal(stored.sourceCheck.errorCode, 'source_unavailable');
  assert.equal(
    JSON.stringify(stored).includes('synthetic-access-token'),
    false,
  );
});

test('a stale source check cannot replace the newer check repository identity', async () => {
  let releaseFirst;
  const firstPending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted;
  const firstReady = new Promise((resolve) => {
    firstStarted = resolve;
  });
  let calls = 0;
  const staleRepository = {
    ...repository,
    name: 'stale-widgets',
    fullName: 'cboone/stale-widgets',
    url: 'https://github.com/cboone/stale-widgets',
  };
  const currentRepository = {
    ...repository,
    name: 'current-widgets',
    fullName: 'cboone/current-widgets',
    url: 'https://github.com/cboone/current-widgets',
  };
  const board = await fixture({
    sourceOperations: {
      async checkRepository() {
        calls += 1;
        if (calls === 1) {
          firstStarted();
          await firstPending;
          return { summary: sourceSummary(staleRepository) };
        }
        return { summary: sourceSummary(currentRepository) };
      },
    },
  });
  board.reportStorage.seed(
    repositoryStateKey(repository.id),
    createRepositoryState(repository),
  );
  const input = {
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    accessToken: 'synthetic-access-token',
    signal: new AbortController().signal,
    budget,
  };
  const first = board.operations.checkSource(input);
  await firstReady;
  await board.operations.checkSource(input);
  releaseFirst();
  await assert.rejects(first, { code: 'source_unstable' });
  const stored = board.reportStorage.value(repositoryStateKey(repository.id));
  assert.deepEqual(stored.repository, currentRepository);
  assert.equal(stored.sourceCheck.status, 'complete');
});

test('an older first source check cannot start after a newer check publishes', async () => {
  let releaseFirstPin;
  const firstPinPending = new Promise((resolve) => {
    releaseFirstPin = resolve;
  });
  let firstStarted;
  const firstReady = new Promise((resolve) => {
    firstStarted = resolve;
  });
  let calls = 0;
  const staleRepository = {
    ...repository,
    name: 'stale-widgets',
    fullName: 'cboone/stale-widgets',
    url: 'https://github.com/cboone/stale-widgets',
  };
  const currentRepository = {
    ...repository,
    name: 'current-widgets',
    fullName: 'cboone/current-widgets',
    url: 'https://github.com/cboone/current-widgets',
  };
  const timestamps = [
    '2026-09-19T11:59:58.000Z',
    '2026-09-19T11:59:59.000Z',
    NOW,
  ];
  const board = await fixture({
    now: () => timestamps.shift() ?? NOW,
    sourceOperations: {
      async checkRepository(input) {
        calls += 1;
        if (calls === 1) {
          firstStarted();
          await firstPinPending;
          await input.onRepositoryPinned(staleRepository);
          return { summary: sourceSummary(staleRepository) };
        }
        await input.onRepositoryPinned(currentRepository);
        return { summary: sourceSummary(currentRepository) };
      },
    },
  });
  const input = {
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    accessToken: 'synthetic-access-token',
    signal: new AbortController().signal,
    budget,
  };
  const first = board.operations.checkSource(input);
  await firstReady;
  await board.operations.checkSource(input);
  releaseFirstPin();
  await assert.rejects(first, { code: 'source_unstable' });
  const stored = board.reportStorage.value(repositoryStateKey(repository.id));
  assert.deepEqual(stored.repository, currentRepository);
  assert.equal(stored.sourceCheck.sequence, 1);
  assert.equal(stored.sourceCheck.status, 'complete');
});

test('creates state after a successful first check without persisting its snapshot', async () => {
  const board = await fixture({
    sourceOperations: {
      async checkRepository(input) {
        await input.onRepositoryPinned(repository);
        return {
          summary: sourceSummary(),
          sourceSnapshot: { issueBody: 'transient-only' },
        };
      },
    },
  });
  await board.operations.checkSource({
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    accessToken: 'synthetic-access-token',
    signal: new AbortController().signal,
    budget,
  });
  const state = board.reportStorage.value(repositoryStateKey(repository.id));
  assert.equal(state.sourceCheck.status, 'complete');
  assert.equal(JSON.stringify(state).includes('transient-only'), false);
  assert.equal(board.reportStorage.value(REPORT_CATALOG_KEY), null);
});

test('delegates admission after reconciliation with a bounded fixed deadline', async () => {
  const board = await fixture();
  const response = await board.operations.admitJob({
    ownerId: OWNER_ID,
    authorizationEpoch: 2,
    repository: {
      ...repository,
      defaultBranch: 'main',
      defaultTip: 'a'.repeat(40),
    },
    request: {
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174001',
      operation: 'generate',
      expectedCurrentReportId: null,
    },
    budget,
  });
  assert.equal(response.job.state, 'queued');
  assert.deepEqual(board.reconciliations[0], {
    ownerId: OWNER_ID,
    budget,
  });
  assert.deepEqual(board.reconciliations[1], {
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    budget,
  });
  assert.deepEqual(board.admissions[0], {
    ownerId: OWNER_ID,
    authorizationEpoch: 2,
    repository: {
      ...repository,
      defaultBranch: 'main',
      defaultTip: 'a'.repeat(40),
    },
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174001',
    operation: 'generate',
    expectedCurrentReportId: null,
    deadlineAt: new Date(
      Date.parse(NOW) + REPORT_OPERATION_LIMITS.admissionDeadlineMs,
    ).toISOString(),
    budget,
  });
});

test('global admission sweep completes another repository before reserving and dispatching', async () => {
  const writes = [];
  const reportStorage = traceStorageWrites(memoryStorage(), 'reports', writes);
  const jobStorage = traceStorageWrites(memoryStorage(), 'jobs', writes);
  const spendStorage = traceStorageWrites(memoryStorage(), 'spend', writes);
  const repositoryB = {
    id: 18,
    fullName: 'cboone/gadgets',
    name: 'gadgets',
    private: true,
    url: 'https://github.com/cboone/gadgets',
    defaultBranch: 'main',
    defaultTip: 'b'.repeat(40),
  };
  const repositoryAJob = createAnalysisJob({
    ownerId: OWNER_ID,
    repositoryId: repository.id,
    idempotencyKey: '018f0f11-1111-7111-8111-111111111111',
    operation: 'generate',
    expectedCurrentReportId: null,
    authorizationEpoch: 2,
    admissionDeployId: 'deploy-1',
    at: '2026-09-19T11:58:00.000Z',
    deadlineAt: '2026-09-19T12:13:00.000Z',
  });
  await ensureSetupSpendLedger({
    storage: spendStorage,
    budget,
    deployId: 'deploy-1',
    at: '2026-09-19T11:57:00.000Z',
  });
  await ensureCatalogRepository({
    storage: reportStorage,
    budget,
    repository,
    at: '2026-09-19T11:57:01.000Z',
  });
  await readOrCreateRepositoryState({
    storage: reportStorage,
    budget,
    repository,
  });
  await claimRepositoryJob({
    storage: reportStorage,
    budget,
    repositoryId: repository.id,
    jobId: repositoryAJob.jobId,
    operation: repositoryAJob.operation,
    expectedCurrentReportId: repositoryAJob.expectedCurrentReportId,
    admittedAt: repositoryAJob.createdAt,
  });
  const reservation = await reserveSetupSpend({
    storage: spendStorage,
    budget,
    deployId: 'deploy-1',
    jobId: repositoryAJob.jobId,
    operation: repositoryAJob.operation,
    at: '2026-09-19T11:58:01.000Z',
    revalidate: async () => true,
  });
  assert.equal(reservation.status, 'reserved');

  let terminalJob = transitionJob(repositoryAJob, {
    type: 'reservation-committed',
    at: '2026-09-19T11:58:01.000Z',
    deadlineAt: '2026-09-19T12:13:00.000Z',
    pricePolicyId: reservation.policyId,
    reservationMicrousd: reservation.reservationMicrousd,
    accounting: reservation.accounting,
  });
  terminalJob = transitionJob(terminalJob, {
    type: 'dispatch-installed',
    at: '2026-09-19T11:58:02.000Z',
    deadlineAt: '2026-09-19T12:13:00.000Z',
    capabilityHash: '1'.repeat(64),
  });
  terminalJob = transitionJob(terminalJob, {
    type: 'free-lease-claimed',
    at: '2026-09-19T11:58:03.000Z',
    phase: 'collecting',
    tokenHash: '2'.repeat(64),
    expiresAt: '2026-09-19T12:03:00.000Z',
  });
  terminalJob = transitionJob(terminalJob, {
    type: 'free-lease-claimed',
    at: '2026-09-19T11:58:04.000Z',
    phase: 'counting',
    tokenHash: '2'.repeat(64),
    expiresAt: '2026-09-19T12:03:00.000Z',
  });
  terminalJob = transitionJob(terminalJob, {
    type: 'primary-started',
    at: '2026-09-19T11:58:05.000Z',
    freeTokenHash: '2'.repeat(64),
    attemptTokenHash: '3'.repeat(64),
    deadlineAt: '2026-09-19T12:08:00.000Z',
    sourceFingerprint: '4'.repeat(64),
  });
  terminalJob = transitionJob(terminalJob, {
    type: 'response-completed',
    at: '2026-09-19T11:58:06.000Z',
    number: 1,
    attemptTokenHash: '3'.repeat(64),
    deadlineAt: '2026-09-19T12:03:00.000Z',
    usage: {
      terminalClass: 'complete-response',
      terminalStopReason: 'end_turn',
      inputTokens: 1000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 100,
      costMicrousd: 7500,
    },
  });
  terminalJob = transitionJob(terminalJob, {
    type: 'terminated',
    at: '2026-09-19T11:58:07.000Z',
    status: 'failed',
    errorCode: 'analysis_output_invalid',
    attemptTokenHash: '3'.repeat(64),
    finalizationTokenHash: null,
    freeTokenHash: null,
    recovery: false,
  });
  jobStorage.seed(`jobs/${terminalJob.jobId}`, terminalJob);

  const pendingState = await readRepositoryState({
    storage: reportStorage,
    budget,
    repositoryId: repository.id,
  });
  const pendingReservation = await readSetupSpendReservation({
    storage: spendStorage,
    budget,
    deployId: 'deploy-1',
    jobId: terminalJob.jobId,
  });
  assert.equal(pendingState.state.activeJob.jobId, terminalJob.jobId);
  assert.equal(terminalJob.accounting.status, 'pending');
  assert.deepEqual(
    pendingReservation.attempts.map(({ state }) => state),
    ['reserved', 'reserved'],
  );

  writes.length = 0;
  const dispatches = [];
  let randomCalls = 0;
  let sourceCalls = 0;
  const admission = createAnalysisAdmission({
    reportStorage,
    jobStorage,
    spendStorage,
    deployId: 'deploy-1',
    origin: 'https://tracker-boards.example',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.notEqual(body.jobId, terminalJob.jobId);
      dispatches.push(body);
      writes.push({ store: 'dispatch', key: body.jobId });
      return new Response(null, { status: 202 });
    },
    randomBytes: (size) => {
      randomCalls += 1;
      return Buffer.alloc(size, randomCalls);
    },
    now: () => NOW,
  });
  const reconciler = createAnalysisReconciler({
    reportStorage,
    jobStorage,
    spendStorage,
    deployId: 'deploy-1',
    now: () => NOW,
  });
  const operations = createReportOperations({
    reportStorage,
    jobStorage,
    spendStorage,
    sourceOperations: {
      async checkRepository() {
        sourceCalls += 1;
        throw new Error('source work must not run during admission');
      },
    },
    admission,
    reconcile: reconciler.reconcile,
    deployId: 'deploy-1',
    now: () => NOW,
  });
  const admitted = await operations.admitJob({
    ownerId: OWNER_ID,
    authorizationEpoch: 2,
    repository: repositoryB,
    request: {
      idempotencyKey: '018f0f11-2222-7222-8222-222222222222',
      operation: 'generate',
      expectedCurrentReportId: null,
    },
    budget,
  });

  const spendWrites = writes.filter(
    ({ store, key }) => store === 'spend' && key === SETUP_SPEND_LEDGER_KEY,
  );
  const changedAttempt = (write, jobId, attemptIndex, from, to) =>
    write.before?.active?.[jobId]?.attempts?.[attemptIndex]?.state === from &&
    write.after?.active?.[jobId]?.attempts?.[attemptIndex]?.state === to;
  const primarySettlements = spendWrites.filter((write) =>
    changedAttempt(write, terminalJob.jobId, 0, 'reserved', 'settled'),
  );
  const correctiveReleases = spendWrites.filter((write) =>
    changedAttempt(write, terminalJob.jobId, 1, 'reserved', 'released'),
  );
  const repositoryARemovals = spendWrites.filter(
    (write) =>
      write.before?.active?.[terminalJob.jobId] !== undefined &&
      write.after?.active?.[terminalJob.jobId] === undefined,
  );
  const repositoryBReservations = spendWrites.filter(
    (write) =>
      write.before?.active?.[admitted.job.id] === undefined &&
      write.after?.active?.[admitted.job.id] !== undefined,
  );
  const accountingWrites = writes.filter(
    (write) =>
      write.store === 'jobs' &&
      write.key === `jobs/${terminalJob.jobId}` &&
      write.before?.accounting?.status === 'pending' &&
      write.after?.accounting?.status === 'complete',
  );
  const claimClears = writes.filter(
    (write) =>
      write.store === 'reports' &&
      write.key === repositoryStateKey(repository.id) &&
      write.before?.activeJob?.jobId === terminalJob.jobId &&
      write.after?.activeJob === null,
  );
  assert.equal(primarySettlements.length, 1);
  assert.equal(
    primarySettlements[0].after.active[terminalJob.jobId].attempts[0]
      .actualCostMicrousd,
    7500,
  );
  assert.equal(correctiveReleases.length, 1);
  assert.equal(accountingWrites.length, 1);
  assert.equal(repositoryARemovals.length, 1);
  assert.equal(claimClears.length, 1);
  assert.equal(repositoryBReservations.length, 1);

  const writeIndex = (target) => writes.indexOf(target);
  assert.ok(
    writeIndex(primarySettlements[0]) < writeIndex(correctiveReleases[0]),
  );
  assert.ok(
    writeIndex(correctiveReleases[0]) < writeIndex(accountingWrites[0]),
  );
  assert.ok(
    writeIndex(accountingWrites[0]) < writeIndex(repositoryARemovals[0]),
  );
  assert.ok(writeIndex(repositoryARemovals[0]) < writeIndex(claimClears[0]));
  assert.ok(
    writeIndex(claimClears[0]) < writeIndex(repositoryBReservations[0]),
  );
  assert.ok(
    writeIndex(repositoryBReservations[0]) <
      writes.findIndex(
        ({ store, key }) => store === 'dispatch' && key === admitted.job.id,
      ),
  );

  const completedJob = jobStorage.value(`jobs/${terminalJob.jobId}`);
  const completedState = await readRepositoryState({
    storage: reportStorage,
    budget,
    repositoryId: repository.id,
  });
  const activeReservations = await listSetupSpendReservations({
    storage: spendStorage,
    budget,
    deployId: 'deploy-1',
  });
  assert.equal(completedJob.accounting.status, 'complete');
  assert.deepEqual(
    completedJob.attempts.map(({ state }) => state),
    ['settled', 'released'],
  );
  assert.equal(completedState.state.activeJob, null);
  assert.equal(
    completedState.state.lastAnalysisAttempt.jobId,
    terminalJob.jobId,
  );
  assert.deepEqual(
    activeReservations.map(({ jobId }) => jobId),
    [admitted.job.id],
  );
  assert.equal(admitted.job.state, 'queued');
  assert.deepEqual(
    dispatches.map(({ jobId }) => jobId),
    [admitted.job.id],
  );
  assert.equal(sourceCalls, 0);
});

test('binds the owner decision to the server-side spend transition and returns a minimal projection', async () => {
  const board = await fixture();
  const decision = {
    policyId: 'setup-opus-5-global-standard-v1',
    discussionRevision: 1,
    decisionId: '9'.repeat(64),
    decision: 'acknowledge',
    authorizedThroughMicrousd: 25_000_000,
    authorizedOperations: ['generate', 'refresh'],
  };
  const result = await board.operations.decideSetupBudget({
    ownerId: OWNER_ID,
    decision,
    budget,
  });
  assert.deepEqual(result, {
    status: 'updated',
    spendMode: { available: true, mode: 'setup', reason: null },
  });
  assert.deepEqual(board.decisions[0], {
    storage: board.spendStorage,
    budget,
    deployId: 'deploy-1',
    ...decision,
    at: NOW,
  });
  assert.equal(JSON.stringify(result).includes('Microusd'), false);
});

test('returns initial analysis availability after a bounded nonpaid reconciliation', async () => {
  const board = await fixture();
  board.spendStorage.remove(SETUP_SPEND_LEDGER_KEY);
  const result = await board.operations.getAnalysisAvailability({
    ownerId: OWNER_ID,
    budget,
  });
  assert.deepEqual(result, {
    spendMode: { available: true, mode: 'setup', reason: null },
  });
  assert.deepEqual(board.reconciliations, [{ ownerId: OWNER_ID, budget }]);
  assert.equal(JSON.stringify(result).includes('Microusd'), false);
  assert.notEqual(board.spendStorage.value(SETUP_SPEND_LEDGER_KEY), null);
});

test('all methods reject a non-owner before storage, reconciliation, or provider work', async () => {
  let providerCalls = 0;
  let admissionCalls = 0;
  const board = await fixture({
    sourceOperations: {
      async checkRepository() {
        providerCalls += 1;
        return { summary: sourceSummary() };
      },
    },
    admission: async () => {
      admissionCalls += 1;
      throw new Error('must not be called');
    },
  });
  const invalid = [
    () => board.operations.listReports({ ownerId: 1, cursor: null, budget }),
    () =>
      board.operations.getReport({
        ownerId: 1,
        repositoryId: repository.id,
        budget,
      }),
    () => board.operations.getAnalysisAvailability({ ownerId: 1, budget }),
    () =>
      board.operations.pollJob({
        ownerId: 1,
        jobId: activeIdentity.jobId,
        budget,
      }),
    () =>
      board.operations.checkSource({
        ownerId: 1,
        repositoryId: repository.id,
        accessToken: 'token',
        signal: new AbortController().signal,
        budget,
      }),
    () =>
      board.operations.decideSetupBudget({
        ownerId: 1,
        decision: {},
        budget,
      }),
    () =>
      board.operations.admitJob({
        ownerId: 1,
        repository: { id: repository.id },
        request: {},
        budget,
      }),
  ];
  for (const operation of invalid)
    await assert.rejects(operation(), { code: 'forbidden' });
  assert.equal(board.reconciliations.length, 0);
  assert.equal(providerCalls, 0);
  assert.equal(admissionCalls, 0);
});
