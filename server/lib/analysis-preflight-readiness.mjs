import { createHash } from 'node:crypto';
import { ANALYSIS_INPUT_LIMITS } from './analysis-input.mjs';
import { ANALYSIS_REQUEST_CONTRACT_HASH } from './analysis-request.mjs';
import { ANTHROPIC_POLICY } from './anthropic.mjs';
import { BoardError } from './errors.mjs';
import { canonicalStringify } from './fingerprint.mjs';
import {
  REVIEWED_SETUP_PRICING_ATTESTATION,
  createSetupPolicy,
} from './spend.mjs';

export const ANALYSIS_PREFLIGHT_SCHEMA_VERSION = 1;

const OWNER_ID = 99961;
const HEX_64 = /^[a-f0-9]{64}$/u;
const POLICY_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const unavailable = () => new BoardError('service_unavailable');
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const iso = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));

function binding({ deployId, pricingAttestation }) {
  if (
    typeof deployId !== 'string' ||
    deployId.length < 1 ||
    deployId.length > 128 ||
    /[\r\n\0]/u.test(deployId)
  )
    throw unavailable();
  const { policyId } = createSetupPolicy({
    deployId,
    pricingAttestation:
      pricingAttestation ?? REVIEWED_SETUP_PRICING_ATTESTATION,
  });
  return Object.freeze({
    schemaVersion: ANALYSIS_PREFLIGHT_SCHEMA_VERSION,
    ownerId: OWNER_ID,
    deployId,
    policyId,
    requestContractHash: ANALYSIS_REQUEST_CONTRACT_HASH,
  });
}

function keyFor(value) {
  return `setup/preflight/v1/${createHash('sha256')
    .update(canonicalStringify(value))
    .digest('hex')}`;
}

function projectMarker(value, expected) {
  const keys = [
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
  ];
  if (
    !exact(value, keys) ||
    value.schemaVersion !== expected.schemaVersion ||
    value.ownerId !== expected.ownerId ||
    value.deployId !== expected.deployId ||
    value.policyId !== expected.policyId ||
    value.requestContractHash !== expected.requestContractHash ||
    value.model !== ANTHROPIC_POLICY.model ||
    value.effort !== ANTHROPIC_POLICY.effort ||
    !integer(value.modelMaxInputTokens) ||
    value.modelMaxInputTokens < ANALYSIS_INPUT_LIMITS.inputTokens ||
    !integer(value.modelMaxOutputTokens) ||
    value.modelMaxOutputTokens < ANTHROPIC_POLICY.maxTokens ||
    value.configuredInputTokens !== ANALYSIS_INPUT_LIMITS.inputTokens ||
    value.configuredOutputTokens !== ANTHROPIC_POLICY.maxTokens ||
    !integer(value.inputTokens) ||
    value.inputTokens > value.configuredInputTokens ||
    !integer(value.countRequestBytes) ||
    value.countRequestBytes < 1 ||
    value.countRequestBytes > ANTHROPIC_POLICY.requestBytes ||
    !integer(value.messageRequestBytes) ||
    value.messageRequestBytes < 1 ||
    value.messageRequestBytes > ANTHROPIC_POLICY.requestBytes ||
    !iso(value.verifiedAt) ||
    !POLICY_ID.test(value.policyId) ||
    !HEX_64.test(value.requestContractHash)
  )
    throw unavailable();
  return Object.freeze({ ...value });
}

function marker(expected, facts) {
  return projectMarker(
    {
      ...expected,
      model: facts.model,
      effort: facts.effort,
      modelMaxInputTokens: facts.modelMaxInputTokens,
      modelMaxOutputTokens: facts.modelMaxOutputTokens,
      configuredInputTokens: facts.configuredInputTokens,
      configuredOutputTokens: facts.configuredOutputTokens,
      inputTokens: facts.inputTokens,
      countRequestBytes: facts.countRequestBytes,
      messageRequestBytes: facts.messageRequestBytes,
      verifiedAt: facts.verifiedAt,
    },
    expected,
  );
}

export function analysisPreflightMarkerKey(options) {
  return keyFor(binding(options));
}

/** Strong-read and conditionally create the immutable preflight marker. */
export function createAnalysisPreflightReadiness({
  storage,
  deployId,
  pricingAttestation,
}) {
  if (
    typeof storage?.read !== 'function' ||
    typeof storage?.write !== 'function'
  )
    throw unavailable();
  const expected = binding({ deployId, pricingAttestation });
  const key = keyFor(expected);

  async function read({ budget }) {
    if (!budget) throw unavailable();
    let stored;
    try {
      stored = await storage.read(key, { budget });
    } catch (error) {
      throw error instanceof BoardError ? error : unavailable();
    }
    if (stored === null) return null;
    if (
      !stored ||
      typeof stored.etag !== 'string' ||
      stored.etag.length < 1 ||
      stored.etag.length > 1024
    )
      throw unavailable();
    return projectMarker(stored.value, expected);
  }

  async function requireReady(input) {
    const current = await read(input);
    if (current === null) throw new BoardError('analysis_preflight_required');
    return current;
  }

  async function write({ budget, facts }) {
    if (!budget || !facts || typeof facts !== 'object') throw unavailable();
    const candidate = marker(expected, facts);
    let result;
    try {
      result = await storage.write(
        key,
        candidate,
        { onlyIfNew: true },
        { budget },
      );
    } catch {}
    if (
      result?.modified === true &&
      typeof result.etag === 'string' &&
      result.etag.length > 0 &&
      result.etag.length <= 1024
    )
      return candidate;
    if (result?.modified !== false && result?.modified !== true) {
      const observed = await read({ budget });
      if (observed !== null) return observed;
      throw unavailable();
    }
    return requireReady({ budget });
  }

  return Object.freeze({ binding: expected, read, requireReady, write });
}

export function projectAnalysisReadiness(markerValue) {
  return markerValue === null
    ? Object.freeze({
        ready: false,
        reason: 'analysis_preflight_required',
      })
    : Object.freeze({ ready: true, reason: null });
}
