import { BoardError, errorResponse } from './errors.mjs';
import { REPORT_LIMITS } from '../../src/domain/report-contract.js';

const number = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 4096) =>
  typeof value === 'string' && value.length <= max && !value.includes('\0');
const fail = () => {
  throw new BoardError('internal_error');
};
const iso = (value) => {
  if (
    !text(value, 40) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail();
  return value;
};

function repository(value) {
  if (
    !value ||
    !number(value.id) ||
    value.id < 1 ||
    !text(value.fullName, 256) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.fullName) ||
    value.fullName.split('/')[0].toLowerCase() !== 'cboone' ||
    ['.', '..'].includes(value.name) ||
    value.name !== value.fullName.split('/')[1] ||
    typeof value.private !== 'boolean' ||
    value.url !== `https://github.com/${value.fullName}`
  )
    fail();
  return {
    id: value.id,
    fullName: value.fullName,
    name: value.name,
    private: value.private,
    url: value.url,
  };
}

function list(value, max, project) {
  if (!Array.isArray(value) || value.length > max) fail();
  return value.map(project);
}

function string(value, max = 4096) {
  if (!text(value, max)) fail();
  return value;
}
function count(value) {
  if (!number(value)) fail();
  return value;
}

export function projectSummary(value, repositoryId) {
  if (!value || value.status !== 'complete') fail();
  const repo = repository(value.repo);
  if (repo.id !== repositoryId) fail();
  const sync = value.sync;
  if (
    !sync ||
    !text(sync.branch, REPORT_LIMITS.textLength) ||
    !sync.branch ||
    /[\s\u0000-\u001f\u007f-\u009f]/u.test(sync.branch) ||
    sync.branch
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sync.commit)
  )
    fail();
  const projectedSync = {
    at: iso(sync.at),
    branch: sync.branch,
    commit: sync.commit,
    openPullRequests: count(sync.openPullRequests),
  };
  if (sync.timeZone !== undefined) {
    const timeZone = string(sync.timeZone, 128);
    try {
      new Intl.DateTimeFormat('en', { timeZone });
    } catch {
      fail();
    }
    projectedSync.timeZone = timeZone;
  }
  if (
    value.fingerprint?.algorithm !== 'sha256' ||
    value.fingerprint?.scope !== 'core-and-collected-context' ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint?.value ?? '')
  )
    fail();
  const provenance = value.provenance;
  if (!provenance || provenance.consistency !== 'two-pass-matched') fail();
  const observedFrom = iso(provenance.observedFrom);
  const observedTo = iso(provenance.observedTo);
  if (Date.parse(observedFrom) > Date.parse(observedTo)) fail();
  const inputs = list(provenance.inputs, 100, (input) => {
    if (!input || !['complete', 'bounded', 'unverified'].includes(input.status))
      fail();
    return { name: string(input.name, 256), status: input.status };
  });
  const files = list(provenance.files, 100, (file) => {
    if (!file || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(file.blobId)) fail();
    return { path: string(file.path, 4096), blobId: file.blobId };
  });
  const references = {
    verified: count(provenance.references?.verified),
    unverified: count(provenance.references?.unverified),
  };
  const limitations = list(provenance.limitations, 100, (item) =>
    string(item, 4096),
  );
  const counts = {};
  for (const name of [
    'openIssues',
    'openPullRequests',
    'milestones',
    'labels',
    'branches',
    'unmergedBranches',
    'issueComments',
    'treeEntries',
    'selectedFiles',
  ])
    counts[name] = count(value.counts?.[name]);
  return {
    status: 'complete',
    repo,
    sync: projectedSync,
    fingerprint: {
      algorithm: 'sha256',
      value: value.fingerprint.value,
      scope: 'core-and-collected-context',
    },
    provenance: {
      observedFrom,
      observedTo,
      consistency: 'two-pass-matched',
      inputs,
      files,
      references,
      limitations,
    },
    counts,
  };
}

function json(value, cookies = [], status = 200) {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return Response.json(value, { status, headers });
}
function redirect(result) {
  const headers = new Headers({
    Location: result.location,
    'Cache-Control': 'no-store',
  });
  for (const cookie of result.cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEX_64 = /^[a-f0-9]{64}$/u;

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

async function requestJson(request, maximum = 16_384) {
  if (request.headers.get('content-type') !== 'application/json')
    throw new BoardError('invalid_request');
  const stated = request.headers.get('content-length');
  if (
    stated !== null &&
    (!/^(?:0|[1-9]\d*)$/u.test(stated) || Number(stated) > maximum)
  )
    throw new BoardError('invalid_request');
  const reader = request.body?.getReader();
  if (!reader) throw new BoardError('invalid_request');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new BoardError('invalid_request');
      chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error instanceof BoardError
      ? error
      : new BoardError('invalid_request');
  }
}

function admissionRequest(value) {
  if (
    !exact(value, ['idempotencyKey', 'operation', 'expectedCurrentReportId']) ||
    typeof value.idempotencyKey !== 'string' ||
    !UUID.test(value.idempotencyKey) ||
    !['generate', 'refresh'].includes(value.operation) ||
    !(
      value.expectedCurrentReportId === null ||
      (typeof value.expectedCurrentReportId === 'string' &&
        HEX_64.test(value.expectedCurrentReportId))
    ) ||
    (value.operation === 'generate' &&
      value.expectedCurrentReportId !== null) ||
    (value.operation === 'refresh' && value.expectedCurrentReportId === null)
  )
    throw new BoardError('invalid_request');
  return {
    idempotencyKey: value.idempotencyKey.toLowerCase(),
    operation: value.operation,
    expectedCurrentReportId: value.expectedCurrentReportId,
  };
}

function decisionRequest(value) {
  if (
    !exact(value, [
      'policyId',
      'discussionRevision',
      'decisionId',
      'decision',
      'authorizedThroughMicrousd',
      'authorizedOperations',
    ]) ||
    typeof value.policyId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.policyId) ||
    !Number.isSafeInteger(value.discussionRevision) ||
    value.discussionRevision < 1 ||
    typeof value.decisionId !== 'string' ||
    !HEX_64.test(value.decisionId) ||
    !['acknowledge', 'stop'].includes(value.decision) ||
    !Number.isSafeInteger(value.authorizedThroughMicrousd) ||
    value.authorizedThroughMicrousd < 0 ||
    value.authorizedThroughMicrousd > 25_000_000 ||
    !Array.isArray(value.authorizedOperations) ||
    value.authorizedOperations.length > 2 ||
    new Set(value.authorizedOperations).size !==
      value.authorizedOperations.length ||
    value.authorizedOperations.some(
      (operation) => !['generate', 'refresh'].includes(operation),
    ) ||
    (value.decision === 'stop' &&
      (value.authorizedThroughMicrousd !== 0 ||
        value.authorizedOperations.length !== 0))
  )
    throw new BoardError('invalid_request');
  return {
    policyId: value.policyId,
    discussionRevision: value.discussionRevision,
    decisionId: value.decisionId,
    decision: value.decision,
    authorizedThroughMicrousd: value.authorizedThroughMicrousd,
    authorizedOperations: [...value.authorizedOperations],
  };
}

export function createApi({
  auth,
  sourceOperations,
  reportOperations = null,
  createOperationBudget,
}) {
  return async function api(request) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const budget = createOperationBudget({ signal: request.signal });
      if (request.method === 'GET' && path === '/api/session')
        return json(await auth.bootstrap(request, { budget }));
      if (request.method === 'GET' && path === '/api/auth/start')
        return redirect(await auth.startOAuth(request, { budget }));
      if (request.method === 'GET' && path === '/api/auth/callback')
        return redirect(await auth.completeOAuth(request, { budget }));
      const isList = request.method === 'GET' && path === '/api/repositories';
      const isLogout = request.method === 'POST' && path === '/api/auth/logout';
      const sourceMatch =
        request.method === 'POST' &&
        /^\/api\/repositories\/([1-9]\d*)\/check$/.exec(path);
      const reportMatch =
        request.method === 'GET' &&
        /^\/api\/repositories\/([1-9]\d*)\/report$/.exec(path);
      const admissionMatch =
        request.method === 'POST' &&
        /^\/api\/repositories\/([1-9]\d*)\/report-jobs$/.exec(path);
      const jobMatch =
        request.method === 'GET' &&
        /^\/api\/report-jobs\/([a-f0-9]{64})$/.exec(path);
      const isReports = request.method === 'GET' && path === '/api/reports';
      const isAnalysisAvailability =
        request.method === 'GET' && path === '/api/analysis-availability';
      const isDecision =
        request.method === 'POST' && path === '/api/setup-budget-decision';
      const reportRoute =
        isReports ||
        isAnalysisAvailability ||
        reportMatch ||
        admissionMatch ||
        jobMatch ||
        isDecision;
      if (
        (!isList && !isLogout && !sourceMatch && !reportRoute) ||
        (!isReports && url.search) ||
        (isReports &&
          [...url.searchParams.keys()].some((key) => key !== 'cursor')) ||
        (isReports && url.searchParams.getAll('cursor').length > 1) ||
        (reportRoute && reportOperations === null)
      )
        throw new BoardError('invalid_request');
      const repositoryMatch = sourceMatch || reportMatch || admissionMatch;
      const repositoryId = repositoryMatch
        ? Number(repositoryMatch[1])
        : undefined;
      if (repositoryMatch && !Number.isSafeInteger(repositoryId))
        throw new BoardError('invalid_request');
      const session = await auth.requireAuthorizedOwner(request, { budget });
      if (isLogout || sourceMatch || admissionMatch || isDecision)
        auth.requireCsrf(request, session);
      const parsedAdmission = admissionMatch
        ? admissionRequest(await requestJson(request))
        : null;
      if (isLogout) {
        const result = await auth.logout({ session, budget });
        return json({ ok: true }, result.cookies);
      }
      if (
        isReports ||
        isAnalysisAvailability ||
        reportMatch ||
        jobMatch ||
        isDecision
      ) {
        let output;
        if (isReports)
          output = await reportOperations.listReports({
            ownerId: session.ownerId,
            cursor: url.searchParams.get('cursor'),
            budget,
          });
        else if (isAnalysisAvailability)
          output = await reportOperations.getAnalysisAvailability({
            ownerId: session.ownerId,
            budget,
          });
        else if (reportMatch)
          output = await reportOperations.getReport({
            ownerId: session.ownerId,
            repositoryId,
            budget,
          });
        else if (jobMatch)
          output = await reportOperations.pollJob({
            ownerId: session.ownerId,
            jobId: jobMatch[1],
            budget,
          });
        else
          output = await reportOperations.decideSetupBudget({
            ownerId: session.ownerId,
            decision: decisionRequest(await requestJson(request)),
            budget,
          });
        await auth.recheckOwner({ session, budget });
        return json(output);
      }
      const lease = await auth.acquireToken({ session, budget });
      let result;
      try {
        const shared = {
          ownerId: session.ownerId,
          accessToken: lease.accessToken,
          signal: budget.signal,
          budget,
        };
        if (isList) result = await sourceOperations.listRepositories(shared);
        else if (admissionMatch) {
          const pinned = await sourceOperations.checkRepositoryAccess({
            ...shared,
            repositoryId,
          });
          result = await reportOperations.admitJob({
            ownerId: session.ownerId,
            authorizationEpoch: session.authorizationEpoch,
            repository: pinned,
            request: parsedAdmission,
            budget,
          });
        } else if (reportOperations)
          result = await reportOperations.checkSource({
            ownerId: session.ownerId,
            repositoryId,
            accessToken: lease.accessToken,
            signal: budget.signal,
            budget,
          });
        else
          result = await sourceOperations.checkRepository({
            ...shared,
            repositoryId,
          });
      } catch (error) {
        if (
          error instanceof BoardError &&
          error.code === 'source_authorization_required'
        ) {
          const current = await auth.noteTokenRejected({ lease, budget });
          if (!current) throw new BoardError('provider_unavailable');
        }
        await auth.recheckOwner({ session, budget });
        throw error;
      }
      let output;
      let leaseIsCurrent;
      if (isList) {
        const repositories = list(
          result?.repositories,
          budget.limits.repositories,
          repository,
        );
        if (
          !['ready', 'installation-required'].includes(
            result?.sourceAuthorization,
          )
        )
          fail();
        leaseIsCurrent = await auth.recordSourceAuthorization({
          lease,
          sourceAuthorization: result.sourceAuthorization,
          budget,
        });
        output = { repositories };
      } else if (admissionMatch) {
        output = result;
        leaseIsCurrent = await auth.recordSourceAuthorization({
          lease,
          sourceAuthorization: 'ready',
          budget,
        });
      } else {
        output = projectSummary(result?.summary, repositoryId);
        leaseIsCurrent = await auth.recordSourceAuthorization({
          lease,
          sourceAuthorization: 'ready',
          budget,
        });
      }
      await auth.recheckOwner({ session, lease, budget });
      if (!leaseIsCurrent) throw new BoardError('provider_unavailable');
      return json(output, [], admissionMatch ? 202 : 200);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
