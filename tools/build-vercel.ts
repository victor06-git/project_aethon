// Vercel build: writes .vercel/output (Build Output API v3) so Vercel deploys exactly this:
//   static/          → the React app (Vite, HTTP transport: it calls /api)
//   functions/api    → one Node function wrapping the TypeScript backend (bundled by esbuild)
// Bundling is required: the backend is ESM with extensionless and JSON imports, which Node
// cannot load file by file. The Python code in backend/ is offline tooling and is not deployed.
// Run: npm run build:vercel
import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.vercel', 'output');
const DIST = path.join(ROOT, 'dist', 'web');
const FUNC = path.join(OUT, 'functions', 'api.func');
const NODE_RUNTIME = 'nodejs22.x';

const writeJson = (file: string, obj: unknown) => fs.writeFileSync(file, JSON.stringify(obj, null, 2));

async function buildStatic() {
  fs.rmSync(DIST, { recursive: true, force: true });
  await viteBuild({ configFile: path.join(ROOT, 'vite.config.ts'), mode: 'production', build: { outDir: DIST } });
  fs.cpSync(DIST, path.join(OUT, 'static'), { recursive: true });
}

async function buildFunction() {
  fs.mkdirSync(FUNC, { recursive: true });
  await esbuild({
    entryPoints: [path.join(ROOT, 'backend/src/interfaces/http/vercel.ts')],
    outfile: path.join(FUNC, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning'
  });
  writeJson(path.join(FUNC, '.vc-config.json'), {
    runtime: NODE_RUNTIME,
    handler: 'index.mjs',
    launcherType: 'Nodejs',
    shouldAddHelpers: false
  });
}

function writeConfig() {
  writeJson(path.join(OUT, 'config.json'), {
    version: 3,
    routes: [
      { src: '^/api/(.*)$', dest: '/api' },
      { handle: 'filesystem' },
      { src: '^/(.*)$', dest: '/index.html' }
    ]
  });
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  await buildStatic();
  await buildFunction();
  writeConfig();
  console.log(`Vercel output ready: ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
