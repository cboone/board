import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_VERBATIM_POLICY_V1,
  SOURCE_SAFETY_POLICY_V1,
  assertNoVerbatimOutput,
  assertSourceSafe,
  createNoVerbatimCorpus,
  inspectSourceSafety,
  isDocumentedPlaceholder,
  normalizeNoVerbatimField,
  normalizeNoVerbatimLines,
} from '../lib/source-safety.mjs';

test('source safety policy is versioned, frozen, and uses bounded patterns', () => {
  assert.equal(SOURCE_SAFETY_POLICY_V1.version, 'source-safety-v1');
  assert.ok(Object.isFrozen(SOURCE_SAFETY_POLICY_V1));
  assert.ok(Object.isFrozen(SOURCE_SAFETY_POLICY_V1.rules));
  assert.equal(SOURCE_SAFETY_POLICY_V1.maximumMatchLength, 4096);
  for (const rule of SOURCE_SAFETY_POLICY_V1.rules)
    assert.doesNotMatch(rule.source, /(?:\*|\+)\??/u);
});

test('source safety recognizes each fixed credential rule without exposing text', () => {
  const examples = new Map([
    ['pem-private-key-header', '-----BEGIN PRIVATE KEY-----'],
    ['github-credential-prefix', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
    ['anthropic-credential-prefix', 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    ['openai-credential-prefix', 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    ['slack-credential-prefix', 'xoxb-1234567890-ABCDEFGHIJ'],
    ['aws-access-key-prefix', 'AKIAABCDEFGHIJKLMNOP'],
    [
      'url-authority-credential',
      'https://synthetic-user:synthetic-password@example.invalid/path',
    ],
    ['credential-assignment-or-header', 'API_KEY=synthetic-value'],
  ]);
  for (const [ruleId, value] of examples) {
    const result = inspectSourceSafety(value);
    assert.equal(result.safe, false, ruleId);
    assert.ok(
      result.matches.some((match) => match.ruleId === ruleId),
      ruleId,
    );
    assert.doesNotMatch(JSON.stringify(result), /synthetic|ABC|123456/u);
  }
});

test('assignment placeholders are narrowly and deterministically accepted', () => {
  for (const value of [
    '',
    'example',
    'TEST',
    'dummy',
    'redacted',
    'changeme',
    'xxxx',
    '********',
    '<YOUR_API_KEY>',
    '$API_KEY',
    '${API_KEY}',
    '%API_KEY%',
    'process.env.API_KEY',
  ]) {
    assert.equal(isDocumentedPlaceholder(value), true, value);
    assert.equal(inspectSourceSafety(`api_key="${value}"`).safe, true, value);
  }
  for (const value of ['xxx', 'real-value', '<>', '<'.padEnd(130, 'x') + '>'])
    assert.equal(isDocumentedPlaceholder(value), false, value);
});

test('mandatory safety errors retain only safe identifiers and counts', () => {
  const unsafe = 'authorization=synthetic-sensitive-value';
  assert.throws(
    () => assertSourceSafe(unsafe),
    (error) => {
      assert.equal(error.code, 'analysis_sensitive_input');
      assert.deepEqual(error.details.ruleIds, [
        'credential-assignment-or-header',
      ]);
      assert.equal(error.details.count, 1);
      assert.doesNotMatch(JSON.stringify(error), /synthetic-sensitive/u);
      assert.doesNotMatch(error.message, /synthetic-sensitive/u);
      return true;
    },
  );
});

test('no-verbatim normalization follows the pinned ordered operations', () => {
  assert.equal(NO_VERBATIM_POLICY_V1.runtime, 'node-24.13.0');
  assert.equal(NO_VERBATIM_POLICY_V1.unicodeVersion, '16.0');
  assert.deepEqual(normalizeNoVerbatimLines(' E\u0301\r\nA\t B\rC\u00a0D '), [
    'é',
    'a b',
    'c d',
  ]);
  assert.equal(
    normalizeNoVerbatimField(' E\u0301\r\nA\t B\rC\u00a0D '),
    'é a b c d',
  );
});

test('no-verbatim rejects exact fields and the 31/32 line boundary', () => {
  const exact = createNoVerbatimCorpus(['Tiny raw fact']);
  assert.throws(() => assertNoVerbatimOutput(['tiny RAW fact'], exact), {
    code: 'analysis_output_invalid',
  });

  const line31 = 'a'.repeat(31);
  const line32 = 'b'.repeat(32);
  const corpus = createNoVerbatimCorpus([line31, line32]);
  assert.equal(
    assertNoVerbatimOutput([`prefix ${line31} suffix`], corpus),
    true,
  );
  assert.throws(
    () => assertNoVerbatimOutput([`prefix ${line32} suffix`], corpus),
    (error) => {
      assert.deepEqual(error.details.ruleIds, ['no-verbatim-source-line']);
      return true;
    },
  );
});

test('no-verbatim rejects the 64-code-point window and permits 63', () => {
  const source = [
    ...Array.from({ length: 64 }, (_, index) =>
      String.fromCodePoint(0x1f600 + (index % 32)),
    ),
  ].join('');
  const corpus = createNoVerbatimCorpus([`before ${source} after`]);
  const first63 = [...source].slice(0, 63).join('');
  assert.equal(assertNoVerbatimOutput([first63], corpus), true);
  assert.throws(() => assertNoVerbatimOutput([source], corpus), {
    code: 'analysis_output_invalid',
  });
});

test('canonical and prior prose stay exempt unless explicitly added to corpus', () => {
  const corpus = createNoVerbatimCorpus(['Raw source evidence only']);
  assert.equal(
    assertNoVerbatimOutput(
      ['Canonical title', 'Previously accepted analysis'],
      corpus,
    ),
    true,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(corpus)), {});
});

test('output safety applies regardless of credential match length', () => {
  const corpus = createNoVerbatimCorpus([]);
  assert.throws(
    () => assertNoVerbatimOutput(['password=q'], corpus),
    (error) => {
      assert.equal(error.code, 'analysis_output_invalid');
      assert.deepEqual(error.details.ruleIds, ['no-verbatim-output-safety']);
      assert.doesNotMatch(JSON.stringify(error), /password=q/u);
      return true;
    },
  );
});
