#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await run('node', ['scripts/ensure-ios.mjs'], { cwd: appDir, env: process.env });
await run('pnpm', ['exec', 'cap', 'sync', 'ios'], { cwd: appDir, env: process.env });

async function run(command, args, options) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
    });
    child.on('error', rejectRun);
    child.on('exit', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 1}`));
    });
  });
}
