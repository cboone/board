import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANALYSIS_RESULT_CLASSIFICATION,
  AnalysisResultValidationError,
  assembleSuccessfulAnalysisResult,
} from '../lib/analysis-result.mjs';
import {
  ANALYSIS_INPUT_LIMITS,
  ANALYSIS_INPUT_WIRE_VERSION,
} from '../lib/analysis-input.mjs';
import { transitionJob } from '../lib/job-machine.mjs';
import { createAnalysisJob } from '../lib/jobs.mjs';
import { sourceDigest } from '../lib/fingerprint.mjs';
import { SETUP_POLICY_ID, SETUP_SPEND_LIMITS } from '../lib/spend.mjs';

const hash = (character) => character.repeat(64);
const at = (hour, minute) =>
  `2026-09-18T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
const repository = Object.freeze({
  id: 17,
  fullName: 'cboone/widgets',
  name: 'widgets',
  private: true,
  url: 'https://github.com/cboone/widgets',
});

const sourceInputs = () => [
  { name: 'core-inventory', status: 'complete' },
  { name: 'issue-comments', status: 'complete' },
  { name: 'repository-tree', status: 'complete' },
  { name: 'selected-file-context', status: 'complete' },
  { name: 'references', status: 'complete' },
  { name: 'branch-ancestry', status: 'complete' },
];

function analysisSelection(analysisInput) {
  const mandatory = structuredClone(analysisInput);
  mandatory.comments = [];
  mandatory.repositoryTree = mandatory.repositoryTree.map((entry) => {
    const projected = { ...entry };
    delete projected.selectedContent;
    return projected;
  });
  return {
    version: 'analysis-selection-v1',
    wireVersion: ANALYSIS_INPUT_WIRE_VERSION,
    sourceSafetyPolicyVersion: 'source-safety-v1',
    sourcePathExtractorVersion: 1,
    mandatoryManifestHash: sourceDigest(mandatory),
    selectedComments: [],
    selectedFiles: [],
    omissions: [],
    selectedCounts: { comments: 0, files: 0, total: 0 },
    omittedCounts: { comments: 0, files: 0, total: 0 },
    countAttempts: [
      {
        prefixLength: 0,
        inputTokens: 1000,
        countRequestBytes: 4096,
        messageRequestBytes: 4200,
      },
    ],
    limits: { ...ANALYSIS_INPUT_LIMITS },
    limited: false,
    limitations: [],
  };
}

function accounting(sequence = 1) {
  return {
    status: 'pending',
    ledgerRevision: sequence,
    accountingSequence: sequence,
    accountingDigest: hash('7'),
    transitionId: hash('8'),
  };
}

function validatingJob({
  hour,
  idempotencyKey,
  operation = 'generate',
  expectedCurrentReportId = null,
  fingerprint = hash('d'),
} = {}) {
  let job = createAnalysisJob({
    ownerId: 99961,
    repositoryId: repository.id,
    idempotencyKey,
    operation,
    expectedCurrentReportId,
    authorizationEpoch: 2,
    admissionDeployId: 'deploy-1',
    at: at(hour, 0),
    deadlineAt: at(hour, 30),
  });
  job = transitionJob(job, {
    type: 'reservation-committed',
    at: at(hour, 1),
    deadlineAt: at(hour, 30),
    pricePolicyId: SETUP_POLICY_ID,
    reservationMicrousd: [
      SETUP_SPEND_LIMITS.attemptCostMicrousd,
      SETUP_SPEND_LIMITS.attemptCostMicrousd,
    ],
    accounting: accounting(),
  });
  job = transitionJob(job, {
    type: 'dispatch-installed',
    at: at(hour, 2),
    deadlineAt: at(hour, 30),
    capabilityHash: hash('1'),
  });
  job = transitionJob(job, {
    type: 'free-lease-claimed',
    at: at(hour, 3),
    phase: 'collecting',
    tokenHash: hash('2'),
    expiresAt: at(hour, 10),
  });
  job = transitionJob(job, {
    type: 'free-lease-claimed',
    at: at(hour, 4),
    phase: 'counting',
    tokenHash: hash('2'),
    expiresAt: at(hour, 11),
  });
  job = transitionJob(job, {
    type: 'primary-started',
    at: at(hour, 5),
    freeTokenHash: hash('2'),
    attemptTokenHash: hash('3'),
    deadlineAt: at(hour, 15),
    sourceFingerprint: fingerprint,
  });
  job = transitionJob(job, {
    type: 'response-completed',
    at: at(hour, 6),
    number: 1,
    attemptTokenHash: hash('3'),
    deadlineAt: at(hour, 12),
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
  return transitionJob(job, {
    type: 'finalization-claimed',
    at: at(hour, 7),
    number: 1,
    attemptTokenHash: hash('3'),
    finalizationTokenHash: hash('4'),
    expiresAt: at(hour, 20),
  });
}

function validatingCorrectiveJob(options) {
  const hour = options.hour;
  let job = validatingJob(options);
  job = transitionJob(job, {
    type: 'primary-rejected',
    at: at(hour, 8),
    attemptTokenHash: hash('3'),
    finalizationTokenHash: hash('4'),
    classification: ANALYSIS_RESULT_CLASSIFICATION,
  });
  job = transitionJob(job, {
    type: 'accounting-recorded',
    at: at(hour, 9),
    deadlineAt: at(hour, 20),
    attemptTokenHash: hash('3'),
    finalizationTokenHash: hash('4'),
    attemptUpdates: [{ number: 1, state: 'settled' }],
    accounting: {
      ...accounting(2),
      accountingDigest: hash('9'),
      transitionId: hash('a'),
    },
  });
  job = transitionJob(job, {
    type: 'corrective-started',
    at: at(hour, 10),
    primaryAttemptTokenHash: hash('3'),
    finalizationTokenHash: hash('4'),
    correctiveAttemptTokenHash: hash('5'),
    deadlineAt: at(hour, 15),
  });
  job = transitionJob(job, {
    type: 'response-completed',
    at: at(hour, 11),
    number: 2,
    attemptTokenHash: hash('5'),
    deadlineAt: at(hour, 14),
    usage: {
      terminalClass: 'complete-response',
      terminalStopReason: 'end_turn',
      inputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 50,
      costMicrousd: 3750,
    },
  });
  return transitionJob(job, {
    type: 'finalization-claimed',
    at: at(hour, 12),
    number: 2,
    attemptTokenHash: hash('5'),
    finalizationTokenHash: hash('6'),
    expiresAt: at(hour, 20),
  });
}

function inventory(sync, title = 'Canonical issue title') {
  return {
    board: 'backlog-triage',
    title: 'widgets backlog',
    repo: repository.fullName,
    repoUrl: repository.url,
    sync: structuredClone(sync),
    issues: [
      {
        id: 9001,
        number: 1,
        title,
        milestone: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        updatedAt: '2026-09-18T11:00:00.000Z',
        assignees: [],
        inProgress: null,
      },
    ],
  };
}

function analysisInput(sync, title, priorAnalysis = null, rawSource = null) {
  return {
    wireVersion: ANALYSIS_INPUT_WIRE_VERSION,
    repository: {
      id: repository.id,
      fullName: repository.fullName,
      defaultBranch: sync.branch,
      defaultTip: sync.commit,
    },
    limitations: [],
    priorAnalysis,
    issueCatalog: [
      {
        id: 9001,
        number: 1,
        title,
        milestoneId: null,
        inProgress: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        updatedAt: '2026-09-18T11:00:00.000Z',
      },
    ],
    milestoneCatalog: [],
    labelCatalog: [],
    issueEvidence: [
      {
        issueId: 9001,
        body: rawSource,
        stateReason: null,
        labelIds: [],
      },
    ],
    comments: [],
    pullRequests: [],
    branches: [
      {
        name: sync.branch,
        tip: sync.commit,
        ahead: 0,
        behind: 0,
        unmerged: false,
        verification: 'verified',
      },
    ],
    references: [],
    repositoryTree: [],
  };
}

function delta(summary = 'Start the canonical issue.') {
  return {
    summary,
    issueAnalysis: [],
    lanes: [
      {
        key: 'L1',
        name: 'Report contract',
        mode: 'any',
        issues: [9001],
        owns: '',
        note: '',
      },
    ],
    startNow: [
      {
        issue: 9001,
        why: 'The issue has no known dependency.',
        touches: '',
      },
    ],
    contention: { rowLabel: '', claims: [] },
    notes: { startNow: '', blocked: '', contention: '' },
  };
}

function context({
  hour = 12,
  idempotencyKey = '018f0f11-1111-7111-8111-111111111111',
  operation = 'generate',
  priorVersion = null,
  title = 'Canonical issue title',
  rawSource = 'Raw source evidence that must remain transient.',
  analysisDelta = delta(),
} = {}) {
  const sync = {
    at: at(hour, 4),
    timeZone: 'UTC',
    branch: 'main',
    commit: 'b'.repeat(40),
    openPullRequests: 0,
  };
  const sourceSummary = {
    status: 'complete',
    repo: structuredClone(repository),
    sync: structuredClone(sync),
    fingerprint: {
      algorithm: 'sha256',
      value: hash('d'),
      scope: 'core-and-collected-context',
    },
    provenance: {
      observedFrom: at(hour, 3),
      observedTo: at(hour, 4),
      consistency: 'two-pass-matched',
      inputs: sourceInputs(),
      files: [],
      references: { verified: 0, unverified: 0 },
      limitations: ['Matching observations are not an atomic GitHub snapshot.'],
    },
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
  };
  const expectedCurrentReportId = priorVersion?.reportId ?? null;
  const originalAnalysisInput = analysisInput(
    sync,
    title,
    operation === 'refresh'
      ? {
          issueAnalysis: [],
          lanes: priorVersion.report.lanes,
          startNow: priorVersion.report.startNow,
          contention: priorVersion.report.contention ?? {},
          notes: priorVersion.report.notes ?? {},
        }
      : null,
    rawSource,
  );
  return {
    analysisDelta,
    analysisInput: originalAnalysisInput,
    analysisSelection: analysisSelection(originalAnalysisInput),
    inventory: inventory(sync, title),
    sourceSummary,
    job: validatingJob({
      hour,
      idempotencyKey,
      operation,
      expectedCurrentReportId,
    }),
    generatedAt: at(hour, 8),
    priorVersion,
  };
}

test('assembles a deterministic initial version with exact cost and provenance', () => {
  const input = context();
  const first = assembleSuccessfulAnalysisResult(input);
  const second = assembleSuccessfulAnalysisResult(input);
  assert.deepEqual(second, first);
  assert.match(first.candidateDigest, /^[a-f0-9]{64}$/u);
  assert.equal(first.value.comparison.status, 'initial');
  assert.equal(first.value.comparison.basis, null);
  assert.deepEqual(
    first.value.source.provenance.analysisSelection,
    input.analysisSelection,
  );
  assert.deepEqual(first.value.analysis.attempts, [
    {
      number: 1,
      terminalClass: 'complete-response',
      inputTokens: 1000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 100,
      rates: { inputRateMicrousd: 5, outputRateMicrousd: 25 },
      inferenceGeo: 'global',
      serviceTier: 'standard',
      costMicrousd: 7500,
    },
  ]);
  assert.equal(first.value.report.issues[0].body, undefined);
  assert.doesNotMatch(first.serialized, /Raw source evidence/u);
});

test('rejects unknown source IDs with one bounded output classification', () => {
  const analysisDelta = delta();
  analysisDelta.lanes[0].issues = [9999];
  assert.throws(
    () => assembleSuccessfulAnalysisResult(context({ analysisDelta })),
    (error) => {
      assert.ok(error instanceof AnalysisResultValidationError);
      assert.equal(error.code, ANALYSIS_RESULT_CLASSIFICATION);
      assert.equal(error.classification, ANALYSIS_RESULT_CLASSIFICATION);
      assert.equal(error.message.includes('9999'), false);
      assert.deepEqual(Object.keys(error).sort(), [
        'classification',
        'code',
        'name',
        'retryable',
        'status',
      ]);
      return true;
    },
  );
});

test('applies no-verbatim and output safety only to model-authored persisted text', () => {
  const rawSource =
    'This canonical source sentence is long enough to remain private.';
  assert.throws(
    () =>
      assembleSuccessfulAnalysisResult(
        context({ rawSource, analysisDelta: delta(rawSource) }),
      ),
    (error) => {
      assert.equal(error.code, ANALYSIS_RESULT_CLASSIFICATION);
      assert.doesNotMatch(JSON.stringify(error), /canonical source sentence/u);
      assert.doesNotMatch(error.message, /canonical source sentence/u);
      return true;
    },
  );

  const canonical = assembleSuccessfulAnalysisResult(
    context({ rawSource, title: rawSource }),
  );
  assert.equal(canonical.value.report.issues[0].title, rawSource);

  assert.throws(
    () =>
      assembleSuccessfulAnalysisResult(
        context({
          rawSource: 'Unrelated source.',
          analysisDelta: delta('password=actual-provider-secret'),
        }),
      ),
    { code: ANALYSIS_RESULT_CLASSIFICATION },
  );
});

test('creates unchanged and changed refresh comparisons against the exact basis', () => {
  const initialInput = context({
    analysisDelta: delta('Preserve accepted prior analysis.'),
  });
  const initial = assembleSuccessfulAnalysisResult(initialInput).value;
  const refreshInput = context({
    hour: 13,
    idempotencyKey: '018f0f11-2222-7222-8222-222222222222',
    operation: 'refresh',
    priorVersion: initial,
    analysisDelta: delta('Preserve accepted prior analysis.'),
  });
  const unchanged = assembleSuccessfulAnalysisResult(refreshInput).value;
  assert.equal(unchanged.comparison.status, 'unchanged');
  assert.equal(unchanged.comparison.basis.reportId, initial.reportId);
  assert.deepEqual(unchanged.comparison.entries, []);

  const changed = assembleSuccessfulAnalysisResult({
    ...refreshInput,
    analysisDelta: delta('The recommended start reason changed.'),
  }).value;
  assert.equal(changed.comparison.status, 'changed');
  assert.deepEqual(
    changed.comparison.entries.map(({ kind }) => kind),
    ['prose'],
  );
});

test('rejects a source fingerprint or refresh basis that is not the job basis', () => {
  const mismatchedSource = context();
  mismatchedSource.sourceSummary.fingerprint.value = hash('e');
  assert.throws(() => assembleSuccessfulAnalysisResult(mismatchedSource), {
    code: 'service_unavailable',
  });

  const initial = assembleSuccessfulAnalysisResult(context()).value;
  const refresh = context({
    hour: 13,
    idempotencyKey: '018f0f11-3333-7333-8333-333333333333',
    operation: 'refresh',
    priorVersion: initial,
  });
  refresh.job.publication.basisReportId = hash('f');
  assert.throws(() => assembleSuccessfulAnalysisResult(refresh), {
    code: 'service_unavailable',
  });
});

test('rejects malformed provider fields and never copies unknown durable fields', () => {
  const rawMarker = 'raw-provider-marker-that-must-not-escape';
  const analysisDelta = { ...delta(), unexpected: rawMarker };
  assert.throws(
    () => assembleSuccessfulAnalysisResult(context({ analysisDelta })),
    (error) => {
      assert.equal(error.code, ANALYSIS_RESULT_CLASSIFICATION);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(rawMarker, 'u'));
      return true;
    },
  );

  const malformedSource = context();
  malformedSource.sourceSummary.rawIssueBody = rawMarker;
  assert.throws(
    () => assembleSuccessfulAnalysisResult(malformedSource),
    (error) => {
      assert.equal(error.code, 'service_unavailable');
      assert.doesNotMatch(JSON.stringify(error), new RegExp(rawMarker, 'u'));
      return true;
    },
  );
});

test('fails closed when durable known usage does not match reviewed rates', () => {
  const input = context();
  input.job.attempts[0].costMicrousd = 7501;
  assert.throws(() => assembleSuccessfulAnalysisResult(input), {
    code: 'service_unavailable',
  });
});

test('records both known attempts for a corrective result', () => {
  const input = context();
  input.generatedAt = at(12, 13);
  input.job = validatingCorrectiveJob({
    hour: 12,
    idempotencyKey: '018f0f11-1111-7111-8111-111111111111',
    fingerprint: hash('d'),
  });
  const candidate = assembleSuccessfulAnalysisResult(input).value;
  assert.deepEqual(
    candidate.analysis.attempts.map(
      ({ number, terminalClass, costMicrousd }) => ({
        number,
        terminalClass,
        costMicrousd,
      }),
    ),
    [
      {
        number: 1,
        terminalClass: ANALYSIS_RESULT_CLASSIFICATION,
        costMicrousd: 7500,
      },
      { number: 2, terminalClass: 'complete-response', costMicrousd: 3750 },
    ],
  );
});
