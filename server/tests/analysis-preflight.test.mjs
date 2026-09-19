import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalysisPreflight } from '../lib/analysis-preflight.mjs';
import {
  analysisPreflightMarkerKey,
  createAnalysisPreflightReadiness,
} from '../lib/analysis-preflight-readiness.mjs';
import { analysisPriorForSource } from '../lib/analysis-request.mjs';
import { ANTHROPIC_POLICY } from '../lib/anthropic.mjs';
import {
  createRepositoryState,
  projectRepositoryState,
} from '../lib/report-records.mjs';
import { repositoryStateKey } from '../lib/report-store.mjs';
import { budget, memoryStorage } from './auth-helpers.mjs';

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const now = () => NOW;
const operationBudget = () => budget(now);
const repository = Object.freeze({
  id: 17,
  fullName: 'cboone/widgets',
  name: 'widgets',
  private: true,
  url: 'https://github.com/cboone/widgets',
  defaultBranch: 'main',
  defaultTip: 'a'.repeat(40),
});

function readinessFacts(overrides = {}) {
  return {
    model: ANTHROPIC_POLICY.model,
    effort: ANTHROPIC_POLICY.effort,
    modelMaxInputTokens: 1_000_000,
    modelMaxOutputTokens: 32_000,
    configuredInputTokens: 100_000,
    configuredOutputTokens: ANTHROPIC_POLICY.maxTokens,
    inputTokens: 1234,
    countRequestBytes: 2048,
    messageRequestBytes: 4096,
    verifiedAt: '2026-09-19T12:00:00.000Z',
    ...overrides,
  };
}

function prepareStub({ rawSource }) {
  return async ({
    sourceSnapshot,
    priorAnalysis,
    requestFactory,
    countClient,
  }) => {
    assert.equal(sourceSnapshot.rawIssueBody, rawSource);
    assert.equal(priorAnalysis, null);
    const pair = requestFactory(
      {
        role: 'user',
        content: JSON.stringify({
          repository: { id: repository.id },
          rawIssueBody: rawSource,
        }),
      },
      { outputTokens: ANTHROPIC_POLICY.maxTokens },
    );
    const inputTokens = await countClient(pair.countRequest);
    return {
      ...pair,
      analysisSelection: {
        selectedCounts: { total: 0 },
        countAttempts: [{ prefixLength: 0, inputTokens }],
      },
    };
  };
}

test('explicit preflight runs only metadata and token counting, persists one source-free global marker, and reuses it', async () => {
  const reportStorage = memoryStorage();
  const spendStorage = memoryStorage();
  const rawSource = 'private issue body that must remain transient';
  let sourceCalls = 0;
  let providerFactories = 0;
  let modelCalls = 0;
  let countCalls = 0;
  let authorizations = 0;
  const preflight = createAnalysisPreflight({
    reportStorage,
    spendStorage,
    sourceOperations: {
      async checkRepository(input) {
        sourceCalls += 1;
        assert.equal(input.repositoryId, repository.id);
        return {
          summary: {
            repo: {
              id: repository.id,
              fullName: repository.fullName,
              name: repository.name,
              private: repository.private,
              url: repository.url,
            },
            provenance: { limitations: [] },
          },
          sourceSnapshot: { rawIssueBody: rawSource },
        };
      },
    },
    deployId: 'deploy-1',
    createProvider: async () => {
      providerFactories += 1;
      return Object.freeze({
        async retrieveModel() {
          modelCalls += 1;
          return {
            id: ANTHROPIC_POLICY.model,
            maxInputTokens: 1_000_000,
            maxTokens: 32_000,
          };
        },
        async countTokens({ analysisInput }) {
          countCalls += 1;
          assert.equal(analysisInput.rawIssueBody, rawSource);
          return 1234;
        },
      });
    },
    prepareInput: prepareStub({ rawSource }),
    now,
  });
  const input = {
    ownerId: 99961,
    repositoryId: repository.id,
    repository,
    request: { operation: 'generate', expectedCurrentReportId: null },
    accessToken: 'github-token',
    signal: new AbortController().signal,
    budget: operationBudget(),
    authorize: async () => {
      authorizations += 1;
    },
  };
  const first = await preflight.verify(input);
  assert.equal(first.marker.model, ANTHROPIC_POLICY.model);
  assert.equal(first.marker.inputTokens, 1234);
  assert.equal(sourceCalls, 1);
  assert.equal(providerFactories, 1);
  assert.equal(modelCalls, 1);
  assert.equal(countCalls, 1);
  assert.ok(authorizations >= 5);

  const key = analysisPreflightMarkerKey({ deployId: 'deploy-1' });
  const stored = spendStorage.records.get(key)?.value;
  assert.deepEqual(stored, first.marker);
  assert.deepEqual(Object.keys(stored), [
    'schemaVersion',
    'ownerId',
    'deployId',
    'policyId',
    'requestContractHash',
    'model',
    'effort',
    'modelMaxInputTokens',
    'modelMaxOutputTokens',
    'configuredInputTokens',
    'configuredOutputTokens',
    'inputTokens',
    'countRequestBytes',
    'messageRequestBytes',
    'verifiedAt',
  ]);
  const serialized = JSON.stringify(stored);
  for (const forbidden of [repository.fullName, rawSource, 'rawIssueBody'])
    assert.equal(serialized.includes(forbidden), false);
  assert.equal(
    spendStorage.events.filter(([action]) => action === 'write').length,
    1,
  );
  assert.deepEqual([...spendStorage.records.keys()], [key]);

  const second = await preflight.verify({
    ...input,
    budget: operationBudget(),
  });
  assert.deepEqual(second, first);
  assert.equal(sourceCalls, 1);
  assert.equal(providerFactories, 1);
  assert.equal(modelCalls, 1);
  assert.equal(countCalls, 1);

  const reportId = 'b'.repeat(64);
  const stateKey = repositoryStateKey(repository.id);
  const saved = projectRepositoryState({
    ...createRepositoryState({
      id: repository.id,
      fullName: repository.fullName,
      name: repository.name,
      private: repository.private,
      url: repository.url,
    }),
    revision: 1,
    current: {
      reportId,
      versionKey: `owners/99961/repositories/${repository.id}/versions/${reportId}`,
      generatedAt: '2026-09-19T11:00:00.000Z',
      sourceFingerprint: 'c'.repeat(64),
    },
  });
  const created = await reportStorage.write(stateKey, saved, {
    onlyIfNew: true,
  });
  assert.equal(created.modified, true);
  await assert.rejects(
    preflight.verify({
      ...input,
      budget: operationBudget(),
    }),
    { code: 'report_state_changed' },
  );
  await assert.rejects(
    preflight.verify({
      ...input,
      request: {
        operation: 'refresh',
        expectedCurrentReportId: 'd'.repeat(64),
      },
      budget: operationBudget(),
    }),
    { code: 'report_state_changed' },
  );
  const active = projectRepositoryState({
    ...saved,
    revision: 2,
    activeJob: {
      jobId: 'e'.repeat(64),
      operation: 'refresh',
      expectedCurrentReportId: reportId,
      admittedAt: '2026-09-19T11:30:00.000Z',
    },
  });
  const updated = await reportStorage.write(stateKey, active, {
    onlyIfMatch: created.etag,
  });
  assert.equal(updated.modified, true);
  await assert.rejects(
    preflight.verify({
      ...input,
      request: {
        operation: 'refresh',
        expectedCurrentReportId: reportId,
      },
      budget: operationBudget(),
    }),
    { code: 'analysis_in_progress' },
  );
  assert.equal(sourceCalls, 1);
  assert.equal(providerFactories, 1);
  assert.equal(modelCalls, 1);
  assert.equal(countCalls, 1);

  const nextDeploy = createAnalysisPreflightReadiness({
    storage: spendStorage,
    deployId: 'deploy-2',
  });
  await assert.rejects(nextDeploy.requireReady({ budget: operationBudget() }), {
    code: 'analysis_preflight_required',
  });
});

test('preflight revalidates the exact report tuple after publishing readiness', async () => {
  const reportStorage = memoryStorage();
  const baseSpendStorage = memoryStorage();
  const stateKey = repositoryStateKey(repository.id);
  let sourceCalls = 0;
  let modelCalls = 0;
  let countCalls = 0;
  const activeState = projectRepositoryState({
    ...createRepositoryState({
      id: repository.id,
      fullName: repository.fullName,
      name: repository.name,
      private: repository.private,
      url: repository.url,
    }),
    revision: 1,
    activeJob: {
      jobId: 'f'.repeat(64),
      operation: 'generate',
      expectedCurrentReportId: null,
      admittedAt: '2026-09-19T11:30:00.000Z',
    },
  });
  const spendStorage = {
    ...baseSpendStorage,
    async write(key, value, condition) {
      const result = await baseSpendStorage.write(key, value, condition);
      if (result.modified && key.startsWith('setup/preflight/v1/')) {
        const claimed = await reportStorage.write(stateKey, activeState, {
          onlyIfNew: true,
        });
        assert.equal(claimed.modified, true);
      }
      return result;
    },
  };
  const preflight = createAnalysisPreflight({
    reportStorage,
    spendStorage,
    sourceOperations: {
      async checkRepository() {
        sourceCalls += 1;
        return {
          summary: {
            repo: {
              id: repository.id,
              fullName: repository.fullName,
              name: repository.name,
              private: repository.private,
              url: repository.url,
            },
            provenance: { limitations: [] },
          },
          sourceSnapshot: { rawIssueBody: 'private' },
        };
      },
    },
    deployId: 'deploy-1',
    createProvider: async () => ({
      async retrieveModel() {
        modelCalls += 1;
        return {
          id: ANTHROPIC_POLICY.model,
          maxInputTokens: 1_000_000,
          maxTokens: 32_000,
        };
      },
      async countTokens() {
        countCalls += 1;
        return 1234;
      },
    }),
    prepareInput: prepareStub({ rawSource: 'private' }),
    now,
  });
  const input = {
    ownerId: 99961,
    repositoryId: repository.id,
    repository,
    request: { operation: 'generate', expectedCurrentReportId: null },
    accessToken: 'github-token',
    signal: new AbortController().signal,
    budget: operationBudget(),
    authorize: async () => {},
  };

  await assert.rejects(preflight.verify(input), {
    code: 'analysis_in_progress',
  });
  await assert.rejects(
    preflight.verify({ ...input, budget: operationBudget() }),
    { code: 'analysis_in_progress' },
  );
  assert.equal(sourceCalls, 1);
  assert.equal(modelCalls, 1);
  assert.equal(countCalls, 1);
});

test('readiness rejects unknown identity and stale binding fields', async () => {
  const storage = memoryStorage();
  const readiness = createAnalysisPreflightReadiness({
    storage,
    deployId: 'deploy-1',
  });
  const marker = await readiness.write({
    budget: operationBudget(),
    facts: readinessFacts(),
  });
  const key = analysisPreflightMarkerKey({ deployId: 'deploy-1' });
  const invalid = [
    { ...marker, repositoryId: repository.id },
    { ...marker, deployId: 'deploy-stale' },
    { ...marker, policyId: 'setup-stale-policy' },
    { ...marker, requestContractHash: '0'.repeat(64) },
  ];
  for (const value of invalid) {
    storage.records.set(key, { value, etag: '"invalid"' });
    await assert.rejects(readiness.read({ budget: operationBudget() }), {
      code: 'service_unavailable',
    });
  }
});

test('readiness resolves committed lost acknowledgements and concurrent only-if-new writes', async () => {
  const baseStorage = memoryStorage();
  let loseAcknowledgement = true;
  const storage = {
    ...baseStorage,
    async write(key, value, condition) {
      const result = await baseStorage.write(key, value, condition);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('synthetic lost acknowledgement');
      }
      return result;
    },
  };
  const firstReadiness = createAnalysisPreflightReadiness({
    storage,
    deployId: 'deploy-1',
  });
  const first = await firstReadiness.write({
    budget: operationBudget(),
    facts: readinessFacts(),
  });
  assert.deepEqual(
    await firstReadiness.requireReady({ budget: operationBudget() }),
    first,
  );

  const concurrentReadiness = createAnalysisPreflightReadiness({
    storage,
    deployId: 'deploy-1',
  });
  const observed = await concurrentReadiness.write({
    budget: operationBudget(),
    facts: readinessFacts({
      inputTokens: 4321,
      verifiedAt: '2026-09-19T12:01:00.000Z',
    }),
  });
  assert.deepEqual(observed, first);
  assert.equal(
    baseStorage.events.filter(([action]) => action === 'write').length,
    2,
  );
});

test('preflight rejects a provider surface that exposes any Messages method', async () => {
  const reportStorage = memoryStorage();
  const spendStorage = memoryStorage();
  let paidCalls = 0;
  const preflight = createAnalysisPreflight({
    reportStorage,
    spendStorage,
    sourceOperations: {
      async checkRepository() {
        return {
          summary: {
            repo: {
              id: repository.id,
              fullName: repository.fullName,
              name: repository.name,
              private: repository.private,
              url: repository.url,
            },
            provenance: { limitations: [] },
          },
          sourceSnapshot: { rawIssueBody: 'private' },
        };
      },
    },
    deployId: 'deploy-1',
    createProvider: async () => ({
      retrieveModel: async () => ({}),
      countTokens: async () => 1,
      createMessage: async () => {
        paidCalls += 1;
      },
    }),
    prepareInput: prepareStub({ rawSource: 'private' }),
    now,
  });
  await assert.rejects(
    preflight.verify({
      ownerId: 99961,
      repositoryId: repository.id,
      repository,
      request: { operation: 'generate', expectedCurrentReportId: null },
      accessToken: 'github-token',
      signal: new AbortController().signal,
      budget: operationBudget(),
      authorize: async () => {},
    }),
    { code: 'service_unavailable' },
  );
  assert.equal(paidCalls, 0);
  assert.equal(spendStorage.records.size, 0);
});

test('shared prior selection omits advisory analysis after a repository rename', () => {
  const report = {
    issues: [],
    lanes: [],
    startNow: [],
    contention: [],
    notes: [],
  };
  const prior = {
    report,
    source: {
      provenance: {
        repository: {
          id: repository.id,
          fullName: repository.fullName,
          name: repository.name,
          private: repository.private,
          url: repository.url,
        },
      },
    },
  };
  assert.notEqual(analysisPriorForSource(prior, repository), null);
  assert.equal(
    analysisPriorForSource(prior, {
      ...repository,
      fullName: 'cboone/renamed-widgets',
      name: 'renamed-widgets',
      url: 'https://github.com/cboone/renamed-widgets',
    }),
    null,
  );
});
