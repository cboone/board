import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_DELTA_SCHEMA,
  ANALYSIS_WIRE_LIMITS,
  ANALYSIS_WIRE_VERSION,
  assembleAnalysisReport,
  validateAnalysisDelta,
} from '../../src/domain/analysis-wire.js';

const timestamp = '2026-09-18T14:30:00Z';

function sourcePair() {
  const issueCatalog = [
    {
      id: 9_001,
      number: 1,
      title: 'Define the contract',
      milestoneId: null,
      inProgress: null,
      createdAt: '2026-09-01T12:00:00Z',
      updatedAt: timestamp,
    },
    {
      id: 9_002,
      number: 2,
      title: 'Implement the adapter',
      milestoneId: null,
      inProgress: null,
      createdAt: '2026-09-02T12:00:00Z',
      updatedAt: timestamp,
    },
  ];
  const analysisInput = {
    wireVersion: ANALYSIS_WIRE_VERSION,
    repository: {
      id: 50,
      fullName: 'example/widgets',
      defaultBranch: 'main',
      defaultTip: 'a'.repeat(40),
    },
    limitations: [],
    issueCatalog,
    milestoneCatalog: [],
    labelCatalog: [],
    issueEvidence: [],
    comments: [],
    pullRequests: [{ id: 8_001, number: 80, title: 'Settle the API shape' }],
    branches: [
      {
        name: 'feature/contract',
        unmerged: true,
        verification: 'verified',
      },
    ],
    references: [
      {
        key: 'external-approval',
        requested: { reference: 'https://outside.test/approval' },
        verification: 'unverified',
        reason: 'not-readable',
      },
      {
        key: '50:item:90',
        requested: { repoId: 50, number: 90, kind: 'item' },
        verification: 'unverified',
        reason: 'not-readable',
      },
      {
        key: 'external-reference',
        requested: { reference: 'other/package#17' },
        verification: 'unverified',
        reason: 'not-readable',
      },
    ],
    repositoryTree: [],
  };
  const inventory = {
    board: 'backlog-triage',
    title: 'widgets backlog',
    repo: 'example/widgets',
    sync: {
      at: timestamp,
      timeZone: 'UTC',
      branch: 'main',
      commit: 'a'.repeat(40),
      openPullRequests: 1,
    },
    issues: issueCatalog.map((issue) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      milestone: null,
      inProgress: null,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      assignees: [],
    })),
  };
  return { analysisInput, inventory };
}

function noReference() {
  return { kind: 'none', target: '', label: '', title: '' };
}

function issueAnalysis(issue, overrides = {}) {
  return {
    issue,
    short: '',
    waitingOn: [],
    blockedBecause: '',
    after: [],
    sameBranchAs: 0,
    uncertaintyReason: '',
    uncertaintyReference: noReference(),
    ...overrides,
  };
}

function delta() {
  return {
    summary: 'The contract and adapter can start independently.',
    issueAnalysis: [],
    lanes: [
      {
        key: 'L1',
        name: 'Independent work',
        mode: 'any',
        issues: [9_001, 9_002],
        owns: '',
        note: '',
      },
    ],
    startNow: [
      { issue: 9_001, why: 'Defines the public shape.', touches: '' },
      { issue: 9_002, why: 'Builds the separate adapter.', touches: '' },
    ],
    contention: {
      rowLabel: 'Component',
      claims: [{ name: 'shared package', query: '', issues: [9_001, 9_002] }],
    },
    notes: { startNow: '', blocked: '', contention: '' },
  };
}

function codes(value, input = sourcePair().analysisInput) {
  return validateAnalysisDelta(value, input).errors.map((error) => error.code);
}

describe('analysis wire contract', () => {
  it('publishes a frozen local structured-output schema with strict objects', () => {
    expect(ANALYSIS_WIRE_VERSION).toBe(1);
    expect(Object.isFrozen(ANALYSIS_DELTA_SCHEMA)).toBe(true);
    expect(ANALYSIS_DELTA_SCHEMA.additionalProperties).toBe(false);
    expect(
      Object.values(ANALYSIS_DELTA_SCHEMA.$defs).every(
        (definition) => definition.additionalProperties === false,
      ),
    ).toBe(true);
    expect(JSON.stringify(ANALYSIS_DELTA_SCHEMA)).not.toMatch(
      /"\$ref":"(?!#\/\$defs\/)/u,
    );
  });

  it('validates the six-field delta and binds every placement to source IDs', () => {
    const { analysisInput } = sourcePair();
    expect(validateAnalysisDelta(delta(), analysisInput)).toEqual({
      valid: true,
      errors: [],
    });

    const byNumber = delta();
    byNumber.lanes[0].issues[0] = 1;
    expect(codes(byNumber, analysisInput)).toEqual(
      expect.arrayContaining(['source_binding', 'missing_issue']),
    );
  });

  it('rejects canonical fields supplied by model output', () => {
    const value = delta();
    value.issueAnalysis.push({
      ...issueAnalysis(9_001),
      title: 'A model-authored canonical title',
    });
    expect(codes(value)).toContain('fields');
  });

  it('assembles canonical issues and removes empty wire sentinels', () => {
    const { analysisInput, inventory } = sourcePair();
    const result = assembleAnalysisReport(delta(), analysisInput, inventory);
    expect(result).toMatchObject({ valid: true, errors: [] });
    expect(
      result.report.issues.map(({ id, number, title }) => ({
        id,
        number,
        title,
      })),
    ).toEqual([
      { id: 9_001, number: 1, title: 'Define the contract' },
      { id: 9_002, number: 2, title: 'Implement the adapter' },
    ]);
    expect(result.report.lanes[0].issues).toEqual([1, 2]);
    expect(result.report.startNow.map((pick) => pick.issue)).toEqual([1, 2]);
    expect(result.report.contention.claims[0].issues).toEqual([1, 2]);
    expect(result.report.contention.claims[0]).not.toHaveProperty('query');
    expect(result.report).not.toHaveProperty('notes');
  });

  it('copies a nonempty claim query exactly and never turns empty into text', () => {
    const { analysisInput, inventory } = sourcePair();
    const value = delta();
    value.contention.claims[0].query = 'is:issue is:open label:shared';
    const result = assembleAnalysisReport(value, analysisInput, inventory);
    expect(result.valid).toBe(true);
    expect(result.report.contention.claims[0].query).toBe(
      'is:issue is:open label:shared',
    );
  });

  it('source-binds issue references by ID and maps them to report numbers', () => {
    const { analysisInput, inventory } = sourcePair();
    const value = delta();
    value.issueAnalysis.push(
      issueAnalysis(9_002, {
        waitingOn: [{ kind: 'issue', target: '9001', label: '', title: '' }],
        blockedBecause: 'The adapter follows the contract.',
      }),
    );
    value.startNow.splice(1, 1);
    const result = assembleAnalysisReport(value, analysisInput, inventory);
    expect(result.valid).toBe(true);
    expect(result.report.issues[1]).toMatchObject({
      waitingOn: [1],
      blockedBecause: 'The adapter follows the contract.',
    });

    value.issueAnalysis[0].waitingOn[0].target = '1';
    expect(codes(value, analysisInput)).toContain('source_binding');
  });

  it('allows an unverified supplied target only as explicit uncertainty', () => {
    const { analysisInput, inventory } = sourcePair();
    const external = {
      kind: 'url',
      target: 'external-approval',
      label: 'External approval',
      title: 'Confirm the integration approval',
    };
    const value = delta();
    value.issueAnalysis.push(
      issueAnalysis(9_002, {
        uncertaintyReason: 'The approval could not be verified.',
        uncertaintyReference: external,
      }),
    );
    value.startNow.splice(1, 1);
    const assembled = assembleAnalysisReport(value, analysisInput, inventory);
    expect(assembled.valid).toBe(true);
    expect(assembled.report.issues[1].uncertainty).toEqual({
      reason: 'The approval could not be verified.',
      reference: {
        url: 'https://outside.test/approval',
        label: 'External approval',
        title: 'Confirm the integration approval',
      },
    });

    value.issueAnalysis[0] = issueAnalysis(9_002, {
      waitingOn: [external],
      blockedBecause: 'The approval is required.',
    });
    expect(codes(value, analysisInput)).toContain('unverified_reference');
  });

  it('renders object-shaped repository reference provenance as a report reference', () => {
    const { analysisInput, inventory } = sourcePair();
    const value = delta();
    value.issueAnalysis.push(
      issueAnalysis(9_002, {
        uncertaintyReason: 'The related item could not be verified.',
        uncertaintyReference: {
          kind: 'ref',
          target: '50:item:90',
          label: '',
          title: 'Review the related item',
        },
      }),
    );
    value.startNow.splice(1, 1);
    const assembled = assembleAnalysisReport(value, analysisInput, inventory);
    expect(assembled.valid).toBe(true);
    expect(assembled.report.issues[1].uncertainty.reference).toEqual({
      ref: 'example/widgets#90',
      title: 'Review the related item',
    });
  });

  it('rejects model reference kinds that do not match gathered targets', () => {
    for (const [kind, target] of [
      ['ref', 'external-approval'],
      ['url', 'external-reference'],
      ['url', '50:item:90'],
    ]) {
      const { analysisInput } = sourcePair();
      const value = delta();
      value.issueAnalysis.push(
        issueAnalysis(9_002, {
          uncertaintyReason: 'The related target could not be verified.',
          uncertaintyReference: {
            kind,
            target,
            label: kind === 'url' ? 'Related target' : '',
            title: 'Review the related target',
          },
        }),
      );
      expect(codes(value, analysisInput)).toContain('source_binding');
    }
  });

  it('rejects malformed and self-referential gathered repository targets', () => {
    for (const requested of [
      { repoId: 51, number: 90, kind: 'item' },
      { repoId: 50, number: 90, kind: 'task' },
      { repoId: 50, number: 0, kind: 'item' },
    ]) {
      const { analysisInput } = sourcePair();
      analysisInput.references.find(
        ({ key }) => key === '50:item:90',
      ).requested = requested;
      const value = delta();
      value.issueAnalysis.push(
        issueAnalysis(9_002, {
          uncertaintyReason: 'The related target could not be verified.',
          uncertaintyReference: {
            kind: 'ref',
            target: '50:item:90',
            label: '',
            title: 'Review the related target',
          },
        }),
      );
      expect(codes(value, analysisInput)).toContain('source_binding');
    }

    const { analysisInput } = sourcePair();
    analysisInput.references.find(({ key }) => key === '50:item:90').requested =
      { repoId: 50, number: 2, kind: 'issue' };
    const value = delta();
    value.issueAnalysis.push(
      issueAnalysis(9_002, {
        uncertaintyReason: 'The related target could not be verified.',
        uncertaintyReference: {
          kind: 'ref',
          target: '50:item:90',
          label: '',
          title: 'Review the related target',
        },
      }),
    );
    expect(codes(value, analysisInput)).toContain('self_reference');
  });

  it('enforces sentinel relationships and complete lane coverage', () => {
    const value = delta();
    value.issueAnalysis.push(
      issueAnalysis(9_001, {
        waitingOn: [noReference()],
        blockedBecause: 'Not a real blocker.',
      }),
    );
    value.lanes[0].issues.pop();
    value.contention.claims = [];
    value.contention.rowLabel = '';
    expect(codes(value)).toEqual(
      expect.arrayContaining(['sentinel', 'missing_issue']),
    );
  });

  it('rejects oversized, unsafe, and structurally non-JSON output', () => {
    const oversized = delta();
    oversized.summary = 'x'.repeat(ANALYSIS_WIRE_LIMITS.summaryCodePoints + 1);
    expect(codes(oversized)).toContain('text');

    const estimated = delta();
    estimated.summary = 'This takes 3 days.';
    expect(codes(estimated)).toContain('text');

    const sparse = delta();
    sparse.lanes[0].issues = new Array(2);
    expect(codes(sparse)).toContain('not_json');
  });

  it('fails assembly when the canonical analysis catalog and inventory differ', () => {
    const { analysisInput, inventory } = sourcePair();
    inventory.issues[0].title = 'Different trusted title';
    expect(
      assembleAnalysisReport(delta(), analysisInput, inventory),
    ).toMatchObject({
      valid: false,
      errors: [{ code: 'source_mismatch' }],
    });
  });

  it('accepts an empty source backlog with empty lanes and picks', () => {
    const { analysisInput, inventory } = sourcePair();
    analysisInput.issueCatalog = [];
    inventory.issues = [];
    const value = delta();
    value.issueAnalysis = [];
    value.lanes = [];
    value.startNow = [];
    value.contention = { rowLabel: '', claims: [] };
    expect(validateAnalysisDelta(value, analysisInput).valid).toBe(true);
    expect(
      assembleAnalysisReport(value, analysisInput, inventory),
    ).toMatchObject({
      valid: true,
      report: { issues: [], lanes: [], startNow: [] },
    });
  });
});
