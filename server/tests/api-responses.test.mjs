import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_RESPONSE_LIMITS,
  projectAnalysisAvailabilityResponse,
  projectAnalysisPreflightResponse,
  projectCatalogPageResponse,
  projectDirectReportResponse,
  projectJobResponse,
  projectRepositoryListResponse,
  projectSessionResponse,
  projectSetupDecisionResponse,
  serializeApiResponse,
} from '../lib/api-responses.mjs';

const repository = {
  id: 17,
  fullName: 'cboone/widgets',
  name: 'widgets',
  private: true,
  url: 'https://github.com/cboone/widgets',
};
const spendMode = {
  available: false,
  mode: 'setup',
  reason: 'budget_discussion_required',
};
const analysisReadiness = {
  ready: false,
  reason: 'analysis_preflight_required',
};
const setupBudget = {
  mode: 'setup',
  status: 'discussion-required',
  currency: 'USD',
  policyId: 'setup-opus-5-global-standard-v1',
  model: 'claude-opus-5',
  settledMicrousd: 1_000_000,
  reservedMicrousd: 20_000_000,
  unknownMicrousd: 500_000,
  exposureMicrousd: 21_500_000,
  capMicrousd: 25_000_000,
  discussionMicrousd: 20_000_000,
  remainingMicrousd: 3_500_000,
  pricingValidThrough: '2026-09-26T05:35:41.000Z',
  discussion: {
    status: 'required',
    currentRevision: 2,
    triggerExposureMicrousd: 21_500_000,
  },
};
const preflightMarker = {
  schemaVersion: 1,
  ownerId: 99961,
  deployId: 'deploy-1',
  policyId: 'setup-policy-v1',
  requestContractHash: 'd'.repeat(64),
  model: 'claude-opus-5',
  effort: 'high',
  modelMaxInputTokens: 1_000_000,
  modelMaxOutputTokens: 32_000,
  configuredInputTokens: 100_000,
  configuredOutputTokens: 16_384,
  inputTokens: 12_345,
  countRequestBytes: 123_456,
  messageRequestBytes: 123_512,
  verifiedAt: '2026-09-19T12:00:00.000Z',
};
const job = {
  id: 'a'.repeat(64),
  operation: 'generate',
  state: 'queued',
  createdAt: '2026-09-19T12:00:00.000Z',
  errorCode: null,
  reportId: null,
};
const emptyReport = () => ({
  repository: structuredClone(repository),
  analyzedRepository: null,
  current: null,
  previous: null,
  report: null,
  inventory: null,
  comparison: null,
  source: null,
  analysis: null,
  sourceCheck: null,
  lastAnalysisAttempt: null,
  activeJob: null,
  spendMode: structuredClone(spendMode),
});

test('projects every JSON response family through an exact recursive allowlist', () => {
  const cases = [
    [projectSessionResponse, { auth: false }],
    [
      projectSessionResponse,
      {
        auth: true,
        user: { id: 99961, login: 'cboone' },
        csrfToken: 'c'.repeat(43),
        sourceAuthorization: 'ready',
      },
    ],
    [projectRepositoryListResponse, { repositories: [repository] }],
    [
      projectCatalogPageResponse,
      {
        items: [
          {
            repository,
            current: {
              reportId: 'b'.repeat(64),
              generatedAt: '2026-09-19T12:00:00.000Z',
              sourceFingerprint: 'c'.repeat(64),
            },
            sourceStatus: 'complete',
            activeJob: null,
          },
        ],
        nextCursor: null,
      },
    ],
    [projectDirectReportResponse, emptyReport()],
    [
      projectAnalysisAvailabilityResponse,
      { spendMode, analysisReadiness, setupBudget },
    ],
    [
      projectAnalysisPreflightResponse,
      {
        marker: preflightMarker,
      },
      {
        preflight: {
          status: 'ready',
          ...Object.fromEntries(
            Object.entries(preflightMarker).filter(
              ([key]) => !['schemaVersion', 'ownerId'].includes(key),
            ),
          ),
        },
      },
    ],
    [projectJobResponse, { job }],
    [
      projectSetupDecisionResponse,
      { status: 'updated', spendMode, analysisReadiness, setupBudget },
    ],
  ];
  for (const [project, value, expected = value] of cases) {
    const projected = project(structuredClone(value));
    assert.deepEqual(projected, expected);
    const unexpected = structuredClone(value);
    unexpected.privateMarker = 'must-not-cross';
    assert.throws(() => project(unexpected), { code: 'internal_error' });
  }

  const nested = { repositories: [{ ...repository, privateMarker: true }] };
  assert.throws(() => projectRepositoryListResponse(nested), {
    code: 'service_unavailable',
  });
});

test('rejects inconsistent setup budget aggregates and discussion states', () => {
  const project = (candidate) =>
    projectAnalysisAvailabilityResponse({
      spendMode,
      analysisReadiness,
      setupBudget: candidate,
    });
  for (const candidate of [
    { ...setupBudget, exposureMicrousd: setupBudget.exposureMicrousd + 1 },
    { ...setupBudget, remainingMicrousd: setupBudget.remainingMicrousd + 1 },
    { ...setupBudget, currency: 'EUR' },
    {
      ...setupBudget,
      discussion: { ...setupBudget.discussion, status: 'acknowledged' },
    },
    { ...setupBudget, privateRevision: 7 },
  ])
    assert.throws(() => project(candidate), { code: 'internal_error' });
});

test('projects a scope gate below the discussion threshold and bounds its trigger', () => {
  const scopeGate = {
    ...setupBudget,
    settledMicrousd: 1,
    reservedMicrousd: 0,
    unknownMicrousd: 0,
    exposureMicrousd: 1,
    remainingMicrousd: 24_999_999,
    discussion: {
      ...setupBudget.discussion,
      currentRevision: 2,
      triggerExposureMicrousd: 10_819_201,
    },
  };
  assert.deepEqual(
    projectAnalysisAvailabilityResponse({
      spendMode,
      analysisReadiness,
      setupBudget: scopeGate,
    }).setupBudget,
    scopeGate,
  );
  assert.deepEqual(
    projectSetupDecisionResponse({
      status: 'conflict',
      spendMode,
      analysisReadiness,
      setupBudget: scopeGate,
    }).setupBudget,
    scopeGate,
  );
  for (const triggerExposureMicrousd of [-1, 25_000_001])
    assert.throws(
      () =>
        projectAnalysisAvailabilityResponse({
          spendMode,
          analysisReadiness,
          setupBudget: {
            ...scopeGate,
            discussion: {
              ...scopeGate.discussion,
              triggerExposureMicrousd,
            },
          },
        }),
      { code: 'internal_error' },
    );
});

test('enforces the final buffered JSON ceiling on exact UTF-8 bytes', () => {
  const below = 'x'.repeat(API_RESPONSE_LIMITS.jsonBytes - 3);
  assert.equal(
    Buffer.byteLength(serializeApiResponse(below), 'utf8'),
    API_RESPONSE_LIMITS.jsonBytes - 1,
  );
  assert.throws(() => serializeApiResponse(`${below}x`), {
    code: 'internal_error',
  });
  const multibyte = '🧭'.repeat(
    Math.floor((API_RESPONSE_LIMITS.jsonBytes - 3) / 4),
  );
  assert.ok(
    Buffer.byteLength(serializeApiResponse(multibyte), 'utf8') <
      API_RESPONSE_LIMITS.jsonBytes,
  );
  assert.throws(() => serializeApiResponse(`${multibyte}🧭`), {
    code: 'internal_error',
  });
});

test('rejects inconsistent or oversized analysis preflight facts', () => {
  for (const marker of [
    { ...preflightMarker, configuredInputTokens: 99_999 },
    { ...preflightMarker, configuredOutputTokens: 16_383 },
    { ...preflightMarker, modelMaxInputTokens: 99_999 },
    { ...preflightMarker, modelMaxOutputTokens: 16_383 },
    { ...preflightMarker, countRequestBytes: 8 * 1024 * 1024 + 1 },
    { ...preflightMarker, messageRequestBytes: 8 * 1024 * 1024 + 1 },
  ])
    assert.throws(() => projectAnalysisPreflightResponse({ marker }), {
      code: 'internal_error',
    });
});
