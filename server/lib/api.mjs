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

function json(value, cookies = []) {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return Response.json(value, { headers });
}
function redirect(result) {
  const headers = new Headers({
    Location: result.location,
    'Cache-Control': 'no-store',
  });
  for (const cookie of result.cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

export function createApi({ auth, sourceOperations, createOperationBudget }) {
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
      const match =
        request.method === 'POST' &&
        /^\/api\/repositories\/([1-9]\d*)\/check$/.exec(path);
      if ((!isList && !isLogout && !match) || url.search)
        throw new BoardError('invalid_request');
      const repositoryId = match ? Number(match[1]) : undefined;
      if (match && !Number.isSafeInteger(repositoryId))
        throw new BoardError('invalid_request');
      const session = await auth.requireAuthorizedOwner(request, { budget });
      if (isLogout || match) auth.requireCsrf(request, session);
      if (isLogout) {
        const result = await auth.logout({ session, budget });
        return json({ ok: true }, result.cookies);
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
        result = isList
          ? await sourceOperations.listRepositories(shared)
          : await sourceOperations.checkRepository({ ...shared, repositoryId });
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
      return json(output);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
