import { describe, expect, it } from 'vitest';

import { deriveReport } from '../../src/domain/lane-model.js';

const issue = (number, fields = {}) => ({
  number,
  title: `Issue ${number}`,
  milestone: null,
  ...fields,
});
const lane = (mode, issues, key = 'L1') => ({ key, name: key, mode, issues });
const report = (issues, lanes, startNow = []) => ({ issues, lanes, startNow });

describe('deriveReport', () => {
  it('skips blocked and soft-queued serial roots while preserving real step numbers', () => {
    const model = deriveReport(
      report(
        [
          issue(1, {
            waitingOn: [{ pr: 90 }],
            blockedBecause: 'Needs the API.',
          }),
          issue(2, { after: [{ branch: 'api-change' }] }),
          issue(3),
        ],
        [lane('serial', [1, 2, 3])],
        [{ issue: 3 }],
      ),
    );

    expect(model.lanes[0].runningRoots).toEqual([3]);
    expect(model.lanes[0].startableRoots).toEqual([3]);
    expect([...model.lanes[0].rankByIssue]).toEqual([
      [1, '1'],
      [2, '2'],
      [3, '3'],
    ]);
    expect([...model.lanes[0].stateByIssue]).toEqual([
      [1, 'blocked'],
      [2, 'queued'],
      [3, 'now'],
    ]);
    expect(model.stats).toEqual({
      open: 3,
      ready: 2,
      blocked: 1,
      lanes: 1,
      branchesAtOnce: 1,
      picks: 1,
    });
  });

  it('keeps an independently hard-blocked companion out of an otherwise runnable unit', () => {
    const model = deriveReport(
      report(
        [
          issue(1),
          issue(2, {
            sameBranchAs: 1,
            waitingOn: [{ pr: 90 }],
            blockedBecause: 'Needs an external change.',
          }),
          issue(3),
        ],
        [lane('serial', [2, 1, 3])],
      ),
    );

    expect(model.units.get(1)).toMatchObject({
      rootBlocked: false,
      queued: false,
      companions: [2],
    });
    expect(model.lanes[0].runningRoots).toEqual([1]);
    expect([...model.lanes[0].nowIssues]).toEqual([1]);
    expect(model.lanes[0].rankByIssue.get(2)).toBe('1');
    expect(model.lanes[0].stateByIssue.get(2)).toBe('blocked');
  });

  it('propagates companion soft ordering to its unit and passes it over in a serial lane', () => {
    const model = deriveReport(
      report(
        [
          issue(1),
          issue(2, { sameBranchAs: 1, after: [{ pr: 90 }] }),
          issue(3),
        ],
        [lane('serial', [1, 2, 3])],
      ),
    );

    expect(model.units.get(1).queued).toBe(true);
    expect(model.lanes[0].startableRoots).toEqual([3]);
    expect(model.lanes[0].stateByIssue.get(1)).toBe('queued');
  });

  it('holds a serial slot for active companion work even when that companion is blocked', () => {
    const model = deriveReport(
      report(
        [
          issue(1),
          issue(2, {
            sameBranchAs: 1,
            inProgress: 'PR #90',
            waitingOn: [{ pr: 91 }],
          }),
          issue(3),
        ],
        [lane('serial', [1, 2, 3])],
      ),
    );

    expect(model.units.get(1)).toMatchObject({
      activeIssues: [2],
      inProgress: 'PR #90',
    });
    expect(model.lanes[0].activeRoots).toEqual([1]);
    expect(model.lanes[0].startableRoots).toEqual([]);
    expect(model.lanes[0].capacity).toBe(1);
    expect(model.lanes[0].stateByIssue.get(2)).toBe('blocked');
  });

  it('counts existing active overlap without recommending another serial branch', () => {
    const model = deriveReport(
      report(
        [
          issue(1, { inProgress: 'PR #90', waitingOn: [{ pr: 91 }] }),
          issue(2, { inProgress: 'feature/2' }),
          issue(3),
        ],
        [lane('serial', [1, 2, 3])],
      ),
    );

    expect(model.lanes[0].runningRoots).toEqual([1, 2]);
    expect(model.lanes[0].capacity).toBe(2);
    expect(model.lanes[0].startableRoots).toEqual([]);
    expect(model.stats.branchesAtOnce).toBe(2);
  });

  it.each([
    { waitingOn: [{ pr: 90 }] },
    { after: [{ pr: 90 }] },
    { uncertainty: { reason: 'The work footprint is not clear.' } },
  ])('keeps later roots waiting when its head cannot run: %j', (headFields) => {
    const model = deriveReport(
      report([issue(1, headFields), issue(2)], [lane('head', [1, 2])]),
    );
    expect(model.lanes[0].runningRoots).toEqual([]);
    expect(model.lanes[0].startableRoots).toEqual([]);
    expect(model.lanes[0].freedAfter).toBe(0);
  });

  it('counts only roots actually freed by a running head and its admitted companions', () => {
    const model = deriveReport(
      report(
        [
          issue(1, { inProgress: 'feature/1' }),
          issue(2, { sameBranchAs: 1, waitingOn: [{ pr: 90 }] }),
          issue(3, { waitingOn: [1] }),
          issue(4),
          issue(5, { waitingOn: [1, { pr: 91 }] }),
          issue(6, { waitingOn: [2] }),
          issue(7, { after: [1] }),
        ],
        [lane('head', [2, 1, 3, 4, 5, 6, 7])],
      ),
    );

    expect(model.lanes[0].runningRoots).toEqual([1]);
    expect(model.lanes[0].freedAfter).toBe(3);
    expect(model.lanes[0].rankByIssue.get(2)).toBe('1');
    expect(model.lanes[0].rankByIssue.get(3)).toBe('·');
    expect(model.unblocks.get(1)).toEqual([3, 5]);
    expect(model.eases.get(1)).toEqual([7]);
  });

  it('does not claim head freeing when a different active branch holds the slot', () => {
    const model = deriveReport(
      report(
        [issue(1), issue(2, { inProgress: 'feature/2' }), issue(3)],
        [lane('head', [1, 2, 3])],
      ),
    );
    expect(model.lanes[0].runningRoots).toEqual([2]);
    expect(model.lanes[0].freedAfter).toBe(0);
  });

  it.each([
    {
      name: 'the head root is active',
      issues: [
        issue(1, { inProgress: 'PR #90' }),
        issue(2, { inProgress: 'PR #91' }),
        issue(3, { waitingOn: [1] }),
      ],
      order: [1, 2, 3],
      remaining: [issue(2, { inProgress: 'PR #91' }), issue(3)],
      remainingOrder: [2, 3],
      activeRoots: [1, 2],
      successor: 3,
    },
    {
      name: 'an active head companion overlaps a blocked active root',
      issues: [
        issue(1),
        issue(2, { sameBranchAs: 1, inProgress: 'PR #90' }),
        issue(3, { inProgress: 'PR #91', waitingOn: [{ pr: 92 }] }),
        issue(4, { after: [1] }),
      ],
      order: [2, 1, 3, 4],
      remaining: [
        issue(3, { inProgress: 'PR #91', waitingOn: [{ pr: 92 }] }),
        issue(4),
      ],
      remainingOrder: [3, 4],
      activeRoots: [1, 3],
      successor: 4,
    },
  ])(
    'does not promise head freeing while another branch remains active: $name',
    (scenario) => {
      const model = deriveReport(
        report(scenario.issues, [lane('head', scenario.order)]),
      );
      const afterHead = deriveReport(
        report(scenario.remaining, [lane('head', scenario.remainingOrder)]),
      );

      expect(model.lanes[0].runningRoots).toEqual(scenario.activeRoots);
      expect(model.lanes[0].capacity).toBe(2);
      expect(model.lanes[0].startableRoots).toEqual([]);
      expect(model.lanes[0].freedAfter).toBe(0);
      expect(afterHead.lanes[0].runningRoots).toEqual([
        scenario.activeRoots[1],
      ]);
      expect(afterHead.lanes[0].capacity).toBe(1);
      expect(afterHead.lanes[0].startableRoots).toEqual([]);
      expect(afterHead.lanes[0].stateByIssue.get(scenario.successor)).toBe(
        'queued',
      );
    },
  );

  it('counts successors when active companions occupy only the head branch unit', () => {
    const model = deriveReport(
      report(
        [
          issue(1),
          issue(2, { sameBranchAs: 1, inProgress: 'PR #90' }),
          issue(3, { waitingOn: [2] }),
        ],
        [lane('head', [2, 1, 3])],
      ),
    );

    expect(model.lanes[0].runningRoots).toEqual([1]);
    expect(model.lanes[0].capacity).toBe(1);
    expect(model.lanes[0].freedAfter).toBe(1);
  });

  it('does not count a successor whose companion still has independent soft ordering', () => {
    const model = deriveReport(
      report(
        [
          issue(1),
          issue(3, { waitingOn: [1] }),
          issue(4, { sameBranchAs: 3, after: [{ pr: 90 }] }),
        ],
        [lane('head', [1, 3, 4])],
      ),
    );
    expect(model.lanes[0].freedAfter).toBe(0);
  });

  it('counts a successor whose companion soft ordering is resolved by the head', () => {
    const model = deriveReport(
      report(
        [
          issue(1),
          issue(3, { waitingOn: [1] }),
          issue(4, { sameBranchAs: 3, after: [1] }),
        ],
        [lane('head', [1, 3, 4])],
      ),
    );
    expect(model.lanes[0].freedAfter).toBe(1);
  });

  it('counts a freed root even if its companion remains independently hard-blocked', () => {
    const model = deriveReport(
      report(
        [
          issue(1),
          issue(3, { waitingOn: [1] }),
          issue(4, { sameBranchAs: 3, waitingOn: [{ pr: 90 }] }),
        ],
        [lane('head', [1, 3, 4])],
      ),
    );
    expect(model.lanes[0].freedAfter).toBe(1);
  });

  it('resolves known same-repository references for freeing and inverse relations', () => {
    const data = report(
      [
        issue(1),
        issue(2, { waitingOn: [{ ref: 'EXAMPLE/widgets#1' }] }),
        issue(3, { after: [{ ref: 'example/widgets#1' }] }),
      ],
      [lane('head', [1, 2, 3])],
    );
    data.repo = 'example/widgets';
    const model = deriveReport(data);
    expect(model.lanes[0].freedAfter).toBe(2);
    expect(model.unblocks.get(1)).toEqual([2]);
    expect(model.eases.get(1)).toEqual([3]);
  });

  it('resolves source issue URLs only inside the exact custom repository path', () => {
    const data = report(
      [
        issue(1),
        issue(2, {
          after: [
            {
              url: 'https://git.example.com/enterprise/example/widgets/issues/1',
              label: 'Current source',
            },
          ],
        }),
        issue(3, {
          after: [
            {
              url: 'https://git.example.com/elsewhere/example/widgets/issues/1',
              label: 'Different path',
            },
          ],
        }),
        issue(4, {
          after: [
            {
              url: 'https://git.example.com/Enterprise/example/widgets/issues/1',
              label: 'Different case',
            },
          ],
        }),
      ],
      [lane('head', [1, 2, 3, 4])],
    );
    data.repo = 'example/widgets';
    data.repoUrl = 'https://git.example.com/enterprise/example/widgets';
    const model = deriveReport(data);
    expect(model.lanes[0].freedAfter).toBe(1);
    expect(model.eases.get(1)).toEqual([2]);
  });

  it('counts any-order units separately from their companions and preserves active blocked work', () => {
    const model = deriveReport(
      report(
        [
          issue(1),
          issue(2, { sameBranchAs: 1 }),
          issue(3, { inProgress: 'PR #90', waitingOn: [{ pr: 91 }] }),
          issue(4, { after: [{ pr: 92 }] }),
          issue(5),
        ],
        [lane('any', [1, 2, 3, 4, 5])],
      ),
    );
    expect(model.lanes[0].runningRoots).toEqual([1, 3, 5]);
    expect(model.lanes[0].startableRoots).toEqual([1, 5]);
    expect(model.lanes[0].capacity).toBe(3);
    expect(model.lanes[0].rankByIssue.get(1)).toBe('·');
  });

  it('withholds an uncertain unit while retaining ready counts and visible active occupancy', () => {
    const model = deriveReport(
      report(
        [
          issue(1),
          issue(2, {
            sameBranchAs: 1,
            uncertainty: { reason: 'Needs scope details.' },
          }),
          issue(3, {
            inProgress: 'PR #90',
            uncertainty: { reason: 'Cannot verify its blocker.' },
          }),
        ],
        [lane('any', [1, 2, 3])],
      ),
    );
    expect(model.units.get(1).uncertain).toBe(true);
    expect(model.lanes[0].startableRoots).toEqual([]);
    expect(model.lanes[0].runningRoots).toEqual([3]);
    expect(model.lanes[0].stateByIssue.get(1)).toBe('uncertain');
    expect(model.stats.ready).toBe(3);
    expect(model.stats.blocked).toBe(0);
  });

  it('provides raw-lane lookups, ordered blocked issues, and a coherent empty model', () => {
    const rawLane = lane('any', [1, 2]);
    const model = deriveReport(
      report(
        [
          issue(1, { waitingOn: [{ pr: 90 }, { pr: 91 }] }),
          issue(2, { waitingOn: [{ pr: 92 }] }),
        ],
        [rawLane],
      ),
    );
    expect(model.laneOf.get(1)).toBe(rawLane);
    expect(model.blockedIssues.map((value) => value.number)).toEqual([2, 1]);
    expect(deriveReport(report([], [])).stats).toEqual({
      open: 0,
      ready: 0,
      blocked: 0,
      lanes: 0,
      branchesAtOnce: 0,
      picks: 0,
    });
  });
});
