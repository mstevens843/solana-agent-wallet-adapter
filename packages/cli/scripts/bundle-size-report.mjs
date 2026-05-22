#!/usr/bin/env node
// Bundle size guard. Fails CI if dist/index.js exceeds the budget.

import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..');
const dist = join(cliRoot, 'dist', 'index.js');

// The CLI bundles the full mcp-server (all 20 protocol SDKs), so the realistic
// baseline is well above a typical Node CLI. We track the high-water mark and
// fail only when growth is unbounded.
const BUDGET_MB = Number(process.env.AGENTIC_CLI_BUNDLE_BUDGET_MB ?? 40);

if (!existsSync(dist)) {
  console.error('[bundle-size] dist/index.js missing — build must run first.');
  process.exit(1);
}

const { size } = await stat(dist);
const mb = size / (1024 * 1024);
const budgetBytes = BUDGET_MB * 1024 * 1024;

if (size > budgetBytes) {
  console.error(`[bundle-size] FAIL: dist/index.js is ${mb.toFixed(2)} MB (budget ${BUDGET_MB} MB). Trim deps or lazy-import.`);
  process.exit(1);
}

console.log(`[bundle-size] ok — ${mb.toFixed(2)} MB / ${BUDGET_MB} MB budget`);
