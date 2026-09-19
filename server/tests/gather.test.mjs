import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSourceOperations,
  isKnownCredentialPath,
  selectSourceFiles,
} from '../lib/gather.mjs';
import { BoardError } from '../lib/errors.mjs';
import { createOperationBudget, SOURCE_LIMITS } from '../lib/source-limits.mjs';
import { validateReport } from '../../src/domain/report-contract.js';
import {
  APP_ID,
  OWNER_ID,
  TIP,
  OTHER_TIP,
  BLOB_ID,
  AT,
  repo,
  installation,
  issue,
  pull,
  label,
  milestone,
  comment,
  json,
  fixtureProvider,
} from './source-fixtures.mjs';

function operations(provider) {
  return createSourceOperations({
    appId: APP_ID,
    fetchImpl: provider.fetchImpl,
    now: () => Date.parse(AT),
  });
}
function params(overrides = {}) {
  return {
    ownerId: OWNER_ID,
    accessToken: 'sample-token',
    repositoryId: repo.id,
    ...overrides,
  };
}
function refIssue(overrides = {}) {
  return issue(99, {
    state: 'closed',
    state_reason: 'completed',
    body: 'Closed private body is not gathered',
    ...overrides,
  });
}
function referenceCalls(provider) {
  return provider.calls.filter(
    (call) =>
      call.url.pathname === '/graphql' &&
      JSON.parse(call.init.body).query.includes('query ReferenceFacts'),
  );
}

test('eligible selection requires the expected personal App installation and actual grants', async () => {
  const provider = fixtureProvider({
    values: {
      installations: [
        { ...installation, id: 2, app_id: APP_ID + 1 },
        { ...installation, id: 3, account: { id: 1234, type: 'Organization' } },
        { ...installation, id: 4, suspended_at: AT },
        installation,
      ],
      repositories: [
        repo,
        {
          ...repo,
          id: 8,
          name: 'fork',
          full_name: 'cboone/fork',
          html_url: 'https://github.com/cboone/fork',
          fork: true,
        },
        {
          ...repo,
          id: 9,
          name: 'archive',
          full_name: 'cboone/archive',
          html_url: 'https://github.com/cboone/archive',
          archived: true,
        },
      ],
    },
  });
  assert.deepEqual(await operations(provider).listRepositories(params()), {
    repositories: [
      {
        id: 7,
        fullName: 'cboone/widgets',
        name: 'widgets',
        private: true,
        url: repo.html_url,
      },
    ],
    sourceAuthorization: 'ready',
  });
  assert.equal(
    provider.calls.filter((call) =>
      /\/installations\/\d+\/repositories$/u.test(call.url.pathname),
    ).length,
    1,
  );
});
test('missing or write-capable grants differ from an empty eligible repository set', async () => {
  const required = ['metadata', 'issues', 'pull_requests', 'contents'];
  for (const installations of [
    [],
    [{ ...installation, permissions: { metadata: 'read' } }],
    ...required.map((key) => [
      {
        ...installation,
        permissions: { ...installation.permissions, [key]: 'write' },
      },
    ]),
    [
      {
        ...installation,
        permissions: { ...installation.permissions, administration: 'write' },
      },
    ],
    [
      {
        ...installation,
        permissions: { ...installation.permissions, members: 'read' },
      },
    ],
  ]) {
    const result = await operations(
      fixtureProvider({ values: { installations } }),
    ).listRepositories(params());
    assert.equal(result.sourceAuthorization, 'installation-required');
    assert.deepEqual(result.repositories, []);
  }
  const result = await operations(
    fixtureProvider({ values: { repositories: [] } }),
  ).listRepositories(params());
  assert.equal(result.sourceAuthorization, 'ready');
});
test('repository and installation selection traverse more than 100 entries', async () => {
  const installations = Array.from({ length: 101 }, (_, index) => ({
    ...installation,
    id: index + 1,
    app_id: index === 100 ? APP_ID : APP_ID + 1,
  }));
  const repositories = Array.from({ length: 101 }, (_, index) => ({
    ...repo,
    id: index + 1,
    name: 'repo-' + index,
    full_name: 'cboone/repo-' + index,
    html_url: 'https://github.com/cboone/repo-' + index,
  }));
  const provider = fixtureProvider({ values: { installations, repositories } });
  const result = await operations(provider).listRepositories(params());
  assert.equal(result.repositories.length, 101);
  assert.equal(
    provider.calls.filter((call) => call.url.pathname === '/user/installations')
      .length,
    2,
  );
  assert.equal(
    provider.calls.filter((call) => /\/repositories$/u.test(call.url.pathname))
      .length,
    2,
  );
});
test('owner and numeric repository selection are server-enforced before provider reads', async () => {
  const provider = fixtureProvider();
  await assert.rejects(
    () => operations(provider).listRepositories(params({ ownerId: 1 })),
    { code: 'forbidden' },
  );
  await assert.rejects(
    () =>
      operations(provider).checkRepository(
        params({ repositoryId: 'https://example.test' }),
      ),
    { code: 'invalid_request' },
  );
  assert.equal(provider.calls.length, 0);
  await assert.rejects(
    () => operations(provider).checkRepository(params({ repositoryId: 8 })),
    { code: 'source_unavailable' },
  );
});
test('lightweight repository access pins only current eligibility and the default tip', async () => {
  const provider = fixtureProvider();
  assert.deepEqual(await operations(provider).checkRepositoryAccess(params()), {
    id: repo.id,
    fullName: repo.full_name,
    name: repo.name,
    private: repo.private,
    url: repo.html_url,
    defaultBranch: repo.default_branch,
    defaultTip: TIP,
  });
  assert.deepEqual(
    provider.calls.map((call) => call.url.pathname),
    [
      '/user/installations',
      '/user/installations/1/repositories',
      '/repos/cboone/widgets',
      '/repos/cboone/widgets/branches/main',
    ],
  );
});
test('a source check calls its optional pinned hook once before inventory collection', async () => {
  const provider = fixtureProvider();
  const observations = [];
  const result = await operations(provider).checkRepository(
    params({
      async onRepositoryPinned(repository) {
        observations.push({
          repository,
          paths: provider.calls.map((call) => call.url.pathname),
        });
      },
    }),
  );
  assert.equal(result.summary.status, 'complete');
  assert.deepEqual(observations, [
    {
      repository: {
        id: repo.id,
        fullName: repo.full_name,
        name: repo.name,
        private: repo.private,
        url: repo.html_url,
      },
      paths: [
        '/user/installations',
        '/user/installations/1/repositories',
        '/repos/cboone/widgets',
        '/repos/cboone/widgets/branches/main',
      ],
    },
  ]);
});
test('a pinned-hook source error is not retried as source instability', async () => {
  const provider = fixtureProvider();
  let calls = 0;
  await assert.rejects(
    operations(provider).checkRepository(
      params({
        onRepositoryPinned() {
          calls += 1;
          throw new BoardError('source_unstable');
        },
      }),
    ),
    { code: 'source_unstable' },
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    provider.calls.map((call) => call.url.pathname),
    [
      '/user/installations',
      '/user/installations/1/repositories',
      '/repos/cboone/widgets',
      '/repos/cboone/widgets/branches/main',
    ],
  );
});
test('empty eligible repository yields a complete safe summary and explicit empty inventory', async () => {
  const provider = fixtureProvider();
  const { summary, sourceSnapshot } =
    await operations(provider).checkRepository(params());
  assert.equal(summary.status, 'complete');
  assert.equal(summary.sync.commit, TIP);
  assert.equal(summary.provenance.consistency, 'two-pass-matched');
  assert.equal(summary.counts.openIssues, 0);
  assert.equal(summary.counts.branches, 1);
  assert.deepEqual(sourceSnapshot.inventory.issues, []);
  assert.match(summary.fingerprint.value, /^[a-f\d]{64}$/u);
  const report = {
    ...sourceSnapshot.inventory,
    repoUrl: repo.html_url,
    summary: 'No open issues.',
    milestones: [],
    lanes: [],
    issues: [],
    startNow: [],
    contention: { rowLabel: 'Component', claims: [] },
    notes: {},
  };
  assert.equal(validateReport(report, sourceSnapshot.inventory).valid, true);
});
test('REST PR-shaped issues are filtered and source titles/milestones remain exact', async () => {
  const attached = milestone({
    state: 'closed',
    title: 'Exact milestone title',
  });
  const provider = fixtureProvider({
    values: {
      issues: [
        issue(1, { title: '<literal issue title>', milestone: attached }),
        issue(2, {
          title: 'Pull request 2',
          pull_request: { url: 'provider' },
        }),
      ],
      pulls: [pull(2)],
    },
  });
  const { summary, sourceSnapshot } =
    await operations(provider).checkRepository(params());
  assert.equal(summary.counts.openIssues, 1);
  assert.equal(summary.counts.milestones, 1);
  assert.equal(
    sourceSnapshot.inventory.issues[0].title,
    '<literal issue title>',
  );
  assert.equal(
    sourceSnapshot.inventory.issues[0].milestone,
    'Exact milestone title',
  );
});
test('issue-list and pull representations may have distinct database IDs', async () => {
  const provider = fixtureProvider({ values: { pulls: [pull(2)] } });
  const result = await operations(provider).checkRepository(params());
  assert.deepEqual(
    result.sourceSnapshot.pullRequests.map(({ id, number }) => ({
      id,
      number,
    })),
    [{ id: 1002, number: 2 }],
  );
});
test('cross-source label/milestone joins allow matching facts and reject conflicting facts', async () => {
  const same = fixtureProvider({
    values: {
      issues: [issue(1, { labels: [label()], milestone: milestone() })],
      labels: [label()],
      milestones: [milestone()],
    },
  });
  assert.equal(
    (await operations(same).checkRepository(params())).summary.counts.labels,
    1,
  );
  const conflicting = fixtureProvider({
    values: {
      issues: [
        issue(1, {
          labels: [label({ description: 'Issue-attached differs' })],
        }),
      ],
      labels: [label()],
    },
  });
  await assert.rejects(
    () => operations(conflicting).checkRepository(params()),
    { code: 'source_unstable' },
  );
});
test('open issues and nested PR closing references traverse all pages', async () => {
  const issues = Array.from({ length: 101 }, (_, index) => issue(index + 1));
  const closing = issues.map((item) => ({
    databaseId: item.id,
    number: item.number,
    repository: { databaseId: repo.id, nameWithOwner: repo.full_name },
  }));
  const provider = fixtureProvider({
    values: { issues, pulls: [pull(200)], closing: { 200: closing } },
  });
  const { summary, sourceSnapshot } =
    await operations(provider).checkRepository(params());
  assert.equal(summary.counts.openIssues, 101);
  assert.equal(sourceSnapshot.pullRequests[0].closingIssues.length, 101);
  assert.ok(
    sourceSnapshot.inventory.issues.every(
      (item) => item.inProgress === 'PR #200',
    ),
  );
  assert.equal(
    provider.calls.filter((call) => call.url.pathname === '/graphql').length,
    4,
  );
});
test('duplicate nested closing identities fail even when facts match', async () => {
  const node = {
    databaseId: 1001,
    number: 1,
    repository: { databaseId: repo.id, nameWithOwner: repo.full_name },
  };
  const provider = fixtureProvider({
    values: { pulls: [pull()], closing: { 2: [node, node] } },
  });
  await assert.rejects(() => operations(provider).checkRepository(params()), {
    code: 'source_unstable',
  });
});
test('canonical progress prioritizes PR, then an unmerged branch, then explicit label; assignment alone is insufficient', async () => {
  const issues = [
    issue(1, {
      labels: [label()],
      assignees: [{ id: OWNER_ID, login: 'cboone' }],
    }),
    issue(3, { labels: [label()] }),
    issue(4, { labels: [label()] }),
    issue(5, { assignees: [{ id: OWNER_ID, login: 'cboone' }] }),
    issue(6),
    issue(61),
  ];
  const provider = fixtureProvider({
    values: {
      issues,
      pulls: [pull(2)],
      labels: [label()],
      closing: {
        2: [
          {
            databaseId: 1001,
            number: 1,
            repository: { databaseId: repo.id, nameWithOwner: repo.full_name },
          },
        ],
      },
      branches: [
        { name: 'main', commit: { sha: TIP }, protected: false },
        {
          name: 'feature/1-work',
          commit: { sha: OTHER_TIP },
          protected: false,
        },
        {
          name: 'feature/3-work',
          commit: { sha: OTHER_TIP },
          protected: false,
        },
        {
          name: 'feature/61-work',
          commit: { sha: OTHER_TIP },
          protected: false,
        },
      ],
    },
  });
  const inventory = (await operations(provider).checkRepository(params()))
    .sourceSnapshot.inventory;
  assert.deepEqual(
    inventory.issues.map((item) => item.inProgress),
    [
      'PR #2',
      'feature/3-work',
      'the in progress label',
      null,
      null,
      'feature/61-work',
    ],
  );
  assert.deepEqual(inventory.issues[3].assignees, [
    { id: OWNER_ID, login: 'cboone' },
  ]);
  assert.equal(inventory.issues[3].createdAt, AT);
});
test('issue creation and bounded assignee identities remain canonical source metadata', async () => {
  const provider = fixtureProvider({
    values: {
      issues: [
        issue(1, {
          created_at: '2026-08-01T09:30:00Z',
          assignees: [
            { id: 30, login: 'third', avatar_url: 'not retained' },
            { id: 10, login: 'first', name: 'not retained' },
          ],
        }),
      ],
    },
  });
  const result = await operations(provider).checkRepository(params());
  const expectedAssignees = [
    { id: 10, login: 'first' },
    { id: 30, login: 'third' },
  ];
  assert.equal(
    result.sourceSnapshot.issues[0].createdAt,
    '2026-08-01T09:30:00Z',
  );
  assert.deepEqual(
    result.sourceSnapshot.issues[0].assignees,
    expectedAssignees,
  );
  assert.equal(
    result.sourceSnapshot.inventory.issues[0].createdAt,
    '2026-08-01T09:30:00Z',
  );
  assert.equal(result.sourceSnapshot.inventory.issues[0].id, 1001);
  assert.equal(result.sourceSnapshot.inventory.issues[0].updatedAt, AT);
  assert.deepEqual(
    result.sourceSnapshot.inventory.issues[0].assignees,
    expectedAssignees,
  );
  assert.equal(result.sourceSnapshot.inventory.issues[0].inProgress, null);
});
test('duplicate or conflicting assignee identities never become canonical facts', async () => {
  for (const issues of [
    [
      issue(1, {
        assignees: [
          { id: 10, login: 'same' },
          { id: 10, login: 'same' },
        ],
      }),
    ],
    [
      issue(1, { assignees: [{ id: 10, login: 'first' }] }),
      issue(2, { assignees: [{ id: 10, login: 'second' }] }),
    ],
    [
      issue(1, { assignees: [{ id: 10, login: 'same' }] }),
      issue(2, { assignees: [{ id: 20, login: 'SAME' }] }),
    ],
    [issue(1, { assignees: [{ id: OWNER_ID, login: 'not-cboone' }] })],
    [issue(1, { assignees: [{ id: 10, login: 'cboone' }] })],
  ]) {
    const provider = fixtureProvider({ values: { issues } });
    await assert.rejects(() => operations(provider).checkRepository(params()), {
      code: 'source_unstable',
    });
  }
});
test('assignee collection has an explicit per-issue bound', async () => {
  const assignees = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1,
    login: 'user-' + index,
  }));
  const provider = fixtureProvider({
    values: { issues: [issue(1, { assignees })] },
  });
  await assert.rejects(() => operations(provider).checkRepository(params()), {
    code: 'source_limit_exceeded',
  });
});
test('issue creation or assignment changes between observations keep source unstable', async () => {
  for (const changedIssue of [
    (pass) =>
      issue(1, {
        created_at: pass % 2 ? '2026-08-01T00:00:00Z' : AT,
      }),
    (pass) =>
      issue(1, {
        assignees: pass % 2 ? [{ id: 10, login: 'first' }] : [],
      }),
  ]) {
    const provider = fixtureProvider({
      values: (pass) => ({ issues: [changedIssue(pass)] }),
    });
    await assert.rejects(() => operations(provider).checkRepository(params()), {
      code: 'source_unstable',
    });
  }
});
for (const [status, ahead, behind, unmerged] of [
  ['ahead', 300, 0, true],
  ['diverged', 1, 3, true],
  ['behind', 0, 9, false],
  ['identical', 0, 0, false],
])
  test(
    'branch ancestry uses scalar ' +
      status +
      ' facts, regardless of truncated commit arrays',
    async () => {
      const provider = fixtureProvider({
        values: {
          branches: [
            {
              name: 'feature/1-work',
              commit: { sha: OTHER_TIP },
              protected: false,
            },
          ],
          comparison: {
            status,
            ahead_by: ahead,
            behind_by: behind,
            commits: [],
            files: [],
          },
        },
      });
      const result = await operations(provider).checkRepository(params());
      assert.equal(result.sourceSnapshot.branches[0].unmerged, unmerged);
      assert.equal(result.summary.counts.unmergedBranches, unmerged ? 1 : 0);
      const compares = provider.calls.filter((call) =>
        call.url.pathname.includes('/compare/'),
      );
      assert.equal(compares.length, 1);
      assert.ok(compares[0].url.pathname.endsWith(TIP + '...' + OTHER_TIP));
    },
  );
test('unreadable ancestry remains unverified and is reread in the second pass', async () => {
  const provider = fixtureProvider({
    values: {
      branches: [
        {
          name: 'feature/1-work',
          commit: { sha: OTHER_TIP },
          protected: false,
        },
      ],
    },
    handle: ({ url }) =>
      url.pathname.includes('/compare/')
        ? json({}, { status: 404 })
        : undefined,
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(result.sourceSnapshot.branches[0].unmerged, null);
  assert.equal(
    result.summary.provenance.inputs.find(
      (item) => item.name === 'branch-ancestry',
    ).status,
    'unverified',
  );
  assert.equal(
    provider.calls.filter((call) => call.url.pathname.includes('/compare/'))
      .length,
    2,
  );
});
test('all issue comments are reread, including more than 100 comments', async () => {
  const comments = Array.from({ length: 101 }, (_, index) =>
    comment(index + 1),
  );
  const provider = fixtureProvider({
    values: {
      issues: [issue(1, { comments: 101 })],
      comments: { 1: comments },
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(result.summary.counts.issueComments, 101);
  assert.equal(
    provider.calls.filter((call) => call.url.pathname.endsWith('/1/comments'))
      .length,
    4,
  );
});
for (const kind of ['edit', 'delete', 'add'])
  test(
    'comment ' + kind + ' with unchanged default SHA fails two-pass stability',
    async () => {
      const provider = fixtureProvider({
        values: (pass) => {
          const changed = pass % 2 === 1;
          const comments =
            kind === 'delete' && changed
              ? []
              : kind === 'add' && changed
                ? [comment(), comment(2)]
                : [
                    comment(1, {
                      body:
                        kind === 'edit' && changed
                          ? 'Edited without timestamp change'
                          : 'Original',
                    }),
                  ];
          return {
            issues: [issue(1, { comments: comments.length })],
            comments: { 1: comments },
          };
        },
      });
      await assert.rejects(
        () => operations(provider).checkRepository(params()),
        { code: 'source_unstable' },
      );
      assert.equal(
        provider.calls.filter((call) =>
          call.url.pathname.endsWith('/1/comments'),
        ).length,
        4,
      );
    },
  );
test('one entire retry succeeds if the next pair of complete observations matches', async () => {
  const provider = fixtureProvider({
    values: (pass) => ({
      issues: [issue(1, { body: pass === 0 ? 'Before' : 'After' })],
    }),
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(result.sourceSnapshot.issues[0].body, 'After');
  assert.equal(
    provider.calls.filter(
      (call) => call.url.pathname === '/repos/cboone/widgets/issues',
    ).length,
    4,
  );
});
test('repeatedly changing issue text never succeeds merely because timestamps/default tip match', async () => {
  const provider = fixtureProvider({
    values: (pass) => ({ issues: [issue(1, { body: 'Version ' + pass })] }),
  });
  await assert.rejects(() => operations(provider).checkRepository(params()), {
    code: 'source_unstable',
  });
  assert.equal(
    provider.calls.filter(
      (call) => call.url.pathname === '/repos/cboone/widgets/issues',
    ).length,
    4,
  );
});
test('same-source references deduplicate and retain only verified closed facts', async () => {
  const provider = fixtureProvider({
    values: {
      issues: [
        issue(1, {
          body: 'Requires #99, #99. Also other/project#17 and https://outside.test/check',
        }),
      ],
      references: { 'issues/99': refIssue() },
    },
  });
  const result = await operations(provider).checkRepository(params());
  const verified = result.sourceSnapshot.references.find(
    (entry) => entry.verification === 'verified',
  );
  assert.equal(verified.facts.state, 'closed');
  assert.equal(verified.facts.stateReason, 'completed');
  assert.equal(result.summary.provenance.references.verified, 1);
  assert.equal(result.summary.provenance.references.unverified, 2);
  assert.equal(referenceCalls(provider).length, 2);
  assert.ok(
    provider.calls.every(
      (call) => call.url.origin === 'https://api.github.com',
    ),
  );
  assert.ok(
    !JSON.stringify(result.sourceSnapshot.references).includes(
      'Closed private body',
    ),
  );
  assert.ok(!JSON.stringify(result.summary).includes('Requires #99'));
});
for (const kind of ['state_reason', 'merge', 'unreadable', 'readable'])
  test(
    'closed target ' + kind + ' transition fails independent verification',
    async () => {
      const provider = fixtureProvider({
        values: (pass) => {
          const changed = pass % 2 === 1;
          const isPull = kind === 'merge';
          let target = isPull
            ? pull(99, {
                state: 'closed',
                merged: changed,
                merge_commit_sha: changed ? OTHER_TIP : null,
              })
            : refIssue({
                state_reason:
                  changed && kind === 'state_reason'
                    ? 'not_planned'
                    : 'completed',
              });
          if (
            (kind === 'unreadable' && changed) ||
            (kind === 'readable' && !changed)
          )
            target = json({}, { status: 404 });
          return {
            issues: [
              issue(1, { body: isPull ? repo.html_url + '/pull/99' : '#99' }),
            ],
            references: { [isPull ? 'pulls/99' : 'issues/99']: target },
          };
        },
      });
      await assert.rejects(
        () => operations(provider).checkRepository(params()),
        { code: 'source_unstable' },
      );
      assert.equal(referenceCalls(provider).length, 4);
    },
  );
test('unreadable same-source targets are explicit uncertainty, never closed', async () => {
  const provider = fixtureProvider({
    values: { issues: [issue(1, { body: '#99' })] },
  });
  const result = await operations(provider).checkRepository(params());
  const target = result.sourceSnapshot.references[0];
  assert.equal(target.verification, 'unverified');
  assert.equal(target.reason, 'not-readable');
  assert.equal(target.facts, undefined);
});
test('fresh eligibility checks detect access loss even when public source URLs exist', async () => {
  let lists = 0;
  const provider = fixtureProvider({
    handle: ({ url }) =>
      url.pathname === '/user/installations/1/repositories' && ++lists > 1
        ? json({ repositories: [] })
        : undefined,
  });
  await assert.rejects(() => operations(provider).checkRepository(params()), {
    code: 'source_unavailable',
  });
});
test('core collection cannot admit more than the shared 1000 open issue limit', async () => {
  const provider = fixtureProvider({
    values: { issues: [issue(1), issue(2)] },
  });
  const budget = createOperationBudget({ limits: { issues: 1 } });
  await assert.rejects(
    () => operations(provider).checkRepository(params({ budget })),
    { code: 'source_limit_exceeded' },
  );
});
test('required comment collection cannot be silently truncated', async () => {
  const provider = fixtureProvider({
    values: {
      issues: [issue(1, { comments: 2 })],
      comments: { 1: [comment()] },
    },
  });
  await assert.rejects(() => operations(provider).checkRepository(params()), {
    code: 'source_unstable',
  });
});
test('tree fallback traverses complete nonrecursive subtrees', async () => {
  const subtree = 'd'.repeat(40);
  const provider = fixtureProvider({
    handle: ({ url }) => {
      if (!url.pathname.includes('/git/trees/')) return undefined;
      if (url.searchParams.has('recursive'))
        return json({ tree: [], truncated: true });
      if (url.pathname.endsWith(TIP))
        return json({
          tree: [{ path: 'src', type: 'tree', sha: subtree, mode: '040000' }],
          truncated: false,
        });
      return json({
        tree: [
          {
            path: 'main.js',
            type: 'blob',
            sha: BLOB_ID,
            mode: '100644',
            size: 20,
          },
        ],
        truncated: false,
      });
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(result.summary.counts.treeEntries, 2);
  assert.ok(
    result.sourceSnapshot.tree.some((entry) => entry.path === 'src/main.js'),
  );
  assert.equal(
    provider.calls.filter((call) => call.url.pathname.includes('/git/trees/'))
      .length,
    3,
  );
});
test('truncated nonrecursive tree fails collection explicitly', async () => {
  const provider = fixtureProvider({
    handle: ({ url }) =>
      url.pathname.includes('/git/trees/')
        ? json({ tree: [], truncated: true })
        : undefined,
  });
  await assert.rejects(() => operations(provider).checkRepository(params()), {
    code: 'source_incomplete',
  });
});
test('file policy is deterministic and excludes credential, binary, dependency, and generated contents', () => {
  const paths = [
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'package.json',
    'src/main.js',
    '.env.production',
    'credentials/service.json',
    'private.key',
    'vendor/README.md',
    'dist/README.md',
    'node_modules/package.json',
    'image.png',
  ];
  const tree = paths.map((path) => ({
    path,
    type: 'blob',
    sha: BLOB_ID,
    mode: '100644',
    size: 20,
  }));
  const prose = [
    'src/main.js',
    '.env.production',
    'credentials/service.json',
    'private.key',
    'vendor/README.md',
    'dist/README.md',
    'node_modules/package.json',
    'image.png',
  ]
    .map((path) => '\u0060' + path + '\u0060')
    .join(' ');
  const selected = selectSourceFiles(
    tree.reverse(),
    [issue(1, { body: prose })],
    SOURCE_LIMITS,
  );
  assert.deepEqual(
    selected.selected.map((entry) => entry.path),
    ['src/main.js', 'README.md', 'AGENTS.md', 'CLAUDE.md', 'package.json'],
  );
  assert.deepEqual(
    selected.selected.map((entry) => entry.relevanceClass),
    ['referenced', 'guidance', 'guidance', 'guidance', 'configuration'],
  );
  assert.equal(selected.excluded, 7);
});
test('explicit references win overlapping file classes before count limits', () => {
  const tree = ['README.md', 'AGENTS.md', 'package.json'].map((path) => ({
    path,
    type: 'blob',
    sha: BLOB_ID,
    mode: '100644',
    size: 20,
  }));
  const policy = selectSourceFiles(
    tree,
    [issue(1, { body: 'Inspect `package.json`.' })],
    { ...SOURCE_LIMITS, files: 1 },
  );
  assert.deepEqual(policy.selected, [
    {
      path: 'package.json',
      type: 'blob',
      sha: BLOB_ID,
      mode: '100644',
      size: 20,
      relevanceClass: 'referenced',
    },
  ]);
});
test('selected blobs are pinned and reused only by immutable identity, with no raw summary text', async () => {
  const content = 'Private README text';
  const provider = fixtureProvider({
    values: {
      tree: [
        {
          path: 'README.md',
          type: 'blob',
          sha: BLOB_ID,
          mode: '100644',
          size: Buffer.byteLength(content),
        },
      ],
      fileContent: content,
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.deepEqual(result.summary.provenance.files, [
    { path: 'README.md', blobId: BLOB_ID },
  ]);
  assert.equal(result.sourceSnapshot.files[0].content, content);
  assert.ok(!JSON.stringify(result.summary).includes(content));
  assert.equal(
    provider.calls.filter((call) => call.url.pathname.includes('/git/blobs/'))
      .length,
    1,
  );
  assert.equal(
    provider.calls.filter((call) => call.url.pathname.includes('/git/trees/'))
      .length,
    1,
  );
});
test('invalid UTF-8, binary, and oversized selected files are omitted with tree identities retained', async () => {
  const invalidBlob = 'd'.repeat(40);
  const binaryBlob = 'e'.repeat(40);
  const validBlob = 'f'.repeat(40);
  const oversizedBlob = '1'.repeat(40);
  const contents = {
    [invalidBlob]: Buffer.from([0xc3, 0x28]),
    [binaryBlob]: Buffer.from([0x61, 0, 0x62]),
    [validBlob]: Buffer.from('{}\n'),
    [oversizedBlob]: Buffer.alloc(SOURCE_LIMITS.fileBytes + 1, 0x61),
  };
  const provider = fixtureProvider({
    values: {
      tree: [
        ...[
          ['README.md', invalidBlob],
          ['AGENTS.md', binaryBlob],
          ['package.json', validBlob],
        ].map(([path, sha]) => ({
          path,
          type: 'blob',
          sha,
          mode: '100644',
          size: contents[sha].byteLength,
        })),
        {
          path: 'tsconfig.json',
          type: 'blob',
          sha: oversizedBlob,
          mode: '100644',
        },
      ],
      fileContents: contents,
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.deepEqual(result.sourceSnapshot.files, [
    {
      path: 'package.json',
      blobId: validBlob,
      content: '{}\n',
      relevanceClass: 'configuration',
    },
  ]);
  assert.deepEqual(result.sourceSnapshot.filePolicy.omitted, [
    {
      path: 'README.md',
      blobId: invalidBlob,
      relevanceClass: 'guidance',
      reason: 'invalid-utf8',
    },
    {
      path: 'AGENTS.md',
      blobId: binaryBlob,
      relevanceClass: 'guidance',
      reason: 'binary-content',
    },
    {
      path: 'tsconfig.json',
      blobId: oversizedBlob,
      relevanceClass: 'configuration',
      reason: 'oversized',
    },
  ]);
  assert.ok(
    result.sourceSnapshot.tree.some(
      (entry) => entry.path === 'README.md' && entry.sha === invalidBlob,
    ),
  );
  assert.ok(
    result.sourceSnapshot.tree.some(
      (entry) => entry.path === 'AGENTS.md' && entry.sha === binaryBlob,
    ),
  );
  assert.equal(result.summary.counts.selectedFiles, 1);
});
test('failure of an admitted selected file is incomplete, never bounded success', async () => {
  const provider = fixtureProvider({
    values: {
      tree: [
        {
          path: 'README.md',
          type: 'blob',
          sha: BLOB_ID,
          mode: '100644',
          size: 20,
        },
      ],
    },
    handle: ({ url }) =>
      url.pathname.includes('/git/blobs/')
        ? json({}, { status: 404 })
        : undefined,
  });
  await assert.rejects(() => operations(provider).checkRepository(params()), {
    code: 'source_incomplete',
  });
});
test('same target numbers in bare and explicit references share one facts-only read per pass', async () => {
  const provider = fixtureProvider({
    values: {
      issues: [issue(1, { body: '#99 and ' + repo.html_url + '/issues/99' })],
      references: { 'issues/99': refIssue() },
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(result.summary.provenance.references.verified, 2);
  assert.equal(referenceCalls(provider).length, 2);
  assert.ok(
    referenceCalls(provider).every(
      (call) =>
        !/\b(?:body|title|comments)\b/u.test(JSON.parse(call.init.body).query),
    ),
  );
  assert.ok(
    provider.calls.every(
      (call) => !/\/(?:issues|pulls)\/99$/u.test(call.url.pathname),
    ),
  );
});
test('source provenance does not extract a cross-repository suffix from arbitrary path prose', async () => {
  const provider = fixtureProvider({
    values: {
      issues: [
        issue(1, { body: 'path/other/package#17 and C#17 are literal prose' }),
      ],
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.deepEqual(result.sourceSnapshot.references, []);
  assert.equal(referenceCalls(provider).length, 0);
});
test('known source issue and closing-association IDs must match across endpoints', async () => {
  const provider = fixtureProvider({
    values: {
      issues: [issue(1)],
      pulls: [pull(2)],
      closing: {
        2: [
          {
            databaseId: 99999,
            number: 1,
            repository: { databaseId: repo.id, nameWithOwner: repo.full_name },
          },
        ],
      },
    },
  });
  await assert.rejects(() => operations(provider).checkRepository(params()), {
    code: 'source_unstable',
  });
});
test('issue-list PR shapes and open PR collections must agree on membership and canonical facts', async () => {
  for (const restIssues of [[issue(2, { pull_request: {} })], []]) {
    const provider = fixtureProvider({
      values: { pulls: [pull(2)] },
      handle: ({ url }) =>
        url.pathname === '/repos/cboone/widgets/issues'
          ? json(restIssues)
          : undefined,
    });
    await assert.rejects(() => operations(provider).checkRepository(params()), {
      code: 'source_unstable',
    });
  }
});
test('remote branch inventory must include the independently pinned default branch and tip', async () => {
  for (const branches of [
    [],
    [{ name: 'main', commit: { sha: OTHER_TIP }, protected: false }],
  ]) {
    const provider = fixtureProvider({
      handle: ({ url }) =>
        url.pathname === '/repos/cboone/widgets/branches'
          ? json(branches)
          : undefined,
    });
    await assert.rejects(() => operations(provider).checkRepository(params()), {
      code: 'source_unstable',
    });
  }
});
test('source field validation preserves exact values but rejects inventory-incompatible title text', async () => {
  for (const title of [
    '',
    '   ',
    'A title with\nan embedded control',
    'x'.repeat(20001),
  ]) {
    const provider = fixtureProvider({
      values: { issues: [issue(1, { title })] },
    });
    await assert.rejects(() => operations(provider).checkRepository(params()), {
      code: 'source_incomplete',
    });
  }
});
test('selected source paths can come from issue comments and remain pinned to the tree', async () => {
  const content = 'Selected source text';
  const provider = fixtureProvider({
    values: {
      issues: [issue(1, { comments: 1 })],
      comments: {
        1: [comment(1, { body: 'See \u0060./src/main.js:17\u0060' })],
      },
      tree: [
        {
          path: 'src/main.js',
          type: 'blob',
          sha: BLOB_ID,
          mode: '100644',
          size: Buffer.byteLength(content),
        },
      ],
      fileContent: content,
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(result.summary.counts.selectedFiles, 1);
  assert.equal(result.sourceSnapshot.files[0].path, 'src/main.js');
  assert.equal(result.sourceSnapshot.files[0].relevanceClass, 'referenced');
});
test('credential locations are excluded even when explicitly referenced in issue prose', () => {
  const paths = [
    '.ssh/config',
    '.aws/config',
    '.docker/config.json',
    '.config/gcloud/account.json',
    'service-account.json',
    'oauth_credentials.json',
    '.env',
    'cert.p12',
  ];
  const tree = paths.map((path) => ({
    path,
    type: 'blob',
    sha: BLOB_ID,
    mode: '100644',
    size: 10,
  }));
  const body = paths.map((path) => '\u0060' + path + '\u0060').join(' ');
  const policy = selectSourceFiles(tree, [issue(1, { body })], SOURCE_LIMITS);
  assert.equal(policy.selected.length, 0);
  assert.equal(policy.excluded, paths.length);
});
test('optional file admission records exclusions and both file/count bounds without fetching skipped contents', async () => {
  const content = '12345';
  const provider = fixtureProvider({
    values: {
      tree: ['A/README.md', 'B/README.md', 'C/README.md'].map((path) => ({
        path,
        type: 'blob',
        sha: BLOB_ID,
        mode: '100644',
        size: Buffer.byteLength(content),
      })),
      fileContent: content,
    },
  });
  const budget = createOperationBudget({
    limits: { files: 2, totalFileBytes: 5 },
  });
  const result = await operations(provider).checkRepository(params({ budget }));
  assert.equal(result.summary.counts.selectedFiles, 1);
  assert.equal(
    result.summary.provenance.inputs.find(
      (input) => input.name === 'selected-file-context',
    ).status,
    'bounded',
  );
  assert.equal(
    provider.calls.filter((call) => call.url.pathname.includes('/git/blobs/'))
      .length,
    1,
  );
});
test('oversized or symbolic-link files are excluded before content fetch', () => {
  const tree = [
    {
      path: 'README.md',
      type: 'blob',
      sha: BLOB_ID,
      mode: '100644',
      size: SOURCE_LIMITS.fileBytes + 1,
    },
    { path: 'AGENTS.md', type: 'blob', sha: BLOB_ID, mode: '120000', size: 10 },
    {
      path: 'dependency',
      type: 'commit',
      sha: BLOB_ID,
      mode: '160000',
      size: null,
    },
  ];
  const selected = selectSourceFiles(tree, [], SOURCE_LIMITS);
  assert.equal(selected.selected.length, 0);
  assert.equal(selected.excluded, 3);
});
test('a required provider page failure never returns a partial successful summary', async () => {
  const provider = fixtureProvider({
    handle: ({ url }) =>
      url.pathname === '/repos/cboone/widgets/labels'
        ? json({}, { status: 503 })
        : undefined,
  });
  await assert.rejects(() => operations(provider).checkRepository(params()), {
    code: 'provider_unavailable',
  });
});
test('live source operation uses the caller deadline and counters instead of resetting them', async () => {
  const provider = fixtureProvider();
  const budget = createOperationBudget({ limits: { requests: 1 } });
  budget.takeRequest();
  await assert.rejects(
    () => operations(provider).checkRepository(params({ budget })),
    { code: 'source_limit_exceeded' },
  );
  assert.equal(provider.calls.length, 0);
});
test('all open PR pages and each PR nested connection are collected beyond 100 PRs', async () => {
  const provider = fixtureProvider({
    values: {
      pulls: Array.from({ length: 101 }, (_, index) => pull(index + 1)),
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(result.summary.counts.openPullRequests, 101);
  assert.equal(
    provider.calls.filter(
      (call) => call.url.pathname === '/repos/cboone/widgets/pulls',
    ).length,
    4,
  );
  assert.equal(
    provider.calls.filter((call) => call.url.pathname === '/graphql').length,
    202,
  );
});
test('label, milestone and branch collections each traverse beyond 100 with shared pinned ancestry reads', async () => {
  const provider = fixtureProvider({
    values: {
      labels: Array.from({ length: 101 }, (_, index) =>
        label({ id: index + 1, name: 'Label ' + index }),
      ),
      milestones: Array.from({ length: 101 }, (_, index) =>
        milestone({
          id: index + 1,
          number: index + 1,
          title: 'Milestone ' + index,
        }),
      ),
      branches: Array.from({ length: 101 }, (_, index) => ({
        name: 'feature/' + index,
        commit: { sha: OTHER_TIP },
        protected: false,
      })),
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(result.summary.counts.labels, 101);
  assert.equal(result.summary.counts.milestones, 101);
  assert.equal(result.summary.counts.branches, 102);
  assert.equal(result.summary.counts.unmergedBranches, 101);
  for (const resource of ['labels', 'milestones', 'branches'])
    assert.equal(
      provider.calls.filter(
        (call) => call.url.pathname === '/repos/cboone/widgets/' + resource,
      ).length,
      4,
    );
  assert.equal(
    provider.calls.filter((call) => call.url.pathname.includes('/compare/'))
      .length,
    1,
  );
});
test('canonical source fingerprints are stable when endpoint ordering differs between observations', async () => {
  const provider = fixtureProvider({
    values: (pass) => ({
      issues: pass % 2 ? [issue(2), issue(1)] : [issue(1), issue(2)],
      labels:
        pass % 2
          ? [label({ id: 2 }), label({ id: 1 })]
          : [label({ id: 1 }), label({ id: 2 })],
    }),
  });
  assert.equal(
    (await operations(provider).checkRepository(params())).summary.status,
    'complete',
  );
});
test('nested cursor repetition or identity mismatch prevents a complete PR manifest', async () => {
  for (const mismatch of [false, true]) {
    const provider = fixtureProvider({
      values: { pulls: [pull()] },
      handle: ({ url }) =>
        url.pathname === '/graphql'
          ? json({
              data: {
                repository: {
                  databaseId: mismatch ? 99 : repo.id,
                  nameWithOwner: repo.full_name,
                  pullRequest: {
                    number: 2,
                    closingIssuesReferences: {
                      nodes: [],
                      pageInfo: { hasNextPage: true, endCursor: 'repeated' },
                    },
                  },
                },
              },
            })
          : undefined,
    });
    await assert.rejects(() => operations(provider).checkRepository(params()), {
      code: 'source_incomplete',
    });
  }
});
test('per-collection admission includes PRs, labels, milestones, branches and complete comments', async () => {
  const cases = [
    [{ pulls: [pull(2), pull(3)] }, { pullRequests: 1 }],
    [{ labels: [label({ id: 1 }), label({ id: 2 })] }, { labels: 1 }],
    [
      {
        milestones: [
          milestone({ id: 1, number: 1 }),
          milestone({ id: 2, number: 2 }),
        ],
      },
      { milestones: 1 },
    ],
    [
      {
        branches: [
          { name: 'feature/1', commit: { sha: OTHER_TIP }, protected: false },
        ],
      },
      { branches: 1 },
    ],
    [
      {
        issues: [issue(1, { comments: 2 })],
        comments: { 1: [comment(1), comment(2)] },
      },
      { comments: 1 },
    ],
  ];
  for (const [values, limits] of cases) {
    const provider = fixtureProvider({ values });
    const budget = createOperationBudget({ limits });
    await assert.rejects(
      () => operations(provider).checkRepository(params({ budget })),
      { code: 'source_limit_exceeded' },
    );
  }
});
test('a wrong or malformed source identity cannot become eligible metadata', async () => {
  for (const source of [
    { ...repo, owner: { id: OWNER_ID, login: 'cboone', type: 'Organization' } },
    {
      ...repo,
      owner: { id: 1, login: 'other', type: 'User' },
      full_name: 'other/widgets',
      html_url: 'https://github.com/other/widgets',
    },
  ]) {
    const provider = fixtureProvider({ values: { repositories: [source] } });
    await assert.rejects(() => operations(provider).checkRepository(params()), {
      code: 'source_unavailable',
    });
  }
  const malformed = fixtureProvider({
    values: { repositories: [{ ...repo, html_url: 'invalid URL' }] },
  });
  await assert.rejects(() => operations(malformed).listRepositories(params()), {
    code: 'source_incomplete',
  });
});
test('GitHub merged PR reference state becomes canonical closed and merged facts', async () => {
  const provider = fixtureProvider({
    values: {
      issues: [issue(1, { body: repo.html_url + '/pull/99' })],
      references: {
        'pulls/99': pull(99, {
          state: 'closed',
          merged: true,
          merge_commit_sha: OTHER_TIP,
        }),
      },
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.deepEqual(result.sourceSnapshot.references[0].facts, {
    repoId: repo.id,
    id: 1099,
    number: 99,
    type: 'pull',
    state: 'closed',
    merged: true,
    mergeSha: OTHER_TIP,
  });
  assert.equal(referenceCalls(provider).length, 2);
});
test('an issue cannot use the PR-only MERGED provider state', async () => {
  const provider = fixtureProvider({
    values: { issues: [issue(1, { body: '#99' })] },
    handle: ({ url }) =>
      url.pathname === '/graphql'
        ? json({
            data: {
              repository: {
                databaseId: repo.id,
                nameWithOwner: repo.full_name,
                issueOrPullRequest: {
                  __typename: 'Issue',
                  fullDatabaseId: '1099',
                  number: 99,
                  state: 'MERGED',
                  stateReason: 'COMPLETED',
                  repository: {
                    databaseId: repo.id,
                    nameWithOwner: repo.full_name,
                  },
                },
              },
            },
          })
        : undefined,
  });
  await assert.rejects(() => operations(provider).checkRepository(params()), {
    code: 'source_incomplete',
  });
});
test('Git plaintext credential-store paths are excluded even when issue prose explicitly names them', () => {
  const paths = [
    '.git-credentials',
    'nested/.git-credentials',
    '.config/git/credentials',
  ];
  const tree = paths.map((path) => ({
    path,
    type: 'blob',
    sha: BLOB_ID,
    mode: '100644',
    size: 10,
  }));
  const policy = selectSourceFiles(
    tree,
    [
      issue(1, {
        body: paths.map((path) => '\u0060' + path + '\u0060').join(' '),
      }),
    ],
    SOURCE_LIMITS,
  );
  assert.deepEqual(policy.selected, []);
  assert.equal(policy.excluded, paths.length);
});
test('same-source prose references beyond GraphQL Int stay unverified without an invalid provider read', async () => {
  const provider = fixtureProvider({
    values: {
      issues: [
        issue(1, {
          body: '#2147483648, ' + repo.html_url + '/pull/9007199254740991',
        }),
      ],
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(referenceCalls(provider).length, 0);
  assert.equal(result.summary.provenance.references.unverified, 2);
  assert.ok(
    result.sourceSnapshot.references.every(
      (entry) =>
        entry.verification === 'unverified' &&
        entry.reason === 'unsupported-reference-number' &&
        entry.facts === undefined,
    ),
  );
});
test('the largest supported GraphQL Int reference remains verifiable', async () => {
  const number = 2147483647;
  const provider = fixtureProvider({
    values: {
      issues: [issue(1, { body: '#' + number })],
      references: {
        ['issues/' + number]: issue(number, {
          state: 'closed',
          state_reason: 'completed',
        }),
      },
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(result.summary.provenance.references.verified, 1);
  assert.equal(referenceCalls(provider).length, 2);
  assert.ok(
    referenceCalls(provider).every(
      (call) => JSON.parse(call.init.body).variables.number === number,
    ),
  );
});
test('GraphQL fullDatabaseId joins source items above the 32-bit database identity range', async () => {
  const id = 4000000000;
  const provider = fixtureProvider({
    values: {
      issues: [issue(1, { id, body: '#99' })],
      pulls: [pull(2)],
      closing: {
        2: [
          {
            databaseId: id,
            number: 1,
            repository: { databaseId: repo.id, nameWithOwner: repo.full_name },
          },
        ],
      },
      references: { 'issues/99': refIssue({ id: id + 1 }) },
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(result.sourceSnapshot.inventory.issues[0].inProgress, 'PR #2');
  assert.equal(result.sourceSnapshot.references[0].facts.id, id + 1);
  assert.ok(
    provider.calls
      .filter((call) => call.url.pathname === '/graphql')
      .every((call) =>
        JSON.parse(call.init.body).query.includes('fullDatabaseId'),
      ),
  );
});
test('unrepresentable GraphQL database identities fail rather than rounding a source join', async () => {
  const provider = fixtureProvider({
    values: {
      issues: [issue(1)],
      pulls: [pull(2)],
      closing: {
        2: [
          {
            fullDatabaseId: '9007199254740992',
            number: 1,
            repository: { databaseId: repo.id, nameWithOwner: repo.full_name },
          },
        ],
      },
    },
  });
  await assert.rejects(() => operations(provider).checkRepository(params()), {
    code: 'source_incomplete',
  });
});
test('source branch names reject all controls before canonical inventory progress is built', async () => {
  for (const control of ['\u0001', '\u001f', '\u007f', '\u0080']) {
    const provider = fixtureProvider({
      values: {
        issues: [issue(1)],
        branches: [
          {
            name: 'feature/1-' + control + 'work',
            commit: { sha: OTHER_TIP },
            protected: false,
          },
        ],
      },
    });
    await assert.rejects(() => operations(provider).checkRepository(params()), {
      code: 'source_incomplete',
    });
  }
});
test('valid branch punctuation remains exact in source metadata and canonical progress', async () => {
  const name = 'feature/1-#work';
  const provider = fixtureProvider({
    values: {
      issues: [issue(1)],
      branches: [{ name, commit: { sha: OTHER_TIP }, protected: false }],
    },
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(result.sourceSnapshot.inventory.issues[0].inProgress, name);
  assert.ok(
    result.sourceSnapshot.branches.some((branch) => branch.name === name),
  );
});
test('Unicode-equivalent branch spellings remain distinct with stable progress selection across page order', async () => {
  const branches = ['1-é', '1-e\u0301'].map((name) => ({
    name,
    commit: { sha: OTHER_TIP },
    protected: false,
  }));
  const provider = fixtureProvider({
    values: (pass) => ({
      issues: [issue(1)],
      branches: pass % 2 ? [...branches].reverse() : branches,
    }),
  });
  const result = await operations(provider).checkRepository(params());
  assert.equal(
    result.sourceSnapshot.inventory.issues[0].inProgress,
    '1-e\u0301',
  );
  assert.ok(
    result.sourceSnapshot.branches.some((branch) => branch.name === '1-é'),
  );
  assert.ok(
    result.sourceSnapshot.branches.some(
      (branch) => branch.name === '1-e\u0301',
    ),
  );
});
test('bounded file admission uses total path order for distinct Unicode-equivalent spellings', () => {
  const tree = ['A-é/README.md', 'A-e\u0301/README.md'].map((path) => ({
    path,
    type: 'blob',
    sha: BLOB_ID,
    mode: '100644',
    size: 10,
  }));
  const limits = { ...SOURCE_LIMITS, files: 1 };
  const forward = selectSourceFiles(tree, [], limits);
  const reversed = selectSourceFiles([...tree].reverse(), [], limits);
  assert.deepEqual(forward, reversed);
  assert.equal(forward.selected[0].path, 'A-e\u0301/README.md');
});
test('known agent and hosted CLI credential paths are excluded while agent guidance remains eligible', () => {
  const secrets = [
    '.codex/auth.json',
    '.claude/.credentials.json',
    '.config/gh/hosts.yml',
    '.config/glab-cli/config.yml',
    '.config/netlify/config.json',
    'Library/Preferences/netlify/config.json',
  ];
  const guidance = ['.codex/AGENTS.md', '.claude/CLAUDE.md'];
  const tree = [...secrets, ...guidance].map((path) => ({
    path,
    type: 'blob',
    sha: BLOB_ID,
    mode: '100644',
    size: 10,
  }));
  const body = secrets.map((path) => '\u0060' + path + '\u0060').join(' ');
  const policy = selectSourceFiles(tree, [issue(1, { body })], SOURCE_LIMITS);
  assert.deepEqual(
    policy.selected.map((entry) => entry.path),
    ['.codex/AGENTS.md', '.claude/CLAUDE.md'],
  );
  assert.equal(policy.excluded, secrets.length);
  assert.equal(isKnownCredentialPath('.codex/auth.json/cache'), true);
  assert.equal(isKnownCredentialPath('nested/.env.production/child'), true);
  assert.equal(isKnownCredentialPath('.codex/AGENTS.md'), false);
});
test('eligible repository inventory admits10000 and explicitly rejects10001 without truncation', async () => {
  const repositories = Array.from({ length: 10001 }, (_, index) => ({
    ...repo,
    id: index + 1,
    name: 'repo-' + index,
    full_name: 'cboone/repo-' + index,
    html_url: 'https://github.com/cboone/repo-' + index,
  }));
  const admitted = fixtureProvider({
    values: { repositories: repositories.slice(0, 10000) },
  });
  const result = await operations(admitted).listRepositories(params());
  assert.equal(result.repositories.length, 10000);
  const exceeded = fixtureProvider({ values: { repositories } });
  await assert.rejects(() => operations(exceeded).listRepositories(params()), {
    code: 'source_limit_exceeded',
  });
});
test('repository admission counts eligible joined identities rather than fork/archive rows', async () => {
  const extra = {
    ...repo,
    id: 8,
    name: 'fork',
    full_name: 'cboone/fork',
    html_url: 'https://github.com/cboone/fork',
    fork: true,
  };
  const provider = fixtureProvider({ values: { repositories: [repo, extra] } });
  const budget = createOperationBudget({ limits: { repositories: 1 } });
  assert.equal(
    (await operations(provider).listRepositories(params({ budget })))
      .repositories.length,
    1,
  );
});
