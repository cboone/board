import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  analysisAvailability,
  deferred,
  ignoreAbortForRace,
  jobId,
  mockApi,
  repositories,
  reportId,
  safeJob,
  savedBoard,
  sourceFingerprint,
  sourceSummary,
} from './mock-api.js';

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

test('offers sign-in without reading repositories or reports', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.authenticated = false;
  await page.goto('/');
  await expect(
    page.getByRole('link', { name: 'Sign in with GitHub' }),
  ).toHaveAttribute('href', '/api/auth/start');
  expect(flow.calls.map(({ path }) => path)).toEqual(['/api/session']);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('lists eligible repositories separately from saved unavailable boards', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const historical = {
    id: 303,
    name: 'historical-board',
    fullName: 'cboone/historical-board',
    private: true,
    url: 'https://github.com/cboone/historical-board',
  };
  flow.catalog = {
    items: [
      {
        repository: repositories[0],
        current: {
          reportId,
          generatedAt: '2026-09-18T20:10:00.000Z',
          sourceFingerprint,
        },
        sourceStatus: 'ready',
        activeJob: null,
      },
      {
        repository: historical,
        current: {
          reportId: '4'.repeat(64),
          generatedAt: '2026-09-17T20:10:00.000Z',
          sourceFingerprint: '5'.repeat(64),
        },
        sourceStatus: 'source-unavailable',
        activeJob: null,
      },
    ],
    nextCursor: null,
  };
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Currently eligible' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Saved boards currently unavailable',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'cboone/historical-board' }),
  ).toBeVisible();
  await expect(page.getByLabel('Repository')).toHaveValue('');
});

test('authorizes the owner by numeric ID when the display login changes', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
  flow.session = async () => ({
    status: 200,
    data: {
      auth: true,
      user: { id: 99961, login: 'cboone-renamed' },
      csrfToken: flow.csrfToken,
      sourceAuthorization: 'ready',
    },
  });

  await page.goto('/repositories/202');
  await expect(page.getByText('Signed in as @cboone-renamed')).toBeVisible();
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
});

test('loads a saved report before its automatic free source check completes', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
  const pending = deferred();
  const started = deferred();
  flow.check = async () => {
    started.resolve();
    await pending.promise;
    return {
      status: 503,
      data: { error: { code: 'provider_unavailable', retryable: true } },
    };
  };
  await page.goto('/repositories/202');
  await started.promise;
  await expect(page.locator('#selected-repository-title')).toBeVisible();
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
  await expect(
    page.getByText('Checking GitHub for source changes…'),
  ).toBeVisible();
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
  pending.resolve();
  await expect(page.getByRole('alert')).toContainText('GitHub is unavailable');
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
});

test('preserves the last successful source check when a later check fails', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
  const successfulFingerprint = 'e'.repeat(64);
  let checks = 0;
  flow.check = async () => {
    checks += 1;
    return checks === 1
      ? {
          status: 200,
          data: sourceSummary(repositories[1], successfulFingerprint),
        }
      : {
          status: 429,
          data: {
            error: {
              code: 'provider_rate_limited',
              message: 'provider-secret-fixture',
              retryable: true,
            },
          },
        };
  };
  await page.goto('/repositories/202');
  await expect(page.getByText('GitHub changes were detected')).toBeVisible();
  await page.getByRole('button', { name: 'Check GitHub' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'GitHub limited the requests',
  );
  await page.getByText('GitHub check details').click();
  await expect(
    page.getByText(`Source fingerprint: ${successfulFingerprint}`),
  ).toBeVisible();
  await expect(page.getByText('provider-secret-fixture')).toHaveCount(0);
});

test('clears protected report data and withholds a late check after sign-out', async ({
  page,
}) => {
  await ignoreAbortForRace(page);
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
  const pending = deferred();
  const started = deferred();
  flow.check = async () => {
    started.resolve();
    await pending.promise;
    return { status: 200, data: sourceSummary() };
  };
  await page.goto('/repositories/202');
  await started.promise;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out of Board.')).toBeVisible();
  await expect(page.locator('#saved-report')).toHaveCount(0);
  pending.resolve();
  await expect(page.getByLabel('Repository')).toHaveCount(0);
  expect(
    flow.calls.find(({ path }) => path === '/api/auth/logout').csrfToken,
  ).toBe('s'.repeat(43));
});

test('clears the dashboard setup spending projection on sign-out', async ({
  page,
}) => {
  const flow = await mockApi(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Setup analysis spending' }),
  ).toBeVisible();
  expect(
    flow.calls.some(
      ({ method, path }) =>
        method === 'GET' && path === '/api/analysis-availability',
    ),
  ).toBe(true);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out of Board.')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Setup analysis spending' }),
  ).toHaveCount(0);
});

test('withholds late repository and report catalog responses after sign-out', async ({
  page,
}) => {
  await ignoreAbortForRace(page);
  const flow = await mockApi(page);
  const pending = deferred();
  const repositoriesStarted = deferred();
  const reportsStarted = deferred();
  flow.list = async () => {
    repositoriesStarted.resolve();
    await pending.promise;
    return { status: 200, data: { repositories } };
  };
  flow.reports = async () => {
    reportsStarted.resolve();
    await pending.promise;
    return {
      status: 200,
      data: {
        items: [
          {
            repository: repositories[1],
            current: {
              reportId,
              generatedAt: '2026-09-18T20:10:00.000Z',
              sourceFingerprint,
            },
            sourceStatus: 'ready',
            activeJob: null,
          },
        ],
        nextCursor: null,
      },
    };
  };
  await page.goto('/');
  await Promise.all([repositoriesStarted.promise, reportsStarted.promise]);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out of Board.')).toBeVisible();
  const repositoriesResponse = page.waitForResponse('**/api/repositories');
  const reportsResponse = page.waitForResponse('**/api/reports');
  pending.resolve();
  await Promise.all([repositoriesResponse, reportsResponse]);
  await expect(page.getByLabel('Repository')).toHaveCount(0);
  await expect(page.getByText('sample-board-private')).toHaveCount(0);
});

test('withholds a late direct report response after sign-out', async ({
  page,
}) => {
  await ignoreAbortForRace(page);
  const flow = await mockApi(page);
  const pending = deferred();
  const started = deferred();
  flow.report = async () => {
    started.resolve();
    await pending.promise;
    return { status: 200, data: savedBoard() };
  };
  await page.goto('/repositories/202');
  await started.promise;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out of Board.')).toBeVisible();
  const response = page.waitForResponse('**/api/repositories/202/report');
  pending.resolve();
  await response;
  await expect(page.locator('#saved-report')).toHaveCount(0);
  await expect(page.getByLabel('Repository')).toHaveCount(0);
  expect(
    flow.calls.filter(({ path }) => path === '/api/repositories/202/check'),
  ).toEqual([]);
});

test('withholds a late analysis availability response after sign-out', async ({
  page,
}) => {
  await ignoreAbortForRace(page);
  const flow = await mockApi(page);
  const pending = deferred();
  const started = deferred();
  flow.availability = async () => {
    started.resolve();
    await pending.promise;
    return {
      status: 200,
      data: analysisAvailability(),
    };
  };
  await page.goto('/repositories/202');
  await started.promise;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out of Board.')).toBeVisible();
  const response = page.waitForResponse('**/api/analysis-availability');
  pending.resolve();
  await response;
  await expect(
    page.getByRole('button', { name: 'Generate report' }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Repository')).toHaveCount(0);
});

test('withholds a late active-job poll response after sign-out', async ({
  page,
}) => {
  await ignoreAbortForRace(page);
  const flow = await mockApi(page);
  flow.boards.set(
    202,
    savedBoard(repositories[1], {
      activeJob: safeJob('analyzing', { operation: 'refresh' }),
    }),
  );
  const pending = deferred();
  const started = deferred();
  flow.job = async () => {
    started.resolve();
    await pending.promise;
    return {
      status: 200,
      data: {
        job: safeJob('succeeded', { operation: 'refresh' }),
      },
    };
  };
  await page.goto('/repositories/202');
  await started.promise;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out of Board.')).toBeVisible();
  const response = page.waitForResponse(`**/api/report-jobs/${jobId}`);
  pending.resolve();
  await response;
  await expect(page.locator('#saved-report')).toHaveCount(0);
  await expect(page.getByText('Report analysis complete')).toHaveCount(0);
  await expect(page.getByLabel('Repository')).toHaveCount(0);
});

test('ignores an old-session 401 after a new session is established', async ({
  page,
}) => {
  await ignoreAbortForRace(page);
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
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
  await started.promise;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out of Board.')).toBeVisible();
  flow.authenticated = true;
  flow.csrfToken = 'n'.repeat(43);
  await page.getByRole('button', { name: 'Check session' }).click();
  await expect(page.getByText('Signed in as @cboone')).toBeVisible();
  const response = page.waitForResponse('**/api/repositories/202/check');
  pending.resolve();
  await response;
  await expect(page.getByText('Signed in as @cboone')).toBeVisible();
  await expect(page.getByLabel('Repository')).toBeVisible();
  await expect(page.getByText('Your Board session has ended.')).toHaveCount(0);
});

test('withholds a pending protected response when periodic session verification observes expiry', async ({
  page,
}) => {
  await page.clock.install();
  await ignoreAbortForRace(page);
  const flow = await mockApi(page);
  const pending = deferred();
  const started = deferred();
  flow.report = async () => {
    started.resolve();
    await pending.promise;
    return { status: 200, data: savedBoard() };
  };
  await page.goto('/repositories/202');
  await started.promise;
  flow.authenticated = false;
  await page.clock.fastForward(60000);
  await expect(
    page.getByRole('link', { name: 'Sign in with GitHub' }),
  ).toBeVisible();
  await expect(page.getByLabel('Repository')).toHaveCount(0);
  const response = page.waitForResponse('**/api/repositories/202/report');
  pending.resolve();
  await response;
  await expect(page.locator('#saved-report')).toHaveCount(0);
  expect(flow.calls.at(-1).path).toBe('/api/session');
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
});

test('clears protected content when an authoritative request observes session expiry', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
  let checks = 0;
  flow.check = async () => {
    checks += 1;
    return checks === 1
      ? { status: 200, data: sourceSummary() }
      : {
          status: 401,
          data: { error: { code: 'session_required', retryable: false } },
        };
  };
  await page.goto('/repositories/202');
  await expect(page.getByText('saved report matches')).toBeVisible();
  await page.getByRole('button', { name: 'Check GitHub' }).click();
  await expect(
    page.getByRole('link', { name: 'Sign in with GitHub' }),
  ).toBeVisible();
  await expect(page.locator('#saved-report')).toHaveCount(0);
  await expect(page.getByLabel('Repository')).toHaveCount(0);
});

test('preserves Board authentication and the saved report when GitHub needs reauthorization', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
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
  await expect(
    page.getByRole('link', { name: 'Reconnect GitHub' }),
  ).toBeVisible();
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
  await expect(
    page.getByRole('button', { name: 'Refresh report' }),
  ).toBeDisabled();
  await expect(page.getByText('provider-secret-fixture')).toHaveCount(0);
});

test('reports failed server sign-out while keeping protected data cleared', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
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
  await expect(page.locator('#saved-report')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    page.getByText('server sign-out could not be confirmed', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('#saved-report')).toHaveCount(0);
  await expect(page.getByText('provider-secret-fixture')).toHaveCount(0);
});

test('revalidates the session before restoring a protected page from the sample', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
  await page.goto('/repositories/202');
  await expect(page.locator('#saved-report')).toBeVisible();
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
  await expect(page.getByText('Checking your session…')).toBeVisible();
  await expect(page.getByLabel('Repository')).toHaveCount(0);
  await expect(page.locator('#saved-report')).toHaveCount(0);
  pending.resolve();
  await expect(
    page.getByRole('link', { name: 'Sign in with GitHub' }),
  ).toBeVisible();
});

test('shows a generic callback failure and removes its query', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.authenticated = false;
  await page.goto('/?auth_error=forbidden');
  await expect(
    page.getByText('GitHub sign-in could not be completed. Please try again.'),
  ).toBeVisible();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('forbidden')).toHaveCount(0);
});

test('rejects wrong-owner repository and report catalog responses', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const wrongRepository = {
    ...repositories[1],
    fullName: 'another-owner/sample-board-private',
    url: 'https://github.com/another-owner/sample-board-private',
  };
  const wrongSavedRepository = {
    id: 303,
    name: 'historical-board',
    fullName: 'another-owner/historical-board',
    private: true,
    url: 'https://github.com/another-owner/historical-board',
  };
  flow.repositories = [wrongRepository];
  flow.catalog = {
    items: [
      {
        repository: wrongSavedRepository,
        current: {
          reportId,
          generatedAt: '2026-09-18T20:10:00.000Z',
          sourceFingerprint,
        },
        sourceStatus: 'source-unavailable',
        activeJob: null,
      },
    ],
    nextCursor: null,
  };
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('incomplete response');
  await expect(page.getByLabel('Repository')).toHaveCount(0);
  await expect(page.getByText('another-owner')).toHaveCount(0);
});

test('rejects a malformed source response without rendering partial details', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const malformed = sourceSummary();
  malformed.counts.openIssues = -1;
  flow.check = async () => ({ status: 200, data: malformed });
  await page.goto('/repositories/202');
  await expect(page.getByRole('alert')).toContainText('incomplete response');
  await expect(page.getByText('GitHub check details')).toHaveCount(0);
});

test('renders source provenance literally and remains accessible at a narrow viewport', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const summary = sourceSummary();
  summary.provenance.limitations = ['<img src=x onerror=alert(1)>'];
  flow.check = async () => ({ status: 200, data: summary });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/repositories/202');
  await page.getByText('GitHub check details').click();
  await expect(
    page.getByText('<img src=x onerror=alert(1)>', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('#production img')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
