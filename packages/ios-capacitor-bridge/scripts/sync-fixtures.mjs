#!/usr/bin/env node
// Copies shared-test-fixtures/ into Tests/Fixtures so XCTest can find them at
// runtime. Run before `swift test` (or wire as a pre-build phase in Xcode).
import { readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const sharedFixtures = resolve(packageRoot, '../../packages/shared-test-fixtures/fixtures');
const destDir = resolve(packageRoot, 'Tests/Fixtures');

mkdirSync(destDir, { recursive: true });
const files = readdirSync(sharedFixtures).filter((f) => f.endsWith('.json'));
for (const f of files) {
  copyFileSync(join(sharedFixtures, f), join(destDir, f));
}
console.log(`[ios-bridge] Synced ${files.length} fixture files from shared-test-fixtures → Tests/Fixtures`);
