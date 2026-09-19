import { createHash } from 'node:crypto';

/** Object order is insignificant; collection order is normalized by its owner. */
export function canonicalStringify(value) {
  if (Array.isArray(value))
    return '[' + value.map(canonicalStringify).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ':' + canonicalStringify(value[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

export function sourceDigest(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

export function compareSourceKeys(left, right) {
  const first = String(left);
  const second = String(right);
  return first < second ? -1 : first > second ? 1 : 0;
}
const ordered = (values, key) =>
  [...values].sort((a, b) => compareSourceKeys(key(a), key(b)));

/** Hash only covered canonical source facts, excluding observation timestamps. */
export function sourceManifest(snapshot) {
  return {
    repository: snapshot.repository,
    issues: ordered(snapshot.issues, (item) => item.id).map((item) => ({
      ...item,
      labels: ordered(item.labels, (label) => label.id),
      assignees: [...item.assignees].sort((left, right) => left.id - right.id),
    })),
    pullRequests: ordered(snapshot.pullRequests, (item) => item.id).map(
      (item) => ({
        ...item,
        closingIssues: ordered(
          item.closingIssues,
          (issue) => issue.repoId + ':' + issue.id,
        ),
      }),
    ),
    milestones: ordered(snapshot.milestones, (item) => item.id),
    labels: ordered(snapshot.labels, (item) => item.id),
    branches: ordered(snapshot.branches, (item) => item.name),
    comments: ordered(snapshot.comments, (item) => item.issue + ':' + item.id),
    references: ordered(snapshot.references, (item) => item.key),
    tree: ordered(snapshot.tree ?? [], (item) => item.path),
    files: ordered(snapshot.files ?? [], (item) => item.path).map(
      ({ path, blobId }) => ({ path, blobId }),
    ),
  };
}

export function fingerprintSource(snapshot) {
  return {
    algorithm: 'sha256',
    value: sourceDigest(sourceManifest(snapshot)),
    scope: 'core-and-collected-context',
  };
}
