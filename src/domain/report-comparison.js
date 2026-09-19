const REPORT_COMPARISON_SCHEMA_VERSION = 1;

const REPORT_COMPARISON_LIMITS = Object.freeze({
  entries: 6_000,
  fieldsPerEntry: 16,
  arrayLength: 2_000,
  textCodePoints: 20_000,
  totalTextCodePoints: 500_000,
  bytes: 1_048_576,
  depth: 10,
  nodes: 50_000,
  errors: 100,
});

const ISSUE_FIELDS = Object.freeze([
  'title',
  'milestone',
  'assignees',
  'inProgress',
  'waitingOn',
  'blockedBecause',
  'after',
  'uncertainty',
  'sameBranchAs',
  'laneKey',
  'short',
]);
const LANE_FIELDS = Object.freeze(['mode', 'issues', 'name', 'owns', 'note']);
const START_FIELDS = Object.freeze(['why', 'touches']);
const CLAIM_FIELDS = Object.freeze(['issues', 'query']);
const PROSE_FIELDS = Object.freeze([
  'summary',
  'notes.startNow',
  'notes.blocked',
  'notes.contention',
]);

const KIND_FIELDS = Object.freeze({
  board: Object.freeze(['board', 'title', 'repo', 'repoUrl']),
  'issue-closed': Object.freeze(['issue']),
  'issue-opened': Object.freeze(['issue']),
  issue: ISSUE_FIELDS,
  'start-added': Object.freeze(['start']),
  'start-removed': Object.freeze(['start']),
  'lane-added': Object.freeze(['lane']),
  'lane-removed': Object.freeze(['lane']),
  lane: LANE_FIELDS,
  'lane-order': Object.freeze(['order']),
  start: START_FIELDS,
  'start-order': Object.freeze(['order']),
  'claim-added': Object.freeze(['claim']),
  'claim-removed': Object.freeze(['claim']),
  claim: CLAIM_FIELDS,
  'claim-order': Object.freeze(['order']),
  contention: Object.freeze(['rowLabel', 'milestones']),
  prose: PROSE_FIELDS,
});

const ENTRY_IDENTITIES = Object.freeze({
  board: [],
  'issue-closed': ['issueNumber'],
  'issue-opened': ['issueNumber'],
  issue: ['issueNumber'],
  'start-added': ['issueNumber'],
  'start-removed': ['issueNumber'],
  'lane-added': ['laneKey'],
  'lane-removed': ['laneKey'],
  lane: ['laneKey'],
  'lane-order': [],
  start: ['issueNumber'],
  'start-order': [],
  'claim-added': ['claimName'],
  'claim-removed': ['claimName'],
  claim: ['claimName'],
  'claim-order': [],
  contention: [],
  prose: [],
});

const ADD_KINDS = new Set([
  'issue-opened',
  'start-added',
  'lane-added',
  'claim-added',
]);
const REMOVE_KINDS = new Set([
  'issue-closed',
  'start-removed',
  'lane-removed',
  'claim-removed',
]);

function plainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value))
    return '[' + value.map((entry) => stableStringify(entry)).join(',') + ']';
  if (plainObject(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

function same(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function by(values, key) {
  return new Map((values ?? []).map((value) => [key(value), value]));
}

function sharedOrderChanged(before, after) {
  const left = before.filter((value) => after.includes(value));
  const right = after.filter((value) => before.includes(value));
  return !same(left, right);
}

function effectiveRepoUrl(report) {
  return (report.repoUrl ?? `https://github.com/${report.repo}`).replace(
    /\/+$/u,
    '',
  );
}

function effectiveClaimQuery(claim) {
  return claim.query || `is:open ${claim.name}`;
}

function issueMap(report) {
  return by(report.issues ?? [], (issue) => issue.number);
}

function laneMap(report) {
  return by(report.lanes ?? [], (lane) => lane.key);
}

function laneByIssue(report) {
  const result = new Map();
  for (const lane of report.lanes ?? [])
    for (const number of lane.issues ?? []) result.set(number, lane.key);
  return result;
}

function startMap(report) {
  return by(report.startNow ?? [], (pick) => pick.issue);
}

function claims(report) {
  return report.contention?.claims ?? [];
}

function claimMap(report) {
  return by(claims(report), (claim) => claim.name);
}

function visibleReference(reference, { title = true } = {}) {
  if (!plainObject(reference)) return reference;
  const projected = clone(reference);
  if (!title) delete projected.title;
  return projected;
}

function visibleUncertainty(uncertainty) {
  if (uncertainty == null) return null;
  return {
    reason: uncertainty.reason,
    reference:
      uncertainty.reference == null
        ? null
        : visibleReference(uncertainty.reference, { title: false }),
  };
}

function visibleIssue(issue, laneKey) {
  return {
    number: issue.number,
    title: issue.title,
    short: issue.short ?? null,
    milestone: issue.milestone ?? null,
    assignees: clone(issue.assignees ?? []),
    inProgress: issue.inProgress ?? null,
    waitingOn: clone(issue.waitingOn ?? []),
    blockedBecause: issue.blockedBecause ?? null,
    after: (issue.after ?? []).map((reference) =>
      visibleReference(reference, { title: false }),
    ),
    uncertainty: visibleUncertainty(issue.uncertainty),
    sameBranchAs: issue.sameBranchAs ?? null,
    laneKey: laneKey ?? null,
  };
}

function visibleLane(lane) {
  return {
    key: lane.key,
    name: lane.name,
    mode: lane.mode,
    issues: [...lane.issues],
    owns: lane.owns ?? null,
    note: lane.note ?? null,
  };
}

function visibleStart(pick) {
  return {
    issue: pick.issue,
    why: pick.why,
    touches: pick.touches ?? null,
  };
}

function visibleClaim(claim) {
  return {
    name: claim.name,
    query: effectiveClaimQuery(claim),
    issues: [...claim.issues],
  };
}

function visibleShorts(report) {
  const visible = new Set((report.startNow ?? []).map((pick) => pick.issue));
  for (const issue of report.issues ?? []) {
    if ((issue.waitingOn ?? []).length) visible.add(issue.number);
    for (const reference of issue.waitingOn ?? [])
      if (typeof reference === 'number') visible.add(reference);
  }
  return visible;
}

function drawnMilestones(report) {
  const claimed = new Set();
  const issues = issueMap(report);
  for (const claim of claims(report))
    for (const number of claim.issues ?? []) {
      const milestone = issues.get(number)?.milestone;
      if (milestone != null) claimed.add(milestone);
    }
  return (report.milestones ?? [])
    .filter((milestone) => claimed.has(milestone.title))
    .map((milestone) => ({
      title: milestone.title,
      label: milestone.short || milestone.title,
    }));
}

function rowLabel(report) {
  return report.contention?.rowLabel || 'Plugin';
}

function entry(kind, identity, fields, before, after) {
  return {
    kind,
    ...identity,
    fields,
    before,
    after,
  };
}

function changedProjection(before, after, orderedFields) {
  const fields = orderedFields.filter(
    (field) => !same(before[field], after[field]),
  );
  if (!fields.length) return null;
  return {
    fields,
    before: Object.fromEntries(
      fields.map((field) => [field, clone(before[field])]),
    ),
    after: Object.fromEntries(
      fields.map((field) => [field, clone(after[field])]),
    ),
  };
}

/** Return deterministic reader-visible changes between two validated reports. */
function compareReports(previous, current) {
  const entries = [];
  const oldIssues = issueMap(previous);
  const newIssues = issueMap(current);
  const oldLanesByIssue = laneByIssue(previous);
  const newLanesByIssue = laneByIssue(current);
  const oldLanes = laneMap(previous);
  const newLanes = laneMap(current);
  const oldStarts = startMap(previous);
  const newStarts = startMap(current);
  const oldClaims = claimMap(previous);
  const newClaims = claimMap(current);

  const boardBefore = {
    board: previous.board ?? null,
    title: previous.title ?? null,
    repo: previous.repo ?? null,
    repoUrl: previous.repoUrl ?? null,
  };
  const boardAfter = {
    board: current.board ?? null,
    title: current.title ?? null,
    repo: current.repo ?? null,
    repoUrl: current.repoUrl ?? null,
  };
  const boardFields = ['board', 'title', 'repo'].filter(
    (field) => !same(boardBefore[field], boardAfter[field]),
  );
  if (
    (previous.repoUrl != null || current.repoUrl != null) &&
    effectiveRepoUrl(previous) !== effectiveRepoUrl(current)
  )
    boardFields.push('repoUrl');
  if (boardFields.length)
    entries.push(
      entry(
        'board',
        {},
        boardFields,
        Object.fromEntries(
          boardFields.map((field) => [field, boardBefore[field]]),
        ),
        Object.fromEntries(
          boardFields.map((field) => [field, boardAfter[field]]),
        ),
      ),
    );

  for (const issue of previous.issues ?? [])
    if (!newIssues.has(issue.number))
      entries.push(
        entry(
          'issue-closed',
          { issueNumber: issue.number },
          ['issue'],
          { issue: visibleIssue(issue, oldLanesByIssue.get(issue.number)) },
          null,
        ),
      );
  for (const issue of current.issues ?? [])
    if (!oldIssues.has(issue.number))
      entries.push(
        entry('issue-opened', { issueNumber: issue.number }, ['issue'], null, {
          issue: visibleIssue(issue, newLanesByIssue.get(issue.number)),
        }),
      );

  const shownShorts = new Set([
    ...visibleShorts(previous),
    ...visibleShorts(current),
  ]);
  for (const issue of current.issues ?? []) {
    const old = oldIssues.get(issue.number);
    if (!old) continue;
    const before = {
      title: old.title,
      milestone: old.milestone ?? null,
      assignees: clone(old.assignees ?? []),
      inProgress: old.inProgress ?? null,
      waitingOn: clone(old.waitingOn ?? []),
      blockedBecause: old.blockedBecause ?? null,
      after: (old.after ?? []).map((reference) =>
        visibleReference(reference, { title: false }),
      ),
      uncertainty: visibleUncertainty(old.uncertainty),
      sameBranchAs: old.sameBranchAs ?? null,
      laneKey: oldLanesByIssue.get(issue.number) ?? null,
      short: shownShorts.has(issue.number) ? (old.short ?? null) : null,
    };
    const after = {
      title: issue.title,
      milestone: issue.milestone ?? null,
      assignees: clone(issue.assignees ?? []),
      inProgress: issue.inProgress ?? null,
      waitingOn: clone(issue.waitingOn ?? []),
      blockedBecause: issue.blockedBecause ?? null,
      after: (issue.after ?? []).map((reference) =>
        visibleReference(reference, { title: false }),
      ),
      uncertainty: visibleUncertainty(issue.uncertainty),
      sameBranchAs: issue.sameBranchAs ?? null,
      laneKey: newLanesByIssue.get(issue.number) ?? null,
      short: shownShorts.has(issue.number) ? (issue.short ?? null) : null,
    };
    const change = changedProjection(before, after, ISSUE_FIELDS);
    if (change)
      entries.push(
        entry(
          'issue',
          { issueNumber: issue.number },
          change.fields,
          change.before,
          change.after,
        ),
      );
  }

  for (const pick of current.startNow ?? [])
    if (!oldStarts.has(pick.issue))
      entries.push(
        entry('start-added', { issueNumber: pick.issue }, ['start'], null, {
          start: visibleStart(pick),
        }),
      );
  for (const pick of previous.startNow ?? [])
    if (!newStarts.has(pick.issue))
      entries.push(
        entry(
          'start-removed',
          { issueNumber: pick.issue },
          ['start'],
          { start: visibleStart(pick) },
          null,
        ),
      );

  for (const lane of current.lanes ?? [])
    if (!oldLanes.has(lane.key))
      entries.push(
        entry('lane-added', { laneKey: lane.key }, ['lane'], null, {
          lane: visibleLane(lane),
        }),
      );
  for (const lane of previous.lanes ?? [])
    if (!newLanes.has(lane.key))
      entries.push(
        entry(
          'lane-removed',
          { laneKey: lane.key },
          ['lane'],
          { lane: visibleLane(lane) },
          null,
        ),
      );
  for (const lane of current.lanes ?? []) {
    const old = oldLanes.get(lane.key);
    if (!old) continue;
    const before = {
      mode: old.mode,
      issues: sharedOrderChanged(old.issues, lane.issues)
        ? [...old.issues]
        : [...lane.issues],
      name: old.name,
      owns: old.owns ?? null,
      note: old.note ?? null,
    };
    const after = {
      mode: lane.mode,
      issues: [...lane.issues],
      name: lane.name,
      owns: lane.owns ?? null,
      note: lane.note ?? null,
    };
    const change = changedProjection(before, after, LANE_FIELDS);
    if (change)
      entries.push(
        entry(
          'lane',
          { laneKey: lane.key },
          change.fields,
          change.before,
          change.after,
        ),
      );
  }
  const oldLaneOrder = (previous.lanes ?? []).map((lane) => lane.key);
  const newLaneOrder = (current.lanes ?? []).map((lane) => lane.key);
  if (sharedOrderChanged(oldLaneOrder, newLaneOrder))
    entries.push(
      entry(
        'lane-order',
        {},
        ['order'],
        { order: oldLaneOrder },
        { order: newLaneOrder },
      ),
    );

  for (const pick of current.startNow ?? []) {
    const old = oldStarts.get(pick.issue);
    if (!old) continue;
    const change = changedProjection(
      { why: old.why, touches: old.touches ?? null },
      { why: pick.why, touches: pick.touches ?? null },
      START_FIELDS,
    );
    if (change)
      entries.push(
        entry(
          'start',
          { issueNumber: pick.issue },
          change.fields,
          change.before,
          change.after,
        ),
      );
  }
  const oldStartOrder = (previous.startNow ?? []).map((pick) => pick.issue);
  const newStartOrder = (current.startNow ?? []).map((pick) => pick.issue);
  if (sharedOrderChanged(oldStartOrder, newStartOrder))
    entries.push(
      entry(
        'start-order',
        {},
        ['order'],
        { order: oldStartOrder },
        { order: newStartOrder },
      ),
    );

  for (const claim of claims(current))
    if (!oldClaims.has(claim.name))
      entries.push(
        entry('claim-added', { claimName: claim.name }, ['claim'], null, {
          claim: visibleClaim(claim),
        }),
      );
  for (const claim of claims(previous))
    if (!newClaims.has(claim.name))
      entries.push(
        entry(
          'claim-removed',
          { claimName: claim.name },
          ['claim'],
          { claim: visibleClaim(claim) },
          null,
        ),
      );
  for (const claim of claims(current)) {
    const old = oldClaims.get(claim.name);
    if (!old) continue;
    const change = changedProjection(
      { issues: [...old.issues], query: effectiveClaimQuery(old) },
      { issues: [...claim.issues], query: effectiveClaimQuery(claim) },
      CLAIM_FIELDS,
    );
    if (change)
      entries.push(
        entry(
          'claim',
          { claimName: claim.name },
          change.fields,
          change.before,
          change.after,
        ),
      );
  }
  const oldClaimOrder = claims(previous).map((claim) => claim.name);
  const newClaimOrder = claims(current).map((claim) => claim.name);
  if (sharedOrderChanged(oldClaimOrder, newClaimOrder))
    entries.push(
      entry(
        'claim-order',
        {},
        ['order'],
        { order: oldClaimOrder },
        { order: newClaimOrder },
      ),
    );

  if (claims(previous).length && claims(current).length) {
    const contentionChange = changedProjection(
      {
        rowLabel: rowLabel(previous),
        milestones: drawnMilestones(previous),
      },
      { rowLabel: rowLabel(current), milestones: drawnMilestones(current) },
      ['rowLabel', 'milestones'],
    );
    if (contentionChange)
      entries.push(
        entry(
          'contention',
          {},
          contentionChange.fields,
          contentionChange.before,
          contentionChange.after,
        ),
      );
  }

  const compareContentionNote =
    claims(previous).length > 0 && claims(current).length > 0;
  const proseBefore = {
    summary: previous.summary,
    'notes.startNow': previous.notes?.startNow ?? null,
    'notes.blocked': previous.notes?.blocked ?? null,
    'notes.contention': compareContentionNote
      ? (previous.notes?.contention ?? null)
      : null,
  };
  const proseAfter = {
    summary: current.summary,
    'notes.startNow': current.notes?.startNow ?? null,
    'notes.blocked': current.notes?.blocked ?? null,
    'notes.contention': compareContentionNote
      ? (current.notes?.contention ?? null)
      : null,
  };
  const proseChange = changedProjection(proseBefore, proseAfter, PROSE_FIELDS);
  if (proseChange)
    entries.push(
      entry(
        'prose',
        {},
        proseChange.fields,
        proseChange.before,
        proseChange.after,
      ),
    );

  return entries;
}

function metadataOf(version) {
  return {
    reportId: version.reportId,
    generatedAt: version.generatedAt,
    sourceFingerprint: clone(
      version.sourceFingerprint ?? version.source?.fingerprint,
    ),
    sync: clone(version.sync ?? version.report?.sync),
  };
}

/** Create an initial, unchanged, or changed persisted comparison envelope. */
function createReportComparison(basis, result) {
  const entries =
    basis === null ? [] : compareReports(basis.report, result.report);
  return {
    schemaVersion: REPORT_COMPARISON_SCHEMA_VERSION,
    status:
      basis === null ? 'initial' : entries.length ? 'changed' : 'unchanged',
    basis: basis === null ? null : metadataOf(basis),
    result: metadataOf(result),
    entries,
  };
}

function createInitialComparison(result) {
  return createReportComparison(null, result);
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every((key) => typeof key === 'string') &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    own.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
    })
  );
}

function validTimestamp(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function inspectJson(value) {
  const pending = [{ value, depth: 0 }];
  const seen = new Set();
  let nodes = 0;
  let text = 0;
  while (pending.length) {
    const current = pending.pop();
    nodes += 1;
    if (
      nodes > REPORT_COMPARISON_LIMITS.nodes ||
      current.depth > REPORT_COMPARISON_LIMITS.depth
    )
      return false;
    if (typeof current.value === 'string') {
      const length = [...current.value].length;
      text += length;
      if (
        length > REPORT_COMPARISON_LIMITS.textCodePoints ||
        text > REPORT_COMPARISON_LIMITS.totalTextCodePoints ||
        /\p{Cc}/u.test(current.value)
      )
        return false;
      continue;
    }
    if (current.value === null || typeof current.value === 'boolean') continue;
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    if (typeof current.value !== 'object' || seen.has(current.value))
      return false;
    const array = Array.isArray(current.value);
    if (
      array
        ? Object.getPrototypeOf(current.value) !== Array.prototype
        : !plainObject(current.value)
    )
      return false;
    const keys = Reflect.ownKeys(current.value);
    if (array) {
      if (
        current.value.length > REPORT_COMPARISON_LIMITS.arrayLength ||
        keys.length !== current.value.length + 1
      )
        return false;
      for (let index = 0; index < current.value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          current.value,
          String(index),
        );
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
          return false;
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    } else {
      for (const key of keys) {
        if (typeof key !== 'string') return false;
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
          return false;
        text += [...key].length;
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }
    seen.add(current.value);
  }
  return text <= REPORT_COMPARISON_LIMITS.totalTextCodePoints;
}

function validSync(sync) {
  if (!plainObject(sync)) return false;
  const allowed = new Set([
    'at',
    'timeZone',
    'branch',
    'commit',
    'openPullRequests',
    'extra',
  ]);
  if (
    Object.keys(sync).some((key) => !allowed.has(key)) ||
    !validTimestamp(sync.at) ||
    typeof sync.branch !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sync.commit)
  )
    return false;
  if (sync.timeZone != null && typeof sync.timeZone !== 'string') return false;
  if (
    sync.openPullRequests != null &&
    (!Number.isSafeInteger(sync.openPullRequests) || sync.openPullRequests < 0)
  )
    return false;
  return (
    sync.extra == null ||
    (Array.isArray(sync.extra) &&
      sync.extra.every((value) => typeof value === 'string'))
  );
}

function validMetadata(metadata) {
  return (
    exactKeys(metadata, [
      'reportId',
      'generatedAt',
      'sourceFingerprint',
      'sync',
    ]) &&
    typeof metadata.reportId === 'string' &&
    metadata.reportId.length > 0 &&
    metadata.reportId.length <= 200 &&
    validTimestamp(metadata.generatedAt) &&
    exactKeys(metadata.sourceFingerprint, ['algorithm', 'value', 'scope']) &&
    metadata.sourceFingerprint.algorithm === 'sha256' &&
    /^[0-9a-f]{64}$/u.test(metadata.sourceFingerprint.value) &&
    metadata.sourceFingerprint.scope === 'core-and-collected-context' &&
    validSync(metadata.sync)
  );
}

function expectedEntryKeys(kind) {
  const identities = ENTRY_IDENTITIES[kind];
  return identities == null
    ? null
    : ['kind', ...identities, 'fields', 'before', 'after'];
}

function validSnapshot(field, value) {
  if (field === 'issue')
    return (
      plainObject(value) &&
      exactKeys(value, [
        'number',
        'title',
        'short',
        'milestone',
        'assignees',
        'inProgress',
        'waitingOn',
        'blockedBecause',
        'after',
        'uncertainty',
        'sameBranchAs',
        'laneKey',
      ]) &&
      positiveInteger(value.number)
    );
  if (field === 'lane')
    return (
      plainObject(value) &&
      exactKeys(value, ['key', 'name', 'mode', 'issues', 'owns', 'note']) &&
      typeof value.key === 'string' &&
      Array.isArray(value.issues)
    );
  if (field === 'start')
    return (
      plainObject(value) &&
      exactKeys(value, ['issue', 'why', 'touches']) &&
      positiveInteger(value.issue)
    );
  if (field === 'claim')
    return (
      plainObject(value) &&
      exactKeys(value, ['name', 'query', 'issues']) &&
      typeof value.name === 'string' &&
      typeof value.query === 'string' &&
      Array.isArray(value.issues)
    );
  if (
    [
      'issues',
      'order',
      'waitingOn',
      'after',
      'assignees',
      'milestones',
    ].includes(field)
  )
    return Array.isArray(value);
  if (['sameBranchAs', 'issueNumber'].includes(field))
    return value === null || positiveInteger(value);
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    plainObject(value)
  );
}

/** Strictly validate a saved deterministic comparison envelope. */
function validateReportComparison(comparison) {
  const errors = [];
  const add = (path, code, message) => {
    if (errors.length < REPORT_COMPARISON_LIMITS.errors)
      errors.push({ path, code, message });
  };
  const check = (condition, path, code, message) => {
    if (!condition) add(path, code, message);
    return condition;
  };
  try {
    if (
      !check(
        inspectJson(comparison),
        'comparison',
        'not_json',
        'Expected bounded plain dense JSON.',
      )
    )
      return { valid: false, errors };
    const bytes = new TextEncoder().encode(
      JSON.stringify(comparison),
    ).byteLength;
    check(
      bytes <= REPORT_COMPARISON_LIMITS.bytes,
      'comparison',
      'size_limit',
      'The comparison exceeds its byte limit.',
    );
    if (
      !check(
        exactKeys(comparison, [
          'schemaVersion',
          'status',
          'basis',
          'result',
          'entries',
        ]),
        'comparison',
        'fields',
        'Unexpected comparison fields.',
      )
    )
      return { valid: false, errors };
    check(
      comparison.schemaVersion === REPORT_COMPARISON_SCHEMA_VERSION,
      'comparison.schemaVersion',
      'version',
      'Unsupported comparison schema version.',
    );
    check(
      ['initial', 'unchanged', 'changed'].includes(comparison.status),
      'comparison.status',
      'enum',
      'Unknown comparison status.',
    );
    check(
      validMetadata(comparison.result),
      'comparison.result',
      'metadata',
      'Invalid result metadata.',
    );
    check(
      comparison.status === 'initial'
        ? comparison.basis === null
        : validMetadata(comparison.basis),
      'comparison.basis',
      'metadata',
      'Initial comparisons have no basis; refresh comparisons require one.',
    );
    check(
      Array.isArray(comparison.entries) &&
        comparison.entries.length <= REPORT_COMPARISON_LIMITS.entries,
      'comparison.entries',
      'type',
      'Expected a bounded comparison entry list.',
    );
    if (Array.isArray(comparison.entries)) {
      check(
        comparison.status === 'changed'
          ? comparison.entries.length > 0
          : comparison.entries.length === 0,
        'comparison.entries',
        'status',
        'Only changed comparisons may contain entries.',
      );
      comparison.entries.forEach((item, index) => {
        const path = `comparison.entries.${index}`;
        const keys = expectedEntryKeys(item?.kind);
        if (
          !check(
            keys !== null && exactKeys(item, keys),
            path,
            'fields',
            'Invalid fields for comparison kind.',
          )
        )
          return;
        for (const identity of ENTRY_IDENTITIES[item.kind]) {
          if (identity === 'issueNumber')
            check(
              positiveInteger(item[identity]),
              `${path}.${identity}`,
              'identity',
              'Expected a positive issue number.',
            );
          else
            check(
              typeof item[identity] === 'string' && item[identity].length > 0,
              `${path}.${identity}`,
              'identity',
              'Expected a nonempty comparison identity.',
            );
        }
        check(
          Array.isArray(item.fields) &&
            item.fields.length > 0 &&
            item.fields.length <= REPORT_COMPARISON_LIMITS.fieldsPerEntry &&
            new Set(item.fields).size === item.fields.length &&
            item.fields.every((field) =>
              KIND_FIELDS[item.kind].includes(field),
            ) &&
            item.fields.every(
              (field, fieldIndex) =>
                KIND_FIELDS[item.kind].indexOf(field) >
                (fieldIndex === 0
                  ? -1
                  : KIND_FIELDS[item.kind].indexOf(
                      item.fields[fieldIndex - 1],
                    )),
            ),
          `${path}.fields`,
          'fields',
          'Comparison fields must be unique, known, and canonically ordered.',
        );
        const expectsNullBefore = ADD_KINDS.has(item.kind);
        const expectsNullAfter = REMOVE_KINDS.has(item.kind);
        check(
          expectsNullBefore
            ? item.before === null
            : plainObject(item.before) &&
                exactKeys(item.before, item.fields) &&
                item.fields.every((field) =>
                  validSnapshot(field, item.before[field]),
                ),
          `${path}.before`,
          'shape',
          'Invalid before value for comparison kind.',
        );
        check(
          expectsNullAfter
            ? item.after === null
            : plainObject(item.after) &&
                exactKeys(item.after, item.fields) &&
                item.fields.every((field) =>
                  validSnapshot(field, item.after[field]),
                ),
          `${path}.after`,
          'shape',
          'Invalid after value for comparison kind.',
        );
        if (!expectsNullBefore && !expectsNullAfter)
          check(
            item.fields.every(
              (field) => !same(item.before[field], item.after[field]),
            ),
            path,
            'unchanged',
            'Every recorded field must change.',
          );
      });
    }
  } catch {
    add(
      'comparison',
      'malformed_input',
      'The comparison could not be inspected safely.',
    );
  }
  return { valid: errors.length === 0, errors };
}

export {
  REPORT_COMPARISON_LIMITS,
  REPORT_COMPARISON_SCHEMA_VERSION,
  compareReports,
  createInitialComparison,
  createReportComparison,
  effectiveClaimQuery,
  validateReportComparison,
};
