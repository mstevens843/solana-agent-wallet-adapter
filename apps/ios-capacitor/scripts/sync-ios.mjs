#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Run ensure-ios.mjs BEFORE `cap sync` to bootstrap the project (cap add ios)
// if it doesn't exist yet, and to seed Info.plist / entitlements before sync.
await run('node', ['scripts/ensure-ios.mjs'], { cwd: appDir, env: process.env });
await run('pnpm', ['exec', 'cap', 'sync', 'ios'], { cwd: appDir, env: process.env });
// Run again AFTER `cap sync` because cap regenerates CapApp-SPM/Package.swift
// from a template (resetting iOS deployment target to 15.0). The post-sync run
// patches it back to 16.0 and re-applies any plist changes cap may have wiped.
await run('node', ['scripts/ensure-ios.mjs'], { cwd: appDir, env: process.env });

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
