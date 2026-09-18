const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const PROSE_REFERENCE = /([\w.-]+\/[\w.-]+)?#(\d+)(?![\w#])/g;

/** Only source links with an HTTPS destination may reach an anchor. */
export function safeUrl(value) {
  if (
    typeof value !== 'string' ||
    !/^https:\/\//i.test(value) ||
    /[\s\\"<>]/.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function repositoryPath(value) {
  if (!REPOSITORY.test(value)) return null;
  const parts = value.split('/');
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.map(encodeURIComponent).join('/');
}

function branchPath(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.map(encodeURIComponent).join('/');
}

function issueNumber(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? String(Number(value))
    : null;
}

/** Build source URLs without treating branch names or queries as URL syntax. */
export function createSourceLinks(report) {
  const path = repositoryPath(report.repo);
  const fallback = path ? `https://github.com/${path}` : null;
  let repository = safeUrl(report.repoUrl) || fallback;
  repository = repository?.replace(/\/+$/, '') ?? null;
  const suffix = path ? `/${path}` : null;
  const base =
    repository && suffix && repository.endsWith(suffix)
      ? repository.slice(0, -suffix.length)
      : 'https://github.com';
  const issue = (number) => {
    const n = issueNumber(number);
    return repository && n ? `${repository}/issues/${n}` : null;
  };
  const pull = (number) => {
    const n = issueNumber(number);
    return repository && n ? `${repository}/pull/${n}` : null;
  };
  const search = (query) =>
    repository
      ? `${repository}/issues?q=${encodeURIComponent(String(query))}`
      : null;
  const milestone = (title) => {
    const quoted = `"${String(title).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return search(
      title ? `is:open milestone:${quoted}` : 'is:open no:milestone',
    );
  };
  const branch = (name) => {
    const value = branchPath(name);
    return repository && value ? `${repository}/tree/${value}` : null;
  };
  const compare = (name) => {
    const from = branchPath(report.sync.branch);
    const to = branchPath(name);
    return repository && from && to
      ? `${repository}/compare/${from}...${to}`
      : null;
  };
  const crossIssue = (reference) => {
    if (typeof reference !== 'string') return null;
    const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(reference);
    if (!match) return null;
    const repo = repositoryPath(match[1]);
    const number = issueNumber(match[2]);
    return repo && number ? `${base}/${repo}/issues/${number}` : null;
  };
  const progress = (where) => {
    if (typeof where !== 'string') return null;
    const pr = /^PR #(\d+)$/.exec(where);
    if (pr) return pull(pr[1]);
    return /^\S+$/.test(where) ? compare(where) : null;
  };
  const reference = (value) => {
    if (typeof value === 'number') return issue(value);
    if (!value || typeof value !== 'object') return null;
    if (value.pr != null) return pull(value.pr);
    if (value.branch != null) return compare(value.branch);
    if (value.ref != null) return crossIssue(value.ref);
    return safeUrl(value.url);
  };
  const commit = (sha) =>
    repository && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha)
      ? `${repository}/commit/${sha}`
      : null;
  return {
    repository,
    issue,
    pull,
    search,
    milestone,
    branch,
    compare,
    crossIssue,
    progress,
    reference,
    commit,
  };
}

/** Return text and link descriptors; callers construct text nodes themselves. */
export function proseReferences(text, links) {
  const source = String(text ?? '');
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(PROSE_REFERENCE)) {
    const before = source[match.index - 1];
    if (before && /[\w&/]/.test(before)) continue;
    const head = source.slice(0, match.index);
    if (/:\/\//.test(head.slice(head.search(/\S*$/)))) continue;
    const href = match[1]
      ? links.crossIssue(match[0])
      : links.issue(Number(match[2]));
    if (!href) continue;
    parts.push(source.slice(last, match.index));
    parts.push({ href, text: match[0] });
    last = match.index + match[0].length;
  }
  parts.push(source.slice(last));
  return parts;
}
