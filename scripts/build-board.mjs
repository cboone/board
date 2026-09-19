import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyStaticBuild } from './verify-fixture-build.js';

const fixtureRedirects = '/api/* /fixture-only.json 404\n/* /index.html 200\n';
const productionRedirects = '/* /index.html 200\n';

export function selectBuildMode(context, productionRequested) {
  return productionRequested === true && context === 'production'
    ? 'production'
    : 'fixture';
}

async function removeGenerated(directory) {
  try {
    await rm(directory, { recursive: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function copyRuntimeDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    assert(
      !/^\.env(?:\.|$)/.test(entry.name) &&
        !/\.(?:pem|key|p12|pfx)$/i.test(entry.name) &&
        entry.name !== 'node_modules',
      'Runtime staging cannot include environment files or dependencies.',
    );
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      await copyRuntimeDirectory(from, to);
    } else {
      assert(entry.isFile(), 'Runtime staging requires regular source files.');
      await copyFile(from, to);
    }
  }
}

async function installServer({ projectDirectory }) {
  await new Promise((accept, reject) => {
    const child = spawn('npm', ['ci', '--prefix', 'server'], {
      cwd: projectDirectory,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) accept();
      else reject(new Error('Server dependency installation failed.'));
    });
  });
}

async function buildFrontend({ projectDirectory, mode }) {
  const { build } = await import('vite');
  await build({
    root: projectDirectory,
    envDir: false,
    envPrefix: [],
    define: {
      'import.meta.env.VITE_BOARD_MODE': JSON.stringify(mode),
    },
    build: { manifest: true },
  });
}

export async function composeBuild({
  projectDirectory,
  context,
  productionRequested = false,
  installServer: install = installServer,
  buildFrontend: build = buildFrontend,
}) {
  const project = resolve(projectDirectory);
  const generated = resolve(project, 'server/.generated');
  const publishDirectory = resolve(project, 'dist');
  const functionsDirectory = resolve(generated, 'server/functions');
  const mode = selectBuildMode(context, productionRequested);
  await removeGenerated(generated);
  try {
    if (mode === 'production') {
      await install({ projectDirectory: project });
      for (const directory of [
        'server/functions',
        'server/lib',
        'src/domain',
      ]) {
        await copyRuntimeDirectory(
          resolve(project, directory),
          resolve(generated, directory),
        );
      }
      assert(
        (await readdir(functionsDirectory)).includes('api.mjs'),
        'Production composition requires the authored API entry.',
      );
    }
    await build({ projectDirectory: project, mode });
    await writeFile(
      resolve(publishDirectory, '_redirects'),
      mode === 'production' ? productionRedirects : fixtureRedirects,
    );
    await verifyStaticBuild(publishDirectory, { mode });
    return { mode, publishDirectory, functionsDirectory };
  } catch (error) {
    await removeGenerated(generated);
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const arguments_ = process.argv.slice(2);
  assert(arguments_.every((value) => value === '--production'));
  composeBuild({
    projectDirectory: resolve(import.meta.dirname, '..'),
    context: process.env.CONTEXT,
    productionRequested: arguments_.includes('--production'),
  }).then(
    ({ mode }) => process.stdout.write(`Built ${mode} Board application.\n`),
    () => {
      process.stderr.write('Board build did not complete.\n');
      process.exitCode = 1;
    },
  );
}
