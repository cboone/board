import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const forbiddenSource =
  /ANTHROPIC_API_KEY|GITHUB_APP_CLIENT_SECRET|GITHUB_CLIENT_SECRET|BOARD_(?:PREVIOUS_)?TOKEN_ENCRYPTION_KEY|@netlify\/(?:blobs|database)/;

export async function verifyStaticBuild(
  publishDirectory,
  { mode = 'fixture', forbiddenValues = [] } = {},
) {
  assert(
    ['fixture', 'production'].includes(mode),
    'Unknown browser build mode.',
  );
  const publish = resolve(publishDirectory);
  const requiredFiles = ['index.html', '_headers', '_redirects'];
  for (const file of requiredFiles) {
    await readFile(resolve(publish, file));
  }

  const entries = await readdir(publish, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    assert(
      !/^\.env(?:\.|$)/.test(entry.name),
      'Environment files must not enter the static publish directory.',
    );
    assert(
      !['functions', 'server', 'node_modules', '.netlify'].includes(entry.name),
      'Server directories must not enter the static publish directory.',
    );
    if (entry.isDirectory()) continue;
    assert(
      entry.isFile(),
      'The publish directory must contain regular static files only.',
    );
    const file = resolve(entry.parentPath, entry.name);
    const content = await readFile(file, 'utf8');
    assert(
      !forbiddenSource.test(content) &&
        forbiddenValues.every((value) => !content.includes(value)),
      'Server credentials or storage clients must not enter browser assets: ' +
        relative(publish, file),
    );
  }

  const html = await readFile(resolve(publish, 'index.html'), 'utf8');
  assert(
    !/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html),
    'Built HTML must not contain inline scripts.',
  );
  assert(
    !/<style\b|\sstyle=|https:\/\/fonts\./i.test(html),
    'Built HTML must use external local styling and system fonts.',
  );
  assert(
    !/\bsrc=["']https?:/i.test(html),
    'Built HTML must not load remote scripts or assets.',
  );

  const headers = await readFile(resolve(publish, '_headers'), 'utf8');
  assert(
    headers.includes("script-src 'self'") &&
      headers.includes("style-src 'self'"),
    'The CSP must restrict scripts and styles to local assets.',
  );
  assert(
    !headers.includes("'unsafe-inline'") && !headers.includes("'unsafe-eval'"),
    'The CSP must not permit inline scripts or eval.',
  );
  assert(
    headers.includes("frame-ancestors 'none'") &&
      headers.includes('X-Content-Type-Options: nosniff'),
    'Security headers must be present.',
  );

  const redirects = await readFile(resolve(publish, '_redirects'), 'utf8');
  const lines = redirects.trim().split('\n');
  if (mode === 'fixture') {
    assert.equal(lines[0], '/api/* /fixture-only.json 404');
    assert.equal(lines[1], '/* /index.html 200');
    const response = JSON.parse(
      await readFile(resolve(publish, 'fixture-only.json'), 'utf8'),
    );
    assert.equal(response.error.code, 'fixture_only');
    assert.equal(response.error.retryable, false);
  } else {
    assert.deepEqual(lines, ['/* /index.html 200']);
  }

  const manifest = JSON.parse(
    await readFile(resolve(publish, '.vite/manifest.json'), 'utf8'),
  );
  if (mode === 'fixture') {
    assert(
      Object.keys(manifest).every((path) => !path.startsWith('src/app/')),
      'Fixture builds must not contain the production application graph.',
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  verifyStaticBuild(resolve(import.meta.dirname, '../dist'), {
    mode: process.argv.includes('--production') ? 'production' : 'fixture',
  }).then(
    () => process.stdout.write('Static Board build verified.\n'),
    (error) => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    },
  );
}
