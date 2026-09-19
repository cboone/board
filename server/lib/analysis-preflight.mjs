import {
  ANALYSIS_INPUT_LIMITS,
  prepareAnalysisInput,
} from './analysis-input.mjs';
import {
  analysisInputFromCountRequest,
  analysisPriorForSource,
  analysisRequestMetrics,
  buildAnalysisRequestPair,
} from './analysis-request.mjs';
import { createAnalysisPreflightReadiness } from './analysis-preflight-readiness.mjs';
import { ANTHROPIC_POLICY } from './anthropic.mjs';
import { BoardError } from './errors.mjs';
import { readReportEnvelope, readRepositoryState } from './report-store.mjs';
import { projectRepositoryIdentity } from './report-records.mjs';
import { ANALYSIS_DELTA_SCHEMA } from '../../src/domain/analysis-wire.js';

const OWNER_ID = 99961;
const HEX_64 = /^[a-f0-9]{64}$/u;
const OPERATIONS = new Set(['generate', 'refresh']);
const unavailable = () => new BoardError('service_unavailable');
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function sameRepository(left, right) {
  return (
    left.id === right.id &&
    left.fullName === right.fullName &&
    left.name === right.name &&
    left.private === right.private &&
    left.url === right.url
  );
}

function repositoryIdentity(value) {
  return projectRepositoryIdentity({
    id: value?.id,
    fullName: value?.fullName,
    name: value?.name,
    private: value?.private,
    url: value?.url,
  });
}

function requestInput(value) {
  if (
    !exact(value, ['operation', 'expectedCurrentReportId']) ||
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

function boundedSignal(input) {
  input.budget.assertActive?.();
  const remaining = Math.floor(input.budget.remainingMs?.() ?? 0);
  if (!Number.isSafeInteger(remaining) || remaining < 1)
    throw new BoardError('source_timeout');
  const timeout = AbortSignal.timeout(
    Math.max(
      1,
      Math.min(input.budget.limits?.requestMs ?? remaining, remaining),
    ),
  );
  return input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
}

function provider(value) {
  if (
    !exact(value, ['retrieveModel', 'countTokens']) ||
    typeof value.retrieveModel !== 'function' ||
    typeof value.countTokens !== 'function'
  )
    throw unavailable();
  return value;
}

/**
 * Run the explicit, owner-authorized, no-Messages preflight. Raw source and
 * provider-bound request bodies remain local to this call.
 */
export function createAnalysisPreflight({
  reportStorage,
  spendStorage,
  sourceOperations,
  deployId,
  pricingAttestation,
  createProvider,
  prepareInput = prepareAnalysisInput,
  now = Date.now,
}) {
  if (
    typeof reportStorage?.read !== 'function' ||
    typeof spendStorage?.read !== 'function' ||
    typeof spendStorage?.write !== 'function' ||
    typeof sourceOperations?.checkRepository !== 'function' ||
    typeof createProvider !== 'function' ||
    typeof prepareInput !== 'function' ||
    typeof now !== 'function'
  )
    throw unavailable();
  const readiness = createAnalysisPreflightReadiness({
    storage: spendStorage,
    deployId,
    pricingAttestation,
  });

  async function loadState(input, selected, includePrior) {
    const stored = await readRepositoryState({
      storage: reportStorage,
      budget: input.budget,
      repositoryId: selected.id,
    });
    const state = stored?.state ?? null;
    if (state !== null) {
      const identity = repositoryIdentity(state.repository);
      if (!sameRepository(identity, selected)) throw unavailable();
      if (state.activeJob !== null)
        throw new BoardError('analysis_in_progress');
    }
    const currentReportId = state?.current?.reportId ?? null;
    if (currentReportId !== input.request.expectedCurrentReportId)
      throw new BoardError('report_state_changed');
    if (!includePrior || input.request.operation === 'generate') return null;
    const prior = await readReportEnvelope({
      storage: reportStorage,
      budget: input.budget,
      repositoryId: selected.id,
      reportId: input.request.expectedCurrentReportId,
    });
    if (prior === null) throw new BoardError('source_incomplete');
    return prior.envelope;
  }

  async function verify(input) {
    if (
      !input ||
      input.ownerId !== OWNER_ID ||
      !input.budget ||
      typeof input.accessToken !== 'string' ||
      input.accessToken.length < 1 ||
      typeof input.authorize !== 'function'
    )
      throw new BoardError('invalid_request');
    const requested = requestInput(input.request);
    const selected = repositoryIdentity(input.repository);
    if (selected.id !== input.repositoryId)
      throw new BoardError('invalid_request');

    const existing = await readiness.read({ budget: input.budget });
    if (existing !== null) {
      await input.authorize();
      await loadState({ ...input, request: requested }, selected, false);
      await input.authorize();
      return Object.freeze({ marker: existing });
    }

    const prior = await loadState(
      { ...input, request: requested },
      selected,
      true,
    );
    const gathered = await sourceOperations.checkRepository({
      ownerId: input.ownerId,
      repositoryId: selected.id,
      accessToken: input.accessToken,
      signal: input.signal,
      budget: input.budget,
    });
    const gatheredRepository = repositoryIdentity(gathered?.summary?.repo);
    if (!sameRepository(gatheredRepository, selected))
      throw new BoardError('source_unstable');

    await input.authorize();
    const client = provider(await createProvider());
    const metadata = await client.retrieveModel({
      signal: boundedSignal(input),
    });
    await input.authorize();
    if (
      !exact(metadata, ['id', 'maxInputTokens', 'maxTokens']) ||
      metadata.id !== ANTHROPIC_POLICY.model ||
      !Number.isSafeInteger(metadata.maxInputTokens) ||
      metadata.maxInputTokens < ANALYSIS_INPUT_LIMITS.inputTokens ||
      !Number.isSafeInteger(metadata.maxTokens) ||
      metadata.maxTokens < ANTHROPIC_POLICY.maxTokens
    )
      throw new BoardError('analysis_provider_unavailable');

    const prepared = await prepareInput({
      sourceSnapshot: gathered.sourceSnapshot,
      limitations: gathered.summary?.provenance?.limitations,
      priorAnalysis: analysisPriorForSource(prior, gathered.summary?.repo),
      requestFactory: buildAnalysisRequestPair,
      countClient: async (countRequest) => {
        await input.authorize();
        const inputTokens = await client.countTokens({
          analysisInput: analysisInputFromCountRequest(countRequest),
          schema: ANALYSIS_DELTA_SCHEMA,
          signal: boundedSignal(input),
        });
        await input.authorize();
        return inputTokens;
      },
    });
    input.budget.assertActive?.();
    const metrics = analysisRequestMetrics(prepared);
    await input.authorize();
    await loadState({ ...input, request: requested }, selected, false);

    const verifiedAt = new Date(now()).toISOString();
    if (!Number.isFinite(Date.parse(verifiedAt))) throw unavailable();
    const marker = await readiness.write({
      budget: input.budget,
      facts: {
        model: ANTHROPIC_POLICY.model,
        effort: ANTHROPIC_POLICY.effort,
        modelMaxInputTokens: metadata.maxInputTokens,
        modelMaxOutputTokens: metadata.maxTokens,
        configuredInputTokens: ANALYSIS_INPUT_LIMITS.inputTokens,
        configuredOutputTokens: ANTHROPIC_POLICY.maxTokens,
        ...metrics,
        verifiedAt,
      },
    });
    await input.authorize();
    await loadState({ ...input, request: requested }, selected, false);
    await input.authorize();
    return Object.freeze({ marker });
  }

  return Object.freeze({ verify });
}
