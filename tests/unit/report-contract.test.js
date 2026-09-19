import { describe, expect, it } from 'vitest';

import {
  REPORT_LIMITS,
  validateReport,
} from '../../src/domain/report-contract.js';

function pair() {
  const sync = {
    at: '2026-09-18T14:30:00Z',
    branch: 'main',
    commit: 'a'.repeat(40),
    timeZone: 'America/New_York',
    openPullRequests: 1,
  };
  const report = {
    board: 'backlog-triage',
    title: 'widgets backlog',
    repo: 'example/widgets',
    sync: { ...sync },
    summary: 'Start the tokenizer to free the parser lane.',
    issues: [
      { number: 1, title: 'Replace the tokenizer', milestone: 'Parser' },
      {
        number: 2,
        title: 'Stream large inputs',
        milestone: 'Parser',
        waitingOn: [1],
        blockedBecause: 'Needs the replacement token format.',
      },
      {
        number: 3,
        title: 'Cache CI dependencies',
        milestone: null,
        inProgress: 'feature/3-cache',
      },
    ],
    lanes: [
      { key: 'L1', name: 'Parser', mode: 'serial', issues: [1, 2] },
      { key: 'L2', name: 'CI', mode: 'any', issues: [3] },
    ],
    startNow: [{ issue: 1, why: 'Frees #2 without editing CI.' }],
    contention: {
      rowLabel: 'Package',
      claims: [{ name: 'parser', issues: [1, 2] }],
    },
  };
  // Source facts are authored separately from the analysis under validation.
  const inventory = {
    board: 'backlog-triage',
    title: 'widgets backlog',
    repo: 'example/widgets',
    sync: { ...sync },
    issues: [
      {
        number: 1,
        title: 'Replace the tokenizer',
        milestone: 'Parser',
        inProgress: null,
      },
      {
        number: 2,
        title: 'Stream large inputs',
        milestone: 'Parser',
        inProgress: null,
      },
      {
        number: 3,
        title: 'Cache CI dependencies',
        milestone: null,
        inProgress: 'feature/3-cache',
      },
    ],
  };
  return { report, inventory };
}

function codes(report, inventory) {
  return validateReport(report, inventory).errors.map((error) => error.code);
}

describe('validateReport', () => {
  it('accepts the independent inventory and original parser/CI contract', () => {
    const { report, inventory } = pair();
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('detects a model omission even when the remaining report is internally complete', () => {
    const { report, inventory } = pair();
    report.issues = [report.issues[0], report.issues[2]];
    report.lanes[0].issues = [1];
    delete report.contention;
    expect(codes(report, inventory)).toContain('missing_issue');
  });

  it.each(['title', 'milestone', 'inProgress'])(
    'rejects changed canonical issue %s',
    (field) => {
      const { report, inventory } = pair();
      report.issues[0][field] =
        field === 'inProgress' ? 'PR #80' : 'Invented source value';
      expect(codes(report, inventory)).toContain('source_mismatch');
    },
  );

  it('rejects omitted known progress even if the model then selects the active issue', () => {
    const { report, inventory } = pair();
    delete report.issues[2].inProgress;
    report.startNow.push({ issue: 3, why: 'Appears free.' });
    expect(codes(report, inventory)).toContain('source_mismatch');
  });

  it('requires explicit canonical null progress and rejects assignment-only evidence', () => {
    const { report, inventory } = pair();
    delete inventory.issues[0].inProgress;
    expect(codes(report, inventory)).toContain('source_progress');
    inventory.issues[0].inProgress = 'assigned to you';
    report.issues[0].inProgress = 'assigned to you';
    expect(codes(report, inventory)).toContain('progress');
  });

  it('accepts a real branch identifier containing assignment terminology', () => {
    const { report, inventory } = pair();
    inventory.issues[2].inProgress = 'feature/reassignment-3';
    report.issues[2].inProgress = 'feature/reassignment-3';
    expect(validateReport(report, inventory).valid).toBe(true);
  });

  it.each(['title', 'repo'])(
    'binds board identity %s to the source',
    (field) => {
      const { report, inventory } = pair();
      report[field] = field === 'repo' ? 'other/widgets' : 'Another backlog';
      expect(codes(report, inventory)).toContain('source_mismatch');
    },
  );

  it.each(['at', 'branch', 'commit', 'openPullRequests'])(
    'binds sync %s to the collected source',
    (field) => {
      const { report, inventory } = pair();
      report.sync[field] = {
        at: '2026-09-19T14:30:00Z',
        branch: 'develop',
        commit: 'b'.repeat(40),
        openPullRequests: 2,
      }[field];
      expect(codes(report, inventory)).toContain('source_mismatch');
    },
  );

  it.each([null, [], {}, 'unexpected', 10, { issues: [null] }])(
    'returns errors without throwing for malformed data: %j',
    (value) => {
      const { inventory } = pair();
      expect(() => validateReport(value, inventory)).not.toThrow();
      expect(validateReport(value, inventory).valid).toBe(false);
    },
  );

  it('bounds recursive, oversized and circular payloads', () => {
    const { report, inventory } = pair();
    report.extra = report;
    expect(codes(report, inventory)).toContain('not_json');
    delete report.extra;
    report.summary = 'x'.repeat(REPORT_LIMITS.textLength + 1);
    expect(codes(report, inventory)).toContain('size_limit');
    report.summary = 'Summary';
    report.extra = Array.from(
      { length: REPORT_LIMITS.arrayLength + 1 },
      () => null,
    );
    expect(codes(report, inventory)).toContain('size_limit');
  });

  it('rejects a sparse pick list in an otherwise valid empty backlog', () => {
    const { report, inventory } = pair();
    report.issues = [];
    report.lanes = [];
    report.startNow = [];
    inventory.issues = [];
    delete report.contention;
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });

    report.startNow = new Array(1);
    expect(() => validateReport(report, inventory)).not.toThrow();
    expect(validateReport(report, inventory)).toEqual({
      valid: false,
      errors: [
        {
          path: 'report.startNow.0',
          code: 'not_json',
          message: expect.any(String),
        },
      ],
    });
  });

  it.each([
    { name: 'report issues', path: 'report.issues.1', field: 'issues' },
    {
      name: 'source inventory issues',
      path: 'inventory.issues.1',
      field: 'inventoryIssues',
    },
    {
      name: 'nested hard references',
      path: 'report.issues.1.waitingOn.0',
      field: 'waitingOn',
    },
    {
      name: 'nested lane order',
      path: 'report.lanes.0.issues.1',
      field: 'laneIssues',
    },
  ])(
    'rejects a missing own index in $name before semantic traversal',
    ({ path, field }) => {
      const { report, inventory } = pair();
      expect(validateReport(report, inventory).valid).toBe(true);
      const arrays = {
        issues: report.issues,
        inventoryIssues: inventory.issues,
        waitingOn: report.issues[1].waitingOn,
        laneIssues: report.lanes[0].issues,
      };
      delete arrays[field][field === 'waitingOn' ? 0 : 1];

      expect(() => validateReport(report, inventory)).not.toThrow();
      expect(validateReport(report, inventory)).toEqual({
        valid: false,
        errors: [{ path, code: 'not_json', message: expect.any(String) }],
      });
    },
  );

  it('rejects nonenumerable array elements that would skip structural text limits', () => {
    const { report, inventory } = pair();
    report.extra = ['x'.repeat(REPORT_LIMITS.textLength + 1)];
    Object.defineProperty(report.extra, '0', { enumerable: false });
    expect(Object.hasOwn(report.extra, 0)).toBe(true);
    expect(() => validateReport(report, inventory)).not.toThrow();
    expect(validateReport(report, inventory)).toEqual({
      valid: false,
      errors: [
        {
          path: 'report.extra.0',
          code: 'not_json',
          message: expect.any(String),
        },
      ],
    });
  });

  it.each(['meta', '01'])(
    'rejects an enumerable array property %s outside its dense indices',
    (key) => {
      const { report, inventory } = pair();
      report.startNow[key] = {
        issue: 999,
        why: 'This property must not bypass pick validation.',
      };
      expect(report.startNow.length).toBe(1);
      expect(() => validateReport(report, inventory)).not.toThrow();
      expect(validateReport(report, inventory)).toEqual({
        valid: false,
        errors: [
          {
            path: 'report.startNow',
            code: 'not_json',
            message: expect.any(String),
          },
        ],
      });
    },
  );

  it('accepts dense report and inventory arrays parsed from plain JSON', () => {
    const { report, inventory } = JSON.parse(JSON.stringify(pair()));
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('accepts dense frozen arrays in reports and source inventories', () => {
    const { report, inventory } = pair();
    for (const array of [
      report.issues,
      report.lanes,
      report.startNow,
      report.contention.claims,
      report.contention.claims[0].issues,
      report.lanes[0].issues,
      report.lanes[1].issues,
      report.issues[1].waitingOn,
      inventory.issues,
    ])
      Object.freeze(array);
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('rejects hidden canonical titles that would bypass text bounds', () => {
    const { report, inventory } = pair();
    const title = 'x'.repeat(REPORT_LIMITS.textLength + 1);
    for (const issue of [report.issues[0], inventory.issues[0]])
      Object.defineProperty(issue, 'title', {
        value: title,
        enumerable: false,
      });
    expect(validateReport(report, inventory)).toEqual({
      valid: false,
      errors: [
        {
          path: 'report.issues.0.title',
          code: 'not_json',
          message: expect.any(String),
        },
      ],
    });
  });

  it.each(['object', 'array'])(
    'rejects a hidden function property on a %s',
    (kind) => {
      const { report, inventory } = pair();
      const target = kind === 'array' ? report.startNow : report;
      Object.defineProperty(target, 'hidden', { value: () => 'Uninspected' });
      expect(codes(report, inventory)).toContain('not_json');
      expect(validateReport(report, inventory).valid).toBe(false);
    },
  );

  it.each(['object', 'array'])(
    'rejects an own symbol property on a %s',
    (kind) => {
      const { report, inventory } = pair();
      const target = kind === 'array' ? report.startNow : report;
      target[Symbol('hidden')] = 'Uninspected data';
      expect(codes(report, inventory)).toContain('not_json');
      expect(validateReport(report, inventory).valid).toBe(false);
    },
  );

  it.each(['object', 'array'])(
    'rejects an enumerable %s accessor without executing its getter',
    (kind) => {
      const { report, inventory } = pair();
      const target = kind === 'array' ? report.startNow : report;
      const key = kind === 'array' ? '0' : 'summary';
      const originalValue = target[key];
      let reads = 0;
      Object.defineProperty(target, key, {
        enumerable: true,
        get() {
          reads += 1;
          return originalValue;
        },
      });
      expect(validateReport(report, inventory).valid).toBe(false);
      expect(reads).toBe(0);
    },
  );

  it('accepts frozen plain and null-prototype objects with dense JSON arrays', () => {
    const values = JSON.parse(JSON.stringify(pair()));
    Object.setPrototypeOf(values.report, null);
    Object.setPrototypeOf(values.inventory, null);
    function freezeJson(value) {
      if (value === null || typeof value !== 'object') return value;
      for (const child of Object.values(value)) freezeJson(child);
      return Object.freeze(value);
    }
    const { report, inventory } = freezeJson(values);
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('rejects an Array subclass that skips validation of an invalid dense pick', () => {
    class SkippedChecksArray extends Array {
      forEach() {}
    }
    const { report, inventory } = pair();
    report.issues = [];
    report.lanes = [];
    inventory.issues = [];
    delete report.contention;
    report.startNow = [
      { issue: 999, why: 'This issue is outside the source.' },
    ];
    expect(codes(report, inventory)).toContain('ineligible_pick');

    report.startNow = new SkippedChecksArray(...report.startNow);
    expect(Object.keys(report.startNow)).toEqual(['0']);
    expect(() => validateReport(report, inventory)).not.toThrow();
    expect(validateReport(report, inventory)).toEqual({
      valid: false,
      errors: [
        {
          path: 'report.startNow',
          code: 'not_json',
          message: expect.any(String),
        },
      ],
    });
  });

  it.each([
    { name: 'null', prototype: null },
    { name: 'custom', prototype: Object.create(Array.prototype) },
  ])('rejects an array with a $name prototype', ({ prototype }) => {
    const { report, inventory } = pair();
    report.extra = Object.setPrototypeOf(['Source context'], prototype);
    expect(() => validateReport(report, inventory)).not.toThrow();
    expect(validateReport(report, inventory)).toEqual({
      valid: false,
      errors: [
        { path: 'report.extra', code: 'not_json', message: expect.any(String) },
      ],
    });
  });

  it('rejects a throwing accessor without reading it', () => {
    const { inventory } = pair();
    let reads = 0;
    const report = Object.defineProperty({}, 'issues', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('Unavailable');
      },
    });
    expect(validateReport(report, inventory)).toMatchObject({
      valid: false,
      errors: [{ path: 'report.issues', code: 'not_json' }],
    });
    expect(reads).toBe(0);
  });

  it.each([
    '2026-02-29T14:00:00Z',
    '2026-04-31T14:00:00Z',
    '2026-09-18T25:00:00Z',
    '2026-09-18T14:00:00',
  ])('rejects invalid timestamp %s', (timestamp) => {
    const { report, inventory } = pair();
    report.sync.at = timestamp;
    expect(codes(report, inventory)).toContain('timestamp');
  });

  it('accepts a leap date and numeric zone offset', () => {
    const { report, inventory } = pair();
    report.sync.at = inventory.sync.at = '2024-02-29T14:30:00-04:00';
    expect(validateReport(report, inventory).valid).toBe(true);
  });

  it('rejects short SHA, unknown zone, controls and missing milestone fields', () => {
    const { report, inventory } = pair();
    report.sync.commit = 'abcdef';
    report.sync.timeZone = 'Unknown/Zone';
    delete report.issues[0].milestone;
    expect(codes(report, inventory)).toEqual(
      expect.arrayContaining(['commit', 'timezone', 'milestone']),
    );
    report.summary = 'Terminal\u001bcontrol';
    expect(codes(report, inventory)).toContain('unsafe_text');
  });

  it.each([
    { url: 'javascript:alert(1)', label: 'Unsafe' },
    { url: 'http://example.com', label: 'Unencrypted' },
    { url: 'https://user:password@example.com', label: 'Credentials' },
    { url: 'https://example.com\\@other.example', label: 'Backslash' },
    { branch: '../main' },
    { branch: 'feature/./change' },
    { pr: 0 },
    { ref: 'owner/repo#0' },
    { pr: 90, branch: 'feature' },
    { url: 'https://example.com' },
  ])('rejects unsafe or malformed reference %j', (target) => {
    const { report, inventory } = pair();
    report.issues[1].waitingOn = [target];
    expect(validateReport(report, inventory).valid).toBe(false);
  });

  it('accepts every external reference form without turning links into fetches', () => {
    const { report, inventory } = pair();
    report.issues[1].waitingOn = [
      { pr: 90, title: 'API change' },
      { branch: 'feature/api' },
      { ref: 'example/other#4' },
      { url: 'https://example.com/design', label: 'Design' },
    ];
    expect(validateReport(report, inventory).valid).toBe(true);
  });

  it.each(['/feature/api', 'feature/api/', 'feature//api'])(
    'rejects empty branch path components in %s',
    (branch) => {
      const { report, inventory } = pair();
      report.sync.branch = inventory.sync.branch = branch;
      expect(codes(report, inventory)).toContain('branch');

      report.sync.branch = inventory.sync.branch = 'main';
      report.issues[1].waitingOn = [{ branch }];
      expect(codes(report, inventory)).toContain('branch');

      report.issues[1].waitingOn = [1];
      report.issues[2].inProgress = inventory.issues[2].inProgress = branch;
      expect(codes(report, inventory)).toContain('progress');
    },
  );

  it.each([
    'example/other#9007199254740992',
    `example/other#${'9'.repeat(100)}`,
  ])('rejects repository reference with an unsafe issue number %s', (ref) => {
    const { report, inventory } = pair();
    report.issues[1].waitingOn = [{ ref }];
    expect(validateReport(report, inventory)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        {
          path: 'report.issues.1.waitingOn.0.ref',
          code: 'reference',
          message: expect.any(String),
        },
      ]),
    });
  });

  it.each(['9007199254740992', '9'.repeat(100)])(
    'rejects a PR progress marker with unsafe number %s',
    (number) => {
      const { report, inventory } = pair();
      report.issues[2].inProgress =
        inventory.issues[2].inProgress = `PR #${number}`;
      expect(codes(report, inventory)).toContain('progress');
    },
  );

  it('accepts nested branch paths and a maximum safe repository issue number', () => {
    const { report, inventory } = pair();
    report.sync.branch = inventory.sync.branch = 'release/next';
    report.issues[2].inProgress = inventory.issues[2].inProgress =
      'feature/3/cache';
    report.issues[1].waitingOn = [
      { branch: 'feature/parser/api' },
      { ref: `example/other#${Number.MAX_SAFE_INTEGER}` },
    ];
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });
    report.issues[2].inProgress =
      inventory.issues[2].inProgress = `PR #${Number.MAX_SAFE_INTEGER}`;
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it.each([
    'https://github.com/other/widgets',
    'https://github.com/example/widgets?q=x',
    'https://github.com/example/%2e%2e/widgets',
    'https://github.com/../example/widgets',
  ])('rejects wrong or traversing repository URL %s', (url) => {
    const { report, inventory } = pair();
    report.repoUrl = url;
    expect(codes(report, inventory)).toContain('url');
  });

  it('normalizes absent GitHub repository URL and trailing slash', () => {
    const { report, inventory } = pair();
    report.repoUrl = 'https://github.com/example/widgets/';
    expect(validateReport(report, inventory).valid).toBe(true);
  });

  it('accepts a safe source URL with a mixed-case HTTPS scheme', () => {
    const { report, inventory } = pair();
    report.issues[1].waitingOn = [
      { url: 'HtTpS://example.com/design', label: 'Design' },
    ];
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('accepts a canonical repository URL with a mixed-case HTTPS scheme', () => {
    const { report, inventory } = pair();
    report.repoUrl = inventory.repoUrl = 'HtTpS://github.com/example/widgets';
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('rejects source additions, duplicate issues, absent/repeated lane placements and repeated claims', () => {
    const { report, inventory } = pair();
    report.issues.push({
      number: 4,
      title: 'Outside inventory',
      milestone: null,
    });
    report.lanes[1].issues.push(4);
    expect(codes(report, inventory)).toContain('unknown_issue');
    report.issues.push({ ...report.issues[0] });
    expect(codes(report, inventory)).toContain('duplicate');
    report.issues.pop();
    report.issues.pop();
    report.lanes[1].issues = [1, 3];
    expect(codes(report, inventory)).toContain('duplicate_placement');
    report.lanes[1].issues = [];
    expect(validateReport(report, inventory).valid).toBe(false);
  });

  it.each(['waitingOn', 'after', 'mixed'])(
    'rejects %s dependency cycles',
    (field) => {
      const { report, inventory } = pair();
      report.startNow = [];
      if (field === 'waitingOn') {
        report.issues[0].waitingOn = [2];
        report.issues[0].blockedBecause = 'Needs #2.';
      } else if (field === 'after') {
        delete report.issues[1].waitingOn;
        delete report.issues[1].blockedBecause;
        report.issues[0].after = [2];
        report.issues[1].after = [1];
      } else report.issues[0].after = [2];
      expect(codes(report, inventory)).toContain('dependency_cycle');
    },
  );

  it('rejects unknown/self dependencies, duplicate hard/soft relations and unsupported lane modes', () => {
    const { report, inventory } = pair();
    report.issues[1].after = [1];
    expect(codes(report, inventory)).toContain('duplicate_relation');
    report.issues[1].waitingOn = [2, 99];
    expect(codes(report, inventory)).toEqual(
      expect.arrayContaining(['self_reference', 'unknown_reference']),
    );
    report.lanes[0].mode = 'parallel';
    expect(codes(report, inventory)).toContain('mode');
  });

  it('detects a mixed cycle through a known same-repository reference', () => {
    const { report, inventory } = pair();
    report.issues[0].waitingOn = [2];
    report.issues[0].blockedBecause = 'Needs the streaming API.';
    delete report.issues[1].waitingOn;
    delete report.issues[1].blockedBecause;
    report.issues[1].after = [{ ref: 'EXAMPLE/widgets#1' }];
    report.startNow = [];
    expect(codes(report, inventory)).toContain('dependency_cycle');
  });

  it('detects a mixed cycle through a known local issue URL', () => {
    const { report, inventory } = pair();
    report.issues[0].waitingOn = [2];
    report.issues[0].blockedBecause = 'Needs the streaming API.';
    delete report.issues[1].waitingOn;
    delete report.issues[1].blockedBecause;
    report.issues[1].after = [
      {
        url: 'https://github.com/example/widgets/issues/1#comment',
        label: 'Tokenizer issue',
      },
    ];
    report.startNow = [];
    expect(codes(report, inventory)).toContain('dependency_cycle');
  });

  it('rejects a PR reference whose number is already a known issue', () => {
    const { report, inventory } = pair();
    report.issues[1].waitingOn = [{ pr: 1 }];
    expect(codes(report, inventory)).toContain('reference');
  });

  it.each([
    'https://github.com/example/other/issues/1',
    'https://github.com/example/widgets/issues/90',
    'https://example.com/example/widgets/issues/1',
    'https://github.com/example/widgets/pull/90',
  ])('does not invent a local issue from external or unknown URL %s', (url) => {
    const { report, inventory } = pair();
    report.issues[1].after = [{ url, label: 'External constraint' }];
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it.each(['after', 'waitingOn'])(
    'detects a branch-unit cycle with root %s and companion soft ordering',
    (field) => {
      const { report, inventory } = pair();
      report.issues[0][field] = [3];
      if (field === 'waitingOn')
        report.issues[0].blockedBecause = 'Needs the CI change.';
      report.issues[1].sameBranchAs = 1;
      delete report.issues[2].inProgress;
      inventory.issues[2].inProgress = null;
      report.issues.push({
        number: 4,
        title: 'CI setup follow-up',
        milestone: null,
        sameBranchAs: 3,
        after: [2],
      });
      inventory.issues.push({
        number: 4,
        title: 'CI setup follow-up',
        milestone: null,
        inProgress: null,
      });
      report.lanes[1].issues.push(4);
      report.startNow = [];
      expect(codes(report, inventory)).toContain('dependency_cycle');
    },
  );

  it('does not invent a branch-unit cycle from an independently hard-blocked companion', () => {
    const { report, inventory } = pair();
    report.issues[1].sameBranchAs = 1;
    report.issues[1].waitingOn = [3];
    report.issues[2].after = [1];
    delete report.issues[2].inProgress;
    inventory.issues[2].inProgress = null;
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('rejects self and duplicate relations hidden behind same-repository aliases', () => {
    const { report, inventory } = pair();
    report.issues[0].after = [{ ref: 'example/widgets#1' }];
    expect(codes(report, inventory)).toContain('self_reference');
    delete report.issues[0].after;
    report.issues[1].after = [{ ref: 'example/widgets#1' }];
    expect(codes(report, inventory)).toContain('duplicate_relation');
    report.issues[1].sameBranchAs = 1;
    expect(codes(report, inventory)).toContain('branch_order');
  });

  it.each(['example/other#1', 'example/widgets#90'])(
    'retains external or unlisted reference %s without inventing a local cycle',
    (ref) => {
      const { report, inventory } = pair();
      report.issues[1].after = [{ ref }];
      expect(validateReport(report, inventory)).toEqual({
        valid: true,
        errors: [],
      });
    },
  );

  it('rejects cross-lane companions, companion chains and ordering within a branch', () => {
    const { report, inventory } = pair();
    report.issues[1].sameBranchAs = 3;
    expect(codes(report, inventory)).toContain('branch_unit');
    report.issues[1].sameBranchAs = 1;
    report.issues[0].sameBranchAs = 2;
    expect(codes(report, inventory)).toContain('branch_unit');
    delete report.issues[0].sameBranchAs;
    report.issues[1].after = [1];
    expect(codes(report, inventory)).toContain('branch_order');
  });

  it('rejects a shared claimed component split across independent lanes', () => {
    const { report, inventory } = pair();
    report.lanes[0].issues = [1];
    report.lanes.push({
      key: 'L3',
      name: 'Streaming',
      mode: 'any',
      issues: [2],
    });
    expect(codes(report, inventory)).toContain('contention_lane');
  });

  it.each([2, 3, 99])(
    'rejects blocked, active and absent pick #%s',
    (number) => {
      const { report, inventory } = pair();
      report.startNow = [{ issue: number, why: 'Not eligible.' }];
      expect(codes(report, inventory)).toContain('ineligible_pick');
    },
  );

  it('rejects a later serial pick, a companion pick and multiple serial picks', () => {
    const { report, inventory } = pair();
    delete report.issues[1].waitingOn;
    delete report.issues[1].blockedBecause;
    report.startNow = [{ issue: 2, why: 'Skipping the runnable head.' }];
    expect(codes(report, inventory)).toContain('ineligible_pick');
    report.issues[1].sameBranchAs = 1;
    expect(codes(report, inventory)).toContain('ineligible_pick');
    delete report.issues[1].sameBranchAs;
    report.startNow.unshift({ issue: 1, why: 'Also picked.' });
    expect(codes(report, inventory)).toContain('ineligible_pick');
  });

  it('permits the root of an independently hard-blocked companion and rejects companion soft queuing', () => {
    const { report, inventory } = pair();
    report.issues[1].sameBranchAs = 1;
    report.issues[1].waitingOn = [{ pr: 90 }];
    expect(validateReport(report, inventory).valid).toBe(true);
    report.issues[1].after = [{ pr: 91 }];
    expect(codes(report, inventory)).toContain('ineligible_pick');
  });

  it('retains uncertain issues while withholding the affected branch unit', () => {
    const { report, inventory } = pair();
    report.issues[0].uncertainty = {
      reason: 'Cannot verify the schema blocker.',
      reference: { pr: 90 },
    };
    expect(codes(report, inventory)).toContain('ineligible_pick');
    report.startNow = [];
    expect(validateReport(report, inventory).valid).toBe(true);
    report.issues[0].uncertainty.reason = ' ';
    expect(validateReport(report, inventory).valid).toBe(false);
  });

  it('allows uncertainty to cite its own source issue without creating a dependency', () => {
    const { report, inventory } = pair();
    report.issues[0].uncertainty = {
      reason: 'The issue does not identify the intended component.',
      reference: 1,
    };
    report.startNow = [];
    expect(validateReport(report, inventory).valid).toBe(true);
  });

  it('rejects repeated lane keys, contention names and start picks', () => {
    const { report, inventory } = pair();
    report.lanes[1].key = 'L1';
    expect(codes(report, inventory)).toContain('duplicate');
    report.lanes[1].key = 'L2';
    report.contention.claims.push({ name: 'parser', issues: [1, 2] });
    expect(codes(report, inventory)).toContain('duplicate');
    report.contention.claims.pop();
    report.startNow.push({ issue: 1, why: 'Repeated recommendation.' });
    expect(codes(report, inventory)).toContain('duplicate');
  });

  it('requires a concrete explanation when otherwise eligible starts are withheld', () => {
    const { report, inventory } = pair();
    report.startNow = [];
    expect(validateReport(report, inventory).valid).toBe(false);
    report.notes = {
      startNow:
        'The parser work is deferred while the migration direction is confirmed.',
    };
    expect(validateReport(report, inventory).valid).toBe(true);
  });

  it('allows an empty source backlog only with empty lanes and picks', () => {
    const { report, inventory } = pair();
    report.issues = [];
    report.lanes = [];
    report.startNow = [];
    inventory.issues = [];
    delete report.contention;
    expect(validateReport(report, inventory)).toEqual({
      valid: true,
      errors: [],
    });
    report.lanes = [{ key: 'L1', name: 'Phantom', mode: 'any', issues: [1] }];
    expect(validateReport(report, inventory).valid).toBe(false);
  });

  it('binds complete canonical issue IDs, timestamps, and sorted assignees', () => {
    const { report, inventory } = pair();
    for (const [index, source] of inventory.issues.entries()) {
      const metadata = {
        id: 10_000 + source.number,
        createdAt: `2026-09-0${index + 1}T12:00:00Z`,
        updatedAt: '2026-09-18T14:30:00Z',
        assignees:
          index === 0
            ? [
                { id: 10, login: 'cboone' },
                { id: 20, login: 'reviewer' },
              ]
            : [],
      };
      Object.assign(source, metadata);
      Object.assign(report.issues[index], structuredClone(metadata));
    }
    expect(validateReport(report, inventory).valid).toBe(true);

    report.issues[0].assignees[0].login = 'invented';
    expect(codes(report, inventory)).toContain('source_mismatch');
  });

  it('rejects partial or noncanonical assignee metadata', () => {
    const { report, inventory } = pair();
    Object.assign(inventory.issues[0], {
      id: 10_001,
      createdAt: '2026-09-01T12:00:00Z',
      updatedAt: '2026-09-18T14:30:00Z',
      assignees: [
        { id: 20, login: 'reviewer' },
        { id: 10, login: 'cboone' },
      ],
    });
    Object.assign(report.issues[0], structuredClone(inventory.issues[0]));
    expect(codes(report, inventory)).toContain('assignees');

    delete inventory.issues[0].createdAt;
    delete report.issues[0].createdAt;
    expect(codes(report, inventory)).toContain('canonical_metadata');
  });
});
