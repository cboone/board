import { describe, expect, it } from 'vitest';

import {
  REPORT_COMPARISON_LIMITS,
  REPORT_COMPARISON_SCHEMA_VERSION,
  compareReports,
  createInitialComparison,
  createReportComparison,
  effectiveClaimQuery,
  validateReportComparison,
} from '../../src/domain/report-comparison.js';

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function report() {
  return {
    board: 'backlog-triage',
    title: 'widgets backlog',
    repo: 'example/widgets',
    sync: {
      at: '2026-09-18T14:30:00Z',
      timeZone: 'UTC',
      branch: 'main',
      commit: 'a'.repeat(40),
      openPullRequests: 2,
    },
    summary: 'Start the core and documentation roots.',
    milestones: [
      { title: 'Core work', short: 'Core' },
      { title: 'Documentation', short: 'Docs' },
    ],
    issues: [
      {
        number: 1,
        title: 'Define the core contract',
        short: 'Core contract',
        milestone: 'Core work',
        assignees: [{ id: 10, login: 'cboone' }],
        inProgress: null,
      },
      {
        number: 2,
        title: 'Implement the core adapter',
        short: 'Core adapter',
        milestone: 'Core work',
        assignees: [],
        inProgress: null,
        waitingOn: [1],
        blockedBecause: 'The adapter follows the core contract.',
      },
      {
        number: 3,
        title: 'Write the guide',
        short: 'Guide',
        milestone: 'Documentation',
        assignees: [],
        inProgress: null,
      },
      {
        number: 4,
        title: 'Add documentation examples',
        short: 'Examples',
        milestone: 'Documentation',
        assignees: [],
        inProgress: null,
      },
    ],
    lanes: [
      {
        key: 'L1',
        name: 'Core',
        mode: 'serial',
        issues: [1, 2],
        owns: 'src/core',
        note: 'Keep core changes ordered.',
      },
      {
        key: 'L2',
        name: 'Documentation',
        mode: 'any',
        issues: [3, 4],
        owns: 'docs',
        note: 'The guide and examples are independent.',
      },
    ],
    startNow: [
      { issue: 1, why: 'Defines the shared contract.', touches: 'src/core' },
      { issue: 3, why: 'Builds the guide.', touches: 'docs/guide' },
    ],
    contention: {
      rowLabel: 'Component',
      claims: [
        { name: 'core', issues: [1, 2] },
        {
          name: 'docs',
          query: 'is:issue is:open path:docs',
          issues: [3, 4],
        },
      ],
    },
    notes: {
      startNow: 'Two roots are useful now.',
      blocked: 'The adapter is blocked.',
      contention: 'Each lane shares one component.',
    },
  };
}

function version(value = report(), suffix = '1') {
  return {
    reportId: `report-${suffix}`,
    generatedAt: `2026-09-18T15:0${suffix}:00Z`,
    sourceFingerprint: {
      algorithm: 'sha256',
      value: suffix.repeat(64),
      scope: 'core-and-collected-context',
    },
    sync: copy(value.sync),
    report: value,
  };
}

function find(entries, kind, identity = {}) {
  return entries.find(
    (entry) =>
      entry.kind === kind &&
      Object.entries(identity).every(([key, value]) => entry[key] === value),
  );
}

describe('report comparison states and validation', () => {
  it('keeps initial distinct from a refresh with no reader-visible changes', () => {
    const initial = createInitialComparison(version(report(), '1'));
    const unchanged = createReportComparison(
      version(report(), '1'),
      version(report(), '2'),
    );
    expect(initial).toMatchObject({
      schemaVersion: REPORT_COMPARISON_SCHEMA_VERSION,
      status: 'initial',
      basis: null,
      entries: [],
    });
    expect(unchanged).toMatchObject({ status: 'unchanged', entries: [] });
    expect(validateReportComparison(initial)).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateReportComparison(unchanged)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('uses the source fingerprint nested in a saved source envelope', () => {
    const result = version(report(), '1');
    result.source = { fingerprint: result.sourceFingerprint };
    delete result.sourceFingerprint;
    expect(createInitialComparison(result).result.sourceFingerprint).toEqual(
      result.source.fingerprint,
    );
  });

  it('validates status, kind-specific keys, field order, and changed values', () => {
    const value = createReportComparison(
      version(report(), '1'),
      version({ ...report(), summary: 'A changed summary.' }, '2'),
    );
    expect(validateReportComparison(value).valid).toBe(true);

    value.status = 'unchanged';
    value.entries[0].unexpected = true;
    expect(
      validateReportComparison(value).errors.map(({ code }) => code),
    ).toEqual(expect.arrayContaining(['status', 'fields']));
  });

  it('rejects oversized and sparse comparison data without throwing', () => {
    const value = createInitialComparison(version(report(), '1'));
    value.result.reportId = 'x'.repeat(
      REPORT_COMPARISON_LIMITS.textCodePoints + 1,
    );
    expect(validateReportComparison(value).valid).toBe(false);

    const sparse = createInitialComparison(version(report(), '1'));
    sparse.entries = new Array(1);
    expect(() => validateReportComparison(sparse)).not.toThrow();
    expect(validateReportComparison(sparse).valid).toBe(false);
  });

  it('rejects unknown nested snapshot fields and null required text', () => {
    const current = report();
    current.issues[1].waitingOn = [
      { pr: 91, title: 'Approve the public shape' },
    ];
    const comparison = createReportComparison(
      version(report(), '1'),
      version(current, '2'),
    );
    const issueChange = find(comparison.entries, 'issue', { issueNumber: 2 });
    issueChange.after.waitingOn[0].privateMarker = 'must-not-cross';
    expect(validateReportComparison(comparison).valid).toBe(false);

    const requiredText = createReportComparison(
      version(report(), '1'),
      version({ ...report(), title: 'revised widgets backlog' }, '2'),
    );
    requiredText.entries[0].after.title = null;
    expect(validateReportComparison(requiredText).valid).toBe(false);
  });
});

describe('reader-visible report comparison', () => {
  it('normalizes the implicit repository URL while retaining identity changes', () => {
    const previous = report();
    const current = copy(previous);
    current.repoUrl = 'https://github.com/example/widgets/';
    expect(compareReports(previous, current)).toEqual([]);

    current.title = 'renamed widgets backlog';
    expect(find(compareReports(previous, current), 'board')).toMatchObject({
      fields: ['title'],
      before: { title: 'widgets backlog' },
      after: { title: 'renamed widgets backlog' },
    });
  });

  it('treats an absent claim query and its rendered default as equivalent', () => {
    const previous = report();
    const current = copy(previous);
    current.contention.claims[0].query = 'is:open core';
    expect(effectiveClaimQuery(previous.contention.claims[0])).toBe(
      'is:open core',
    );
    expect(compareReports(previous, current)).toEqual([]);

    current.contention.claims[0].query = 'is:issue is:open label:core';
    expect(
      find(compareReports(previous, current), 'claim', {
        claimName: 'core',
      }),
    ).toMatchObject({
      fields: ['query'],
      before: { query: 'is:open core' },
      after: { query: 'is:issue is:open label:core' },
    });
  });

  it('covers every issue-level reader field and canonical assignment', () => {
    const previous = report();
    const current = copy(previous);
    const issue = current.issues[0];
    issue.title = 'Define the revised core contract';
    issue.milestone = 'Documentation';
    issue.assignees = [{ id: 11, login: 'reviewer' }];
    issue.inProgress = 'PR #90';
    issue.waitingOn = [{ pr: 91, title: 'Approve the public shape' }];
    issue.blockedBecause = 'PR #91 must settle the public shape.';
    issue.after = [{ pr: 92, title: 'Land the supporting types' }];
    issue.uncertainty = {
      reason: 'The external interface remains unclear.',
      reference: {
        url: 'https://outside.test/interface',
        label: 'Interface review',
        title: 'Review the external interface',
      },
    };
    issue.sameBranchAs = 2;
    issue.short = 'Revised contract';
    current.lanes[0].issues.shift();
    current.lanes[1].issues.unshift(1);

    const changed = find(compareReports(previous, current), 'issue', {
      issueNumber: 1,
    });
    expect(changed.fields).toEqual([
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
  });

  it('ignores an after-reference title the lane row does not render', () => {
    const previous = report();
    previous.issues[0].after = [
      { pr: 92, title: 'Old invisible supporting title' },
    ];
    const current = copy(previous);
    current.issues[0].after[0].title = 'New invisible supporting title';
    expect(compareReports(previous, current)).toEqual([]);
  });

  it('detects a blocker title because the blocked section renders it', () => {
    const previous = report();
    previous.issues[1].waitingOn = [{ pr: 91, title: 'Old approval title' }];
    const current = copy(previous);
    current.issues[1].waitingOn[0].title = 'New approval title';
    expect(
      find(compareReports(previous, current), 'issue', {
        issueNumber: 2,
      }).fields,
    ).toContain('waitingOn');
  });

  it('records opened and closed issues in stable source order', () => {
    const previous = report();
    const current = copy(previous);
    current.issues = [
      ...current.issues.slice(0, 3),
      {
        number: 5,
        title: 'Publish release notes',
        milestone: null,
        assignees: [],
        inProgress: null,
      },
    ];
    current.lanes[1].issues = [3, 5];
    const entries = compareReports(previous, current);
    expect(find(entries, 'issue-closed', { issueNumber: 4 })).toBeDefined();
    expect(find(entries, 'issue-opened', { issueNumber: 5 })).toBeDefined();
    expect(
      entries.indexOf(find(entries, 'issue-closed', { issueNumber: 4 })),
    ).toBeLessThan(
      entries.indexOf(find(entries, 'issue-opened', { issueNumber: 5 })),
    );
  });

  it('covers lane membership, addition, removal, order, mode, and details', () => {
    const previous = report();
    const current = copy(previous);
    current.lanes[0] = {
      ...current.lanes[0],
      name: 'Core platform',
      mode: 'any',
      issues: [2, 1],
      owns: 'src/platform',
      note: 'The core branches no longer overlap.',
    };
    current.lanes.reverse();
    const entries = compareReports(previous, current);
    expect(find(entries, 'lane', { laneKey: 'L1' }).fields).toEqual([
      'mode',
      'issues',
      'name',
      'owns',
      'note',
    ]);
    expect(find(entries, 'lane-order')).toBeDefined();

    const replaced = copy(previous);
    replaced.lanes.pop();
    replaced.lanes.push({
      key: 'L3',
      name: 'New docs lane',
      mode: 'any',
      issues: [3, 4],
    });
    const replacements = compareReports(previous, replaced);
    expect(find(replacements, 'lane-removed', { laneKey: 'L2' })).toBeDefined();
    expect(find(replacements, 'lane-added', { laneKey: 'L3' })).toBeDefined();
    expect(find(replacements, 'issue', { issueNumber: 3 }).fields).toContain(
      'laneKey',
    );
  });

  it('covers start membership, order, reason, and footprint', () => {
    const previous = report();
    const current = copy(previous);
    current.startNow = [
      {
        issue: 1,
        why: 'Defines the revised shared contract.',
        touches: 'src/platform',
      },
      { issue: 2, why: 'Builds the adapter.', touches: 'src/adapter' },
    ];
    const entries = compareReports(previous, current);
    expect(find(entries, 'start-removed', { issueNumber: 3 })).toBeDefined();
    expect(find(entries, 'start-added', { issueNumber: 2 })).toBeDefined();
    expect(find(entries, 'start', { issueNumber: 1 }).fields).toEqual([
      'why',
      'touches',
    ]);

    const reordered = copy(previous);
    reordered.startNow.reverse();
    expect(
      find(compareReports(previous, reordered), 'start-order'),
    ).toBeDefined();
  });

  it('covers claim membership, issue order, claim order, name, and search', () => {
    const previous = report();
    const current = copy(previous);
    current.contention.claims[0].issues.reverse();
    current.contention.claims[0].query = 'is:issue is:open label:core';
    current.contention.claims.reverse();
    const entries = compareReports(previous, current);
    expect(find(entries, 'claim', { claimName: 'core' }).fields).toEqual([
      'issues',
      'query',
    ]);
    expect(find(entries, 'claim-order')).toBeDefined();

    const renamed = copy(previous);
    renamed.contention.claims[0].name = 'platform';
    const renameEntries = compareReports(previous, renamed);
    expect(
      find(renameEntries, 'claim-removed', { claimName: 'core' }),
    ).toBeDefined();
    expect(
      find(renameEntries, 'claim-added', { claimName: 'platform' }),
    ).toBeDefined();
  });

  it('covers row labels, displayed milestone labels, summary, and notes', () => {
    const previous = report();
    const current = copy(previous);
    current.contention.rowLabel = 'Package';
    current.milestones[0].short = 'Platform';
    current.summary = 'Start a revised set of roots.';
    current.notes.startNow = 'The revised roots free more work.';
    current.notes.blocked = 'One adapter remains blocked.';
    current.notes.contention = 'Each package has one lane.';
    const entries = compareReports(previous, current);
    expect(find(entries, 'contention').fields).toEqual([
      'rowLabel',
      'milestones',
    ]);
    expect(find(entries, 'prose').fields).toEqual([
      'summary',
      'notes.startNow',
      'notes.blocked',
      'notes.contention',
    ]);
  });

  it('does not report a contention note while neither side draws a matrix', () => {
    const previous = report();
    delete previous.contention;
    const current = copy(previous);
    current.notes.contention = 'Still hidden.';
    expect(find(compareReports(previous, current), 'prose')).toBeUndefined();
  });

  it('is deterministic and its complete changed envelope validates', () => {
    const previous = report();
    const current = copy(previous);
    current.summary = 'A deterministic changed summary.';
    current.contention.claims[0].query = 'is:issue is:open label:core';
    const first = compareReports(previous, current);
    const second = compareReports(copy(previous), copy(current));
    expect(first).toEqual(second);

    const comparison = createReportComparison(
      version(previous, '1'),
      version(current, '2'),
    );
    expect(comparison.status).toBe('changed');
    expect(validateReportComparison(comparison)).toEqual({
      valid: true,
      errors: [],
    });
  });
});
