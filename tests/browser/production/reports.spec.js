import { expect, test } from '@playwright/test';
import {
  deferred,
  emptyBoard,
  jobId,
  mockApi,
  repositories,
  reportId,
  safeJob,
  savedBoard,
  sourceSummary,
} from './mock-api.js';

test('generates only after an explicit click and reloads the successful report', async ({
  page,
}) => {
  const flow = await mockApi(page);
  let reportReads = 0;
  flow.report = async () => {
    reportReads += 1;
    return reportReads === 1
      ? {
          status: 404,
          data: { error: { code: 'report_not_found', retryable: false } },
        }
      : { status: 200, data: savedBoard() };
  };
  let polls = 0;
  flow.job = async () => ({
    status: 200,
    data: {
      job: polls++ === 0 ? safeJob('analyzing') : safeJob('succeeded'),
    },
  });
  await page.goto('/repositories/202');
  await expect(
    page.getByRole('heading', { name: 'No saved report yet' }),
  ).toBeVisible();
  expect(
    flow.calls.some(
      ({ method, path }) =>
        method === 'GET' && path === '/api/repositories/202/report',
    ),
  ).toBe(true);
  expect(
    flow.calls.some(
      ({ method, path }) =>
        method === 'POST' && path === '/api/repositories/202/check',
    ),
  ).toBe(true);
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
  await page.getByRole('button', { name: 'Generate report' }).click();
  await expect(page.getByText('Analyzing the backlog…')).toBeVisible();
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
  const admission = flow.calls.find(
    ({ method, path }) =>
      method === 'POST' && path === '/api/repositories/202/report-jobs',
  );
  expect(admission.csrfToken).toBe(flow.csrfToken);
  expect(admission.body).toEqual({
    idempotencyKey: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    ),
    operation: 'generate',
    expectedCurrentReportId: null,
  });
  expect(reportReads).toBe(2);
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });
});

test('enables first-use generation after an unverified session completes a source check', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.sourceAuthorization = 'unverified';
  flow.boards.set(202, emptyBoard());

  await page.goto('/repositories/202');
  await expect(
    page.getByRole('button', { name: 'Generate report' }),
  ).toBeEnabled();
});

test('keeps a saved report readable and refreshable across a repository rename', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const analyzedRepository = {
    ...repositories[1],
    name: 'sample-board-before-rename',
    fullName: 'cboone/sample-board-before-rename',
    url: 'https://github.com/cboone/sample-board-before-rename',
  };
  let reportReads = 0;
  flow.report = async () => {
    reportReads += 1;
    return {
      status: 200,
      data:
        reportReads === 1
          ? savedBoard(analyzedRepository)
          : savedBoard(analyzedRepository, {
              repository: repositories[1],
            }),
    };
  };
  flow.check = async () => ({
    status: 200,
    data: sourceSummary(repositories[1], 'e'.repeat(64)),
  });
  flow.admission = async () => ({
    status: 202,
    data: { job: safeJob('queued', { operation: 'refresh' }) },
  });

  await page.goto('/repositories/202');
  await expect(page.locator('#selected-repository-title')).toContainText(
    repositories[1].fullName,
  );
  await expect(page.getByText('GitHub changes were detected')).toBeVisible();
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );

  await page.reload();
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
  await expect(page.locator('#selected-repository-title')).toContainText(
    repositories[1].fullName,
  );
  await page.getByRole('button', { name: 'Refresh report' }).click();
  await expect
    .poll(
      () =>
        flow.calls.filter(
          ({ method, path }) =>
            method === 'POST' && path === '/api/repositories/202/report-jobs',
        ).length,
    )
    .toBe(1);
  expect(
    flow.calls.find(({ path }) => path.endsWith('/report-jobs')).body,
  ).toMatchObject({ operation: 'refresh', expectedCurrentReportId: reportId });
});

test('resumes an admitted first-generation job even when the catalog has no current report', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(
    202,
    emptyBoard(repositories[1], {
      activeJob: safeJob('gathering'),
    }),
  );
  flow.job = async () => ({
    status: 200,
    data: {
      job: safeJob('failed', { errorCode: 'budget_exhausted' }),
    },
  });
  await page.goto('/repositories/202');
  await expect(
    page.getByRole('heading', { name: 'No saved report yet' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('spending limit');
  expect(flow.catalog.items).toEqual([]);
  expect(
    flow.calls.some(
      ({ method, path }) =>
        method === 'GET' && path === '/api/repositories/202/report',
    ),
  ).toBe(true);
  expect(
    flow.calls.some(
      ({ method, path }) =>
        method === 'GET' && path === `/api/report-jobs/${jobId}`,
    ),
  ).toBe(true);
  expect(
    flow.calls.filter(
      ({ method, path }) =>
        method === 'POST' && path === '/api/repositories/202/report-jobs',
    ),
  ).toEqual([]);
});

test('fails closed when analysis availability cannot be read for a new board', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.availability = async () => ({
    status: 503,
    data: { error: { code: 'service_unavailable', retryable: true } },
  });
  await page.goto('/repositories/202');
  await expect(
    page.getByRole('heading', { name: 'No saved report yet' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Generate report' }),
  ).toBeDisabled();
  await expect(page.getByText('Board is unavailable')).toBeVisible();
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
});

test('rejects a contradictory available response for a new board', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.availability = async () => ({
    status: 200,
    data: {
      spendMode: {
        available: true,
        mode: 'disabled',
        reason: 'budget_exhausted',
      },
    },
  });
  await page.goto('/repositories/202');
  await expect(
    page.getByRole('button', { name: 'Generate report' }),
  ).toBeDisabled();
  await expect(page.getByText('incomplete response')).toBeVisible();
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
});

test('refreshes against the displayed current report and preserves it on failure', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
  flow.check = async () => ({
    status: 200,
    data: sourceSummary(repositories[1], 'e'.repeat(64)),
  });
  flow.admission = async () => ({
    status: 202,
    data: {
      job: safeJob('queued', {
        operation: 'refresh',
      }),
    },
  });
  flow.job = async () => ({
    status: 200,
    data: {
      job: safeJob('failed', {
        operation: 'refresh',
        errorCode: 'analysis_output_invalid',
      }),
    },
  });
  await page.goto('/repositories/202');
  await expect(page.getByText('GitHub changes were detected')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh report' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'did not produce a valid report',
  );
  await expect(page.locator('#analysis-status-title')).toBeFocused();
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
  expect(
    flow.calls.find(({ path }) => path.endsWith('/report-jobs')).body,
  ).toEqual({
    idempotencyKey: expect.any(String),
    operation: 'refresh',
    expectedCurrentReportId: reportId,
  });
});

test('reloads authoritative board state after an admission conflict', async ({
  page,
}) => {
  const flow = await mockApi(page);
  let reportReads = 0;
  flow.report = async () => {
    reportReads += 1;
    return {
      status: 200,
      data: savedBoard(repositories[1], {
        activeJob:
          reportReads === 1
            ? null
            : safeJob('gathering', { operation: 'refresh' }),
      }),
    };
  };
  flow.admission = async () => ({
    status: 409,
    data: { error: { code: 'analysis_in_progress', retryable: true } },
  });
  flow.job = async () => ({
    status: 200,
    data: {
      job: safeJob('failed', {
        operation: 'refresh',
        errorCode: 'analysis_output_invalid',
      }),
    },
  });
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Refresh report' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'did not produce a valid report',
  );
  expect(reportReads).toBe(2);
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toHaveLength(1);
});

test('requires GitHub reconnection after admission loses source authorization', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
  flow.admission = async () => ({
    status: 403,
    data: {
      error: { code: 'source_authorization_required', retryable: false },
    },
  });
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Refresh report' }).click();
  await expect(
    page.getByRole('link', { name: 'Reconnect GitHub' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Refresh report' }),
  ).toBeDisabled();
});

test('keeps stale report actions disabled during authoritative reload', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const reloadPending = deferred();
  const reloadStarted = deferred();
  let reportReads = 0;
  flow.report = async () => {
    reportReads += 1;
    if (reportReads === 1) return { status: 200, data: savedBoard() };
    reloadStarted.resolve();
    await reloadPending.promise;
    return { status: 200, data: savedBoard() };
  };
  flow.admission = async () => ({
    status: 202,
    data: {
      job: safeJob('queued', { operation: 'refresh' }),
    },
  });
  flow.job = async () => ({
    status: 200,
    data: {
      job: safeJob('succeeded', { operation: 'refresh' }),
    },
  });
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Refresh report' }).click();
  await reloadStarted.promise;
  await expect(
    page.getByRole('button', { name: 'Refresh report' }),
  ).toBeDisabled();
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toHaveLength(1);
  reloadPending.resolve();
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
});

test('resumes an active job and presents an ambiguous terminal state separately', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(
    202,
    savedBoard(repositories[1], {
      activeJob: safeJob('validating', { operation: 'refresh' }),
    }),
  );
  flow.job = async () => ({
    status: 200,
    data: {
      job: safeJob('ambiguous', {
        operation: 'refresh',
        errorCode: 'analysis_ambiguous',
      }),
    },
  });
  await page.goto('/repositories/202');
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
  expect(
    flow.calls.some(({ path }) => path === `/api/report-jobs/${jobId}`),
  ).toBe(true);
});

test('retries a transient polling failure and clears the stale error on progress', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(
    202,
    savedBoard(repositories[1], {
      activeJob: safeJob('gathering', { operation: 'refresh' }),
    }),
  );
  let polls = 0;
  flow.job = async () => {
    polls += 1;
    if (polls === 1)
      return {
        status: 503,
        data: { error: { code: 'service_unavailable', retryable: true } },
      };
    if (polls === 2)
      return {
        status: 200,
        data: {
          job: safeJob('analyzing', { operation: 'refresh' }),
        },
      };
    return {
      status: 200,
      data: {
        job: safeJob('failed', {
          operation: 'refresh',
          errorCode: 'analysis_output_invalid',
        }),
      },
    };
  };
  await page.goto('/repositories/202');
  await expect(page.getByText('Analyzing the backlog…')).toBeVisible();
  await expect(page.getByText('Board is unavailable')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText(
    'did not produce a valid report',
  );
  expect(polls).toBe(3);
});

test('renders the last failed analysis separately after a reload', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(
    202,
    savedBoard(repositories[1], {
      lastAnalysisAttempt: {
        jobId,
        operation: 'refresh',
        status: 'failed',
        completedAt: '2026-09-18T20:15:00.000Z',
        errorCode: 'analysis_output_invalid',
      },
    }),
  );
  await page.goto('/repositories/202');
  await expect(
    page.getByText(/The last refresh attempt completed/u),
  ).toContainText('The last refresh attempt completed');
  await expect(
    page.getByText(/The last refresh attempt completed/u),
  ).toContainText('did not produce a valid report');
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
});

test('restores analysis availability after a successful source check', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(
    202,
    savedBoard(repositories[1], {
      sourceCheck: {
        sequence: 2,
        startedAt: '2026-09-18T20:12:00.000Z',
        completedAt: '2026-09-18T20:12:01.000Z',
        status: 'source-unavailable',
        summary: null,
        errorCode: 'source_unavailable',
      },
      spendMode: {
        available: false,
        mode: 'disabled',
        reason: 'source_unavailable',
      },
    }),
  );
  await page.goto('/repositories/202');
  await expect(page.getByText('matches the latest complete')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Refresh report' }),
  ).toBeEnabled();
  expect(
    flow.calls.some(
      ({ method, path }) =>
        method === 'GET' && path === '/api/analysis-availability',
    ),
  ).toBe(true);
});

test('restores refresh when a historical repository becomes eligible again', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.sourceAuthorization = 'installation-required';
  flow.repositories = [repositories[0]];
  const historical = savedBoard(repositories[1], {
    sourceCheck: {
      sequence: 2,
      startedAt: '2026-09-18T20:12:00.000Z',
      completedAt: '2026-09-18T20:12:01.000Z',
      status: 'source-unavailable',
      summary: null,
      errorCode: 'source_unavailable',
    },
    spendMode: {
      available: false,
      mode: 'disabled',
      reason: 'source_unavailable',
    },
  });
  flow.boards.set(202, historical);
  flow.catalog = {
    items: [
      {
        repository: repositories[1],
        current: historical.current,
        sourceStatus: 'source-unavailable',
        activeJob: null,
      },
    ],
    nextCursor: null,
  };
  flow.check = async () => ({
    status: 200,
    data: sourceSummary(repositories[1]),
  });

  await page.goto('/repositories/202');
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
  await expect(
    page.getByRole('button', { name: 'Refresh report' }),
  ).toBeEnabled();
  await expect(page.getByText('matches the latest complete')).toBeVisible();
});

test('keeps an unavailable historical report readable and disables paid analysis', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.repositories = [repositories[0]];
  const historical = savedBoard(repositories[1], {
    sourceCheck: {
      sequence: 2,
      startedAt: '2026-09-18T20:12:00.000Z',
      completedAt: '2026-09-18T20:12:01.000Z',
      status: 'source-unavailable',
      summary: null,
      errorCode: 'source_unavailable',
    },
    spendMode: {
      available: false,
      mode: 'disabled',
      reason: 'source_unavailable',
    },
  });
  flow.boards.set(202, historical);
  flow.catalog = {
    items: [
      {
        repository: repositories[1],
        current: historical.current,
        sourceStatus: 'source-unavailable',
        activeJob: null,
      },
    ],
    nextCursor: null,
  };
  flow.check = async () => ({
    status: 404,
    data: { error: { code: 'source_unavailable', retryable: false } },
  });
  await page.goto('/repositories/202');
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
  await expect(page.getByText('saved report is historical')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Refresh report' }),
  ).toBeDisabled();
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
});

test('reuses an admission UUID after an uncertain response', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(202, emptyBoard());
  let attempts = 0;
  flow.admission = async () => {
    attempts += 1;
    return attempts === 1
      ? { status: 202, data: {} }
      : { status: 202, data: { job: safeJob('queued') } };
  };
  flow.job = async () => ({
    status: 200,
    data: {
      job: safeJob('failed', { errorCode: 'budget_exhausted' }),
    },
  });
  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Generate report' }).click();
  await expect(
    page.getByRole('button', { name: 'Retry generate report' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry generate report' }).click();
  await expect(page.getByRole('alert')).toContainText('spending limit');
  const admissions = flow.calls.filter(({ path }) =>
    path.endsWith('/report-jobs'),
  );
  expect(admissions).toHaveLength(2);
  expect(admissions[0].body.idempotencyKey).toBe(
    admissions[1].body.idempotencyKey,
  );
});

test('bounds and restarts catalog pagination once after membership changes', async ({
  page,
}) => {
  const flow = await mockApi(page);
  let calls = 0;
  flow.reports = async (cursor) => {
    calls += 1;
    if (calls === 1)
      return {
        status: 409,
        data: {
          error: { code: 'report_catalog_changed', retryable: true },
        },
      };
    expect(cursor).toBeNull();
    return { status: 200, data: { items: [], nextCursor: null } };
  };
  await page.goto('/');
  await expect(page.getByLabel('Repository')).toBeVisible();
  expect(calls).toBe(2);
});

test('accepts exactly twenty catalog pages in one pass', async ({ page }) => {
  const flow = await mockApi(page);
  const cursors = [];
  flow.reports = async (cursor) => {
    cursors.push(cursor);
    return {
      status: 200,
      data: {
        items: [],
        nextCursor: cursors.length === 20 ? null : `catalog-${cursors.length}`,
      },
    };
  };

  await page.goto('/');
  await expect(page.getByLabel('Repository')).toBeVisible();
  expect(cursors).toHaveLength(20);
  expect(cursors[0]).toBeNull();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('stops after twenty pages in both catalog passes', async ({ page }) => {
  const flow = await mockApi(page);
  const cursors = [];
  flow.reports = async (cursor) => {
    cursors.push(cursor);
    return {
      status: 200,
      data: { items: [], nextCursor: `catalog-${cursors.length}` },
    };
  };

  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText(
    'saved report list changed while loading',
  );
  expect(cursors).toHaveLength(40);
  expect(cursors[0]).toBeNull();
  expect(cursors[20]).toBeNull();
});

test('cancels old polling when navigating to another repository', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(
    202,
    savedBoard(repositories[1], {
      activeJob: safeJob('analyzing', { operation: 'refresh' }),
    }),
  );
  flow.boards.set(101, emptyBoard(repositories[0]));
  let finishPoll;
  flow.job = async () =>
    new Promise((resolve) => {
      finishPoll = resolve;
    });
  await page.goto('/repositories/202');
  await expect(page.locator('#saved-report')).toBeVisible();
  await page.getByLabel('Repository').selectOption('101');
  await expect(page).toHaveURL('/repositories/101');
  await expect(
    page.getByRole('heading', { name: 'No saved report yet' }),
  ).toBeVisible();
  finishPoll?.({
    status: 200,
    data: {
      job: safeJob('failed', {
        operation: 'refresh',
        errorCode: 'analysis_output_invalid',
      }),
    },
  });
  await expect(page.getByText('did not produce a valid report')).toHaveCount(0);
  await expect(page.locator('#saved-report')).toHaveCount(0);
});

test('rejects unexpected report fields before untrusted content reaches the renderer', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const malformed = savedBoard();
  malformed.report.rawIssueBodies = 'private-source-sentinel';
  flow.boards.set(202, malformed);
  await page.goto('/repositories/202');
  await expect(page.getByRole('alert')).toContainText('incomplete response');
  await expect(page.locator('#saved-report')).toHaveCount(0);
  await expect(page.getByText('private-source-sentinel')).toHaveCount(0);
});

test('requires the exact persisted analysis output limit', async ({ page }) => {
  const flow = await mockApi(page);
  flow.boards.set(202, savedBoard());
  await page.goto('/repositories/202');
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );

  for (const mutate of [
    (limits) => delete limits.outputTokens,
    (limits) => {
      limits.outputTokens = 16_383;
    },
    (limits) => {
      limits.privateMarker = 'must-not-cross';
    },
  ]) {
    const malformed = savedBoard();
    mutate(malformed.source.provenance.analysisSelection.limits);
    flow.boards.set(202, malformed);
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('incomplete response');
    await expect(page.locator('#saved-report')).toHaveCount(0);
  }
});

test('rejects contradictory persisted source and analysis attempt states', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const malformedSource = savedBoard();
  malformedSource.sourceCheck = {
    sequence: 1,
    startedAt: '2026-09-18T20:12:00.000Z',
    completedAt: '2026-09-18T20:12:01.000Z',
    status: 'checking',
    summary: null,
    errorCode: null,
  };
  flow.boards.set(202, malformedSource);
  await page.goto('/repositories/202');
  await expect(page.getByRole('alert')).toContainText('incomplete response');
  await expect(page.locator('#saved-report')).toHaveCount(0);

  const malformedAttempt = savedBoard();
  malformedAttempt.lastAnalysisAttempt = {
    jobId,
    operation: 'refresh',
    status: 'succeeded',
    completedAt: '2026-09-18T20:15:00.000Z',
    errorCode: 'analysis_output_invalid',
  };
  flow.boards.set(202, malformedAttempt);
  await page.goto('/repositories/202');
  await expect(page.getByRole('alert')).toContainText('incomplete response');
  await expect(page.locator('#saved-report')).toHaveCount(0);
});

test('renders a valid report when optional prior-state metadata is absent', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const board = savedBoard();
  delete board.previous;
  delete board.comparison;
  delete board.sourceCheck;
  delete board.lastAnalysisAttempt;
  flow.boards.set(202, board);
  await page.goto('/repositories/202');
  await expect(page.locator('#saved-report')).toContainText(
    'Define the report boundary',
  );
  await expect(
    page.getByRole('heading', { name: 'Saved report comparison' }),
  ).toHaveCount(0);
});
