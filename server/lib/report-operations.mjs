import { BoardError } from './errors.mjs';
import { createJobStore } from './job-store.mjs';
import {
  beginSourceCheck,
  finishSourceCheck,
  readCatalogPage,
  readCurrentReportEnvelope,
  readOrCreateRepositoryState,
  readRepositoryState,
} from './report-store.mjs';
import { projectRepositoryIdentity } from './report-records.mjs';
import {
  applyCurrentSetupDiscussionDecision,
  ensureSetupSpendLedger,
  readSetupSpendSummary,
} from './spend-store.mjs';

const OWNER_ID = 99961;
const HEX_64 = /^[a-f0-9]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPERATIONS = new Set(['generate', 'refresh']);
const SOURCE_FAILURES = new Set([
  'provider_rate_limited',
  'provider_unavailable',
  'source_authorization_required',
  'source_incomplete',
  'source_limit_exceeded',
  'source_timeout',
  'source_unstable',
]);
const SPEND_REASONS = Object.freeze({
  'discussion-required': 'budget_discussion_required',
  'budget-exhausted': 'budget_exhausted',
  'pricing-review-required': 'pricing_review_required',
  'pricing-expired': 'pricing_review_required',
  stopped: 'analysis_unavailable',
});

export const REPORT_OPERATION_LIMITS = Object.freeze({
  admissionDeadlineMs: 15 * 60 * 1000,
});

const unavailable = () => new BoardError('service_unavailable');
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const storage = (value) =>
  value &&
  typeof value.read === 'function' &&
  typeof value.write === 'function';

function clockTimestamp(now) {
  const value = now();
  const timestamp =
    typeof value === 'number' && Number.isFinite(value)
      ? new Date(value).toISOString()
      : value;
  if (
    typeof timestamp !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  )
    throw unavailable();
  return timestamp;
}

function operationInput(input) {
  if (!input || typeof input !== 'object' || !input.budget)
    throw new BoardError('invalid_request');
  if (input.ownerId !== OWNER_ID) throw new BoardError('forbidden');
  return input;
}

function repositoryId(input) {
  operationInput(input);
  if (!positive(input.repositoryId)) throw new BoardError('invalid_request');
  return input.repositoryId;
}

function pointer(value) {
  if (value === null) return null;
  return {
    reportId: value.reportId,
    generatedAt: value.generatedAt,
    sourceFingerprint: value.sourceFingerprint,
  };
}

function sourceStatus(sourceCheck) {
  return sourceCheck?.status ?? 'ready';
}

function projectSpendMode(summary, sourceCheck = null) {
  if (sourceCheck?.status === 'source-unavailable')
    return {
      available: false,
      mode: 'disabled',
      reason: 'source_unavailable',
    };
  if (
    !summary ||
    !['setup', 'production'].includes(summary.mode) ||
    typeof summary.status !== 'string'
  )
    throw unavailable();
  if (summary.status === 'available')
    return { available: true, mode: summary.mode, reason: null };
  const reason = SPEND_REASONS[summary.status];
  if (!reason) throw unavailable();
  return {
    available: false,
    mode: summary.status === 'stopped' ? 'disabled' : summary.mode,
    reason,
  };
}

const disabledSpendMode = () => ({
  available: false,
  mode: 'disabled',
  reason: 'analysis_unavailable',
});

function safeJobReader(jobStore) {
  return async (claim, ownerId, budget) => {
    if (claim === null) return null;
    try {
      return await jobStore.safeJob({
        jobId: claim.jobId,
        ownerId,
        budget,
      });
    } catch (error) {
      if (error instanceof BoardError && error.code === 'report_not_found')
        throw unavailable();
      throw error;
    }
  };
}

async function safeJobOrNull(readJob, claim, ownerId, budget) {
  try {
    return await readJob(claim, ownerId, budget);
  } catch {
    return null;
  }
}

function persistedSourceSummary(summary, selectedRepositoryId) {
  return {
    status: 'complete',
    repositoryId: selectedRepositoryId,
    fingerprint: summary.fingerprint?.value,
    sync: {
      at: summary.sync?.at,
      branch: summary.sync?.branch,
      commit: summary.sync?.commit,
      openPullRequests: summary.sync?.openPullRequests,
    },
    counts: {
      openIssues: summary.counts?.openIssues,
      openPullRequests: summary.counts?.openPullRequests,
      milestones: summary.counts?.milestones,
      labels: summary.counts?.labels,
      branches: summary.counts?.branches,
      unmergedBranches: summary.counts?.unmergedBranches,
      issueComments: summary.counts?.issueComments,
      treeEntries: summary.counts?.treeEntries,
      selectedFiles: summary.counts?.selectedFiles,
    },
  };
}

function browserSourceSummary(summary, repository) {
  const sync = {
    at: summary.sync?.at,
    branch: summary.sync?.branch,
    commit: summary.sync?.commit,
    openPullRequests: summary.sync?.openPullRequests,
  };
  if (Object.hasOwn(summary.sync ?? {}, 'timeZone'))
    sync.timeZone = summary.sync.timeZone;
  return {
    status: 'complete',
    repo: repository,
    sync,
    fingerprint: {
      algorithm: summary.fingerprint?.algorithm,
      value: summary.fingerprint?.value,
      scope: summary.fingerprint?.scope,
    },
    provenance: {
      observedFrom: summary.provenance?.observedFrom,
      observedTo: summary.provenance?.observedTo,
      consistency: summary.provenance?.consistency,
      inputs: summary.provenance?.inputs?.map(({ name, status }) => ({
        name,
        status,
      })),
      files: summary.provenance?.files?.map(({ path, blobId }) => ({
        path,
        blobId,
      })),
      references: {
        verified: summary.provenance?.references?.verified,
        unverified: summary.provenance?.references?.unverified,
      },
      limitations: summary.provenance?.limitations
        ? [...summary.provenance.limitations]
        : undefined,
    },
    counts: {
      openIssues: summary.counts?.openIssues,
      openPullRequests: summary.counts?.openPullRequests,
      milestones: summary.counts?.milestones,
      labels: summary.counts?.labels,
      branches: summary.counts?.branches,
      unmergedBranches: summary.counts?.unmergedBranches,
      issueComments: summary.counts?.issueComments,
      treeEntries: summary.counts?.treeEntries,
      selectedFiles: summary.counts?.selectedFiles,
    },
  };
}

function admissionRequest(value) {
  if (
    !exact(value, ['idempotencyKey', 'operation', 'expectedCurrentReportId']) ||
    typeof value.idempotencyKey !== 'string' ||
    !UUID.test(value.idempotencyKey) ||
    !OPERATIONS.has(value.operation) ||
    !(
      value.expectedCurrentReportId === null ||
      (typeof value.expectedCurrentReportId === 'string' &&
        HEX_64.test(value.expectedCurrentReportId))
    ) ||
    (value.operation === 'generate' &&
      value.expectedCurrentReportId !== null) ||
    (value.operation === 'refresh' && value.expectedCurrentReportId === null)
  )
    throw new BoardError('invalid_request');
  return value;
}

function admissionFunction(value) {
  if (typeof value === 'function') return value;
  if (value && typeof value.admit === 'function')
    return value.admit.bind(value);
  throw unavailable();
}

function decisionFunction(value) {
  if (typeof value === 'function') return value;
  throw unavailable();
}

/**
 * Coordinate authenticated, browser-safe report operations over the durable
 * stores. Provider input and coordination records never cross this boundary.
 */
export function createReportOperations({
  reportStorage,
  jobStorage,
  spendStorage,
  sourceOperations,
  admission,
  reconcile,
  deployId,
  pricingAttestation,
  applySpendDecision = applyCurrentSetupDiscussionDecision,
  now = Date.now,
  admissionDeadlineMs = REPORT_OPERATION_LIMITS.admissionDeadlineMs,
}) {
  if (
    !storage(reportStorage) ||
    !storage(jobStorage) ||
    !storage(spendStorage) ||
    typeof sourceOperations?.checkRepository !== 'function' ||
    typeof reconcile !== 'function' ||
    typeof deployId !== 'string' ||
    deployId.length < 1 ||
    deployId.length > 128 ||
    /[\r\n\0]/u.test(deployId) ||
    typeof now !== 'function' ||
    !Number.isSafeInteger(admissionDeadlineMs) ||
    admissionDeadlineMs < 1 ||
    admissionDeadlineMs > REPORT_OPERATION_LIMITS.admissionDeadlineMs
  )
    throw unavailable();
  const admit = admissionFunction(admission);
  const decide = decisionFunction(applySpendDecision);
  const jobs = createJobStore({ storage: jobStorage });
  const safeJob = safeJobReader(jobs);
  const spendContext = (budget) => ({
    storage: spendStorage,
    budget,
    deployId,
    ...(pricingAttestation === undefined ? {} : { pricingAttestation }),
  });

  async function listReports(input) {
    operationInput(input);
    const page = await readCatalogPage({
      storage: reportStorage,
      budget: input.budget,
      cursor: input.cursor ?? null,
      at: clockTimestamp(now),
    });
    const items = [];
    for (const item of page.items) {
      items.push({
        repository: item.repository,
        current: pointer(item.current),
        sourceStatus: sourceStatus(item.sourceCheck),
        activeJob: await safeJobOrNull(
          safeJob,
          item.activeJob,
          input.ownerId,
          input.budget,
        ),
      });
    }
    return { items, nextCursor: page.nextCursor };
  }

  async function getReport(input) {
    const selectedRepositoryId = repositoryId(input);
    let reconciliationAvailable = true;
    try {
      await reconcile({
        ownerId: input.ownerId,
        repositoryId: selectedRepositoryId,
        budget: input.budget,
      });
    } catch {
      reconciliationAvailable = false;
    }
    const stateRecord = await readRepositoryState({
      storage: reportStorage,
      budget: input.budget,
      repositoryId: selectedRepositoryId,
    });
    if (stateRecord === null) throw new BoardError('report_not_found');
    if (
      stateRecord.state.current === null &&
      stateRecord.state.previous !== null
    )
      throw unavailable();
    const stored =
      stateRecord.state.current === null
        ? { state: stateRecord.state, envelope: null }
        : await readCurrentReportEnvelope({
            storage: reportStorage,
            budget: input.budget,
            repositoryId: selectedRepositoryId,
            at: clockTimestamp(now),
          });
    let activeJob = null;
    if (reconciliationAvailable) {
      try {
        activeJob = await safeJob(
          stored.state.activeJob,
          input.ownerId,
          input.budget,
        );
      } catch {
        reconciliationAvailable = false;
      }
    }
    let spendMode;
    if (stored.state.sourceCheck?.status === 'source-unavailable') {
      spendMode = projectSpendMode(null, stored.state.sourceCheck);
    } else if (!reconciliationAvailable) {
      spendMode = disabledSpendMode();
    } else {
      try {
        const spendAt = clockTimestamp(now);
        await ensureSetupSpendLedger({
          ...spendContext(input.budget),
          at: spendAt,
        });
        const spend = await readSetupSpendSummary({
          ...spendContext(input.budget),
          at: spendAt,
        });
        spendMode = projectSpendMode(spend);
      } catch {
        spendMode = disabledSpendMode();
      }
    }
    const envelope = stored.envelope;
    return {
      repository: stored.state.repository,
      current: pointer(stored.state.current),
      previous: pointer(stored.state.previous),
      report: envelope?.report ?? null,
      inventory: envelope?.inventory ?? null,
      comparison: envelope?.comparison ?? null,
      source: envelope?.source ?? null,
      analysis: envelope?.analysis ?? null,
      sourceCheck: stored.state.sourceCheck,
      lastAnalysisAttempt: stored.state.lastAnalysisAttempt,
      activeJob,
      spendMode,
    };
  }

  async function getAnalysisAvailability(input) {
    operationInput(input);
    const at = clockTimestamp(now);
    await ensureSetupSpendLedger({
      ...spendContext(input.budget),
      at,
    });
    await reconcile({ ownerId: input.ownerId, budget: input.budget });
    const spend = await readSetupSpendSummary({
      ...spendContext(input.budget),
      at,
    });
    return { spendMode: projectSpendMode(spend) };
  }

  async function pollJob(input) {
    operationInput(input);
    if (typeof input.jobId !== 'string' || !HEX_64.test(input.jobId))
      throw new BoardError('invalid_request');
    await jobs.safeJob({
      jobId: input.jobId,
      ownerId: input.ownerId,
      budget: input.budget,
    });
    await reconcile({
      ownerId: input.ownerId,
      jobId: input.jobId,
      budget: input.budget,
    });
    return {
      job: await jobs.safeJob({
        jobId: input.jobId,
        ownerId: input.ownerId,
        budget: input.budget,
      }),
    };
  }

  async function checkSource(input) {
    const selectedRepositoryId = repositoryId(input);
    if (
      typeof input.accessToken !== 'string' ||
      input.accessToken.length < 1 ||
      !input.signal
    )
      throw new BoardError('invalid_request');
    const startedAt = clockTimestamp(now);
    const existing = await readRepositoryState({
      storage: reportStorage,
      budget: input.budget,
      repositoryId: selectedRepositoryId,
    });
    let sequence = null;
    const startCheck = async (pinnedRepository = null) => {
      if (sequence !== null) throw unavailable();
      if (pinnedRepository !== null) {
        const identity = projectRepositoryIdentity(pinnedRepository);
        if (identity.id !== selectedRepositoryId) throw unavailable();
        await readOrCreateRepositoryState({
          storage: reportStorage,
          budget: input.budget,
          repository: identity,
          refreshIdentity: false,
        });
      }
      const begun = await beginSourceCheck({
        storage: reportStorage,
        budget: input.budget,
        repositoryId: selectedRepositoryId,
        startedAt,
      });
      sequence = begun.state.sourceCheck.sequence;
    };
    if (existing !== null) await startCheck();
    try {
      const result = await sourceOperations.checkRepository({
        ownerId: input.ownerId,
        repositoryId: selectedRepositoryId,
        accessToken: input.accessToken,
        signal: input.signal,
        budget: input.budget,
        ...(sequence === null
          ? { onRepositoryPinned: (value) => startCheck(value) }
          : {}),
      });
      if (!result || typeof result !== 'object' || !result.summary)
        throw unavailable();
      const summaryRepository = projectRepositoryIdentity(result.summary.repo);
      if (summaryRepository.id !== selectedRepositoryId) throw unavailable();
      const responseSummary = browserSourceSummary(
        result.summary,
        summaryRepository,
      );
      const summary = persistedSourceSummary(
        responseSummary,
        selectedRepositoryId,
      );
      if (sequence === null) throw unavailable();
      await finishSourceCheck({
        storage: reportStorage,
        budget: input.budget,
        repositoryId: selectedRepositoryId,
        sequence,
        completedAt: clockTimestamp(now),
        status: 'complete',
        summary,
        repository: summaryRepository,
      });
      return { summary: responseSummary };
    } catch (error) {
      if (sequence !== null && error instanceof BoardError) {
        const unavailableSource = ['forbidden', 'source_unavailable'].includes(
          error.code,
        );
        if (unavailableSource || SOURCE_FAILURES.has(error.code)) {
          try {
            await finishSourceCheck({
              storage: reportStorage,
              budget: input.budget,
              repositoryId: selectedRepositoryId,
              sequence,
              completedAt: clockTimestamp(now),
              status: unavailableSource ? 'source-unavailable' : 'failed',
              errorCode: unavailableSource ? 'source_unavailable' : error.code,
            });
          } catch {
            // A newer source-check sequence or storage failure owns the state.
          }
        }
      }
      if (error instanceof BoardError && error.code === 'forbidden')
        throw new BoardError('source_unavailable');
      throw error;
    }
  }

  async function decideSetupBudget(input) {
    operationInput(input);
    if (!input.decision || typeof input.decision !== 'object')
      throw new BoardError('invalid_request');
    const result = await decide({
      ...spendContext(input.budget),
      ...input.decision,
      at: clockTimestamp(now),
    });
    if (!result || !['updated', 'existing', 'conflict'].includes(result.status))
      throw unavailable();
    return {
      status: result.status,
      spendMode: projectSpendMode(result.spend),
    };
  }

  async function admitJob(input) {
    operationInput(input);
    const request = admissionRequest(input.request);
    if (!positive(input.repository?.id))
      throw new BoardError('invalid_request');
    await reconcile({ ownerId: input.ownerId, budget: input.budget });
    await reconcile({
      ownerId: input.ownerId,
      repositoryId: input.repository.id,
      budget: input.budget,
    });
    const admittedAt = clockTimestamp(now);
    const job = await admit({
      ownerId: input.ownerId,
      authorizationEpoch: input.authorizationEpoch,
      repository: input.repository,
      idempotencyKey: request.idempotencyKey,
      operation: request.operation,
      expectedCurrentReportId: request.expectedCurrentReportId,
      deadlineAt: new Date(
        Date.parse(admittedAt) + admissionDeadlineMs,
      ).toISOString(),
      ...(input.budget.signal ? { signal: input.budget.signal } : {}),
      budget: input.budget,
    });
    return { job };
  }

  return Object.freeze({
    listReports,
    getReport,
    getAnalysisAvailability,
    pollJob,
    checkSource,
    decideSetupBudget,
    admitJob,
  });
}
