import { createHash } from 'node:crypto';
import {
  ANALYSIS_INPUT_LIMITS,
  ANALYSIS_INPUT_WIRE_VERSION,
  ANALYSIS_SELECTION_VERSION,
  projectPriorAnalysis,
} from './analysis-input.mjs';
import {
  ANTHROPIC_POLICY,
  FIXED_BACKLOG_ANALYSIS_POLICY,
  buildCountRequest,
  buildMessageRequest,
} from './anthropic.mjs';
import { BoardError } from './errors.mjs';
import { canonicalStringify } from './fingerprint.mjs';
import { ANALYSIS_DELTA_SCHEMA } from '../../src/domain/analysis-wire.js';

export const ANALYSIS_REQUEST_CONTRACT_VERSION = 'analysis-request-contract-v1';

const contract = Object.freeze({
  version: ANALYSIS_REQUEST_CONTRACT_VERSION,
  inputWireVersion: ANALYSIS_INPUT_WIRE_VERSION,
  selectionVersion: ANALYSIS_SELECTION_VERSION,
  limits: ANALYSIS_INPUT_LIMITS,
  provider: ANTHROPIC_POLICY,
  system: FIXED_BACKLOG_ANALYSIS_POLICY,
  schema: ANALYSIS_DELTA_SCHEMA,
  countEnvelope: buildCountRequest({ contract: true }, ANALYSIS_DELTA_SCHEMA),
  messageEnvelope: buildMessageRequest(
    { contract: true },
    ANALYSIS_DELTA_SCHEMA,
  ),
});

export const ANALYSIS_REQUEST_CONTRACT_HASH = createHash('sha256')
  .update(canonicalStringify(contract))
  .digest('hex');

/** Reuse prior analysis only while the source identity remains exact. */
export function analysisPriorForSource(priorVersion, currentRepository) {
  const priorRepository = priorVersion?.source?.provenance?.repository;
  if (
    priorVersion === null ||
    priorRepository === null ||
    currentRepository === null ||
    typeof priorRepository !== 'object' ||
    typeof currentRepository !== 'object' ||
    priorRepository.id !== currentRepository.id ||
    priorRepository.fullName !== currentRepository.fullName ||
    priorRepository.name !== currentRepository.name ||
    priorRepository.private !== currentRepository.private ||
    priorRepository.url !== currentRepository.url
  )
    return null;
  return projectPriorAnalysis(priorVersion.report);
}

/** Build the exact count and paid Messages envelopes from one user message. */
export function buildAnalysisRequestPair(message, { outputTokens } = {}) {
  if (
    !message ||
    message.role !== 'user' ||
    typeof message.content !== 'string' ||
    outputTokens !== ANTHROPIC_POLICY.maxTokens
  )
    throw new BoardError('analysis_provider_unavailable');
  let analysisInput;
  try {
    analysisInput = JSON.parse(message.content);
  } catch {
    throw new BoardError('analysis_provider_unavailable');
  }
  return Object.freeze({
    countRequest: buildCountRequest(analysisInput, ANALYSIS_DELTA_SCHEMA),
    messageRequest: buildMessageRequest(analysisInput, ANALYSIS_DELTA_SCHEMA),
  });
}

/** Recover the normalized input only from an exact single-message envelope. */
export function analysisInputFromCountRequest(request) {
  try {
    if (
      !request ||
      !Array.isArray(request.messages) ||
      request.messages.length !== 1 ||
      request.messages[0]?.role !== 'user' ||
      typeof request.messages[0].content !== 'string'
    )
      throw new TypeError();
    return JSON.parse(request.messages[0].content);
  } catch {
    throw new BoardError('analysis_provider_unavailable');
  }
}

/** Return only bounded numeric facts about the final selected request pair. */
export function analysisRequestMetrics(prepared) {
  const selected = prepared?.analysisSelection?.selectedCounts?.total;
  const attempt = prepared?.analysisSelection?.countAttempts?.findLast(
    ({ prefixLength }) => prefixLength === selected,
  );
  let countJson;
  let messageJson;
  try {
    countJson = JSON.stringify(prepared.countRequest);
    messageJson = JSON.stringify(prepared.messageRequest);
  } catch {
    throw new BoardError('analysis_provider_unavailable');
  }
  const countRequestBytes = Buffer.byteLength(countJson ?? '', 'utf8');
  const messageRequestBytes = Buffer.byteLength(messageJson ?? '', 'utf8');
  if (
    !Number.isSafeInteger(selected) ||
    selected < 0 ||
    !attempt ||
    !Number.isSafeInteger(attempt.inputTokens) ||
    attempt.inputTokens < 0 ||
    countRequestBytes < 1 ||
    messageRequestBytes < 1 ||
    countRequestBytes > ANTHROPIC_POLICY.requestBytes ||
    messageRequestBytes > ANTHROPIC_POLICY.requestBytes
  )
    throw new BoardError('analysis_provider_unavailable');
  return Object.freeze({
    inputTokens: attempt.inputTokens,
    countRequestBytes,
    messageRequestBytes,
  });
}
