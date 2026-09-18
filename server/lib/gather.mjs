import { BoardError } from './errors.mjs';
import { createGithubClient } from './github.mjs';
import { createOperationBudget } from './source-limits.mjs';
import {
  compareSourceKeys,
  fingerprintSource,
  sourceDigest,
} from './fingerprint.mjs';
import { REPORT_LIMITS } from '../../src/domain/report-contract.js';

const OWNER_ID = 99961;
const OWNER_LOGIN = 'cboone';
const SHA = /^[a-f\d]{40}$/u;
const GRAPHQL_INT_MAX = 2147483647;
const CLOSING_QUERY =
  'query ClosingIssues($owner:String!,$name:String!,$number:Int!,$cursor:String){' +
  'repository(owner:$owner,name:$name){databaseId nameWithOwner pullRequest(number:$number){' +
  'number closingIssuesReferences(first:100,after:$cursor){nodes{fullDatabaseId number ' +
  'repository{databaseId nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}';
const REFERENCE_QUERY =
  'query ReferenceFacts($owner:String!,$name:String!,$number:Int!){' +
  'repository(owner:$owner,name:$name){databaseId nameWithOwner issueOrPullRequest(number:$number){' +
  '__typename ... on Issue{fullDatabaseId number state stateReason repository{databaseId nameWithOwner}} ' +
  '... on PullRequest{fullDatabaseId number state merged mergeCommit{oid} repository{databaseId nameWithOwner}}}}}';

function incomplete() {
  throw new BoardError('source_incomplete');
}
function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1) incomplete();
  return value;
}
function databaseId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/u.test(value))
    incomplete();
  return positive(Number(value));
}
function nonnegative(value) {
  if (!Number.isSafeInteger(value) || value < 0) incomplete();
  return value;
}
function text(value, { nullable = false, max = 2 * 1024 * 1024 } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > max || /\u0000/u.test(value))
    incomplete();
  return value;
}
function canonicalText(value) {
  text(value, { max: REPORT_LIMITS.textLength });
  if (!/\S/u.test(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    incomplete();
  return value;
}
function boolean(value) {
  if (typeof value !== 'boolean') incomplete();
  return value;
}
function parsedUrl(value) {
  if (typeof value !== 'string' || /[\s\\]/u.test(value)) incomplete();
  try {
    return new URL(value);
  } catch {
    incomplete();
  }
}
function sha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) incomplete();
  return value;
}
function branchName(value) {
  text(value, { max: REPORT_LIMITS.textLength });
  if (
    !value ||
    /[\s\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    incomplete();
  return value;
}
function bounded(values, limit) {
  if (values.length > limit) throw new BoardError('source_limit_exceeded');
  return values;
}
async function completeAll(promises) {
  const results = await Promise.allSettled(promises);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    // Finish the current observation before an entire retry. A token rejection
    // or another terminal failure takes precedence over a moving-source result.
    const failure =
      failures.find(
        (result) => result.reason.code === 'source_authorization_required',
      ) ??
      failures.find((result) => result.reason.code !== 'source_unstable') ??
      failures[0];
    throw failure.reason;
  }
  return results.map((result) => result.value);
}
function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    incomplete();
  return value;
}
function permissionGranted(permissions) {
  return ['metadata', 'issues', 'pull_requests', 'contents'].every((key) =>
    ['read', 'write'].includes(permissions?.[key]),
  );
}
function repositoryFacts(item) {
  if (!item || typeof item !== 'object') incomplete();
  positive(item.id);
  positive(item.owner?.id);
  text(item.owner?.login, { max: 100 });
  text(item.owner?.type, { max: 100 });
  text(item.name, { max: 100 });
  text(item.full_name, { max: 250 });
  if (
    !/^[A-Za-z\d_.-]+$/u.test(item.name) ||
    ['.', '..'].includes(item.name) ||
    item.full_name !== item.owner.login + '/' + item.name
  )
    incomplete();
  const url = parsedUrl(item.html_url);
  if (
    url.origin !== 'https://github.com' ||
    url.pathname !== '/' + item.full_name ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    incomplete();
  return {
    id: item.id,
    ownerId: item.owner.id,
    ownerLogin: item.owner.login,
    ownerType: item.owner.type,
    fullName: item.full_name,
    name: item.name,
    private: boolean(item.private),
    fork: boolean(item.fork),
    archived: boolean(item.archived),
    url: url.href,
  };
}
function eligible(repo, ownerId) {
  return (
    repo.ownerId === ownerId &&
    repo.ownerType === 'User' &&
    repo.ownerLogin.toLowerCase() === OWNER_LOGIN &&
    !repo.fork &&
    !repo.archived
  );
}
function selection(repo) {
  return {
    id: repo.id,
    fullName: repo.fullName,
    name: repo.name,
    private: repo.private,
    url: repo.url,
  };
}
function labelFacts(item) {
  return {
    id: positive(item?.id),
    name: canonicalText(item.name),
    color: text(item.color, { max: 20 }),
    description: text(item.description, { nullable: true }),
  };
}
function milestoneFacts(item) {
  if (!['open', 'closed'].includes(item?.state)) incomplete();
  return {
    id: positive(item.id),
    number: positive(item.number),
    title: canonicalText(item.title),
    description: text(item.description, { nullable: true }),
    state: item.state,
    dueOn: item.due_on === null ? null : timestamp(item.due_on),
    updatedAt: timestamp(item.updated_at),
  };
}
function unique(values, identity) {
  const seen = new Set();
  for (const value of values) {
    const id = identity(value);
    if (seen.has(id)) throw new BoardError('source_unstable');
    seen.add(id);
  }
  return values;
}
function joinFacts(map, item) {
  const existing = map.get(item.id);
  if (existing && sourceDigest(existing) !== sourceDigest(item))
    throw new BoardError('source_unstable');
  map.set(item.id, item);
}
function pullJoinFacts(item) {
  return {
    id: positive(item.id),
    number: positive(item.number),
    title: canonicalText(item.title),
    body: text(item.body, { nullable: true }),
    state: item.state,
    updatedAt: timestamp(item.updated_at),
  };
}
function issueFacts(item) {
  if (item.state !== 'open' || !Array.isArray(item.labels)) incomplete();
  return {
    id: positive(item.id),
    number: positive(item.number),
    title: canonicalText(item.title),
    body: text(item.body, { nullable: true }),
    state: item.state,
    stateReason:
      item.state_reason === null ? null : text(item.state_reason, { max: 100 }),
    labels: unique(item.labels.map(labelFacts), (label) => label.id),
    milestone: item.milestone === null ? null : milestoneFacts(item.milestone),
    comments: nonnegative(item.comments),
    updatedAt: timestamp(item.updated_at),
  };
}
function pullFacts(item, repo) {
  if (
    item.state !== 'open' ||
    item.base?.repo?.id !== repo.id ||
    item.base?.repo?.full_name !== repo.fullName
  )
    incomplete();
  return {
    id: positive(item.id),
    number: positive(item.number),
    title: canonicalText(item.title),
    body: text(item.body, { nullable: true }),
    state: item.state,
    draft: boolean(item.draft),
    updatedAt: timestamp(item.updated_at),
    base: {
      ref: branchName(item.base.ref),
      sha: sha(item.base.sha),
      repoId: repo.id,
    },
    head: {
      ref: branchName(item.head?.ref),
      sha: sha(item.head?.sha),
      repoId: item.head.repo === null ? null : positive(item.head.repo?.id),
    },
    closingIssues: [],
  };
}
function pathPrefix(repo) {
  return (
    '/repos/' +
    encodeURIComponent(repo.ownerLogin) +
    '/' +
    encodeURIComponent(repo.name)
  );
}

async function listEligible(client, appId, ownerId, budget) {
  const installations = await client.paginate('/user/installations', {
    key: 'installations',
    limit: budget.limits.requests * budget.limits.pageSize,
  });
  const matching = installations.filter(
    (installation) =>
      installation.app_id === appId &&
      installation.account?.id === ownerId &&
      installation.account?.type === 'User' &&
      installation.suspended_at === null &&
      permissionGranted(installation.permissions),
  );
  const repos = new Map();
  for (const installation of matching) {
    positive(installation.id);
    const values = await client.paginate(
      '/user/installations/' + installation.id + '/repositories',
      {
        key: 'repositories',
        limit: budget.limits.requests * budget.limits.pageSize,
      },
    );
    for (const item of values) {
      const repo = repositoryFacts(item);
      if (!eligible(repo, ownerId)) continue;
      joinFacts(repos, repo);
      if (repos.size > budget.limits.repositories)
        throw new BoardError('source_limit_exceeded');
    }
  }
  return {
    repositories: [...repos.values()].sort((a, b) => a.id - b.id),
    sourceAuthorization: matching.length ? 'ready' : 'installation-required',
  };
}

async function pinRepository(client, appId, ownerId, repositoryId, budget) {
  const inventory = await listEligible(client, appId, ownerId, budget);
  const selected = inventory.repositories.find(
    (repo) => repo.id === repositoryId,
  );
  if (!selected) throw new BoardError('source_unavailable');
  const response = await client.get(pathPrefix(selected));
  const repo = repositoryFacts(response);
  if (
    repo.id !== repositoryId ||
    !eligible(repo, ownerId) ||
    sourceDigest(repo) !== sourceDigest(selected)
  )
    throw new BoardError('source_unstable');
  const defaultBranch = branchName(response.default_branch);
  const tip = await client.get(
    pathPrefix(repo) + '/branches/' + encodeURIComponent(defaultBranch),
  );
  if (tip.name !== defaultBranch) incomplete();
  return { ...repo, defaultBranch, defaultTip: sha(tip.commit?.sha) };
}

async function closingIssues(client, repo, pull, budget) {
  let cursor = null;
  const cursors = new Set();
  const result = [];
  const seen = new Set();
  for (;;) {
    const data = await client.graphql(CLOSING_QUERY, {
      owner: repo.ownerLogin,
      name: repo.name,
      number: pull.number,
      cursor,
    });
    const repository = data.repository;
    const connection = repository?.pullRequest?.closingIssuesReferences;
    if (
      repository?.databaseId !== repo.id ||
      repository.nameWithOwner !== repo.fullName ||
      repository.pullRequest?.number !== pull.number ||
      !Array.isArray(connection?.nodes) ||
      connection.nodes.length > 100 ||
      typeof connection.pageInfo?.hasNextPage !== 'boolean'
    )
      incomplete();
    for (const node of connection.nodes) {
      const item = {
        id: databaseId(node?.fullDatabaseId),
        number: positive(node.number),
        repoId: positive(node.repository?.databaseId),
        repo: text(node.repository.nameWithOwner, { max: 250 }),
      };
      const key = item.repoId + ':' + item.id;
      if (seen.has(key)) throw new BoardError('source_unstable');
      seen.add(key);
      result.push(item);
      bounded(result, budget.limits.issues);
    }
    if (!connection.pageInfo.hasNextPage) break;
    const next = text(connection.pageInfo.endCursor, { max: 2000 });
    if (!next || cursors.has(next)) incomplete();
    cursors.add(next);
    cursor = next;
  }
  return result;
}

async function classifyBranch(client, repo, item, cache) {
  const name = branchName(item.name);
  const tip = sha(item.commit?.sha);
  const key = repo.id + ':' + repo.defaultTip + ':' + tip;
  let observation = cache.get(key);
  if (!observation) {
    observation = (async () => {
      let facts;
      if (tip === repo.defaultTip)
        facts = {
          status: 'identical',
          ahead: 0,
          behind: 0,
          unmerged: false,
          verification: 'verified',
        };
      else {
        try {
          const comparison = await client.get(
            pathPrefix(repo) + '/compare/' + repo.defaultTip + '...' + tip,
          );
          if (
            !['ahead', 'behind', 'identical', 'diverged'].includes(
              comparison.status,
            )
          )
            incomplete();
          const ahead = nonnegative(comparison.ahead_by);
          const behind = nonnegative(comparison.behind_by);
          if (
            (comparison.status === 'identical' &&
              (ahead !== 0 || behind !== 0)) ||
            (comparison.status === 'behind' && ahead !== 0) ||
            (comparison.status === 'ahead' && (ahead === 0 || behind !== 0)) ||
            (comparison.status === 'diverged' && (ahead === 0 || behind === 0))
          )
            incomplete();
          facts = {
            status: comparison.status,
            ahead,
            behind,
            unmerged: ahead > 0,
            verification: 'verified',
          };
        } catch (error) {
          if (!['forbidden', 'source_unavailable'].includes(error.code))
            throw error;
          facts = {
            status: 'unknown',
            ahead: null,
            behind: null,
            unmerged: null,
            verification: 'unverified',
          };
        }
      }
      return facts;
    })();
    cache.set(key, observation);
  }
  const facts = await observation;
  // Unreadability is an observation, so repeat it in the next complete pass.
  if (facts.verification !== 'verified') cache.delete(key);
  return { name, tip, protected: boolean(item.protected), ...facts };
}

function treeItem(item, prefix = '') {
  text(item?.path, { max: REPORT_LIMITS.textLength });
  if (
    !item.path ||
    item.path.startsWith('/') ||
    /[\\\u0000]/u.test(item.path) ||
    item.path
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    !['blob', 'tree', 'commit'].includes(item.type)
  )
    incomplete();
  return {
    path: prefix + item.path,
    type: item.type,
    sha: sha(item.sha),
    mode: text(item.mode, { max: 10 }),
    size: item.size === undefined ? null : nonnegative(item.size),
  };
}
async function completeTree(client, repo, budget) {
  const prefix = pathPrefix(repo) + '/git/trees/';
  const recursive = await client.get(prefix + repo.defaultTip + '?recursive=1');
  if (
    !Array.isArray(recursive.tree) ||
    typeof recursive.truncated !== 'boolean'
  )
    incomplete();
  if (!recursive.truncated)
    return bounded(
      unique(
        recursive.tree.map((item) => treeItem(item)),
        (item) => item.path,
      ),
      budget.limits.treeEntries,
    );
  const pending = [{ sha: repo.defaultTip, prefix: '' }];
  const result = [];
  while (pending.length) {
    const next = pending.shift();
    const response = await client.get(prefix + next.sha);
    if (!Array.isArray(response.tree) || response.truncated !== false)
      incomplete();
    for (const item of response.tree) {
      const entry = treeItem(item, next.prefix);
      if (item.path.includes('/')) incomplete();
      result.push(entry);
      bounded(result, budget.limits.treeEntries);
      if (entry.type === 'tree')
        pending.push({ sha: entry.sha, prefix: entry.path + '/' });
    }
  }
  return unique(result, (item) => item.path);
}

const EXCLUDED_DIRECTORY =
  /(^|\/)(?:node_modules|vendor|vendors|dist|build|coverage|\.git|\.next|\.cache|\.ssh|\.aws|\.azure|\.docker|\.gnupg|\.kube|\.config\/gcloud|generated|credentials?|secrets?)(?:\/|$)/iu;
const EXCLUDED_FILE =
  /(^|\/)(?:\.env[^/]*|\.git-credentials|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)[^/]*|\.?credentials?[^/]*|\.?secrets?[^/]*|(?:service[-_]?account|private[-_]?key|oauth[-_]?credentials)[^/]*\.json|[^/]*\.(?:pem|key|p12|pfx|jks|keystore|crt|cer))$/iu;
const KNOWN_CREDENTIAL_PATH =
  /(^|\/)(?:\.codex\/auth\.json|\.claude\/\.credentials\.json|\.config\/(?:gh\/hosts\.ya?ml|glab-cli\/config\.ya?ml|netlify\/config\.json)|Library\/Preferences\/netlify\/config\.json)$/iu;
const BINARY_FILE =
  /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|otf|mp[34]|wav|ogg|so|dylib|dll|exe|class|wasm|bin)$/iu;
const GUIDANCE_FILE = /(^|\/)(?:readme(?:\.[^/]+)?|agents\.md|claude\.md)$/iu;
const CONFIG_FILE =
  /(^|\/)(?:package\.json|(?:pnpm-lock|yarn|package-lock)\.[^/]+|(?:vite|vitest|playwright|tailwind|eslint|rollup|webpack|babel|jest)\.config\.[^/]+|(?:tsconfig[^/]*\.json)|makefile|cargo\.toml|go\.mod|pyproject\.toml|deno\.jsonc?|\.github\/workflows\/[^/]+\.ya?ml)$/iu;

export function selectSourceFiles(tree, issues, limits) {
  const prose = issues
    .map((issue) => (issue.body ?? '') + '\n' + (issue.title ?? ''))
    .join('\n');
  const referencedPaths = new Set();
  const quotedPath =
    /[\u0060"']([^\u0060"'\r\n]+)[\u0060"']|\]\(([^()\s]+)\)/gu;
  for (const match of prose.matchAll(quotedPath)) {
    const path = (match[1] ?? match[2])
      .replace(/^\.\//u, '')
      .replace(/(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)$/u, '');
    if (!path.includes('://') && !path.startsWith('/'))
      referencedPaths.add(path);
  }
  let excluded = 0;
  let unselected = 0;
  const candidates = [];
  for (const entry of [...tree].sort((a, b) =>
    compareSourceKeys(a.path, b.path),
  )) {
    if (entry.type === 'commit') {
      excluded += 1;
      continue;
    }
    if (entry.type !== 'blob') continue;
    if (
      EXCLUDED_DIRECTORY.test(entry.path) ||
      EXCLUDED_FILE.test(entry.path) ||
      KNOWN_CREDENTIAL_PATH.test(entry.path) ||
      BINARY_FILE.test(entry.path) ||
      (entry.mode !== '100644' && entry.mode !== '100755')
    ) {
      excluded += 1;
      continue;
    }
    const referenced = referencedPaths.has(entry.path);
    if (
      !GUIDANCE_FILE.test(entry.path) &&
      !CONFIG_FILE.test(entry.path) &&
      !referenced
    ) {
      unselected += 1;
      continue;
    }
    if (entry.size !== null && entry.size > limits.fileBytes) {
      excluded += 1;
      continue;
    }
    candidates.push(entry);
  }
  const selected = [];
  let reservedBytes = 0;
  for (const entry of candidates) {
    const bytes = entry.size ?? limits.fileBytes;
    if (
      selected.length >= limits.files ||
      reservedBytes + bytes > limits.totalFileBytes
    )
      continue;
    selected.push(entry);
    reservedBytes += bytes;
  }
  return {
    selected,
    excluded,
    unselected: unselected + candidates.length - selected.length,
  };
}

async function filesForTree(client, repo, tree, issues, budget) {
  const policy = selectSourceFiles(tree, issues, budget.limits);
  let total = 0;
  const files = [];
  for (const entry of policy.selected) {
    let blob;
    try {
      blob = await client.get(pathPrefix(repo) + '/git/blobs/' + entry.sha);
    } catch (error) {
      if (['forbidden', 'source_unavailable'].includes(error.code))
        incomplete();
      throw error;
    }
    if (
      blob.sha !== entry.sha ||
      blob.encoding !== 'base64' ||
      typeof blob.content !== 'string'
    )
      incomplete();
    const size = nonnegative(blob.size);
    if (
      size > budget.limits.fileBytes ||
      total + size > budget.limits.totalFileBytes
    )
      throw new BoardError('source_limit_exceeded');
    const encoded = blob.content.replace(/\n/gu, '');
    if (
      !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(
        encoded,
      )
    )
      incomplete();
    const bytes = Buffer.from(encoded, 'base64');
    if (
      bytes.byteLength !== size ||
      (entry.size !== null && entry.size !== size)
    )
      incomplete();
    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      incomplete();
    }
    if (content.includes('\u0000')) incomplete();
    total += size;
    files.push({ path: entry.path, blobId: entry.sha, content });
  }
  return { files, excluded: policy.excluded, unselected: policy.unselected };
}

function referencesFrom(prose, repo) {
  const refs = new Map();
  const pattern =
    /https:\/\/[^\s<>"')\u0060]+|(?:[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+)?#[1-9]\d*/giu;
  for (const match of prose.matchAll(pattern)) {
    const before = match.index === 0 ? '' : prose[match.index - 1];
    if (before && /[A-Za-z\d_/#]/u.test(before)) continue;
    const raw = match[0].replace(/[.,;:]+$/u, '');
    let number;
    let kind = 'item';
    if (/^https:\/\//iu.test(raw)) {
      let url;
      try {
        url = new URL(raw);
      } catch {
        continue;
      }
      const local = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9]\d*)\/?$/u.exec(
        url.pathname,
      );
      if (
        url.origin === 'https://github.com' &&
        !url.username &&
        !url.password &&
        local &&
        (local[1] + '/' + local[2]).toLowerCase() ===
          repo.fullName.toLowerCase()
      ) {
        number = Number(local[4]);
        kind = local[3] === 'pull' ? 'pull' : 'issue';
      }
    } else {
      const local = /^(?:([^#]+))?#([1-9]\d*)$/u.exec(raw);
      if (!local?.[1] || local[1].toLowerCase() === repo.fullName.toLowerCase())
        number = Number(local[2]);
    }
    if (Number.isSafeInteger(number) && number > 0) {
      const key = repo.id + ':' + kind + ':' + number;
      refs.set(key, {
        key,
        requested: { repoId: repo.id, number, kind },
        ...(number > GRAPHQL_INT_MAX
          ? {
              verification: 'unverified',
              reason: 'unsupported-reference-number',
            }
          : {}),
      });
    } else {
      const key = 'external:' + raw;
      refs.set(key, {
        key,
        requested: { reference: raw },
        verification: 'unverified',
        reason: 'external-reference',
      });
    }
  }
  return [...refs.values()];
}

async function resolveReference(client, repo, entry, reads) {
  if (entry.verification === 'unverified') return entry;
  const { number, kind } = entry.requested;
  const read = () => {
    if (!reads.has(number))
      reads.set(
        number,
        client.graphql(REFERENCE_QUERY, {
          owner: repo.ownerLogin,
          name: repo.name,
          number,
        }),
      );
    return reads.get(number);
  };
  try {
    const data = await read();
    if (data.repository === null) throw new BoardError('source_unavailable');
    const repository = data.repository;
    if (
      repository?.databaseId !== repo.id ||
      repository.nameWithOwner !== repo.fullName
    )
      incomplete();
    const item = repository.issueOrPullRequest;
    if (item === null) throw new BoardError('source_unavailable');
    if (
      item?.number !== number ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(item.state) ||
      item.repository?.databaseId !== repo.id ||
      item.repository.nameWithOwner !== repo.fullName ||
      !['Issue', 'PullRequest'].includes(item.__typename)
    )
      incomplete();
    const actualKind = item.__typename === 'PullRequest' ? 'pull' : 'issue';
    if (kind !== 'item' && kind !== actualKind) incomplete();
    if (
      (actualKind === 'issue' && item.state === 'MERGED') ||
      (actualKind === 'pull' &&
        boolean(item.merged) !== (item.state === 'MERGED'))
    )
      incomplete();
    const facts = {
      repoId: repo.id,
      id: databaseId(item.fullDatabaseId),
      number,
      type: actualKind,
      state: item.state === 'MERGED' ? 'closed' : item.state.toLowerCase(),
      ...(actualKind === 'pull'
        ? {
            merged: boolean(item.merged),
            mergeSha:
              item.mergeCommit === null ? null : sha(item.mergeCommit?.oid),
          }
        : {
            stateReason:
              item.stateReason === null
                ? null
                : text(item.stateReason, { max: 100 }).toLowerCase(),
          }),
    };
    return { ...entry, verification: 'verified', facts };
  } catch (error) {
    if (!['forbidden', 'source_unavailable'].includes(error.code)) throw error;
    return {
      ...entry,
      verification: 'unverified',
      reason:
        error.code === 'forbidden' ? 'permission-unavailable' : 'not-readable',
    };
  }
}

async function gatherPass(
  client,
  { appId, ownerId, repositoryId, budget, immutable },
) {
  const repository = await pinRepository(
    client,
    appId,
    ownerId,
    repositoryId,
    budget,
  );
  const prefix = pathPrefix(repository);
  const [issueItems, pullItems, milestoneItems, labelItems, branchItems] =
    await completeAll([
      client.paginate(prefix + '/issues?state=open', {
        limit: budget.limits.issues + budget.limits.pullRequests,
      }),
      client.paginate(prefix + '/pulls?state=open', {
        limit: budget.limits.pullRequests,
      }),
      client.paginate(prefix + '/milestones?state=open', {
        limit: budget.limits.milestones,
      }),
      client.paginate(prefix + '/labels', { limit: budget.limits.labels }),
      client.paginate(prefix + '/branches', {
        limit: budget.limits.branches,
        identity: (item) => item.name,
      }),
    ]);
  const issues = unique(
    bounded(
      issueItems.filter((item) => !item.pull_request).map(issueFacts),
      budget.limits.issues,
    ),
    (item) => item.number,
  );
  const pullRequests = unique(
    pullItems.map((item) => pullFacts(item, repository)),
    (item) => item.number,
  );
  const issuePulls = unique(
    issueItems.filter((item) => item.pull_request).map(pullJoinFacts),
    (item) => item.number,
  );
  const listedPulls = new Map(pullRequests.map((item) => [item.number, item]));
  if (issuePulls.length !== listedPulls.size)
    throw new BoardError('source_unstable');
  for (const item of issuePulls) {
    const pull = listedPulls.get(item.number);
    if (
      !pull ||
      sourceDigest(item) !==
        sourceDigest({
          id: pull.id,
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          updatedAt: pull.updatedAt,
        })
    )
      throw new BoardError('source_unstable');
  }
  const defaultBranch = branchItems.find(
    (item) => item.name === repository.defaultBranch,
  );
  if (!defaultBranch || defaultBranch.commit?.sha !== repository.defaultTip)
    throw new BoardError('source_unstable');
  await completeAll(
    pullRequests.map(async (pull) => {
      pull.closingIssues = await closingIssues(
        client,
        repository,
        pull,
        budget,
      );
    }),
  );
  const issueByNumber = new Map(issues.map((item) => [item.number, item]));
  const issueById = new Map(issues.map((item) => [item.id, item]));
  for (const pull of pullRequests)
    for (const target of pull.closingIssues) {
      if (target.repoId !== repository.id) continue;
      if (
        target.repo !== repository.fullName ||
        (issueByNumber.has(target.number) &&
          issueByNumber.get(target.number).id !== target.id) ||
        (issueById.has(target.id) &&
          issueById.get(target.id).number !== target.number)
      )
        throw new BoardError('source_unstable');
    }
  const labels = new Map(
    labelItems.map((item) => {
      const facts = labelFacts(item);
      return [facts.id, facts];
    }),
  );
  const milestones = new Map(
    milestoneItems.map((item) => {
      const facts = milestoneFacts(item);
      if (facts.state !== 'open') incomplete();
      return [facts.id, facts];
    }),
  );
  for (const issue of issues) {
    for (const label of issue.labels) joinFacts(labels, label);
    if (issue.milestone) joinFacts(milestones, issue.milestone);
  }
  unique([...milestones.values()], (item) => item.number);
  bounded([...labels], budget.limits.labels);
  bounded([...milestones], budget.limits.milestones);
  const comments = [];
  await completeAll(
    issues.map(async (issue) => {
      const values = await client.paginate(
        prefix + '/issues/' + issue.number + '/comments',
        { limit: budget.limits.comments },
      );
      if (values.length !== issue.comments)
        throw new BoardError('source_unstable');
      for (const value of values) {
        comments.push({
          id: positive(value.id),
          issue: issue.number,
          body: text(value.body),
          updatedAt: timestamp(value.updated_at),
        });
        bounded(comments, budget.limits.comments);
      }
    }),
  );
  unique(comments, (item) => item.id);
  const branches = await completeAll(
    branchItems.map((item) =>
      classifyBranch(client, repository, item, immutable.comparisons),
    ),
  );
  const prose = [...issues, ...pullRequests, ...comments]
    .map((item) => (item.title ?? '') + '\n' + (item.body ?? ''))
    .join('\n');
  const requested = referencesFrom(prose, repository);
  const reads = new Map();
  const references = await completeAll(
    requested.map((entry) =>
      resolveReference(client, repository, entry, reads),
    ),
  );
  let tree = immutable.trees.get(repository.defaultTip);
  if (!tree) {
    tree = await completeTree(client, repository, budget);
    immutable.trees.set(repository.defaultTip, tree);
  }
  const contextIssues = [...issues, ...comments];
  const selected = selectSourceFiles(tree, contextIssues, budget.limits);
  const fileKey =
    repository.defaultTip +
    ':' +
    sourceDigest(selected.selected.map((item) => item.path));
  let context = immutable.files.get(fileKey);
  if (!context) {
    context = await filesForTree(
      client,
      repository,
      tree,
      contextIssues,
      budget,
    );
    immutable.files.set(fileKey, context);
  }
  const finalRepository = await pinRepository(
    client,
    appId,
    ownerId,
    repositoryId,
    budget,
  );
  if (sourceDigest(repository) !== sourceDigest(finalRepository))
    throw new BoardError('source_unstable');
  return {
    repository,
    issues,
    pullRequests,
    milestones: [...milestones.values()],
    labels: [...labels.values()],
    branches,
    comments,
    references,
    tree,
    files: context.files,
    filePolicy: { excluded: context.excluded, unselected: context.unselected },
  };
}

function buildInventory(snapshot, sync) {
  const repo = snapshot.repository;
  const issues = [...snapshot.issues]
    .sort((a, b) => a.number - b.number)
    .map((issue) => {
      const prs = snapshot.pullRequests
        .filter((pull) =>
          pull.closingIssues.some(
            (target) =>
              target.repoId === repo.id &&
              target.repo === repo.fullName &&
              target.number === issue.number &&
              target.id === issue.id,
          ),
        )
        .sort((a, b) => a.number - b.number);
      const branch = snapshot.branches
        .filter(
          (item) =>
            item.unmerged === true &&
            item.name !== repo.defaultBranch &&
            new RegExp(
              '(?:^|[/_.-])' + issue.number + '(?:$|[/_.-])',
              'u',
            ).test(item.name),
        )
        .sort((a, b) => compareSourceKeys(a.name, b.name))[0];
      const label = issue.labels.some((item) =>
        /^in[\s_-]+progress$/iu.test(item.name),
      );
      return {
        number: issue.number,
        title: issue.title,
        milestone: issue.milestone?.title ?? null,
        inProgress: prs.length
          ? 'PR #' + prs[0].number
          : branch
            ? branch.name
            : label
              ? 'the in progress label'
              : null,
      };
    });
  const inventory = {
    board: 'backlog-triage',
    title: repo.name + ' backlog',
    repo: repo.fullName,
    sync,
    issues,
  };
  // Check freshly constructed inventory data against the core text/node bounds
  // without creating a provisional analysis report.
  let characters = 0;
  let nodes = 0;
  const pending = [inventory];
  while (pending.length) {
    const value = pending.pop();
    nodes += 1;
    if (typeof value === 'string') characters += value.length;
    else if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        characters += key.length;
        pending.push(entry);
      }
    }
    if (
      characters > REPORT_LIMITS.totalTextLength ||
      nodes > REPORT_LIMITS.nodes
    )
      throw new BoardError('source_limit_exceeded');
  }
  return inventory;
}

function summarize(snapshot, observedFrom, observedTo) {
  const sync = {
    at: observedTo,
    timeZone: 'UTC',
    branch: snapshot.repository.defaultBranch,
    commit: snapshot.repository.defaultTip,
    openPullRequests: snapshot.pullRequests.length,
  };
  const unverified = snapshot.references.filter(
    (entry) => entry.verification === 'unverified',
  ).length;
  const unknownBranches = snapshot.branches.filter(
    (entry) => entry.verification === 'unverified',
  ).length;
  const limitations = [
    'Matching observations are not an atomic GitHub snapshot.',
    'Unpushed local branches and worktrees are not visible to GitHub.',
  ];
  if (snapshot.filePolicy.excluded)
    limitations.push(
      'Credential, binary, generated, vendor, dependency, or oversized files are excluded.',
    );
  if (snapshot.filePolicy.unselected)
    limitations.push(
      'Repository file context uses a bounded deterministic selection.',
    );
  if (unverified)
    limitations.push(
      'External, unreadable, or unsupported references remain unverified.',
    );
  if (unknownBranches)
    limitations.push('Some remote branch ancestry is unverified.');
  const summary = {
    status: 'complete',
    repo: selection(snapshot.repository),
    sync,
    fingerprint: fingerprintSource(snapshot),
    provenance: {
      observedFrom,
      observedTo,
      consistency: 'two-pass-matched',
      inputs: [
        { name: 'core-inventory', status: 'complete' },
        { name: 'issue-comments', status: 'complete' },
        { name: 'repository-tree', status: 'complete' },
        {
          name: 'selected-file-context',
          status:
            snapshot.filePolicy.excluded || snapshot.filePolicy.unselected
              ? 'bounded'
              : 'complete',
        },
        { name: 'references', status: unverified ? 'unverified' : 'complete' },
        {
          name: 'branch-ancestry',
          status: unknownBranches ? 'unverified' : 'complete',
        },
      ],
      files: snapshot.files.map(({ path, blobId }) => ({ path, blobId })),
      references: {
        verified: snapshot.references.length - unverified,
        unverified,
      },
      limitations,
    },
    counts: {
      openIssues: snapshot.issues.length,
      openPullRequests: snapshot.pullRequests.length,
      milestones: snapshot.milestones.length,
      labels: snapshot.labels.length,
      branches: snapshot.branches.length,
      unmergedBranches: snapshot.branches.filter(
        (item) => item.unmerged === true,
      ).length,
      issueComments: snapshot.comments.length,
      treeEntries: snapshot.tree.length,
      selectedFiles: snapshot.files.length,
    },
  };
  return {
    summary,
    sourceSnapshot: { ...snapshot, inventory: buildInventory(snapshot, sync) },
  };
}

/** Raw provider context is returned only to the server caller, never serialized. */
export function createSourceOperations({
  appId,
  ownerId = OWNER_ID,
  fetchImpl = fetch,
  now = Date.now,
}) {
  if (!Number.isSafeInteger(appId) || appId < 1 || ownerId !== OWNER_ID)
    throw new BoardError('invalid_request');
  const prepare = (options) => {
    if (options.ownerId !== ownerId) throw new BoardError('forbidden');
    const budget =
      options.budget ?? createOperationBudget({ now, signal: options.signal });
    budget.assertActive();
    const client = createGithubClient({
      accessToken: options.accessToken,
      signal: options.signal,
      budget,
      fetchImpl,
    });
    return { client, budget };
  };
  return Object.freeze({
    async listRepositories(options) {
      const { client, budget } = prepare(options);
      const result = await listEligible(client, appId, ownerId, budget);
      return {
        repositories: result.repositories.map(selection),
        sourceAuthorization: result.sourceAuthorization,
      };
    },
    async checkRepository(options) {
      if (
        !Number.isSafeInteger(options.repositoryId) ||
        options.repositoryId < 1
      )
        throw new BoardError('invalid_request');
      const { client, budget } = prepare(options);
      const observedFrom = new Date(now()).toISOString();
      const immutable = {
        comparisons: new Map(),
        trees: new Map(),
        files: new Map(),
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const parameters = {
            appId,
            ownerId,
            repositoryId: options.repositoryId,
            budget,
            immutable,
          };
          const first = await gatherPass(client, parameters);
          const second = await gatherPass(client, parameters);
          if (
            fingerprintSource(first).value !== fingerprintSource(second).value
          )
            throw new BoardError('source_unstable');
          budget.assertActive();
          return summarize(second, observedFrom, new Date(now()).toISOString());
        } catch (error) {
          if (error.code !== 'source_unstable' || attempt !== 0) throw error;
        }
      }
      throw new BoardError('source_unstable');
    },
  });
}
