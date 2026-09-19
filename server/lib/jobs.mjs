import { createHash, timingSafeEqual } from 'node:crypto';
import { BoardError } from './errors.mjs';

export const JOB_STATE_MACHINE_VERSION = 1;
export const JOB_STATES = Object.freeze([
  'created',
  'reserved',
  'dispatchable',
  'collecting',
  'counting',
  'primary-in-flight',
  'primary-response-complete',
  'validating-primary',
  'primary-invalid',
  'corrective-in-flight',
  'corrective-response-complete',
  'validating-corrective',
  'version-written',
  'published',
  'succeeded',
  'failed',
  'ambiguous',
  'superseded',
  'budget-blocked',
]);
export const TERMINAL_JOB_STATES = Object.freeze([
  'succeeded',
  'failed',
  'ambiguous',
  'superseded',
  'budget-blocked',
]);

const STATES = new Set(JOB_STATES);
const TERMINAL = new Set(TERMINAL_JOB_STATES);
const HEX_64 = /^[a-f0-9]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPERATIONS = new Set(['generate', 'refresh']);
const ATTEMPT_STATES = new Set([
  'unreserved',
  'reserved',
  'in-flight',
  'response-complete',
  'settled',
  'released',
  'unknown',
]);
const ACCOUNTING_STATES = new Set([
  'unreserved',
  'pending',
  'complete',
  'unknown',
]);
const ERROR_CODES = new Set([
  'analysis_ambiguous',
  'analysis_output_invalid',
  'budget_discussion_required',
  'budget_exhausted',
  'idempotency_conflict',
  'pricing_review_required',
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
const digest = (domain, value) =>
  createHash('sha256').update(`${domain}\0${value}`).digest('hex');
const clone = (value) => structuredClone(value);

export function deriveAnalysisJobIdentity({
  ownerId,
  repositoryId,
  idempotencyKey,
}) {
  if (
    ownerId !== 99961 ||
    !positive(repositoryId) ||
    !UUID.test(idempotencyKey)
  )
    fail();
  const canonicalKey = idempotencyKey.toLowerCase();
  const jobId = digest('board-job-id-v1', `${ownerId}:${canonicalKey}`);
  const reportId = digest('board-report-id-v1', jobId);
  return Object.freeze({
    idempotencyKey: canonicalKey,
    jobId,
    reportId,
    versionKey: `owners/${ownerId}/repositories/${repositoryId}/versions/${reportId}`,
  });
}

export function hashDispatchCapability(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value) ||
    Buffer.from(value, 'base64url').length !== 32 ||
    Buffer.from(value, 'base64url').toString('base64url') !== value
  )
    fail();
  return digest('board-dispatch-capability-v1', value);
}

export function matchesDispatchCapability(hash, value) {
  if (!HEX_64.test(hash)) return false;
  try {
    const candidate = hashDispatchCapability(value);
    return timingSafeEqual(Buffer.from(hash), Buffer.from(candidate));
  } catch {
    return false;
  }
}

function projectLease(value) {
  if (value === null) return null;
  exact(value, ['tokenHash', 'expiresAt']);
  if (!HEX_64.test(value.tokenHash)) fail();
  iso(value.expiresAt);
  return clone(value);
}

function projectAttempt(value, expectedNumber) {
  exact(value, [
    'number',
    'reservationMicrousd',
    'state',
    'tokenHash',
    'startedAt',
    'deadlineAt',
    'completedAt',
    'terminalClass',
    'terminalStopReason',
    'inputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'outputTokens',
    'costMicrousd',
  ]);
  if (
    value.number !== expectedNumber ||
    !integer(value.reservationMicrousd) ||
    !ATTEMPT_STATES.has(value.state) ||
    !nullable(value.tokenHash, (item) => HEX_64.test(item)) ||
    !nullable(value.startedAt, (item) => Boolean(iso(item))) ||
    !nullable(value.deadlineAt, (item) => Boolean(iso(item))) ||
    !nullable(value.completedAt, (item) => Boolean(iso(item))) ||
    !nullable(value.terminalClass, (item) => text(item, 128)) ||
    !nullable(value.terminalStopReason, (item) => text(item, 128)) ||
    !nullable(value.inputTokens, integer) ||
    !nullable(value.cacheCreationInputTokens, integer) ||
    !nullable(value.cacheReadInputTokens, integer) ||
    !nullable(value.outputTokens, integer) ||
    !nullable(value.costMicrousd, integer)
  )
    fail();
  if (
    value.state === 'unreserved' &&
    (value.reservationMicrousd !== 0 ||
      [
        value.tokenHash,
        value.startedAt,
        value.deadlineAt,
        value.completedAt,
        value.terminalClass,
        value.terminalStopReason,
        value.inputTokens,
        value.cacheCreationInputTokens,
        value.cacheReadInputTokens,
        value.outputTokens,
        value.costMicrousd,
      ].some((item) => item !== null))
  )
    fail();
  return clone(value);
}

function projectPublication(value, ownerId, repositoryId, jobId) {
  exact(value, [
    'reportId',
    'versionKey',
    'candidateDigest',
    'basisReportId',
    'pointerRevision',
    'publishedAt',
    'cleanupCandidateKey',
  ]);
  const expectedReportId = digest('board-report-id-v1', jobId);
  if (
    value.reportId !== expectedReportId ||
    value.versionKey !==
      `owners/${ownerId}/repositories/${repositoryId}/versions/${expectedReportId}` ||
    !nullable(value.candidateDigest, (item) => HEX_64.test(item)) ||
    !nullable(value.basisReportId, (item) => HEX_64.test(item)) ||
    !nullable(value.pointerRevision, integer) ||
    !nullable(value.publishedAt, (item) => Boolean(iso(item))) ||
    !nullable(
      value.cleanupCandidateKey,
      (item) =>
        typeof item === 'string' &&
        /^owners\/99961\/repositories\/[1-9]\d*\/versions\/[a-f0-9]{64}$/u.test(
          item,
        ),
    )
  )
    fail();
  return clone(value);
}

function projectAccounting(value) {
  exact(value, [
    'status',
    'ledgerRevision',
    'accountingSequence',
    'accountingDigest',
    'transitionId',
  ]);
  if (
    !ACCOUNTING_STATES.has(value.status) ||
    !nullable(value.ledgerRevision, integer) ||
    !nullable(value.accountingSequence, integer) ||
    !nullable(value.accountingDigest, (item) => HEX_64.test(item)) ||
    !nullable(value.transitionId, (item) => HEX_64.test(item))
  )
    fail();
  const facts = [
    value.ledgerRevision,
    value.accountingSequence,
    value.accountingDigest,
    value.transitionId,
  ];
  if (
    value.status === 'unreserved'
      ? facts.some((item) => item !== null)
      : facts.some((item) => item === null)
  )
    fail();
  return clone(value);
}

function projectTerminal(value, state) {
  if (value === null) {
    if (TERMINAL.has(state)) fail();
    return null;
  }
  exact(value, ['status', 'completedAt', 'errorCode']);
  if (
    !TERMINAL.has(state) ||
    value.status !== state ||
    !nullable(value.errorCode, (item) => ERROR_CODES.has(item))
  )
    fail();
  iso(value.completedAt);
  return clone(value);
}

export function projectAnalysisJob(value) {
  exact(value, [
    'schemaVersion',
    'stateMachineVersion',
    'jobId',
    'ownerId',
    'repositoryId',
    'operation',
    'expectedCurrentReportId',
    'authorizationEpoch',
    'admissionDeployId',
    'createdAt',
    'updatedAt',
    'state',
    'stateVersion',
    'stateDeadlineAt',
    'dispatchCapabilityHash',
    'freeLease',
    'finalizationLease',
    'pricePolicyId',
    'sourceFingerprint',
    'attempts',
    'publication',
    'accounting',
    'terminal',
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.stateMachineVersion !== JOB_STATE_MACHINE_VERSION ||
    !HEX_64.test(value.jobId) ||
    value.ownerId !== 99961 ||
    !positive(value.repositoryId) ||
    !OPERATIONS.has(value.operation) ||
    !nullable(value.expectedCurrentReportId, (item) => HEX_64.test(item)) ||
    (value.operation === 'generate' &&
      value.expectedCurrentReportId !== null) ||
    (value.operation === 'refresh' && value.expectedCurrentReportId === null) ||
    !positive(value.authorizationEpoch) ||
    !text(value.admissionDeployId, 128) ||
    !STATES.has(value.state) ||
    !integer(value.stateVersion) ||
    !nullable(value.dispatchCapabilityHash, (item) => HEX_64.test(item)) ||
    !nullable(value.pricePolicyId, (item) =>
      /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(item),
    ) ||
    !nullable(value.sourceFingerprint, (item) => HEX_64.test(item)) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length !== 2
  )
    fail();
  const createdAt = iso(value.createdAt);
  const updatedAt = iso(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail();
  if (TERMINAL.has(value.state)) {
    if (value.stateDeadlineAt !== null) fail();
  } else {
    iso(value.stateDeadlineAt);
  }
  return {
    ...clone(value),
    freeLease: projectLease(value.freeLease),
    finalizationLease: projectLease(value.finalizationLease),
    attempts: value.attempts.map((attempt, index) =>
      projectAttempt(attempt, index + 1),
    ),
    publication: projectPublication(
      value.publication,
      value.ownerId,
      value.repositoryId,
      value.jobId,
    ),
    accounting: projectAccounting(value.accounting),
    terminal: projectTerminal(value.terminal, value.state),
  };
}

const emptyAttempt = (number) => ({
  number,
  reservationMicrousd: 0,
  state: 'unreserved',
  tokenHash: null,
  startedAt: null,
  deadlineAt: null,
  completedAt: null,
  terminalClass: null,
  terminalStopReason: null,
  inputTokens: null,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
  outputTokens: null,
  costMicrousd: null,
});

export function createAnalysisJob({
  ownerId,
  repositoryId,
  idempotencyKey,
  operation,
  expectedCurrentReportId = null,
  authorizationEpoch,
  admissionDeployId,
  at,
  deadlineAt,
}) {
  const identity = deriveAnalysisJobIdentity({
    ownerId,
    repositoryId,
    idempotencyKey,
  });
  const job = {
    schemaVersion: 1,
    stateMachineVersion: JOB_STATE_MACHINE_VERSION,
    jobId: identity.jobId,
    ownerId,
    repositoryId,
    operation,
    expectedCurrentReportId,
    authorizationEpoch,
    admissionDeployId,
    createdAt: iso(at),
    updatedAt: at,
    state: 'created',
    stateVersion: 0,
    stateDeadlineAt: iso(deadlineAt),
    dispatchCapabilityHash: null,
    freeLease: null,
    finalizationLease: null,
    pricePolicyId: null,
    sourceFingerprint: null,
    attempts: [emptyAttempt(1), emptyAttempt(2)],
    publication: {
      reportId: identity.reportId,
      versionKey: identity.versionKey,
      candidateDigest: null,
      basisReportId: expectedCurrentReportId,
      pointerRevision: null,
      publishedAt: null,
      cleanupCandidateKey: null,
    },
    accounting: {
      status: 'unreserved',
      ledgerRevision: null,
      accountingSequence: null,
      accountingDigest: null,
      transitionId: null,
    },
    terminal: null,
  };
  return projectAnalysisJob(job);
}

export function projectSafeJob(value) {
  const job = projectAnalysisJob(value);
  return {
    id: job.jobId,
    operation: job.operation,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    terminal:
      job.terminal === null
        ? null
        : {
            status: job.terminal.status,
            errorCode: job.terminal.errorCode,
          },
  };
}
