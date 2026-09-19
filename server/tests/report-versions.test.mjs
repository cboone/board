import assert from 'node:assert/strict';
import test from 'node:test';
import { ANALYSIS_INPUT_LIMITS } from '../lib/analysis-input.mjs';
import {
  API_RESPONSE_LIMITS,
  projectDirectReportResponse,
  serializeApiResponse,
} from '../lib/api-responses.mjs';
import { deriveAnalysisJobIdentity } from '../lib/jobs.mjs';
import {
  REPORT_ANALYSIS_SCHEMA_VERSION,
  REPORT_ASSEMBLER_VERSION,
  REPORT_PROMPT_VERSION,
  SUCCESSFUL_REPORT_VERSION_MAX_BYTES,
  SUCCESSFUL_REPORT_VERSION_SCHEMA_VERSION,
  matchesStoredSuccessfulReportVersion,
  prepareSuccessfulReportVersion,
  projectSuccessfulReportVersion,
  serializeSuccessfulReportVersion,
  successfulReportVersionDigest,
  successfulReportVersionKey,
  writeSuccessfulReportVersion,
} from '../lib/report-versions.mjs';
import {
  createInitialComparison,
  createReportComparison,
} from '../../src/domain/report-comparison.js';
import { SETUP_SPEND_LIMITS } from '../lib/spend.mjs';

const generatedAt = '2026-09-18T20:10:00.000Z';
const observedFrom = '2026-09-18T20:09:58.000Z';
const issueUpdatedAt = '2026-09-18T19:00:00.000Z';
const fingerprintValue = 'c'.repeat(64);
const identity = deriveAnalysisJobIdentity({
  ownerId: 99961,
  repositoryId: 17,
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
});

function issue(number = 1, title = 'Define the report boundary') {
  return {
    id: 9000 + number,
    number,
    title,
    milestone: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: issueUpdatedAt,
    assignees: [],
    inProgress: null,
  };
}

function sourceInputs() {
  return [
    { name: 'core-inventory', status: 'complete' },
    { name: 'issue-comments', status: 'complete' },
    { name: 'repository-tree', status: 'complete' },
    { name: 'selected-file-context', status: 'complete' },
    { name: 'references', status: 'complete' },
    { name: 'branch-ancestry', status: 'complete' },
  ];
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

function version() {
  const sync = {
    at: generatedAt,
    timeZone: 'UTC',
    branch: 'main',
    commit: 'a'.repeat(40),
    openPullRequests: 0,
  };
  const inventory = {
    board: 'backlog-triage',
    title: 'widgets backlog',
    repo: 'cboone/widgets',
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
    value: fingerprintValue,
    scope: 'core-and-collected-context',
  };
  const comparison = createInitialComparison({
    reportId: identity.reportId,
    generatedAt,
    source: { fingerprint },
    report,
  });
  return {
    schemaVersion: SUCCESSFUL_REPORT_VERSION_SCHEMA_VERSION,
    reportId: identity.reportId,
    jobId: identity.jobId,
    ownerId: 99961,
    repositoryId: 17,
    generatedAt,
    report,
    inventory,
    comparison,
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
        repository: {
          id: 17,
          fullName: 'cboone/widgets',
          name: 'widgets',
          private: true,
          url: 'https://github.com/cboone/widgets',
        },
        observedFrom,
        observedTo: generatedAt,
        consistency: 'two-pass-matched',
        inputs: sourceInputs(),
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

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseObjectKeys(child)]),
    );
  return value;
}

function addUnknownNestedComparisonField(candidate) {
  const previousReport = structuredClone(candidate.report);
  candidate.report.issues[0].waitingOn = [
    { pr: 99, title: 'External dependency' },
  ];
  candidate.report.issues[0].blockedBecause =
    'The external dependency must finish first.';
  candidate.comparison = createReportComparison(
    {
      reportId: 'b'.repeat(64),
      generatedAt: '2026-09-18T20:09:00.000Z',
      source: { fingerprint: candidate.source.fingerprint },
      report: previousReport,
    },
    {
      reportId: candidate.reportId,
      generatedAt: candidate.generatedAt,
      source: { fingerprint: candidate.source.fingerprint },
      report: candidate.report,
    },
  );
  const issueChange = candidate.comparison.entries.find(
    (entry) => entry.kind === 'issue' && entry.issueNumber === 1,
  );
  issueChange.after.waitingOn[0].privateMarker = 'must-not-cross';
}

test('projects the exact successful envelope and retains only bounded provenance', () => {
  const candidate = version();
  const projected = projectSuccessfulReportVersion(candidate);
  assert.deepEqual(projected, candidate);
  assert.notEqual(projected, candidate);
  assert.notEqual(projected.report, candidate.report);
  assert.equal(
    Buffer.byteLength(serializeSuccessfulReportVersion(candidate), 'utf8') <=
      SUCCESSFUL_REPORT_VERSION_MAX_BYTES,
    true,
  );
  const stored = JSON.stringify(projected);
  for (const forbidden of [
    'rawOutput',
    'providerErrorBody',
    'issue body that must not persist',
    'selected file content',
  ])
    assert.equal(stored.includes(forbidden), false);
});

test('canonical serialization and digest ignore input object insertion order', () => {
  const candidate = version();
  const reordered = reverseObjectKeys(candidate);
  assert.equal(
    serializeSuccessfulReportVersion(reordered),
    serializeSuccessfulReportVersion(candidate),
  );
  assert.equal(
    successfulReportVersionDigest(reordered),
    successfulReportVersionDigest(candidate),
  );
  assert.match(successfulReportVersionDigest(candidate), /^[a-f0-9]{64}$/u);
  const prepared = prepareSuccessfulReportVersion(candidate);
  assert.equal(
    prepared.serialized,
    serializeSuccessfulReportVersion(candidate),
  );
  assert.equal(
    prepared.candidateDigest,
    successfulReportVersionDigest(candidate),
  );
  assert.equal(successfulReportVersionKey(candidate), identity.versionKey);
});

test('rejects unknown nested comparison fields at the stored-version boundary', () => {
  const candidate = version();
  addUnknownNestedComparisonField(candidate);
  assert.throws(() => projectSuccessfulReportVersion(candidate), {
    code: 'service_unavailable',
  });
});

test('rejects unknown nested comparison fields at the API boundary', () => {
  const candidate = version();
  addUnknownNestedComparisonField(candidate);
  assert.throws(
    () =>
      projectDirectReportResponse({
        repository: candidate.source.provenance.repository,
        analyzedRepository: candidate.source.provenance.repository,
        current: {
          reportId: candidate.reportId,
          generatedAt: candidate.generatedAt,
          sourceFingerprint: candidate.source.fingerprint.value,
        },
        previous: null,
        report: candidate.report,
        inventory: candidate.inventory,
        comparison: candidate.comparison,
        source: candidate.source,
        analysis: candidate.analysis,
        sourceCheck: null,
        lastAnalysisAttempt: null,
        activeJob: null,
        spendMode: { available: true, mode: 'setup', reason: null },
      }),
    { code: 'service_unavailable' },
  );
});

test('retains exact selected identities, hashes, bounds, and safe omission reasons', () => {
  const candidate = version();
  const selection = candidate.source.provenance.analysisSelection;
  const selectedBlob = 'e'.repeat(40);
  candidate.source.provenance.inputs[3].status = 'bounded';
  candidate.source.provenance.files = [
    { path: 'README.md', blobId: selectedBlob },
  ];
  candidate.source.counts.issueComments = 2;
  candidate.source.counts.treeEntries = 2;
  candidate.source.counts.selectedFiles = 1;
  selection.selectedComments = [
    { id: 71, issueId: 9001, bodyHash: '1'.repeat(64) },
  ];
  selection.selectedFiles = [
    {
      path: 'README.md',
      blobId: selectedBlob,
      relevanceClass: 'guidance',
    },
  ];
  selection.omissions = [
    {
      kind: 'comment',
      id: 72,
      issueId: 9001,
      contentHash: '2'.repeat(64),
      ruleIds: ['optional-comment-item-bytes'],
    },
    {
      kind: 'file',
      path: 'docs/ignored.pdf',
      blobId: 'f'.repeat(40),
      ruleIds: ['collector-binary'],
    },
  ];
  selection.selectedCounts = { comments: 1, files: 1, total: 2 };
  selection.omittedCounts = { comments: 1, files: 1, total: 2 };
  selection.countAttempts.push({
    prefixLength: 2,
    inputTokens: 1400,
    countRequestBytes: 5000,
    messageRequestBytes: 5200,
  });
  selection.limited = true;
  selection.limitations = ['collector-binary', 'optional-comment-item-bytes'];

  const projected = projectSuccessfulReportVersion(candidate);
  assert.deepEqual(projected.source.provenance.analysisSelection, selection);
});

for (const [name, mutate] of [
  ['top-level credentials', (value) => (value.credentials = 'private')],
  [
    'raw issue bodies',
    (value) =>
      (value.report.issues[0].body = 'issue body that must not persist'),
  ],
  [
    'raw inventory comments',
    (value) => (value.inventory.issues[0].comments = ['private comment']),
  ],
  [
    'repository tree data',
    (value) => (value.source.provenance.tree = [{ path: 'private.txt' }]),
  ],
  [
    'provider output',
    (value) => (value.analysis.rawOutput = '{"private":true}'),
  ],
  [
    'provider error bodies',
    (value) =>
      (value.analysis.attempts[0].providerErrorBody = 'provider-private'),
  ],
  [
    'selected file content',
    (value) =>
      (value.source.provenance.analysisSelection.selectedFiles = [
        {
          path: 'README.md',
          blobId: 'e'.repeat(40),
          relevanceClass: 'guidance',
          content: 'selected file content',
        },
      ]),
  ],
]) {
  test(`rejects ${name} rather than silently projecting it away`, () => {
    const candidate = version();
    mutate(candidate);
    assert.throws(() => projectSuccessfulReportVersion(candidate), {
      code: 'service_unavailable',
    });
  });
}

test('binds report identity, source metadata, comparison result and exact cost', () => {
  for (const mutate of [
    (value) => (value.reportId = 'f'.repeat(64)),
    (value) => (value.source.sync.commit = 'b'.repeat(40)),
    (value) => (value.comparison.result.reportId = 'e'.repeat(64)),
    (value) => (value.source.provenance.repository.id = 18),
    (value) => (value.analysis.attempts[0].costMicrousd += 1),
    (value) => {
      const attempt = value.analysis.attempts[0];
      attempt.inputTokens = SETUP_SPEND_LIMITS.attemptInputTokens + 1;
      attempt.costMicrousd =
        attempt.inputTokens * attempt.rates.inputRateMicrousd +
        attempt.outputTokens * attempt.rates.outputRateMicrousd;
    },
    (value) => {
      const attempt = value.analysis.attempts[0];
      attempt.outputTokens = SETUP_SPEND_LIMITS.attemptOutputTokens + 1;
      attempt.costMicrousd =
        attempt.inputTokens * attempt.rates.inputRateMicrousd +
        attempt.outputTokens * attempt.rates.outputRateMicrousd;
    },
    (value) =>
      (value.source.provenance.analysisSelection.limits.inputTokens -= 1),
  ]) {
    const candidate = version();
    mutate(candidate);
    assert.throws(() => projectSuccessfulReportVersion(candidate), {
      code: 'service_unavailable',
    });
  }
});

test('enforces the five MiB cap on canonical UTF-8, including multibyte text', () => {
  const candidate = version();
  const title = '🧭'.repeat(2000);
  candidate.inventory.issues = [];
  candidate.report.issues = [];
  candidate.report.lanes = [
    { key: 'L1', name: 'All issues', mode: 'any', issues: [] },
  ];
  candidate.report.startNow = [];
  candidate.report.notes = { startNow: 'No starts selected for this fixture.' };
  for (let number = 1; number <= 400; number += 1) {
    const item = issue(number, title);
    candidate.inventory.issues.push(item);
    candidate.report.issues.push(structuredClone(item));
    candidate.report.lanes[0].issues.push(number);
  }
  candidate.source.counts.openIssues = 400;
  candidate.comparison = createInitialComparison({
    reportId: candidate.reportId,
    generatedAt: candidate.generatedAt,
    source: { fingerprint: candidate.source.fingerprint },
    report: candidate.report,
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(candidate), 'utf8') >
      SUCCESSFUL_REPORT_VERSION_MAX_BYTES,
  );
  assert.throws(() => projectSuccessfulReportVersion(candidate), {
    code: 'service_unavailable',
  });
});

test('projects and buffers a near-five-MiB authenticated report below the API ceiling', () => {
  const candidate = version();
  const title = '🧭'.repeat(2000);
  candidate.inventory.issues = [];
  candidate.report.issues = [];
  candidate.report.lanes = [
    { key: 'L1', name: 'All issues', mode: 'any', issues: [] },
  ];
  candidate.report.startNow = [];
  candidate.report.notes = { startNow: 'No starts selected for this fixture.' };
  for (let number = 1; number <= 300; number += 1) {
    const item = issue(number, title);
    candidate.inventory.issues.push(item);
    candidate.report.issues.push(structuredClone(item));
    candidate.report.lanes[0].issues.push(number);
  }
  candidate.source.counts.openIssues = 300;
  candidate.comparison = createInitialComparison({
    reportId: candidate.reportId,
    generatedAt: candidate.generatedAt,
    source: { fingerprint: candidate.source.fingerprint },
    report: candidate.report,
  });
  const storedBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
  assert.ok(storedBytes > 4.5 * 1024 * 1024);
  assert.ok(storedBytes <= SUCCESSFUL_REPORT_VERSION_MAX_BYTES);
  projectSuccessfulReportVersion(candidate);

  const response = projectDirectReportResponse({
    repository: candidate.source.provenance.repository,
    analyzedRepository: candidate.source.provenance.repository,
    current: {
      reportId: candidate.reportId,
      generatedAt: candidate.generatedAt,
      sourceFingerprint: candidate.source.fingerprint.value,
    },
    previous: null,
    report: candidate.report,
    inventory: candidate.inventory,
    comparison: candidate.comparison,
    source: candidate.source,
    analysis: candidate.analysis,
    sourceCheck: null,
    lastAnalysisAttempt: null,
    activeJob: null,
    spendMode: { available: true, mode: 'setup', reason: null },
  });
  const serialized = serializeApiResponse(response);
  assert.ok(Buffer.byteLength(serialized, 'utf8') > 4.5 * 1024 * 1024);
  assert.ok(
    Buffer.byteLength(serialized, 'utf8') <= API_RESPONSE_LIMITS.jsonBytes,
  );
});

test('proves an immutable stored value only with the same digest and identities', () => {
  const candidate = version();
  const candidateDigest = successfulReportVersionDigest(candidate);
  assert.equal(
    matchesStoredSuccessfulReportVersion({
      candidate,
      candidateDigest,
      stored: reverseObjectKeys(candidate),
    }),
    true,
  );
  const different = version();
  different.analysis.attempts[0].terminalClass = 'accepted';
  assert.equal(
    matchesStoredSuccessfulReportVersion({
      candidate,
      candidateDigest,
      stored: different,
    }),
    false,
  );
  different.analysis.rawOutput = 'private';
  assert.equal(
    matchesStoredSuccessfulReportVersion({
      candidate,
      candidateDigest,
      stored: different,
    }),
    false,
  );
});

test('writes onlyIfNew and confirms new, conflicting and lost-ack writes by strong read', async () => {
  const candidate = version();
  const key = successfulReportVersionKey(candidate);

  for (const scenario of ['written', 'existing', 'lost-ack']) {
    let stored = scenario === 'existing' ? structuredClone(candidate) : null;
    let writes = 0;
    let reads = 0;
    const storage = {
      async write(actualKey, value, condition) {
        writes += 1;
        assert.equal(actualKey, key);
        assert.deepEqual(condition, { onlyIfNew: true });
        if (scenario === 'existing') return { modified: false };
        stored = structuredClone(value);
        if (scenario === 'lost-ack') throw new Error('synthetic lost ack');
        return { modified: true, etag: '"new"' };
      },
      async read(actualKey) {
        reads += 1;
        assert.equal(actualKey, key);
        return stored === null
          ? null
          : { value: structuredClone(stored), etag: '"strong"' };
      },
    };
    const result = await writeSuccessfulReportVersion({
      storage,
      versionKey: key,
      version: candidate,
    });
    assert.equal(
      result.status,
      scenario === 'lost-ack' ? 'recovered' : scenario,
    );
    assert.equal(
      result.candidateDigest,
      successfulReportVersionDigest(candidate),
    );
    assert.equal(writes, 1);
    assert.equal(reads, 1);
  }
});

test('a conflict or uncertain write cannot accept a different immutable value', async () => {
  const candidate = version();
  const different = version();
  different.analysis.attempts[0].terminalClass = 'accepted';
  const key = successfulReportVersionKey(candidate);
  for (const write of [
    async () => ({ modified: false }),
    async () => {
      throw new Error('synthetic lost ack');
    },
  ]) {
    await assert.rejects(
      writeSuccessfulReportVersion({
        versionKey: key,
        version: candidate,
        storage: {
          write,
          read: async () => ({ value: different, etag: '"strong"' }),
        },
      }),
      { code: 'service_unavailable' },
    );
  }
});
