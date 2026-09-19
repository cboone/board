import { ANALYSIS_INPUT_LIMITS } from './analysis-input.mjs';
import { ANTHROPIC_POLICY } from './anthropic.mjs';
import { BoardError } from './errors.mjs';
import {
  REPORT_STORAGE_LIMITS,
  projectRepositoryIdentity,
  projectRepositoryState,
} from './report-records.mjs';
import { projectSuccessfulReportApiPayload } from './report-versions.mjs';
import { SOURCE_LIMITS } from './source-limits.mjs';

export const API_RESPONSE_LIMITS = Object.freeze({
  jsonBytes: 6 * 1024 * 1024,
});

const HEX_64 = /^[a-f0-9]{64}$/u;
const CURSOR = /^[A-Za-z0-9_-]{1,1024}$/u;
const OPERATIONS = new Set(['generate', 'refresh']);
const JOB_STATES = new Set([
  'queued',
  'gathering',
  'analyzing',
  'validating',
  'publishing',
  'succeeded',
  'failed',
  'ambiguous',
]);
const JOB_ERRORS = new Set([
  'analysis_ambiguous',
  'analysis_input_too_large',
  'analysis_output_invalid',
  'analysis_provider_rate_limited',
  'analysis_provider_unavailable',
  'analysis_preflight_required',
  'analysis_sensitive_input',
  'analysis_unavailable',
  'budget_discussion_required',
  'budget_exhausted',
  'idempotency_conflict',
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
const SOURCE_AUTHORIZATION = new Set([
  'ready',
  'reauthorization-required',
  'installation-required',
  'unverified',
]);
const SOURCE_STATUS = new Set([
  'ready',
  'checking',
  'complete',
  'failed',
  'source-unavailable',
]);
const SPEND_REASONS = new Set([
  'source_unavailable',
  'analysis_unavailable',
  'budget_discussion_required',
  'budget_exhausted',
  'pricing_review_required',
]);

const fail = () => {
  throw new BoardError('internal_error');
};
const text = (value, maximum) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const exact = (value, keys) => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
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

function repository(value) {
  const projected = projectRepositoryIdentity(value);
  if (projected.name.length > 100 || ['.', '..'].includes(projected.name))
    fail();
  return projected;
}

const sameRepository = (left, right) =>
  left.id === right.id &&
  left.fullName === right.fullName &&
  left.name === right.name &&
  left.private === right.private &&
  left.url === right.url;

function pointer(value) {
  if (value === null) return null;
  exact(value, ['reportId', 'generatedAt', 'sourceFingerprint']);
  if (!HEX_64.test(value.reportId) || !HEX_64.test(value.sourceFingerprint))
    fail();
  return {
    reportId: value.reportId,
    generatedAt: iso(value.generatedAt),
    sourceFingerprint: value.sourceFingerprint,
  };
}

function safeJob(value) {
  if (value === null) return null;
  exact(value, [
    'id',
    'operation',
    'state',
    'createdAt',
    'errorCode',
    'reportId',
  ]);
  if (
    !HEX_64.test(value.id) ||
    !OPERATIONS.has(value.operation) ||
    !JOB_STATES.has(value.state) ||
    !(value.errorCode === null || JOB_ERRORS.has(value.errorCode)) ||
    !(value.reportId === null || HEX_64.test(value.reportId))
  )
    fail();
  const terminalFailure = ['failed', 'ambiguous'].includes(value.state);
  if (
    (value.state === 'succeeded' &&
      (value.reportId === null || value.errorCode !== null)) ||
    (terminalFailure &&
      (value.reportId !== null || value.errorCode === null)) ||
    (!terminalFailure &&
      value.state !== 'succeeded' &&
      (value.reportId !== null || value.errorCode !== null))
  )
    fail();
  return {
    id: value.id,
    operation: value.operation,
    state: value.state,
    createdAt: iso(value.createdAt),
    errorCode: value.errorCode,
    reportId: value.reportId,
  };
}

function spendMode(value) {
  exact(value, ['available', 'mode', 'reason']);
  if (
    typeof value.available !== 'boolean' ||
    !['setup', 'production', 'disabled'].includes(value.mode) ||
    !(value.reason === null || SPEND_REASONS.has(value.reason)) ||
    (value.available && (value.mode === 'disabled' || value.reason !== null)) ||
    (!value.available && value.reason === null) ||
    (value.mode === 'disabled' &&
      !['source_unavailable', 'analysis_unavailable'].includes(value.reason)) ||
    (value.mode !== 'disabled' &&
      !value.available &&
      ![
        'budget_discussion_required',
        'budget_exhausted',
        'pricing_review_required',
      ].includes(value.reason))
  )
    fail();
  return {
    available: value.available,
    mode: value.mode,
    reason: value.reason,
  };
}

function analysisReadiness(value) {
  exact(value, ['ready', 'reason']);
  if (
    typeof value.ready !== 'boolean' ||
    (value.ready && value.reason !== null) ||
    (!value.ready && value.reason !== 'analysis_preflight_required')
  )
    fail();
  return { ready: value.ready, reason: value.reason };
}

function repositoryStateMetadata(value, projectedRepository) {
  const state = projectRepositoryState({
    schemaVersion: 1,
    ownerId: 99961,
    repository: projectedRepository,
    revision: 0,
    current: null,
    previous: null,
    activeJob: null,
    sourceCheck: value.sourceCheck,
    lastAnalysisAttempt: value.lastAnalysisAttempt,
  });
  return {
    sourceCheck: state.sourceCheck,
    lastAnalysisAttempt: state.lastAnalysisAttempt,
  };
}

export function projectSessionResponse(value) {
  if (value?.auth === false) {
    exact(value, ['auth']);
    return { auth: false };
  }
  exact(value, ['auth', 'user', 'csrfToken', 'sourceAuthorization']);
  exact(value.user, ['id', 'login']);
  if (
    value.auth !== true ||
    value.user.id !== 99961 ||
    !text(value.user.login, 100) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u.test(
      value.user.login,
    ) ||
    !text(value.csrfToken, 256) ||
    value.csrfToken.length < 32 ||
    !SOURCE_AUTHORIZATION.has(value.sourceAuthorization)
  )
    fail();
  return {
    auth: true,
    user: { id: value.user.id, login: value.user.login },
    csrfToken: value.csrfToken,
    sourceAuthorization: value.sourceAuthorization,
  };
}

export function projectRepositoryListResponse(value) {
  exact(value, ['repositories']);
  if (
    !Array.isArray(value.repositories) ||
    value.repositories.length > SOURCE_LIMITS.repositories
  )
    fail();
  const repositories = value.repositories.map(repository);
  if (new Set(repositories.map(({ id }) => id)).size !== repositories.length)
    fail();
  return { repositories };
}

export function projectCatalogPageResponse(value) {
  exact(value, ['items', 'nextCursor']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > REPORT_STORAGE_LIMITS.catalogPage ||
    !(value.nextCursor === null || CURSOR.test(value.nextCursor))
  )
    fail();
  const seen = new Set();
  const items = value.items.map((item) => {
    exact(item, ['repository', 'current', 'sourceStatus', 'activeJob']);
    const projectedRepository = repository(item.repository);
    const current = pointer(item.current);
    if (
      current === null ||
      seen.has(projectedRepository.id) ||
      !SOURCE_STATUS.has(item.sourceStatus)
    )
      fail();
    seen.add(projectedRepository.id);
    return {
      repository: projectedRepository,
      current,
      sourceStatus: item.sourceStatus,
      activeJob: safeJob(item.activeJob),
    };
  });
  return { items, nextCursor: value.nextCursor };
}

export function projectDirectReportResponse(value) {
  exact(value, [
    'repository',
    'analyzedRepository',
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
  const projectedRepository = repository(value.repository);
  const analyzedRepository =
    value.analyzedRepository === null
      ? null
      : repository(value.analyzedRepository);
  if (
    analyzedRepository !== null &&
    analyzedRepository.id !== projectedRepository.id
  )
    fail();
  const current = pointer(value.current);
  const previous = pointer(value.previous);
  if (current !== null && previous?.reportId === current.reportId) fail();
  const metadata = repositoryStateMetadata(value, projectedRepository);
  const activeJob = safeJob(value.activeJob);
  const projectedSpendMode = spendMode(value.spendMode);
  let payload = {
    report: null,
    inventory: null,
    comparison: null,
    source: null,
    analysis: null,
  };
  if (current === null) {
    if (
      analyzedRepository !== null ||
      previous !== null ||
      [
        value.report,
        value.inventory,
        value.comparison,
        value.source,
        value.analysis,
      ].some((entry) => entry !== null) ||
      activeJob?.operation === 'refresh'
    )
      fail();
  } else {
    if (analyzedRepository === null) fail();
    payload = projectSuccessfulReportApiPayload(
      {
        report: value.report,
        inventory: value.inventory,
        comparison: value.comparison,
        source: value.source,
        analysis: value.analysis,
      },
      {
        reportId: current.reportId,
        repositoryId: analyzedRepository.id,
        generatedAt: current.generatedAt,
      },
    );
    const sourceRepository = payload.source.provenance.repository;
    if (
      !sameRepository(sourceRepository, analyzedRepository) ||
      current.sourceFingerprint !== payload.source.fingerprint.value ||
      (previous === null
        ? payload.comparison.basis !== null
        : payload.comparison.basis === null ||
          payload.comparison.basis.reportId !== previous.reportId ||
          payload.comparison.basis.generatedAt !== previous.generatedAt ||
          payload.comparison.basis.sourceFingerprint.value !==
            previous.sourceFingerprint)
    )
      fail();
  }
  return {
    repository: projectedRepository,
    analyzedRepository,
    current,
    previous,
    ...payload,
    ...metadata,
    activeJob,
    spendMode: projectedSpendMode,
  };
}

export function projectAnalysisAvailabilityResponse(value) {
  exact(value, ['spendMode', 'analysisReadiness']);
  return {
    spendMode: spendMode(value.spendMode),
    analysisReadiness: analysisReadiness(value.analysisReadiness),
  };
}

export function projectAnalysisPreflightResponse(value) {
  exact(value, ['marker']);
  exact(value.marker, [
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
  const marker = value.marker;
  if (
    marker.schemaVersion !== 1 ||
    marker.ownerId !== 99961 ||
    !text(marker.deployId, 128) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(marker.policyId) ||
    !HEX_64.test(marker.requestContractHash) ||
    marker.model !== 'claude-opus-5' ||
    marker.effort !== 'high' ||
    !Number.isSafeInteger(marker.modelMaxInputTokens) ||
    marker.modelMaxInputTokens < marker.configuredInputTokens ||
    !Number.isSafeInteger(marker.modelMaxOutputTokens) ||
    marker.modelMaxOutputTokens < marker.configuredOutputTokens ||
    marker.configuredInputTokens !== ANALYSIS_INPUT_LIMITS.inputTokens ||
    marker.configuredOutputTokens !== ANTHROPIC_POLICY.maxTokens ||
    !Number.isSafeInteger(marker.inputTokens) ||
    marker.inputTokens < 0 ||
    marker.inputTokens > marker.configuredInputTokens ||
    !Number.isSafeInteger(marker.countRequestBytes) ||
    marker.countRequestBytes < 1 ||
    marker.countRequestBytes > ANTHROPIC_POLICY.requestBytes ||
    !Number.isSafeInteger(marker.messageRequestBytes) ||
    marker.messageRequestBytes < 1 ||
    marker.messageRequestBytes > ANTHROPIC_POLICY.requestBytes
  )
    fail();
  return {
    preflight: {
      status: 'ready',
      deployId: marker.deployId,
      policyId: marker.policyId,
      requestContractHash: marker.requestContractHash,
      model: marker.model,
      effort: marker.effort,
      modelMaxInputTokens: marker.modelMaxInputTokens,
      modelMaxOutputTokens: marker.modelMaxOutputTokens,
      configuredInputTokens: marker.configuredInputTokens,
      configuredOutputTokens: marker.configuredOutputTokens,
      inputTokens: marker.inputTokens,
      countRequestBytes: marker.countRequestBytes,
      messageRequestBytes: marker.messageRequestBytes,
      verifiedAt: iso(marker.verifiedAt),
    },
  };
}

export function projectJobResponse(value) {
  exact(value, ['job']);
  const job = safeJob(value.job);
  if (job === null) fail();
  return { job };
}

export function projectSetupDecisionResponse(value) {
  exact(value, ['status', 'spendMode']);
  if (!['updated', 'existing', 'conflict'].includes(value.status)) fail();
  return { status: value.status, spendMode: spendMode(value.spendMode) };
}

export function serializeApiResponse(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail();
  }
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') >= API_RESPONSE_LIMITS.jsonBytes
  )
    fail();
  return serialized;
}
