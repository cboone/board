import { createHash } from 'node:crypto';
import { BoardError } from './errors.mjs';

const freezePolicy = (value) => {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested))
      freezePolicy(nested);
  }
  return Object.freeze(value);
};

export const SOURCE_SAFETY_POLICY_V1 = freezePolicy({
  version: 'source-safety-v1',
  maximumMatchLength: 4096,
  maximumPlaceholderLength: 128,
  assignmentKeys: [
    'api_key',
    'apikey',
    'access_token',
    'auth_token',
    'client_secret',
    'password',
    'passwd',
    'secret',
    'private_key',
    'authorization',
  ],
  placeholderGrammar: {
    exact: ['example', 'test', 'dummy', 'redacted', 'changeme'],
    repeatedCharacters: ['x', 'X', '*'],
    minimumRepeatedCharacters: 4,
    environmentVariable:
      '(?:\\$[A-Za-z_][A-Za-z0-9_]*|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|%[A-Za-z_][A-Za-z0-9_]*%|process\\.env\\.[A-Za-z_][A-Za-z0-9_]*)',
    angleBracket: '<[A-Za-z][A-Za-z0-9_. -]{0,126}>',
  },
  rules: [
    {
      id: 'pem-private-key-header',
      source:
        '-----BEGIN (?:[A-Z0-9][A-Z0-9 -]{0,63} )?PRIVATE KEY(?: BLOCK)?-----',
      flags: 'giu',
    },
    {
      id: 'github-credential-prefix',
      source:
        '(?:github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{20,255})',
      flags: 'gu',
    },
    {
      id: 'anthropic-credential-prefix',
      source: 'sk-ant-(?:api[0-9]{2}-)?[A-Za-z0-9_-]{16,255}',
      flags: 'gu',
    },
    {
      id: 'openai-credential-prefix',
      source: 'sk-(?!ant-)(?:(?:proj|org|svcacct)-)?[A-Za-z0-9_-]{16,255}',
      flags: 'gu',
    },
    {
      id: 'slack-credential-prefix',
      source: 'xox[baprs]-[A-Za-z0-9-]{10,255}',
      flags: 'gu',
    },
    {
      id: 'aws-access-key-prefix',
      source: '(?:AKIA|ASIA)[A-Z0-9]{16}',
      flags: 'gu',
    },
  ],
  urlAuthority: {
    id: 'url-authority-credential',
    source:
      '[A-Za-z][A-Za-z0-9+.-]{1,15}:\\/\\/([^\\s\\/@:]{1,256}):([^\\s\\/@]{0,2048})@',
    flags: 'gu',
  },
  assignment: {
    id: 'credential-assignment-or-header',
    source:
      '(?:^|[^A-Za-z0-9_])(?:["\']?)(api_key|apikey|access_token|auth_token|client_secret|password|passwd|secret|private_key|authorization)(?:["\']?)\\s*(?::|=)\\s*(?:"([^"\\r\\n]{0,2048})"|\'([^\'\\r\\n]{0,2048})\'|(\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|[^,;)\\]}&\\r\\n]{0,2048}))',
    flags: 'gimu',
  },
});

export const NO_VERBATIM_POLICY_V1 = freezePolicy({
  version: 'no-verbatim-v1',
  runtime: 'node-24.13.0',
  unicodeVersion: '16.0',
  minimumSourceLineCodePoints: 32,
  sourceWindowCodePoints: 64,
  rules: {
    exactField: 'no-verbatim-exact-field',
    sourceLine: 'no-verbatim-source-line',
    sourceWindow: 'no-verbatim-source-window',
    outputSafety: 'no-verbatim-output-safety',
  },
});

/** This error intentionally carries only fixed text, rule IDs, and counts. */
export class SourceSafetyError extends BoardError {
  constructor(code, { ruleIds = [], count = 0 } = {}) {
    const selected = [
      'analysis_sensitive_input',
      'analysis_output_invalid',
    ].includes(code)
      ? code
      : 'analysis_output_invalid';
    super(selected);
    this.name = 'SourceSafetyError';
    this.details = Object.freeze({
      ruleIds: Object.freeze([...new Set(ruleIds)].sort()),
      count: Number.isSafeInteger(count) && count >= 0 ? count : 0,
    });
  }
}

const stripValueWrapper = (value) => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'"))
      return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

export function isDocumentedPlaceholder(value) {
  if (typeof value !== 'string') return false;
  const candidate = stripValueWrapper(value).replace(
    /^(?:bearer|basic|token)\s+/iu,
    '',
  );
  if (candidate === '') return true;
  const lower = candidate.toLowerCase();
  if (SOURCE_SAFETY_POLICY_V1.placeholderGrammar.exact.includes(lower))
    return true;
  if (candidate.length > SOURCE_SAFETY_POLICY_V1.maximumPlaceholderLength)
    return false;
  const repeated = new RegExp(
    '^([xX*])\\1{' +
      (SOURCE_SAFETY_POLICY_V1.placeholderGrammar.minimumRepeatedCharacters -
        1) +
      ',' +
      (SOURCE_SAFETY_POLICY_V1.maximumPlaceholderLength - 1) +
      '}$',
    'u',
  );
  if (repeated.test(candidate)) return true;
  if (
    new RegExp(
      '^' +
        SOURCE_SAFETY_POLICY_V1.placeholderGrammar.environmentVariable +
        '$',
      'u',
    ).test(candidate)
  )
    return true;
  return new RegExp(
    '^' + SOURCE_SAFETY_POLICY_V1.placeholderGrammar.angleBracket + '$',
    'u',
  ).test(candidate);
}

const addCount = (counts, ruleId, count = 1) => {
  if (count > 0) counts.set(ruleId, (counts.get(ruleId) ?? 0) + count);
};

const countPattern = (value, descriptor) => {
  const pattern = new RegExp(descriptor.source, descriptor.flags);
  let count = 0;
  for (const match of value.matchAll(pattern))
    count += match.length > 0 ? 1 : 0;
  return count;
};

/** Return only safe policy identifiers and aggregate counts. */
export function inspectSourceSafety(value) {
  if (typeof value !== 'string')
    throw new SourceSafetyError('analysis_sensitive_input');
  const counts = new Map();
  for (const rule of SOURCE_SAFETY_POLICY_V1.rules)
    addCount(counts, rule.id, countPattern(value, rule));

  const urlPattern = new RegExp(
    SOURCE_SAFETY_POLICY_V1.urlAuthority.source,
    SOURCE_SAFETY_POLICY_V1.urlAuthority.flags,
  );
  for (const match of value.matchAll(urlPattern)) {
    if (
      !isDocumentedPlaceholder(match[1]) ||
      !isDocumentedPlaceholder(match[2])
    )
      addCount(counts, SOURCE_SAFETY_POLICY_V1.urlAuthority.id);
  }

  const assignmentPattern = new RegExp(
    SOURCE_SAFETY_POLICY_V1.assignment.source,
    SOURCE_SAFETY_POLICY_V1.assignment.flags,
  );
  for (const match of value.matchAll(assignmentPattern)) {
    const assigned = match[2] ?? match[3] ?? match[4] ?? '';
    if (!isDocumentedPlaceholder(assigned))
      addCount(counts, SOURCE_SAFETY_POLICY_V1.assignment.id);
  }

  const matches = [...counts]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([ruleId, count]) => Object.freeze({ ruleId, count }));
  return Object.freeze({
    safe: matches.length === 0,
    count: matches.reduce((sum, match) => sum + match.count, 0),
    matches: Object.freeze(matches),
  });
}

export function assertSourceSafe(value, { output = false } = {}) {
  const result = inspectSourceSafety(value);
  if (!result.safe)
    throw new SourceSafetyError(
      output ? 'analysis_output_invalid' : 'analysis_sensitive_input',
      {
        ruleIds: result.matches.map(({ ruleId }) => ruleId),
        count: result.count,
      },
    );
  return value;
}

const normalizeLineEndings = (value) =>
  value.replace(/\r\n?/gu, '\n').normalize('NFC').toLowerCase();
const REMAINING_WHITE_SPACE =
  /[\t\v\f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
const ALL_WHITE_SPACE = /[\s\u0085]+/gu;

export function normalizeNoVerbatimLines(value) {
  if (typeof value !== 'string') return [];
  return normalizeLineEndings(value)
    .split('\n')
    .map((line) => line.replace(REMAINING_WHITE_SPACE, ' ').trim());
}

export function normalizeNoVerbatimField(value) {
  if (typeof value !== 'string') return '';
  return normalizeLineEndings(value).replace(ALL_WHITE_SPACE, ' ').trim();
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const codePoints = (value) => [...value];
const ROLLING_BASE = 16777619;

const hashPoints = (points, start, width) => {
  let hash = 0;
  for (let index = start; index < start + width; index += 1)
    hash = (Math.imul(hash, ROLLING_BASE) + points[index].codePointAt(0)) >>> 0;
  return hash;
};

const CORPUS_DATA = new WeakMap();

class NoVerbatimCorpus {
  constructor(values) {
    const fields = values
      .filter((value) => typeof value === 'string')
      .map((value) => ({
        full: normalizeNoVerbatimField(value),
        lines: normalizeNoVerbatimLines(value),
      }));
    const fullFields = new Map();
    const lines = new Map();
    const windowSources = [];
    for (const field of fields) {
      if (field.full) {
        const fullHash = digest(field.full);
        if (!fullFields.has(fullHash)) fullFields.set(fullHash, []);
        fullFields.get(fullHash).push(field.full);
        const points = codePoints(field.full);
        if (points.length >= NO_VERBATIM_POLICY_V1.sourceWindowCodePoints)
          windowSources.push(points);
      }
      for (const line of field.lines) {
        const points = codePoints(line);
        if (points.length < NO_VERBATIM_POLICY_V1.minimumSourceLineCodePoints)
          continue;
        if (!lines.has(points.length)) lines.set(points.length, new Map());
        const byHash = lines.get(points.length);
        const lineHash = hashPoints(points, 0, points.length);
        if (!byHash.has(lineHash)) byHash.set(lineHash, []);
        byHash.get(lineHash).push(points);
      }
    }
    CORPUS_DATA.set(this, { fullFields, lines, windowSources });
    Object.freeze(this);
  }
}

/** The returned corpus is opaque and serializes without raw source text. */
export function createNoVerbatimCorpus(values) {
  if (!Array.isArray(values))
    throw new SourceSafetyError('analysis_output_invalid');
  return new NoVerbatimCorpus(values);
}

const rollingWindowHashes = (points, width) => {
  const result = new Map();
  if (points.length < width) return result;
  let power = 1;
  for (let index = 1; index < width; index += 1)
    power = Math.imul(power, ROLLING_BASE) >>> 0;
  let hash = hashPoints(points, 0, width);
  result.set(hash, [0]);
  for (let index = width; index < points.length; index += 1) {
    hash =
      (hash - Math.imul(points[index - width].codePointAt(0), power)) >>> 0;
    hash = (Math.imul(hash, ROLLING_BASE) + points[index].codePointAt(0)) >>> 0;
    const start = index - width + 1;
    if (!result.has(hash)) result.set(hash, []);
    result.get(hash).push(start);
  }
  return result;
};

const sameWindow = (left, leftStart, right, rightStart, width) => {
  for (let offset = 0; offset < width; offset += 1)
    if (left[leftStart + offset] !== right[rightStart + offset]) return false;
  return true;
};

const failNoVerbatim = (ruleId) => {
  throw new SourceSafetyError('analysis_output_invalid', {
    ruleIds: [ruleId],
    count: 1,
  });
};

/** Validate model-authored prose without exposing a matching span. */
export function assertNoVerbatimOutput(fields, corpus) {
  if (!Array.isArray(fields) || !(corpus instanceof NoVerbatimCorpus))
    throw new SourceSafetyError('analysis_output_invalid');
  const corpusData = CORPUS_DATA.get(corpus);
  const width = NO_VERBATIM_POLICY_V1.sourceWindowCodePoints;
  for (const value of fields) {
    if (typeof value !== 'string')
      throw new SourceSafetyError('analysis_output_invalid');
    const safety = inspectSourceSafety(value);
    if (!safety.safe)
      throw new SourceSafetyError('analysis_output_invalid', {
        ruleIds: [NO_VERBATIM_POLICY_V1.rules.outputSafety],
        count: safety.count,
      });

    const normalized = normalizeNoVerbatimField(value);
    if (normalized) {
      const exact = corpusData.fullFields.get(digest(normalized)) ?? [];
      if (exact.some((candidate) => candidate === normalized))
        failNoVerbatim(NO_VERBATIM_POLICY_V1.rules.exactField);
    }

    for (const line of normalizeNoVerbatimLines(value)) {
      const outputLine = codePoints(line);
      for (const [lineWidth, sourceHashes] of corpusData.lines) {
        if (outputLine.length < lineWidth) continue;
        const outputLineHashes = rollingWindowHashes(outputLine, lineWidth);
        for (const [hash, starts] of outputLineHashes) {
          const sources = sourceHashes.get(hash) ?? [];
          if (
            sources.some((source) =>
              starts.some((start) =>
                sameWindow(source, 0, outputLine, start, lineWidth),
              ),
            )
          )
            failNoVerbatim(NO_VERBATIM_POLICY_V1.rules.sourceLine);
        }
      }
    }

    const outputPoints = codePoints(normalized);
    if (outputPoints.length < width) continue;
    const outputHashes = rollingWindowHashes(outputPoints, width);
    for (const sourcePoints of corpusData.windowSources) {
      let power = 1;
      for (let index = 1; index < width; index += 1)
        power = Math.imul(power, ROLLING_BASE) >>> 0;
      let hash = hashPoints(sourcePoints, 0, width);
      const compare = (sourceStart) => {
        const starts = outputHashes.get(hash) ?? [];
        return starts.some((outputStart) =>
          sameWindow(
            sourcePoints,
            sourceStart,
            outputPoints,
            outputStart,
            width,
          ),
        );
      };
      if (compare(0)) failNoVerbatim(NO_VERBATIM_POLICY_V1.rules.sourceWindow);
      for (let index = width; index < sourcePoints.length; index += 1) {
        hash =
          (hash -
            Math.imul(sourcePoints[index - width].codePointAt(0), power)) >>>
          0;
        hash =
          (Math.imul(hash, ROLLING_BASE) +
            sourcePoints[index].codePointAt(0)) >>>
          0;
        if (compare(index - width + 1))
          failNoVerbatim(NO_VERBATIM_POLICY_V1.rules.sourceWindow);
      }
    }
  }
  return true;
}
