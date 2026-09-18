import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { fixtures } from '../../src/fixtures/reports.js';

function section(page, heading) {
  return page.getByRole('region', { name: heading, exact: true });
}

function reportFooter(page) {
  return page.locator('footer').filter({ hasText: /Synced/ });
}

async function expectCounts(page, counts) {
  for (const [label, value] of Object.entries(counts)) {
    const term = page
      .locator('dt')
      .filter({ hasText: new RegExp(`^${label}$`) });
    await expect(term).toHaveCount(1);
    await expect(term.locator('xpath=following-sibling::dd[1]')).toHaveText(
      String(value),
    );
  }
}

test('shows the complete report, canonical titles, and independent work', async ({
  page,
}) => {
  await page.goto('/demo');

  await expect(
    page.getByRole('heading', { level: 1, name: 'example/widgets' }),
  ).toBeVisible();
  await expect(
    page.getByText('widgets backlog', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Sample scenario')).toHaveValue('complete');
  await expectCounts(page, {
    Open: 14,
    Ready: 9,
    Blocked: 5,
    Lanes: 4,
    'Branches at once': 6,
    Picks: 2,
  });

  for (const heading of [
    'Start now',
    'Lanes',
    'Contention matrix',
    'Blocked',
  ]) {
    await expect(
      page.getByRole('heading', { name: heading, exact: true }),
    ).toBeVisible();
  }

  const lanes = section(page, 'Lanes');
  for (const title of [
    'parser: replace the tokenizer',
    'parser: retain source positions on the tokenizer branch',
    'parser: stream large inputs',
    'parser: describe schema migration examples',
    'api: define the public interface contract',
    'api: adapt the HTTP transport',
    'api: adapt the command-line transport',
    'api: publish the integration guide',
    'release: pin the publishing workflow',
    'release: verify package provenance',
    'docs: document keyboard navigation for the sample report and its reference links',
    'fixtures: add transport compatibility examples',
    'ci: cache dependency downloads',
    'tests: extend the browser compatibility matrix',
  ]) {
    await expect(lanes.getByText(title, { exact: true })).toBeVisible();
  }

  const picks = section(page, 'Start now');
  await expect(picks.getByText('parser: replace the tokenizer')).toBeVisible();
  await expect(
    picks.getByText('api: define the public interface contract'),
  ).toBeVisible();
  await expect(
    picks.getByText('fixtures: add transport compatibility examples', {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    picks.getByText(
      /Recommend two new branches even though six branches can run at once/,
    ),
  ).toBeVisible();
  await expect(
    lanes.getByText(/already overlap on the publishing workflow/),
  ).toBeVisible();
  await expect(
    lanes.getByText(
      /#102 accompanies #101 but keeps its own PR blocker visible/,
    ),
  ).toBeVisible();
  await expect(
    lanes.getByText(
      /It frees #111 and #112; #113 still needs integration approval/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText('No milestone', { exact: true }).first(),
  ).toBeVisible();
});

test('links every reference form to its source without fetching the source', async ({
  page,
}) => {
  await page.goto('/demo?scenario=complete');

  const blocked = section(page, 'Blocked');
  await expect(
    blocked.getByRole('link', { name: 'PR #390', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/example/widgets/pull/390');
  await expect(
    blocked.getByRole('link', {
      name: 'feature/132-cache-layout',
      exact: true,
    }),
  ).toHaveAttribute(
    'href',
    'https://github.com/example/widgets/compare/main...feature/132-cache-layout',
  );
  await expect(
    blocked.getByRole('link', { name: 'Integration approval', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/example/approvals/issues/8');

  const lanes = section(page, 'Lanes');
  await expect(
    lanes.getByRole('link', { name: 'example/schemas#17', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/example/schemas/issues/17');
  await expect(
    lanes.getByRole('link', { name: 'PR #392', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/example/widgets/pull/392');
  await expect(
    lanes.getByRole('link', { name: 'In progress on PR #391', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/example/widgets/pull/391');
  await expect(
    lanes.getByRole('link', {
      name: 'In progress on feature/121-provenance',
      exact: true,
    }),
  ).toHaveAttribute(
    'href',
    'https://github.com/example/widgets/compare/main...feature/121-provenance',
  );
  await expect(
    reportFooter(page).getByRole('link', { name: /^0123456/ }),
  ).toHaveAttribute(
    'href',
    'https://github.com/example/widgets/commit/0123456789abcdef0123456789abcdef01234567',
  );
  await expect(reportFooter(page)).toContainText(
    /GitHub.*authoritative|source.*authoritative|GitHub.*source of truth/i,
  );
});

test('switches scenarios and keeps a meaningful empty backlog on reload', async ({
  page,
}) => {
  await page.goto('/demo?scenario=complete');
  await page.getByLabel('Sample scenario').selectOption({
    label: 'Empty sample backlog',
  });

  await expect(page).toHaveURL(/\/demo\?scenario=empty$/);
  await expectCounts(page, {
    Open: 0,
    Ready: 0,
    Blocked: 0,
    Lanes: 0,
    'Branches at once': 0,
    Picks: 0,
  });
  await expect(
    section(page, 'Start now').getByText(
      'No open issues, so there are no branches to start.',
    ),
  ).toBeVisible();
  await expect(
    section(page, 'Blocked').getByText('Nothing is blocked.'),
  ).toBeVisible();
  await expect(
    section(page, 'Contention matrix').getByText(
      'No components are claimed by multiple open issues.',
    ),
  ).toBeVisible();
  await expect(reportFooter(page)).toContainText(
    /no (open issue has a )?milestones?|no issues have milestones|none in a milestone/i,
  );
  await expect(
    page.getByText('parser: replace the tokenizer', { exact: true }),
  ).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel('Sample scenario')).toHaveValue('empty');
  await expect(
    section(page, 'Blocked').getByText('Nothing is blocked.'),
  ).toBeVisible();
});

test('preserves uncertainty and renders HTML-like strings as literal text', async ({
  page,
}) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.goto('/demo?scenario=uncertain');

  await expectCounts(page, {
    Open: 3,
    Ready: 3,
    Blocked: 0,
    Lanes: 2,
    'Branches at once': 0,
    Picks: 0,
  });
  const lanes = section(page, 'Lanes');
  await expect(
    lanes.getByText(
      '<img src=x onerror="alert(\'sample\')"> clarify renderer scope',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    lanes.getByText(/<b>untrusted text<\/b> stays literal/),
  ).toBeVisible();
  await expect(
    page.getByText(/<script>alert\("sample"\)<\/script>/),
  ).toBeVisible();
  await expect(
    lanes.getByText(/No verified dependency state is asserted/),
  ).toBeVisible();
  await expect(
    lanes.getByText('schema: update the independent adapter examples', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    lanes.getByRole('link', { name: 'PR #490', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/example/widgets/pull/490');
  await expect(
    section(page, 'Start now').getByText(
      /No starts are recommended: clarify #201 and verify/,
    ),
  ).toBeVisible();
  await expect(page.locator('img[src="x"], [onerror]')).toHaveCount(0);
  await expect(page.locator('script:not([src])')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('rejects an unverified title before displaying report content or scheduling an age timer', async ({
  page,
}) => {
  await page.goto('/demo?scenario=empty');
  const report = structuredClone(fixtures.complete.report);
  report.issues[0].title = 'Unverified replacement title';
  const outcome = await page.evaluate(
    async ({ report, inventory }) => {
      const { renderReport } = await import('/__test__/report/render.js');
      const mount = document.createElement('div');
      mount.id = 'malformed-report-result';
      document.querySelector('main').append(mount);
      const originalSetInterval = window.setInterval;
      let scheduledIntervals = 0;
      window.setInterval = (...arguments_) => {
        scheduledIntervals += 1;
        return originalSetInterval(...arguments_);
      };
      try {
        const dispose = renderReport(mount, report, inventory);
        dispose();
        return { scheduledIntervals };
      } finally {
        window.setInterval = originalSetInterval;
      }
    },
    { report, inventory: fixtures.complete.inventory },
  );

  const result = page.locator('#malformed-report-result');
  await expect(result.getByRole('alert')).toBeVisible();
  await expect(
    result.getByRole('heading', { name: 'Report unavailable' }),
  ).toBeVisible();
  await expect(result).toContainText(/issues(?:\[0\]|\.0)\.title/);
  await expect(
    result.getByText('Unverified replacement title', { exact: true }),
  ).toHaveCount(0);
  await expect(
    result.getByText('parser: stream large inputs', { exact: true }),
  ).toHaveCount(0);
  await expect(result.locator('a, table, dl')).toHaveCount(0);
  expect(outcome.scheduledIntervals).toBe(0);
});

test('disposes a mounted report age timer once when its report is replaced', async ({
  page,
}) => {
  await page.goto('/demo?scenario=empty');
  const outcome = await page.evaluate(async ({ report, inventory }) => {
    const { renderReport } = await import('/__test__/report/render.js');
    const mount = document.createElement('div');
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const activeIntervals = new Set();
    let scheduledIntervals = 0;
    let clearedIntervals = 0;
    window.setInterval = (...arguments_) => {
      const id = originalSetInterval(...arguments_);
      scheduledIntervals += 1;
      activeIntervals.add(id);
      return id;
    };
    window.clearInterval = (id) => {
      clearedIntervals += 1;
      activeIntervals.delete(id);
      originalClearInterval(id);
    };
    try {
      const dispose = renderReport(mount, report, inventory);
      dispose();
      dispose();
      return {
        scheduledIntervals,
        clearedIntervals,
        activeIntervals: activeIntervals.size,
      };
    } finally {
      for (const id of activeIntervals) originalClearInterval(id);
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  }, fixtures.empty);

  expect(outcome).toEqual({
    scheduledIntervals: 1,
    clearedIntervals: 1,
    activeIntervals: 0,
  });
});

test('renders a valid report with a null optional time zone and disposes its age timer', async ({
  page,
}) => {
  await page.goto('/demo?scenario=empty');
  const report = structuredClone(fixtures.complete.report);
  const inventory = structuredClone(fixtures.complete.inventory);
  report.sync.timeZone = null;
  inventory.sync.timeZone = null;
  const outcome = await page.evaluate(
    async ({ report, inventory }) => {
      const { renderReport } = await import('/__test__/report/render.js');
      const mount = document.createElement('div');
      mount.id = 'null-time-zone-report';
      document.querySelector('main').append(mount);
      const originalSetInterval = window.setInterval;
      const originalClearInterval = window.clearInterval;
      const activeIntervals = new Set();
      let scheduledIntervals = 0;
      let clearedIntervals = 0;
      window.setInterval = (...arguments_) => {
        const id = originalSetInterval(...arguments_);
        scheduledIntervals += 1;
        activeIntervals.add(id);
        return id;
      };
      window.clearInterval = (id) => {
        clearedIntervals += 1;
        activeIntervals.delete(id);
        originalClearInterval(id);
      };
      try {
        const dispose = renderReport(mount, report, inventory);
        dispose();
        dispose();
        return {
          scheduledIntervals,
          clearedIntervals,
          activeIntervals: activeIntervals.size,
        };
      } finally {
        for (const id of activeIntervals) originalClearInterval(id);
        window.setInterval = originalSetInterval;
        window.clearInterval = originalClearInterval;
      }
    },
    { report, inventory },
  );

  const result = page.locator('#null-time-zone-report');
  await expect(
    result.getByRole('heading', { level: 1, name: 'example/widgets' }),
  ).toBeVisible();
  for (const heading of [
    'Start now',
    'Lanes',
    'Contention matrix',
    'Blocked',
  ]) {
    await expect(section(result, heading)).toBeVisible();
  }
  await expect(result.getByRole('alert')).toHaveCount(0);
  await expect(result.locator('.when-age')).toContainText('Synced');
  expect(outcome).toEqual({
    scheduledIntervals: 1,
    clearedIntervals: 1,
    activeIntervals: 0,
  });
});

for (const scenario of ['complete', 'empty', 'uncertain']) {
  test(`${scenario} sample remains local and accessible in both themes`, async ({
    page,
  }) => {
    const externalRequests = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        url.protocol.startsWith('http') &&
        url.origin !== 'http://127.0.0.1:4173'
      ) {
        externalRequests.push(request.url());
      }
    });
    await page.route(/^https?:\/\/(?!127\.0\.0\.1:4173(?:\/|$))/, (route) =>
      route.abort(),
    );
    await page.goto(`/demo?scenario=${scenario}`);
    await expect(
      page.getByRole('heading', { name: 'example/widgets', level: 1 }),
    ).toBeVisible();

    for (const theme of ['light', 'dark']) {
      const target = page.getByRole('button', { name: `Use ${theme} theme` });
      if (await target.count()) {
        await target.focus();
        await page.keyboard.press('Enter');
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(accessibility.violations).toEqual([]);
    }

    await page.getByLabel('Sample scenario').selectOption('complete');
    await page.reload();
    await expect(page.getByLabel('Sample scenario')).toHaveValue('complete');
    expect(externalRequests).toEqual([]);
  });
}

for (const scenario of ['complete', 'uncertain']) {
  test(`${scenario} sample fits narrow viewports without page overflow`, async ({
    page,
  }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/demo?scenario=${scenario}`);
      await expect(
        page.getByRole('heading', { name: 'example/widgets', level: 1 }),
      ).toBeVisible();
      const pageWidth = await page.evaluate(() => ({
        available: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
      }));
      expect(pageWidth.content).toBeLessThanOrEqual(pageWidth.available);
      await expect(section(page, 'Blocked')).toBeVisible();
    }
  });
}

test('offers the sample from the welcome screen and handles an unknown route', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'View sample report' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Sample scenario')).toHaveValue('complete');

  await page.goto('/not-an-available-board');
  await expect(
    page.getByRole('heading', { name: /unavailable|not found|unknown page/i }),
  ).toBeVisible();
  await expect(page.getByLabel('Sample scenario')).not.toBeVisible();

  await page.goto('/demo?scenario=unavailable');
  await expect(page.getByRole('status')).toHaveText(
    'Sample scenario unavailable. Select one of the samples above.',
  );
  await expect(
    page.getByRole('region', { name: 'Start now', exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('Sample scenario').selectOption('complete');
  await expect(
    page.getByRole('heading', { name: 'example/widgets', level: 1 }),
  ).toBeVisible();
});
