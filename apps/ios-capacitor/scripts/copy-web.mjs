#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(appDir, '../..');
const source = join(root, 'apps/browser-demo/dist');
const target = join(appDir, 'dist');

if (!existsSync(source)) {
  console.error(`[ios-capacitor] Browser demo build output not found: ${source}`);
  console.error('[ios-capacitor] Run pnpm -F @solana-agent-wallet-adapter/browser-demo build first.');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`[ios-capacitor] Copied web assets to ${target}`);
