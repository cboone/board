import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalStringify,
  fingerprintSource,
  sourceManifest,
} from '../lib/fingerprint.mjs';

function source() {
  return {
    repository: { id: 7, defaultTip: 'a'.repeat(40) },
    issues: [
      {
        id: 2,
        body: 'Original body',
        labels: [{ id: 4 }, { id: 3 }],
        createdAt: '2026-09-02T00:00:00Z',
        assignees: [
          { id: 10, login: 'second' },
          { id: 2, login: 'first' },
        ],
      },
      {
        id: 1,
        labels: [],
        createdAt: '2026-09-01T00:00:00Z',
        assignees: [],
      },
    ],
    pullRequests: [
      {
        id: 6,
        closingIssues: [
          { id: 2, repoId: 7 },
          { id: 1, repoId: 7 },
        ],
      },
    ],
    milestones: [{ id: 2 }, { id: 1 }],
    labels: [{ id: 4 }, { id: 3 }],
    branches: [
      { name: 'z', tip: 'b' },
      { name: 'a', tip: 'a' },
    ],
    comments: [
      { issue: 1, id: 1, body: 'Original comment', updatedAt: 'same' },
    ],
    references: [
      {
        key: '7:item:99',
        verification: 'verified',
        facts: { state: 'closed', stateReason: 'completed' },
      },
    ],
    tree: [
      { path: 'z', sha: 'b' },
      { path: 'a', sha: 'a' },
    ],
    files: [{ path: 'README.md', blobId: 'c', content: 'Text' }],
  };
}
test('canonical hashing is independent of property and pagination order', () => {
  assert.equal(
    canonicalStringify({ z: 1, a: 2 }),
    canonicalStringify({ a: 2, z: 1 }),
  );
  const original = source();
  const reordered = structuredClone(original);
  for (const key of [
    'issues',
    'pullRequests',
    'milestones',
    'labels',
    'branches',
    'comments',
    'references',
    'tree',
    'files',
  ])
    reordered[key].reverse();
  reordered.issues.find((issue) => issue.id === 2).labels.reverse();
  reordered.issues.find((issue) => issue.id === 2).assignees.reverse();
  reordered.pullRequests[0].closingIssues.reverse();
  assert.deepEqual(fingerprintSource(original), fingerprintSource(reordered));
  assert.deepEqual(
    sourceManifest(original)
      .issues.find((issue) => issue.id === 2)
      .assignees.map((assignee) => assignee.id),
    [2, 10],
  );
  assert.match(fingerprintSource(original).value, /^[a-f\d]{64}$/u);
});
test('issue creation and assignment facts are part of freshness coverage', () => {
  for (const change of [
    (snapshot) => {
      snapshot.issues[0].createdAt = '2026-08-31T00:00:00Z';
    },
    (snapshot) => {
      snapshot.issues[0].assignees[0].login = 'renamed';
    },
    (snapshot) => {
      snapshot.issues[0].assignees = [];
    },
  ]) {
    const original = source();
    const edited = structuredClone(original);
    change(edited);
    assert.notEqual(
      fingerprintSource(original).value,
      fingerprintSource(edited).value,
    );
  }
});
test('actual issue/comment text changes hash even with unchanged timestamps and default SHA', () => {
  for (const change of [
    (snapshot) => {
      snapshot.issues[0].body = 'Edited body';
    },
    (snapshot) => {
      snapshot.comments[0].body = 'Edited comment';
    },
    (snapshot) => {
      snapshot.comments = [];
    },
  ]) {
    const original = source();
    const edited = structuredClone(original);
    change(edited);
    assert.notEqual(
      fingerprintSource(original).value,
      fingerprintSource(edited).value,
    );
  }
});
test('closed target facts and access outcomes are part of freshness coverage', () => {
  for (const change of [
    (snapshot) => {
      snapshot.references[0].facts.stateReason = 'not_planned';
    },
    (snapshot) => {
      snapshot.references[0].facts = {
        type: 'pull',
        state: 'closed',
        merged: true,
        mergeSha: 'a',
      };
    },
    (snapshot) => {
      snapshot.references[0] = {
        key: '7:item:99',
        verification: 'unverified',
        reason: 'not-readable',
      };
    },
  ]) {
    const original = source();
    const edited = structuredClone(original);
    change(edited);
    assert.notEqual(
      fingerprintSource(original).value,
      fingerprintSource(edited).value,
    );
  }
});
test('pinned file identities hash without observation times or raw file allocation', () => {
  const original = source();
  const sameBlob = structuredClone(original);
  sameBlob.files[0].content =
    'Not fingerprinted separately from immutable blob identity';
  sameBlob.observedAt = 'later';
  assert.equal(
    fingerprintSource(original).value,
    fingerprintSource(sameBlob).value,
  );
  sameBlob.files[0].blobId = 'different';
  assert.notEqual(
    fingerprintSource(original).value,
    fingerprintSource(sameBlob).value,
  );
});
test('tree blob identities retain freshness coverage for omitted file content', () => {
  const original = source();
  original.files = [];
  const changedBlob = structuredClone(original);
  changedBlob.tree[0].sha = 'changed';
  assert.notEqual(
    fingerprintSource(original).value,
    fingerprintSource(changedBlob).value,
  );
});
test('distinct canonically equivalent Unicode names use a deterministic total order', () => {
  const original = source();
  original.branches = [
    { name: '1-é', tip: 'a' },
    { name: '1-e\u0301', tip: 'b' },
  ];
  original.tree = [
    { path: 'é/file', sha: 'a' },
    { path: 'e\u0301/file', sha: 'b' },
  ];
  const reordered = structuredClone(original);
  reordered.branches.reverse();
  reordered.tree.reverse();
  assert.equal(
    fingerprintSource(original).value,
    fingerprintSource(reordered).value,
  );
});
