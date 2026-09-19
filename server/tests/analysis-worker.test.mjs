import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisResultValidationError } from '../lib/analysis-result.mjs';
import {
  AnthropicAttemptError,
  AnthropicRefusalError,
  createAnthropicClient,
} from '../lib/anthropic.mjs';
import { BoardError } from '../lib/errors.mjs';
import { transitionJob } from '../lib/job-machine.mjs';
import { createAnalysisJob, hashDispatchCapability } from '../lib/jobs.mjs';
import { createAnalysisReconciler } from '../lib/analysis-reconciler.mjs';
import { createAnalysisWorker } from '../lib/analysis-worker.mjs';
import { SETUP_POLICY_ID, SETUP_SPEND_LIMITS } from '../lib/spend.mjs';

const budget = Object.freeze({ name: 'worker-test-budget' });
const hash = (character) => character.repeat(64);
const capability = Buffer.alloc(32, 9).toString('base64url');
const repository = Object.freeze({
  id: 17,
  fullName: 'cboone/widgets',
  name: 'widgets',
  private: true,
  url: 'https://github.com/cboone/widgets',
});
const primaryCostMicrousd =
  1000 * SETUP_SPEND_LIMITS.inputRateMicrousd +
  100 * SETUP_SPEND_LIMITS.outputRateMicrousd;

function accounting(sequence, status = 'pending') {
  return {
    status,
    ledgerRevision: sequence,
    accountingSequence: sequence,
    accountingDigest: hash(String((sequence % 8) + 1)),
    transitionId: hash(String(((sequence + 1) % 8) + 1)),
  };
}

function clock(value = Date.parse('2026-09-19T04:00:00.000Z')) {
  let current = value;
  return Object.freeze({
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
      return current;
    },
  });
}

function faultController(boundary, outcome) {
  if (boundary === null && outcome === null)
    return Object.freeze({ before() {}, after() {}, count: () => 0 });
  assert.equal(typeof boundary, 'string');
  assert.ok(['absent', 'committed'].includes(outcome));
  let count = 0;
  const interrupt = (position, candidate) => {
    if (count !== 0 || position !== outcome || candidate !== boundary) return;
    count += 1;
    throw new Error(`synthetic ${outcome} ${boundary}`);
  };
  return Object.freeze({
    before: (candidate) => interrupt('absent', candidate),
    after: (candidate) => interrupt('committed', candidate),
    count: () => count,
  });
}

function dispatchableJob({
  now,
  operation = 'generate',
  expectedCurrentReportId = null,
} = {}) {
  const at = (offset) => new Date(now + offset).toISOString();
  let job = createAnalysisJob({
    ownerId: 99961,
    repositoryId: repository.id,
    idempotencyKey: '018f0f11-1111-7111-8111-111111111111',
    operation,
    expectedCurrentReportId,
    authorizationEpoch: 2,
    admissionDeployId: 'deploy-1',
    at: at(-3),
    deadlineAt: at(900_000),
  });
  job = transitionJob(job, {
    type: 'reservation-committed',
    at: at(-2),
    deadlineAt: at(900_000),
    pricePolicyId: SETUP_POLICY_ID,
    reservationMicrousd: [
      SETUP_SPEND_LIMITS.attemptCostMicrousd,
      SETUP_SPEND_LIMITS.attemptCostMicrousd,
    ],
    accounting: accounting(1),
  });
  return transitionJob(job, {
    type: 'dispatch-installed',
    at: at(-1),
    deadlineAt: at(900_000),
    capabilityHash: hashDispatchCapability(capability),
  });
}

function jobService(initial, { afterTransition, fault } = {}) {
  let value = structuredClone(initial);
  let revision = 1;
  return Object.freeze({
    readJob: async ({ jobId }) =>
      value.jobId === jobId
        ? { value: structuredClone(value), etag: `etag-${revision}` }
        : null,
    applyTransition: async ({ jobId, expectedEtag, event }) => {
      assert.equal(jobId, value.jobId);
      if (expectedEtag !== `etag-${revision}`)
        return {
          status: 'conflict',
          value: structuredClone(value),
          etag: `etag-${revision}`,
        };
      fault?.before(event.type);
      value = transitionJob(value, event);
      revision += 1;
      afterTransition?.(event);
      fault?.after(event.type);
      return {
        status: 'updated',
        value: structuredClone(value),
        etag: `etag-${revision}`,
      };
    },
    value: () => structuredClone(value),
  });
}

function reportService(
  job,
  {
    current = null,
    previous = null,
    priorEnvelope = null,
    retainedEnvelopes = [],
    afterRotate = null,
    fault = null,
  } = {},
) {
  const versions = new Map();
  if (priorEnvelope)
    versions.set(
      `owners/99961/repositories/17/versions/${priorEnvelope.reportId}`,
      structuredClone(priorEnvelope),
    );
  for (const envelope of retainedEnvelopes)
    versions.set(
      `owners/99961/repositories/17/versions/${envelope.reportId}`,
      structuredClone(envelope),
    );
  const state = {
    repository,
    revision: 1,
    current: current === null ? null : structuredClone(current),
    previous: previous === null ? null : structuredClone(previous),
    activeJob: {
      jobId: job.jobId,
      operation: job.operation,
      expectedCurrentReportId: job.expectedCurrentReportId,
      admittedAt: job.createdAt,
    },
    lastAnalysisAttempt: null,
  };
  return Object.freeze({
    readRepositoryState: async () => ({
      state: structuredClone(state),
      etag: `state-${state.revision}`,
    }),
    readReportEnvelope: async ({ reportId }) => {
      const key = `owners/99961/repositories/17/versions/${reportId}`;
      const envelope = versions.get(key);
      return envelope
        ? { key, envelope: structuredClone(envelope), etag: 'version-1' }
        : null;
    },
    writeImmutableReportVersion: async ({ versionKey, version }) => {
      fault?.before('immutable-version-write');
      if (versions.has(versionKey))
        assert.deepEqual(versions.get(versionKey), version);
      else versions.set(versionKey, structuredClone(version));
      fault?.after('immutable-version-write');
      return {
        status: 'written',
        versionKey,
        candidateDigest: version.digest,
      };
    },
    rotateRepositoryReport: async ({
      jobId,
      expectedCurrentReportId,
      current: next,
    }) => {
      assert.equal(state.activeJob?.jobId, jobId);
      fault?.before('pointer-rotation');
      if (state.current?.reportId !== next.reportId) {
        assert.equal(state.current?.reportId ?? null, expectedCurrentReportId);
        state.previous = state.current;
        state.current = structuredClone(next);
        state.revision += 1;
        afterRotate?.(structuredClone(state));
      }
      fault?.after('pointer-rotation');
      return { status: 'updated', state: structuredClone(state) };
    },
    clearRepositoryJob: async ({ jobId, lastAnalysisAttempt }) => {
      if (state.activeJob !== null) {
        assert.equal(state.activeJob.jobId, jobId);
        state.activeJob = null;
        state.lastAnalysisAttempt = structuredClone(lastAnalysisAttempt);
        state.revision += 1;
      } else assert.deepEqual(state.lastAnalysisAttempt, lastAnalysisAttempt);
      return { status: 'updated', state: structuredClone(state) };
    },
    repairCatalogRepository: async () => ({ status: 'unchanged' }),
    state: () => structuredClone(state),
    setActiveJob: (activeJob) => {
      state.activeJob = structuredClone(activeJob);
    },
    versions,
  });
}

function spendService(job, { afterSettle, fault } = {}) {
  let reservation = {
    jobId: job.jobId,
    policyId: job.pricePolicyId,
    reservationMicrousd: job.attempts.map(
      (attempt) => attempt.reservationMicrousd,
    ),
    attempts: job.attempts.map((attempt) => ({
      number: attempt.number,
      ceilingMicrousd: attempt.reservationMicrousd,
      state: 'reserved',
      actualCostMicrousd: 0,
      unknownExposureMicrousd: 0,
      recordedAt: null,
    })),
    accounting: structuredClone(job.accounting),
  };
  let sequence = 1;
  let pricingReviewRequired = false;
  const mutate = async (input, state) => {
    assert.equal(await input.revalidate(), true);
    const boundary =
      state === 'settled' && input.attemptNumber === 1
        ? 'primary-settlement'
        : null;
    if (boundary !== null) fault?.before(boundary);
    const attempt = reservation.attempts[input.attemptNumber - 1];
    let changed = false;
    if (attempt.state === 'reserved') {
      attempt.state = state;
      attempt.actualCostMicrousd = input.actualCostMicrousd ?? 0;
      attempt.unknownExposureMicrousd = input.unknownExposureMicrousd ?? 0;
      attempt.recordedAt = input.at;
      changed = true;
    } else if (attempt.state === 'unknown' && state === 'unknown') {
      const actualCostMicrousd = Math.max(
        attempt.actualCostMicrousd,
        input.actualCostMicrousd ?? 0,
      );
      const unknownExposureMicrousd = Math.max(
        attempt.unknownExposureMicrousd,
        input.unknownExposureMicrousd ?? 0,
        actualCostMicrousd,
      );
      changed =
        actualCostMicrousd !== attempt.actualCostMicrousd ||
        unknownExposureMicrousd !== attempt.unknownExposureMicrousd ||
        (input.pricingReviewRequired === true && !pricingReviewRequired);
      attempt.actualCostMicrousd = actualCostMicrousd;
      attempt.unknownExposureMicrousd = unknownExposureMicrousd;
      if (Date.parse(input.at) > Date.parse(attempt.recordedAt))
        attempt.recordedAt = input.at;
    } else assert.equal(attempt.state, state);
    if (changed) {
      sequence += 1;
      const status = reservation.attempts.some(
        (candidate) => candidate.state === 'unknown',
      )
        ? 'unknown'
        : reservation.attempts.every((candidate) =>
              ['settled', 'released'].includes(candidate.state),
            )
          ? 'complete'
          : 'pending';
      reservation.accounting = accounting(sequence, status);
      if (input.pricingReviewRequired === true) pricingReviewRequired = true;
      if (state === 'settled') afterSettle?.(input.attemptNumber);
    }
    if (boundary !== null) fault?.after(boundary);
    return {
      status: changed ? 'updated' : 'existing',
      attempt: structuredClone(attempt),
      accounting: structuredClone(reservation.accounting),
    };
  };
  return Object.freeze({
    readReservation: async ({ jobId }) =>
      reservation?.jobId === jobId
        ? {
            ...structuredClone(reservation),
            pricingReviewRequired,
          }
        : null,
    listReservations: async () =>
      reservation === null ? [] : [structuredClone(reservation)],
    fenceReservation: async ({ revalidate }) => {
      assert.equal(await revalidate(), true);
      return reservation === null
        ? { status: 'fenced', revision: sequence + 1 }
        : { status: 'existing' };
    },
    settleAttempt: (input) => mutate(input, 'settled'),
    releaseAttempt: (input) => mutate(input, 'released'),
    markAttemptUnknown: (input) => mutate(input, 'unknown'),
    removeCompleted: async ({ accounting: expected }) => {
      if (reservation === null) return { status: 'absent' };
      assert.deepEqual(reservation.accounting, expected);
      assert.ok(
        reservation.attempts.every((attempt) =>
          ['settled', 'released'].includes(attempt.state),
        ),
      );
      reservation = null;
      return { status: 'removed' };
    },
    reservation: () =>
      reservation === null ? null : structuredClone(reservation),
    pricingReviewRequired: () => pricingReviewRequired,
    requirePricingReview: () => {
      pricingReviewRequired = true;
    },
  });
}

function primaryResponse(delta = { valid: true }) {
  return {
    model: 'claude-opus-5',
    stopReason: 'end_turn',
    usage: {
      inputTokens: 1000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 100,
      inferenceGeo: 'global',
      serviceTier: 'standard',
    },
    delta,
    validationError: null,
  };
}

function overReservationResponse(delta = { valid: true }) {
  const response = primaryResponse(delta);
  response.usage.inputTokens =
    Math.floor(
      SETUP_SPEND_LIMITS.attemptCostMicrousd /
        SETUP_SPEND_LIMITS.inputRateMicrousd,
    ) + 1;
  response.usage.outputTokens = 0;
  return response;
}

function fixture({
  operation = 'generate',
  responses = [primaryResponse()],
  sourceError = null,
  revokeBeforeWrite = false,
  revokeBeforeCorrection = false,
  current = null,
  previous = null,
  priorEnvelope = null,
  retainedEnvelopes = [],
  afterRotate = null,
  sourceAdvance = 0,
  authAdvance = 0,
  replaceCollectingClaimAfterAuth = false,
  countClaimAdvance = 0,
  prepareAdvance = 0,
  responseAdvance = 0,
  afterSettleAdvance = 0,
  correctiveStartAdvance = 0,
  pricingReviewAfterCount = null,
  messageClient = null,
  reconcileBeforeErrorAt = null,
  faultBoundary = null,
  faultOutcome = null,
} = {}) {
  const time = clock();
  const fault = faultController(faultBoundary, faultOutcome);
  const job = dispatchableJob({
    now: time.now(),
    operation,
    expectedCurrentReportId: current?.reportId ?? null,
  });
  const jobs = jobService(job, {
    fault,
    afterTransition: (event) => {
      if (event.type === 'corrective-started')
        time.advance(correctiveStartAdvance);
      if (event.type === 'free-lease-claimed' && event.phase === 'counting')
        time.advance(countClaimAdvance);
    },
  });
  const reports = reportService(job, {
    current,
    previous,
    priorEnvelope,
    retainedEnvelopes,
    afterRotate,
    fault,
  });
  const spend = spendService(job, {
    fault,
    afterSettle: (number) => {
      if (number === 1) time.advance(afterSettleAdvance);
    },
  });
  let rechecks = 0;
  const auth = Object.freeze({
    acquireJobToken: async () => {
      time.advance(authAdvance);
      if (replaceCollectingClaimAfterAuth) {
        const currentJob = await jobs.readJob({ jobId: job.jobId, budget });
        const replacementAt = new Date(time.now()).toISOString();
        const replaced = await jobs.applyTransition({
          jobId: job.jobId,
          expectedEtag: currentJob.etag,
          event: {
            type: 'free-lease-claimed',
            at: replacementAt,
            phase: 'collecting',
            tokenHash: hash('f'),
            expiresAt: new Date(time.now() + 90_000).toISOString(),
          },
          budget,
        });
        assert.equal(replaced.status, 'updated');
      }
      return {
        ownerId: 99961,
        accessToken: 'github-token',
        generation: 3,
      };
    },
    recheckJobAuthorization: async () => {
      rechecks += 1;
      if ((revokeBeforeWrite || revokeBeforeCorrection) && rechecks === 2)
        throw new BoardError('source_authorization_required');
      return { id: 99961, login: 'cboone' };
    },
  });
  let sourceCalls = 0;
  let sourceBudgetDeadline = null;
  const source = Object.freeze({
    checkRepository: async (input) => {
      sourceCalls += 1;
      sourceBudgetDeadline = input.budget.deadline;
      time.advance(sourceAdvance);
      input.budget.assertActive?.();
      if (sourceError) throw sourceError;
      return {
        summary: {
          fingerprint: { value: hash('d') },
          provenance: { limitations: [] },
        },
        sourceSnapshot: { inventory: { repo: repository.fullName } },
      };
    },
  });
  const services = { jobs, reports, spend };
  const reconciler = createAnalysisReconciler({
    ...services,
    now: time.now,
    versionDigest: (envelope) => envelope.digest,
  });
  let messages = 0;
  let counts = 0;
  let modelRetrievals = 0;
  const queue = [...responses];
  const anthropic = Object.freeze({
    retrieveModel: async () => {
      modelRetrievals += 1;
      return { id: 'claude-opus-5' };
    },
    countTokens: async () => {
      counts += 1;
      if (counts === pricingReviewAfterCount) spend.requirePricingReview();
      return 1000;
    },
    createMessage: async (request) => {
      messages += 1;
      time.advance(responseAdvance);
      if (messageClient !== null) return messageClient.createMessage(request);
      const next = queue.shift();
      if (next instanceof Error) {
        if (messages === reconcileBeforeErrorAt) {
          time.advance(300_000);
          await reconciler.reconcile({ jobId: job.jobId, budget });
        }
        throw next;
      }
      return structuredClone(next);
    },
  });
  let random = 1;
  const worker = createAnalysisWorker({
    ...services,
    auth,
    sourceOperations: source,
    anthropicClient: anthropic,
    reconciler,
    deployId: 'deploy-1',
    now: time.now,
    randomBytes: () => Buffer.alloc(32, random++),
    prepareInput: async ({ countClient }) => {
      time.advance(prepareAdvance);
      const analysisInput = { repository: { id: repository.id } };
      await countClient({
        messages: [{ role: 'user', content: JSON.stringify(analysisInput) }],
      });
      return {
        analysisInput,
        analysisSelection: { version: 'test' },
      };
    },
    assembleResult: ({ analysisDelta, job: currentJob, generatedAt }) => {
      if (analysisDelta.invalid) throw new AnalysisResultValidationError();
      return {
        candidateDigest: hash('e'),
        value: {
          jobId: currentJob.jobId,
          reportId: currentJob.publication.reportId,
          generatedAt,
          source: { fingerprint: { value: currentJob.sourceFingerprint } },
          digest: hash('e'),
        },
      };
    },
  });
  return {
    time,
    job,
    jobs,
    reports,
    spend,
    reconciler,
    worker,
    metrics: {
      messages: () => messages,
      counts: () => counts,
      modelRetrievals: () => modelRetrievals,
      rechecks: () => rechecks,
      sourceCalls: () => sourceCalls,
      sourceBudgetDeadline: () => sourceBudgetDeadline,
      faults: () => fault.count(),
    },
  };
}

const runWorker = (setup) =>
  setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });

async function expectFault(setup, boundary, outcome) {
  await assert.rejects(
    runWorker(setup),
    new RegExp(`synthetic ${outcome} ${boundary}`, 'u'),
  );
  assert.equal(setup.metrics.faults(), 1);
}

function advanceToStateDeadline(setup) {
  const deadline = Date.parse(setup.jobs.value().stateDeadlineAt);
  assert.ok(Number.isSafeInteger(deadline));
  setup.time.advance(Math.max(0, deadline - setup.time.now()));
}

const reconcileJob = (setup) =>
  setup.reconciler.reconcile({
    jobId: setup.job.jobId,
    budget,
  });

async function assertNoAdditionalPaidCall(setup, expected) {
  await runWorker(setup);
  assert.equal(setup.metrics.messages(), expected);
}

function assertNoReport(setup) {
  const state = setup.reports.state();
  assert.equal(state.current, null);
  assert.equal(state.previous, null);
  assert.equal(state.activeJob, null);
  assert.equal(state.lastAnalysisAttempt.status, setup.jobs.value().state);
  assert.equal(setup.reports.versions.size, 0);
}

function assertKnownAccounting(job, setup) {
  assert.equal(job.accounting.status, 'complete');
  assert.ok(job.accounting.ledgerRevision > 1);
  assert.ok(job.accounting.accountingSequence > 1);
  assert.match(job.accounting.accountingDigest, /^[a-f0-9]{64}$/u);
  assert.match(job.accounting.transitionId, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    job.attempts.map(({ state }) => state),
    ['settled', 'released'],
  );
  assert.equal(job.attempts[0].costMicrousd, primaryCostMicrousd);
  assert.equal(job.attempts[1].costMicrousd, null);
  assert.equal(setup.spend.reservation(), null);
}

function assertUnknownAccounting(job, setup) {
  assert.equal(job.state, 'ambiguous');
  assert.equal(job.accounting.status, 'unknown');
  assert.deepEqual(
    job.attempts.map(({ state }) => state),
    ['unknown', 'released'],
  );
  const reservation = setup.spend.reservation();
  assert.equal(reservation.accounting.status, 'unknown');
  assert.deepEqual(job.accounting, reservation.accounting);
  assert.deepEqual(
    reservation.attempts.map(({ state }) => state),
    ['unknown', 'released'],
  );
  assert.equal(reservation.attempts[0].actualCostMicrousd, 0);
  assert.equal(
    reservation.attempts[0].unknownExposureMicrousd,
    job.attempts[0].reservationMicrousd,
  );
}

function assertGeneratedReport(job, setup) {
  const state = setup.reports.state();
  assert.equal(job.state, 'succeeded');
  assert.equal(state.current.reportId, job.publication.reportId);
  assert.equal(state.previous, null);
  assert.equal(state.activeJob, null);
  assert.equal(state.lastAnalysisAttempt.status, 'succeeded');
  assert.equal(setup.reports.versions.has(job.publication.versionKey), true);
  assert.equal(setup.reports.versions.size, 1);
  assertKnownAccounting(job, setup);
}

function assertRefreshedReport(job, setup, history) {
  const state = setup.reports.state();
  assert.equal(job.state, 'succeeded');
  assert.equal(state.current.reportId, job.publication.reportId);
  assert.equal(state.previous.reportId, history.current.reportId);
  assert.equal(state.activeJob, null);
  assert.equal(state.lastAnalysisAttempt.status, 'succeeded');
  assert.equal(setup.reports.versions.has(history.previous.versionKey), true);
  assert.equal(setup.reports.versions.has(job.publication.versionKey), true);
  assert.equal(setup.reports.versions.size, 3);
  assertKnownAccounting(job, setup);
}

function refreshHistory() {
  const currentReportId = hash('a');
  const displacedReportId = hash('b');
  return {
    current: {
      reportId: currentReportId,
      versionKey: `owners/99961/repositories/17/versions/${currentReportId}`,
      generatedAt: '2026-09-18T04:00:00.000Z',
      sourceFingerprint: hash('c'),
    },
    previous: {
      reportId: displacedReportId,
      versionKey: `owners/99961/repositories/17/versions/${displacedReportId}`,
      generatedAt: '2026-09-17T04:00:00.000Z',
      sourceFingerprint: hash('d'),
    },
    priorEnvelope: {
      reportId: currentReportId,
      report: {
        issues: [],
        lanes: [],
        startNow: [],
        contention: {},
        notes: {},
      },
    },
    retainedEnvelope: { reportId: displacedReportId, retained: true },
  };
}

test('full worker success publishes once and duplicate delivery performs no paid work', async () => {
  const setup = fixture();
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'succeeded');
  assert.equal(setup.metrics.messages(), 1);
  assert.equal(
    setup.reports.state().current.reportId,
    result.publication.reportId,
  );
  assert.equal(setup.reports.state().activeJob, null);
  assert.equal(setup.spend.reservation(), null);

  const duplicate = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(duplicate.state, 'succeeded');
  assert.equal(setup.metrics.messages(), 1);
});

for (const outcome of ['absent', 'committed']) {
  test(`primary-started ${outcome} write recovery never guesses that a provider call ran`, async () => {
    const setup = fixture({
      faultBoundary: 'primary-started',
      faultOutcome: outcome,
    });
    await expectFault(setup, 'primary-started', outcome);
    assert.equal(
      setup.jobs.value().state,
      outcome === 'absent' ? 'counting' : 'primary-in-flight',
    );
    assert.equal(setup.metrics.messages(), 0);

    advanceToStateDeadline(setup);
    const recovered = await reconcileJob(setup);
    if (outcome === 'absent') {
      assert.equal(recovered.value.state, 'failed');
      assert.equal(recovered.value.accounting.status, 'complete');
      assert.deepEqual(
        recovered.value.attempts.map(({ state }) => state),
        ['released', 'released'],
      );
      assert.equal(setup.spend.reservation(), null);
    } else assertUnknownAccounting(recovered.value, setup);
    assertNoReport(setup);
    await assertNoAdditionalPaidCall(setup, 0);
  });
}

for (const outcome of ['absent', 'committed']) {
  test(`response-completed ${outcome} write recovery accounts the single provider response`, async () => {
    const setup = fixture({
      faultBoundary: 'response-completed',
      faultOutcome: outcome,
    });
    await expectFault(setup, 'response-completed', outcome);
    assert.equal(
      setup.jobs.value().state,
      outcome === 'absent' ? 'primary-in-flight' : 'primary-response-complete',
    );
    assert.equal(setup.metrics.messages(), 1);

    advanceToStateDeadline(setup);
    const recovered = await reconcileJob(setup);
    if (outcome === 'absent') assertUnknownAccounting(recovered.value, setup);
    else {
      assert.equal(recovered.value.state, 'failed');
      assertKnownAccounting(recovered.value, setup);
    }
    assertNoReport(setup);
    await assertNoAdditionalPaidCall(setup, 1);
  });
}

for (const outcome of ['absent', 'committed']) {
  test(`primary settlement ${outcome} write recovery releases correction without dispatch`, async () => {
    const setup = fixture({
      responses: [primaryResponse({ invalid: true })],
      faultBoundary: 'primary-settlement',
      faultOutcome: outcome,
    });
    await expectFault(setup, 'primary-settlement', outcome);
    assert.equal(setup.jobs.value().state, 'primary-invalid');
    assert.equal(
      setup.spend.reservation().attempts[0].state,
      outcome === 'absent' ? 'reserved' : 'settled',
    );
    assert.equal(setup.metrics.messages(), 1);

    advanceToStateDeadline(setup);
    const recovered = await reconcileJob(setup);
    assert.equal(recovered.value.state, 'failed');
    assertKnownAccounting(recovered.value, setup);
    assertNoReport(setup);
    await assertNoAdditionalPaidCall(setup, 1);
  });
}

for (const outcome of ['absent', 'committed']) {
  test(`immutable version ${outcome} write recovery preserves one paid response`, async () => {
    const setup = fixture({
      faultBoundary: 'immutable-version-write',
      faultOutcome: outcome,
    });
    await expectFault(setup, 'immutable-version-write', outcome);
    assert.equal(setup.jobs.value().state, 'validating-primary');
    assert.equal(setup.reports.versions.size, outcome === 'absent' ? 0 : 1);
    assert.equal(setup.metrics.messages(), 1);

    advanceToStateDeadline(setup);
    const recovered = await reconcileJob(setup);
    if (outcome === 'absent') {
      assert.equal(recovered.value.state, 'failed');
      assertKnownAccounting(recovered.value, setup);
      assertNoReport(setup);
    } else assertGeneratedReport(recovered.value, setup);
    await assertNoAdditionalPaidCall(setup, 1);
  });
}

test('lost acknowledgement after committed pointer rotation preserves displaced metadata and its physical version', async () => {
  const history = refreshHistory();
  let rotations = 0;
  const setup = fixture({
    operation: 'refresh',
    current: history.current,
    previous: history.previous,
    priorEnvelope: history.priorEnvelope,
    retainedEnvelopes: [history.retainedEnvelope],
    afterRotate: () => {
      rotations += 1;
    },
    faultBoundary: 'pointer-rotation',
    faultOutcome: 'committed',
  });

  await expectFault(setup, 'pointer-rotation', 'committed');

  const interrupted = setup.jobs.value();
  assert.equal(interrupted.state, 'version-written');
  assert.equal(
    interrupted.publication.cleanupCandidateKey,
    history.previous.versionKey,
  );
  assert.equal(
    setup.reports.state().current.reportId,
    interrupted.publication.reportId,
  );
  assert.equal(
    setup.reports.state().previous.reportId,
    history.current.reportId,
  );
  assert.equal(setup.reports.versions.has(history.previous.versionKey), true);

  const recovered = await setup.reconciler.reconcile({
    jobId: setup.job.jobId,
    budget,
  });
  assert.equal(recovered.value.state, 'succeeded');
  assert.equal(
    recovered.value.publication.cleanupCandidateKey,
    history.previous.versionKey,
  );
  assertRefreshedReport(recovered.value, setup, history);
  assert.equal(rotations, 1);
  assert.equal(setup.metrics.messages(), 1);
  await assertNoAdditionalPaidCall(setup, 1);
});

test('an absent pointer rotation retries from the recorded displaced version', async () => {
  const history = refreshHistory();
  const setup = fixture({
    operation: 'refresh',
    current: history.current,
    previous: history.previous,
    priorEnvelope: history.priorEnvelope,
    retainedEnvelopes: [history.retainedEnvelope],
    faultBoundary: 'pointer-rotation',
    faultOutcome: 'absent',
  });

  await expectFault(setup, 'pointer-rotation', 'absent');
  const interrupted = setup.jobs.value();
  assert.equal(interrupted.state, 'version-written');
  assert.equal(
    interrupted.publication.cleanupCandidateKey,
    history.previous.versionKey,
  );
  assert.equal(
    setup.reports.state().current.reportId,
    history.current.reportId,
  );
  assert.equal(
    setup.reports.state().previous.reportId,
    history.previous.reportId,
  );
  assert.equal(setup.metrics.messages(), 1);

  const recovered = await reconcileJob(setup);
  assertRefreshedReport(recovered.value, setup, history);
  await assertNoAdditionalPaidCall(setup, 1);
});

for (const outcome of ['absent', 'committed']) {
  test(`report-published ${outcome} write recovery preserves the rotated report`, async () => {
    const history = refreshHistory();
    const setup = fixture({
      operation: 'refresh',
      current: history.current,
      previous: history.previous,
      priorEnvelope: history.priorEnvelope,
      retainedEnvelopes: [history.retainedEnvelope],
      faultBoundary: 'report-published',
      faultOutcome: outcome,
    });

    await expectFault(setup, 'report-published', outcome);
    assert.equal(
      setup.jobs.value().state,
      outcome === 'absent' ? 'version-written' : 'published',
    );
    assert.equal(
      setup.reports.state().current.reportId,
      setup.jobs.value().publication.reportId,
    );
    assert.equal(
      setup.reports.state().previous.reportId,
      history.current.reportId,
    );
    assert.equal(setup.metrics.messages(), 1);

    const recovered = await reconcileJob(setup);
    assertRefreshedReport(recovered.value, setup, history);
    await assertNoAdditionalPaidCall(setup, 1);
  });
}

test('definitive invalid primary can use one corrective attempt and publish', async () => {
  const setup = fixture({
    responses: [primaryResponse({ invalid: true }), primaryResponse()],
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'succeeded');
  assert.equal(setup.metrics.messages(), 2);
  assert.equal(setup.metrics.counts(), 2);
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['settled', 'settled'],
  );
});

test('invalid primary releases correction when its full paid window no longer remains', async () => {
  const setup = fixture({
    responses: [primaryResponse({ invalid: true })],
    sourceAdvance: 89_000,
    prepareAdvance: 59_000,
    responseAdvance: 299_000,
    afterSettleAdvance: 65_000,
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.terminal.errorCode, 'analysis_output_invalid');
  assert.equal(setup.metrics.messages(), 1);
  assert.equal(setup.metrics.counts(), 1);
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['settled', 'released'],
  );
});

test('source failure terminates and releases both reservations before any paid call', async () => {
  const setup = fixture({ sourceError: new BoardError('source_unavailable') });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.terminal.errorCode, 'source_unavailable');
  assert.equal(setup.metrics.messages(), 0);
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['released', 'released'],
  );
});

test('collection uses the remaining durable lease after authentication work', async () => {
  const setup = fixture({ authAdvance: 89_000, sourceAdvance: 1_001 });
  const collectingStartedAt = setup.time.now();
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.terminal.errorCode, 'source_timeout');
  assert.equal(setup.metrics.sourceCalls(), 1);
  assert.equal(
    setup.metrics.sourceBudgetDeadline(),
    collectingStartedAt + 90_000,
  );
  assert.equal(setup.metrics.modelRetrievals(), 0);
  assert.equal(setup.metrics.counts(), 0);
  assert.equal(setup.metrics.messages(), 0);
});

test('an expired collection owner cannot adopt a replacement worker lease', async () => {
  const setup = fixture({
    authAdvance: 90_000,
    replaceCollectingClaimAfterAuth: true,
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'collecting');
  assert.equal(result.freeLease.tokenHash, hash('f'));
  assert.equal(setup.metrics.sourceCalls(), 0);
  assert.equal(setup.metrics.modelRetrievals(), 0);
  assert.equal(setup.metrics.counts(), 0);
  assert.equal(setup.metrics.messages(), 0);
});

test('an expired counting lease stops before model metadata or token counting', async () => {
  const setup = fixture({ countClaimAdvance: 60_000 });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.terminal.errorCode, 'source_timeout');
  assert.equal(setup.metrics.sourceCalls(), 1);
  assert.equal(setup.metrics.modelRetrievals(), 0);
  assert.equal(setup.metrics.counts(), 0);
  assert.equal(setup.metrics.messages(), 0);
});

test('provider cutoff is measured from the enclosing function invocation', async () => {
  const setup = fixture();
  const invocationStartedAt = setup.time.now();
  setup.time.advance(600_000);
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
    invocationStartedAt,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.terminal.errorCode, 'analysis_unavailable');
  assert.equal(setup.metrics.messages(), 0);
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['released', 'released'],
  );
});

test('a pricing gate raised by another reserved job blocks the primary paid boundary', async () => {
  const setup = fixture({ pricingReviewAfterCount: 1 });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.terminal.errorCode, 'analysis_unavailable');
  assert.equal(setup.metrics.messages(), 0);
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['released', 'released'],
  );
});

test('ambiguous provider transport retains conservative exposure and never replays', async () => {
  const setup = fixture({
    responses: [new AnthropicAttemptError('analysis_ambiguous')],
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'ambiguous');
  assert.equal(result.accounting.status, 'unknown');
  assert.equal(result.attempts[0].state, 'unknown');
  assert.equal(setup.spend.reservation().attempts[0].state, 'unknown');
  assert.equal(setup.reports.state().activeJob, null);

  await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(setup.metrics.messages(), 1);
});

test('a 2xx response without a body retains unknown exposure in the worker', async () => {
  const messageClient = createAnthropicClient({
    apiKey: 'synthetic-key',
    fetchImpl: async () => new Response(null, { status: 200 }),
  });
  const setup = fixture({
    messageClient,
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'ambiguous');
  assert.equal(result.terminal.errorCode, 'analysis_ambiguous');
  assert.equal(result.attempts[0].state, 'unknown');
  assert.equal(setup.spend.reservation().attempts[0].state, 'unknown');
  assert.equal(setup.metrics.messages(), 1);
});

test('a returned response model mismatch requires pricing review', async () => {
  const response = primaryResponse();
  response.model = 'claude-opus-5-unreviewed';
  const setup = fixture({ responses: [response] });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'ambiguous');
  assert.equal(result.terminal.errorCode, 'pricing_review_required');
  assert.equal(result.attempts[0].state, 'unknown');
  assert.equal(setup.spend.pricingReviewRequired(), true);
  assert.equal(setup.metrics.messages(), 1);
});

test('unpriceable primary response retains full exposure and blocks pricing', async () => {
  const setup = fixture({
    responses: [
      new AnthropicAttemptError('pricing_review_required', {
        pricingReviewRequired: true,
        usage: { inputTokens: 123, outputTokens: 4 },
      }),
    ],
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'ambiguous');
  assert.equal(result.terminal.errorCode, 'pricing_review_required');
  assert.equal(result.attempts[0].state, 'unknown');
  const reservation = setup.spend.reservation();
  assert.equal(
    reservation.attempts[0].actualCostMicrousd,
    result.attempts[0].reservationMicrousd,
  );
  assert.equal(
    reservation.attempts[0].unknownExposureMicrousd,
    result.attempts[0].reservationMicrousd,
  );
  assert.equal(setup.spend.pricingReviewRequired(), true);
  assert.equal(setup.metrics.messages(), 1);
});

test('cache-billed usage cannot become a fixed-rate known lower bound', async () => {
  const response = overReservationResponse();
  const setup = fixture({
    responses: [
      new AnthropicAttemptError('pricing_review_required', {
        pricingReviewRequired: true,
        usage: {
          ...response.usage,
          cacheCreationInputTokens: 1,
        },
      }),
    ],
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  const reservation = setup.spend.reservation();
  assert.equal(result.state, 'ambiguous');
  assert.equal(
    reservation.attempts[0].actualCostMicrousd,
    result.attempts[0].reservationMicrousd,
  );
  assert.equal(
    reservation.attempts[0].unknownExposureMicrousd,
    result.attempts[0].reservationMicrousd,
  );
  assert.equal(setup.spend.pricingReviewRequired(), true);
});

test('returned primary usage above its reservation requires pricing review', async () => {
  const response = overReservationResponse();
  const expectedCostMicrousd =
    response.usage.inputTokens * SETUP_SPEND_LIMITS.inputRateMicrousd;
  const setup = fixture({ responses: [response] });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'ambiguous');
  assert.equal(result.terminal.errorCode, 'pricing_review_required');
  assert.equal(result.attempts[0].state, 'unknown');
  const reservation = setup.spend.reservation();
  assert.equal(
    reservation.attempts[0].actualCostMicrousd,
    expectedCostMicrousd,
  );
  assert.equal(
    reservation.attempts[0].unknownExposureMicrousd,
    expectedCostMicrousd,
  );
  assert.equal(setup.spend.pricingReviewRequired(), true);
  assert.equal(setup.metrics.messages(), 1);
});

test('a terminal expiry race cannot reduce a known over-ceiling primary cost', async () => {
  const response = overReservationResponse();
  const expectedCostMicrousd =
    response.usage.inputTokens * SETUP_SPEND_LIMITS.inputRateMicrousd;
  const setup = fixture({
    responses: [
      new AnthropicAttemptError('pricing_review_required', {
        pricingReviewRequired: true,
        usage: response.usage,
      }),
    ],
    reconcileBeforeErrorAt: 1,
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'ambiguous');
  assert.equal(result.attempts[0].state, 'unknown');
  assert.equal(result.accounting.status, 'unknown');
  const reservation = setup.spend.reservation();
  assert.equal(
    reservation.attempts[0].actualCostMicrousd,
    expectedCostMicrousd,
  );
  assert.equal(
    reservation.attempts[0].unknownExposureMicrousd,
    expectedCostMicrousd,
  );
  assert.equal(setup.spend.pricingReviewRequired(), true);
  assert.equal(setup.reports.state().activeJob, null);
});

test('definitive primary HTTP refusal records zero cost and releases remaining exposure', async () => {
  const setup = fixture({
    responses: [new AnthropicRefusalError('analysis_provider_rate_limited')],
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.terminal.errorCode, 'analysis_provider_rate_limited');
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['settled', 'released'],
  );
  assert.equal(result.attempts[0].terminalClass, 'provider-refusal');
  assert.equal(result.attempts[0].costMicrousd, 0);
  assert.equal(setup.spend.reservation(), null);

  await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(setup.metrics.messages(), 1);
});

test('definitive corrective HTTP refusal settles both known attempts without replay', async () => {
  const setup = fixture({
    responses: [
      primaryResponse({ invalid: true }),
      new AnthropicRefusalError('analysis_provider_unavailable'),
    ],
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.terminal.errorCode, 'analysis_provider_unavailable');
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['settled', 'settled'],
  );
  assert.equal(result.attempts[1].terminalClass, 'provider-refusal');
  assert.equal(result.attempts[1].costMicrousd, 0);
  assert.equal(setup.spend.reservation(), null);
  assert.equal(setup.metrics.messages(), 2);
});

test('unpriceable corrective response settles primary and requires pricing review', async () => {
  const setup = fixture({
    responses: [
      primaryResponse({ invalid: true }),
      new AnthropicAttemptError('pricing_review_required', {
        pricingReviewRequired: true,
        usage: { inputTokens: 456, outputTokens: 7 },
      }),
    ],
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'ambiguous');
  assert.equal(result.terminal.errorCode, 'pricing_review_required');
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['settled', 'unknown'],
  );
  assert.equal(setup.spend.pricingReviewRequired(), true);
  assert.equal(setup.metrics.messages(), 2);
});

test('returned corrective usage above its reservation requires pricing review', async () => {
  const response = overReservationResponse();
  const expectedCostMicrousd =
    response.usage.inputTokens * SETUP_SPEND_LIMITS.inputRateMicrousd;
  const setup = fixture({
    responses: [primaryResponse({ invalid: true }), response],
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'ambiguous');
  assert.equal(result.terminal.errorCode, 'pricing_review_required');
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['settled', 'unknown'],
  );
  const reservation = setup.spend.reservation();
  assert.equal(
    reservation.attempts[1].actualCostMicrousd,
    expectedCostMicrousd,
  );
  assert.equal(
    reservation.attempts[1].unknownExposureMicrousd,
    expectedCostMicrousd,
  );
  assert.equal(setup.spend.pricingReviewRequired(), true);
  assert.equal(setup.metrics.messages(), 2);
});

test('authorization revocation before correction releases its unused reservation', async () => {
  const setup = fixture({
    responses: [primaryResponse({ invalid: true })],
    revokeBeforeCorrection: true,
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.terminal.errorCode, 'source_authorization_required');
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['settled', 'released'],
  );
  assert.equal(setup.metrics.messages(), 1);
  assert.equal(setup.spend.reservation(), null);
});

test('a pricing gate raised by another reserved job blocks the corrective paid boundary', async () => {
  const setup = fixture({
    responses: [primaryResponse({ invalid: true })],
    pricingReviewAfterCount: 2,
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.terminal.errorCode, 'analysis_unavailable');
  assert.equal(setup.metrics.messages(), 1);
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['settled', 'released'],
  );
});

test('corrective CAS ownership expiring before dispatch never reaches the provider', async () => {
  const setup = fixture({
    responses: [primaryResponse({ invalid: true })],
    correctiveStartAdvance: 300_000,
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'ambiguous');
  assert.deepEqual(
    result.attempts.map(({ state }) => state),
    ['settled', 'unknown'],
  );
  assert.equal(setup.metrics.messages(), 1);
});

test('authorization revocation before immutable write preserves the saved report', async () => {
  const oldReportId = hash('a');
  const current = {
    reportId: oldReportId,
    versionKey: `owners/99961/repositories/17/versions/${oldReportId}`,
    generatedAt: '2026-09-18T04:00:00.000Z',
    sourceFingerprint: hash('b'),
  };
  const priorEnvelope = {
    reportId: oldReportId,
    report: {
      issues: [],
      lanes: [],
      startNow: [],
      contention: {},
      notes: {},
    },
  };
  const setup = fixture({
    operation: 'refresh',
    current,
    priorEnvelope,
    revokeBeforeWrite: true,
  });
  const result = await setup.worker.run({
    jobId: setup.job.jobId,
    capability,
    budget,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.terminal.errorCode, 'source_authorization_required');
  assert.equal(setup.reports.state().current.reportId, oldReportId);
  assert.equal(
    setup.reports.versions.has(result.publication.versionKey),
    false,
  );
});

function reconciliationSetup(job, time) {
  const jobs = jobService(job);
  const reports = reportService(job);
  const spend = spendService(job);
  const reconciler = createAnalysisReconciler({
    jobs,
    reports,
    spend,
    now: time.now,
    versionDigest: (envelope) => envelope.digest,
  });
  return { jobs, reports, spend, reconciler };
}

function collectingJob(time) {
  const job = dispatchableJob({ now: time.now() });
  return transitionJob(job, {
    type: 'free-lease-claimed',
    at: new Date(time.now()).toISOString(),
    phase: 'collecting',
    tokenHash: hash('2'),
    expiresAt: new Date(time.now() + 90_000).toISOString(),
  });
}

function primaryInFlightJob(time) {
  let job = collectingJob(time);
  job = transitionJob(job, {
    type: 'free-lease-claimed',
    at: new Date(time.now()).toISOString(),
    phase: 'counting',
    tokenHash: hash('2'),
    expiresAt: new Date(time.now() + 60_000).toISOString(),
  });
  return transitionJob(job, {
    type: 'primary-started',
    at: new Date(time.now()).toISOString(),
    freeTokenHash: hash('2'),
    attemptTokenHash: hash('3'),
    deadlineAt: new Date(time.now() + 300_000).toISOString(),
    sourceFingerprint: hash('d'),
  });
}

function versionWrittenJob(time, { confirm = true } = {}) {
  let job = primaryInFlightJob(time);
  job = transitionJob(job, {
    type: 'response-completed',
    at: new Date(time.now() + 1).toISOString(),
    number: 1,
    attemptTokenHash: hash('3'),
    deadlineAt: new Date(time.now() + 90_000).toISOString(),
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
  job = transitionJob(job, {
    type: 'finalization-claimed',
    at: new Date(time.now() + 2).toISOString(),
    number: 1,
    attemptTokenHash: hash('3'),
    finalizationTokenHash: hash('4'),
    expiresAt: new Date(time.now() + 90_000).toISOString(),
  });
  job = transitionJob(job, {
    type: 'candidate-staged',
    at: new Date(time.now() + 3).toISOString(),
    number: 1,
    attemptTokenHash: hash('3'),
    finalizationTokenHash: hash('4'),
    candidateDigest: hash('e'),
  });
  if (!confirm) return job;
  return transitionJob(job, {
    type: 'version-confirmed',
    at: new Date(time.now() + 4).toISOString(),
    number: 1,
    attemptTokenHash: hash('3'),
    finalizationTokenHash: hash('4'),
    candidateDigest: hash('e'),
    deadlineAt: new Date(time.now() + 90_000).toISOString(),
  });
}

function primaryRefusalRecordedJob(time) {
  const job = primaryInFlightJob(time);
  return transitionJob(job, {
    type: 'response-completed',
    at: new Date(time.now()).toISOString(),
    number: 1,
    attemptTokenHash: hash('3'),
    deadlineAt: new Date(time.now() + 90_000).toISOString(),
    usage: {
      terminalClass: 'provider-refusal',
      terminalStopReason: 'analysis_provider_rate_limited',
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
      costMicrousd: 0,
    },
  });
}

function primaryPricingReviewTerminalJob(time) {
  const job = primaryInFlightJob(time);
  return transitionJob(job, {
    type: 'terminated',
    at: new Date(time.now()).toISOString(),
    status: 'ambiguous',
    errorCode: 'pricing_review_required',
    attemptTokenHash: hash('3'),
    finalizationTokenHash: null,
    freeTokenHash: null,
    recovery: false,
  });
}

test('expired paid work reconciles to one ambiguous attempt without provider access', async () => {
  const time = clock();
  const job = primaryInFlightJob(time);
  const setup = reconciliationSetup(job, time);
  time.advance(300_000);
  const swept = await setup.reconciler.reconcile({
    ownerId: 99961,
    budget,
  });
  const [result] = swept;
  assert.equal(swept.length, 1);
  assert.equal(result.value.state, 'ambiguous');
  assert.equal(result.value.attempts[0].state, 'unknown');
  assert.equal(setup.spend.reservation().attempts[0].state, 'unknown');
  assert.equal(setup.reports.state().activeJob, null);
});

test('reconciliation preserves a recorded zero-cost refusal after worker interruption', async () => {
  const time = clock();
  const job = primaryRefusalRecordedJob(time);
  const setup = reconciliationSetup(job, time);
  time.advance(90_000);
  const result = await setup.reconciler.reconcile({
    ownerId: 99961,
    jobId: job.jobId,
    budget,
  });
  assert.equal(result.value.state, 'failed');
  assert.equal(
    result.value.terminal.errorCode,
    'analysis_provider_rate_limited',
  );
  assert.deepEqual(
    result.value.attempts.map(({ state }) => state),
    ['settled', 'released'],
  );
  assert.equal(result.value.attempts[0].costMicrousd, 0);
  assert.equal(setup.spend.reservation(), null);
});

test('reconciliation conservatively prices an interrupted unpriceable terminal result', async () => {
  const time = clock();
  const job = primaryPricingReviewTerminalJob(time);
  const setup = reconciliationSetup(job, time);
  const result = await setup.reconciler.reconcile({
    ownerId: 99961,
    jobId: job.jobId,
    budget,
  });
  assert.equal(result.value.state, 'ambiguous');
  assert.equal(result.value.accounting.status, 'unknown');
  assert.equal(setup.spend.pricingReviewRequired(), true);
  const reservation = setup.spend.reservation();
  assert.equal(
    reservation.attempts[0].actualCostMicrousd,
    job.attempts[0].reservationMicrousd,
  );
  assert.equal(
    reservation.attempts[0].unknownExposureMicrousd,
    job.attempts[0].reservationMicrousd,
  );
});

test('version-written and published bookkeeping resume without reconstructing analysis', async () => {
  const time = clock();
  const job = versionWrittenJob(time);
  const setup = reconciliationSetup(job, time);
  setup.reports.versions.set(job.publication.versionKey, {
    jobId: job.jobId,
    reportId: job.publication.reportId,
    generatedAt: new Date(time.now()).toISOString(),
    source: { fingerprint: { value: job.sourceFingerprint } },
    digest: hash('e'),
  });
  const result = await setup.reconciler.reconcile({
    ownerId: 99961,
    jobId: job.jobId,
    budget,
  });
  assert.equal(result.value.state, 'succeeded');
  assert.equal(
    setup.reports.state().current.reportId,
    job.publication.reportId,
  );
  assert.equal(setup.spend.reservation(), null);
});

test('expired finalization confirms an exact immutable version and resumes publication', async () => {
  const time = clock();
  const job = versionWrittenJob(time, { confirm: false });
  const setup = reconciliationSetup(job, time);
  setup.reports.versions.set(job.publication.versionKey, {
    jobId: job.jobId,
    reportId: job.publication.reportId,
    generatedAt: new Date(time.now()).toISOString(),
    source: { fingerprint: { value: job.sourceFingerprint } },
    digest: hash('e'),
  });
  time.advance(90_000);
  const result = await setup.reconciler.reconcile({
    ownerId: 99961,
    jobId: job.jobId,
    budget,
  });
  assert.equal(result.value.state, 'succeeded');
  assert.equal(
    setup.reports.state().current.reportId,
    job.publication.reportId,
  );
});

test('authenticated repository reconciliation resolves a hard-stopped free lease', async () => {
  const time = clock();
  const job = collectingJob(time);
  const setup = reconciliationSetup(job, time);
  time.advance(90_000);
  const result = await setup.reconciler.reconcile({
    ownerId: 99961,
    repositoryId: repository.id,
    budget,
  });
  assert.equal(result.value.state, 'failed');
  assert.equal(setup.jobs.value().state, 'failed');
  assert.equal(setup.jobs.value().terminal.errorCode, 'source_timeout');
  assert.equal(setup.spend.reservation(), null);
  assert.equal(setup.reports.state().activeJob, null);
});

test('global reconciliation cleans a terminal loser without clearing another claim', async () => {
  const time = clock();
  const job = collectingJob(time);
  const setup = reconciliationSetup(job, time);
  const winningClaim = {
    jobId: hash('f'),
    operation: 'generate',
    expectedCurrentReportId: null,
    admittedAt: new Date(time.now()).toISOString(),
  };
  setup.reports.setActiveJob(winningClaim);
  time.advance(90_000);
  const [result] = await setup.reconciler.reconcile({
    ownerId: 99961,
    budget,
  });
  assert.equal(result.value.state, 'failed');
  assert.deepEqual(setup.reports.state().activeJob, winningClaim);
  assert.equal(setup.spend.reservation(), null);
});

test('global reconciliation adopts and releases a stale reservation for a terminal complete job', async () => {
  const time = clock();
  const createdAt = new Date(time.now() - 2).toISOString();
  let job = createAnalysisJob({
    ownerId: 99961,
    repositoryId: repository.id,
    idempotencyKey: '018f0f11-2222-7222-8222-222222222222',
    operation: 'generate',
    authorizationEpoch: 2,
    admissionDeployId: 'deploy-1',
    at: createdAt,
    deadlineAt: new Date(time.now() - 1).toISOString(),
  });
  job = transitionJob(job, {
    type: 'terminated',
    at: new Date(time.now()).toISOString(),
    status: 'failed',
    errorCode: 'analysis_unavailable',
    attemptTokenHash: null,
    finalizationTokenHash: null,
    freeTokenHash: null,
    recovery: true,
  });
  job = transitionJob(job, {
    type: 'accounting-recorded',
    at: new Date(time.now()).toISOString(),
    deadlineAt: null,
    attemptTokenHash: null,
    finalizationTokenHash: null,
    attemptUpdates: [],
    accounting: {
      status: 'complete',
      ledgerRevision: null,
      accountingSequence: null,
      accountingDigest: null,
      transitionId: null,
    },
  });
  const setup = reconciliationSetup(job, time);
  const [result] = await setup.reconciler.reconcile({
    ownerId: 99961,
    budget,
  });
  assert.equal(result.value.accounting.status, 'complete');
  assert.ok(result.value.accounting.ledgerRevision > 0);
  assert.deepEqual(
    result.value.attempts.map(({ state }) => state),
    ['unreserved', 'unreserved'],
  );
  assert.equal(setup.spend.reservation(), null);
  assert.equal(setup.reports.state().activeJob, null);
});
