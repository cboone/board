import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { composeBuild } from '../../scripts/build-board.mjs';
import { verifyStaticBuild } from '../../scripts/verify-fixture-build.js';

const project = resolve(import.meta.dirname, '../..');
const composerUrl = pathToFileURL(
  resolve(project, 'scripts/build-board.mjs'),
).href;
const verifierUrl = pathToFileURL(
  resolve(project, 'scripts/verify-fixture-build.js'),
).href;
const secretSentinel = 'synthetic-client-secret-composition-only';
const providerSentinel = 'synthetic-provider-key-composition-only';
const keySentinel = Buffer.alloc(32, 7).toString('base64');
const html =
  '<!doctype html><html><head><title>Composition sample</title></head><body><script type="module" src="/src/main.js"></script></body></html>\n';

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'board-composition-'));
  t.after(() => rm(directory, { recursive: true }));
  await mkdir(resolve(directory, 'public'), { recursive: true });
  await mkdir(resolve(directory, 'src/app'), { recursive: true });
  await writeFile(
    resolve(directory, 'package.json'),
    JSON.stringify({ type: 'module' }),
  );
  await writeFile(resolve(directory, 'index.html'), html);
  await writeFile(
    resolve(directory, 'src/main.js'),
    "if (import.meta.env.VITE_BOARD_MODE === 'production') { import('./app/production.js').then(({mountProduction}) => mountProduction()); } else { document.body.dataset.mode = 'fixture'; }\n",
  );
  await writeFile(
    resolve(directory, 'src/app/production.js'),
    "export function mountProduction() { document.body.dataset.mode = '/api/session'; }\n",
  );
  for (const file of ['_headers', '_redirects', 'fixture-only.json']) {
    await cp(
      resolve(project, 'public', file),
      resolve(directory, 'public', file),
    );
  }
  return directory;
}

async function staticBuild({ projectDirectory }) {
  const dist = resolve(projectDirectory, 'dist');
  await mkdir(resolve(dist, '.vite'), { recursive: true });
  await writeFile(resolve(dist, 'index.html'), html);
  await writeFile(resolve(dist, '.vite/manifest.json'), '{}');
  for (const file of ['_headers', 'fixture-only.json']) {
    await cp(resolve(projectDirectory, 'public', file), resolve(dist, file));
  }
}

async function fakeRuntime(directory) {
  await mkdir(resolve(directory, 'server/functions'), { recursive: true });
  await mkdir(resolve(directory, 'server/lib'), { recursive: true });
  await cp(resolve(project, 'src/domain'), resolve(directory, 'src/domain'), {
    recursive: true,
  });
  await writeFile(
    resolve(directory, 'server/lib/shared.mjs'),
    "export { REPORT_LIMITS } from '../../src/domain/report-contract.js';\n",
  );
  await writeFile(
    resolve(directory, 'server/functions/api.mjs'),
    "import { REPORT_LIMITS } from '../lib/shared.mjs'; export default function() { return Response.json({limit:REPORT_LIMITS.issues}); }\n",
  );
  await writeFile(
    resolve(directory, 'server/functions/report-job.mjs'),
    'export const config={background:true}; export default function() { return new Response(null,{status:204}); }\n',
  );
}

function childRun(directory, source, context = 'production') {
  const runner = resolve(directory, 'runner.mjs');
  return writeFile(runner, source).then(() => {
    const result = spawnSync(process.execPath, [runner], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        CONTEXT: context,
        VITE_BOARD_MODE: 'production',
        BOARD_APP_ORIGIN: 'https://tracker-boards.netlify.app',
        BOARD_OWNER_ID: '99961',
        GITHUB_APP_ID: '4995264',
        GITHUB_APP_CLIENT_ID: 'Iv23liQyjqNGXrULGeSB',
        GITHUB_APP_CLIENT_SECRET: secretSentinel,
        BOARD_TOKEN_KEY_ID: 'synthetic-test-key',
        BOARD_TOKEN_ENCRYPTION_KEY: keySentinel,
        ANTHROPIC_API_KEY: providerSentinel,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const value of [secretSentinel, providerSentinel, keySentinel]) {
      assert(!result.stdout.includes(value) && !result.stderr.includes(value));
    }
  });
}

test('fixture builds remove generated Functions and never install a server for unsupported contexts', async (t) => {
  const directory = await fixture(t);
  for (const [context, productionRequested] of [
    [undefined, true],
    ['', true],
    ['deploy-preview', true],
    ['branch-deploy', true],
    ['dev', true],
    ['unknown', true],
    ['Production', true],
    ['production', false],
  ]) {
    const stale = resolve(directory, 'server/.generated/server/functions');
    await mkdir(stale, { recursive: true });
    await writeFile(resolve(stale, 'stale.mjs'), 'synthetic stale function');
    const result = await composeBuild({
      projectDirectory: directory,
      context,
      productionRequested,
      installServer: () => {
        assert.fail('Fixture context invoked server installation.');
      },
      buildFrontend: staticBuild,
    });
    assert.equal(result.mode, 'fixture');
    await assert.rejects(access(resolve(directory, 'server/.generated')), {
      code: 'ENOENT',
    });
  }
});

test('actual Vite builds ignore env files and external mode flags and remove the production graph', async (t) => {
  const directory = await fixture(t);
  await fakeRuntime(directory);
  await writeFile(
    resolve(directory, '.env'),
    'VITE_BOARD_MODE=production\nVITE_SYNTHETIC_LEAK=' + secretSentinel + '\n',
  );
  await childRun(
    directory,
    `
    import assert from 'node:assert/strict';
    import {readFile,access} from 'node:fs/promises';
    import {composeBuild} from ${JSON.stringify(composerUrl)};
    import {verifyStaticBuild} from ${JSON.stringify(verifierUrl)};
    const directory=${JSON.stringify(directory)};
    let installs=0;
    const installServer=async()=>{installs++};
    const first=await composeBuild({projectDirectory:directory,context:'production',productionRequested:true,installServer});
    assert.equal(installs,1);
    const production=JSON.parse(await readFile(first.publishDirectory+'/.vite/manifest.json','utf8'));
    assert('src/app/production.js' in production);
    await verifyStaticBuild(first.publishDirectory,{mode:'production',forbiddenValues:[process.env.GITHUB_APP_CLIENT_SECRET,process.env.BOARD_TOKEN_ENCRYPTION_KEY,process.env.ANTHROPIC_API_KEY]});
    const second=await composeBuild({projectDirectory:directory,context:'production',productionRequested:false,installServer});
    const fixture=JSON.parse(await readFile(second.publishDirectory+'/.vite/manifest.json','utf8'));
    assert(!('src/app/production.js' in fixture));
    assert.equal(installs,1);
    await assert.rejects(access(directory+'/server/.generated'),{code:'ENOENT'});
    await verifyStaticBuild(second.publishDirectory,{forbiddenValues:[process.env.GITHUB_APP_CLIENT_SECRET,process.env.BOARD_TOKEN_ENCRYPTION_KEY,process.env.ANTHROPIC_API_KEY]});
  `,
  );
});

test('staged authored functions resolve dependencies and reject preview before provider or store access', async (t) => {
  const directory = await fixture(t);
  for (const path of ['server/functions', 'server/lib', 'src/domain']) {
    await cp(resolve(project, path), resolve(directory, path), {
      recursive: true,
    });
  }
  await writeFile(
    resolve(directory, 'server/package.json'),
    JSON.stringify({ type: 'module' }),
  );
  await symlink(
    resolve(project, 'server/node_modules'),
    resolve(directory, 'server/node_modules'),
    'dir',
  );
  const result = await composeBuild({
    projectDirectory: directory,
    context: 'production',
    productionRequested: true,
    installServer: async () => {},
    buildFrontend: staticBuild,
  });
  assert.deepEqual((await readdir(result.functionsDirectory)).sort(), [
    'api.mjs',
    'report-job.mjs',
  ]);
  for (const module of [
    'analysis-preflight.mjs',
    'analysis-preflight-readiness.mjs',
    'analysis-request.mjs',
  ])
    await access(resolve(result.functionsDirectory, '../lib', module));
  await assert.rejects(
    access(resolve(directory, 'server/.generated/edge-functions')),
    { code: 'ENOENT' },
  );
  await childRun(
    directory,
    `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    const entry=${JSON.stringify(pathToFileURL(resolve(result.functionsDirectory, 'api.mjs')).href)};
    const workerEntry=${JSON.stringify(pathToFileURL(resolve(result.functionsDirectory, 'report-job.mjs')).href)};
    assert(createRequire(entry).resolve('@netlify/blobs'));
    let providerCalls=0;
    globalThis.fetch=()=>{providerCalls++;throw new Error('Unexpected provider access.');};
    const {default:handler}=await import(entry);
    const response=await handler(new Request('https://tracker-boards.netlify.app/api/session'),{deploy:{context:'deploy-preview'}});
    assert.equal(response.status,403);
    assert.equal((await response.json()).error.code,'forbidden');
    const preflightResponse=await handler(new Request('https://tracker-boards.netlify.app/api/repositories/17/analysis-preflight',{method:'POST'}),{deploy:{context:'deploy-preview'}});
    assert.equal(preflightResponse.status,403);
    assert.equal((await preflightResponse.json()).error.code,'forbidden');
    const workerModule=await import(workerEntry);
    assert.deepEqual(workerModule.config,{background:true});
    const workerResult=await workerModule.default(new Request('https://tracker-boards.netlify.app/.netlify/functions/report-job',{method:'POST'}),{deploy:{context:'deploy-preview'}});
    assert.equal(workerResult,undefined);
    assert.equal(providerCalls,0);
    const {REPORT_LIMITS}=await import(${JSON.stringify(pathToFileURL(resolve(directory, 'server/.generated/src/domain/report-contract.js')).href)});
    assert.equal(REPORT_LIMITS.issues,1000);
  `,
  );
});

test('artifact scanning rejects credential/storage markers and sentinel values in every regular asset type', async (t) => {
  const directory = await fixture(t);
  const { publishDirectory } = await composeBuild({
    projectDirectory: directory,
    buildFrontend: staticBuild,
  });
  for (const [name, content] of [
    ['probe.mjs', 'ANTHROPIC_API_KEY'],
    [
      'probe.map',
      JSON.stringify({ sourcesContent: ['import "@netlify/blobs";'] }),
    ],
    ['probe.svg', '<svg>GITHUB_APP_CLIENT_SECRET</svg>'],
    ['probe.txt', secretSentinel],
    [
      'probe.bin',
      Buffer.from([0, 128, ...Buffer.from('BOARD_TOKEN_ENCRYPTION_KEY'), 255]),
    ],
  ]) {
    const path = resolve(publishDirectory, name);
    await writeFile(path, content);
    try {
      await assert.rejects(
        verifyStaticBuild(publishDirectory, {
          forbiddenValues: [secretSentinel],
        }),
        /Server credentials or storage clients/,
      );
    } finally {
      await rm(path);
    }
  }
  await writeFile(
    resolve(publishDirectory, 'benign.bin'),
    Buffer.from([0, 128, 255, 1]),
  );
  await verifyStaticBuild(publishDirectory);
});

test('failed production frontend composition removes all staged Functions', async (t) => {
  const directory = await fixture(t);
  await fakeRuntime(directory);
  await assert.rejects(
    composeBuild({
      projectDirectory: directory,
      context: 'production',
      productionRequested: true,
      installServer: async () => {},
      buildFrontend: async () => {
        throw new Error('Synthetic frontend failure.');
      },
    }),
    /Synthetic frontend failure/,
  );
  await assert.rejects(access(resolve(directory, 'server/.generated')), {
    code: 'ENOENT',
  });
});
