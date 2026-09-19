import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_RESPONSE_LIMITS,
  projectAnalysisAvailabilityResponse,
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
const spendMode = { available: true, mode: 'setup', reason: null };
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
    [projectAnalysisAvailabilityResponse, { spendMode }],
    [projectJobResponse, { job }],
    [projectSetupDecisionResponse, { status: 'updated', spendMode }],
  ];
  for (const [project, value] of cases) {
    const projected = project(structuredClone(value));
    assert.deepEqual(projected, value);
    const unexpected = structuredClone(value);
    unexpected.privateMarker = 'must-not-cross';
    assert.throws(() => project(unexpected), { code: 'internal_error' });
  }

  const nested = { repositories: [{ ...repository, privateMarker: true }] };
  assert.throws(() => projectRepositoryListResponse(nested), {
    code: 'service_unavailable',
  });
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
