#!/usr/bin/env node
import { cp, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { build } from 'esbuild';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(scriptDir, '..');
const repoRoot = join(cliRoot, '..', '..');
const browserDist = join(repoRoot, 'apps', 'browser-demo', 'dist');
const distDir = join(cliRoot, 'dist');
const walletHostDist = join(distDir, 'wallet-host');

if (!existsSync(join(browserDist, 'index.html'))) {
  throw new Error(`Browser wallet host build is missing at ${browserDist}.`);
}

await build({
  entryPoints: [join(cliRoot, 'src', 'index.ts')],
  outfile: join(distDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  banner: {
    js: 'import { createRequire as __agenticCreateRequire } from "node:module";\nconst require = __agenticCreateRequire(import.meta.url);',
  },
  external: [
    'bufferutil',
    'utf-8-validate',
  ],
});

await chmod(join(distDir, 'index.js'), 0o755);
await rm(walletHostDist, { recursive: true, force: true });
await cp(browserDist, walletHostDist, { recursive: true });

console.log(`[cli-build] bundled CLI: ${join(distDir, 'index.js')}`);
console.log(`[cli-build] copied wallet host: ${walletHostDist}`);
