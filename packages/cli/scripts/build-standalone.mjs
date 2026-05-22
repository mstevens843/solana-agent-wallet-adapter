#!/usr/bin/env node
import { chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const targets = {
  'macos-arm64': {
    pkgTarget: 'node22-macos-arm64',
    executable: 'solana-agent-wallet',
  },
  'macos-x64': {
    pkgTarget: 'node22-macos-x64',
    executable: 'solana-agent-wallet',
  },
  'linux-x64': {
    pkgTarget: 'node22-linux-x64',
    executable: 'solana-agent-wallet',
  },
  'windows-x64': {
    pkgTarget: 'node22-win-x64',
    executable: 'solana-agent-wallet.exe',
  },
};

const targetName = process.argv[2];
if (!targetName || !(targetName in targets)) {
  throw new Error(`Usage: node scripts/build-standalone.mjs <${Object.keys(targets).join('|')}>`);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(scriptDir, '..');
const distDir = join(cliRoot, 'dist');
const target = targets[targetName];
const outDir = join(distDir, 'standalone', targetName);
const output = join(outDir, target.executable);
const pkgEnv = {
  ...process.env,
  PKG_CACHE_PATH: process.env.PKG_CACHE_PATH ?? join(tmpdir(), 'solana-agent-wallet-pkg-cache', targetName),
};

if (!existsSync(join(distDir, 'index.js')) || !existsSync(join(distDir, 'wallet-host', 'index.html'))) {
  throw new Error('Run pnpm -F @solana-agent-wallet-adapter/cli build before building standalone binaries.');
}

await mkdir(outDir, { recursive: true });

const require = createRequire(import.meta.url);
const pkgPackageJson = require.resolve('@yao-pkg/pkg/package.json');
const pkgBin = join(dirname(pkgPackageJson), 'lib-es5', 'bin.js');
await run(process.execPath, [
  '--max-old-space-size=6144',
  pkgBin,
  cliRoot,
  '--target',
  target.pkgTarget,
  '--output',
  output,
  '--compress',
  'GZip',
  '--sea',
  '--no-bytecode',
  '--fallback-to-source',
], pkgEnv);

if (process.platform !== 'win32') {
  await chmod(output, 0o755);
}

console.log(`[cli-standalone] built ${targetName}: ${output}`);

function run(command, args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: cliRoot,
      env,
      stdio: 'inherit',
    });
    child.on('error', rejectRun);
    child.on('exit', (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 1}`));
      }
    });
  });
}
