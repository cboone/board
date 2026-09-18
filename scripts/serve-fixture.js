import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const projectDirectory = resolve(import.meta.dirname, '..');
const publishDirectory = resolve(projectDirectory, 'dist');
const sourceDirectory = resolve(projectDirectory, 'src');
const port = Number(process.env.BOARD_DEV_PORT || '4173');
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('The static test server requires a valid loopback port.');
}
const redirects = await readFile(
  resolve(publishDirectory, '_redirects'),
  'utf8',
);
const fixtureApi = redirects.startsWith('/api/* /fixture-only.json 404\n');
const fixtureResponse = fixtureApi
  ? await readFile(resolve(publishDirectory, 'fixture-only.json'))
  : null;

const headerFile = await readFile(
  resolve(publishDirectory, '_headers'),
  'utf8',
);
const headerLines = headerFile.trim().split('\n');
if (headerLines.shift() !== '/*') {
  throw new Error(
    'The fixture server requires one global Netlify header rule.',
  );
}
const headers = Object.fromEntries(
  headerLines.map((line) => {
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error('Unexpected Netlify header syntax.');
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }),
);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function within(directory, path) {
  const candidate = resolve(directory, '.' + path);
  return candidate.startsWith(directory + sep) ? candidate : null;
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers))
    response.setHeader(key, value);
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, 'http://127.0.0.1').pathname,
    );
    if (fixtureApi && pathname.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response
        .writeHead(404)
        .end(request.method === 'HEAD' ? undefined : fixtureResponse);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    // These source modules support renderer rejection tests only. This server
    // and its test routes are never part of the Netlify publish directory.
    const sourcePath = pathname.startsWith('/__test__/')
      ? pathname.slice('/__test__'.length)
      : null;
    const sourceModule =
      sourcePath && /^\/(report|domain)\/[a-z-]+\.js$/.test(sourcePath);
    let file = sourceModule
      ? within(sourceDirectory, sourcePath)
      : within(publishDirectory, pathname);
    let exists =
      file &&
      (await stat(file)
        .then((info) => info.isFile())
        .catch(() => false));
    if (!exists && !sourcePath && !extname(pathname)) {
      file = resolve(publishDirectory, 'index.html');
      exists = true;
    }
    if (!exists || (sourcePath && !sourceModule)) {
      response.writeHead(404).end();
      return;
    }
    const body = await readFile(file);
    response.setHeader(
      'Content-Type',
      contentTypes[extname(file)] ?? 'application/octet-stream',
    );
    response.writeHead(200).end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(400).end();
  }
});

server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
