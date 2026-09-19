import { BoardError } from './errors.mjs';
import {
  JOB_STATES,
  TERMINAL_JOB_STATES,
  projectAnalysisJob,
} from './jobs.mjs';

export const JOB_MACHINE_TRANSITION_VERSION = 1;

const TERMINAL = new Set(TERMINAL_JOB_STATES);
const PAID_IN_FLIGHT = new Map([
  ['primary-in-flight', 1],
  ['corrective-in-flight', 2],
]);
const RESPONSE_COMPLETE = new Map([
  ['primary-response-complete', 1],
  ['corrective-response-complete', 2],
]);
const VALIDATING = new Map([
  ['validating-primary', 1],
  ['validating-corrective', 2],
]);
const HEX_64 = /^[a-f0-9]{64}$/u;
const ERROR_CODES = new Set([
  'analysis_ambiguous',
  'analysis_input_too_large',
  'analysis_output_invalid',
  'analysis_provider_rate_limited',
  'analysis_provider_unavailable',
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

const fail = () => {
  throw new BoardError('service_unavailable');
};
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
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const hex = (value) => typeof value === 'string' && HEX_64.test(value);
const safeText = (value, maximum = 128) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  !/[\r\n\0]/u.test(value);
const iso = (value) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail();
  return value;
};
const before = (left, right) => Date.parse(left) < Date.parse(right);
const atOrBefore = (left, right) => Date.parse(left) <= Date.parse(right);
const clone = (value) => structuredClone(value);

function validateAttempt(attempt) {
  const timestamps = [
    attempt.startedAt,
    attempt.deadlineAt,
    attempt.completedAt,
  ];
  if (
    attempt.startedAt !== null &&
    attempt.deadlineAt !== null &&
    !before(attempt.startedAt, attempt.deadlineAt)
  )
    fail();
  if (
    attempt.completedAt !== null &&
    (attempt.startedAt === null ||
      attempt.deadlineAt === null ||
      !atOrBefore(attempt.startedAt, attempt.completedAt) ||
      !atOrBefore(attempt.completedAt, attempt.deadlineAt))
  )
    fail();
  const usage = [
    attempt.inputTokens,
    attempt.cacheCreationInputTokens,
    attempt.cacheReadInputTokens,
    attempt.outputTokens,
    attempt.costMicrousd,
  ];
  if (attempt.state === 'reserved') {
    if (
      !positive(attempt.reservationMicrousd) ||
      attempt.tokenHash !== null ||
      timestamps.some((value) => value !== null) ||
      attempt.terminalClass !== null ||
      attempt.terminalStopReason !== null ||
      usage.some((value) => value !== null)
    )
      fail();
  } else if (attempt.state === 'in-flight') {
    if (
      !positive(attempt.reservationMicrousd) ||
      !hex(attempt.tokenHash) ||
      attempt.startedAt === null ||
      attempt.deadlineAt === null ||
      attempt.completedAt !== null ||
      attempt.terminalClass !== null ||
      attempt.terminalStopReason !== null ||
      usage.some((value) => value !== null)
    )
      fail();
  } else if (['response-complete', 'settled'].includes(attempt.state)) {
    if (
      !positive(attempt.reservationMicrousd) ||
      !hex(attempt.tokenHash) ||
      timestamps.some((value) => value === null) ||
      !safeText(attempt.terminalClass) ||
      !safeText(attempt.terminalStopReason) ||
      usage.some((value) => !integer(value)) ||
      attempt.costMicrousd > attempt.reservationMicrousd
    )
      fail();
  } else if (attempt.state === 'released') {
    if (
      !positive(attempt.reservationMicrousd) ||
      attempt.tokenHash !== null ||
      timestamps.some((value) => value !== null) ||
      attempt.terminalClass !== null ||
      attempt.terminalStopReason !== null ||
      usage.some((value) => value !== null)
    )
      fail();
  } else if (attempt.state === 'unknown') {
    if (
      !positive(attempt.reservationMicrousd) ||
      !hex(attempt.tokenHash) ||
      attempt.startedAt === null ||
      attempt.deadlineAt === null ||
      attempt.costMicrousd !== null
    )
      fail();
  }
}

function validateActiveShape(job) {
  const [primary, corrective] = job.attempts;
  const free = ['collecting', 'counting'].includes(job.state);
  const finalizing = [
    'validating-primary',
    'primary-invalid',
    'validating-corrective',
  ].includes(job.state);
  if (free !== (job.freeLease !== null)) fail();
  if (finalizing !== (job.finalizationLease !== null)) fail();
  if (free && job.freeLease.expiresAt !== job.stateDeadlineAt) fail();
  if (finalizing && job.finalizationLease.expiresAt !== job.stateDeadlineAt)
    fail();
  if (
    PAID_IN_FLIGHT.has(job.state) &&
    job.attempts[PAID_IN_FLIGHT.get(job.state) - 1].deadlineAt !==
      job.stateDeadlineAt
  )
    fail();
  if (TERMINAL.has(job.state)) {
    if (job.freeLease !== null || job.finalizationLease !== null) fail();
    return;
  }
  if (job.state === 'created') {
    if (
      primary.state !== 'unreserved' ||
      corrective.state !== 'unreserved' ||
      job.accounting.status !== 'unreserved' ||
      job.pricePolicyId !== null ||
      job.dispatchCapabilityHash !== null ||
      job.sourceFingerprint !== null
    )
      fail();
    return;
  }
  if (
    job.pricePolicyId === null ||
    job.accounting.status === 'unreserved' ||
    primary.state === 'unreserved' ||
    corrective.state === 'unreserved'
  )
    fail();
  if (job.state === 'reserved') {
    if (
      primary.state !== 'reserved' ||
      corrective.state !== 'reserved' ||
      job.dispatchCapabilityHash !== null ||
      job.sourceFingerprint !== null
    )
      fail();
    return;
  }
  if (job.dispatchCapabilityHash === null) fail();
  if (['dispatchable', 'collecting', 'counting'].includes(job.state)) {
    if (
      primary.state !== 'reserved' ||
      corrective.state !== 'reserved' ||
      job.sourceFingerprint !== null
    )
      fail();
    return;
  }
  if (job.sourceFingerprint === null) fail();
  if (job.state === 'primary-in-flight') {
    if (primary.state !== 'in-flight' || corrective.state !== 'reserved')
      fail();
  } else if (
    ['primary-response-complete', 'validating-primary'].includes(job.state)
  ) {
    if (
      primary.state !== 'response-complete' ||
      corrective.state !== 'reserved'
    )
      fail();
  } else if (job.state === 'primary-invalid') {
    if (
      !['response-complete', 'settled'].includes(primary.state) ||
      corrective.state !== 'reserved' ||
      job.publication.candidateDigest !== null
    )
      fail();
  } else if (job.state === 'corrective-in-flight') {
    if (primary.state !== 'settled' || corrective.state !== 'in-flight') fail();
  } else if (
    ['corrective-response-complete', 'validating-corrective'].includes(
      job.state,
    )
  ) {
    if (primary.state !== 'settled' || corrective.state !== 'response-complete')
      fail();
  } else if (['version-written', 'published'].includes(job.state)) {
    if (job.publication.candidateDigest === null) fail();
  }
  if (
    ['published'].includes(job.state) &&
    (job.publication.pointerRevision === null ||
      job.publication.publishedAt === null)
  )
    fail();
}

/** Apply the storage schema and the stricter cross-field state invariants. */
export function projectJobMachine(value) {
  const job = projectAnalysisJob(value);
  if (!JOB_STATES.includes(job.state)) fail();
  for (const attempt of job.attempts) validateAttempt(attempt);
  validateActiveShape(job);
  return job;
}

const updated = (job, state, at, deadlineAt) => {
  iso(at);
  if (before(at, job.updatedAt)) fail();
  if (TERMINAL.has(state)) {
    if (deadlineAt !== null) fail();
  } else {
    iso(deadlineAt);
    if (!before(at, deadlineAt)) fail();
  }
  return {
    ...clone(job),
    state,
    stateVersion: job.stateVersion + 1,
    updatedAt: at,
    stateDeadlineAt: deadlineAt,
  };
};

const live = (deadline, at) => before(at, deadline);
const requireLiveHash = (actual, expected, deadline, at) => {
  if (!hex(expected) || actual !== expected || !live(deadline, at)) fail();
};
const requireHash = (actual, expected) => {
  if (!hex(expected) || actual !== expected) fail();
};

export function ownsPaidAttempt(jobValue, { number, tokenHash, at }) {
  try {
    const job = projectJobMachine(jobValue);
    iso(at);
    if (![1, 2].includes(number)) return false;
    const activeNumber =
      PAID_IN_FLIGHT.get(job.state) ??
      RESPONSE_COMPLETE.get(job.state) ??
      VALIDATING.get(job.state) ??
      (job.state === 'primary-invalid' ? 1 : undefined);
    if (activeNumber !== number) return false;
    const attempt = job.attempts[number - 1];
    const deadline =
      attempt.state === 'in-flight'
        ? attempt.deadlineAt
        : (job.finalizationLease?.expiresAt ?? job.stateDeadlineAt);
    return (
      attempt.tokenHash === tokenHash &&
      deadline !== null &&
      live(deadline, at) &&
      ['in-flight', 'response-complete', 'settled'].includes(attempt.state)
    );
  } catch {
    return false;
  }
}

export function ownsFinalization(jobValue, { number, tokenHash, at }) {
  try {
    const job = projectJobMachine(jobValue);
    iso(at);
    return (VALIDATING.get(job.state) === number ||
      (job.state === 'primary-invalid' && number === 1)) &&
      job.finalizationLease.tokenHash === tokenHash &&
      live(job.finalizationLease.expiresAt, at)
      ? true
      : false;
  } catch {
    return false;
  }
}

function reservationCommitted(job, event) {
  exact(event, [
    'type',
    'at',
    'deadlineAt',
    'pricePolicyId',
    'reservationMicrousd',
    'accounting',
  ]);
  if (
    job.state !== 'created' ||
    !live(job.stateDeadlineAt, event.at) ||
    !safeText(event.pricePolicyId) ||
    !Array.isArray(event.reservationMicrousd) ||
    event.reservationMicrousd.length !== 2 ||
    event.reservationMicrousd.some((value) => !positive(value))
  )
    fail();
  exact(event.accounting, [
    'status',
    'ledgerRevision',
    'accountingSequence',
    'accountingDigest',
    'transitionId',
  ]);
  const result = updated(job, 'reserved', event.at, event.deadlineAt);
  result.pricePolicyId = event.pricePolicyId;
  result.attempts = result.attempts.map((attempt, index) => ({
    ...attempt,
    reservationMicrousd: event.reservationMicrousd[index],
    state: 'reserved',
  }));
  result.accounting = clone(event.accounting);
  if (result.accounting.status !== 'pending') fail();
  return result;
}

function dispatchInstalled(job, event) {
  exact(event, ['type', 'at', 'deadlineAt', 'capabilityHash']);
  if (
    job.state !== 'reserved' ||
    !live(job.stateDeadlineAt, event.at) ||
    !hex(event.capabilityHash)
  )
    fail();
  const result = updated(job, 'dispatchable', event.at, event.deadlineAt);
  result.dispatchCapabilityHash = event.capabilityHash;
  return result;
}

function dispatchRotated(job, event) {
  exact(event, [
    'type',
    'at',
    'deadlineAt',
    'previousCapabilityHash',
    'capabilityHash',
  ]);
  if (
    job.state !== 'dispatchable' ||
    !live(job.stateDeadlineAt, event.at) ||
    event.deadlineAt !== job.stateDeadlineAt ||
    !hex(event.previousCapabilityHash) ||
    event.previousCapabilityHash !== job.dispatchCapabilityHash ||
    !hex(event.capabilityHash) ||
    event.capabilityHash === event.previousCapabilityHash
  )
    fail();
  const result = updated(job, 'dispatchable', event.at, event.deadlineAt);
  result.dispatchCapabilityHash = event.capabilityHash;
  return result;
}

function freeLeaseClaimed(job, event) {
  exact(event, ['type', 'at', 'phase', 'tokenHash', 'expiresAt']);
  if (
    !['collecting', 'counting'].includes(event.phase) ||
    !hex(event.tokenHash)
  )
    fail();
  if (job.state === 'dispatchable') {
    if (event.phase !== 'collecting' || !live(job.stateDeadlineAt, event.at))
      fail();
  } else if (['collecting', 'counting'].includes(job.state)) {
    const lease = job.freeLease;
    if (live(lease.expiresAt, event.at)) {
      if (lease.tokenHash !== event.tokenHash) fail();
      if (job.state === 'counting' && event.phase !== 'counting') fail();
    } else if (event.phase !== job.state) {
      fail();
    }
  } else {
    fail();
  }
  const result = updated(job, event.phase, event.at, event.expiresAt);
  result.freeLease = {
    tokenHash: event.tokenHash,
    expiresAt: event.expiresAt,
  };
  return result;
}

function primaryStarted(job, event) {
  exact(event, [
    'type',
    'at',
    'freeTokenHash',
    'attemptTokenHash',
    'deadlineAt',
    'sourceFingerprint',
  ]);
  if (job.state !== 'counting' || !hex(event.sourceFingerprint)) fail();
  requireLiveHash(
    job.freeLease.tokenHash,
    event.freeTokenHash,
    job.freeLease.expiresAt,
    event.at,
  );
  if (!hex(event.attemptTokenHash)) fail();
  const result = updated(job, 'primary-in-flight', event.at, event.deadlineAt);
  result.freeLease = null;
  result.sourceFingerprint = event.sourceFingerprint;
  result.attempts[0] = {
    ...result.attempts[0],
    state: 'in-flight',
    tokenHash: event.attemptTokenHash,
    startedAt: event.at,
    deadlineAt: event.deadlineAt,
  };
  return result;
}

function completeResponse(job, event) {
  exact(event, [
    'type',
    'at',
    'number',
    'attemptTokenHash',
    'deadlineAt',
    'usage',
  ]);
  if (PAID_IN_FLIGHT.get(job.state) !== event.number) fail();
  const attempt = job.attempts[event.number - 1];
  requireLiveHash(
    attempt.tokenHash,
    event.attemptTokenHash,
    attempt.deadlineAt,
    event.at,
  );
  exact(event.usage, [
    'terminalClass',
    'terminalStopReason',
    'inputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'outputTokens',
    'costMicrousd',
  ]);
  if (
    !safeText(event.usage.terminalClass) ||
    !safeText(event.usage.terminalStopReason) ||
    [
      event.usage.inputTokens,
      event.usage.cacheCreationInputTokens,
      event.usage.cacheReadInputTokens,
      event.usage.outputTokens,
      event.usage.costMicrousd,
    ].some((value) => !integer(value)) ||
    event.usage.costMicrousd > attempt.reservationMicrousd
  )
    fail();
  const state =
    event.number === 1
      ? 'primary-response-complete'
      : 'corrective-response-complete';
  const result = updated(job, state, event.at, event.deadlineAt);
  result.attempts[event.number - 1] = {
    ...attempt,
    ...event.usage,
    state: 'response-complete',
    completedAt: event.at,
  };
  return result;
}

function finalizationClaimed(job, event) {
  exact(event, [
    'type',
    'at',
    'number',
    'attemptTokenHash',
    'finalizationTokenHash',
    'expiresAt',
  ]);
  if (RESPONSE_COMPLETE.get(job.state) !== event.number) fail();
  const attempt = job.attempts[event.number - 1];
  requireLiveHash(
    attempt.tokenHash,
    event.attemptTokenHash,
    job.stateDeadlineAt,
    event.at,
  );
  if (
    !hex(event.finalizationTokenHash) ||
    event.finalizationTokenHash === attempt.tokenHash
  )
    fail();
  const state =
    event.number === 1 ? 'validating-primary' : 'validating-corrective';
  const result = updated(job, state, event.at, event.expiresAt);
  result.finalizationLease = {
    tokenHash: event.finalizationTokenHash,
    expiresAt: event.expiresAt,
  };
  return result;
}

function primaryRejected(job, event) {
  exact(event, [
    'type',
    'at',
    'attemptTokenHash',
    'finalizationTokenHash',
    'classification',
  ]);
  if (
    job.state !== 'validating-primary' ||
    event.classification !== 'analysis_output_invalid'
  )
    fail();
  requireHash(job.attempts[0].tokenHash, event.attemptTokenHash);
  requireLiveHash(
    job.finalizationLease.tokenHash,
    event.finalizationTokenHash,
    job.finalizationLease.expiresAt,
    event.at,
  );
  const result = updated(
    job,
    'primary-invalid',
    event.at,
    job.finalizationLease.expiresAt,
  );
  result.attempts[0].terminalClass = event.classification;
  return result;
}

function accountingRecorded(job, event) {
  exact(event, [
    'type',
    'at',
    'deadlineAt',
    'attemptTokenHash',
    'finalizationTokenHash',
    'attemptUpdates',
    'accounting',
  ]);
  if (!Array.isArray(event.attemptUpdates) || event.attemptUpdates.length > 2)
    fail();
  exact(event.accounting, [
    'status',
    'ledgerRevision',
    'accountingSequence',
    'accountingDigest',
    'transitionId',
  ]);
  if (job.state === 'primary-invalid') {
    requireHash(job.attempts[0].tokenHash, event.attemptTokenHash);
    requireLiveHash(
      job.finalizationLease.tokenHash,
      event.finalizationTokenHash,
      job.finalizationLease.expiresAt,
      event.at,
    );
    if (event.deadlineAt !== job.stateDeadlineAt) fail();
  } else if (job.state === 'published') {
    if (event.attemptTokenHash !== null || event.finalizationTokenHash !== null)
      fail();
  } else if (TERMINAL.has(job.state)) {
    if (
      event.deadlineAt !== null ||
      event.attemptTokenHash !== null ||
      event.finalizationTokenHash !== null
    )
      fail();
  } else {
    fail();
  }
  const result = updated(job, job.state, event.at, event.deadlineAt);
  const seen = new Set();
  for (const update of event.attemptUpdates) {
    exact(update, ['number', 'state']);
    if (![1, 2].includes(update.number) || seen.has(update.number)) fail();
    seen.add(update.number);
    const attempt = result.attempts[update.number - 1];
    const allowed =
      (attempt.state === 'response-complete' &&
        ['settled', 'unknown'].includes(update.state)) ||
      (attempt.state === 'reserved' && update.state === 'released') ||
      (attempt.state === 'in-flight' && update.state === 'unknown');
    if (!allowed) fail();
    attempt.state = update.state;
    if (update.state === 'unknown') {
      attempt.terminalClass = 'analysis-ambiguous';
      attempt.costMicrousd = null;
    }
  }
  result.accounting = clone(event.accounting);
  const previousHasAccounting = job.accounting.ledgerRevision !== null;
  const nextHasAccounting = result.accounting.ledgerRevision !== null;
  if (
    previousHasAccounting &&
    (!nextHasAccounting ||
      result.accounting.ledgerRevision <= job.accounting.ledgerRevision ||
      result.accounting.accountingSequence <= job.accounting.accountingSequence)
  )
    fail();
  if (job.state === 'primary-invalid') {
    if (
      result.attempts[0].state !== 'settled' ||
      result.attempts[1].state !== 'reserved' ||
      result.accounting.status !== 'pending'
    )
      fail();
  } else if (job.state === 'published') {
    if (result.accounting.status !== 'complete') fail();
  } else if (!['complete', 'unknown'].includes(result.accounting.status)) {
    fail();
  }
  const allUnreserved = result.attempts.every(
    (attempt) => attempt.state === 'unreserved',
  );
  if (
    result.accounting.status === 'complete' &&
    !allUnreserved &&
    result.attempts.some(
      (attempt) => !['settled', 'released'].includes(attempt.state),
    )
  )
    fail();
  if (
    result.accounting.status === 'unknown' &&
    !result.attempts.some((attempt) => attempt.state === 'unknown')
  )
    fail();
  return result;
}

function correctiveStarted(job, event) {
  exact(event, [
    'type',
    'at',
    'primaryAttemptTokenHash',
    'finalizationTokenHash',
    'correctiveAttemptTokenHash',
    'deadlineAt',
  ]);
  if (
    job.state !== 'primary-invalid' ||
    job.attempts[0].state !== 'settled' ||
    job.attempts[1].state !== 'reserved' ||
    job.accounting.status !== 'pending'
  )
    fail();
  requireHash(job.attempts[0].tokenHash, event.primaryAttemptTokenHash);
  requireLiveHash(
    job.finalizationLease.tokenHash,
    event.finalizationTokenHash,
    job.finalizationLease.expiresAt,
    event.at,
  );
  if (
    !hex(event.correctiveAttemptTokenHash) ||
    event.correctiveAttemptTokenHash === job.attempts[0].tokenHash ||
    event.correctiveAttemptTokenHash === job.finalizationLease.tokenHash
  )
    fail();
  const result = updated(
    job,
    'corrective-in-flight',
    event.at,
    event.deadlineAt,
  );
  result.finalizationLease = null;
  result.attempts[1] = {
    ...result.attempts[1],
    state: 'in-flight',
    tokenHash: event.correctiveAttemptTokenHash,
    startedAt: event.at,
    deadlineAt: event.deadlineAt,
  };
  return result;
}

function candidateStaged(job, event) {
  exact(event, [
    'type',
    'at',
    'number',
    'attemptTokenHash',
    'finalizationTokenHash',
    'candidateDigest',
  ]);
  if (VALIDATING.get(job.state) !== event.number || !hex(event.candidateDigest))
    fail();
  requireHash(job.attempts[event.number - 1].tokenHash, event.attemptTokenHash);
  requireLiveHash(
    job.finalizationLease.tokenHash,
    event.finalizationTokenHash,
    job.finalizationLease.expiresAt,
    event.at,
  );
  if (job.publication.candidateDigest !== null) fail();
  const result = updated(job, job.state, event.at, job.stateDeadlineAt);
  result.publication.candidateDigest = event.candidateDigest;
  return result;
}

function versionConfirmed(job, event) {
  exact(event, [
    'type',
    'at',
    'number',
    'attemptTokenHash',
    'finalizationTokenHash',
    'candidateDigest',
    'deadlineAt',
  ]);
  if (
    VALIDATING.get(job.state) !== event.number ||
    job.publication.candidateDigest !== event.candidateDigest ||
    !hex(event.candidateDigest)
  )
    fail();
  requireHash(job.attempts[event.number - 1].tokenHash, event.attemptTokenHash);
  requireLiveHash(
    job.finalizationLease.tokenHash,
    event.finalizationTokenHash,
    job.finalizationLease.expiresAt,
    event.at,
  );
  const result = updated(job, 'version-written', event.at, event.deadlineAt);
  result.finalizationLease = null;
  return result;
}

function recoveredVersionConfirmed(job, event) {
  exact(event, ['type', 'at', 'candidateDigest', 'deadlineAt']);
  const number = RESPONSE_COMPLETE.get(job.state) ?? VALIDATING.get(job.state);
  const expiry = job.finalizationLease?.expiresAt ?? job.stateDeadlineAt;
  if (
    number === undefined ||
    live(expiry, event.at) ||
    !hex(event.candidateDigest) ||
    job.publication.candidateDigest !== event.candidateDigest
  )
    fail();
  const result = updated(job, 'version-written', event.at, event.deadlineAt);
  result.finalizationLease = null;
  return result;
}

function cleanupCandidateRecorded(job, event) {
  exact(event, ['type', 'at', 'deadlineAt', 'cleanupCandidateKey']);
  const prefix = `owners/99961/repositories/${job.repositoryId}/versions/`;
  const basisKey =
    job.publication.basisReportId === null
      ? null
      : `${prefix}${job.publication.basisReportId}`;
  if (
    job.state !== 'version-written' ||
    job.publication.cleanupCandidateKey !== null ||
    typeof event.cleanupCandidateKey !== 'string' ||
    !new RegExp(`^${prefix}[a-f0-9]{64}$`, 'u').test(
      event.cleanupCandidateKey,
    ) ||
    event.cleanupCandidateKey === job.publication.versionKey ||
    event.cleanupCandidateKey === basisKey
  )
    fail();
  const result = updated(job, 'version-written', event.at, event.deadlineAt);
  result.publication.cleanupCandidateKey = event.cleanupCandidateKey;
  return result;
}

function reportPublished(job, event) {
  exact(event, ['type', 'at', 'deadlineAt', 'pointerRevision']);
  if (job.state !== 'version-written' || !integer(event.pointerRevision))
    fail();
  const result = updated(job, 'published', event.at, event.deadlineAt);
  result.publication.pointerRevision = event.pointerRevision;
  result.publication.publishedAt = event.at;
  return result;
}

function succeeded(job, event) {
  exact(event, ['type', 'at']);
  if (
    job.state !== 'published' ||
    job.accounting.status !== 'complete' ||
    job.attempts.some(
      (attempt) => !['settled', 'released'].includes(attempt.state),
    )
  )
    fail();
  const result = updated(job, 'succeeded', event.at, null);
  result.terminal = {
    status: 'succeeded',
    completedAt: event.at,
    errorCode: null,
  };
  return result;
}

function terminated(job, event) {
  exact(event, [
    'type',
    'at',
    'status',
    'errorCode',
    'attemptTokenHash',
    'finalizationTokenHash',
    'freeTokenHash',
    'recovery',
  ]);
  if (
    TERMINAL.has(job.state) ||
    !['failed', 'ambiguous', 'superseded', 'budget-blocked'].includes(
      event.status,
    ) ||
    (event.errorCode !== null && !ERROR_CODES.has(event.errorCode)) ||
    typeof event.recovery !== 'boolean'
  )
    fail();
  const deadline =
    job.finalizationLease?.expiresAt ??
    job.freeLease?.expiresAt ??
    job.stateDeadlineAt;
  if (event.recovery) {
    if (
      live(deadline, event.at) ||
      event.attemptTokenHash !== null ||
      event.finalizationTokenHash !== null ||
      event.freeTokenHash !== null
    )
      fail();
  } else if (PAID_IN_FLIGHT.has(job.state)) {
    const attempt = job.attempts[PAID_IN_FLIGHT.get(job.state) - 1];
    requireLiveHash(
      attempt.tokenHash,
      event.attemptTokenHash,
      attempt.deadlineAt,
      event.at,
    );
    if (event.finalizationTokenHash !== null || event.freeTokenHash !== null)
      fail();
  } else if (RESPONSE_COMPLETE.has(job.state)) {
    const attempt = job.attempts[RESPONSE_COMPLETE.get(job.state) - 1];
    requireLiveHash(
      attempt.tokenHash,
      event.attemptTokenHash,
      job.stateDeadlineAt,
      event.at,
    );
    if (event.finalizationTokenHash !== null || event.freeTokenHash !== null)
      fail();
  } else if (VALIDATING.has(job.state) || job.state === 'primary-invalid') {
    const number = VALIDATING.get(job.state) ?? 1;
    requireHash(job.attempts[number - 1].tokenHash, event.attemptTokenHash);
    requireLiveHash(
      job.finalizationLease.tokenHash,
      event.finalizationTokenHash,
      job.finalizationLease.expiresAt,
      event.at,
    );
    if (event.freeTokenHash !== null) fail();
  } else if (['collecting', 'counting'].includes(job.state)) {
    requireLiveHash(
      job.freeLease.tokenHash,
      event.freeTokenHash,
      job.freeLease.expiresAt,
      event.at,
    );
    if (event.attemptTokenHash !== null || event.finalizationTokenHash !== null)
      fail();
  } else if (
    event.attemptTokenHash !== null ||
    event.finalizationTokenHash !== null ||
    event.freeTokenHash !== null
  ) {
    fail();
  }
  if (event.status === 'ambiguous' && !PAID_IN_FLIGHT.has(job.state)) fail();
  const result = updated(job, event.status, event.at, null);
  result.freeLease = null;
  result.finalizationLease = null;
  result.publication.candidateDigest = null;
  result.publication.cleanupCandidateKey = null;
  result.terminal = {
    status: event.status,
    completedAt: event.at,
    errorCode: event.errorCode,
  };
  return result;
}

/** Pure state transition; the caller performs the matching conditional write. */
export function transitionJob(jobValue, event) {
  const job = projectJobMachine(jobValue);
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail();
  let candidate;
  switch (event.type) {
    case 'reservation-committed':
      candidate = reservationCommitted(job, event);
      break;
    case 'dispatch-installed':
      candidate = dispatchInstalled(job, event);
      break;
    case 'dispatch-rotated':
      candidate = dispatchRotated(job, event);
      break;
    case 'free-lease-claimed':
      candidate = freeLeaseClaimed(job, event);
      break;
    case 'primary-started':
      candidate = primaryStarted(job, event);
      break;
    case 'response-completed':
      candidate = completeResponse(job, event);
      break;
    case 'finalization-claimed':
      candidate = finalizationClaimed(job, event);
      break;
    case 'primary-rejected':
      candidate = primaryRejected(job, event);
      break;
    case 'accounting-recorded':
      candidate = accountingRecorded(job, event);
      break;
    case 'corrective-started':
      candidate = correctiveStarted(job, event);
      break;
    case 'candidate-staged':
      candidate = candidateStaged(job, event);
      break;
    case 'version-confirmed':
      candidate = versionConfirmed(job, event);
      break;
    case 'recovered-version-confirmed':
      candidate = recoveredVersionConfirmed(job, event);
      break;
    case 'cleanup-candidate-recorded':
      candidate = cleanupCandidateRecorded(job, event);
      break;
    case 'report-published':
      candidate = reportPublished(job, event);
      break;
    case 'succeeded':
      candidate = succeeded(job, event);
      break;
    case 'terminated':
      candidate = terminated(job, event);
      break;
    default:
      fail();
  }
  return projectJobMachine(candidate);
}

/** Describe the next nonpaid recovery action without mutating durable state. */
export function classifyJobRecovery(jobValue, { at, versionDigest = null }) {
  const job = projectJobMachine(jobValue);
  iso(at);
  if (versionDigest !== null && !hex(versionDigest)) fail();
  if (TERMINAL.has(job.state))
    return Object.freeze({
      action:
        job.accounting.status === 'complete' ||
        job.accounting.status === 'unknown'
          ? 'verify-terminal-accounting'
          : 'resume-terminal-accounting',
    });
  if (['version-written'].includes(job.state))
    return Object.freeze({ action: 'resume-publication' });
  if (job.state === 'published')
    return Object.freeze({ action: 'resume-success-finalization' });
  if (['collecting', 'counting'].includes(job.state))
    return Object.freeze({
      action: live(job.freeLease.expiresAt, at)
        ? 'wait-free-owner'
        : 'reclaim-or-fence-free-work',
    });
  if (['created', 'reserved', 'dispatchable'].includes(job.state))
    return Object.freeze({
      action: live(job.stateDeadlineAt, at)
        ? 'wait-pre-provider'
        : 'fence-pre-provider',
    });
  if (PAID_IN_FLIGHT.has(job.state))
    return Object.freeze({
      action: live(job.stateDeadlineAt, at)
        ? 'wait-paid-owner'
        : 'fence-paid-ambiguous',
      attemptNumber: PAID_IN_FLIGHT.get(job.state),
    });
  if (job.state === 'primary-invalid')
    return Object.freeze({
      action: live(job.finalizationLease.expiresAt, at)
        ? 'wait-primary-finalization-owner'
        : 'fence-primary-invalid-and-release-corrective',
      attemptNumber: 1,
    });
  const number = RESPONSE_COMPLETE.get(job.state) ?? VALIDATING.get(job.state);
  if (number !== undefined) {
    const deadline = job.finalizationLease?.expiresAt ?? job.stateDeadlineAt;
    if (live(deadline, at))
      return Object.freeze({
        action: 'wait-finalization-owner',
        attemptNumber: number,
      });
    if (
      versionDigest !== null &&
      job.publication.candidateDigest !== null &&
      versionDigest === job.publication.candidateDigest
    )
      return Object.freeze({
        action: 'advance-version-written',
        attemptNumber: number,
      });
    return Object.freeze({
      action: 'fence-failed-and-settle-known-usage',
      attemptNumber: number,
    });
  }
  fail();
}
