import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const publishDirectory = resolve(import.meta.dirname, '../dist');
const requiredFiles = ['index.html', '_headers', '_redirects'];
for (const file of requiredFiles) {
  await readFile(resolve(publishDirectory, file));
}

const entries = await readdir(publishDirectory, {
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
    'The fixture publish directory must contain regular static files only.',
  );
  const file = resolve(entry.parentPath, entry.name);
  const content = await readFile(file, 'utf8');
  assert(
    !/ANTHROPIC_API_KEY|GITHUB_APP_CLIENT_SECRET|GITHUB_CLIENT_SECRET|BOARD_TOKEN_ENCRYPTION_KEY|@netlify\/(?:blobs|database)/.test(
      content,
    ),
    'Server credentials or storage clients must not enter browser assets: ' +
      relative(publishDirectory, file),
  );
}

const html = await readFile(resolve(publishDirectory, 'index.html'), 'utf8');
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

const headers = await readFile(resolve(publishDirectory, '_headers'), 'utf8');
assert(
  headers.includes("script-src 'self'") && headers.includes("style-src 'self'"),
  'The fixture CSP must restrict scripts and styles to local assets.',
);
assert(
  !headers.includes("'unsafe-inline'") && !headers.includes("'unsafe-eval'"),
  'The fixture CSP must not permit inline scripts or eval.',
);
assert(
  headers.includes("frame-ancestors 'none'") &&
    headers.includes('X-Content-Type-Options: nosniff'),
  'Fixture security headers must be present.',
);

process.stdout.write('Fixture build verified.\n');
