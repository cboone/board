import { expect, test } from '@playwright/test';
import {
  analysisAvailability,
  deferred,
  emptyBoard,
  jobId,
  mockApi,
  repositories,
  reportId,
  safeJob,
  safePreflight,
  savedBoard,
  setupBudget,
  sourceSummary,
} from './mock-api.js';

function discussionAvailability(overrides = {}) {
  return analysisAvailability({
    spendMode: {
      available: false,
      mode: 'setup',
      reason: 'budget_discussion_required',
    },
    setupBudget: setupBudget({
      status: 'discussion-required',
      settledMicrousd: 8_000_000,
      reservedMicrousd: 2_000_000,
      unknownMicrousd: 500_000,
      discussion: {
        status: 'required',
        currentRevision: 1,
        triggerExposureMicrousd: 21_319_200,
      },
      ...overrides,
    }),
  });
}

function decidedAvailability(status) {
  const stopped = status === 'stopped';
  return analysisAvailability({
    spendMode: stopped
      ? { available: false, mode: 'disabled', reason: 'analysis_unavailable' }
      : { available: true, mode: 'setup', reason: null },
    setupBudget: setupBudget({
      status: stopped ? 'stopped' : 'available',
      settledMicrousd: 8_000_000,
      reservedMicrousd: 2_000_000,
      unknownMicrousd: 500_000,
      discussion: {
        status: stopped ? 'stopped' : 'acknowledged',
        currentRevision: 1,
        triggerExposureMicrousd: 21_319_200,
      },
    }),
  });
}

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
  await expect
    .poll(() =>
      flow.calls.some(
        ({ method, path }) =>
          method === 'POST' && path === '/api/repositories/202/check',
      ),
    )
    .toBe(true);
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

test('rechecks the source after a successful job races with the initial source check', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const firstCheckStarted = deferred();
  const releaseFirstCheck = deferred();
  let reportReads = 0;
  let sourceChecks = 0;
  flow.report = async () => {
    reportReads += 1;
    return {
      status: 200,
      data:
        reportReads === 1
          ? savedBoard(repositories[1], {
              activeJob: safeJob('analyzing', { operation: 'refresh' }),
            })
          : savedBoard(),
    };
  };
  flow.check = async () => {
    sourceChecks += 1;
    if (sourceChecks === 1) {
      firstCheckStarted.resolve();
      await releaseFirstCheck.promise;
    }
    return { status: 200, data: sourceSummary() };
  };
  flow.job = async () => {
    await firstCheckStarted.promise;
    return {
      status: 200,
      data: { job: safeJob('succeeded', { operation: 'refresh' }) },
    };
  };

  await page.goto('/repositories/202');
  await expect.poll(() => reportReads).toBe(2);
  expect(sourceChecks).toBe(1);

  releaseFirstCheck.resolve();
  await expect.poll(() => sourceChecks).toBe(2);
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

test('requires the explicit no-spend setup verification before enabling paid analysis', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.boards.set(202, emptyBoard());
  flow.availability = async () => ({
    status: 200,
    data: analysisAvailability({
      analysisReadiness: {
        ready: false,
        reason: 'analysis_preflight_required',
      },
    }),
  });
  flow.preflight = async () => ({
    status: 200,
    data: { preflight: safePreflight() },
  });

  await page.goto('/repositories/202');
  await expect(
    page.getByRole('button', { name: 'Verify analysis setup' }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Generate report' }),
  ).toBeDisabled();
  await expect(
    page.getByText('Analysis setup has not been verified'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Verify analysis setup' }).click();
  await expect(
    page.getByText('Verified claude-opus-5 with 1,234 input tokens'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Generate report' }),
  ).toBeEnabled();
  const call = flow.calls.find(({ path }) =>
    path.endsWith('/analysis-preflight'),
  );
  expect(call.csrfToken).toBe(flow.csrfToken);
  expect(call.body).toEqual({
    operation: 'generate',
    expectedCurrentReportId: null,
  });
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
});

test('serializes source checks behind a pending setup verification', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const pending = deferred();
  flow.boards.set(202, emptyBoard());
  flow.availability = async () => ({
    status: 200,
    data: analysisAvailability({
      analysisReadiness: {
        ready: false,
        reason: 'analysis_preflight_required',
      },
    }),
  });
  flow.preflight = async () => {
    await pending.promise;
    return {
      status: 200,
      data: { preflight: safePreflight() },
    };
  };

  await page.goto('/repositories/202');
  const verify = page.getByRole('button', { name: 'Verify analysis setup' });
  await expect(verify).toBeEnabled();
  const checksBefore = flow.calls.filter(({ path }) =>
    path.endsWith('/check'),
  ).length;
  await verify.click();
  await expect(
    page.getByRole('button', { name: 'Verifying analysis setup…' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Check GitHub' }),
  ).toBeDisabled();

  pending.resolve();
  await expect(
    page.getByRole('button', { name: 'Generate report' }),
  ).toBeEnabled();
  expect(flow.calls.filter(({ path }) => path.endsWith('/check'))).toHaveLength(
    checksBefore,
  );
});

test('serializes setup decisions behind the source-check budget refresh', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const availabilityStarted = deferred();
  const availabilityPending = deferred();
  let availabilityReads = 0;
  flow.boards.set(202, emptyBoard());
  flow.availability = async () => {
    availabilityReads += 1;
    if (availabilityReads === 1)
      return { status: 200, data: discussionAvailability() };
    availabilityStarted.resolve();
    await availabilityPending.promise;
    return { status: 200, data: discussionAvailability() };
  };

  await page.goto('/repositories/202');
  await availabilityStarted.promise;
  const decide = page.getByRole('button', {
    name: 'Continue setup through $25',
  });
  await expect(decide).toBeDisabled();
  await expect(page.getByLabel('Repository')).toBeDisabled();
  await expect(
    page.getByRole('link', { name: repositories[0].fullName }),
  ).toHaveAttribute('aria-disabled', 'true');
  await decide.evaluate((button) => {
    button.disabled = false;
    button.click();
  });
  expect(
    flow.calls.filter(({ path }) => path === '/api/setup-budget-decision'),
  ).toEqual([]);

  availabilityPending.resolve();
  await expect(decide).toBeEnabled();
  await decide.click();
  await expect(
    page.getByText('setup budget decision was recorded', { exact: false }),
  ).toBeVisible();
  expect(
    flow.calls.filter(({ path }) => path === '/api/setup-budget-decision'),
  ).toHaveLength(1);
});

test('shows measured setup spending and records continuation without starting analysis', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.availability = async () => ({
    status: 200,
    data: discussionAvailability(),
  });
  flow.decision = async () => ({
    status: 200,
    data: { status: 'updated', ...decidedAvailability('acknowledged') },
  });

  await page.goto('/');
  const section = page
    .getByRole('heading', { name: 'Setup analysis spending' })
    .locator('..');
  await expect(section).toContainText('Measured setup exposure is $10.50');
  await expect(section).toContainText('$8.00 settled');
  await expect(section).toContainText('$2.00 reserved');
  await expect(section).toContainText('$0.50 unresolved exposure');
  await expect(section).toContainText('$14.50 remains under the cap');
  await expect(section).toContainText(
    'projected worst-case exposure that triggered review is $21.3192',
  );
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);

  await page
    .getByRole('button', { name: 'Continue setup through $25' })
    .click();
  await expect(
    page.getByText('setup budget decision was recorded', { exact: false }),
  ).toBeVisible();
  const decisions = flow.calls.filter(
    ({ path }) => path === '/api/setup-budget-decision',
  );
  expect(decisions).toHaveLength(1);
  expect(decisions[0].csrfToken).toBe(flow.csrfToken);
  expect(decisions[0].body).toEqual({
    policyId: 'setup-policy-v1',
    discussionRevision: 1,
    decisionId: expect.stringMatching(/^[a-f0-9]{64}$/u),
    decision: 'acknowledge',
    authorizedThroughMicrousd: 25_000_000,
    authorizedOperations: ['generate', 'refresh'],
    observed: {
      settledMicrousd: 8_000_000,
      reservedMicrousd: 2_000_000,
      unknownMicrousd: 500_000,
    },
  });
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
});

test('clears a resolved admission budget gate after the setup decision', async ({
  page,
}) => {
  const flow = await mockApi(page);
  let admissionBlocked = false;
  flow.boards.set(202, emptyBoard());
  flow.availability = async () => ({
    status: 200,
    data: admissionBlocked ? discussionAvailability() : analysisAvailability(),
  });
  flow.admission = async () => {
    admissionBlocked = true;
    return {
      status: 409,
      data: {
        error: { code: 'budget_discussion_required', retryable: false },
      },
    };
  };
  flow.decision = async () => ({
    status: 200,
    data: { status: 'updated', ...decidedAvailability('acknowledged') },
  });

  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Generate report' }).click();
  const resolvedError = page.getByRole('alert').filter({
    hasText:
      'The setup spending threshold requires a decision before continuing.',
  });
  await expect(resolvedError).toBeVisible();
  await page
    .getByRole('button', { name: 'Continue setup through $25' })
    .click();
  await expect(
    page.getByText('setup budget decision was recorded', { exact: false }),
  ).toBeVisible();
  await expect(resolvedError).toHaveCount(0);
});

test('reload clears a resolved gate after a committed decision response is lost', async ({
  page,
}) => {
  const flow = await mockApi(page);
  let admissionBlocked = false;
  let decisionCommitted = false;
  flow.boards.set(202, emptyBoard());
  flow.availability = async () => ({
    status: 200,
    data: decisionCommitted
      ? decidedAvailability('acknowledged')
      : admissionBlocked
        ? discussionAvailability()
        : analysisAvailability(),
  });
  flow.admission = async () => {
    admissionBlocked = true;
    return {
      status: 409,
      data: {
        error: { code: 'budget_discussion_required', retryable: false },
      },
    };
  };
  flow.decision = async () => {
    decisionCommitted = true;
    return {
      status: 503,
      data: { error: { code: 'service_unavailable', retryable: true } },
    };
  };

  await page.goto('/repositories/202');
  await page.getByRole('button', { name: 'Generate report' }).click();
  const resolvedError = page.getByRole('alert').filter({
    hasText:
      'The setup spending threshold requires a decision before continuing.',
  });
  await expect(resolvedError).toBeVisible();
  await page
    .getByRole('button', { name: 'Continue setup through $25' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Retry setup budget decision' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reload setup spending' }).click();
  await expect(resolvedError).toHaveCount(0);
  await expect(
    page.getByText('Setup spending was reloaded. No analysis was started.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry setup budget decision' }),
  ).toHaveCount(0);
});

test('shows an authorization-scope discussion below the review threshold', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.availability = async () => ({
    status: 200,
    data: discussionAvailability({
      settledMicrousd: 1,
      reservedMicrousd: 0,
      unknownMicrousd: 0,
      discussion: {
        status: 'required',
        currentRevision: 2,
        triggerExposureMicrousd: 10_819_201,
      },
    }),
  });

  await page.goto('/');
  const section = page
    .getByRole('heading', { name: 'Setup analysis spending' })
    .locator('..');
  await expect(section).toContainText('Measured setup exposure is $0.000001');
  await expect(section).toContainText('The review threshold is $20.00');
  await expect(section).toContainText(
    'projected worst-case exposure that triggered review is $10.819201',
  );
  await expect(
    page.getByRole('button', { name: 'Continue setup through $25' }),
  ).toBeEnabled();
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
});

test('keeps repository reload and navigation inactive during a setup decision', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const pending = deferred();
  flow.list = async () => ({
    status: 503,
    data: { error: { code: 'service_unavailable', retryable: true } },
  });
  flow.catalog = {
    items: [
      {
        repository: repositories[0],
        current: {
          reportId,
          generatedAt: '2026-09-18T20:10:00.000Z',
          sourceFingerprint: 'c'.repeat(64),
        },
        sourceStatus: 'ready',
        activeJob: null,
      },
    ],
    nextCursor: null,
  };
  flow.availability = async () => ({
    status: 200,
    data: discussionAvailability(),
  });
  flow.decision = async () => {
    await pending.promise;
    return {
      status: 200,
      data: { status: 'updated', ...decidedAvailability('acknowledged') },
    };
  };

  await page.goto('/');
  const reload = page.getByRole('button', { name: 'Reload repository lists' });
  await page
    .getByRole('button', { name: 'Continue setup through $25' })
    .click();
  await expect(reload).toBeDisabled();
  await expect(page.getByLabel('Repository')).toBeDisabled();
  await expect(
    page.getByRole('link', { name: repositories[0].fullName }),
  ).toHaveAttribute('aria-disabled', 'true');
  const reportReads = flow.calls.filter(({ path }) =>
    path.endsWith('/report'),
  ).length;
  await page.getByLabel('Repository').evaluate((select) => {
    select.disabled = false;
    select.value = '101';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page).toHaveURL(/\/$/u);
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report')),
  ).toHaveLength(reportReads);
  const listReads = flow.calls.filter(
    ({ path }) => path === '/api/repositories',
  ).length;
  await reload.evaluate((button) => {
    button.disabled = false;
    button.click();
  });
  expect(
    flow.calls.filter(({ path }) => path === '/api/repositories'),
  ).toHaveLength(listReads);

  pending.resolve();
  await expect(
    page.getByText('setup budget decision was recorded', { exact: false }),
  ).toBeVisible();
  await expect(reload).toBeEnabled();
  await expect(page.getByLabel('Repository')).toBeEnabled();
});

test('requires inline confirmation before stopping paid setup', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.availability = async () => ({
    status: 200,
    data: discussionAvailability(),
  });
  flow.decision = async () => ({
    status: 200,
    data: { status: 'updated', ...decidedAvailability('stopped') },
  });

  await page.goto('/');
  await page
    .getByRole('button', { name: 'Stop paid setup for this policy' })
    .click();
  await expect(
    page.getByText('Confirm that paid setup should stop', { exact: false }),
  ).toBeVisible();
  expect(
    flow.calls.filter(({ path }) => path === '/api/setup-budget-decision'),
  ).toEqual([]);
  await page.getByRole('button', { name: 'Confirm stop paid setup' }).click();
  await expect(
    page.getByText('Paid setup is stopped for this policy.'),
  ).toBeVisible();

  const decision = flow.calls.find(
    ({ path }) => path === '/api/setup-budget-decision',
  );
  expect(decision.body).toEqual({
    policyId: 'setup-policy-v1',
    discussionRevision: 1,
    decisionId: expect.stringMatching(/^[a-f0-9]{64}$/u),
    decision: 'stop',
    authorizedThroughMicrousd: 0,
    authorizedOperations: [],
    observed: {
      settledMicrousd: 8_000_000,
      reservedMicrousd: 2_000_000,
      unknownMicrousd: 500_000,
    },
  });
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
});

test('clears stop confirmation when a newer budget projection arrives', async ({
  page,
}) => {
  const flow = await mockApi(page);
  let sourceChecks = 0;
  flow.boards.set(202, emptyBoard());
  flow.check = async () => {
    sourceChecks += 1;
    return { status: 200, data: sourceSummary() };
  };
  flow.availability = async () => ({
    status: 200,
    data: discussionAvailability({
      discussion: {
        status: 'required',
        currentRevision: sourceChecks > 1 ? 2 : 1,
        triggerExposureMicrousd: sourceChecks > 1 ? 22_000_000 : 21_319_200,
      },
    }),
  });

  await page.goto('/repositories/202');
  await page
    .getByRole('button', { name: 'Stop paid setup for this policy' })
    .click();
  const confirmation = page.getByText('Confirm that paid setup should stop', {
    exact: false,
  });
  await expect(confirmation).toBeVisible();
  await page.getByRole('button', { name: 'Check GitHub' }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Stop paid setup for this policy' }),
  ).toBeVisible();
  expect(sourceChecks).toBe(2);
});

test('reuses the exact setup decision after an uncertain service response', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.availability = async () => ({
    status: 200,
    data: discussionAvailability(),
  });
  let attempts = 0;
  flow.decision = async () => {
    attempts += 1;
    return attempts === 1
      ? {
          status: 503,
          data: { error: { code: 'service_unavailable', retryable: true } },
        }
      : {
          status: 200,
          data: { status: 'existing', ...decidedAvailability('acknowledged') },
        };
  };

  await page.goto('/');
  await page
    .getByRole('button', { name: 'Continue setup through $25' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Retry setup budget decision' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Retry setup budget decision' })
    .click();
  await expect(
    page.getByText('existing setup budget decision was confirmed', {
      exact: false,
    }),
  ).toBeVisible();
  const decisions = flow.calls.filter(
    ({ path }) => path === '/api/setup-budget-decision',
  );
  expect(decisions).toHaveLength(2);
  expect(decisions[1].body).toEqual(decisions[0].body);
  expect(decisions[0].body.decisionId).toMatch(/^[a-f0-9]{64}$/u);
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
});

test('defers a terminal-job budget refresh until an explicit reload completes', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const terminal = deferred();
  const pollStarted = deferred();
  const reloadStarted = deferred();
  const reloadResponse = deferred();
  let availabilityReads = 0;
  let reloadInFlight = false;
  let terminalCompleted = false;
  flow.boards.set(
    202,
    savedBoard(repositories[1], {
      activeJob: safeJob('analyzing', { operation: 'refresh' }),
    }),
  );
  flow.availability = async () => {
    availabilityReads += 1;
    if (reloadInFlight) {
      reloadStarted.resolve();
      await reloadResponse.promise;
      return { status: 200, data: discussionAvailability() };
    }
    return {
      status: 200,
      data: terminalCompleted
        ? analysisAvailability({
            setupBudget: setupBudget({
              status: 'available',
              settledMicrousd: 14_000_000,
              discussion: {
                status: 'acknowledged',
                currentRevision: 1,
                triggerExposureMicrousd: 21_319_200,
              },
            }),
          })
        : discussionAvailability(),
    };
  };
  flow.decision = async () => ({
    status: 503,
    data: { error: { code: 'service_unavailable', retryable: true } },
  });
  flow.job = async () => {
    pollStarted.resolve();
    await terminal.promise;
    terminalCompleted = true;
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
  await pollStarted.promise;
  await page
    .getByRole('button', { name: 'Continue setup through $25' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Reload setup spending' }),
  ).toBeVisible();
  const readsBeforeReload = availabilityReads;
  reloadInFlight = true;
  await page.getByRole('button', { name: 'Reload setup spending' }).click();
  await reloadStarted.promise;
  terminal.resolve();
  await expect(page.getByRole('alert')).toContainText(
    'did not produce a valid report',
  );
  expect(availabilityReads).toBe(readsBeforeReload + 1);

  reloadInFlight = false;
  reloadResponse.resolve();
  await expect.poll(() => availabilityReads).toBe(readsBeforeReload + 2);
  await expect(
    page
      .getByRole('heading', { name: 'Setup analysis spending' })
      .locator('..'),
  ).toContainText('Measured setup exposure is $14.00');
});

test('defers a terminal-job budget refresh until a setup decision completes', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const terminal = deferred();
  const pollStarted = deferred();
  const decision = deferred();
  let availabilityReads = 0;
  let terminalCompleted = false;
  flow.boards.set(
    202,
    savedBoard(repositories[1], {
      activeJob: safeJob('analyzing', { operation: 'refresh' }),
    }),
  );
  flow.availability = async () => {
    availabilityReads += 1;
    return {
      status: 200,
      data: terminalCompleted
        ? analysisAvailability({
            setupBudget: setupBudget({
              status: 'available',
              settledMicrousd: 12_000_000,
              discussion: {
                status: 'acknowledged',
                currentRevision: 1,
                triggerExposureMicrousd: 21_319_200,
              },
            }),
          })
        : discussionAvailability(),
    };
  };
  flow.job = async () => {
    pollStarted.resolve();
    await terminal.promise;
    terminalCompleted = true;
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
  flow.decision = async () => {
    await decision.promise;
    return {
      status: 200,
      data: { status: 'updated', ...decidedAvailability('acknowledged') },
    };
  };

  await page.goto('/repositories/202');
  await pollStarted.promise;
  const continueSetup = page.getByRole('button', {
    name: 'Continue setup through $25',
  });
  await expect(continueSetup).toBeEnabled();
  await continueSetup.click();
  const readsBeforeTerminal = availabilityReads;
  terminal.resolve();
  await expect(page.getByRole('alert')).toContainText(
    'did not produce a valid report',
  );
  expect(availabilityReads).toBe(readsBeforeTerminal);

  decision.resolve();
  await expect(
    page.getByText('setup budget decision was recorded', { exact: false }),
  ).toBeVisible();
  await expect.poll(() => availabilityReads).toBe(readsBeforeTerminal + 1);
  await expect(
    page
      .getByRole('heading', { name: 'Setup analysis spending' })
      .locator('..'),
  ).toContainText('Measured setup exposure is $12.00');
  await expect(continueSetup).toHaveCount(0);
});

test('refreshes setup spending after a successful job races with a decision', async ({
  page,
}) => {
  const flow = await mockApi(page);
  const terminal = deferred();
  const pollStarted = deferred();
  const boardReloaded = deferred();
  const decision = deferred();
  let availabilityReads = 0;
  let terminalCompleted = false;
  let reportReads = 0;
  let sourceChecks = 0;
  flow.boards.set(
    202,
    savedBoard(repositories[1], {
      activeJob: safeJob('analyzing', { operation: 'refresh' }),
    }),
  );
  flow.report = async () => {
    reportReads += 1;
    if (reportReads > 1) boardReloaded.resolve();
    return { status: 200, data: flow.boards.get(202) };
  };
  flow.availability = async () => {
    availabilityReads += 1;
    return {
      status: 200,
      data: terminalCompleted
        ? analysisAvailability({
            setupBudget: setupBudget({
              status: 'available',
              settledMicrousd: 13_000_000,
              discussion: {
                status: 'acknowledged',
                currentRevision: 1,
                triggerExposureMicrousd: 21_319_200,
              },
            }),
          })
        : discussionAvailability(),
    };
  };
  flow.check = async () => {
    sourceChecks += 1;
    return { status: 200, data: sourceSummary() };
  };
  flow.job = async () => {
    pollStarted.resolve();
    await terminal.promise;
    terminalCompleted = true;
    flow.boards.set(202, savedBoard());
    return {
      status: 200,
      data: { job: safeJob('succeeded', { operation: 'refresh' }) },
    };
  };
  flow.decision = async () => {
    await decision.promise;
    return {
      status: 200,
      data: { status: 'updated', ...decidedAvailability('acknowledged') },
    };
  };

  await page.goto('/repositories/202');
  await pollStarted.promise;
  const continueSetup = page.getByRole('button', {
    name: 'Continue setup through $25',
  });
  await expect(continueSetup).toBeEnabled();
  await continueSetup.click();
  const readsBeforeTerminal = availabilityReads;
  const checksBeforeTerminal = sourceChecks;
  terminal.resolve();
  await boardReloaded.promise;
  expect(availabilityReads).toBe(readsBeforeTerminal);
  expect(sourceChecks).toBe(checksBeforeTerminal);

  decision.resolve();
  await expect.poll(() => availabilityReads).toBe(readsBeforeTerminal + 2);
  await expect.poll(() => sourceChecks).toBe(checksBeforeTerminal + 1);
  await expect(
    page
      .getByRole('heading', { name: 'Setup analysis spending' })
      .locator('..'),
  ).toContainText('Measured setup exposure is $13.00');
  await expect(continueSetup).toHaveCount(0);
});

test('replaces setup spending with the conflict projection for fresh review', async ({
  page,
}) => {
  const flow = await mockApi(page);
  flow.availability = async () => ({
    status: 200,
    data: discussionAvailability(),
  });
  const changed = discussionAvailability({
    settledMicrousd: 9_000_000,
    reservedMicrousd: 1_500_000,
    unknownMicrousd: 500_000,
    discussion: {
      status: 'required',
      currentRevision: 2,
      triggerExposureMicrousd: 22_000_000,
    },
  });
  flow.decision = async () => ({
    status: 200,
    data: { status: 'conflict', ...changed },
  });

  await page.goto('/');
  await page
    .getByRole('button', { name: 'Continue setup through $25' })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Review the current measured exposure before deciding again',
  );
  const section = page
    .getByRole('heading', { name: 'Setup analysis spending' })
    .locator('..');
  await expect(section).toContainText('Measured setup exposure is $11.00');
  await expect(section).toContainText('$9.00 settled');
  await expect(section).toContainText(
    'projected worst-case exposure that triggered review is $22.00',
  );
  expect(
    flow.calls.filter(({ path }) => path === '/api/setup-budget-decision'),
  ).toHaveLength(1);
  expect(
    flow.calls.filter(({ path }) => path.endsWith('/report-jobs')),
  ).toEqual([]);
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
      analysisReadiness: { ready: true, reason: null },
      setupBudget: setupBudget(),
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
