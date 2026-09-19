export const APP_ID = 123;
export const OWNER_ID = 99961;
export const TIP = 'a'.repeat(40);
export const OTHER_TIP = 'b'.repeat(40);
export const BLOB_ID = 'c'.repeat(40);
export const AT = '2026-09-18T12:00:00Z';
export const repo = {
  id: 7,
  name: 'widgets',
  full_name: 'cboone/widgets',
  owner: { id: OWNER_ID, login: 'cboone', type: 'User' },
  html_url: 'https://github.com/cboone/widgets',
  private: true,
  fork: false,
  archived: false,
  default_branch: 'main',
};
export const installation = {
  id: 1,
  app_id: APP_ID,
  account: { id: OWNER_ID, type: 'User' },
  suspended_at: null,
  permissions: {
    metadata: 'read',
    issues: 'read',
    pull_requests: 'read',
    contents: 'read',
  },
};
export function label(overrides = {}) {
  return {
    id: 11,
    name: 'in progress',
    color: 'eeeeee',
    description: null,
    ...overrides,
  };
}
export function milestone(overrides = {}) {
  return {
    id: 12,
    number: 1,
    title: 'First release',
    description: null,
    state: 'open',
    due_on: null,
    updated_at: AT,
    ...overrides,
  };
}
export function issue(number = 1, overrides = {}) {
  return {
    id: 1000 + number,
    number,
    title: 'Issue ' + number,
    body: null,
    state: 'open',
    state_reason: null,
    labels: [],
    milestone: null,
    assignees: [],
    comments: 0,
    created_at: AT,
    updated_at: AT,
    html_url: repo.html_url + '/issues/' + number,
    ...overrides,
  };
}
export function pull(number = 2, overrides = {}) {
  return {
    id: 1000 + number,
    number,
    title: 'Pull request ' + number,
    body: null,
    state: 'open',
    draft: false,
    updated_at: AT,
    base: {
      ref: 'main',
      sha: TIP,
      repo: { id: repo.id, full_name: repo.full_name },
    },
    head: {
      ref: 'feature/' + number + '-work',
      sha: OTHER_TIP,
      repo: { id: repo.id },
    },
    merged: false,
    merge_commit_sha: null,
    ...overrides,
  };
}
export function comment(id = 1, overrides = {}) {
  return { id, body: 'Comment text', updated_at: AT, ...overrides };
}
export function json(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Provider-shaped fixtures; no real requests or credentials. */
export function fixtureProvider(options = {}) {
  const calls = [];
  let pass = 0;
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init, pass });
    if (options.handle) {
      const handled = await options.handle({ url, init, pass, calls });
      if (handled !== undefined) return handled;
    }
    const values =
      typeof options.values === 'function'
        ? options.values(pass)
        : (options.values ?? {});
    const page = Number(url.searchParams.get('page') ?? 1);
    const paged = (items, path, key) => {
      const size = Number(url.searchParams.get('per_page') ?? 100);
      const slice = items.slice((page - 1) * size, page * size);
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      const headers =
        page * size < items.length
          ? { link: '<' + next.href + '>; rel="next"' }
          : {};
      return json(key ? { [key]: slice } : slice, { headers });
    };
    if (url.pathname === '/user/installations')
      return paged(
        values.installations ?? [installation],
        url.pathname,
        'installations',
      );
    if (/^\/user\/installations\/\d+\/repositories$/u.test(url.pathname))
      return paged(values.repositories ?? [repo], url.pathname, 'repositories');
    if (url.pathname === '/repos/cboone/widgets') {
      // Each complete pass pins twice; the next observation sees new values.
      const result = values.repo ?? repo;
      if (
        calls.filter((call) => call.url.pathname === '/repos/cboone/widgets')
          .length %
          2 ===
        0
      )
        pass += 1;
      return json(result);
    }
    if (url.pathname === '/repos/cboone/widgets/branches/main')
      return json({ name: 'main', commit: { sha: values.tip ?? TIP } });
    if (url.pathname === '/repos/cboone/widgets/issues') {
      const issueList = [...(values.issues ?? [])];
      for (const item of values.pulls ?? []) {
        if (
          !issueList.some(
            (candidate) =>
              candidate.number === item.number && candidate.pull_request,
          )
        )
          issueList.push(
            issue(item.number, {
              ...item,
              // GitHub assigns separate database IDs to the Issue and
              // PullRequest representations of one pull request.
              id: 2000 + item.number,
              pull_request: {
                url:
                  'https://api.github.com/repos/cboone/widgets/pulls/' +
                  item.number,
              },
            }),
          );
      }
      return paged(issueList, url.pathname);
    }
    if (url.pathname === '/repos/cboone/widgets/pulls')
      return paged(values.pulls ?? [], url.pathname);
    if (url.pathname === '/repos/cboone/widgets/milestones')
      return paged(values.milestones ?? [], url.pathname);
    if (url.pathname === '/repos/cboone/widgets/labels')
      return paged(values.labels ?? [], url.pathname);
    if (url.pathname === '/repos/cboone/widgets/branches') {
      const branches = [...(values.branches ?? [])];
      if (!branches.some((item) => item.name === 'main'))
        branches.push({
          name: 'main',
          commit: { sha: values.tip ?? TIP },
          protected: false,
        });
      return paged(branches, url.pathname);
    }
    const comments =
      /^\/repos\/cboone\/widgets\/issues\/(\d+)\/comments$/u.exec(url.pathname);
    if (comments)
      return paged(values.comments?.[comments[1]] ?? [], url.pathname);
    const ref = /^\/repos\/cboone\/widgets\/(issues|pulls)\/(\d+)$/u.exec(
      url.pathname,
    );
    if (ref) {
      const value = values.references?.[ref[1] + '/' + ref[2]];
      return value instanceof Response
        ? value
        : value
          ? json(value)
          : json({}, { status: 404 });
    }
    if (url.pathname === '/graphql') {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes('query ReferenceFacts')) {
        const target =
          values.references?.['issues/' + variables.number] ??
          values.references?.['pulls/' + variables.number];
        if (target instanceof Response) return target.clone();
        const isPull = Boolean(
          values.references?.['pulls/' + variables.number],
        );
        return json({
          data: {
            repository: {
              databaseId: repo.id,
              nameWithOwner: repo.full_name,
              issueOrPullRequest: target
                ? {
                    __typename: isPull ? 'PullRequest' : 'Issue',
                    fullDatabaseId: String(target.id),
                    number: target.number,
                    state:
                      isPull && target.merged
                        ? 'MERGED'
                        : target.state.toUpperCase(),
                    repository: {
                      databaseId: repo.id,
                      nameWithOwner: repo.full_name,
                    },
                    ...(isPull
                      ? {
                          merged: target.merged,
                          mergeCommit:
                            target.merge_commit_sha === null
                              ? null
                              : { oid: target.merge_commit_sha },
                        }
                      : {
                          stateReason:
                            target.state_reason === null
                              ? null
                              : target.state_reason.toUpperCase(),
                        }),
                  }
                : null,
            },
          },
        });
      }
      const nodes = values.closing?.[variables.number] ?? [];
      const offset = variables.cursor ? Number(variables.cursor) : 0;
      const next = offset + 100;
      return json({
        data: {
          repository: {
            databaseId: repo.id,
            nameWithOwner: repo.full_name,
            pullRequest: {
              number: variables.number,
              closingIssuesReferences: {
                nodes: nodes
                  .slice(offset, next)
                  .map(({ databaseId, ...node }) => ({
                    ...node,
                    fullDatabaseId: node.fullDatabaseId ?? String(databaseId),
                  })),
                pageInfo: {
                  hasNextPage: next < nodes.length,
                  endCursor: next < nodes.length ? String(next) : null,
                },
              },
            },
          },
        },
      });
    }
    if (url.pathname.startsWith('/repos/cboone/widgets/compare/'))
      return json(
        values.comparison ?? { status: 'ahead', ahead_by: 1, behind_by: 0 },
      );
    if (url.pathname.startsWith('/repos/cboone/widgets/git/trees/'))
      return json({ tree: values.tree ?? [], truncated: false });
    if (url.pathname.startsWith('/repos/cboone/widgets/git/blobs/')) {
      const blobId = url.pathname.split('/').at(-1);
      const source =
        values.fileContents?.[blobId] ??
        values.fileBytes ??
        values.fileContent ??
        'Sample repository guidance';
      const content = Buffer.from(source);
      return json({
        sha: blobId,
        size: content.byteLength,
        encoding: 'base64',
        content: content.toString('base64'),
      });
    }
    throw new Error('Unexpected fixture request: ' + url.pathname);
  };
  return { fetchImpl, calls };
}
