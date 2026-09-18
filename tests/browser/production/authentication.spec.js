import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const syntheticRepositories = [
  {
    id: 101,
    name: 'sample-board-public',
    fullName: 'cboone/sample-board-public',
    private: false,
    url: 'https://github.com/cboone/sample-board-public',
  },
  {
    id: 202,
    name: 'sample-board-private',
    fullName: 'cboone/sample-board-private',
    private: true,
    url: 'https://github.com/cboone/sample-board-private',
  },
];

function syntheticSummary(repository = syntheticRepositories[1]) {
  return {
    status: 'complete',
    repo: repository,
    sync: {
      at: '2026-09-18T12:00:00.000Z',
      timeZone: 'UTC',
      branch: 'main',
      commit: 'a'.repeat(40),
      openPullRequests: 1,
    },
    fingerprint: {
      algorithm: 'sha256',
      value: 'b'.repeat(64),
      scope: 'core-and-collected-context',
    },
    provenance: {
      observedFrom: '2026-09-18T11:59:50.000Z',
      observedTo: '2026-09-18T12:00:00.000Z',
      consistency: 'two-pass-matched',
      inputs: [{ name: 'issues', status: 'complete' }],
      files: [{ path: 'README.md', blobId: 'c'.repeat(40) }],
      references: { verified: 1, unverified: 1 },
      limitations: ['External references remain unverified.'],
    },
    counts: {
      openIssues: 3,
      openPullRequests: 1,
      milestones: 1,
      labels: 4,
      branches: 2,
      unmergedBranches: 1,
      issueComments: 5,
      treeEntries: 20,
      selectedFiles: 1,
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function ignoreAbortForRace(page) {
  await page.addInitScript(() => {
    const fetchRequest = window.fetch.bind(window);
    // Completion may already be in flight when a caller requests cancellation.
    window.fetch = (input, options = {}) =>
      fetchRequest(input, { ...options, signal: undefined });
  });
}

async function mockApi(page) {
  const flow = {
    authenticated: true,
    csrfToken: 's'.repeat(43),
    sourceAuthorization: 'ready',
    repositories: syntheticRepositories,
    calls: [],
    session: null,
    list: null,
    check: null,
    logout: null,
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    flow.calls.push({
      method: request.method(),
      path,
      csrfToken: request.headers()['x-csrf-token'],
    });
    let response;
    if (path === '/api/session') {
      response = flow.session
        ? await flow.session()
        : {
            status: 200,
            data: flow.authenticated
              ? {
                  auth: true,
                  user: { id: 99961, login: 'cboone' },
                  csrfToken: flow.csrfToken,
                  sourceAuthorization: flow.sourceAuthorization,
                }
              : { auth: false },
          };
    } else if (path === '/api/repositories') {
      response = flow.list
        ? await flow.list()
        : { status: 200, data: { repositories: flow.repositories } };
    } else if (/^\/api\/repositories\/[1-9]\d*\/check$/u.test(path)) {
      response = flow.check
        ? await flow.check(path)
        : {
            status: 200,
            data: syntheticSummary(
              syntheticRepositories.find((repo) =>
                path.includes(`/${repo.id}/`),
              ),
            ),
          };
    } else if (path === '/api/auth/logout') {
      response = flow.logout
        ? await flow.logout()
        : { status: 200, data: { ok: true } };
      if (response.status === 200) flow.authenticated = false;
    } else {
      response = {
        status: 404,
        data: { error: { code: 'invalid_request', retryable: false } },
      };
    }
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(response.data),
    });
  });
  return flow;
}

const traffic = new WeakMap();
test.beforeEach(async ({ page }) => {
  const requests = [];
  traffic.set(page, requests);
  page.on('request', (request) => requests.push(request.url()));
});

test.afterEach(async ({ page }) => {
  expect(
    traffic
      .get(page)
      .filter((url) => !url.startsWith('http://127.0.0.1:4174/')),
  ).toEqual([]);
});

test('offers sign-in without repository access or paid calls', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.authenticated = false;
  await page.goto('/');
  await expect(
    page.getByRole('link', { name: 'Sign in with GitHub' }),
  ).toHaveAttribute('href', '/api/auth/start');
  await expect(page.getByLabel('Repository', { exact: true })).toHaveCount(0);
  expect(flow.calls).toEqual([
    { method: 'GET', path: '/api/session', csrfToken: undefined },
  ]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('selects repositories freely and explicitly checks approved inputs', async ({
  page,
}) => {
  const flow = await mockApi(page);
  await page.goto('/');
  await page.getByLabel('Repository', { exact: true }).selectOption('202');
  await expect(page).toHaveURL('/repositories/202');
  expect(flow.calls.filter(({ method }) => method === 'POST')).toEqual([]);
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toBeVisible();
  expect(flow.calls.at(-1)).toEqual({
    method: 'POST',
    path: '/api/repositories/202/check',
    csrfToken: flow.csrfToken,
  });
  await page.getByText('Input provenance', { exact: true }).click();
  await expect(page.getByText('README.md', { exact: true })).toBeVisible();
  await expect(
    page.getByText('External references remain unverified.', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('reloads a protected repository address after verifying the session', async ({
  page,
}) => {
  const flow = await mockApi(page);
  await page.goto('/repositories/101');
  await expect(
    page.getByRole('heading', { name: 'cboone/sample-board-public' }),
  ).toBeVisible();
  expect(flow.calls.map(({ path }) => path)).toEqual([
    '/api/session',
    '/api/repositories',
  ]);
  await page.reload();
  await expect(page.getByLabel('Repository', { exact: true })).toHaveValue(
    '101',
  );
  expect(flow.calls.filter(({ method }) => method === 'POST')).toEqual([]);
});

test('clears protected content immediately and withholds late successful checks after logout', async ({
  page,
}) => {
  await ignoreAbortForRace(page);
  const flow = await mockApi(page);
  const pending = deferred();
  const started = deferred();
  flow.check = async () => {
    started.resolve();
    await pending.promise;
    return { status: 200, data: syntheticSummary() };
  };
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await started.promise;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByText('Signed out of Board.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('cboone/sample-board-private', { exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveTitle('Board');
  const response = page.waitForResponse('**/api/repositories/202/check');
  pending.resolve();
  await response;
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Repository', { exact: true })).toHaveCount(0);
  expect(
    flow.calls.find(({ path }) => path === '/api/auth/logout').csrfToken,
  ).toBe('s'.repeat(43));
});

test('does not restore a late repository list after logout', async ({
  page,
}) => {
  await ignoreAbortForRace(page);
  const flow = await mockApi(page);
  const pending = deferred();
  const started = deferred();
  flow.list = async () => {
    started.resolve();
    await pending.promise;
    return { status: 200, data: { repositories: syntheticRepositories } };
  };
  await page.goto('/');
  await started.promise;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByText('Signed out of Board.', { exact: true }),
  ).toBeVisible();
  const response = page.waitForResponse('**/api/repositories');
  pending.resolve();
  await response;
  await expect(page.getByLabel('Repository', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('sample-board-private', { exact: false }),
  ).toHaveCount(0);
});

test('ignores an old session 401 after a new session is established', async ({
  page,
}) => {
  await ignoreAbortForRace(page);
  const flow = await mockApi(page);
  const pending = deferred();
  const started = deferred();
  flow.check = async () => {
    started.resolve();
    await pending.promise;
    return {
      status: 401,
      data: { error: { code: 'session_required', retryable: false } },
    };
  };
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await started.promise;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByText('Signed out of Board.', { exact: true }),
  ).toBeVisible();
  flow.authenticated = true;
  flow.csrfToken = 'n'.repeat(43);
  await page
    .getByRole('button', { name: 'Check session', exact: true })
    .click();
  await expect(page.getByLabel('Repository', { exact: true })).toBeVisible();
  const response = page.waitForResponse('**/api/repositories/202/check');
  pending.resolve();
  await response;
  await expect(
    page.getByText('Signed in as @cboone', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Repository', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Your Board session has ended.', { exact: false }),
  ).toHaveCount(0);
});

test('clears protected content when the authoritative session expires', async ({
  page,
}) => {
  const flow = await mockApi(page);
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toBeVisible();
  flow.check = async () => ({
    status: 401,
    data: { error: { code: 'session_required', retryable: false } },
  });
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Sign in with GitHub' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Repository', { exact: true })).toHaveCount(0);
  await expect(page).toHaveTitle('Board');
});

test('withholds a pending check when periodic session verification observes expiry', async ({
  page,
}) => {
  await page.clock.install();
  await ignoreAbortForRace(page);
  const flow = await mockApi(page);
  const pending = deferred();
  const started = deferred();
  flow.check = async () => {
    started.resolve();
    await pending.promise;
    return { status: 200, data: syntheticSummary() };
  };
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await started.promise;
  flow.authenticated = false;
  await page.clock.fastForward(60000);
  await expect(
    page.getByRole('link', { name: 'Sign in with GitHub' }),
  ).toBeVisible();
  await expect(page.getByLabel('Repository', { exact: true })).toHaveCount(0);
  const response = page.waitForResponse('**/api/repositories/202/check');
  pending.resolve();
  await response;
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toHaveCount(0);
  expect(flow.calls.at(-1).path).toBe('/api/session');
});

test('preserves Board authentication when GitHub needs reauthorization', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.check = async () => ({
    status: 403,
    data: {
      error: {
        code: 'source_authorization_required',
        message: 'provider-secret-fixture',
        retryable: false,
      },
    },
  });
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Reconnect GitHub' }),
  ).toBeVisible();
  await expect(
    page.getByText('Signed in as @cboone', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Repository', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Check GitHub', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('provider-secret-fixture', { exact: true }),
  ).toHaveCount(0);
});

test('reports a failed logout honestly while clearing all protected data', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.logout = async () => ({
    status: 503,
    data: {
      error: {
        code: 'service_unavailable',
        message: 'provider-secret-fixture',
        retryable: true,
      },
    },
  });
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByText('server sign-out could not be confirmed', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('Signed out of Board.', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Repository', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toHaveCount(0);
  await expect(
    page.getByText('provider-secret-fixture', { exact: true }),
  ).toHaveCount(0);
});

test('validates authorization before returning through browser history after logout', async ({
  page,
}) => {
  const flow = await mockApi(page);
  await page.goto('/');
  await page.getByLabel('Repository', { exact: true }).selectOption('202');
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByText('Signed out of Board.', { exact: true }),
  ).toBeVisible();
  const pending = deferred();
  flow.session = async () => {
    await pending.promise;
    return { status: 200, data: { auth: false } };
  };
  await page.goBack();
  await expect(
    page.getByText('Checking your session…', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Repository', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toHaveCount(0);
  pending.resolve();
  await expect(
    page.getByRole('link', { name: 'Sign in with GitHub' }),
  ).toBeVisible();
});

test('checks the session again when a protected page returns after navigation', async ({
  page,
}) => {
  const flow = await mockApi(page);
  await page.goto('/repositories/202');
  await expect(page.getByLabel('Repository', { exact: true })).toBeVisible();
  await page.goto('/demo');
  await expect(
    page.getByRole('heading', { name: 'Sample backlog report' }),
  ).toBeVisible();
  const pending = deferred();
  flow.session = async () => {
    await pending.promise;
    return { status: 200, data: { auth: false } };
  };
  await page.goBack({ waitUntil: 'commit' });
  await expect(
    page.getByText('Checking your session…', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Repository', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('sample-board-private', { exact: false }),
  ).toHaveCount(0);
  pending.resolve();
  await expect(
    page.getByRole('link', { name: 'Sign in with GitHub' }),
  ).toBeVisible();
});

test('preserves the last successful check separately from a failed check', async ({
  page,
}) => {
  const flow = await mockApi(page);
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toBeVisible();
  flow.check = async () => ({
    status: 429,
    data: {
      error: {
        code: 'provider_rate_limited',
        message: 'provider-secret-fixture',
        retryable: true,
      },
    },
  });
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'GitHub limited the requests.',
  );
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toBeVisible();
  await expect(
    page.getByText('provider-secret-fixture', { exact: true }),
  ).toHaveCount(0);
});

test('rejects repository metadata for another owner before rendering it', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.repositories = [
    {
      ...syntheticRepositories[1],
      fullName: 'another-owner/sample-board-private',
      url: 'https://github.com/another-owner/sample-board-private',
    },
  ];
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('incomplete response');
  await expect(page.getByLabel('Repository', { exact: true })).toHaveCount(0);
  await expect(page.getByText('another-owner', { exact: false })).toHaveCount(
    0,
  );
});

test('rejects malformed source summaries without displaying a partial success', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const summary = syntheticSummary();
  summary.counts.openIssues = -1;
  flow.check = async () => ({ status: 200, data: summary });
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('incomplete response');
  await expect(
    page.getByRole('heading', { name: 'GitHub check complete' }),
  ).toHaveCount(0);
});

test('renders provenance text literally and supports narrow screens and themes', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const summary = syntheticSummary();
  summary.provenance.limitations = ['<img src=x onerror=alert(1)>'];
  flow.check = async () => ({ status: 200, data: summary });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await page.getByText('Input provenance', { exact: true }).click();
  await expect(
    page.getByText('<img src=x onerror=alert(1)>', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('#production img')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Use dark theme' }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([
    'board.theme',
  ]);
});

test('keeps the production sample independent of authentication and providers', async ({
  page,
}) => {
  const flow = await mockApi(page);
  await page.goto('/demo');
  await expect(
    page.getByRole('heading', { name: 'Sample backlog report' }),
  ).toBeVisible();
  expect(flow.calls).toEqual([]);
  await expect(
    page.getByText('This sample report uses synthetic data.', { exact: true }),
  ).toBeVisible();
});

test('shows a generic callback failure and removes its query without exposing provider text', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.authenticated = false;
  await page.goto('/?auth_error=forbidden');
  await expect(
    page.getByText('GitHub sign-in could not be completed. Please try again.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL('/');
});
