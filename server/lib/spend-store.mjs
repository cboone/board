import { BoardError } from './errors.mjs';
import { canonicalStringify } from './fingerprint.mjs';
import {
  REVIEWED_SETUP_PRICING_ATTESTATION,
  SETUP_SPEND_LIMITS,
  activateSetupPolicy,
  assertSetupPolicyBinding,
  createSetupLedger,
  createSetupPolicy,
  decideSetupDiscussion,
  exposureMicrousd,
  projectSpendLedger,
  removeCompletedSetupJob,
  reserveSetupJob,
  updateSetupAttempt,
} from './spend.mjs';

export const SETUP_SPEND_LEDGER_KEY = 'setup/v1';
export const SPEND_STORE_LIMITS = Object.freeze({ conflicts: 8 });

const HEX_64 = /^[a-f0-9]{64}$/u;
const POLICY_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const unavailable = () => new BoardError('service_unavailable');
const same = (left, right) =>
  canonicalStringify(left) === canonicalStringify(right);
const clone = (value) => structuredClone(value);
const validEtag = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const OPERATIONS = new Set(['generate', 'refresh']);
const iso = (value) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw unavailable();
  return value;
};

function select(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.storage?.read !== 'function' ||
    typeof input.storage?.write !== 'function' ||
    !input.budget ||
    typeof input.deployId !== 'string' ||
    input.deployId.length < 1 ||
    input.deployId.length > 128 ||
    /[\r\n\0]/u.test(input.deployId)
  )
    throw unavailable();
  return {
    storage: input.storage,
    budget: input.budget,
    deployId: input.deployId,
    pricingAttestation:
      input.pricingAttestation ?? REVIEWED_SETUP_PRICING_ATTESTATION,
  };
}

function bindLedger(ledger) {
  return projectSpendLedger(ledger);
}

function bindCurrentLedger(ledger, selected) {
  const projected = bindLedger(ledger);
  const expected = createSetupPolicy({
    deployId: selected.deployId,
    pricingAttestation: selected.pricingAttestation,
  });
  if (projected.activePolicyId !== expected.policyId) throw unavailable();
  assertSetupPolicyBinding({
    policyId: projected.activePolicyId,
    policy: projected.policies[projected.activePolicyId],
    pricingAttestation: selected.pricingAttestation,
    deployId: selected.deployId,
  });
  return projected;
}

async function readLedger(selected) {
  let record;
  try {
    record = await selected.storage.read(SETUP_SPEND_LEDGER_KEY, {
      budget: selected.budget,
    });
  } catch (error) {
    throw error instanceof BoardError ? error : unavailable();
  }
  if (record === null) return null;
  if (!record || !validEtag(record.etag)) throw unavailable();
  return { ledger: bindLedger(record.value), etag: record.etag };
}

async function writeLedger(selected, current, ledger) {
  const expected = bindLedger(ledger);
  try {
    const result = await selected.storage.write(
      SETUP_SPEND_LEDGER_KEY,
      expected,
      { onlyIfMatch: current.etag },
      { budget: selected.budget },
    );
    if (result?.modified === true && validEtag(result.etag))
      return {
        status: 'written',
        current: { ledger: expected, etag: result.etag },
      };
    if (result?.modified !== false) throw unavailable();
  } catch {}
  const observed = await readLedger(selected);
  if (observed === null) throw unavailable();
  return {
    status: same(observed.ledger, expected) ? 'written' : 'conflict',
    current: observed,
  };
}

function entryAccounting(entry) {
  const status = entry.attempts.some((attempt) => attempt.state === 'unknown')
    ? 'unknown'
    : entry.attempts.every((attempt) =>
          ['settled', 'released'].includes(attempt.state),
        )
      ? 'complete'
      : 'pending';
  return Object.freeze({
    status,
    ledgerRevision: entry.lastLedgerRevision,
    accountingSequence: entry.lastAccountingSequence,
    accountingDigest: entry.lastAccountingDigest,
    transitionId: entry.lastTransitionId,
  });
}

function reservationResult(status, ledger, jobId) {
  const entry = ledger.active[jobId];
  if (!entry) throw unavailable();
  return Object.freeze({
    status,
    policyId: entry.policyId,
    reservationMicrousd: Object.freeze(
      entry.attempts.map((attempt) => attempt.ceilingMicrousd),
    ),
    accounting: entryAccounting(entry),
  });
}

function reservationFence(ledger) {
  if (ledger.revision === Number.MAX_SAFE_INTEGER) throw unavailable();
  const next = clone(ledger);
  next.revision += 1;
  return projectSpendLedger(next);
}

function attemptResult(status, ledger, jobId, attemptNumber) {
  const entry = ledger.active[jobId];
  const attempt = entry?.attempts[attemptNumber - 1];
  if (!attempt) throw unavailable();
  return Object.freeze({
    status,
    attempt: Object.freeze({
      number: attempt.number,
      state: attempt.state,
      actualCostMicrousd: attempt.actualCostMicrousd,
      unknownExposureMicrousd: attempt.unknownExposureMicrousd,
      recordedAt: attempt.recordedAt,
    }),
    accounting: entryAccounting(entry),
  });
}

function safeSummary(ledger, at) {
  iso(at);
  const policyId = ledger.activePolicyId;
  const policy = ledger.policies[policyId];
  const discussion = ledger.discussions[policyId] ?? null;
  const exposure = exposureMicrousd(ledger);
  const nextReservationMicrousd =
    SETUP_SPEND_LIMITS.maximumAttempts * SETUP_SPEND_LIMITS.attemptCostMicrousd;
  const expired = Date.parse(at) >= Date.parse(policy.pricingValidThrough);
  const status = ledger.pricingReviewRequired
    ? 'pricing-review-required'
    : expired
      ? 'pricing-expired'
      : discussion?.status === 'stopped'
        ? 'stopped'
        : discussion?.status === 'required'
          ? 'discussion-required'
          : exposure + nextReservationMicrousd > policy.capMicrousd
            ? 'budget-exhausted'
            : 'available';
  return Object.freeze({
    mode: 'setup',
    status,
    policyId,
    model: policy.model,
    exposureMicrousd: exposure,
    settledMicrousd: ledger.settledMicrousd,
    capMicrousd: policy.capMicrousd,
    discussionMicrousd: policy.discussionMicrousd,
    remainingMicrousd: Math.max(0, policy.capMicrousd - exposure),
    pricingValidThrough: policy.pricingValidThrough,
    activeJobCount: Object.keys(ledger.active).length,
    discussion:
      discussion === null
        ? null
        : Object.freeze({
            status: discussion.status,
            currentRevision: discussion.currentRevision,
            triggerExposureMicrousd: discussion.triggerExposureMicrousd,
          }),
  });
}

async function revalidate(input, details) {
  if (typeof input.revalidate !== 'function') throw unavailable();
  let allowed;
  try {
    allowed = await input.revalidate(Object.freeze(details));
  } catch (error) {
    throw error instanceof BoardError ? error : unavailable();
  }
  if (allowed !== true) throw unavailable();
}

/** Ensure the one setup ledger selects this deploy's immutable price policy. */
export async function ensureSetupSpendLedger(input) {
  const selected = select(input);
  const { policyId, policy } = createSetupPolicy({
    deployId: selected.deployId,
    pricingAttestation: selected.pricingAttestation,
  });
  const initial = createSetupLedger({
    policyId,
    policy,
    at: input.at,
  });
  let current = await readLedger(selected);
  let created = false;
  if (current === null) {
    try {
      const result = await selected.storage.write(
        SETUP_SPEND_LEDGER_KEY,
        initial,
        { onlyIfNew: true },
        { budget: selected.budget },
      );
      if (result?.modified === true && validEtag(result.etag)) created = true;
      else if (result?.modified !== false) throw unavailable();
    } catch {}
    current = await readLedger(selected);
    if (current === null) throw unavailable();
  }
  for (
    let conflict = 0;
    conflict < SPEND_STORE_LIMITS.conflicts;
    conflict += 1
  ) {
    const activated = activateSetupPolicy(current.ledger, {
      policyId,
      policy,
      at: input.at,
      expectedRevision: current.ledger.revision,
    });
    if (same(activated, current.ledger))
      return Object.freeze({
        status: created ? 'created' : 'existing',
        revision: current.ledger.revision,
      });
    const written = await writeLedger(selected, current, activated);
    if (written.status === 'written')
      return Object.freeze({
        status: 'existing',
        revision: written.current.ledger.revision,
      });
    current = written.current;
  }
  throw unavailable();
}

/** Strong-read a browser-safe setup-mode summary without coordination facts. */
export async function readSetupSpendSummary(input) {
  const selected = select(input);
  const current = await readLedger(selected);
  if (current === null) throw unavailable();
  return safeSummary(bindCurrentLedger(current.ledger, selected), input.at);
}

/** Strong-read one exact worker reservation without creating or changing it. */
export async function readSetupSpendReservation(input) {
  const selected = select(input);
  if (!HEX_64.test(input.jobId)) throw unavailable();
  const current = await readLedger(selected);
  if (current === null) throw unavailable();
  const entry = current.ledger.active[input.jobId];
  if (!entry) return null;
  return Object.freeze({
    policyId: entry.policyId,
    pricingReviewRequired: current.ledger.pricingReviewRequired,
    reservationMicrousd: Object.freeze(
      entry.attempts.map((attempt) => attempt.ceilingMicrousd),
    ),
    attempts: Object.freeze(
      entry.attempts.map((attempt) =>
        Object.freeze({
          number: attempt.number,
          ceilingMicrousd: attempt.ceilingMicrousd,
          state: attempt.state,
          actualCostMicrousd: attempt.actualCostMicrousd,
          unknownExposureMicrousd: attempt.unknownExposureMicrousd,
          recordedAt: attempt.recordedAt,
        }),
      ),
    ),
    accounting: entryAccounting(entry),
  });
}

/** Strong-read the complete bounded set of active setup reservations. */
export async function listSetupSpendReservations(input) {
  const selected = select(input);
  const current = await readLedger(selected);
  if (current === null) return Object.freeze([]);
  return Object.freeze(
    Object.entries(current.ledger.active)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([jobId, entry]) =>
        Object.freeze({
          jobId,
          policyId: entry.policyId,
          reservationMicrousd: Object.freeze(
            entry.attempts.map((attempt) => attempt.ceilingMicrousd),
          ),
          attempts: Object.freeze(
            entry.attempts.map((attempt) =>
              Object.freeze({
                number: attempt.number,
                ceilingMicrousd: attempt.ceilingMicrousd,
                state: attempt.state,
                actualCostMicrousd: attempt.actualCostMicrousd,
                unknownExposureMicrousd: attempt.unknownExposureMicrousd,
                recordedAt: attempt.recordedAt,
              }),
            ),
          ),
          accounting: entryAccounting(entry),
        }),
      ),
  );
}

/** Reserve both fixed attempts, revalidating the cross-store claim after CAS conflicts. */
export async function reserveSetupSpend(input) {
  const selected = select(input);
  if (
    !HEX_64.test(input.jobId) ||
    !OPERATIONS.has(input.operation) ||
    typeof input.revalidate !== 'function'
  )
    throw unavailable();
  iso(input.at);
  let current = await readLedger(selected);
  if (current === null) throw unavailable();
  for (
    let conflict = 0;
    conflict < SPEND_STORE_LIMITS.conflicts;
    conflict += 1
  ) {
    bindCurrentLedger(current.ledger, selected);
    if (Object.hasOwn(current.ledger.active, input.jobId)) {
      await revalidate(input, {
        kind: 'existing-reservation',
        jobId: input.jobId,
        operation: input.operation,
        ledgerRevision: current.ledger.revision,
        policyId: current.ledger.active[input.jobId].policyId,
      });
      return reservationResult('existing', current.ledger, input.jobId);
    }
    if (current.ledger.pricingReviewRequired)
      return Object.freeze({
        status: 'pricing-review-required',
        spend: safeSummary(current.ledger, input.at),
      });
    if (
      current.ledger.discussions[current.ledger.activePolicyId]?.status ===
      'required'
    )
      return Object.freeze({
        status: 'discussion-required',
        spend: safeSummary(current.ledger, input.at),
      });
    await revalidate(input, {
      kind: 'reservation',
      jobId: input.jobId,
      operation: input.operation,
      ledgerRevision: current.ledger.revision,
      policyId: current.ledger.activePolicyId,
    });
    const result = reserveSetupJob(current.ledger, {
      jobId: input.jobId,
      operation: input.operation,
      at: input.at,
      expectedRevision: current.ledger.revision,
      expectedPolicyId: current.ledger.activePolicyId,
      expectedDeployId: selected.deployId,
      expectedPricingAttestation: selected.pricingAttestation,
    });
    if (result.status === 'existing')
      return reservationResult('existing', result.ledger, input.jobId);
    if (['capacity', 'stopped', 'budget-exhausted'].includes(result.status))
      return Object.freeze({
        status: result.status,
        spend: safeSummary(result.ledger, input.at),
      });
    if (!['reserved', 'discussion-required'].includes(result.status))
      throw unavailable();
    const written = await writeLedger(selected, current, result.ledger);
    if (written.status === 'written') {
      if (result.status === 'reserved')
        return reservationResult(
          'reserved',
          written.current.ledger,
          input.jobId,
        );
      return Object.freeze({
        status: 'discussion-required',
        spend: safeSummary(written.current.ledger, input.at),
      });
    }
    current = written.current;
  }
  return Object.freeze({
    status: 'conflict',
    spend: safeSummary(current.ledger, input.at),
  });
}

/** Fence a still-absent reservation, or return the reservation that won first. */
export async function fenceSetupReservation(input) {
  const selected = select(input);
  if (
    !HEX_64.test(input.jobId) ||
    !OPERATIONS.has(input.operation) ||
    typeof input.revalidate !== 'function'
  )
    throw unavailable();
  iso(input.at);
  let current = await readLedger(selected);
  if (current === null) throw unavailable();
  for (
    let conflict = 0;
    conflict < SPEND_STORE_LIMITS.conflicts;
    conflict += 1
  ) {
    if (Object.hasOwn(current.ledger.active, input.jobId)) {
      const entry = current.ledger.active[input.jobId];
      await revalidate(input, {
        kind: 'existing-reservation',
        jobId: input.jobId,
        operation: input.operation,
        ledgerRevision: current.ledger.revision,
        policyId: entry.policyId,
      });
      return reservationResult('existing', current.ledger, input.jobId);
    }
    await revalidate(input, {
      kind: 'reservation-fence',
      jobId: input.jobId,
      operation: input.operation,
      ledgerRevision: current.ledger.revision,
      policyId: current.ledger.activePolicyId,
    });
    const written = await writeLedger(
      selected,
      current,
      reservationFence(current.ledger),
    );
    if (written.status === 'written')
      return Object.freeze({
        status: 'fenced',
        revision: written.current.ledger.revision,
      });
    current = written.current;
  }
  throw unavailable();
}

function attemptMatches(ledger, attempt, requested) {
  if (attempt.state === 'unknown' && requested.state === 'unknown')
    return (
      attempt.actualCostMicrousd >= requested.actualCostMicrousd &&
      attempt.unknownExposureMicrousd >= requested.unknownExposureMicrousd &&
      (!requested.pricingReviewRequired || ledger.pricingReviewRequired)
    );
  return (
    attempt.state === requested.state &&
    attempt.actualCostMicrousd === requested.actualCostMicrousd &&
    attempt.unknownExposureMicrousd === requested.unknownExposureMicrousd &&
    (!requested.pricingReviewRequired || ledger.pricingReviewRequired)
  );
}

async function recordAttempt(input, requested) {
  const selected = select(input);
  if (
    !HEX_64.test(input.jobId) ||
    ![1, 2].includes(input.attemptNumber) ||
    typeof input.revalidate !== 'function' ||
    !integer(requested.actualCostMicrousd) ||
    !integer(requested.unknownExposureMicrousd) ||
    typeof requested.pricingReviewRequired !== 'boolean'
  )
    throw unavailable();
  iso(input.at);
  let current = await readLedger(selected);
  if (current === null) throw unavailable();
  for (
    let conflict = 0;
    conflict < SPEND_STORE_LIMITS.conflicts;
    conflict += 1
  ) {
    const entry = current.ledger.active[input.jobId];
    const attempt = entry?.attempts[input.attemptNumber - 1];
    if (!attempt) throw unavailable();
    if (attemptMatches(current.ledger, attempt, requested))
      return attemptResult(
        'existing',
        current.ledger,
        input.jobId,
        input.attemptNumber,
      );
    const upgradesUnknown =
      attempt.state === 'unknown' && requested.state === 'unknown';
    if (attempt.state !== 'reserved' && !upgradesUnknown) throw unavailable();
    const recordedAt = upgradesUnknown
      ? [input.at, attempt.recordedAt, current.ledger.updatedAt].reduce(
          (latest, candidate) =>
            Date.parse(candidate) > Date.parse(latest) ? candidate : latest,
        )
      : input.at;
    const nextRequested = upgradesUnknown
      ? {
          ...requested,
          actualCostMicrousd: Math.max(
            attempt.actualCostMicrousd,
            requested.actualCostMicrousd,
          ),
          unknownExposureMicrousd: Math.max(
            attempt.unknownExposureMicrousd,
            requested.unknownExposureMicrousd,
            attempt.ceilingMicrousd,
            attempt.actualCostMicrousd,
            requested.actualCostMicrousd,
          ),
        }
      : requested;
    await revalidate(input, {
      kind: 'attempt-accounting',
      jobId: input.jobId,
      attemptNumber: input.attemptNumber,
      attemptState: nextRequested.state,
      pricingReviewRequired: nextRequested.pricingReviewRequired,
      ledgerRevision: current.ledger.revision,
      policyId: entry.policyId,
    });
    const result = updateSetupAttempt(current.ledger, {
      jobId: input.jobId,
      attemptNumber: input.attemptNumber,
      state: nextRequested.state,
      actualCostMicrousd: nextRequested.actualCostMicrousd,
      unknownExposureMicrousd: nextRequested.unknownExposureMicrousd,
      pricingReviewRequired: nextRequested.pricingReviewRequired,
      at: recordedAt,
      expectedRevision: current.ledger.revision,
    });
    const written = await writeLedger(selected, current, result.ledger);
    if (written.status === 'written')
      return attemptResult(
        'updated',
        written.current.ledger,
        input.jobId,
        input.attemptNumber,
      );
    current = written.current;
  }
  throw unavailable();
}

export async function settleSetupAttempt(input) {
  return recordAttempt(input, {
    state: 'settled',
    actualCostMicrousd: input.actualCostMicrousd,
    unknownExposureMicrousd: 0,
    pricingReviewRequired: false,
  });
}

export async function releaseSetupAttempt(input) {
  return recordAttempt(input, {
    state: 'released',
    actualCostMicrousd: 0,
    unknownExposureMicrousd: 0,
    pricingReviewRequired: false,
  });
}

export async function markSetupAttemptUnknown(input) {
  return recordAttempt(input, {
    state: 'unknown',
    actualCostMicrousd: input.actualCostMicrousd,
    unknownExposureMicrousd: input.unknownExposureMicrousd,
    pricingReviewRequired: input.pricingReviewRequired ?? false,
  });
}

function projectExpectedAccounting(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 5 ||
    value.status !== 'complete' ||
    !integer(value.ledgerRevision) ||
    !integer(value.accountingSequence) ||
    !HEX_64.test(value.accountingDigest) ||
    !HEX_64.test(value.transitionId)
  )
    throw unavailable();
  return clone(value);
}

function accountingMatches(entry, expected) {
  const actual = entryAccounting(entry);
  return same(actual, expected);
}

/** Remove one known-complete entry; absence proves an idempotent prior removal. */
export async function removeCompletedSetupSpend(input) {
  const selected = select(input);
  if (!HEX_64.test(input.jobId)) throw unavailable();
  iso(input.at);
  const expected = projectExpectedAccounting(input.accounting);
  let current = await readLedger(selected);
  if (current === null) throw unavailable();
  for (
    let conflict = 0;
    conflict < SPEND_STORE_LIMITS.conflicts;
    conflict += 1
  ) {
    const entry = current.ledger.active[input.jobId];
    if (!entry)
      return Object.freeze({
        status: 'absent',
        revision: current.ledger.revision,
      });
    if (!accountingMatches(entry, expected)) throw unavailable();
    const ledger = removeCompletedSetupJob(current.ledger, {
      jobId: input.jobId,
      expectedRevision: current.ledger.revision,
      at: input.at,
    });
    const written = await writeLedger(selected, current, ledger);
    if (written.status === 'written')
      return Object.freeze({
        status: 'removed',
        revision: written.current.ledger.revision,
      });
    current = written.current;
  }
  throw unavailable();
}

function findDecision(ledger, decisionId) {
  for (const [policyId, discussion] of Object.entries(ledger.discussions)) {
    const decision = discussion.decisions.find(
      (candidate) => candidate.decisionId === decisionId,
    );
    if (decision) return { policyId, decision };
  }
  return null;
}

function decisionMatches(found, input) {
  return (
    found.policyId === input.policyId &&
    found.decision.triggerRevision === input.triggerRevision &&
    found.decision.observedExposureMicrousd ===
      input.observedExposureMicrousd &&
    found.decision.decision === input.decision &&
    found.decision.authorizedThroughMicrousd ===
      input.authorizedThroughMicrousd &&
    same(found.decision.authorizedOperations, input.authorizedOperations)
  );
}

function currentDecisionMatches(found, input, decision) {
  return (
    found.policyId === input.policyId &&
    found.decision.triggerRevision === input.discussionRevision &&
    found.decision.decision === decision &&
    found.decision.authorizedThroughMicrousd ===
      input.authorizedThroughMicrousd &&
    same(found.decision.authorizedOperations, input.authorizedOperations)
  );
}

function validateDecisionInput(input) {
  if (
    !POLICY_ID.test(input.policyId) ||
    !Number.isSafeInteger(input.triggerRevision) ||
    input.triggerRevision < 1 ||
    !HEX_64.test(input.decisionId) ||
    !['acknowledged', 'stopped'].includes(input.decision) ||
    !integer(input.authorizedThroughMicrousd) ||
    input.authorizedThroughMicrousd > SETUP_SPEND_LIMITS.capMicrousd ||
    !Array.isArray(input.authorizedOperations) ||
    new Set(input.authorizedOperations).size !==
      input.authorizedOperations.length ||
    input.authorizedOperations.some(
      (operation) => !OPERATIONS.has(operation),
    ) ||
    !integer(input.observedExposureMicrousd) ||
    !integer(input.expectedRevision)
  )
    throw unavailable();
  iso(input.at);
}

/** Apply one exact revision-bound owner discussion decision. */
export async function applySetupDiscussionDecision(input) {
  const selected = select(input);
  validateDecisionInput(input);
  let current = await readLedger(selected);
  if (current === null) throw unavailable();
  bindCurrentLedger(current.ledger, selected);
  const existing = findDecision(current.ledger, input.decisionId);
  if (existing) {
    if (!decisionMatches(existing, input)) throw unavailable();
    return Object.freeze({
      status: 'existing',
      spend: safeSummary(current.ledger, input.at),
    });
  }
  if (current.ledger.revision !== input.expectedRevision)
    return Object.freeze({
      status: 'conflict',
      spend: safeSummary(current.ledger, input.at),
    });
  const ledger = decideSetupDiscussion(current.ledger, {
    policyId: input.policyId,
    triggerRevision: input.triggerRevision,
    decisionId: input.decisionId,
    decision: input.decision,
    authorizedThroughMicrousd: input.authorizedThroughMicrousd,
    authorizedOperations: input.authorizedOperations,
    observedExposureMicrousd: input.observedExposureMicrousd,
    at: input.at,
    expectedRevision: input.expectedRevision,
  });
  const written = await writeLedger(selected, current, ledger);
  if (written.status === 'written')
    return Object.freeze({
      status: 'updated',
      spend: safeSummary(written.current.ledger, input.at),
    });
  current = written.current;
  const observed = findDecision(current.ledger, input.decisionId);
  if (observed && decisionMatches(observed, input))
    return Object.freeze({
      status: 'existing',
      spend: safeSummary(current.ledger, input.at),
    });
  return Object.freeze({
    status: 'conflict',
    spend: safeSummary(current.ledger, input.at),
  });
}

/** Bind a browser decision to the current private revision and exposure. */
export async function applyCurrentSetupDiscussionDecision(input) {
  const selected = select(input);
  const decision =
    input.decision === 'acknowledge'
      ? 'acknowledged'
      : input.decision === 'stop'
        ? 'stopped'
        : null;
  if (
    !POLICY_ID.test(input.policyId) ||
    !Number.isSafeInteger(input.discussionRevision) ||
    input.discussionRevision < 1 ||
    !HEX_64.test(input.decisionId) ||
    decision === null ||
    !integer(input.authorizedThroughMicrousd) ||
    input.authorizedThroughMicrousd > SETUP_SPEND_LIMITS.capMicrousd ||
    !Array.isArray(input.authorizedOperations) ||
    new Set(input.authorizedOperations).size !==
      input.authorizedOperations.length ||
    input.authorizedOperations.some((operation) => !OPERATIONS.has(operation))
  )
    throw unavailable();
  iso(input.at);
  const current = await readLedger(selected);
  if (current === null) throw unavailable();
  bindCurrentLedger(current.ledger, selected);
  if (input.policyId !== current.ledger.activePolicyId) throw unavailable();
  const existing = findDecision(current.ledger, input.decisionId);
  if (existing) {
    if (!currentDecisionMatches(existing, input, decision)) throw unavailable();
    return Object.freeze({
      status: 'existing',
      spend: safeSummary(current.ledger, input.at),
    });
  }
  const discussion = current.ledger.discussions[input.policyId];
  if (
    discussion?.status !== 'required' ||
    discussion.currentRevision !== input.discussionRevision
  )
    return Object.freeze({
      status: 'conflict',
      spend: safeSummary(current.ledger, input.at),
    });
  const observedExposureMicrousd = exposureMicrousd(current.ledger);
  const ledger = decideSetupDiscussion(current.ledger, {
    policyId: input.policyId,
    triggerRevision: input.discussionRevision,
    decisionId: input.decisionId,
    decision,
    authorizedThroughMicrousd: input.authorizedThroughMicrousd,
    authorizedOperations: input.authorizedOperations,
    observedExposureMicrousd,
    at: input.at,
    expectedRevision: current.ledger.revision,
  });
  const written = await writeLedger(selected, current, ledger);
  if (written.status === 'written')
    return Object.freeze({
      status: 'updated',
      spend: safeSummary(written.current.ledger, input.at),
    });
  const observed = findDecision(written.current.ledger, input.decisionId);
  if (observed && currentDecisionMatches(observed, input, decision))
    return Object.freeze({
      status: 'existing',
      spend: safeSummary(written.current.ledger, input.at),
    });
  return Object.freeze({
    status: 'conflict',
    spend: safeSummary(written.current.ledger, input.at),
  });
}
