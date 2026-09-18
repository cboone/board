import { describe, expect, it } from 'vitest';

import {
  createSourceLinks,
  proseReferences,
  safeUrl,
} from '../../src/report/links.js';

const report = {
  repo: 'example/widgets',
  sync: { branch: 'release/next#1' },
};

describe('source links', () => {
  const links = createSourceLinks(report);

  it.each([40, 64])('links a full %i-character commit SHA', (length) => {
    const sha = 'a'.repeat(length);
    expect(links.commit(sha)).toBe(
      `https://github.com/example/widgets/commit/${sha}`,
    );
  });

  it.each(['abcdef12', 'a'.repeat(41), 'z'.repeat(40)])(
    'rejects malformed commit %s',
    (sha) => {
      expect(links.commit(sha)).toBeNull();
    },
  );

  it('encodes branch syntax while keeping branch path separators', () => {
    expect(links.branch('feature/name#4?tab=1')).toBe(
      'https://github.com/example/widgets/tree/feature/name%234%3Ftab%3D1',
    );
    expect(links.compare('feature/encoded%2Fsegment')).toBe(
      'https://github.com/example/widgets/compare/release/next%231...feature/encoded%252Fsegment',
    );
  });

  it.each(['../main', 'feature/./name', 'feature/../name', ''])(
    'rejects branch traversal %s',
    (branch) => {
      expect(links.branch(branch)).toBeNull();
      expect(links.compare(branch)).toBeNull();
    },
  );

  it('quotes milestone qualifier values before encoding the search query', () => {
    const url = new URL(links.milestone('Release "next" \\ adapter'));
    expect(url.searchParams.get('q')).toBe(
      'is:open milestone:"Release \\"next\\" \\\\ adapter"',
    );
    expect(new URL(links.milestone(null)).searchParams.get('q')).toBe(
      'is:open no:milestone',
    );
    expect(
      new URL(links.search('is:open label:"a&b" #3')).searchParams.get('q'),
    ).toBe('is:open label:"a&b" #3');
  });

  it('keeps cross-repository sources under the repository hosting prefix', () => {
    const enterprise = createSourceLinks({
      ...report,
      repoUrl: 'https://git.example.com/enterprise/example/widgets/',
    });
    expect(enterprise.crossIssue('other/package#17')).toBe(
      'https://git.example.com/enterprise/other/package/issues/17',
    );
    expect(enterprise.crossIssue('../package#17')).toBeNull();
    expect(enterprise.crossIssue('other/..#17')).toBeNull();
  });

  it('links all reference forms and leaves progress labels as plain text', () => {
    expect(links.reference(12)).toBe(
      'https://github.com/example/widgets/issues/12',
    );
    expect(links.reference({ pr: 90 })).toBe(
      'https://github.com/example/widgets/pull/90',
    );
    expect(links.reference({ branch: 'feature/api' })).toBe(
      'https://github.com/example/widgets/compare/release/next%231...feature/api',
    );
    expect(links.reference({ ref: 'other/package#17' })).toBe(
      'https://github.com/other/package/issues/17',
    );
    expect(
      links.reference({
        url: 'https://example.com/design#next',
        label: 'Design',
      }),
    ).toBe('https://example.com/design#next');
    expect(links.progress('PR #90')).toBe(
      'https://github.com/example/widgets/pull/90',
    );
    expect(links.progress('the in progress label')).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'http://example.com',
    'https://user:password@example.com',
    'https://example.com\\@other.example',
    'https://example.com/<script>',
    'https://example.com/next page',
  ])('suppresses unsafe anchor destination %s', (url) => {
    expect(safeUrl(url)).toBeNull();
    expect(links.reference({ url })).toBeNull();
  });

  it('links issue references in prose while preserving language and URL fragments', () => {
    const source =
      'Start #12 after other/package#17. C#1 and https://example.com/other/package#3 remain text; ../package#4 remains text.';
    const parts = proseReferences(source, links);
    expect(parts.filter((part) => typeof part !== 'string')).toEqual([
      { href: 'https://github.com/example/widgets/issues/12', text: '#12' },
      {
        href: 'https://github.com/other/package/issues/17',
        text: 'other/package#17',
      },
    ]);
    expect(
      parts
        .map((part) => (typeof part === 'string' ? part : part.text))
        .join(''),
    ).toBe(source);
  });

  it.each([
    'path/other/package#17',
    '/other/package#17',
    'path/#17',
    '&other/package#17',
    '&#17',
  ])('leaves embedded reference %s as plain text', (source) => {
    expect(proseReferences(source, links)).toEqual([source]);
  });

  it('links standalone cross-repository references next to punctuation', () => {
    const source = '(other/package#17), then other/package#18.';
    expect(proseReferences(source, links)).toEqual([
      '(',
      {
        href: 'https://github.com/other/package/issues/17',
        text: 'other/package#17',
      },
      '), then ',
      {
        href: 'https://github.com/other/package/issues/18',
        text: 'other/package#18',
      },
      '.',
    ]);
  });
});
