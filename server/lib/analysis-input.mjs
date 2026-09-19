import { Buffer } from 'node:buffer';
import {
  canonicalStringify,
  compareSourceKeys,
  sourceDigest,
} from './fingerprint.mjs';
import {
  SOURCE_PATH_EXTRACTOR_VERSION,
  classifySourceFileRelevance,
  extractReferencedPaths,
  isKnownCredentialPath,
} from './gather.mjs';
import { SOURCE_LIMITS } from './source-limits.mjs';
import {
  SOURCE_SAFETY_POLICY_V1,
  SourceSafetyError,
  createNoVerbatimCorpus,
  inspectSourceSafety,
} from './source-safety.mjs';
import { BoardError } from './errors.mjs';

export const ANALYSIS_INPUT_WIRE_VERSION = 'analysis-input-v1';
export const ANALYSIS_SELECTION_VERSION = 'analysis-selection-v1';

export const ANALYSIS_INPUT_LIMITS = Object.freeze({
  commentBytes: 64 * 1024,
  totalCommentBytes: 2 * 1024 * 1024,
  fileBytes: SOURCE_LIMITS.fileBytes,
  totalFileBytes: SOURCE_LIMITS.totalFileBytes,
  requestBytes: 8 * 1024 * 1024,
  inputTokens: 100000,
});

/** Input preparation errors contain no provider-bound source text. */
export class AnalysisInputError extends BoardError {
  constructor(code, details = {}) {
    const selected = [
      'analysis_input_too_large',
      'analysis_provider_unavailable',
      'source_incomplete',
    ].includes(code)
      ? code
      : 'source_incomplete';
    super(selected);
    this.name = 'AnalysisInputError';
    this.details = Object.freeze({ ...details });
  }
}

const failIncomplete = () => {
  throw new AnalysisInputError('source_incomplete');
};
const asArray = (value) => {
  if (!Array.isArray(value)) failIncomplete();
  return value;
};
const asObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    failIncomplete();
  return value;
};
const positiveInteger = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) failIncomplete();
  return value;
};
const optionalText = (value) => {
  if (value !== null && typeof value !== 'string') failIncomplete();
  return value;
};
const requiredText = (value) => {
  if (typeof value !== 'string') failIncomplete();
  return value;
};
const numericOrder = (left, right) => left - right;
const orderedById = (values) =>
  [...values].sort((left, right) => numericOrder(left.id, right.id));
const jsonClone = (value) => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) failIncomplete();
    return JSON.parse(serialized);
  } catch (error) {
    if (error instanceof AnalysisInputError) throw error;
    failIncomplete();
  }
};

const deepFreeze = (value, seen = new Set()) => {
  if (value === null || typeof value !== 'object' || seen.has(value))
    return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const walkStrings = (value, visit) => {
  const pending = [value];
  const seen = new Set();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === 'string') {
      visit(next);
      continue;
    }
    if (next === null || typeof next !== 'object') continue;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const child of Object.values(next)) pending.push(child);
  }
};

const assertMandatorySafety = (value) => {
  walkStrings(value, (text) => {
    const result = inspectSourceSafety(text);
    if (!result.safe)
      throw new SourceSafetyError('analysis_sensitive_input', {
        ruleIds: result.matches.map(({ ruleId }) => ruleId),
        count: result.count,
      });
  });
};

const checkedLimits = (overrides) => {
  const limits = { ...ANALYSIS_INPUT_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new AnalysisInputError('source_incomplete', { limit: name });
  }
  if (limits.requestBytes < 1 || limits.inputTokens < 1)
    throw new AnalysisInputError('source_incomplete');
  return Object.freeze(limits);
};

function issueProgress(snapshot, issue) {
  const fromInventory = snapshot.inventory?.issues?.find(
    (candidate) => candidate.number === issue.number,
  );
  if (fromInventory && Object.hasOwn(fromInventory, 'inProgress'))
    return fromInventory.inProgress;
  const pulls = snapshot.pullRequests
    .filter((pull) =>
      pull.closingIssues.some(
        (target) =>
          target.repoId === snapshot.repository.id &&
          target.id === issue.id &&
          target.number === issue.number,
      ),
    )
    .sort((left, right) => numericOrder(left.number, right.number));
  if (pulls.length) return 'PR #' + pulls[0].number;
  const branch = snapshot.branches
    .filter(
      (item) =>
        item.unmerged === true &&
        item.name !== snapshot.repository.defaultBranch &&
        new RegExp('(?:^|[/_.-])' + issue.number + '(?:$|[/_.-])', 'u').test(
          item.name,
        ),
    )
    .sort((left, right) => compareSourceKeys(left.name, right.name))[0];
  if (branch) return branch.name;
  return issue.labels.some((label) => /^in[\s_-]+progress$/iu.test(label.name))
    ? 'the in progress label'
    : null;
}

function normalizeMandatory(snapshot, limitations, priorAnalysis) {
  const repository = asObject(snapshot.repository);
  const issues = [...asArray(snapshot.issues)].sort((left, right) =>
    numericOrder(left.number, right.number),
  );
  const issueCatalog = issues.map((issue) => ({
    id: positiveInteger(issue.id),
    number: positiveInteger(issue.number),
    title: requiredText(issue.title),
    milestoneId:
      issue.milestone === null ? null : positiveInteger(issue.milestone.id),
    inProgress: issueProgress(snapshot, issue),
    createdAt: requiredText(issue.createdAt),
    updatedAt: requiredText(issue.updatedAt),
  }));
  const issueEvidence = issues.map((issue) => ({
    issueId: issue.id,
    body: optionalText(issue.body),
    stateReason: optionalText(issue.stateReason),
    labelIds: orderedById(asArray(issue.labels)).map((label) => label.id),
  }));
  const milestoneCatalog = orderedById(asArray(snapshot.milestones)).map(
    (milestone) => ({
      id: positiveInteger(milestone.id),
      title: requiredText(milestone.title),
      description: optionalText(milestone.description),
      dueOn: optionalText(milestone.dueOn),
    }),
  );
  const labelCatalog = orderedById(asArray(snapshot.labels)).map((label) => ({
    id: positiveInteger(label.id),
    name: requiredText(label.name),
    description: optionalText(label.description),
  }));
  const pullRequests = [...asArray(snapshot.pullRequests)]
    .sort((left, right) => numericOrder(left.number, right.number))
    .map((pull) => ({
      id: positiveInteger(pull.id),
      number: positiveInteger(pull.number),
      title: requiredText(pull.title),
      body: optionalText(pull.body),
      draft: pull.draft,
      base: {
        ref: requiredText(pull.base?.ref),
        repoId: positiveInteger(pull.base?.repoId),
      },
      head: {
        ref: requiredText(pull.head?.ref),
        repoId:
          pull.head?.repoId === null
            ? null
            : positiveInteger(pull.head?.repoId),
      },
      closingTargets: [...asArray(pull.closingIssues)]
        .sort((left, right) =>
          compareSourceKeys(
            left.repoId + ':' + left.id,
            right.repoId + ':' + right.id,
          ),
        )
        .map((target) => ({
          repoId: positiveInteger(target.repoId),
          id: positiveInteger(target.id),
          number: positiveInteger(target.number),
        })),
      updatedAt: requiredText(pull.updatedAt),
    }));
  const branches = [...asArray(snapshot.branches)]
    .sort((left, right) => compareSourceKeys(left.name, right.name))
    .map((branch) => ({
      name: requiredText(branch.name),
      tip: requiredText(branch.tip),
      ahead: branch.ahead,
      behind: branch.behind,
      unmerged: branch.unmerged,
      verification: requiredText(branch.verification),
    }));
  const references = [...asArray(snapshot.references)]
    .sort((left, right) => compareSourceKeys(left.key, right.key))
    .map((reference) => ({
      key: requiredText(reference.key),
      requested: jsonClone(reference.requested),
      verification: requiredText(reference.verification),
      verifiedFactsOrReason:
        reference.verification === 'verified'
          ? jsonClone(reference.facts)
          : requiredText(reference.reason),
    }));
  const repositoryTree = [...asArray(snapshot.tree)]
    .filter((entry) => !isKnownCredentialPath(entry.path))
    .sort((left, right) => compareSourceKeys(left.path, right.path))
    .map((entry) => ({
      path: requiredText(entry.path),
      type: requiredText(entry.type),
      mode: requiredText(entry.mode),
      size: entry.size,
    }));

  const normalized = {
    wireVersion: ANALYSIS_INPUT_WIRE_VERSION,
    repository: {
      id: positiveInteger(repository.id),
      fullName: requiredText(repository.fullName),
      defaultBranch: requiredText(repository.defaultBranch),
      defaultTip: requiredText(repository.defaultTip),
    },
    limitations: [...asArray(limitations)].map(requiredText),
    priorAnalysis: priorAnalysis === null ? null : jsonClone(priorAnalysis),
    issueCatalog,
    milestoneCatalog,
    labelCatalog,
    issueEvidence,
    comments: [],
    pullRequests,
    branches,
    references,
    repositoryTree,
  };
  assertMandatorySafety(normalized);
  return normalized;
}

const omission = (candidate, ruleIds) =>
  Object.freeze({
    kind: candidate.kind,
    ...(candidate.kind === 'comment'
      ? {
          id: candidate.id,
          issueId: candidate.issueId,
          contentHash: candidate.contentHash,
        }
      : {
          path: candidate.path,
          blobId: candidate.blobId,
        }),
    ruleIds: Object.freeze([...new Set(ruleIds)].sort()),
  });

function screenComments(snapshot, issueByNumber, limits) {
  const byIssue = new Map(
    [...issueByNumber.keys()].map((number) => [number, []]),
  );
  const omitted = [];
  const seen = new Set();
  for (const source of asArray(snapshot.comments)) {
    const issue = issueByNumber.get(source.issue);
    if (!issue) failIncomplete();
    const body = requiredText(source.body);
    const candidate = {
      kind: 'comment',
      id: positiveInteger(source.id),
      issueId: issue.id,
      issueNumber: issue.number,
      body,
      updatedAt: requiredText(source.updatedAt),
      contentHash: sourceDigest(body),
      bytes: Buffer.byteLength(body),
    };
    if (seen.has(candidate.id)) failIncomplete();
    seen.add(candidate.id);
    const safety = inspectSourceSafety(body);
    if (!safety.safe) {
      omitted.push(
        omission(
          candidate,
          safety.matches.map(({ ruleId }) => ruleId),
        ),
      );
      continue;
    }
    if (candidate.bytes > limits.commentBytes) {
      omitted.push(omission(candidate, ['optional-comment-item-bytes']));
      continue;
    }
    byIssue.get(issue.number).push(candidate);
  }
  for (const values of byIssue.values())
    values.sort(
      (left, right) =>
        compareSourceKeys(right.updatedAt, left.updatedAt) ||
        numericOrder(left.id, right.id),
    );
  const eligible = [];
  const issueNumbers = [...byIssue.keys()].sort(numericOrder);
  for (let round = 0; ; round += 1) {
    let added = false;
    for (const number of issueNumbers) {
      const candidate = byIssue.get(number)[round];
      if (!candidate) continue;
      eligible.push(candidate);
      added = true;
    }
    if (!added) break;
  }
  const ordered = [];
  let aggregateBytes = 0;
  for (const candidate of eligible) {
    if (aggregateBytes + candidate.bytes > limits.totalCommentBytes) {
      omitted.push(omission(candidate, ['optional-comment-aggregate-bytes']));
      continue;
    }
    aggregateBytes += candidate.bytes;
    ordered.push(candidate);
  }
  return { ordered, omitted };
}

const strictContent = (value) => {
  if (typeof value === 'string') return value;
  if (!(value instanceof Uint8Array)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return null;
  }
};

function screenFiles(snapshot, referencedPaths, treeByPath, limits) {
  const omitted = [];
  const candidates = [];
  const seen = new Set();
  for (const source of asArray(snapshot.files)) {
    const path = requiredText(source.path);
    if (seen.has(path)) failIncomplete();
    seen.add(path);
    const tree = treeByPath.get(path);
    if (!tree || tree.type !== 'blob' || tree.sha !== source.blobId)
      failIncomplete();
    const baseCandidate = {
      kind: 'file',
      path,
      blobId: requiredText(source.blobId),
    };
    if (isKnownCredentialPath(path)) {
      omitted.push(omission(baseCandidate, ['known-credential-path']));
      continue;
    }
    const content = strictContent(source.content);
    if (content === null) {
      omitted.push(omission(baseCandidate, ['optional-file-invalid-utf8']));
      continue;
    }
    if (
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(content)
    ) {
      omitted.push(omission(baseCandidate, ['optional-file-binary']));
      continue;
    }
    const safety = inspectSourceSafety(content);
    if (!safety.safe) {
      omitted.push(
        omission(
          baseCandidate,
          safety.matches.map(({ ruleId }) => ruleId),
        ),
      );
      continue;
    }
    const bytes = Buffer.byteLength(content);
    if (bytes > limits.fileBytes) {
      omitted.push(omission(baseCandidate, ['optional-file-item-bytes']));
      continue;
    }
    const relevance = classifySourceFileRelevance(path, referencedPaths);
    if (relevance === null) {
      omitted.push(omission(baseCandidate, ['optional-file-not-relevant']));
      continue;
    }
    candidates.push({
      ...baseCandidate,
      content,
      bytes,
      relevanceClass: relevance.relevanceClass,
      relevanceRank: relevance.rank,
    });
  }
  candidates.sort(
    (left, right) =>
      left.relevanceRank - right.relevanceRank ||
      compareSourceKeys(left.path, right.path),
  );
  const ordered = [];
  let aggregateBytes = 0;
  for (const candidate of candidates) {
    if (aggregateBytes + candidate.bytes > limits.totalFileBytes) {
      omitted.push(omission(candidate, ['optional-file-aggregate-bytes']));
      continue;
    }
    aggregateBytes += candidate.bytes;
    ordered.push(candidate);
  }
  return { ordered, omitted };
}

function interleave(comments, files) {
  const result = [];
  const length = Math.max(comments.length, files.length);
  for (let index = 0; index < length; index += 1) {
    if (comments[index]) result.push(comments[index]);
    if (files[index]) result.push(files[index]);
  }
  return result;
}

function withCandidates(mandatory, candidates) {
  const comments = [];
  const selectedFiles = new Map();
  for (const candidate of candidates) {
    if (candidate.kind === 'comment')
      comments.push({
        id: candidate.id,
        issueId: candidate.issueId,
        body: candidate.body,
        updatedAt: candidate.updatedAt,
      });
    else selectedFiles.set(candidate.path, candidate.content);
  }
  return {
    ...mandatory,
    comments,
    repositoryTree: mandatory.repositoryTree.map((entry) =>
      selectedFiles.has(entry.path)
        ? { ...entry, selectedContent: selectedFiles.get(entry.path) }
        : entry,
    ),
  };
}

function requestPair(input, requestFactory) {
  deepFreeze(input);
  const message = Object.freeze({
    role: 'user',
    content: JSON.stringify(input),
  });
  let pair;
  try {
    pair = requestFactory(message);
  } catch {
    throw new AnalysisInputError('analysis_provider_unavailable');
  }
  let countJson;
  let messageJson;
  try {
    if (
      pair === null ||
      typeof pair !== 'object' ||
      pair.countRequest === null ||
      typeof pair.countRequest !== 'object' ||
      pair.messageRequest === null ||
      typeof pair.messageRequest !== 'object'
    )
      throw new TypeError();
    countJson = JSON.stringify(pair.countRequest);
    messageJson = JSON.stringify(pair.messageRequest);
  } catch {
    throw new AnalysisInputError('analysis_provider_unavailable');
  }
  if (countJson === undefined || messageJson === undefined)
    throw new AnalysisInputError('analysis_provider_unavailable');
  const countRequest = deepFreeze(JSON.parse(countJson));
  const messageRequest = deepFreeze(JSON.parse(messageJson));
  const expectedMessages = [message];
  if (
    canonicalStringify(countRequest.messages) !==
      canonicalStringify(expectedMessages) ||
    canonicalStringify(messageRequest.messages) !==
      canonicalStringify(expectedMessages)
  )
    throw new AnalysisInputError('analysis_provider_unavailable');
  for (const key of ['model', 'system', 'thinking', 'output_config']) {
    if (
      canonicalStringify(countRequest[key]) !==
      canonicalStringify(messageRequest[key])
    )
      throw new AnalysisInputError('analysis_provider_unavailable');
  }
  return Object.freeze({
    input,
    message,
    countRequest,
    messageRequest,
    countRequestBytes: Buffer.byteLength(countJson),
    messageRequestBytes: Buffer.byteLength(messageJson),
  });
}

const defaultRequestFactory = (message) => ({
  countRequest: { messages: [message] },
  messageRequest: { messages: [message] },
});

const withinRequestBound = (pair, limit) =>
  pair.countRequestBytes <= limit && pair.messageRequestBytes <= limit;

const countValue = (value) => {
  const count =
    Number.isSafeInteger(value) && value >= 0
      ? value
      : (value?.inputTokens ?? value?.input_tokens);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new AnalysisInputError('analysis_provider_unavailable');
  return count;
};

async function invokeCountClient(countClient, request) {
  try {
    const response =
      typeof countClient === 'function'
        ? await countClient(request)
        : await countClient.countTokens(request);
    return countValue(response);
  } catch (error) {
    if (error instanceof AnalysisInputError) throw error;
    throw new AnalysisInputError('analysis_provider_unavailable');
  }
}

const safeOmissionForSelection = (candidate, ruleId) =>
  omission(candidate, [ruleId]);

const compareOmissions = (left, right) =>
  compareSourceKeys(left.kind, right.kind) ||
  (left.kind === 'comment'
    ? numericOrder(left.id, right.id)
    : compareSourceKeys(left.path, right.path));

const selectedComment = (candidate) =>
  Object.freeze({
    id: candidate.id,
    issueId: candidate.issueId,
    bodyHash: candidate.contentHash,
  });
const selectedFile = (candidate) =>
  Object.freeze({
    path: candidate.path,
    blobId: candidate.blobId,
    relevanceClass: candidate.relevanceClass,
  });

const stringsFrom = (value) => {
  const result = [];
  walkStrings(value, (text) => result.push(text));
  return result;
};

function noVerbatimValues(snapshot, input, selectedCandidates) {
  const values = [];
  for (const issue of snapshot.issues) {
    if (typeof issue.body === 'string') values.push(issue.body);
  }
  for (const pull of snapshot.pullRequests) {
    if (typeof pull.body === 'string') values.push(pull.body);
  }
  for (const milestone of snapshot.milestones) {
    if (typeof milestone.description === 'string')
      values.push(milestone.description);
  }
  for (const label of snapshot.labels) {
    if (typeof label.description === 'string') values.push(label.description);
  }
  for (const reference of input.references) {
    values.push(...stringsFrom(reference.requested));
    values.push(...stringsFrom(reference.verifiedFactsOrReason));
  }
  for (const candidate of selectedCandidates)
    values.push(
      candidate.kind === 'comment' ? candidate.body : candidate.content,
    );
  return values;
}

/**
 * Build a normalized single-message analysis input and its exact selection
 * manifest. Raw optional text remains only in the returned transient request
 * pair and opaque no-verbatim corpus.
 */
export async function prepareAnalysisInput({
  sourceSnapshot,
  limitations = [],
  priorAnalysis = null,
  countClient,
  requestFactory = defaultRequestFactory,
  limits: limitOverrides,
}) {
  asObject(sourceSnapshot);
  if (
    typeof requestFactory !== 'function' ||
    !(
      typeof countClient === 'function' ||
      (countClient !== null && typeof countClient?.countTokens === 'function')
    )
  )
    throw new AnalysisInputError('analysis_provider_unavailable');
  const limits = checkedLimits(limitOverrides);
  const mandatory = normalizeMandatory(
    sourceSnapshot,
    limitations,
    priorAnalysis,
  );
  const issues = [...sourceSnapshot.issues].sort((left, right) =>
    numericOrder(left.number, right.number),
  );
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  if (issueByNumber.size !== issues.length) failIncomplete();
  const comments = screenComments(sourceSnapshot, issueByNumber, limits);
  const referencedPaths = extractReferencedPaths([
    ...issues,
    ...comments.ordered.map((comment) => ({ body: comment.body, title: '' })),
  ]);
  const treeByPath = new Map(
    sourceSnapshot.tree.map((entry) => [entry.path, entry]),
  );
  if (treeByPath.size !== sourceSnapshot.tree.length) failIncomplete();
  const files = screenFiles(
    sourceSnapshot,
    referencedPaths,
    treeByPath,
    limits,
  );
  const candidates = interleave(comments.ordered, files.ordered);
  const built = new Map();
  const buildAt = (length) => {
    if (!built.has(length))
      built.set(
        length,
        requestPair(
          withCandidates(mandatory, candidates.slice(0, length)),
          requestFactory,
        ),
      );
    return built.get(length);
  };

  const mandatoryPair = buildAt(0);
  if (!withinRequestBound(mandatoryPair, limits.requestBytes))
    throw new AnalysisInputError('analysis_input_too_large', {
      ruleId: 'mandatory-request-bytes',
    });

  let bytePrefix = candidates.length;
  if (!withinRequestBound(buildAt(bytePrefix), limits.requestBytes)) {
    let low = 0;
    let high = bytePrefix;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (withinRequestBound(buildAt(middle), limits.requestBytes))
        low = middle;
      else high = middle - 1;
    }
    bytePrefix = low;
  }

  const countAttempts = [];
  const countAt = async (length) => {
    const pair = buildAt(length);
    const inputTokens = await invokeCountClient(countClient, pair.countRequest);
    countAttempts.push(
      Object.freeze({
        prefixLength: length,
        inputTokens,
        countRequestBytes: pair.countRequestBytes,
        messageRequestBytes: pair.messageRequestBytes,
      }),
    );
    return inputTokens;
  };
  const mandatoryTokens = await countAt(0);
  if (mandatoryTokens > limits.inputTokens)
    throw new AnalysisInputError('analysis_input_too_large', {
      ruleId: 'mandatory-input-tokens',
    });
  let selectedLength = bytePrefix;
  if (selectedLength > 0) {
    let tokens = await countAt(selectedLength);
    while (tokens > limits.inputTokens) {
      selectedLength = Math.floor(selectedLength / 2);
      if (selectedLength === 0) {
        tokens = mandatoryTokens;
        break;
      }
      tokens = await countAt(selectedLength);
    }
  }

  const finalCandidates = candidates.slice(0, selectedLength);
  const finalPair = buildAt(selectedLength);
  const selectionOmissions = [];
  for (let index = selectedLength; index < candidates.length; index += 1)
    selectionOmissions.push(
      safeOmissionForSelection(
        candidates[index],
        index >= bytePrefix
          ? 'optional-request-bytes'
          : 'optional-input-tokens',
      ),
    );
  for (const entry of sourceSnapshot.filePolicy?.omitted ?? [])
    selectionOmissions.push(
      Object.freeze({
        kind: 'file',
        path: requiredText(entry.path),
        blobId: requiredText(entry.blobId),
        ruleIds: Object.freeze(['collector-' + requiredText(entry.reason)]),
      }),
    );
  const omissions = Object.freeze(
    [...comments.omitted, ...files.omitted, ...selectionOmissions].sort(
      compareOmissions,
    ),
  );
  const selectedComments = Object.freeze(
    finalCandidates
      .filter(({ kind }) => kind === 'comment')
      .map(selectedComment),
  );
  const selectedFiles = Object.freeze(
    finalCandidates.filter(({ kind }) => kind === 'file').map(selectedFile),
  );
  const limited = omissions.length > 0;
  const selectionLimitations = Object.freeze(
    [...new Set(omissions.flatMap(({ ruleIds }) => ruleIds))].sort(),
  );
  const manifest = Object.freeze({
    version: ANALYSIS_SELECTION_VERSION,
    wireVersion: ANALYSIS_INPUT_WIRE_VERSION,
    sourceSafetyPolicyVersion: SOURCE_SAFETY_POLICY_V1.version,
    sourcePathExtractorVersion: SOURCE_PATH_EXTRACTOR_VERSION,
    mandatoryManifestHash: sourceDigest(mandatory),
    selectedComments,
    selectedFiles,
    omissions,
    selectedCounts: Object.freeze({
      comments: selectedComments.length,
      files: selectedFiles.length,
      total: finalCandidates.length,
    }),
    omittedCounts: Object.freeze({
      comments: omissions.filter(({ kind }) => kind === 'comment').length,
      files: omissions.filter(({ kind }) => kind === 'file').length,
      total: omissions.length,
    }),
    countAttempts: Object.freeze(countAttempts),
    limits,
    limited,
    limitations: selectionLimitations,
  });
  const noVerbatimCorpus = createNoVerbatimCorpus(
    noVerbatimValues(sourceSnapshot, finalPair.input, finalCandidates),
  );
  return Object.freeze({
    analysisInput: finalPair.input,
    userMessage: finalPair.message,
    countRequest: finalPair.countRequest,
    messageRequest: finalPair.messageRequest,
    analysisSelection: manifest,
    noVerbatimCorpus,
  });
}

/** Keep only continuity fields from a previously validated report. */
export function projectPriorAnalysis(report) {
  if (report === null) return null;
  asObject(report);
  const issueAnalysis = asArray(report.issues).map((issue) => ({
    issue: positiveInteger(issue.number),
    ...(typeof issue.short === 'string' ? { short: issue.short } : {}),
    ...(Array.isArray(issue.waitingOn)
      ? { waitingOn: jsonClone(issue.waitingOn) }
      : {}),
    ...(typeof issue.blockedBecause === 'string'
      ? { blockedBecause: issue.blockedBecause }
      : {}),
    ...(Array.isArray(issue.after) ? { after: jsonClone(issue.after) } : {}),
    ...(Number.isSafeInteger(issue.sameBranchAs)
      ? { sameBranchAs: issue.sameBranchAs }
      : {}),
    ...(typeof issue.uncertaintyReason === 'string'
      ? { uncertaintyReason: issue.uncertaintyReason }
      : {}),
    ...(issue.uncertaintyReference !== undefined
      ? { uncertaintyReference: jsonClone(issue.uncertaintyReference) }
      : {}),
  }));
  const projected = {
    issueAnalysis,
    lanes: jsonClone(report.lanes),
    startNow: jsonClone(report.startNow),
    contention: jsonClone(report.contention),
    notes: jsonClone(report.notes),
  };
  assertMandatorySafety(projected);
  return projected;
}
