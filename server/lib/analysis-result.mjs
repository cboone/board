import { BoardError } from './errors.mjs';
import { canonicalStringify, sourceDigest } from './fingerprint.mjs';
import { projectAnalysisJob } from './jobs.mjs';
import {
  REPORT_ANALYSIS_SCHEMA_VERSION,
  REPORT_ASSEMBLER_VERSION,
  REPORT_PROMPT_VERSION,
  SUCCESSFUL_REPORT_VERSION_SCHEMA_VERSION,
  prepareSuccessfulReportVersion,
  projectSuccessfulReportVersion,
} from './report-versions.mjs';
import {
  assertNoVerbatimOutput,
  assertSourceSafe,
  createNoVerbatimCorpus,
} from './source-safety.mjs';
import { SETUP_SPEND_LIMITS } from './spend.mjs';
import { ANTHROPIC_POLICY } from './anthropic.mjs';
import {
  ANALYSIS_WIRE_VERSION,
  assembleAnalysisReport,
  validateAnalysisDelta,
} from '../../src/domain/analysis-wire.js';
import {
  createInitialComparison,
  createReportComparison,
  validateReportComparison,
} from '../../src/domain/report-comparison.js';
import { validateReport } from '../../src/domain/report-contract.js';
import { ANALYSIS_INPUT_WIRE_VERSION } from './analysis-input.mjs';

export const ANALYSIS_RESULT_CLASSIFICATION = 'analysis_output_invalid';

const SUMMARY_KEYS = Object.freeze([
  'status',
  'repo',
  'sync',
  'fingerprint',
  'provenance',
  'counts',
]);
const PROVENANCE_KEYS = Object.freeze([
  'observedFrom',
  'observedTo',
  'consistency',
  'inputs',
  'files',
  'references',
  'limitations',
]);
const ANALYSIS_INPUT_KEYS = Object.freeze([
  'wireVersion',
  'repository',
  'limitations',
  'priorAnalysis',
  'issueCatalog',
  'milestoneCatalog',
  'labelCatalog',
  'issueEvidence',
  'comments',
  'pullRequests',
  'branches',
  'references',
  'repositoryTree',
]);
const ANALYSIS_REPOSITORY_KEYS = Object.freeze([
  'id',
  'fullName',
  'defaultBranch',
  'defaultTip',
]);

const unavailable = () => new BoardError('service_unavailable');
const same = (left, right) =>
  canonicalStringify(left) === canonicalStringify(right);
const plainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function exactKeys(value, keys) {
  if (!plainObject(value)) throw unavailable();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw unavailable();
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw unavailable();
  }
  return value;
}

/** A provider-result rejection with no source or output-derived details. */
export class AnalysisResultValidationError extends BoardError {
  constructor() {
    super(ANALYSIS_RESULT_CLASSIFICATION);
    this.name = 'AnalysisResultValidationError';
    this.classification = ANALYSIS_RESULT_CLASSIFICATION;
  }
}

const invalidResult = () => {
  throw new AnalysisResultValidationError();
};

function referenceProse(reference, result) {
  if (!plainObject(reference)) return;
  if (reference.kind === 'branch' || reference.kind === 'ref') {
    result.push(reference.title);
  } else if (reference.kind === 'url') {
    result.push(reference.label, reference.title);
  }
}

function modelAuthoredPersistedStrings(delta) {
  const result = [delta.summary];
  for (const issue of delta.issueAnalysis) {
    result.push(issue.short, issue.blockedBecause, issue.uncertaintyReason);
    for (const reference of issue.waitingOn) referenceProse(reference, result);
    for (const reference of issue.after) referenceProse(reference, result);
    referenceProse(issue.uncertaintyReference, result);
  }
  for (const lane of delta.lanes)
    result.push(lane.key, lane.name, lane.owns, lane.note);
  for (const pick of delta.startNow) result.push(pick.why, pick.touches);
  result.push(delta.contention.rowLabel);
  for (const claim of delta.contention.claims)
    result.push(claim.name, claim.query);
  for (const value of Object.values(delta.notes)) result.push(value);
  return result;
}

function appendStrings(value, result, seen = new Set()) {
  if (typeof value === 'string') {
    result.push(value);
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) appendStrings(child, result, seen);
}

function noVerbatimCorpusFromInput(analysisInput) {
  const values = [];
  for (const issue of analysisInput.issueEvidence)
    if (typeof issue.body === 'string') values.push(issue.body);
  for (const pull of analysisInput.pullRequests)
    if (typeof pull.body === 'string') values.push(pull.body);
  for (const milestone of analysisInput.milestoneCatalog)
    if (typeof milestone.description === 'string')
      values.push(milestone.description);
  for (const label of analysisInput.labelCatalog)
    if (typeof label.description === 'string') values.push(label.description);
  for (const reference of analysisInput.references) {
    appendStrings(reference.requested, values);
    appendStrings(reference.verifiedFactsOrReason, values);
  }
  for (const comment of analysisInput.comments)
    if (typeof comment.body === 'string') values.push(comment.body);
  for (const entry of analysisInput.repositoryTree)
    if (typeof entry.selectedContent === 'string')
      values.push(entry.selectedContent);
  return createNoVerbatimCorpus(values);
}

function mandatoryInputDigest(analysisInput) {
  const mandatory = structuredClone(analysisInput);
  mandatory.comments = [];
  mandatory.repositoryTree = mandatory.repositoryTree.map((entry) => {
    const projected = { ...entry };
    delete projected.selectedContent;
    return projected;
  });
  return sourceDigest(mandatory);
}

function verifyAnalysisSelection(analysisInput, analysisSelection) {
  if (
    !plainObject(analysisSelection) ||
    analysisSelection.mandatoryManifestHash !==
      mandatoryInputDigest(analysisInput) ||
    !Array.isArray(analysisSelection.selectedComments) ||
    !Array.isArray(analysisSelection.selectedFiles)
  )
    throw unavailable();
  const selectedComments = analysisInput.comments.map((comment) => ({
    id: comment.id,
    issueId: comment.issueId,
    bodyHash: sourceDigest(comment.body),
  }));
  const selectedPaths = analysisInput.repositoryTree
    .filter((entry) => Object.hasOwn(entry, 'selectedContent'))
    .map((entry) => entry.path)
    .sort();
  const manifestedPaths = analysisSelection.selectedFiles
    .map((entry) => entry.path)
    .sort();
  if (
    !same(selectedComments, analysisSelection.selectedComments) ||
    !same(selectedPaths, manifestedPaths)
  )
    throw unavailable();
}

function projectKnownAttempts(job) {
  const count = job.state === 'validating-corrective' ? 2 : 1;
  const attempts = job.attempts.slice(0, count);
  if (
    attempts.some(
      (attempt) =>
        !['response-complete', 'settled'].includes(attempt.state) ||
        attempt.terminalClass === null ||
        attempt.inputTokens === null ||
        attempt.cacheCreationInputTokens === null ||
        attempt.cacheReadInputTokens === null ||
        attempt.outputTokens === null ||
        attempt.costMicrousd === null,
    )
  )
    throw unavailable();
  return attempts.map((attempt) => ({
    number: attempt.number,
    terminalClass: attempt.terminalClass,
    inputTokens: attempt.inputTokens,
    cacheCreationInputTokens: attempt.cacheCreationInputTokens,
    cacheReadInputTokens: attempt.cacheReadInputTokens,
    outputTokens: attempt.outputTokens,
    rates: {
      inputRateMicrousd: SETUP_SPEND_LIMITS.inputRateMicrousd,
      outputRateMicrousd: SETUP_SPEND_LIMITS.outputRateMicrousd,
    },
    inferenceGeo: ANTHROPIC_POLICY.inferenceGeo,
    serviceTier: ANTHROPIC_POLICY.responseServiceTier,
    costMicrousd: attempt.costMicrousd,
  }));
}

function projectTrustedContext({
  analysisInput,
  analysisSelection,
  inventory,
  sourceSummary,
  job,
  generatedAt,
  priorVersion = null,
}) {
  try {
    exactKeys(analysisInput, ANALYSIS_INPUT_KEYS);
    exactKeys(analysisInput.repository, ANALYSIS_REPOSITORY_KEYS);
    exactKeys(sourceSummary, SUMMARY_KEYS);
    exactKeys(sourceSummary.provenance, PROVENANCE_KEYS);
    for (const key of [
      'limitations',
      'issueCatalog',
      'milestoneCatalog',
      'labelCatalog',
      'issueEvidence',
      'comments',
      'pullRequests',
      'branches',
      'references',
      'repositoryTree',
    ])
      if (!Array.isArray(analysisInput[key])) throw unavailable();
    if (
      analysisInput.priorAnalysis !== null &&
      !plainObject(analysisInput.priorAnalysis)
    )
      throw unavailable();
    verifyAnalysisSelection(analysisInput, analysisSelection);
    const projectedJob = projectAnalysisJob(job);
    if (
      !['validating-primary', 'validating-corrective'].includes(
        projectedJob.state,
      ) ||
      analysisInput.wireVersion !== ANALYSIS_INPUT_WIRE_VERSION ||
      sourceSummary.status !== 'complete' ||
      sourceSummary.repo?.id !== projectedJob.repositoryId ||
      analysisInput.repository.id !== projectedJob.repositoryId ||
      analysisInput.repository.fullName !== sourceSummary.repo?.fullName ||
      analysisInput.repository.defaultBranch !== sourceSummary.sync?.branch ||
      analysisInput.repository.defaultTip !== sourceSummary.sync?.commit ||
      inventory?.repo !== sourceSummary.repo?.fullName ||
      !same(inventory?.sync, sourceSummary.sync) ||
      projectedJob.sourceFingerprint !== sourceSummary.fingerprint?.value ||
      projectedJob.publication.basisReportId !==
        projectedJob.expectedCurrentReportId ||
      typeof generatedAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(generatedAt) ||
      !Number.isFinite(Date.parse(generatedAt)) ||
      Date.parse(generatedAt) < Date.parse(projectedJob.updatedAt) ||
      Date.parse(generatedAt) < Date.parse(sourceSummary.sync?.at)
    )
      throw unavailable();

    let basis = null;
    if (projectedJob.operation === 'generate') {
      if (priorVersion !== null || analysisInput.priorAnalysis !== null)
        throw unavailable();
    } else {
      if (priorVersion === null) throw unavailable();
      basis = projectSuccessfulReportVersion(priorVersion);
      if (
        basis.ownerId !== projectedJob.ownerId ||
        basis.repositoryId !== projectedJob.repositoryId ||
        basis.reportId !== projectedJob.expectedCurrentReportId
      )
        throw unavailable();
      const identityMatches = same(
        basis.source.provenance.repository,
        sourceSummary.repo,
      );
      if (identityMatches !== (analysisInput.priorAnalysis !== null))
        throw unavailable();
    }

    const source = {
      fingerprint: structuredClone(sourceSummary.fingerprint),
      sync: structuredClone(sourceSummary.sync),
      counts: structuredClone(sourceSummary.counts),
      provenance: {
        repository: structuredClone(sourceSummary.repo),
        observedFrom: sourceSummary.provenance.observedFrom,
        observedTo: sourceSummary.provenance.observedTo,
        consistency: sourceSummary.provenance.consistency,
        inputs: structuredClone(sourceSummary.provenance.inputs),
        files: structuredClone(sourceSummary.provenance.files),
        references: structuredClone(sourceSummary.provenance.references),
        limitations: structuredClone(sourceSummary.provenance.limitations),
        analysisSelection: structuredClone(analysisSelection),
      },
    };
    const analysis = {
      model: ANTHROPIC_POLICY.model,
      effort: ANTHROPIC_POLICY.effort,
      promptVersion: REPORT_PROMPT_VERSION,
      schemaVersion: REPORT_ANALYSIS_SCHEMA_VERSION,
      wireVersion: ANALYSIS_WIRE_VERSION,
      assemblerVersion: REPORT_ASSEMBLER_VERSION,
      pricingPolicyId: projectedJob.pricePolicyId,
      attempts: projectKnownAttempts(projectedJob),
    };
    return {
      job: projectedJob,
      basis,
      source,
      analysis,
      inventory: structuredClone(inventory),
      generatedAt,
    };
  } catch {
    throw unavailable();
  }
}

/**
 * Convert one decoded provider delta into a fully projected immutable report
 * candidate. Raw source and raw provider output are accepted only through the
 * transient analysis input and opaque no-verbatim corpus.
 */
export function assembleSuccessfulAnalysisResult(input) {
  const context = projectTrustedContext(input);
  const wire = validateAnalysisDelta(input.analysisDelta, input.analysisInput);
  if (!wire.valid) invalidResult();

  try {
    for (const lane of input.analysisDelta.lanes)
      assertSourceSafe(lane.key, { output: true });
    assertNoVerbatimOutput(
      modelAuthoredPersistedStrings(input.analysisDelta),
      noVerbatimCorpusFromInput(input.analysisInput),
    );
  } catch {
    invalidResult();
  }

  const assembled = assembleAnalysisReport(
    input.analysisDelta,
    input.analysisInput,
    context.inventory,
  );
  if (!assembled.valid) invalidResult();
  const reportValidation = validateReport(assembled.report, context.inventory);
  if (!reportValidation.valid) invalidResult();

  const result = {
    reportId: context.job.publication.reportId,
    generatedAt: context.generatedAt,
    source: { fingerprint: context.source.fingerprint },
    report: assembled.report,
  };
  let comparison;
  try {
    comparison =
      context.basis === null
        ? createInitialComparison(result)
        : createReportComparison(context.basis, result);
  } catch {
    invalidResult();
  }
  if (!validateReportComparison(comparison).valid) invalidResult();

  try {
    return prepareSuccessfulReportVersion({
      schemaVersion: SUCCESSFUL_REPORT_VERSION_SCHEMA_VERSION,
      reportId: context.job.publication.reportId,
      jobId: context.job.jobId,
      ownerId: context.job.ownerId,
      repositoryId: context.job.repositoryId,
      generatedAt: context.generatedAt,
      report: assembled.report,
      inventory: context.inventory,
      comparison,
      source: context.source,
      analysis: context.analysis,
    });
  } catch {
    throw unavailable();
  }
}
