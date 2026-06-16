#!/usr/bin/env node
// Copies shared-test-fixtures/ into Tests/Fixtures so XCTest can find them at
// runtime. Run before `swift test` (or wire as a pre-build phase in Xcode).
// With `--check`, verifies the mirror is in sync (exits 1 on drift) instead of
// copying — wire into CI so a stale Tests/Fixtures copy fails the build.
import { readdirSync, copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const sharedFixtures = resolve(packageRoot, '../../packages/shared-test-fixtures/fixtures');
const destDir = resolve(packageRoot, 'Tests/Fixtures');
const checkOnly = process.argv.includes('--check');

const files = readdirSync(sharedFixtures).filter((f) => f.endsWith('.json'));

if (checkOnly) {
  const drifted = files.filter((f) => {
    const dest = join(destDir, f);
    return !existsSync(dest) || readFileSync(join(sharedFixtures, f)) .compare(readFileSync(dest)) !== 0;
  });
  if (drifted.length) {
    console.error(`[ios-bridge] Fixture drift in Tests/Fixtures: ${drifted.join(', ')}. Run scripts/sync-fixtures.mjs.`);
    process.exit(1);
  }
  console.log(`[ios-bridge] ${files.length} fixture files in sync with shared-test-fixtures.`);
} else {
  mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    copyFileSync(join(sharedFixtures, f), join(destDir, f));
  }
  console.log(`[ios-bridge] Synced ${files.length} fixture files from shared-test-fixtures → Tests/Fixtures`);
}
