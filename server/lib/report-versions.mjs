import { createHash } from 'node:crypto';
import {
  ANALYSIS_INPUT_LIMITS,
  ANALYSIS_INPUT_WIRE_VERSION,
  ANALYSIS_SELECTION_VERSION,
} from './analysis-input.mjs';
import { ANTHROPIC_POLICY } from './anthropic.mjs';
import { BoardError } from './errors.mjs';
import { canonicalStringify } from './fingerprint.mjs';
import { SOURCE_PATH_EXTRACTOR_VERSION } from './gather.mjs';
import {
  REPORT_STORAGE_LIMITS,
  projectRepositoryIdentity,
} from './report-records.mjs';
import { SOURCE_LIMITS } from './source-limits.mjs';
import { SOURCE_SAFETY_POLICY_V1 } from './source-safety.mjs';
import { SETUP_SPEND_LIMITS } from './spend.mjs';
import { ANALYSIS_WIRE_VERSION } from '../../src/domain/analysis-wire.js';
import { validateReportComparison } from '../../src/domain/report-comparison.js';
import { validateReport } from '../../src/domain/report-contract.js';

export const SUCCESSFUL_REPORT_VERSION_SCHEMA_VERSION = 1;
export const REPORT_ANALYSIS_SCHEMA_VERSION = 1;
export const REPORT_ASSEMBLER_VERSION = 1;
export const REPORT_PROMPT_VERSION = 'backlog-analysis-prompt-v1';
export const SUCCESSFUL_REPORT_VERSION_MAX_BYTES =
  REPORT_STORAGE_LIMITS.reportEnvelopeBytes;

const HEX_40_OR_64 = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const POLICY_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_SLUG = /^[a-z][a-z0-9_-]{0,63}$/u;
const RELEVANCE_CLASSES = new Set(['referenced', 'guidance', 'configuration']);
const INPUT_PROVENANCE = Object.freeze([
  Object.freeze({ name: 'core-inventory', statuses: ['complete'] }),
  Object.freeze({ name: 'issue-comments', statuses: ['complete'] }),
  Object.freeze({ name: 'repository-tree', statuses: ['complete'] }),
  Object.freeze({
    name: 'selected-file-context',
    statuses: ['complete', 'bounded'],
  }),
  Object.freeze({ name: 'references', statuses: ['complete', 'unverified'] }),
  Object.freeze({
    name: 'branch-ancestry',
    statuses: ['complete', 'unverified'],
  }),
]);
const ENVELOPE_STRUCTURE_LIMITS = Object.freeze({
  depth: 32,
  nodes: 300_000,
  arrayLength: SOURCE_LIMITS.comments + SOURCE_LIMITS.treeEntries,
  stringLength: 2_000_000,
});

const fail = () => {
  throw new BoardError('service_unavailable');
};
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const plainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function exact(value, required, optional = []) {
  if (!plainObject(value)) fail();
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
  return value;
}

function inspectPlainJson(value) {
  const pending = [{ value, depth: 0, leaving: false }];
  const active = new Set();
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (current.leaving) {
      active.delete(current.value);
      continue;
    }
    nodes += 1;
    if (
      nodes > ENVELOPE_STRUCTURE_LIMITS.nodes ||
      current.depth > ENVELOPE_STRUCTURE_LIMITS.depth
    )
      fail();
    if (typeof current.value === 'string') {
      if (
        current.value.length > ENVELOPE_STRUCTURE_LIMITS.stringLength ||
        /\p{Cc}/u.test(current.value)
      )
        fail();
      continue;
    }
    if (
      current.value === null ||
      typeof current.value === 'boolean' ||
      (typeof current.value === 'number' && Number.isFinite(current.value))
    )
      continue;
    if (typeof current.value !== 'object' || active.has(current.value)) fail();
    const array = Array.isArray(current.value);
    if (
      array
        ? Object.getPrototypeOf(current.value) !== Array.prototype
        : !plainObject(current.value)
    )
      fail();
    const keys = Reflect.ownKeys(current.value);
    active.add(current.value);
    pending.push({ ...current, leaving: true });
    if (array) {
      if (
        current.value.length > ENVELOPE_STRUCTURE_LIMITS.arrayLength ||
        keys.length !== current.value.length + 1
      )
        fail();
      for (let index = 0; index < current.value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          current.value,
          String(index),
        );
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
          fail();
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    } else {
      for (const key of keys) {
        if (typeof key !== 'string') fail();
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
          fail();
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }
  }
}

function text(value, maximum = 20_000, { empty = false } = {}) {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    (!empty && !/\S/u.test(value)) ||
    /\p{Cc}/u.test(value)
  )
    fail();
  return value;
}

function utcTimestamp(value, { milliseconds = false } = {}) {
  text(value, 40);
  const expression = milliseconds
    ? /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\.(\d{3})Z$/u
    : /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?Z$/u;
  const match = expression.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) fail();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail();
  return value;
}

function safePath(value) {
  text(value, 4096);
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail();
  return value;
}

function boundedArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value;
}

function projectSync(value) {
  exact(
    value,
    ['at', 'branch', 'commit'],
    ['timeZone', 'openPullRequests', 'extra'],
  );
  const result = {
    at: utcTimestamp(value.at),
    branch: text(value.branch, 256),
    commit: value.commit,
  };
  if (
    value.branch
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    !HEX_40_OR_64.test(value.commit)
  )
    fail();
  if (Object.hasOwn(value, 'timeZone'))
    result.timeZone = text(value.timeZone, 128);
  if (Object.hasOwn(value, 'openPullRequests')) {
    if (!integer(value.openPullRequests)) fail();
    result.openPullRequests = value.openPullRequests;
  }
  if (Object.hasOwn(value, 'extra')) {
    result.extra = boundedArray(value.extra, 100).map((entry) =>
      text(entry, 4096),
    );
  }
  return result;
}

function projectAssignees(value) {
  const seen = new Set();
  let previous = 0;
  return boundedArray(value, 100).map((assignee) => {
    exact(assignee, ['id', 'login']);
    if (
      !positive(assignee.id) ||
      assignee.id <= previous ||
      seen.has(assignee.id)
    )
      fail();
    previous = assignee.id;
    seen.add(assignee.id);
    return { id: assignee.id, login: text(assignee.login, 256) };
  });
}

function projectReference(value) {
  if (positive(value)) return value;
  if (!plainObject(value)) fail();
  const kinds = ['pr', 'branch', 'ref', 'url'].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (kinds.length !== 1) fail();
  const kind = kinds[0];
  if (kind === 'url') {
    exact(value, ['url', 'label'], ['title']);
    const result = {
      url: text(value.url, 4096),
      label: text(value.label, 1000),
    };
    if (Object.hasOwn(value, 'title')) result.title = text(value.title);
    return result;
  }
  exact(value, [kind], ['title']);
  const result = {
    [kind]: kind === 'pr' ? value.pr : text(value[kind], 4096),
  };
  if (kind === 'pr' && !positive(value.pr)) fail();
  if (Object.hasOwn(value, 'title')) result.title = text(value.title);
  return result;
}

const ISSUE_REQUIRED = Object.freeze([
  'id',
  'number',
  'title',
  'milestone',
  'createdAt',
  'updatedAt',
  'assignees',
  'inProgress',
]);
const ISSUE_ANALYSIS = Object.freeze([
  'short',
  'waitingOn',
  'blockedBecause',
  'after',
  'sameBranchAs',
  'uncertainty',
]);

function projectIssue(value, { analysis }) {
  exact(value, ISSUE_REQUIRED, analysis ? ISSUE_ANALYSIS : []);
  if (!positive(value.id) || !positive(value.number)) fail();
  const result = {
    id: value.id,
    number: value.number,
    title: text(value.title),
    milestone: value.milestone === null ? null : text(value.milestone),
    createdAt: utcTimestamp(value.createdAt),
    updatedAt: utcTimestamp(value.updatedAt),
    assignees: projectAssignees(value.assignees),
    inProgress: value.inProgress === null ? null : text(value.inProgress, 4096),
  };
  if (!analysis) return result;
  if (Object.hasOwn(value, 'short')) result.short = text(value.short, 240);
  if (Object.hasOwn(value, 'waitingOn'))
    result.waitingOn = boundedArray(value.waitingOn, 100).map(projectReference);
  if (Object.hasOwn(value, 'blockedBecause'))
    result.blockedBecause = text(value.blockedBecause, 8000);
  if (Object.hasOwn(value, 'after'))
    result.after = boundedArray(value.after, 100).map(projectReference);
  if (Object.hasOwn(value, 'sameBranchAs')) {
    if (!positive(value.sameBranchAs)) fail();
    result.sameBranchAs = value.sameBranchAs;
  }
  if (Object.hasOwn(value, 'uncertainty')) {
    exact(value.uncertainty, ['reason'], ['reference']);
    result.uncertainty = { reason: text(value.uncertainty.reason, 8000) };
    if (Object.hasOwn(value.uncertainty, 'reference'))
      result.uncertainty.reference = projectReference(
        value.uncertainty.reference,
      );
  }
  return result;
}

function projectInventory(value) {
  exact(value, ['board', 'title', 'repo', 'sync', 'issues'], ['repoUrl']);
  if (value.board !== 'backlog-triage') fail();
  const result = {
    board: value.board,
    title: text(value.title),
    repo: text(value.repo, 256),
    sync: projectSync(value.sync),
    issues: boundedArray(value.issues, 1000).map((issue) =>
      projectIssue(issue, { analysis: false }),
    ),
  };
  if (Object.hasOwn(value, 'repoUrl'))
    result.repoUrl = text(value.repoUrl, 4096);
  return result;
}

function projectReport(value) {
  exact(
    value,
    [
      'board',
      'title',
      'repo',
      'sync',
      'summary',
      'issues',
      'lanes',
      'startNow',
    ],
    ['repoUrl', 'milestones', 'notes', 'contention'],
  );
  if (value.board !== 'backlog-triage') fail();
  const result = {
    board: value.board,
    title: text(value.title),
    repo: text(value.repo, 256),
    sync: projectSync(value.sync),
    summary: text(value.summary, 20_000),
    issues: boundedArray(value.issues, 1000).map((issue) =>
      projectIssue(issue, { analysis: true }),
    ),
    lanes: boundedArray(value.lanes, 1000).map((lane) => {
      exact(lane, ['key', 'name', 'mode', 'issues'], ['owns', 'note']);
      if (!['serial', 'head', 'any'].includes(lane.mode)) fail();
      const projected = {
        key: text(lane.key, 100),
        name: text(lane.name, 240),
        mode: lane.mode,
        issues: boundedArray(lane.issues, 1000).map((number) => {
          if (!positive(number)) fail();
          return number;
        }),
      };
      if (Object.hasOwn(lane, 'owns')) projected.owns = text(lane.owns, 8000);
      if (Object.hasOwn(lane, 'note')) projected.note = text(lane.note, 8000);
      return projected;
    }),
    startNow: boundedArray(value.startNow, 1000).map((pick) => {
      exact(pick, ['issue', 'why'], ['touches']);
      if (!positive(pick.issue)) fail();
      const projected = { issue: pick.issue, why: text(pick.why, 8000) };
      if (Object.hasOwn(pick, 'touches'))
        projected.touches = text(pick.touches, 8000);
      return projected;
    }),
  };
  if (Object.hasOwn(value, 'repoUrl'))
    result.repoUrl = text(value.repoUrl, 4096);
  if (Object.hasOwn(value, 'milestones'))
    result.milestones = boundedArray(value.milestones, 2000).map(
      (milestone) => {
        exact(milestone, ['title'], ['short']);
        const projected = { title: text(milestone.title) };
        if (Object.hasOwn(milestone, 'short'))
          projected.short = text(milestone.short, 240);
        return projected;
      },
    );
  if (Object.hasOwn(value, 'notes')) {
    exact(value.notes, [], ['startNow', 'blocked', 'contention']);
    if (Object.keys(value.notes).length === 0) fail();
    result.notes = Object.fromEntries(
      ['startNow', 'blocked', 'contention']
        .filter((key) => Object.hasOwn(value.notes, key))
        .map((key) => [key, text(value.notes[key], 8000)]),
    );
  }
  if (Object.hasOwn(value, 'contention')) {
    exact(value.contention, ['claims'], ['rowLabel']);
    result.contention = {
      claims: boundedArray(value.contention.claims, 1000).map((claim) => {
        exact(claim, ['name', 'issues'], ['query']);
        const projected = {
          name: text(claim.name, 240),
          issues: boundedArray(claim.issues, 1000).map((number) => {
            if (!positive(number)) fail();
            return number;
          }),
        };
        if (Object.hasOwn(claim, 'query'))
          projected.query = text(claim.query, 2000);
        return projected;
      }),
    };
    if (Object.hasOwn(value.contention, 'rowLabel'))
      result.contention.rowLabel = text(value.contention.rowLabel, 240);
  }
  return result;
}

function projectFingerprint(value) {
  exact(value, ['algorithm', 'value', 'scope']);
  if (
    value.algorithm !== 'sha256' ||
    !HEX_64.test(value.value) ||
    value.scope !== 'core-and-collected-context'
  )
    fail();
  return {
    algorithm: value.algorithm,
    value: value.value,
    scope: value.scope,
  };
}

function projectCountSet(value) {
  exact(value, ['comments', 'files', 'total']);
  if (
    !integer(value.comments) ||
    !integer(value.files) ||
    !integer(value.total) ||
    value.total !== value.comments + value.files
  )
    fail();
  return { comments: value.comments, files: value.files, total: value.total };
}

function projectRuleIds(value) {
  const result = boundedArray(value, 32).map((ruleId) => {
    text(ruleId, 128);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(ruleId)) fail();
    return ruleId;
  });
  if (
    result.length === 0 ||
    new Set(result).size !== result.length ||
    result.some((ruleId, index) => index > 0 && ruleId <= result[index - 1])
  )
    fail();
  return result;
}

function projectAnalysisSelection(value, provenanceFiles) {
  exact(value, [
    'version',
    'wireVersion',
    'sourceSafetyPolicyVersion',
    'sourcePathExtractorVersion',
    'mandatoryManifestHash',
    'selectedComments',
    'selectedFiles',
    'omissions',
    'selectedCounts',
    'omittedCounts',
    'countAttempts',
    'limits',
    'limited',
    'limitations',
  ]);
  if (
    value.version !== ANALYSIS_SELECTION_VERSION ||
    value.wireVersion !== ANALYSIS_INPUT_WIRE_VERSION ||
    value.sourceSafetyPolicyVersion !== SOURCE_SAFETY_POLICY_V1.version ||
    value.sourcePathExtractorVersion !== SOURCE_PATH_EXTRACTOR_VERSION ||
    !HEX_64.test(value.mandatoryManifestHash)
  )
    fail();
  const selectedComments = boundedArray(
    value.selectedComments,
    SOURCE_LIMITS.comments,
  ).map((entry) => {
    exact(entry, ['id', 'issueId', 'bodyHash']);
    if (
      !positive(entry.id) ||
      !positive(entry.issueId) ||
      !HEX_64.test(entry.bodyHash)
    )
      fail();
    return { id: entry.id, issueId: entry.issueId, bodyHash: entry.bodyHash };
  });
  if (
    new Set(selectedComments.map(({ id }) => id)).size !==
    selectedComments.length
  )
    fail();
  const selectedFiles = boundedArray(
    value.selectedFiles,
    SOURCE_LIMITS.files,
  ).map((entry) => {
    exact(entry, ['path', 'blobId', 'relevanceClass']);
    if (
      !HEX_40_OR_64.test(entry.blobId) ||
      !RELEVANCE_CLASSES.has(entry.relevanceClass)
    )
      fail();
    return {
      path: safePath(entry.path),
      blobId: entry.blobId,
      relevanceClass: entry.relevanceClass,
    };
  });
  if (
    new Set(selectedFiles.map(({ path }) => path)).size !== selectedFiles.length
  )
    fail();
  const omissions = boundedArray(
    value.omissions,
    SOURCE_LIMITS.comments + SOURCE_LIMITS.treeEntries,
  ).map((entry) => {
    if (entry?.kind === 'comment') {
      exact(entry, ['kind', 'id', 'issueId', 'contentHash', 'ruleIds']);
      if (
        !positive(entry.id) ||
        !positive(entry.issueId) ||
        !HEX_64.test(entry.contentHash)
      )
        fail();
      return {
        kind: entry.kind,
        id: entry.id,
        issueId: entry.issueId,
        contentHash: entry.contentHash,
        ruleIds: projectRuleIds(entry.ruleIds),
      };
    }
    if (entry?.kind === 'file') {
      exact(entry, ['kind', 'path', 'blobId', 'ruleIds']);
      if (!HEX_40_OR_64.test(entry.blobId)) fail();
      return {
        kind: entry.kind,
        path: safePath(entry.path),
        blobId: entry.blobId,
        ruleIds: projectRuleIds(entry.ruleIds),
      };
    }
    fail();
  });
  const selectedCounts = projectCountSet(value.selectedCounts);
  const omittedCounts = projectCountSet(value.omittedCounts);
  if (
    selectedCounts.comments !== selectedComments.length ||
    selectedCounts.files !== selectedFiles.length ||
    omittedCounts.comments !==
      omissions.filter(({ kind }) => kind === 'comment').length ||
    omittedCounts.files !==
      omissions.filter(({ kind }) => kind === 'file').length
  )
    fail();
  const omissionKeys = omissions.map((entry) =>
    entry.kind === 'comment' ? `comment:${entry.id}` : `file:${entry.path}`,
  );
  const selectedKeys = new Set([
    ...selectedComments.map(({ id }) => `comment:${id}`),
    ...selectedFiles.map(({ path }) => `file:${path}`),
  ]);
  if (
    new Set(omissionKeys).size !== omissionKeys.length ||
    omissions.some(
      (entry, index) =>
        index > 0 &&
        (entry.kind < omissions[index - 1].kind ||
          (entry.kind === omissions[index - 1].kind &&
            (entry.kind === 'comment'
              ? entry.id <= omissions[index - 1].id
              : entry.path <= omissions[index - 1].path))),
    ) ||
    omissionKeys.some((key) => selectedKeys.has(key))
  )
    fail();
  const countAttempts = boundedArray(value.countAttempts, 64).map((entry) => {
    exact(entry, [
      'prefixLength',
      'inputTokens',
      'countRequestBytes',
      'messageRequestBytes',
    ]);
    if (
      !integer(entry.prefixLength) ||
      !integer(entry.inputTokens) ||
      !positive(entry.countRequestBytes) ||
      !positive(entry.messageRequestBytes)
    )
      fail();
    return { ...entry };
  });
  if (
    countAttempts.length === 0 ||
    countAttempts[0].prefixLength !== 0 ||
    new Set(countAttempts.map(({ prefixLength }) => prefixLength)).size !==
      countAttempts.length
  )
    fail();
  exact(value.limits, Object.keys(ANALYSIS_INPUT_LIMITS));
  const limits = {};
  for (const [key, expected] of Object.entries(ANALYSIS_INPUT_LIMITS)) {
    if (value.limits[key] !== expected) fail();
    limits[key] = expected;
  }
  if (
    countAttempts.some(
      ({ countRequestBytes, messageRequestBytes }) =>
        countRequestBytes > limits.requestBytes ||
        messageRequestBytes > limits.requestBytes,
    ) ||
    countAttempts.at(-1).prefixLength !== selectedCounts.total ||
    countAttempts.at(-1).inputTokens > limits.inputTokens
  )
    fail();
  if (
    typeof value.limited !== 'boolean' ||
    value.limited !== Boolean(omissions.length)
  )
    fail();
  const limitations = boundedArray(value.limitations, 256).map((entry) => {
    text(entry, 128);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(entry)) fail();
    return entry;
  });
  const expectedLimitations = [
    ...new Set(omissions.flatMap(({ ruleIds }) => ruleIds)),
  ].sort();
  if (
    canonicalStringify(limitations) !== canonicalStringify(expectedLimitations)
  )
    fail();
  const sourceFiles = new Set(
    provenanceFiles.map(({ path, blobId }) => `${path}\0${blobId}`),
  );
  if (
    selectedFiles.some(
      ({ path, blobId }) => !sourceFiles.has(`${path}\0${blobId}`),
    )
  )
    fail();
  return {
    version: value.version,
    wireVersion: value.wireVersion,
    sourceSafetyPolicyVersion: value.sourceSafetyPolicyVersion,
    sourcePathExtractorVersion: value.sourcePathExtractorVersion,
    mandatoryManifestHash: value.mandatoryManifestHash,
    selectedComments,
    selectedFiles,
    omissions,
    selectedCounts,
    omittedCounts,
    countAttempts,
    limits,
    limited: value.limited,
    limitations,
  };
}

function projectProvenance(value, repositoryId) {
  exact(value, [
    'repository',
    'observedFrom',
    'observedTo',
    'consistency',
    'inputs',
    'files',
    'references',
    'limitations',
    'analysisSelection',
  ]);
  const repository = projectRepositoryIdentity(value.repository);
  if (repository.id !== repositoryId) fail();
  const observedFrom = utcTimestamp(value.observedFrom, { milliseconds: true });
  const observedTo = utcTimestamp(value.observedTo, { milliseconds: true });
  if (
    Date.parse(observedTo) < Date.parse(observedFrom) ||
    value.consistency !== 'two-pass-matched'
  )
    fail();
  const inputs = boundedArray(value.inputs, INPUT_PROVENANCE.length).map(
    (entry, index) => {
      exact(entry, ['name', 'status']);
      const expected = INPUT_PROVENANCE[index];
      if (
        expected === undefined ||
        entry.name !== expected.name ||
        !expected.statuses.includes(entry.status)
      )
        fail();
      return { name: entry.name, status: entry.status };
    },
  );
  if (inputs.length !== INPUT_PROVENANCE.length) fail();
  const paths = new Set();
  const files = boundedArray(value.files, SOURCE_LIMITS.files).map((entry) => {
    exact(entry, ['path', 'blobId']);
    const path = safePath(entry.path);
    if (paths.has(path) || !HEX_40_OR_64.test(entry.blobId)) fail();
    paths.add(path);
    return { path, blobId: entry.blobId };
  });
  exact(value.references, ['verified', 'unverified']);
  if (
    !integer(value.references.verified) ||
    !integer(value.references.unverified)
  )
    fail();
  const limitations = boundedArray(value.limitations, 256).map((entry) =>
    text(entry, 4096),
  );
  return {
    repository,
    observedFrom,
    observedTo,
    consistency: value.consistency,
    inputs,
    files,
    references: {
      verified: value.references.verified,
      unverified: value.references.unverified,
    },
    limitations,
    analysisSelection: projectAnalysisSelection(value.analysisSelection, files),
  };
}

function projectSource(value, repositoryId, inventory) {
  exact(value, ['fingerprint', 'sync', 'counts', 'provenance']);
  const fingerprint = projectFingerprint(value.fingerprint);
  const sync = projectSync(value.sync);
  if (
    !Object.hasOwn(sync, 'timeZone') ||
    !Object.hasOwn(sync, 'openPullRequests')
  )
    fail();
  exact(value.counts, [
    'openIssues',
    'openPullRequests',
    'milestones',
    'labels',
    'branches',
    'unmergedBranches',
    'issueComments',
    'treeEntries',
    'selectedFiles',
  ]);
  if (Object.values(value.counts).some((count) => !integer(count))) fail();
  const counts = { ...value.counts };
  const provenance = projectProvenance(value.provenance, repositoryId);
  if (
    counts.openIssues !== inventory.issues.length ||
    counts.openPullRequests !== (sync.openPullRequests ?? 0) ||
    counts.selectedFiles !== provenance.files.length ||
    provenance.observedTo !== sync.at ||
    provenance.analysisSelection.selectedCounts.comments >
      counts.issueComments ||
    provenance.analysisSelection.selectedCounts.files > counts.selectedFiles
  )
    fail();
  return { fingerprint, sync, counts, provenance };
}

function checkedCost(inputTokens, outputTokens, rates) {
  const inputCost = inputTokens * rates.inputRateMicrousd;
  const outputCost = outputTokens * rates.outputRateMicrousd;
  if (
    !Number.isSafeInteger(inputCost) ||
    !Number.isSafeInteger(outputCost) ||
    !Number.isSafeInteger(inputCost + outputCost)
  )
    fail();
  return inputCost + outputCost;
}

function projectAnalysis(value) {
  exact(value, [
    'model',
    'effort',
    'promptVersion',
    'schemaVersion',
    'wireVersion',
    'assemblerVersion',
    'pricingPolicyId',
    'attempts',
  ]);
  if (
    value.model !== ANTHROPIC_POLICY.model ||
    value.effort !== ANTHROPIC_POLICY.effort ||
    value.promptVersion !== REPORT_PROMPT_VERSION ||
    value.schemaVersion !== REPORT_ANALYSIS_SCHEMA_VERSION ||
    value.wireVersion !== ANALYSIS_WIRE_VERSION ||
    value.assemblerVersion !== REPORT_ASSEMBLER_VERSION ||
    !POLICY_ID.test(value.pricingPolicyId)
  )
    fail();
  const attempts = boundedArray(value.attempts, 2).map((attempt, index) => {
    exact(attempt, [
      'number',
      'terminalClass',
      'inputTokens',
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
      'outputTokens',
      'rates',
      'inferenceGeo',
      'serviceTier',
      'costMicrousd',
    ]);
    exact(attempt.rates, ['inputRateMicrousd', 'outputRateMicrousd']);
    const rates = {
      inputRateMicrousd: attempt.rates.inputRateMicrousd,
      outputRateMicrousd: attempt.rates.outputRateMicrousd,
    };
    if (
      attempt.number !== index + 1 ||
      !SAFE_SLUG.test(attempt.terminalClass) ||
      !integer(attempt.inputTokens) ||
      attempt.cacheCreationInputTokens !== 0 ||
      attempt.cacheReadInputTokens !== 0 ||
      !integer(attempt.outputTokens) ||
      rates.inputRateMicrousd !== SETUP_SPEND_LIMITS.inputRateMicrousd ||
      rates.outputRateMicrousd !== SETUP_SPEND_LIMITS.outputRateMicrousd ||
      attempt.inferenceGeo !== ANTHROPIC_POLICY.inferenceGeo ||
      attempt.serviceTier !== ANTHROPIC_POLICY.responseServiceTier ||
      attempt.costMicrousd !==
        checkedCost(attempt.inputTokens, attempt.outputTokens, rates)
    )
      fail();
    return {
      number: attempt.number,
      terminalClass: attempt.terminalClass,
      inputTokens: attempt.inputTokens,
      cacheCreationInputTokens: attempt.cacheCreationInputTokens,
      cacheReadInputTokens: attempt.cacheReadInputTokens,
      outputTokens: attempt.outputTokens,
      rates,
      inferenceGeo: attempt.inferenceGeo,
      serviceTier: attempt.serviceTier,
      costMicrousd: attempt.costMicrousd,
    };
  });
  if (attempts.length === 0) fail();
  return {
    model: value.model,
    effort: value.effort,
    promptVersion: value.promptVersion,
    schemaVersion: value.schemaVersion,
    wireVersion: value.wireVersion,
    assemblerVersion: value.assemblerVersion,
    pricingPolicyId: value.pricingPolicyId,
    attempts,
  };
}

function derivedReportId(jobId) {
  return createHash('sha256')
    .update(`board-report-id-v1\0${jobId}`)
    .digest('hex');
}

function projectComparison(value) {
  const validation = validateReportComparison(value);
  if (!validation.valid) fail();
  return JSON.parse(canonicalStringify(value));
}

function projectEnvelope(value) {
  inspectPlainJson(value);
  exact(value, [
    'schemaVersion',
    'reportId',
    'jobId',
    'ownerId',
    'repositoryId',
    'generatedAt',
    'report',
    'inventory',
    'comparison',
    'source',
    'analysis',
  ]);
  if (
    value.schemaVersion !== SUCCESSFUL_REPORT_VERSION_SCHEMA_VERSION ||
    !HEX_64.test(value.reportId) ||
    !HEX_64.test(value.jobId) ||
    value.reportId !== derivedReportId(value.jobId) ||
    value.ownerId !== 99961 ||
    !positive(value.repositoryId)
  )
    fail();
  const generatedAt = utcTimestamp(value.generatedAt, { milliseconds: true });
  const validation = validateReport(value.report, value.inventory);
  if (!validation.valid) fail();
  const inventory = projectInventory(value.inventory);
  const report = projectReport(value.report);
  const comparison = projectComparison(value.comparison);
  const source = projectSource(value.source, value.repositoryId, inventory);
  const analysis = projectAnalysis(value.analysis);
  const repository = source.provenance.repository;
  const reportUrl = (
    report.repoUrl ?? `https://github.com/${report.repo}`
  ).replace(/\/$/u, '');
  const inventoryUrl = (
    inventory.repoUrl ?? `https://github.com/${inventory.repo}`
  ).replace(/\/$/u, '');
  if (
    repository.fullName !== inventory.repo ||
    repository.name !== inventory.repo.split('/')[1] ||
    repository.url !== reportUrl ||
    repository.url !== inventoryUrl ||
    Date.parse(generatedAt) < Date.parse(source.sync.at) ||
    canonicalStringify(report.sync) !== canonicalStringify(source.sync) ||
    canonicalStringify(inventory.sync) !== canonicalStringify(source.sync) ||
    comparison.result.reportId !== value.reportId ||
    comparison.result.generatedAt !== generatedAt ||
    canonicalStringify(comparison.result.sourceFingerprint) !==
      canonicalStringify(source.fingerprint) ||
    canonicalStringify(comparison.result.sync) !==
      canonicalStringify(source.sync)
  )
    fail();
  if (
    comparison.basis !== null &&
    (!HEX_64.test(comparison.basis.reportId) ||
      comparison.basis.reportId === value.reportId ||
      Date.parse(comparison.basis.generatedAt) > Date.parse(generatedAt))
  )
    fail();
  return {
    schemaVersion: value.schemaVersion,
    reportId: value.reportId,
    jobId: value.jobId,
    ownerId: value.ownerId,
    repositoryId: value.repositoryId,
    generatedAt,
    report,
    inventory,
    comparison,
    source,
    analysis,
  };
}

function serializeProjected(value) {
  const serialized = canonicalStringify(value);
  if (
    Buffer.byteLength(serialized, 'utf8') > SUCCESSFUL_REPORT_VERSION_MAX_BYTES
  )
    fail();
  return serialized;
}

function digestSerialized(serialized) {
  return createHash('sha256')
    .update('board-report-version-v1\0')
    .update(serialized)
    .digest('hex');
}

/** Strictly validate and copy the complete immutable successful-report value. */
export function projectSuccessfulReportVersion(value) {
  const projected = projectEnvelope(value);
  serializeProjected(projected);
  return projected;
}

/** Canonically serialize the exact projected envelope and enforce its byte cap. */
export function serializeSuccessfulReportVersion(value) {
  return serializeProjected(projectEnvelope(value));
}

/** Return the domain-separated SHA-256 digest of the canonical envelope. */
export function successfulReportVersionDigest(value) {
  return digestSerialized(serializeSuccessfulReportVersion(value));
}

/** Project once for an immutable write and retain its exact digest proof. */
export function prepareSuccessfulReportVersion(value) {
  const projected = projectEnvelope(value);
  const serialized = serializeProjected(projected);
  return Object.freeze({
    value: projected,
    serialized,
    candidateDigest: digestSerialized(serialized),
  });
}

export function successfulReportVersionKey(value) {
  const projected = projectSuccessfulReportVersion(value);
  return `owners/${projected.ownerId}/repositories/${projected.repositoryId}/versions/${projected.reportId}`;
}

/**
 * Prove a conflict or uncertain write against a validated strong-read value.
 * A digest match alone is insufficient unless every publication identity also
 * matches the original candidate.
 */
export function matchesStoredSuccessfulReportVersion({
  candidate,
  candidateDigest,
  stored,
}) {
  try {
    if (!HEX_64.test(candidateDigest)) return false;
    const expected = prepareSuccessfulReportVersion(candidate);
    if (expected.candidateDigest !== candidateDigest) return false;
    const observed = prepareSuccessfulReportVersion(stored);
    return (
      observed.candidateDigest === candidateDigest &&
      observed.value.reportId === expected.value.reportId &&
      observed.value.jobId === expected.value.jobId &&
      observed.value.ownerId === expected.value.ownerId &&
      observed.value.repositoryId === expected.value.repositoryId
    );
  } catch {
    return false;
  }
}

async function confirmImmutableRead(storage, versionKey, prepared, budget) {
  let read;
  try {
    read = await storage.read(versionKey, { budget });
  } catch {
    fail();
  }
  if (
    read === null ||
    !matchesStoredSuccessfulReportVersion({
      candidate: prepared.value,
      candidateDigest: prepared.candidateDigest,
      stored: read.value,
    })
  )
    fail();
}

/**
 * Perform one only-if-new write and require a validating strong read for every
 * successful outcome, including conflicts and committed-but-unacknowledged
 * writes. The helper never retries the immutable write.
 */
export async function writeSuccessfulReportVersion({
  storage,
  versionKey,
  version,
  budget,
}) {
  if (
    storage === null ||
    typeof storage?.write !== 'function' ||
    typeof storage?.read !== 'function'
  )
    fail();
  const prepared = prepareSuccessfulReportVersion(version);
  const expectedKey = `owners/${prepared.value.ownerId}/repositories/${prepared.value.repositoryId}/versions/${prepared.value.reportId}`;
  if (versionKey !== expectedKey) fail();
  let result;
  let uncertain = false;
  try {
    result = await storage.write(
      versionKey,
      prepared.value,
      { onlyIfNew: true },
      { budget },
    );
    if (
      result === null ||
      typeof result !== 'object' ||
      typeof result.modified !== 'boolean'
    )
      fail();
  } catch {
    uncertain = true;
  }
  await confirmImmutableRead(storage, versionKey, prepared, budget);
  return Object.freeze({
    status: uncertain ? 'recovered' : result.modified ? 'written' : 'existing',
    versionKey,
    candidateDigest: prepared.candidateDigest,
  });
}
