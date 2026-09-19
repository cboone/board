import { createInitialComparison } from '../../../src/domain/report-comparison.js';

export const repositories = [
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

export const reportId = '1'.repeat(64);
export const previousReportId = '2'.repeat(64);
export const jobId = '3'.repeat(64);
export const generatedAt = '2026-09-18T20:10:00.000Z';
export const sourceFingerprint = 'c'.repeat(64);

export function sourceSummary(
  repository = repositories[1],
  fingerprint = sourceFingerprint,
) {
  return {
    status: 'complete',
    repo: repository,
    sync: {
      at: generatedAt,
      timeZone: 'UTC',
      branch: 'main',
      commit: 'a'.repeat(40),
      openPullRequests: 0,
    },
    fingerprint: {
      algorithm: 'sha256',
      value: fingerprint,
      scope: 'core-and-collected-context',
    },
    provenance: {
      observedFrom: '2026-09-18T20:09:58.000Z',
      observedTo: generatedAt,
      consistency: 'two-pass-matched',
      inputs: [{ name: 'issues', status: 'complete' }],
      files: [{ path: 'README.md', blobId: 'b'.repeat(40) }],
      references: { verified: 1, unverified: 0 },
      limitations: ['Matching observations are not an atomic GitHub snapshot.'],
    },
    counts: {
      openIssues: 1,
      openPullRequests: 0,
      milestones: 0,
      labels: 1,
      branches: 1,
      unmergedBranches: 0,
      issueComments: 0,
      treeEntries: 5,
      selectedFiles: 1,
    },
  };
}

export function emptyBoard(repository = repositories[1], overrides = {}) {
  return {
    repository,
    analyzedRepository: null,
    current: null,
    previous: null,
    report: null,
    inventory: null,
    comparison: null,
    source: null,
    analysis: null,
    sourceCheck: null,
    lastAnalysisAttempt: null,
    activeJob: null,
    spendMode: { available: true, mode: 'setup', reason: null },
    ...overrides,
  };
}

export function savedBoard(repository = repositories[1], overrides = {}) {
  const sync = {
    at: generatedAt,
    timeZone: 'UTC',
    branch: 'main',
    commit: 'a'.repeat(40),
    openPullRequests: 0,
  };
  const issue = {
    id: 9001,
    number: 1,
    title: 'Define the report boundary',
    milestone: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-18T19:00:00.000Z',
    assignees: [],
    inProgress: null,
  };
  const inventory = {
    board: 'backlog-triage',
    title: 'widgets backlog',
    repo: repository.fullName,
    repoUrl: repository.url,
    sync: structuredClone(sync),
    issues: [structuredClone(issue)],
  };
  const report = {
    ...structuredClone(inventory),
    summary: 'Start the report boundary issue.',
    lanes: [
      {
        key: 'L1',
        name: 'Report contract',
        mode: 'any',
        issues: [1],
      },
    ],
    startNow: [{ issue: 1, why: 'The issue has no dependencies.' }],
  };
  const fingerprint = {
    algorithm: 'sha256',
    value: sourceFingerprint,
    scope: 'core-and-collected-context',
  };
  const comparison = createInitialComparison({
    reportId,
    generatedAt,
    source: { fingerprint },
    report,
  });
  return {
    repository,
    analyzedRepository: repository,
    current: {
      reportId,
      generatedAt,
      sourceFingerprint,
    },
    previous: null,
    report,
    inventory,
    comparison,
    source: {
      fingerprint,
      sync: structuredClone(sync),
      counts: {
        openIssues: 1,
        openPullRequests: 0,
        milestones: 0,
        labels: 1,
        branches: 1,
        unmergedBranches: 0,
        issueComments: 0,
        treeEntries: 5,
        selectedFiles: 1,
      },
      provenance: {
        repository,
        observedFrom: '2026-09-18T20:09:58.000Z',
        observedTo: generatedAt,
        consistency: 'two-pass-matched',
        inputs: [
          { name: 'core-inventory', status: 'complete' },
          { name: 'issue-comments', status: 'complete' },
          { name: 'repository-tree', status: 'complete' },
          { name: 'selected-file-context', status: 'complete' },
          { name: 'references', status: 'complete' },
          { name: 'branch-ancestry', status: 'complete' },
        ],
        files: [{ path: 'README.md', blobId: 'b'.repeat(40) }],
        references: { verified: 1, unverified: 0 },
        limitations: [
          'Matching observations are not an atomic GitHub snapshot.',
        ],
        analysisSelection: {
          version: 'analysis-selection-v1',
          wireVersion: 'analysis-input-v1',
          sourceSafetyPolicyVersion: 'source-safety-v1',
          sourcePathExtractorVersion: 1,
          mandatoryManifestHash: 'd'.repeat(64),
          selectedComments: [],
          selectedFiles: [
            {
              path: 'README.md',
              blobId: 'b'.repeat(40),
              relevanceClass: 'guidance',
            },
          ],
          omissions: [],
          selectedCounts: { comments: 0, files: 1, total: 1 },
          omittedCounts: { comments: 0, files: 0, total: 0 },
          countAttempts: [
            {
              prefixLength: 0,
              inputTokens: 1200,
              countRequestBytes: 4096,
              messageRequestBytes: 4200,
            },
          ],
          limits: {
            commentBytes: 65536,
            totalCommentBytes: 2097152,
            fileBytes: 65536,
            totalFileBytes: 2097152,
            requestBytes: 8388608,
            inputTokens: 100000,
            outputTokens: 16384,
          },
          limited: false,
          limitations: [],
        },
      },
    },
    analysis: {
      model: 'claude-opus-5',
      effort: 'high',
      promptVersion: 'backlog-analysis-prompt-v1',
      schemaVersion: 1,
      wireVersion: 1,
      assemblerVersion: 1,
      pricingPolicyId: 'setup-opus-5-global-standard-v1',
      attempts: [
        {
          number: 1,
          terminalClass: 'complete',
          inputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 20,
          rates: { inputRateMicrousd: 5, outputRateMicrousd: 25 },
          inferenceGeo: 'global',
          serviceTier: 'standard',
          costMicrousd: 550,
        },
      ],
    },
    sourceCheck: null,
    lastAnalysisAttempt: null,
    activeJob: null,
    spendMode: { available: true, mode: 'setup', reason: null },
    ...overrides,
  };
}

export function safeJob(state, overrides = {}) {
  return {
    id: jobId,
    operation: 'generate',
    state,
    createdAt: '2026-09-18T20:11:00.000Z',
    errorCode: null,
    reportId: state === 'succeeded' ? reportId : null,
    ...overrides,
  };
}

export function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export async function ignoreAbortForRace(page) {
  await page.addInitScript(() => {
    const fetchRequest = window.fetch.bind(window);
    window.fetch = (input, options = {}) =>
      fetchRequest(input, { ...options, signal: undefined });
  });
}

export async function mockApi(page) {
  const flow = {
    authenticated: true,
    csrfToken: 's'.repeat(43),
    sourceAuthorization: 'ready',
    repositories,
    catalog: { items: [], nextCursor: null },
    boards: new Map(),
    calls: [],
    session: null,
    list: null,
    reports: null,
    report: null,
    availability: null,
    check: null,
    admission: null,
    job: null,
    logout: null,
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const address = new URL(request.url());
    const path = address.pathname;
    const call = {
      method: request.method(),
      path,
      query: address.search,
      csrfToken: request.headers()['x-csrf-token'],
      body: request.postData() ? request.postDataJSON() : null,
    };
    flow.calls.push(call);
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
    } else if (path === '/api/reports') {
      response = flow.reports
        ? await flow.reports(address.searchParams.get('cursor'))
        : { status: 200, data: flow.catalog };
    } else if (path === '/api/analysis-availability') {
      response = flow.availability
        ? await flow.availability()
        : {
            status: 200,
            data: {
              spendMode: { available: true, mode: 'setup', reason: null },
            },
          };
    } else if (/^\/api\/repositories\/[1-9]\d*\/report$/u.test(path)) {
      const id = Number(path.split('/')[3]);
      response = flow.report
        ? await flow.report(id)
        : flow.boards.has(id)
          ? { status: 200, data: flow.boards.get(id) }
          : {
              status: 404,
              data: {
                error: { code: 'report_not_found', retryable: false },
              },
            };
    } else if (/^\/api\/repositories\/[1-9]\d*\/check$/u.test(path)) {
      const id = Number(path.split('/')[3]);
      response = flow.check
        ? await flow.check(id)
        : {
            status: 200,
            data: sourceSummary(
              flow.repositories.find((repo) => repo.id === id) ??
                flow.boards.get(id)?.repository,
            ),
          };
    } else if (/^\/api\/repositories\/[1-9]\d*\/report-jobs$/u.test(path)) {
      const id = Number(path.split('/')[3]);
      response = flow.admission
        ? await flow.admission(id, call.body)
        : { status: 202, data: { job: safeJob('queued') } };
    } else if (/^\/api\/report-jobs\/[a-f0-9]{64}$/u.test(path)) {
      response = flow.job
        ? await flow.job(path.split('/').at(-1))
        : { status: 200, data: { job: safeJob('succeeded') } };
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
