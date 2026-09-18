const completeReport = {
  board: 'backlog-triage',
  title: 'widgets backlog',
  repo: 'example/widgets',
  sync: {
    at: '2026-09-18T14:30:00Z',
    timeZone: 'America/New_York',
    branch: 'main',
    commit: '0123456789abcdef0123456789abcdef01234567',
    openPullRequests: 3,
    extra: ['Synthetic sample data'],
  },
  summary:
    'Start the tokenizer rewrite and public interface contract on independent branches. Release automation already has two overlapping branches; keep its shared workflow changes together.',
  milestones: [
    { title: 'Parser rewrite', short: 'Parser' },
    { title: 'Public API', short: 'API' },
    { title: 'Release tooling', short: 'Release' },
  ],
  issues: [
    {
      number: 101,
      title: 'parser: replace the tokenizer',
      milestone: 'Parser rewrite',
    },
    {
      number: 102,
      title: 'parser: retain source positions on the tokenizer branch',
      milestone: 'Parser rewrite',
      sameBranchAs: 101,
      waitingOn: [{ pr: 390, title: 'Define the source-position format' }],
      blockedBecause:
        'PR #390 must settle source positions before this companion can run. The tokenizer root can start independently.',
    },
    {
      number: 103,
      title: 'parser: stream large inputs',
      milestone: 'Parser rewrite',
      waitingOn: [101],
      blockedBecause: 'Streaming reads the token format that #101 replaces.',
    },
    {
      number: 104,
      title: 'parser: describe schema migration examples',
      milestone: null,
      after: [
        { ref: 'example/schemas#17', title: 'Publish the schema vocabulary' },
      ],
    },
    {
      number: 110,
      title: 'api: define the public interface contract',
      milestone: 'Public API',
    },
    {
      number: 111,
      title: 'api: adapt the HTTP transport',
      milestone: 'Public API',
      waitingOn: [110],
      blockedBecause: 'The HTTP adapter needs the public interface from #110.',
    },
    {
      number: 112,
      title: 'api: adapt the command-line transport',
      milestone: 'Public API',
    },
    {
      number: 113,
      title: 'api: publish the integration guide',
      milestone: 'Public API',
      waitingOn: [
        110,
        {
          url: 'https://github.com/example/approvals/issues/8',
          label: 'Integration approval',
          title: 'Approve the public integration examples',
        },
      ],
      blockedBecause:
        'Both #110 and the separate integration approval must land. The contract alone does not free this guide.',
    },
    {
      number: 120,
      title: 'release: pin the publishing workflow',
      milestone: 'Release tooling',
      inProgress: 'PR #391',
    },
    {
      number: 121,
      title: 'release: verify package provenance',
      milestone: 'Release tooling',
      inProgress: 'feature/121-provenance',
    },
    {
      number: 130,
      title:
        'docs: document keyboard navigation for the sample report and its reference links',
      milestone: null,
    },
    {
      number: 131,
      title: 'fixtures: add transport compatibility examples',
      milestone: null,
    },
    {
      number: 132,
      title: 'ci: cache dependency downloads',
      milestone: null,
      waitingOn: [
        {
          branch: 'feature/132-cache-layout',
          title: 'Settle the dependency cache layout',
        },
      ],
      blockedBecause:
        'The unmerged cache-layout branch determines the download paths.',
    },
    {
      number: 133,
      title: 'tests: extend the browser compatibility matrix',
      milestone: null,
      after: [{ pr: 392, title: 'Introduce the browser test harness' }],
    },
  ],
  lanes: [
    {
      key: 'L1',
      name: 'Parser core',
      mode: 'serial',
      issues: [101, 102, 103, 104],
      owns: 'src/parser and parser migration examples',
      note: 'These changes share parser components, so use one branch at a time. #102 accompanies #101 but keeps its own PR blocker visible.',
    },
    {
      key: 'L2',
      name: 'Public interface',
      mode: 'head',
      issues: [110, 111, 112, 113],
      owns: 'src/contracts, independent adapters, and integration guides',
      note: '#110 settles the contract before the adapters diverge. It frees #111 and #112; #113 still needs integration approval.',
    },
    {
      key: 'L3',
      name: 'Release automation',
      mode: 'serial',
      issues: [120, 121],
      owns: '.github/workflows and release tooling',
      note: 'PR #391 and feature/121-provenance already overlap on the publishing workflow. Both remain visible; start no additional release branch.',
    },
    {
      key: 'L4',
      name: 'Independent improvements',
      mode: 'any',
      issues: [130, 131, 132, 133],
      owns: 'docs/keyboard, fixtures/transports, ci/cache, and tests/browser',
      note: 'Each branch edits a separate component. #130 and #131 can run independently; cache and browser changes retain their external ordering constraints.',
    },
  ],
  startNow: [
    {
      issue: 101,
      why: 'Settle the token format to free #103. #102 shares this branch but waits independently for PR #390.',
      touches: 'src/parser/tokenizer and token-format tests',
    },
    {
      issue: 110,
      why: 'Define the interface once, then free the independent HTTP and command-line adapters.',
      touches: 'src/contracts/public-interface',
    },
  ],
  contention: {
    rowLabel: 'Component',
    claims: [
      {
        name: 'src/parser',
        issues: [101, 102, 103, 104],
        query: 'is:issue is:open "src/parser"',
      },
      { name: '.github/workflows', issues: [120, 121] },
    ],
  },
  notes: {
    startNow:
      'Recommend two new branches even though six branches can run at once. Two release branches are already active; defer #130 and #131 to concentrate on the parser and interface work that frees others.',
    contention:
      'Parser issues share src/parser. Both active release issues claim the publishing workflow and remain in the same lane.',
  },
};

// The source inventory is authored independently of the analysis payload.
const completeInventory = {
  board: 'backlog-triage',
  title: 'widgets backlog',
  repo: 'example/widgets',
  sync: {
    at: '2026-09-18T14:30:00Z',
    timeZone: 'America/New_York',
    branch: 'main',
    commit: '0123456789abcdef0123456789abcdef01234567',
    openPullRequests: 3,
    extra: ['Synthetic sample data'],
  },
  issues: [
    {
      number: 101,
      title: 'parser: replace the tokenizer',
      milestone: 'Parser rewrite',
      inProgress: null,
    },
    {
      number: 102,
      title: 'parser: retain source positions on the tokenizer branch',
      milestone: 'Parser rewrite',
      inProgress: null,
    },
    {
      number: 103,
      title: 'parser: stream large inputs',
      milestone: 'Parser rewrite',
      inProgress: null,
    },
    {
      number: 104,
      title: 'parser: describe schema migration examples',
      milestone: null,
      inProgress: null,
    },
    {
      number: 110,
      title: 'api: define the public interface contract',
      milestone: 'Public API',
      inProgress: null,
    },
    {
      number: 111,
      title: 'api: adapt the HTTP transport',
      milestone: 'Public API',
      inProgress: null,
    },
    {
      number: 112,
      title: 'api: adapt the command-line transport',
      milestone: 'Public API',
      inProgress: null,
    },
    {
      number: 113,
      title: 'api: publish the integration guide',
      milestone: 'Public API',
      inProgress: null,
    },
    {
      number: 120,
      title: 'release: pin the publishing workflow',
      milestone: 'Release tooling',
      inProgress: 'PR #391',
    },
    {
      number: 121,
      title: 'release: verify package provenance',
      milestone: 'Release tooling',
      inProgress: 'feature/121-provenance',
    },
    {
      number: 130,
      title:
        'docs: document keyboard navigation for the sample report and its reference links',
      milestone: null,
      inProgress: null,
    },
    {
      number: 131,
      title: 'fixtures: add transport compatibility examples',
      milestone: null,
      inProgress: null,
    },
    {
      number: 132,
      title: 'ci: cache dependency downloads',
      milestone: null,
      inProgress: null,
    },
    {
      number: 133,
      title: 'tests: extend the browser compatibility matrix',
      milestone: null,
      inProgress: null,
    },
  ],
};

const emptyReport = {
  board: 'backlog-triage',
  title: 'widgets backlog',
  repo: 'example/widgets',
  sync: {
    at: '2026-09-18T15:00:00Z',
    timeZone: 'America/New_York',
    branch: 'main',
    commit: 'abcdef0123456789abcdef0123456789abcdef01',
    openPullRequests: 0,
    extra: ['Synthetic sample data'],
  },
  summary:
    'The sample repository has no open issues. There are no branches to recommend or components in contention.',
  issues: [],
  lanes: [],
  startNow: [],
  milestones: [],
  contention: { rowLabel: 'Component', claims: [] },
  notes: {
    startNow: 'No open issues, so there are no branches to start.',
    blocked: 'Nothing is blocked.',
    contention: 'No components are claimed by multiple open issues.',
  },
};

const emptyInventory = {
  board: 'backlog-triage',
  title: 'widgets backlog',
  repo: 'example/widgets',
  sync: {
    at: '2026-09-18T15:00:00Z',
    timeZone: 'America/New_York',
    branch: 'main',
    commit: 'abcdef0123456789abcdef0123456789abcdef01',
    openPullRequests: 0,
    extra: ['Synthetic sample data'],
  },
  issues: [],
};

const uncertainReport = {
  board: 'backlog-triage',
  title: 'widgets backlog',
  repo: 'example/widgets',
  sync: {
    at: '2026-09-18T15:30:00Z',
    timeZone: 'America/New_York',
    branch: 'main',
    commit: 'fedcba9876543210fedcba9876543210fedcba98',
    openPullRequests: 0,
    extra: ['Synthetic sample data'],
  },
  summary:
    'Keep the unclear scope and unverified blocker visible, and withhold affected starts. Text such as <script>alert("sample")</script> is sample prose, not executable content.',
  issues: [
    {
      number: 201,
      title: '<img src=x onerror="alert(\'sample\')"> clarify renderer scope',
      milestone: null,
      uncertainty: {
        reason:
          'The request does not identify which renderer files it changes. Confirm the scope before opening a branch; <b>untrusted text</b> stays literal.',
      },
    },
    {
      number: 202,
      title: 'schema: confirm the proposed field names',
      milestone: null,
      uncertainty: {
        reason:
          'PR #490 is mentioned as a blocker, but its status cannot be verified. No verified dependency state is asserted.',
        reference: {
          pr: 490,
          title: 'Confirm the schema proposal is still open',
        },
      },
    },
    {
      number: 203,
      title: 'schema: update the independent adapter examples',
      milestone: null,
    },
  ],
  lanes: [
    {
      key: 'L1',
      name: 'Unclear renderer scope',
      mode: 'serial',
      issues: [201],
      owns: 'Renderer footprint awaiting clarification',
      note: 'The issue remains on the board while its editing scope is uncertain.',
    },
    {
      key: 'L2',
      name: 'Schema agreement',
      mode: 'head',
      issues: [202, 203],
      owns: 'Schema field definitions and independent adapter examples',
      note: 'An uncertain head holds the lane. #203 waits for the schema decision without inventing a confirmed PR blocker.',
    },
  ],
  startNow: [],
  contention: { rowLabel: 'Component', claims: [] },
  notes: {
    startNow:
      'No starts are recommended: clarify #201 and verify the blocker mentioned by #202 before opening affected branches.',
    blocked:
      'No hard blockers have been verified. The two uncertain issues remain visible in their lanes.',
    contention:
      'Confirm the renderer footprint before asserting whether it shares components with other work.',
  },
};

const uncertainInventory = {
  board: 'backlog-triage',
  title: 'widgets backlog',
  repo: 'example/widgets',
  sync: {
    at: '2026-09-18T15:30:00Z',
    timeZone: 'America/New_York',
    branch: 'main',
    commit: 'fedcba9876543210fedcba9876543210fedcba98',
    openPullRequests: 0,
    extra: ['Synthetic sample data'],
  },
  issues: [
    {
      number: 201,
      title: '<img src=x onerror="alert(\'sample\')"> clarify renderer scope',
      milestone: null,
      inProgress: null,
    },
    {
      number: 202,
      title: 'schema: confirm the proposed field names',
      milestone: null,
      inProgress: null,
    },
    {
      number: 203,
      title: 'schema: update the independent adapter examples',
      milestone: null,
      inProgress: null,
    },
  ],
};

export const fixtures = {
  complete: {
    label: 'Complete sample backlog',
    description:
      'Synthetic lanes, dependencies, branch companions, active overlap, and milestones. No GitHub or analysis requests are made.',
    report: completeReport,
    inventory: completeInventory,
  },
  empty: {
    label: 'Empty sample backlog',
    description:
      'A synthetic repository with no open issues or milestones. No GitHub or analysis requests are made.',
    report: emptyReport,
    inventory: emptyInventory,
  },
  uncertain: {
    label: 'Uncertain sample backlog',
    description:
      'Synthetic unclear scope and an unverifiable blocker, including text that resembles HTML. No GitHub or analysis requests are made.',
    report: uncertainReport,
    inventory: uncertainInventory,
  },
};
