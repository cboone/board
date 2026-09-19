import { deriveReport } from './lane-model.js';
import { validateReport } from './report-contract.js';

const ANALYSIS_WIRE_VERSION = 1;

const ANALYSIS_WIRE_LIMITS = Object.freeze({
  bytes: 1_048_576,
  issues: 1_000,
  lanes: 1_000,
  starts: 1_000,
  claims: 1_000,
  referencesPerIssue: 100,
  errors: 100,
  totalTextCodePoints: 500_000,
  summaryCodePoints: 8_000,
  proseCodePoints: 8_000,
  shortCodePoints: 240,
  nameCodePoints: 240,
  keyCodePoints: 100,
  queryCodePoints: 2_000,
});

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const referenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'target', 'label', 'title'],
  properties: {
    kind: {
      type: 'string',
      enum: ['none', 'issue', 'pr', 'branch', 'ref', 'url'],
    },
    target: { type: 'string', maxLength: ANALYSIS_WIRE_LIMITS.proseCodePoints },
    label: { type: 'string', maxLength: ANALYSIS_WIRE_LIMITS.nameCodePoints },
    title: { type: 'string', maxLength: ANALYSIS_WIRE_LIMITS.proseCodePoints },
  },
};

const ANALYSIS_DELTA_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'issueAnalysis',
    'lanes',
    'startNow',
    'contention',
    'notes',
  ],
  properties: {
    summary: {
      type: 'string',
      maxLength: ANALYSIS_WIRE_LIMITS.summaryCodePoints,
    },
    issueAnalysis: {
      type: 'array',
      maxItems: ANALYSIS_WIRE_LIMITS.issues,
      items: { $ref: '#/$defs/issueAnalysis' },
    },
    lanes: {
      type: 'array',
      maxItems: ANALYSIS_WIRE_LIMITS.lanes,
      items: { $ref: '#/$defs/lane' },
    },
    startNow: {
      type: 'array',
      maxItems: ANALYSIS_WIRE_LIMITS.starts,
      items: { $ref: '#/$defs/pick' },
    },
    contention: { $ref: '#/$defs/contention' },
    notes: { $ref: '#/$defs/notes' },
  },
  $defs: {
    reference: referenceSchema,
    issueAnalysis: {
      type: 'object',
      additionalProperties: false,
      required: [
        'issue',
        'short',
        'waitingOn',
        'blockedBecause',
        'after',
        'sameBranchAs',
        'uncertaintyReason',
        'uncertaintyReference',
      ],
      properties: {
        issue: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
        short: {
          type: 'string',
          maxLength: ANALYSIS_WIRE_LIMITS.shortCodePoints,
        },
        waitingOn: {
          type: 'array',
          maxItems: ANALYSIS_WIRE_LIMITS.referencesPerIssue,
          items: { $ref: '#/$defs/reference' },
        },
        blockedBecause: {
          type: 'string',
          maxLength: ANALYSIS_WIRE_LIMITS.proseCodePoints,
        },
        after: {
          type: 'array',
          maxItems: ANALYSIS_WIRE_LIMITS.referencesPerIssue,
          items: { $ref: '#/$defs/reference' },
        },
        sameBranchAs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_SAFE_INTEGER,
        },
        uncertaintyReason: {
          type: 'string',
          maxLength: ANALYSIS_WIRE_LIMITS.proseCodePoints,
        },
        uncertaintyReference: { $ref: '#/$defs/reference' },
      },
    },
    lane: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'name', 'mode', 'issues', 'owns', 'note'],
      properties: {
        key: {
          type: 'string',
          minLength: 1,
          maxLength: ANALYSIS_WIRE_LIMITS.keyCodePoints,
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: ANALYSIS_WIRE_LIMITS.nameCodePoints,
        },
        mode: { type: 'string', enum: ['serial', 'head', 'any'] },
        issues: {
          type: 'array',
          minItems: 1,
          maxItems: ANALYSIS_WIRE_LIMITS.issues,
          items: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
        },
        owns: {
          type: 'string',
          maxLength: ANALYSIS_WIRE_LIMITS.proseCodePoints,
        },
        note: {
          type: 'string',
          maxLength: ANALYSIS_WIRE_LIMITS.proseCodePoints,
        },
      },
    },
    pick: {
      type: 'object',
      additionalProperties: false,
      required: ['issue', 'why', 'touches'],
      properties: {
        issue: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
        why: {
          type: 'string',
          minLength: 1,
          maxLength: ANALYSIS_WIRE_LIMITS.proseCodePoints,
        },
        touches: {
          type: 'string',
          maxLength: ANALYSIS_WIRE_LIMITS.proseCodePoints,
        },
      },
    },
    claim: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'query', 'issues'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: ANALYSIS_WIRE_LIMITS.nameCodePoints,
        },
        query: {
          type: 'string',
          maxLength: ANALYSIS_WIRE_LIMITS.queryCodePoints,
        },
        issues: {
          type: 'array',
          minItems: 2,
          maxItems: ANALYSIS_WIRE_LIMITS.issues,
          items: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
        },
      },
    },
    contention: {
      type: 'object',
      additionalProperties: false,
      required: ['rowLabel', 'claims'],
      properties: {
        rowLabel: {
          type: 'string',
          maxLength: ANALYSIS_WIRE_LIMITS.nameCodePoints,
        },
        claims: {
          type: 'array',
          maxItems: ANALYSIS_WIRE_LIMITS.claims,
          items: { $ref: '#/$defs/claim' },
        },
      },
    },
    notes: {
      type: 'object',
      additionalProperties: false,
      required: ['startNow', 'blocked', 'contention'],
      properties: Object.fromEntries(
        ['startNow', 'blocked', 'contention'].map((key) => [
          key,
          {
            type: 'string',
            maxLength: ANALYSIS_WIRE_LIMITS.proseCodePoints,
          },
        ]),
      ),
    },
  },
});

const objectKeys = Object.freeze({
  delta: [
    'summary',
    'issueAnalysis',
    'lanes',
    'startNow',
    'contention',
    'notes',
  ],
  issue: [
    'issue',
    'short',
    'waitingOn',
    'blockedBecause',
    'after',
    'sameBranchAs',
    'uncertaintyReason',
    'uncertaintyReference',
  ],
  reference: ['kind', 'target', 'label', 'title'],
  lane: ['key', 'name', 'mode', 'issues', 'owns', 'note'],
  pick: ['issue', 'why', 'touches'],
  contention: ['rowLabel', 'claims'],
  claim: ['name', 'query', 'issues'],
  notes: ['startNow', 'blocked', 'contention'],
});

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

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

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  const own = Reflect.ownKeys(value);
  if (own.some((key) => typeof key !== 'string')) return false;
  return (
    own.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    own.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
    })
  );
}

function codePoints(value) {
  return [...value].length;
}

function safeString(value, maximum, { empty = false, prose = false } = {}) {
  if (typeof value !== 'string') return false;
  const length = codePoints(value);
  if ((!empty && length === 0) || length > maximum) return false;
  if (/\p{Cc}/u.test(value)) return false;
  if (prose && /\u2014/u.test(value)) return false;
  if (
    prose &&
    /\b\d+(?:\.\d+)?\s*(?:hours?|days?|weeks?|months?|sprints?|story\s+points?)\b/iu.test(
      value,
    )
  )
    return false;
  return true;
}

function denseJson(value) {
  const pending = [value];
  const ancestors = new Set();
  while (pending.length) {
    const entry = pending.pop();
    if (entry === null || ['string', 'boolean'].includes(typeof entry))
      continue;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return false;
      continue;
    }
    if (typeof entry !== 'object') return false;
    if (ancestors.has(entry)) return false;
    const array = Array.isArray(entry);
    if (
      array
        ? Object.getPrototypeOf(entry) !== Array.prototype
        : !plainObject(entry)
    )
      return false;
    const keys = Reflect.ownKeys(entry);
    if (keys.some((key) => typeof key !== 'string')) return false;
    if (array) {
      if (keys.length !== entry.length + 1) return false;
      for (let index = 0; index < entry.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          entry,
          String(index),
        );
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
          return false;
        pending.push(descriptor.value);
      }
    } else {
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
          return false;
        pending.push(descriptor.value);
      }
    }
    ancestors.add(entry);
  }
  return true;
}

function integerTarget(value) {
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const number = Number(value);
  return positiveInteger(number) ? number : null;
}

function referenceFacts(entry) {
  return entry?.verifiedFactsOrReason ?? entry?.facts ?? null;
}

function referenceMatches(entry, target) {
  return [entry?.key, entry?.requested, entry?.normalizedTarget].includes(
    target,
  );
}

function hardReferenceAvailable(reference, analysisInput) {
  if (reference.kind === 'issue' || reference.kind === 'pr') return true;
  if (reference.kind === 'branch') {
    const branch = analysisInput.branches?.find(
      (entry) => entry?.name === reference.target,
    );
    return Boolean(
      branch &&
      branch.unmerged === true &&
      !['unverified', 'unknown'].includes(branch.verification),
    );
  }
  const entry = analysisInput.references?.find((candidate) =>
    referenceMatches(candidate, reference.target),
  );
  const facts = referenceFacts(entry);
  return Boolean(
    entry?.verification === 'verified' &&
    facts &&
    (facts.state === 'open' || facts.status === 'open'),
  );
}

/** Validate the complete model-facing analysis delta against its source IDs. */
function validateAnalysisDelta(delta, analysisInput) {
  const errors = [];
  let totalText = 0;
  const add = (path, code, message) => {
    if (errors.length < ANALYSIS_WIRE_LIMITS.errors)
      errors.push({ path, code, message });
  };
  const check = (condition, path, code, message) => {
    if (!condition) add(path, code, message);
    return condition;
  };
  const text = (value, path, maximum, options) => {
    const valid = safeString(value, maximum, options);
    check(valid, path, 'text', 'Expected bounded safe text.');
    if (typeof value === 'string') totalText += codePoints(value);
    return valid;
  };
  try {
    if (
      !check(
        denseJson(delta),
        'analysisDelta',
        'not_json',
        'Expected plain dense JSON.',
      )
    )
      return { valid: false, errors };
    let encoded;
    try {
      encoded = new TextEncoder().encode(JSON.stringify(delta)).byteLength;
    } catch {
      encoded = ANALYSIS_WIRE_LIMITS.bytes + 1;
    }
    check(
      encoded <= ANALYSIS_WIRE_LIMITS.bytes,
      'analysisDelta',
      'size_limit',
      'The analysis delta exceeds its byte limit.',
    );
    if (
      !check(
        exactKeys(delta, objectKeys.delta),
        'analysisDelta',
        'fields',
        'Expected exactly the six analysis fields.',
      )
    )
      return { valid: false, errors };

    const issueCatalog = Array.isArray(analysisInput?.issueCatalog)
      ? analysisInput.issueCatalog
      : [];
    const issueById = new Map(
      issueCatalog
        .filter((issue) => positiveInteger(issue?.id))
        .map((issue) => [issue.id, issue]),
    );
    check(
      issueCatalog.length === issueById.size &&
        issueCatalog.every(
          (issue) =>
            positiveInteger(issue?.number) &&
            issueCatalog.filter(
              (candidate) => candidate?.number === issue.number,
            ).length === 1,
        ) &&
        issueCatalog.length <= ANALYSIS_WIRE_LIMITS.issues,
      'analysisInput.issueCatalog',
      'source_binding',
      'Expected unique canonical issue IDs within the issue limit.',
    );
    const pullById = new Map(
      (Array.isArray(analysisInput?.pullRequests)
        ? analysisInput.pullRequests
        : []
      )
        .filter((pull) => positiveInteger(pull?.id))
        .map((pull) => [pull.id, pull]),
    );

    const validateReference = (reference, path, context, ownerId) => {
      if (
        !check(
          exactKeys(reference, objectKeys.reference),
          path,
          'fields',
          'Expected exactly kind, target, label, and title.',
        )
      )
        return false;
      check(
        ['none', 'issue', 'pr', 'branch', 'ref', 'url'].includes(
          reference.kind,
        ),
        `${path}.kind`,
        'enum',
        'Unknown reference kind.',
      );
      text(
        reference.target,
        `${path}.target`,
        ANALYSIS_WIRE_LIMITS.proseCodePoints,
        {
          empty: true,
        },
      );
      text(
        reference.label,
        `${path}.label`,
        ANALYSIS_WIRE_LIMITS.nameCodePoints,
        {
          empty: true,
          prose: true,
        },
      );
      text(
        reference.title,
        `${path}.title`,
        ANALYSIS_WIRE_LIMITS.proseCodePoints,
        {
          empty: true,
          prose: true,
        },
      );
      if (reference.kind === 'none') {
        check(
          context === 'uncertainty' &&
            reference.target === '' &&
            reference.label === '' &&
            reference.title === '',
          path,
          'sentinel',
          'The none sentinel is legal only as an empty uncertainty reference.',
        );
        return context === 'uncertainty';
      }
      check(
        reference.target !== '',
        `${path}.target`,
        'sentinel',
        'A real reference requires a target.',
      );
      if (reference.kind === 'issue') {
        const target = integerTarget(reference.target);
        check(
          target !== null && issueById.has(target),
          `${path}.target`,
          'source_binding',
          'Issue references must use a canonical issue ID.',
        );
        check(
          target !== ownerId,
          `${path}.target`,
          'self_reference',
          'An issue cannot reference itself.',
        );
        check(
          reference.label === '' && reference.title === '',
          path,
          'canonical_field',
          'Local issue display fields come from the canonical catalog.',
        );
      } else if (reference.kind === 'pr') {
        const target = integerTarget(reference.target);
        const pull = target === null ? null : pullById.get(target);
        check(
          Boolean(pull),
          `${path}.target`,
          'source_binding',
          'Pull request references must use a canonical open pull request ID.',
        );
        check(
          reference.label === '' &&
            (reference.title === '' || reference.title === pull?.title),
          path,
          'canonical_field',
          'Pull request display fields must be empty or canonical.',
        );
      } else if (reference.kind === 'branch') {
        const branch = analysisInput.branches?.find(
          (entry) => entry?.name === reference.target,
        );
        check(
          Boolean(branch),
          `${path}.target`,
          'source_binding',
          'Branch references must name a supplied branch.',
        );
        check(
          reference.label === '' && reference.title !== '',
          path,
          'sentinel',
          'A branch reference requires analysis title text and no label.',
        );
      } else {
        const sourceReference = analysisInput.references?.find((entry) =>
          referenceMatches(entry, reference.target),
        );
        check(
          Boolean(sourceReference),
          `${path}.target`,
          'source_binding',
          'External references must match a supplied reference target.',
        );
        check(
          reference.title !== '' &&
            (reference.kind !== 'url' || reference.label !== ''),
          path,
          'sentinel',
          'External references require their rendered analysis text.',
        );
      }
      if (context !== 'uncertainty')
        check(
          hardReferenceAvailable(reference, analysisInput),
          path,
          'unverified_reference',
          'Hard and soft dependencies must be verified and still open.',
        );
      return true;
    };

    text(
      delta.summary,
      'analysisDelta.summary',
      ANALYSIS_WIRE_LIMITS.summaryCodePoints,
      { prose: true },
    );
    check(
      Array.isArray(delta.issueAnalysis) &&
        delta.issueAnalysis.length <= ANALYSIS_WIRE_LIMITS.issues,
      'analysisDelta.issueAnalysis',
      'type',
      'Expected a bounded issue analysis list.',
    );
    const analyzed = new Set();
    if (Array.isArray(delta.issueAnalysis))
      delta.issueAnalysis.forEach((issue, index) => {
        const path = `analysisDelta.issueAnalysis.${index}`;
        if (
          !check(
            exactKeys(issue, objectKeys.issue),
            path,
            'fields',
            'Unexpected issue analysis fields.',
          )
        )
          return;
        check(
          positiveInteger(issue.issue) && issueById.has(issue.issue),
          `${path}.issue`,
          'source_binding',
          'Issue analysis must use a canonical issue ID.',
        );
        check(
          !analyzed.has(issue.issue),
          `${path}.issue`,
          'duplicate',
          'An issue may have at most one analysis object.',
        );
        analyzed.add(issue.issue);
        text(
          issue.short,
          `${path}.short`,
          ANALYSIS_WIRE_LIMITS.shortCodePoints,
          {
            empty: true,
            prose: true,
          },
        );
        for (const field of ['waitingOn', 'after']) {
          const values = issue[field];
          check(
            Array.isArray(values) &&
              values.length <= ANALYSIS_WIRE_LIMITS.referencesPerIssue,
            `${path}.${field}`,
            'type',
            'Expected a bounded reference list.',
          );
          if (Array.isArray(values))
            values.forEach((reference, referenceIndex) =>
              validateReference(
                reference,
                `${path}.${field}.${referenceIndex}`,
                field,
                issue.issue,
              ),
            );
        }
        text(
          issue.blockedBecause,
          `${path}.blockedBecause`,
          ANALYSIS_WIRE_LIMITS.proseCodePoints,
          { empty: true, prose: true },
        );
        if (Array.isArray(issue.waitingOn))
          check(
            (issue.waitingOn.length === 0) === (issue.blockedBecause === ''),
            `${path}.blockedBecause`,
            'sentinel',
            'A blocker reason is required exactly when hard blockers exist.',
          );
        check(
          issue.sameBranchAs === 0 ||
            (positiveInteger(issue.sameBranchAs) &&
              issueById.has(issue.sameBranchAs) &&
              issue.sameBranchAs !== issue.issue),
          `${path}.sameBranchAs`,
          'source_binding',
          'A branch companion must use another canonical issue ID or zero.',
        );
        text(
          issue.uncertaintyReason,
          `${path}.uncertaintyReason`,
          ANALYSIS_WIRE_LIMITS.proseCodePoints,
          { empty: true, prose: true },
        );
        validateReference(
          issue.uncertaintyReference,
          `${path}.uncertaintyReference`,
          'uncertainty',
          issue.issue,
        );
        check(
          issue.uncertaintyReason !== '' ||
            issue.uncertaintyReference?.kind === 'none',
          `${path}.uncertaintyReference`,
          'sentinel',
          'An uncertainty reference requires an uncertainty reason.',
        );
      });

    check(
      Array.isArray(delta.lanes) &&
        delta.lanes.length <= ANALYSIS_WIRE_LIMITS.lanes &&
        (issueById.size === 0 || delta.lanes.length > 0),
      'analysisDelta.lanes',
      'type',
      'Expected a bounded nonempty lane list.',
    );
    const laneKeys = new Set();
    const placed = new Map();
    if (Array.isArray(delta.lanes))
      delta.lanes.forEach((lane, index) => {
        const path = `analysisDelta.lanes.${index}`;
        if (
          !check(
            exactKeys(lane, objectKeys.lane),
            path,
            'fields',
            'Unexpected lane fields.',
          )
        )
          return;
        text(lane.key, `${path}.key`, ANALYSIS_WIRE_LIMITS.keyCodePoints);
        text(lane.name, `${path}.name`, ANALYSIS_WIRE_LIMITS.nameCodePoints, {
          prose: true,
        });
        check(
          !laneKeys.has(lane.key),
          `${path}.key`,
          'duplicate',
          'Lane keys must be unique.',
        );
        laneKeys.add(lane.key);
        check(
          ['serial', 'head', 'any'].includes(lane.mode),
          `${path}.mode`,
          'enum',
          'Unknown lane mode.',
        );
        check(
          Array.isArray(lane.issues) &&
            lane.issues.length > 0 &&
            lane.issues.length <= ANALYSIS_WIRE_LIMITS.issues,
          `${path}.issues`,
          'type',
          'Expected a bounded nonempty issue ID list.',
        );
        if (Array.isArray(lane.issues))
          lane.issues.forEach((id, issueIndex) => {
            check(
              positiveInteger(id) && issueById.has(id),
              `${path}.issues.${issueIndex}`,
              'source_binding',
              'Lane membership must use a canonical issue ID.',
            );
            check(
              !placed.has(id),
              `${path}.issues.${issueIndex}`,
              'duplicate',
              'Every issue must appear in exactly one lane.',
            );
            placed.set(id, lane.key);
          });
        text(lane.owns, `${path}.owns`, ANALYSIS_WIRE_LIMITS.proseCodePoints, {
          empty: true,
          prose: true,
        });
        text(lane.note, `${path}.note`, ANALYSIS_WIRE_LIMITS.proseCodePoints, {
          empty: true,
          prose: true,
        });
      });
    for (const id of issueById.keys())
      check(
        placed.has(id),
        'analysisDelta.lanes',
        'missing_issue',
        `Canonical issue ID ${id} is missing from all lanes.`,
      );

    check(
      Array.isArray(delta.startNow) &&
        delta.startNow.length <= ANALYSIS_WIRE_LIMITS.starts,
      'analysisDelta.startNow',
      'type',
      'Expected a bounded start list.',
    );
    const starts = new Set();
    if (Array.isArray(delta.startNow))
      delta.startNow.forEach((pick, index) => {
        const path = `analysisDelta.startNow.${index}`;
        if (
          !check(
            exactKeys(pick, objectKeys.pick),
            path,
            'fields',
            'Unexpected start fields.',
          )
        )
          return;
        check(
          positiveInteger(pick.issue) && issueById.has(pick.issue),
          `${path}.issue`,
          'source_binding',
          'Start picks must use canonical issue IDs.',
        );
        check(
          !starts.has(pick.issue),
          `${path}.issue`,
          'duplicate',
          'Start picks must be unique.',
        );
        starts.add(pick.issue);
        text(pick.why, `${path}.why`, ANALYSIS_WIRE_LIMITS.proseCodePoints, {
          prose: true,
        });
        text(
          pick.touches,
          `${path}.touches`,
          ANALYSIS_WIRE_LIMITS.proseCodePoints,
          {
            empty: true,
            prose: true,
          },
        );
      });

    if (
      check(
        exactKeys(delta.contention, objectKeys.contention),
        'analysisDelta.contention',
        'fields',
        'Unexpected contention fields.',
      )
    ) {
      text(
        delta.contention.rowLabel,
        'analysisDelta.contention.rowLabel',
        ANALYSIS_WIRE_LIMITS.nameCodePoints,
        { empty: true, prose: true },
      );
      check(
        Array.isArray(delta.contention.claims) &&
          delta.contention.claims.length <= ANALYSIS_WIRE_LIMITS.claims,
        'analysisDelta.contention.claims',
        'type',
        'Expected a bounded claim list.',
      );
      const claimNames = new Set();
      if (Array.isArray(delta.contention.claims))
        delta.contention.claims.forEach((claim, index) => {
          const path = `analysisDelta.contention.claims.${index}`;
          if (
            !check(
              exactKeys(claim, objectKeys.claim),
              path,
              'fields',
              'Unexpected claim fields.',
            )
          )
            return;
          text(
            claim.name,
            `${path}.name`,
            ANALYSIS_WIRE_LIMITS.nameCodePoints,
            {
              prose: true,
            },
          );
          text(
            claim.query,
            `${path}.query`,
            ANALYSIS_WIRE_LIMITS.queryCodePoints,
            {
              empty: true,
            },
          );
          check(
            !claimNames.has(claim.name),
            `${path}.name`,
            'duplicate',
            'Claim names must be unique.',
          );
          claimNames.add(claim.name);
          check(
            Array.isArray(claim.issues) &&
              claim.issues.length >= 2 &&
              claim.issues.length <= ANALYSIS_WIRE_LIMITS.issues,
            `${path}.issues`,
            'type',
            'A claim must contain at least two canonical issue IDs.',
          );
          const claimIssues = new Set();
          if (Array.isArray(claim.issues)) {
            for (const [issueIndex, id] of claim.issues.entries()) {
              check(
                positiveInteger(id) && issueById.has(id),
                `${path}.issues.${issueIndex}`,
                'source_binding',
                'Claim membership must use canonical issue IDs.',
              );
              check(
                !claimIssues.has(id),
                `${path}.issues.${issueIndex}`,
                'duplicate',
                'A claim cannot repeat an issue.',
              );
              claimIssues.add(id);
            }
            check(
              new Set(claim.issues.map((id) => placed.get(id))).size === 1,
              `${path}.issues`,
              'lane_binding',
              'A contention claim cannot cross lane boundaries.',
            );
          }
        });
      check(
        delta.contention.claims?.length > 0 || delta.contention.rowLabel === '',
        'analysisDelta.contention.rowLabel',
        'sentinel',
        'A row label is not visible without contention claims.',
      );
    }

    if (
      check(
        exactKeys(delta.notes, objectKeys.notes),
        'analysisDelta.notes',
        'fields',
        'Unexpected note fields.',
      )
    )
      for (const key of objectKeys.notes)
        text(
          delta.notes[key],
          `analysisDelta.notes.${key}`,
          ANALYSIS_WIRE_LIMITS.proseCodePoints,
          { empty: true, prose: true },
        );

    check(
      totalText <= ANALYSIS_WIRE_LIMITS.totalTextCodePoints,
      'analysisDelta',
      'size_limit',
      'The analysis delta exceeds its aggregate text limit.',
    );
  } catch {
    add(
      'analysisDelta',
      'malformed_input',
      'The analysis delta could not be inspected safely.',
    );
  }
  return { valid: errors.length === 0, errors };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceReference(reference, analysisInput, issueById, pullById) {
  if (reference.kind === 'none') return null;
  if (reference.kind === 'issue')
    return issueById.get(Number(reference.target)).number;
  if (reference.kind === 'pr') {
    const pull = pullById.get(Number(reference.target));
    return { pr: pull.number, title: pull.title };
  }
  if (reference.kind === 'branch')
    return { branch: reference.target, title: reference.title };
  const matched = analysisInput.references.find((entry) =>
    referenceMatches(entry, reference.target),
  );
  const requested =
    matched.normalizedTarget ?? matched.requested ?? matched.key;
  return reference.kind === 'url'
    ? { url: requested, label: reference.label, title: reference.title }
    : { ref: requested, title: reference.title };
}

/**
 * Merge validated analysis fields into a report cloned from canonical inventory.
 * Invalid input returns validation errors and never produces a partial report.
 */
function assembleAnalysisReport(delta, analysisInput, inventory) {
  const wire = validateAnalysisDelta(delta, analysisInput);
  if (!wire.valid) return wire;
  try {
    const issueById = new Map(
      analysisInput.issueCatalog.map((issue) => [issue.id, issue]),
    );
    const pullById = new Map(
      (analysisInput.pullRequests ?? []).map((pull) => [pull.id, pull]),
    );
    const reportIssueByNumber = new Map(
      inventory.issues.map((issue) => [issue.number, clone(issue)]),
    );
    const milestoneById = new Map(
      (analysisInput.milestoneCatalog ?? []).map((milestone) => [
        milestone.id,
        milestone,
      ]),
    );
    const bindingErrors = [];
    for (const source of issueById.values()) {
      const canonical = reportIssueByNumber.get(source.number);
      const milestone =
        source.milestoneId == null
          ? null
          : milestoneById.get(source.milestoneId)?.title;
      if (
        !canonical ||
        (Object.hasOwn(canonical, 'id') && canonical.id !== source.id) ||
        canonical.title !== source.title ||
        canonical.milestone !== milestone ||
        (canonical.inProgress ?? null) !== (source.inProgress ?? null) ||
        (Object.hasOwn(canonical, 'createdAt') &&
          canonical.createdAt !== source.createdAt) ||
        (Object.hasOwn(canonical, 'updatedAt') &&
          canonical.updatedAt !== source.updatedAt)
      )
        bindingErrors.push({
          path: `analysisInput.issueCatalog.${source.id}`,
          code: 'source_mismatch',
          message:
            'The analysis catalog does not match the canonical inventory.',
        });
    }
    if (bindingErrors.length) return { valid: false, errors: bindingErrors };

    const analysisById = new Map(
      delta.issueAnalysis.map((issue) => [issue.issue, issue]),
    );
    for (const [id, source] of issueById) {
      const issue = reportIssueByNumber.get(source.number);
      const analysis = analysisById.get(id);
      if (!analysis) continue;
      if (analysis.short !== '') issue.short = analysis.short;
      if (analysis.waitingOn.length) {
        issue.waitingOn = analysis.waitingOn.map((reference) =>
          sourceReference(reference, analysisInput, issueById, pullById),
        );
        issue.blockedBecause = analysis.blockedBecause;
      }
      if (analysis.after.length)
        issue.after = analysis.after.map((reference) =>
          sourceReference(reference, analysisInput, issueById, pullById),
        );
      if (analysis.sameBranchAs !== 0)
        issue.sameBranchAs = issueById.get(analysis.sameBranchAs).number;
      if (analysis.uncertaintyReason !== '') {
        issue.uncertainty = { reason: analysis.uncertaintyReason };
        const reference = sourceReference(
          analysis.uncertaintyReference,
          analysisInput,
          issueById,
          pullById,
        );
        if (reference !== null) issue.uncertainty.reference = reference;
      }
    }

    const report = {
      board: inventory.board,
      title: inventory.title,
      repo: inventory.repo,
      ...(inventory.repoUrl == null ? {} : { repoUrl: inventory.repoUrl }),
      sync: clone(inventory.sync),
      summary: delta.summary,
      issues: inventory.issues.map((issue) =>
        reportIssueByNumber.get(issue.number),
      ),
      lanes: delta.lanes.map((lane) => ({
        key: lane.key,
        name: lane.name,
        mode: lane.mode,
        issues: lane.issues.map((id) => issueById.get(id).number),
        ...(lane.owns === '' ? {} : { owns: lane.owns }),
        ...(lane.note === '' ? {} : { note: lane.note }),
      })),
      startNow: delta.startNow.map((pick) => ({
        issue: issueById.get(pick.issue).number,
        why: pick.why,
        ...(pick.touches === '' ? {} : { touches: pick.touches }),
      })),
    };
    const milestones = (analysisInput.milestoneCatalog ?? []).map(
      (milestone) => ({ title: milestone.title }),
    );
    if (milestones.length) report.milestones = milestones;
    if (delta.contention.claims.length) {
      report.contention = {
        ...(delta.contention.rowLabel === ''
          ? {}
          : { rowLabel: delta.contention.rowLabel }),
        claims: delta.contention.claims.map((claim) => ({
          name: claim.name,
          ...(claim.query === '' ? {} : { query: claim.query }),
          issues: claim.issues.map((id) => issueById.get(id).number),
        })),
      };
    }
    const notes = Object.fromEntries(
      Object.entries(delta.notes).filter(([, value]) => value !== ''),
    );
    if (Object.keys(notes).length) report.notes = notes;

    const validation = validateReport(report, inventory);
    if (!validation.valid) return validation;
    deriveReport(report);
    return { valid: true, errors: [], report };
  } catch {
    return {
      valid: false,
      errors: [
        {
          path: 'analysisDelta',
          code: 'assembly_failed',
          message: 'The validated analysis could not be assembled safely.',
        },
      ],
    };
  }
}

export {
  ANALYSIS_DELTA_SCHEMA,
  ANALYSIS_WIRE_LIMITS,
  ANALYSIS_WIRE_VERSION,
  assembleAnalysisReport,
  validateAnalysisDelta,
};
