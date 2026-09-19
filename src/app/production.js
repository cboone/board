import { validateReportComparison } from '../domain/report-comparison.js';
import { validateReport } from '../domain/report-contract.js';
import { renderReport } from '../report/render.js';

const sourceStates = new Set([
  'ready',
  'reauthorization-required',
  'installation-required',
  'unverified',
]);

const messages = Object.freeze({
  invalid_request: 'This request is unavailable. Select a repository again.',
  session_required: 'Your Board session has ended. Sign in again to continue.',
  forbidden:
    'This request is not authorized. Check your session and try again.',
  source_authorization_required:
    'Reconnect GitHub to check repositories. Your Board session remains signed in.',
  source_unavailable:
    'This repository is unavailable or ineligible for new analysis.',
  source_unstable:
    'GitHub changed during the check. Try again to collect a consistent result.',
  source_limit_exceeded:
    'This repository exceeds the current collection limits. The check did not complete.',
  source_incomplete:
    'Some required GitHub inputs could not be collected. Try the check again.',
  provider_rate_limited:
    'GitHub limited the requests. Try again after the limit resets.',
  source_timeout:
    'The GitHub check reached its runtime limit. The check did not complete.',
  provider_unavailable: 'GitHub is unavailable. Try again.',
  report_state_changed:
    'The saved report changed. Reload it before requesting analysis again.',
  analysis_in_progress: 'Another analysis is already in progress.',
  analysis_unavailable: 'Paid analysis is unavailable for this repository.',
  analysis_input_too_large:
    'This repository exceeds the configured analysis limits.',
  analysis_output_invalid:
    'The analysis did not produce a valid report. The saved report was preserved.',
  analysis_ambiguous:
    'The analysis result could not be confirmed. The saved report was preserved.',
  analysis_sensitive_input:
    'Some repository input cannot be sent safely for analysis.',
  analysis_provider_rate_limited:
    'Analysis is temporarily rate limited. Try again later.',
  analysis_provider_unavailable:
    'Analysis is temporarily unavailable. Try again later.',
  budget_exhausted: 'The configured analysis spending limit has been reached.',
  budget_discussion_required:
    'The setup spending threshold requires a decision before continuing.',
  pricing_review_required:
    'Analysis pricing must be reviewed before continuing.',
  idempotency_conflict:
    'This analysis request identifier is already in use. Reload the board before trying again.',
  report_catalog_full:
    'The saved report catalog has reached its configured limit.',
  report_catalog_changed:
    'The saved report list changed while loading. Reload the list and try again.',
  report_not_found: 'No saved board is available for this repository.',
  superseded: 'A newer report replaced this analysis result.',
  service_unavailable: 'Board is unavailable. Try again.',
  internal_error: 'Board could not complete the request. Try again.',
  network_error:
    'Board could not be reached. Check your connection and try again.',
  invalid_response: 'Board returned an incomplete response. Try again.',
});

const countLabels = Object.freeze({
  openIssues: 'Open issues',
  openPullRequests: 'Open pull requests',
  milestones: 'Milestones',
  labels: 'Labels',
  branches: 'Remote branches',
  unmergedBranches: 'Unmerged branches',
  issueComments: 'Issue comments',
  treeEntries: 'Repository tree entries',
  selectedFiles: 'Selected files',
});

const buttonClass =
  'rounded-md bg-blue-800 px-4 py-2 font-semibold text-white hover:bg-blue-900 disabled:cursor-wait disabled:opacity-60 dark:bg-blue-300 dark:text-slate-950 dark:hover:bg-blue-200';
const secondaryClass =
  'rounded-md border border-slate-400 px-4 py-2 font-medium hover:border-blue-700 dark:border-slate-500 dark:hover:border-blue-300';
const mutedClass = 'text-slate-700 dark:text-slate-300';
const boxClass =
  'rounded-lg border border-slate-300 bg-white p-5 dark:border-slate-700 dark:bg-slate-900';

class StaleRequest extends Error {}
class ApiError extends Error {
  constructor(code) {
    super(messages[code] ?? messages.internal_error);
    this.code = Object.hasOwn(messages, code) ? code : 'internal_error';
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(text, handler, secondary = false) {
  const node = element(
    'button',
    text,
    secondary ? secondaryClass : buttonClass,
  );
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function link(text, path, primary = false) {
  const node = element(
    'a',
    text,
    primary ? buttonClass : 'text-blue-800 underline dark:text-blue-300',
  );
  node.href = path;
  return node;
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, maximum = 2000) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const isId = (value) => Number.isSafeInteger(value) && value > 0;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function validSession(value) {
  return (
    isObject(value) &&
    Object.keys(value).length === 4 &&
    ['auth', 'user', 'csrfToken', 'sourceAuthorization'].every((key) =>
      Object.hasOwn(value, key),
    ) &&
    value.auth === true &&
    isObject(value.user) &&
    Object.keys(value.user).length === 2 &&
    Object.hasOwn(value.user, 'id') &&
    Object.hasOwn(value.user, 'login') &&
    value.user.id === 99961 &&
    value.user.login === 'cboone' &&
    isText(value.csrfToken, 256) &&
    value.csrfToken.length >= 32 &&
    sourceStates.has(value.sourceAuthorization)
  );
}

function validRepository(value) {
  if (
    !isObject(value) ||
    Object.keys(value).length !== 5 ||
    !['id', 'name', 'fullName', 'url', 'private'].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    !isId(value.id) ||
    !isText(value.name, 100) ||
    !/^[A-Za-z0-9._-]+$/u.test(value.name) ||
    value.name === '.' ||
    value.name === '..' ||
    value.fullName !== `cboone/${value.name}` ||
    !isText(value.url) ||
    typeof value.private !== 'boolean'
  )
    return false;
  try {
    const url = new URL(value.url);
    return (
      url.origin === 'https://github.com' &&
      url.pathname === `/${value.fullName}` &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function repositoryList(value) {
  if (
    !isObject(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'repositories') ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > 10000 ||
    !value.repositories.every(validRepository) ||
    new Set(value.repositories.map(({ id }) => id)).size !==
      value.repositories.length
  )
    throw new ApiError('invalid_response');
  return value.repositories.map(
    ({ id, name, fullName, private: privateRepo }) => ({
      id,
      name,
      fullName,
      private: privateRepo,
      url: `https://github.com/${fullName}`,
    }),
  );
}

function validSummary(value, selected) {
  return (
    isObject(value) &&
    Object.keys(value).length === 6 &&
    ['status', 'repo', 'sync', 'fingerprint', 'counts', 'provenance'].every(
      (key) => Object.hasOwn(value, key),
    ) &&
    value.status === 'complete' &&
    validRepository(value.repo) &&
    value.repo.id === selected.id &&
    value.repo.fullName === selected.fullName &&
    isObject(value.sync) &&
    Object.keys(value.sync).every((key) =>
      ['at', 'timeZone', 'branch', 'commit', 'openPullRequests'].includes(key),
    ) &&
    isText(value.sync.at) &&
    Number.isFinite(Date.parse(value.sync.at)) &&
    isText(value.sync.branch) &&
    isText(value.sync.commit, 64) &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.sync.commit) &&
    isCount(value.sync.openPullRequests) &&
    isObject(value.fingerprint) &&
    Object.keys(value.fingerprint).length === 3 &&
    value.fingerprint.algorithm === 'sha256' &&
    isText(value.fingerprint.value, 64) &&
    /^[a-f0-9]{64}$/u.test(value.fingerprint.value) &&
    value.fingerprint.scope === 'core-and-collected-context' &&
    isObject(value.counts) &&
    Object.keys(value.counts).length === Object.keys(countLabels).length &&
    Object.keys(countLabels).every((key) => isCount(value.counts[key])) &&
    isObject(value.provenance) &&
    Object.keys(value.provenance).length === 7 &&
    [
      'observedFrom',
      'observedTo',
      'consistency',
      'inputs',
      'files',
      'references',
      'limitations',
    ].every((key) => Object.hasOwn(value.provenance, key)) &&
    isText(value.provenance.observedFrom) &&
    isText(value.provenance.observedTo) &&
    Number.isFinite(Date.parse(value.provenance.observedFrom)) &&
    Number.isFinite(Date.parse(value.provenance.observedTo)) &&
    value.provenance.consistency === 'two-pass-matched' &&
    Array.isArray(value.provenance.inputs) &&
    value.provenance.inputs.length <= 20 &&
    value.provenance.inputs.every(
      (entry) =>
        isObject(entry) &&
        Object.keys(entry).length === 2 &&
        isText(entry.name, 128) &&
        isText(entry.status, 128),
    ) &&
    Array.isArray(value.provenance.limitations) &&
    value.provenance.limitations.length <= 100 &&
    value.provenance.limitations.every((entry) => isText(entry)) &&
    Array.isArray(value.provenance.files) &&
    value.provenance.files.length <= 40 &&
    value.provenance.files.every(
      (file) =>
        isObject(file) &&
        Object.keys(file).length === 2 &&
        isText(file.path) &&
        isText(file.blobId, 64) &&
        /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(file.blobId),
    ) &&
    isObject(value.provenance.references) &&
    Object.keys(value.provenance.references).length === 2 &&
    isCount(value.provenance.references.verified) &&
    isCount(value.provenance.references.unverified)
  );
}

const hex64 = /^[a-f0-9]{64}$/u;
const hex40Or64 = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const catalogSourceStates = new Set([
  'ready',
  'checking',
  'complete',
  'failed',
  'source-unavailable',
  'unknown',
]);
const jobStates = new Set([
  'queued',
  'gathering',
  'analyzing',
  'validating',
  'publishing',
  'succeeded',
  'failed',
  'ambiguous',
]);
const terminalJobStates = new Set(['succeeded', 'failed', 'ambiguous']);
const operations = new Set(['generate', 'refresh']);
const jobLabels = Object.freeze({
  queued: 'Analysis queued…',
  gathering: 'Collecting approved GitHub inputs…',
  analyzing: 'Analyzing the backlog…',
  validating: 'Validating the report…',
  publishing: 'Publishing the report…',
  succeeded: 'Report ready.',
});
const comparisonLabels = Object.freeze({
  initial: 'Initial report',
  unchanged: 'No reader-visible report changes',
  changed: 'Changes since the previous report',
});

const strictObject = (value) =>
  isObject(value) && Object.getPrototypeOf(value) === Object.prototype;
const strictText = (value, maximum = 20000) =>
  typeof value === 'string' &&
  /\S/u.test(value) &&
  value.length <= maximum &&
  !/\p{Cc}/u.test(value);
const optionalStrictText = (value, maximum = 20000) =>
  value === null || strictText(value, maximum);
const timestamp = (value) =>
  strictText(value, 40) && Number.isFinite(Date.parse(value));
const strictExact = (value, required, optional = []) => {
  if (!strictObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};
const stableJson = (value) =>
  Array.isArray(value)
    ? `[${value.map(stableJson).join(',')}]`
    : strictObject(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value);

function safeHttps(value) {
  if (!strictText(value, 4096)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !/[\s"<>\\]/u.test(value)
    );
  } catch {
    return false;
  }
}

function copyRepository(value) {
  return {
    id: value.id,
    name: value.name,
    fullName: value.fullName,
    private: value.private,
    url: value.url,
  };
}

function validPointer(value) {
  return (
    strictExact(value, ['reportId', 'generatedAt', 'sourceFingerprint']) &&
    hex64.test(value.reportId) &&
    timestamp(value.generatedAt) &&
    hex64.test(value.sourceFingerprint)
  );
}

function validJob(value) {
  if (
    !strictExact(value, [
      'id',
      'operation',
      'state',
      'createdAt',
      'errorCode',
      'reportId',
    ]) ||
    !hex64.test(value.id) ||
    !operations.has(value.operation) ||
    !jobStates.has(value.state) ||
    !timestamp(value.createdAt)
  )
    return false;
  if (value.errorCode !== null && !Object.hasOwn(messages, value.errorCode))
    return false;
  if (!(value.reportId === null || hex64.test(value.reportId))) return false;
  return value.state === 'succeeded'
    ? value.reportId !== null && value.errorCode === null
    : ['failed', 'ambiguous'].includes(value.state)
      ? value.errorCode !== null && value.reportId === null
      : value.reportId === null && value.errorCode === null;
}

function parseCatalogPage(value) {
  if (
    !strictExact(value, ['items', 'nextCursor']) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !value.items.every(
      (item) =>
        strictExact(item, [
          'repository',
          'current',
          'sourceStatus',
          'activeJob',
        ]) &&
        validRepository(item.repository) &&
        validPointer(item.current) &&
        catalogSourceStates.has(item.sourceStatus) &&
        (item.activeJob === null || validJob(item.activeJob)),
    ) ||
    !(
      value.nextCursor === null ||
      (strictText(value.nextCursor, 1024) &&
        /^[A-Za-z0-9_-]+$/u.test(value.nextCursor))
    )
  )
    throw new ApiError('invalid_response');
  return {
    items: value.items.map((item) => ({
      repository: copyRepository(item.repository),
      current: { ...item.current },
      sourceStatus: item.sourceStatus,
      activeJob: item.activeJob === null ? null : { ...item.activeJob },
    })),
    nextCursor: value.nextCursor,
  };
}

function validSync(value, { source = false } = {}) {
  const required = source
    ? ['at', 'branch', 'commit', 'openPullRequests']
    : ['at', 'branch', 'commit'];
  if (
    !strictExact(
      value,
      required,
      source ? ['timeZone'] : ['timeZone', 'openPullRequests', 'extra'],
    ) ||
    !timestamp(value.at) ||
    !strictText(value.branch, 256) ||
    /\s/u.test(value.branch) ||
    value.branch
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..') ||
    !hex40Or64.test(value.commit)
  )
    return false;
  if (Object.hasOwn(value, 'timeZone') && !strictText(value.timeZone, 128))
    return false;
  if (
    Object.hasOwn(value, 'openPullRequests') &&
    !isCount(value.openPullRequests)
  )
    return false;
  return (
    !Object.hasOwn(value, 'extra') ||
    (Array.isArray(value.extra) &&
      value.extra.length <= 100 &&
      value.extra.every((entry) => strictText(entry, 4096)))
  );
}

function validFingerprint(value) {
  return (
    strictExact(value, ['algorithm', 'value', 'scope']) &&
    value.algorithm === 'sha256' &&
    hex64.test(value.value) &&
    value.scope === 'core-and-collected-context'
  );
}

function validReference(value) {
  if (isId(value)) return true;
  if (!strictObject(value)) return false;
  const kinds = ['pr', 'branch', 'ref', 'url'].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (kinds.length !== 1) return false;
  const kind = kinds[0];
  if (kind === 'url')
    return (
      strictExact(value, ['url', 'label'], ['title']) &&
      safeHttps(value.url) &&
      strictText(value.label, 1000) &&
      (!Object.hasOwn(value, 'title') || strictText(value.title))
    );
  return (
    strictExact(value, [kind], ['title']) &&
    (kind === 'pr' ? isId(value.pr) : strictText(value[kind], 4096)) &&
    (!Object.hasOwn(value, 'title') || strictText(value.title))
  );
}

function validAssignees(value) {
  if (!Array.isArray(value) || value.length > 100) return false;
  let previous = 0;
  for (const assignee of value) {
    if (
      !strictExact(assignee, ['id', 'login']) ||
      !isId(assignee.id) ||
      assignee.id <= previous ||
      !strictText(assignee.login, 256)
    )
      return false;
    previous = assignee.id;
  }
  return true;
}

function validStrictIssue(value, analysis) {
  const required = [
    'id',
    'number',
    'title',
    'milestone',
    'createdAt',
    'updatedAt',
    'assignees',
    'inProgress',
  ];
  const optional = analysis
    ? [
        'short',
        'waitingOn',
        'blockedBecause',
        'after',
        'sameBranchAs',
        'uncertainty',
      ]
    : [];
  if (
    !strictExact(value, required, optional) ||
    !isId(value.id) ||
    !isId(value.number) ||
    !strictText(value.title) ||
    !optionalStrictText(value.milestone) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !validAssignees(value.assignees) ||
    !optionalStrictText(value.inProgress, 4096)
  )
    return false;
  if (!analysis) return true;
  if (Object.hasOwn(value, 'short') && !strictText(value.short, 240))
    return false;
  for (const key of ['waitingOn', 'after'])
    if (
      Object.hasOwn(value, key) &&
      (!Array.isArray(value[key]) ||
        value[key].length > 100 ||
        !value[key].every(validReference))
    )
      return false;
  if (
    Object.hasOwn(value, 'blockedBecause') &&
    !strictText(value.blockedBecause, 8000)
  )
    return false;
  if (Object.hasOwn(value, 'sameBranchAs') && !isId(value.sameBranchAs))
    return false;
  if (Object.hasOwn(value, 'uncertainty')) {
    const uncertainty = value.uncertainty;
    if (
      !strictExact(uncertainty, ['reason'], ['reference']) ||
      !strictText(uncertainty.reason, 8000) ||
      (Object.hasOwn(uncertainty, 'reference') &&
        !validReference(uncertainty.reference))
    )
      return false;
  }
  return true;
}

function validStrictInventory(value) {
  return (
    strictExact(
      value,
      ['board', 'title', 'repo', 'sync', 'issues'],
      ['repoUrl'],
    ) &&
    value.board === 'backlog-triage' &&
    strictText(value.title) &&
    strictText(value.repo, 256) &&
    validSync(value.sync) &&
    (!Object.hasOwn(value, 'repoUrl') || safeHttps(value.repoUrl)) &&
    Array.isArray(value.issues) &&
    value.issues.length <= 1000 &&
    value.issues.every((issue) => validStrictIssue(issue, false))
  );
}

function validStrictReport(value) {
  if (
    !strictExact(
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
    ) ||
    value.board !== 'backlog-triage' ||
    !strictText(value.title) ||
    !strictText(value.repo, 256) ||
    !validSync(value.sync) ||
    !strictText(value.summary) ||
    (Object.hasOwn(value, 'repoUrl') && !safeHttps(value.repoUrl)) ||
    !Array.isArray(value.issues) ||
    value.issues.length > 1000 ||
    !value.issues.every((issue) => validStrictIssue(issue, true))
  )
    return false;
  if (
    !Array.isArray(value.lanes) ||
    value.lanes.length > 1000 ||
    !value.lanes.every(
      (lane) =>
        strictExact(
          lane,
          ['key', 'name', 'mode', 'issues'],
          ['owns', 'note'],
        ) &&
        strictText(lane.key, 100) &&
        strictText(lane.name, 240) &&
        ['serial', 'head', 'any'].includes(lane.mode) &&
        Array.isArray(lane.issues) &&
        lane.issues.length <= 1000 &&
        lane.issues.every(isId) &&
        (!Object.hasOwn(lane, 'owns') || strictText(lane.owns, 8000)) &&
        (!Object.hasOwn(lane, 'note') || strictText(lane.note, 8000)),
    ) ||
    !Array.isArray(value.startNow) ||
    value.startNow.length > 1000 ||
    !value.startNow.every(
      (pick) =>
        strictExact(pick, ['issue', 'why'], ['touches']) &&
        isId(pick.issue) &&
        strictText(pick.why, 8000) &&
        (!Object.hasOwn(pick, 'touches') || strictText(pick.touches, 8000)),
    )
  )
    return false;
  if (
    Object.hasOwn(value, 'milestones') &&
    (!Array.isArray(value.milestones) ||
      value.milestones.length > 2000 ||
      !value.milestones.every(
        (milestone) =>
          strictExact(milestone, ['title'], ['short']) &&
          strictText(milestone.title) &&
          (!Object.hasOwn(milestone, 'short') ||
            strictText(milestone.short, 240)),
      ))
  )
    return false;
  if (
    Object.hasOwn(value, 'notes') &&
    (!strictExact(value.notes, [], ['startNow', 'blocked', 'contention']) ||
      Object.keys(value.notes).length === 0 ||
      !Object.values(value.notes).every((entry) => strictText(entry, 8000)))
  )
    return false;
  if (Object.hasOwn(value, 'contention')) {
    const contention = value.contention;
    if (
      !strictExact(contention, ['claims'], ['rowLabel']) ||
      !Array.isArray(contention.claims) ||
      contention.claims.length > 1000 ||
      !contention.claims.every(
        (claim) =>
          strictExact(claim, ['name', 'issues'], ['query']) &&
          strictText(claim.name, 240) &&
          Array.isArray(claim.issues) &&
          claim.issues.length <= 1000 &&
          claim.issues.every(isId) &&
          (!Object.hasOwn(claim, 'query') || strictText(claim.query, 2000)),
      ) ||
      (Object.hasOwn(contention, 'rowLabel') &&
        !strictText(contention.rowLabel, 240))
    )
      return false;
  }
  return true;
}

function validSelectionCounts(value) {
  return (
    strictExact(value, ['comments', 'files', 'total']) &&
    isCount(value.comments) &&
    isCount(value.files) &&
    value.total === value.comments + value.files
  );
}

function validOmission(value) {
  if (!strictObject(value)) return false;
  const common =
    Array.isArray(value.ruleIds) &&
    value.ruleIds.length > 0 &&
    value.ruleIds.length <= 32 &&
    value.ruleIds.every((entry) => strictText(entry, 128));
  if (value.kind === 'comment')
    return (
      strictExact(value, ['kind', 'id', 'issueId', 'contentHash', 'ruleIds']) &&
      isId(value.id) &&
      isId(value.issueId) &&
      hex64.test(value.contentHash) &&
      common
    );
  return (
    value.kind === 'file' &&
    strictExact(value, ['kind', 'path', 'blobId', 'ruleIds']) &&
    strictText(value.path, 4096) &&
    hex40Or64.test(value.blobId) &&
    common
  );
}

function validAnalysisSelection(value) {
  if (
    !strictExact(value, [
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
    ]) ||
    !strictText(value.version, 128) ||
    !strictText(value.wireVersion, 128) ||
    !strictText(value.sourceSafetyPolicyVersion, 128) ||
    !isCount(value.sourcePathExtractorVersion) ||
    !hex64.test(value.mandatoryManifestHash) ||
    !validSelectionCounts(value.selectedCounts) ||
    !validSelectionCounts(value.omittedCounts) ||
    typeof value.limited !== 'boolean' ||
    !Array.isArray(value.selectedComments) ||
    value.selectedComments.length > 20000 ||
    !value.selectedComments.every(
      (entry) =>
        strictExact(entry, ['id', 'issueId', 'bodyHash']) &&
        isId(entry.id) &&
        isId(entry.issueId) &&
        hex64.test(entry.bodyHash),
    ) ||
    !Array.isArray(value.selectedFiles) ||
    value.selectedFiles.length > 40 ||
    !value.selectedFiles.every(
      (entry) =>
        strictExact(entry, ['path', 'blobId', 'relevanceClass']) &&
        strictText(entry.path, 4096) &&
        hex40Or64.test(entry.blobId) &&
        ['referenced', 'guidance', 'configuration'].includes(
          entry.relevanceClass,
        ),
    ) ||
    !Array.isArray(value.omissions) ||
    value.omissions.length > 100040 ||
    !value.omissions.every(validOmission) ||
    !Array.isArray(value.countAttempts) ||
    value.countAttempts.length === 0 ||
    value.countAttempts.length > 64 ||
    !value.countAttempts.every(
      (entry) =>
        strictExact(entry, [
          'prefixLength',
          'inputTokens',
          'countRequestBytes',
          'messageRequestBytes',
        ]) && Object.values(entry).every(isCount),
    ) ||
    !strictExact(value.limits, [
      'commentBytes',
      'totalCommentBytes',
      'fileBytes',
      'totalFileBytes',
      'requestBytes',
      'inputTokens',
    ]) ||
    !Object.values(value.limits).every(isCount) ||
    !Array.isArray(value.limitations) ||
    value.limitations.length > 256 ||
    !value.limitations.every((entry) => strictText(entry, 128))
  )
    return false;
  return (
    value.selectedCounts.comments === value.selectedComments.length &&
    value.selectedCounts.files === value.selectedFiles.length &&
    value.omittedCounts.comments ===
      value.omissions.filter(({ kind }) => kind === 'comment').length &&
    value.omittedCounts.files ===
      value.omissions.filter(({ kind }) => kind === 'file').length
  );
}

function validSavedSource(value, repository, inventory) {
  if (
    !strictExact(value, ['fingerprint', 'sync', 'counts', 'provenance']) ||
    !validFingerprint(value.fingerprint) ||
    !validSync(value.sync, { source: true }) ||
    !strictExact(value.counts, Object.keys(countLabels)) ||
    !Object.values(value.counts).every(isCount)
  )
    return false;
  const provenance = value.provenance;
  return (
    strictExact(provenance, [
      'repository',
      'observedFrom',
      'observedTo',
      'consistency',
      'inputs',
      'files',
      'references',
      'limitations',
      'analysisSelection',
    ]) &&
    validRepository(provenance.repository) &&
    provenance.repository.id === repository.id &&
    provenance.repository.fullName === repository.fullName &&
    timestamp(provenance.observedFrom) &&
    timestamp(provenance.observedTo) &&
    provenance.consistency === 'two-pass-matched' &&
    Array.isArray(provenance.inputs) &&
    provenance.inputs.length <= 10 &&
    provenance.inputs.every(
      (entry) =>
        strictExact(entry, ['name', 'status']) &&
        strictText(entry.name, 128) &&
        strictText(entry.status, 128),
    ) &&
    Array.isArray(provenance.files) &&
    provenance.files.length <= 40 &&
    provenance.files.every(
      (entry) =>
        strictExact(entry, ['path', 'blobId']) &&
        strictText(entry.path, 4096) &&
        hex40Or64.test(entry.blobId),
    ) &&
    strictExact(provenance.references, ['verified', 'unverified']) &&
    isCount(provenance.references.verified) &&
    isCount(provenance.references.unverified) &&
    Array.isArray(provenance.limitations) &&
    provenance.limitations.length <= 256 &&
    provenance.limitations.every((entry) => strictText(entry, 4096)) &&
    validAnalysisSelection(provenance.analysisSelection) &&
    value.counts.openIssues === inventory.issues.length &&
    value.counts.selectedFiles === provenance.files.length
  );
}

function validAnalysisAttempt(value) {
  return (
    strictExact(value, [
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
    ]) &&
    isId(value.number) &&
    strictText(value.terminalClass, 128) &&
    isCount(value.inputTokens) &&
    isCount(value.cacheCreationInputTokens) &&
    isCount(value.cacheReadInputTokens) &&
    isCount(value.outputTokens) &&
    strictExact(value.rates, ['inputRateMicrousd', 'outputRateMicrousd']) &&
    isCount(value.rates.inputRateMicrousd) &&
    isCount(value.rates.outputRateMicrousd) &&
    strictText(value.inferenceGeo, 128) &&
    strictText(value.serviceTier, 128) &&
    isCount(value.costMicrousd)
  );
}

function validAnalysis(value) {
  return (
    strictExact(value, [
      'model',
      'effort',
      'promptVersion',
      'schemaVersion',
      'wireVersion',
      'assemblerVersion',
      'pricingPolicyId',
      'attempts',
    ]) &&
    value.model === 'claude-opus-5' &&
    strictText(value.effort, 64) &&
    strictText(value.promptVersion, 128) &&
    isCount(value.schemaVersion) &&
    (isCount(value.wireVersion) || strictText(value.wireVersion, 128)) &&
    isCount(value.assemblerVersion) &&
    strictText(value.pricingPolicyId, 128) &&
    Array.isArray(value.attempts) &&
    value.attempts.length > 0 &&
    value.attempts.length <= 2 &&
    value.attempts.every(validAnalysisAttempt)
  );
}

function validSourceCheck(value, repositoryId) {
  if (value === null) return true;
  if (
    !strictExact(value, [
      'sequence',
      'startedAt',
      'completedAt',
      'status',
      'summary',
      'errorCode',
    ]) ||
    !isId(value.sequence) ||
    !timestamp(value.startedAt) ||
    !['checking', 'complete', 'failed', 'source-unavailable'].includes(
      value.status,
    ) ||
    !(value.completedAt === null || timestamp(value.completedAt)) ||
    !(value.errorCode === null || Object.hasOwn(messages, value.errorCode))
  )
    return false;
  if (value.status === 'checking')
    return (
      value.completedAt === null &&
      value.summary === null &&
      value.errorCode === null
    );
  if (value.completedAt === null) return false;
  if (value.status !== 'complete')
    return value.summary === null && value.errorCode !== null;
  return (
    value.errorCode === null &&
    value.summary !== null &&
    strictExact(value.summary, [
      'status',
      'repositoryId',
      'fingerprint',
      'sync',
      'counts',
    ]) &&
    value.summary.status === 'complete' &&
    value.summary.repositoryId === repositoryId &&
    hex64.test(value.summary.fingerprint) &&
    validSync(value.summary.sync, { source: true }) &&
    strictExact(value.summary.counts, Object.keys(countLabels)) &&
    Object.values(value.summary.counts).every(isCount)
  );
}

function validLastAttempt(value) {
  if (value === null) return true;
  if (
    !strictExact(value, [
      'jobId',
      'operation',
      'status',
      'completedAt',
      'errorCode',
    ]) ||
    !hex64.test(value.jobId) ||
    !operations.has(value.operation) ||
    ![
      'succeeded',
      'failed',
      'ambiguous',
      'superseded',
      'budget-blocked',
    ].includes(value.status) ||
    !timestamp(value.completedAt) ||
    !(value.errorCode === null || Object.hasOwn(messages, value.errorCode))
  )
    return false;
  return value.status === 'succeeded'
    ? value.errorCode === null
    : value.errorCode !== null;
}

function validSpendMode(value) {
  if (
    !strictExact(value, ['available', 'mode', 'reason']) ||
    typeof value.available !== 'boolean' ||
    !['setup', 'production', 'disabled'].includes(value.mode)
  )
    return false;
  if (value.available)
    return value.mode !== 'disabled' && value.reason === null;
  if (value.mode === 'disabled')
    return ['source_unavailable', 'analysis_unavailable'].includes(
      value.reason,
    );
  return [
    'budget_discussion_required',
    'budget_exhausted',
    'pricing_review_required',
  ].includes(value.reason);
}

function parseAnalysisAvailability(value) {
  if (!strictExact(value, ['spendMode']) || !validSpendMode(value.spendMode))
    throw new ApiError('invalid_response');
  return { ...value.spendMode };
}

function parseDirectReport(value) {
  const required = [
    'repository',
    'current',
    'report',
    'inventory',
    'source',
    'analysis',
    'activeJob',
    'spendMode',
  ];
  const optional = [
    'previous',
    'comparison',
    'sourceCheck',
    'lastAnalysisAttempt',
  ];
  if (
    !strictExact(value, required, optional) ||
    !validRepository(value.repository) ||
    !validSpendMode(value.spendMode) ||
    !(value.activeJob === null || validJob(value.activeJob)) ||
    !validSourceCheck(value.sourceCheck ?? null, value.repository.id) ||
    !validLastAttempt(value.lastAnalysisAttempt ?? null)
  )
    throw new ApiError('invalid_response');
  const previous = value.previous ?? null;
  const comparison = value.comparison ?? null;
  if (previous !== null && !validPointer(previous))
    throw new ApiError('invalid_response');
  if (value.current === null) {
    if (
      previous !== null ||
      comparison !== null ||
      value.report !== null ||
      value.inventory !== null ||
      value.source !== null ||
      value.analysis !== null ||
      value.activeJob?.operation === 'refresh'
    )
      throw new ApiError('invalid_response');
  } else {
    if (
      !validPointer(value.current) ||
      !validStrictReport(value.report) ||
      !validStrictInventory(value.inventory) ||
      !validateReport(value.report, value.inventory).valid ||
      !validSavedSource(value.source, value.repository, value.inventory) ||
      !validAnalysis(value.analysis) ||
      value.current.sourceFingerprint !== value.source.fingerprint.value ||
      value.report.repo !== value.repository.fullName ||
      value.inventory.repo !== value.repository.fullName ||
      stableJson(value.report.sync) !== stableJson(value.source.sync) ||
      stableJson(value.inventory.sync) !== stableJson(value.source.sync)
    )
      throw new ApiError('invalid_response');
    if (
      comparison !== null &&
      (!validateReportComparison(comparison).valid ||
        comparison.result.reportId !== value.current.reportId ||
        comparison.result.generatedAt !== value.current.generatedAt ||
        comparison.result.sourceFingerprint.value !==
          value.current.sourceFingerprint ||
        (previous === null
          ? comparison.basis !== null
          : comparison.basis?.reportId !== previous.reportId ||
            comparison.basis.generatedAt !== previous.generatedAt ||
            comparison.basis.sourceFingerprint.value !==
              previous.sourceFingerprint))
    )
      throw new ApiError('invalid_response');
  }
  return {
    repository: copyRepository(value.repository),
    current: value.current === null ? null : { ...value.current },
    previous: previous === null ? null : { ...previous },
    report: value.report,
    inventory: value.inventory,
    comparison,
    source: value.source,
    analysis: value.analysis,
    sourceCheck: value.sourceCheck ?? null,
    lastAnalysisAttempt: value.lastAnalysisAttempt ?? null,
    activeJob: value.activeJob === null ? null : { ...value.activeJob },
    spendMode: { ...value.spendMode },
  };
}

function selectedId() {
  const path = window.location.pathname.replace(/\/$/u, '') || '/';
  if (path === '/') return null;
  const match = /^\/repositories\/([1-9]\d*)$/u.exec(path);
  return match && isId(Number(match[1])) ? Number(match[1]) : false;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function comparisonDescription(entry) {
  const subject = entry.issueNumber
    ? `issue #${entry.issueNumber}`
    : entry.laneKey
      ? `lane ${entry.laneKey}`
      : entry.claimName
        ? `contention claim ${entry.claimName}`
        : 'report';
  const labels = {
    'issue-opened': 'Opened',
    'issue-closed': 'Closed',
    'start-added': 'Added a start recommendation for',
    'start-removed': 'Removed a start recommendation for',
    'lane-added': 'Added',
    'lane-removed': 'Removed',
    'claim-added': 'Added',
    'claim-removed': 'Removed',
  };
  const lead = labels[entry.kind] ?? `Changed ${subject}`;
  if (Object.hasOwn(labels, entry.kind)) return `${lead} ${subject}`;
  const changes = entry.fields.map((field) => {
    const before = comparisonValue(entry.before?.[field]);
    const after = comparisonValue(entry.after?.[field]);
    return `${field}: ${before} → ${after}`;
  });
  return changes.length ? `${lead}: ${changes.join('; ')}` : lead;
}

function comparisonValue(value) {
  const serialized =
    value === null
      ? 'none'
      : typeof value === 'string'
        ? value
        : stableJson(value);
  return serialized.length > 300 ? `${serialized.slice(0, 299)}…` : serialized;
}

export function mountProduction(mount) {
  let generation = 0;
  let viewGeneration = 0;
  let stopped = false;
  let sessionTimer;
  let pollTimer;
  let pollCount = 0;
  let pollingJobId = null;
  let checkingSession = false;
  let pendingFocus = null;
  let disposeReport = () => {};
  const controllers = new Set();
  const viewControllers = new Set();
  const state = {
    authenticated: false,
    user: null,
    csrfToken: '',
    sourceAuthorization: 'unverified',
    repositories: [],
    savedBoards: [],
    selected: null,
    board: null,
    freshness: { status: 'idle', summary: null, error: null },
    job: null,
    pending: null,
    error: null,
    listError: null,
    jobError: null,
    notice: '',
    signingOut: false,
    admissionRetry: null,
  };

  const current = (stamp) => !stopped && stamp === generation;
  const currentView = (stamp, repositoryId) =>
    current(stamp.generation) &&
    stamp.view === viewGeneration &&
    state.selected?.id === repositoryId;

  function disposeRenderedReport() {
    disposeReport();
    disposeReport = () => {};
  }

  function stopPolling() {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
    pollCount = 0;
    pollingJobId = null;
  }

  function clearView() {
    viewGeneration += 1;
    stopPolling();
    for (const controller of viewControllers) controller.abort();
    viewControllers.clear();
    disposeRenderedReport();
    state.board = null;
    state.freshness = { status: 'idle', summary: null, error: null };
    state.job = null;
    state.jobError = null;
    state.admissionRetry = null;
    pendingFocus = null;
  }

  function clearProtected() {
    generation += 1;
    clearView();
    for (const controller of controllers) controller.abort();
    controllers.clear();
    window.clearInterval(sessionTimer);
    sessionTimer = undefined;
    checkingSession = false;
    state.authenticated = false;
    state.user = null;
    state.csrfToken = '';
    state.sourceAuthorization = 'unverified';
    state.repositories = [];
    state.savedBoards = [];
    state.selected = null;
    state.pending = null;
    state.error = null;
    state.listError = null;
    state.notice = '';
    state.signingOut = false;
    document.title = 'Board';
    mount.replaceChildren();
  }

  async function request(
    method,
    path,
    {
      csrfToken = state.csrfToken,
      body,
      scope = 'global',
      expectedStatus,
    } = {},
  ) {
    const stamp = generation;
    const controller = new AbortController();
    controllers.add(controller);
    if (scope === 'view') viewControllers.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 65000);
    try {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(method === 'POST' ? { 'X-CSRF-Token': csrfToken } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!current(stamp)) throw new StaleRequest();
      let data;
      try {
        data = await response.json();
      } catch {
        if (!current(stamp)) throw new StaleRequest();
        throw new ApiError('invalid_response');
      }
      if (!current(stamp)) throw new StaleRequest();
      if (!response.ok) {
        if (response.status === 401 && path !== '/api/auth/logout') {
          clearProtected();
          state.notice = messages.session_required;
          paint();
          throw new StaleRequest();
        }
        throw new ApiError(
          isObject(data) && isObject(data.error)
            ? data.error.code
            : 'invalid_response',
        );
      }
      if (expectedStatus !== undefined && response.status !== expectedStatus)
        throw new ApiError('invalid_response');
      return data;
    } catch (error) {
      if (!current(stamp) || error instanceof StaleRequest)
        throw new StaleRequest();
      throw error instanceof ApiError ? error : new ApiError('network_error');
    } finally {
      window.clearTimeout(timeout);
      controllers.delete(controller);
      viewControllers.delete(controller);
    }
  }

  function showError(error) {
    if (error instanceof StaleRequest) return;
    state.pending = null;
    state.error =
      error instanceof ApiError ? error : new ApiError('internal_error');
    if (state.error.code === 'source_authorization_required')
      state.sourceAuthorization = 'reauthorization-required';
    paint();
  }

  async function bootstrap() {
    clearProtected();
    const address = new URL(window.location.href);
    const callbackError = address.searchParams.get('auth_error');
    if (callbackError && Object.hasOwn(messages, callbackError))
      state.notice = 'GitHub sign-in could not be completed. Please try again.';
    if (callbackError !== null) {
      address.searchParams.delete('auth_error');
      window.history.replaceState(null, '', address);
    }
    state.pending = 'bootstrap';
    paint();
    const stamp = generation;
    try {
      const session = await request('GET', '/api/session');
      if (!current(stamp)) return;
      if (strictExact(session, ['auth']) && session.auth === false) {
        state.pending = null;
        paint();
        return;
      }
      if (!validSession(session)) throw new ApiError('invalid_response');
      state.authenticated = true;
      state.user = { id: session.user.id, login: session.user.login };
      state.csrfToken = session.csrfToken;
      state.sourceAuthorization = session.sourceAuthorization;
      sessionTimer = window.setInterval(verifySession, 60000);
      await loadDashboard();
    } catch (error) {
      if (current(stamp)) showError(error);
    }
  }

  async function verifySession() {
    if (!state.authenticated || checkingSession || stopped) return;
    checkingSession = true;
    const stamp = generation;
    try {
      const session = await request('GET', '/api/session');
      if (!current(stamp)) return;
      if (strictExact(session, ['auth']) && session.auth === false) {
        clearProtected();
        state.notice = messages.session_required;
        paint();
      } else if (!validSession(session)) {
        throw new ApiError('invalid_response');
      } else if (session.csrfToken !== state.csrfToken) {
        await bootstrap();
      } else if (state.sourceAuthorization !== session.sourceAuthorization) {
        state.sourceAuthorization = session.sourceAuthorization;
        paint();
      }
    } catch (error) {
      if (!current(stamp)) return;
      clearProtected();
      showError(error);
    } finally {
      if (current(stamp)) checkingSession = false;
    }
  }

  async function loadCatalog() {
    for (let pass = 0; pass < 2; pass += 1) {
      const items = new Map();
      let cursor = null;
      try {
        for (let page = 0; page < 20; page += 1) {
          const path =
            cursor === null
              ? '/api/reports'
              : `/api/reports?cursor=${encodeURIComponent(cursor)}`;
          const result = parseCatalogPage(await request('GET', path));
          for (const item of result.items) items.set(item.repository.id, item);
          cursor = result.nextCursor;
          if (cursor === null)
            return [...items.values()].sort(
              (left, right) => left.repository.id - right.repository.id,
            );
        }
        throw new ApiError('report_catalog_changed');
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.code !== 'report_catalog_changed'
        )
          throw error;
        if (pass === 1) throw error;
      }
    }
    throw new ApiError('report_catalog_changed');
  }

  async function loadDashboard() {
    const stamp = generation;
    state.pending = 'repositories';
    state.error = null;
    state.listError = null;
    paint();
    const [repositories, catalog] = await Promise.allSettled([
      request('GET', '/api/repositories'),
      loadCatalog(),
    ]);
    if (!current(stamp)) return;
    if (repositories.status === 'fulfilled') {
      try {
        state.repositories = repositoryList(repositories.value);
      } catch (error) {
        state.listError = error;
        state.repositories = [];
      }
    } else if (!(repositories.reason instanceof StaleRequest)) {
      state.listError = repositories.reason;
      state.repositories = [];
    }
    if (catalog.status === 'fulfilled') state.savedBoards = catalog.value;
    else if (!(catalog.reason instanceof StaleRequest)) {
      state.listError = catalog.reason;
      state.savedBoards = [];
    }
    state.pending = null;
    const id = selectedId();
    if (id === false) {
      paint();
      return;
    }
    if (id === null) {
      state.selected = null;
      paint();
      return;
    }
    state.selected =
      mergedRepositories().find((repo) => repo.id === id) ?? null;
    if (!state.selected) {
      state.error = new ApiError('source_unavailable');
      paint();
      return;
    }
    paint();
    await loadBoard(id);
  }

  function mergedRepositories() {
    const repositories = new Map(
      state.repositories.map((repository) => [repository.id, repository]),
    );
    for (const item of state.savedBoards)
      if (!repositories.has(item.repository.id))
        repositories.set(item.repository.id, item.repository);
    return [...repositories.values()].sort((left, right) => left.id - right.id);
  }

  function localEmptyBoard(repository, spendMode) {
    return {
      repository: copyRepository(repository),
      current: null,
      previous: null,
      report: null,
      inventory: null,
      comparison: null,
      source: null,
      analysis: null,
      sourceCheck: null,
      lastAnalysisAttempt: null,
      activeJob: null,
      spendMode: { ...spendMode },
    };
  }

  function closedSpendMode(error) {
    const reason =
      error instanceof ApiError && Object.hasOwn(messages, error.code)
        ? error.code
        : 'analysis_unavailable';
    return { available: false, mode: 'disabled', reason };
  }

  async function readAnalysisAvailability() {
    return parseAnalysisAvailability(
      await request('GET', '/api/analysis-availability', { scope: 'view' }),
    );
  }

  async function refreshAnalysisAvailability(stamp, repositoryId) {
    let spendMode;
    try {
      spendMode = await readAnalysisAvailability();
    } catch (error) {
      if (error instanceof StaleRequest) throw error;
      spendMode = closedSpendMode(error);
    }
    if (!currentView(stamp, repositoryId)) return false;
    if (!state.board) throw new ApiError('invalid_response');
    state.board = { ...state.board, spendMode };
    return true;
  }

  function openUnsavedRepository(repository, spendMode) {
    state.board = localEmptyBoard(repository, spendMode);
    state.pending = null;
    state.job = null;
    state.jobError = null;
    state.admissionRetry = null;
    paint();
    checkSource();
  }

  function chooseRepository(event) {
    const id = Number(event.target.value);
    const repository = mergedRepositories().find((item) => item.id === id);
    clearView();
    state.selected = repository ?? null;
    state.error = null;
    const path = repository ? `/repositories/${repository.id}` : '/';
    window.history.pushState(null, '', path);
    paint();
    if (!repository) return;
    loadBoard(repository.id);
  }

  async function loadBoard(repositoryId, { afterSuccess = false } = {}) {
    const stamp = { generation, view: viewGeneration };
    state.pending = 'report';
    state.error = null;
    if (!afterSuccess) state.jobError = null;
    paint();
    try {
      const board = parseDirectReport(
        await request('GET', `/api/repositories/${repositoryId}/report`, {
          scope: 'view',
        }),
      );
      if (!currentView(stamp, repositoryId)) return;
      state.selected = board.repository;
      state.board = board;
      state.pending = null;
      state.job = board.activeJob;
      state.admissionRetry = null;
      if (afterSuccess) pendingFocus = 'report-details-title';
      paint();
      if (board.activeJob && !terminalJobStates.has(board.activeJob.state))
        startPolling(board.activeJob);
      checkSource();
    } catch (error) {
      if (!currentView(stamp, repositoryId)) return;
      if (
        error instanceof ApiError &&
        error.code === 'report_not_found' &&
        state.repositories.some(({ id }) => id === repositoryId)
      ) {
        state.error = null;
        let spendMode;
        try {
          spendMode = await readAnalysisAvailability();
        } catch (availabilityError) {
          if (availabilityError instanceof StaleRequest) return;
          spendMode = closedSpendMode(availabilityError);
        }
        if (!currentView(stamp, repositoryId)) return;
        openUnsavedRepository(state.selected, spendMode);
        return;
      }
      state.pending = null;
      state.error =
        error instanceof ApiError ? error : new ApiError('internal_error');
      paint();
    }
  }

  async function checkSource({ focus = false } = {}) {
    if (
      !state.selected ||
      state.freshness.status === 'checking' ||
      state.sourceAuthorization === 'reauthorization-required'
    )
      return;
    const stamp = { generation, view: viewGeneration };
    const selected = state.selected;
    state.freshness = {
      status: 'checking',
      summary: state.freshness.summary,
      error: null,
    };
    paint();
    try {
      const data = await request(
        'POST',
        `/api/repositories/${selected.id}/check`,
        { scope: 'view' },
      );
      if (!currentView(stamp, selected.id)) return;
      if (!validSummary(data, selected)) throw new ApiError('invalid_response');
      const summary = {
        sync: { ...data.sync },
        fingerprint: { ...data.fingerprint },
        counts: { ...data.counts },
        provenance: {
          observedFrom: data.provenance.observedFrom,
          observedTo: data.provenance.observedTo,
          files: data.provenance.files.map(({ path, blobId }) => ({
            path,
            blobId,
          })),
          limitations: [...data.provenance.limitations],
        },
      };
      state.freshness = {
        status:
          state.board?.current?.sourceFingerprint === data.fingerprint.value
            ? 'unchanged'
            : state.board?.current
              ? 'changed'
              : 'ready',
        summary,
        error: null,
      };
      if (focus) pendingFocus = 'source-freshness-title';
      paint();
      if (!(await refreshAnalysisAvailability(stamp, selected.id))) return;
      paint();
    } catch (error) {
      if (!currentView(stamp, selected.id)) return;
      const safeError =
        error instanceof ApiError ? error : new ApiError('internal_error');
      if (safeError.code === 'source_authorization_required')
        state.sourceAuthorization = 'reauthorization-required';
      state.freshness = {
        status:
          safeError.code === 'source_unavailable'
            ? 'source-unavailable'
            : 'failed',
        summary: state.freshness.summary,
        error: safeError,
      };
      if (focus) pendingFocus = 'source-freshness-title';
      paint();
    }
  }

  function analysisAllowed() {
    const savedSourceUnavailable =
      state.board?.sourceCheck?.status === 'source-unavailable' &&
      !['ready', 'unchanged', 'changed'].includes(state.freshness.status);
    return (
      state.selected !== null &&
      state.repositories.some(({ id }) => id === state.selected.id) &&
      state.sourceAuthorization === 'ready' &&
      state.freshness.status !== 'source-unavailable' &&
      !savedSourceUnavailable &&
      state.board?.spendMode.available === true
    );
  }

  async function startAnalysis() {
    if (
      !state.selected ||
      !state.board ||
      state.pending !== null ||
      (state.job && !terminalJobStates.has(state.job.state)) ||
      !analysisAllowed()
    )
      return;
    const repositoryId = state.selected.id;
    const operation = state.board.current === null ? 'generate' : 'refresh';
    const expectedCurrentReportId = state.board.current?.reportId ?? null;
    const retry = state.admissionRetry;
    const idempotencyKey =
      retry?.operation === operation &&
      retry.expectedCurrentReportId === expectedCurrentReportId
        ? retry.idempotencyKey
        : crypto.randomUUID();
    const admission = { idempotencyKey, operation, expectedCurrentReportId };
    const stamp = { generation, view: viewGeneration };
    state.pending = 'admission';
    state.jobError = null;
    paint();
    try {
      const data = await request(
        'POST',
        `/api/repositories/${repositoryId}/report-jobs`,
        { body: admission, scope: 'view', expectedStatus: 202 },
      );
      if (!currentView(stamp, repositoryId)) return;
      if (!strictExact(data, ['job']) || !validJob(data.job))
        throw new ApiError('invalid_response');
      state.pending = null;
      state.admissionRetry = null;
      state.job = { ...data.job };
      pendingFocus = 'analysis-status-title';
      paint();
      if (!terminalJobStates.has(data.job.state)) startPolling(data.job);
    } catch (error) {
      if (!currentView(stamp, repositoryId)) return;
      const safeError =
        error instanceof ApiError ? error : new ApiError('internal_error');
      state.pending = null;
      state.jobError = safeError;
      state.admissionRetry = ['network_error', 'invalid_response'].includes(
        safeError.code,
      )
        ? admission
        : null;
      if (safeError.code === 'source_authorization_required')
        state.sourceAuthorization = 'reauthorization-required';
      if (
        ['report_state_changed', 'analysis_in_progress'].includes(
          safeError.code,
        )
      ) {
        await loadBoard(repositoryId);
        return;
      }
      if (
        state.admissionRetry === null &&
        !(await refreshAnalysisAvailability(stamp, repositoryId))
      )
        return;
      pendingFocus = 'analysis-status-title';
      paint();
    }
  }

  function startPolling(job) {
    if (pollingJobId === job.id) return;
    stopPolling();
    pollingJobId = job.id;
    pollCount = 0;
    pollJob(job.id);
  }

  function schedulePoll(jobId) {
    const delays = [250, 500, 1000, 2000, 4000, 8000, 10000];
    if (pollCount >= 120) {
      stopPolling();
      state.jobError = new ApiError('analysis_ambiguous');
      paint();
      return;
    }
    const delay = delays[Math.min(pollCount, delays.length - 1)];
    pollTimer = window.setTimeout(() => pollJob(jobId), delay);
  }

  async function pollJob(jobId) {
    if (pollingJobId !== jobId || !state.selected) return;
    const repositoryId = state.selected.id;
    const stamp = { generation, view: viewGeneration };
    pollCount += 1;
    try {
      const data = await request('GET', `/api/report-jobs/${jobId}`, {
        scope: 'view',
      });
      if (!currentView(stamp, repositoryId) || pollingJobId !== jobId) return;
      if (
        !strictExact(data, ['job']) ||
        !validJob(data.job) ||
        data.job.id !== jobId
      )
        throw new ApiError('invalid_response');
      state.job = { ...data.job };
      state.jobError = null;
      if (!terminalJobStates.has(data.job.state)) {
        paint();
        schedulePoll(jobId);
        return;
      }
      stopPolling();
      if (data.job.state === 'succeeded') {
        state.jobError = null;
        paint();
        await loadBoard(repositoryId, { afterSuccess: true });
        return;
      }
      state.jobError = new ApiError(
        data.job.errorCode ??
          (data.job.state === 'ambiguous'
            ? 'analysis_ambiguous'
            : 'analysis_output_invalid'),
      );
      if (state.jobError.code === 'source_authorization_required')
        state.sourceAuthorization = 'reauthorization-required';
      if (!(await refreshAnalysisAvailability(stamp, repositoryId))) return;
      paint();
    } catch (error) {
      if (!currentView(stamp, repositoryId) || pollingJobId !== jobId) return;
      const safeError =
        error instanceof ApiError ? error : new ApiError('internal_error');
      if (
        ['network_error', 'service_unavailable', 'source_timeout'].includes(
          safeError.code,
        ) &&
        pollCount < 120
      ) {
        state.jobError = safeError;
        paint();
        schedulePoll(jobId);
      } else {
        stopPolling();
        state.jobError = safeError;
        paint();
      }
    }
  }

  async function logout() {
    const csrfToken = state.csrfToken;
    clearProtected();
    window.history.replaceState(null, '', '/');
    state.signingOut = true;
    state.notice = 'Signing out…';
    paint();
    const stamp = generation;
    try {
      const result = await request('POST', '/api/auth/logout', { csrfToken });
      if (!current(stamp)) return;
      if (!strictExact(result, ['ok']) || result.ok !== true)
        throw new ApiError('invalid_response');
      state.signingOut = false;
      state.notice = 'Signed out of Board.';
      paint();
    } catch (error) {
      if (!current(stamp)) return;
      state.signingOut = false;
      state.notice =
        'Your local view is cleared, but server sign-out could not be confirmed. Check your session before trying again.';
      showError(error);
    }
  }

  function paint() {
    if (stopped) return;
    const retainedFocus =
      mount.contains(document.activeElement) && document.activeElement.id
        ? document.activeElement.id
        : null;
    disposeRenderedReport();
    mount.replaceChildren();
    const id = selectedId();
    if (id === false) {
      document.title = 'Page unavailable · Board';
      mount.append(
        element('h1', 'Page unavailable', 'text-3xl font-bold'),
        element(
          'p',
          'This address does not identify a Board page.',
          `mt-4 ${mutedClass}`,
        ),
        link('Return to Board', '/'),
      );
      return;
    }
    document.title = state.selected
      ? `${state.selected.fullName} · Board`
      : 'Board';
    if (state.authenticated) paintAccount();
    if (state.notice) {
      const notice = element('p', state.notice, `mb-5 ${mutedClass}`);
      notice.setAttribute('role', 'status');
      mount.append(notice);
    }
    if (state.error) {
      const alert = element('p', state.error.message, `${boxClass} mb-5`);
      alert.setAttribute('role', 'alert');
      mount.append(alert);
    }
    if (!state.authenticated) {
      paintSignedOut();
      return;
    }
    paintRepositoryNavigation();
    if (state.selected) paintSelectedBoard();
    const focusTarget = pendingFocus ?? retainedFocus;
    if (focusTarget) {
      const target = document.getElementById(focusTarget);
      if (target) {
        target.tabIndex = -1;
        target.focus();
        if (pendingFocus === focusTarget) pendingFocus = null;
      }
    }
  }

  function paintAccount() {
    const account = element(
      'div',
      undefined,
      'mb-8 flex flex-wrap items-center justify-between gap-4',
    );
    account.append(
      element('p', `Signed in as @${state.user.login}`, mutedClass),
      action('Sign out', logout, true),
    );
    mount.append(account);
  }

  function paintSignedOut() {
    mount.append(
      element(
        'h1',
        'A clearer way to decide what to start next.',
        'max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl',
      ),
      element(
        'p',
        'Sign in with GitHub to open your repository backlog. Public and private reports are available only to your account.',
        `mt-6 max-w-2xl text-lg leading-8 ${mutedClass}`,
      ),
    );
    if (state.pending === 'bootstrap') {
      const status = element(
        'p',
        'Checking your session…',
        `mt-6 ${mutedClass}`,
      );
      status.setAttribute('role', 'status');
      mount.append(status);
    } else if (!state.signingOut) {
      const controls = element(
        'div',
        undefined,
        'mt-8 flex flex-wrap items-center gap-5',
      );
      controls.append(link('Sign in with GitHub', '/api/auth/start', true));
      if (state.error || state.notice)
        controls.append(action('Check session', bootstrap, true));
      controls.append(link('View sample report', '/demo'));
      mount.append(controls);
    }
  }

  function paintRepositoryNavigation() {
    mount.append(element('h1', 'Your repositories', 'text-3xl font-bold'));
    mount.append(
      element(
        'p',
        'Open an eligible repository or return to a saved historical board.',
        `mt-3 ${mutedClass}`,
      ),
    );
    if (state.sourceAuthorization === 'reauthorization-required')
      mount.append(link('Reconnect GitHub', '/api/auth/start', true));
    if (state.pending === 'repositories') {
      const status = element(
        'p',
        'Loading repositories and saved boards…',
        `mt-6 ${mutedClass}`,
      );
      status.setAttribute('role', 'status');
      mount.append(status);
      return;
    }
    if (state.listError) {
      const alert = element('p', state.listError.message, `${boxClass} mt-5`);
      alert.setAttribute('role', 'alert');
      mount.append(
        alert,
        action('Reload repository lists', loadDashboard, true),
      );
    }
    const merged = mergedRepositories();
    if (!merged.length) {
      mount.append(
        element(
          'p',
          'No eligible repositories or saved boards are available. Check the App installation and repository selection.',
          `mt-6 ${mutedClass}`,
        ),
      );
      const controls = element(
        'div',
        undefined,
        'mt-5 flex flex-wrap items-center gap-5',
      );
      controls.append(
        link(
          'Manage GitHub App access',
          'https://github.com/settings/installations',
        ),
        action('Reload repositories', loadDashboard, true),
      );
      mount.append(controls);
      return;
    }
    const label = element('label', 'Repository', 'mt-6 block font-semibold');
    label.htmlFor = 'repository-selection';
    const select = element(
      'select',
      undefined,
      'mt-2 w-full max-w-xl rounded-md border border-slate-400 bg-white px-3 py-3 text-slate-950 dark:border-slate-500 dark:bg-slate-950 dark:text-slate-50',
    );
    select.id = 'repository-selection';
    select.disabled = state.pending === 'report';
    const placeholder = element('option', 'Select a repository');
    placeholder.value = '';
    select.append(placeholder);
    for (const repository of merged) {
      const option = element(
        'option',
        `${repository.fullName}${repository.private ? ' (private)' : ''}`,
      );
      option.value = String(repository.id);
      select.append(option);
    }
    select.value = state.selected ? String(state.selected.id) : '';
    select.addEventListener('change', chooseRepository);
    mount.append(label, select);

    const eligible = element('section', undefined, 'mt-8');
    eligible.append(element('h2', 'Currently eligible', 'text-xl font-bold'));
    paintRepositoryGroup(
      eligible,
      state.repositories,
      'No eligible repositories.',
    );
    mount.append(eligible);
    const eligibleIds = new Set(state.repositories.map(({ id }) => id));
    const unavailable = state.savedBoards
      .filter((item) => !eligibleIds.has(item.repository.id))
      .map(({ repository }) => repository);
    if (unavailable.length) {
      const historical = element('section', undefined, 'mt-6');
      historical.append(
        element(
          'h2',
          'Saved boards currently unavailable',
          'text-xl font-bold',
        ),
      );
      paintRepositoryGroup(historical, unavailable, '');
      mount.append(historical);
    }
  }

  function paintRepositoryGroup(section, repositories, emptyText) {
    if (!repositories.length) {
      if (emptyText)
        section.append(element('p', emptyText, `mt-2 ${mutedClass}`));
      return;
    }
    const list = element('ul', undefined, 'mt-3 space-y-2');
    for (const repository of repositories) {
      const item = element('li');
      const boardLink = link(
        repository.fullName,
        `/repositories/${repository.id}`,
      );
      boardLink.addEventListener('click', (event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        const select = mount.querySelector('#repository-selection');
        if (select) {
          select.value = String(repository.id);
          select.dispatchEvent(new Event('change'));
        }
      });
      item.append(boardLink, ` · ${repository.private ? 'Private' : 'Public'}`);
      list.append(item);
    }
    section.append(list);
  }

  function paintSelectedBoard() {
    const source = element('section', undefined, `${boxClass} mt-8`);
    source.setAttribute('aria-labelledby', 'selected-repository-title');
    const title = element(
      'h2',
      state.selected.fullName,
      'break-all text-2xl font-bold',
    );
    title.id = 'selected-repository-title';
    source.append(
      title,
      element(
        'p',
        state.selected.private ? 'Private repository' : 'Public repository',
        `mt-2 ${mutedClass}`,
      ),
    );
    if (state.pending === 'report' && !state.board) {
      const progress = element(
        'p',
        'Loading saved board…',
        `mt-4 ${mutedClass}`,
      );
      progress.setAttribute('role', 'status');
      source.append(progress);
      mount.append(source);
      return;
    }
    if (!state.board) {
      source.append(
        element(
          'p',
          'The saved board could not be loaded.',
          `mt-4 ${mutedClass}`,
        ),
      );
      mount.append(source);
      return;
    }
    const controls = element(
      'div',
      undefined,
      'mt-5 flex flex-wrap items-center gap-4',
    );
    const check = action(
      state.freshness.status === 'checking'
        ? 'Checking GitHub…'
        : 'Check GitHub',
      () => checkSource({ focus: true }),
      true,
    );
    check.disabled =
      state.freshness.status === 'checking' ||
      state.sourceAuthorization === 'reauthorization-required';
    controls.append(check);
    const operation = state.board.current === null ? 'Generate' : 'Refresh';
    const retrying = state.admissionRetry !== null;
    const analyze = action(
      state.pending === 'admission'
        ? `${operation} requested…`
        : retrying
          ? `Retry ${operation.toLowerCase()} report`
          : `${operation} report`,
      startAnalysis,
    );
    analyze.disabled =
      state.pending !== null ||
      (state.job !== null && !terminalJobStates.has(state.job.state)) ||
      !analysisAllowed();
    controls.append(
      analyze,
      link('Open repository on GitHub', state.selected.url),
    );
    source.append(controls);
    if (!analysisAllowed()) {
      const reason = analysisUnavailableReason();
      if (reason)
        source.append(element('p', reason, `mt-4 text-sm ${mutedClass}`));
    }
    source.append(
      element(
        'p',
        'The GitHub check is free. Paid analysis runs only when you choose Generate report or Refresh report.',
        `mt-4 text-sm ${mutedClass}`,
      ),
    );
    mount.append(source);
    paintFreshness();
    paintJobStatus();
    if (state.board.current === null) paintEmptyBoard();
    else paintSavedBoard();
  }

  function analysisUnavailableReason() {
    if (!state.repositories.some(({ id }) => id === state.selected.id))
      return 'This historical board remains readable, but its source is not currently eligible for analysis.';
    if (state.sourceAuthorization === 'reauthorization-required')
      return messages.source_authorization_required;
    if (state.sourceAuthorization !== 'ready')
      return 'GitHub source authorization must be ready before analysis can start.';
    if (
      state.freshness.status === 'source-unavailable' ||
      (state.board.sourceCheck?.status === 'source-unavailable' &&
        !['ready', 'unchanged', 'changed'].includes(state.freshness.status))
    )
      return messages.source_unavailable;
    if (!state.board.spendMode.available)
      return (
        messages[state.board.spendMode.reason] ?? messages.analysis_unavailable
      );
    return '';
  }

  function paintFreshness() {
    const section = element('section', undefined, `${boxClass} mt-6`);
    section.setAttribute('aria-labelledby', 'source-freshness-title');
    const title = element('h2', 'Source freshness', 'text-xl font-bold');
    title.id = 'source-freshness-title';
    section.append(title);
    const statusText = {
      idle: 'GitHub has not been checked in this view.',
      checking: 'Checking GitHub for source changes…',
      ready: 'GitHub inputs are ready. No saved report exists yet.',
      unchanged: 'The saved report matches the latest complete GitHub check.',
      changed: 'GitHub changes were detected after the saved report.',
      failed: 'The GitHub check failed. No freshness claim was made.',
      'source-unavailable':
        'The saved report is historical because its GitHub source is unavailable or ineligible.',
    }[state.freshness.status];
    const status = element('p', statusText, `mt-3 ${mutedClass}`);
    status.setAttribute('role', 'status');
    section.append(status);
    if (state.freshness.error) {
      const alert = element('p', state.freshness.error.message, 'mt-3');
      alert.setAttribute('role', 'alert');
      section.append(alert);
    }
    if (state.freshness.summary)
      paintSummaryDetails(section, state.freshness.summary);
    mount.append(section);
  }

  function paintJobStatus() {
    const lastAttempt =
      !state.job &&
      !state.jobError &&
      state.board?.lastAnalysisAttempt?.status !== 'succeeded'
        ? state.board?.lastAnalysisAttempt
        : null;
    if (!state.job && !state.jobError && !lastAttempt) return;
    const section = element('section', undefined, `${boxClass} mt-6`);
    section.setAttribute('aria-labelledby', 'analysis-status-title');
    const title = element('h2', 'Analysis status', 'text-xl font-bold');
    title.id = 'analysis-status-title';
    section.append(title);
    if (state.job && !state.jobError) {
      const message = element(
        'p',
        jobLabels[state.job.state] ?? 'Analysis status updated.',
        `mt-3 ${mutedClass}`,
      );
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      section.append(message);
    }
    if (state.jobError) {
      const alert = element('p', state.jobError.message, 'mt-3');
      alert.setAttribute('role', 'alert');
      section.append(alert);
    }
    if (lastAttempt) {
      const fallback =
        lastAttempt.status === 'ambiguous'
          ? messages.analysis_ambiguous
          : lastAttempt.status === 'superseded'
            ? messages.superseded
            : 'The analysis attempt ended without publishing a report. The saved report was preserved.';
      const detail = lastAttempt.errorCode
        ? (messages[lastAttempt.errorCode] ?? fallback)
        : fallback;
      const alert = element(
        'p',
        `The last ${lastAttempt.operation} attempt completed ${formatDate(lastAttempt.completedAt)}. ${detail}`,
        'mt-3',
      );
      section.append(alert);
    }
    mount.append(section);
  }

  function paintEmptyBoard() {
    const empty = element('section', undefined, `${boxClass} mt-6`);
    empty.append(
      element('h2', 'No saved report yet', 'text-xl font-bold'),
      element(
        'p',
        'Generate report starts the first paid analysis for this repository.',
        `mt-3 ${mutedClass}`,
      ),
    );
    mount.append(empty);
  }

  function paintSavedBoard() {
    paintReportMetadata();
    paintComparison();
    const reportMount = element('div', undefined, 'mt-8');
    reportMount.id = 'saved-report';
    mount.append(reportMount);
    disposeReport = renderReport(
      reportMount,
      state.board.report,
      state.board.inventory,
    );
  }

  function paintReportMetadata() {
    const section = element('section', undefined, `${boxClass} mt-6`);
    section.setAttribute('aria-labelledby', 'report-details-title');
    const title = element('h2', 'Saved report details', 'text-xl font-bold');
    title.id = 'report-details-title';
    section.append(title);
    const details = element('dl', undefined, 'mt-4 grid gap-4 sm:grid-cols-2');
    const rows = [
      ['Generated', formatDate(state.board.current.generatedAt)],
      ['Analyzed commit', state.board.source.sync.commit],
      ['Source fingerprint', state.board.source.fingerprint.value],
      [
        'Model',
        `${state.board.analysis.model} · ${state.board.analysis.effort}`,
      ],
    ];
    if (state.board.previous)
      rows.push([
        'Previous report',
        formatDate(state.board.previous.generatedAt),
      ]);
    for (const [term, description] of rows) {
      const row = element('div');
      row.append(
        element('dt', term, `text-sm ${mutedClass}`),
        element('dd', description, 'mt-1 break-all font-medium'),
      );
      details.append(row);
    }
    section.append(details);
    const provenance = element(
      'details',
      undefined,
      'mt-6 border-t border-slate-300 pt-5 dark:border-slate-700',
    );
    provenance.append(
      element('summary', 'Analysis provenance', 'cursor-pointer font-semibold'),
      element(
        'p',
        `Observed ${state.board.source.provenance.observedFrom} to ${state.board.source.provenance.observedTo}.`,
        `mt-3 break-words text-sm ${mutedClass}`,
      ),
      element(
        'p',
        `${state.board.source.provenance.analysisSelection.selectedCounts.comments} comments and ${state.board.source.provenance.analysisSelection.selectedCounts.files} files were selected within bounded input limits.`,
        `mt-3 text-sm ${mutedClass}`,
      ),
    );
    const selectedFiles =
      state.board.source.provenance.analysisSelection.selectedFiles;
    if (selectedFiles.length) {
      provenance.append(element('h3', 'Selected files', 'mt-4 font-semibold'));
      const list = element(
        'ul',
        undefined,
        'mt-2 list-disc space-y-1 pl-5 text-sm',
      );
      for (const file of selectedFiles)
        list.append(
          element('li', `${file.path} · ${file.relevanceClass}`, 'break-all'),
        );
      provenance.append(list);
    }
    const limitations = [
      ...state.board.source.provenance.limitations,
      ...state.board.source.provenance.analysisSelection.limitations,
    ];
    if (limitations.length) {
      provenance.append(
        element('h3', 'Bounds and limitations', 'mt-4 font-semibold'),
      );
      const list = element(
        'ul',
        undefined,
        'mt-2 list-disc space-y-1 pl-5 text-sm',
      );
      for (const limitation of limitations)
        list.append(element('li', limitation));
      provenance.append(list);
    }
    section.append(provenance);
    mount.append(section);
  }

  function paintComparison() {
    if (!state.board.comparison) return;
    const comparison = state.board.comparison;
    const section = element('section', undefined, `${boxClass} mt-6`);
    section.setAttribute('aria-labelledby', 'saved-comparison-title');
    const title = element('h2', 'Saved report comparison', 'text-xl font-bold');
    title.id = 'saved-comparison-title';
    section.append(
      title,
      element('p', comparisonLabels[comparison.status], `mt-3 ${mutedClass}`),
    );
    if (comparison.entries.length) {
      const visible = comparison.entries.slice(0, 200);
      const list = element('ul', undefined, 'mt-4 list-disc space-y-2 pl-5');
      for (const entry of visible)
        list.append(element('li', comparisonDescription(entry)));
      section.append(list);
      if (visible.length < comparison.entries.length)
        section.append(
          element(
            'p',
            `${comparison.entries.length - visible.length} additional saved changes are not expanded in this view.`,
            `mt-3 text-sm ${mutedClass}`,
          ),
        );
    }
    mount.append(section);
  }

  function paintSummaryDetails(parent, summary) {
    const details = element(
      'details',
      undefined,
      'mt-5 border-t border-slate-300 pt-5 dark:border-slate-700',
    );
    details.append(
      element(
        'summary',
        'GitHub check details',
        'cursor-pointer font-semibold',
      ),
      element(
        'p',
        `Checked ${formatDate(summary.sync.at)} on ${summary.sync.branch}.`,
        `mt-3 ${mutedClass}`,
      ),
      element(
        'p',
        `Source fingerprint: ${summary.fingerprint.value}`,
        `mt-3 break-all font-mono text-xs ${mutedClass}`,
      ),
    );
    const counts = element(
      'dl',
      undefined,
      'mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3',
    );
    for (const [key, label] of Object.entries(countLabels)) {
      const entry = element('div');
      entry.append(
        element('dt', label, `text-sm ${mutedClass}`),
        element('dd', String(summary.counts[key]), 'mt-1 text-lg font-bold'),
      );
      counts.append(entry);
    }
    details.append(counts);
    if (summary.provenance.files.length) {
      details.append(element('h3', 'Selected files', 'mt-4 font-semibold'));
      const files = element(
        'ul',
        undefined,
        'mt-2 list-disc space-y-1 pl-5 text-sm',
      );
      for (const file of summary.provenance.files)
        files.append(element('li', file.path, 'break-all'));
      details.append(files);
    }
    if (summary.provenance.limitations.length) {
      details.append(
        element(
          'h3',
          'Collection limits and uncertainty',
          'mt-4 font-semibold',
        ),
      );
      const limitations = element(
        'ul',
        undefined,
        'mt-2 list-disc space-y-2 pl-5 text-sm',
      );
      for (const limitation of summary.provenance.limitations)
        limitations.append(element('li', limitation));
      details.append(limitations);
    }
    parent.append(details);
  }

  const restore = () => bootstrap();
  const pageShow = (event) => {
    if (event.persisted) bootstrap();
  };
  const pageHide = () => clearProtected();
  window.addEventListener('popstate', restore);
  window.addEventListener('pageshow', pageShow);
  window.addEventListener('pagehide', pageHide);
  bootstrap();

  return () => {
    stopped = true;
    clearProtected();
    window.removeEventListener('popstate', restore);
    window.removeEventListener('pageshow', pageShow);
    window.removeEventListener('pagehide', pageHide);
  };
}
