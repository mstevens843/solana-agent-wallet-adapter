#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  join(root, 'apps/browser-demo/src/main.ts'),
  join(root, 'apps/browser-demo/README.md'),
  join(root, 'docs/deploy/render.md'),
];
const assetLinksFile = join(root, 'apps/browser-demo/public/.well-known/assetlinks.json');

const requiredAssets = [
  'solana-agent-wallet-macos-arm64.tar.gz',
  'solana-agent-wallet-macos-x64.tar.gz',
  'solana-agent-wallet-linux-x64.tar.gz',
  'solana-agent-wallet-windows-x64.zip',
  'agentic-desktop-macos-arm64.dmg',
  'agentic-desktop-macos-x64.dmg',
  'agentic-desktop-windows-x64.msi',
  'agentic-desktop-linux-x64.AppImage',
  'agentic-android.apk',
  'agentic-android.aab',
];

const requiredCommands = [
  'npm install -g @solana-agent-wallet-adapter/cli',
  'npm exec @solana-agent-wallet-adapter/cli -- app',
];
const routePaths = ['/', '/docs', '/cli', '/desktop', '/android', '/demo'];
const localOnlyCommands = ['pnpm desktop:dev', 'pnpm cli -- app'];

const contents = files.map((file) => [file, readFileSync(file, 'utf8')]);
const failures = [];

for (const asset of requiredAssets) {
  for (const [file, text] of contents) {
    if (!text.includes(asset)) {
      failures.push(`${asset} missing from ${file}`);
    }
  }
}

const homepage = contents.find(([file]) => file.endsWith('apps/browser-demo/src/main.ts'))?.[1] ?? '';
for (const command of requiredCommands) {
  if (!homepage.includes(command)) {
    failures.push(`${command} missing from apps/browser-demo/src/main.ts`);
  }
}

if (!homepage.includes('https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest/download')) {
  failures.push('latest-release download base URL missing from apps/browser-demo/src/main.ts');
}

for (const route of routePaths) {
  if (!homepage.includes(`'${route}'`) && !homepage.includes(`"${route}"`)) {
    failures.push(`${route} route missing from apps/browser-demo/src/main.ts`);
  }
}

for (const requiredSymbol of ['homepageFooter', 'homepageDemoCtaSection']) {
  if (!homepage.includes(requiredSymbol)) {
    failures.push(`${requiredSymbol} missing from apps/browser-demo/src/main.ts`);
  }
}

const localDevelopmentStart = homepage.indexOf('function localDevelopmentSection');
const localDevelopmentEnd = homepage.indexOf('function downloadCard');
const localDevelopmentSection =
  localDevelopmentStart >= 0 && localDevelopmentEnd > localDevelopmentStart
    ? homepage.slice(localDevelopmentStart, localDevelopmentEnd)
    : '';
const publicInstallSurface =
  localDevelopmentStart >= 0 ? homepage.slice(0, localDevelopmentStart) : homepage;

for (const command of localOnlyCommands) {
  const occurrences = homepage.match(new RegExp(escapeRegExp(command), 'g'))?.length ?? 0;
  if (occurrences !== 1 || !localDevelopmentSection.includes(command)) {
    failures.push(`${command} must appear exactly once in localDevelopmentSection`);
  }
  if (publicInstallSurface.includes(command)) {
    failures.push(`${command} must not appear in public install/download sections`);
  }
}

try {
  const assetLinks = JSON.parse(readFileSync(assetLinksFile, 'utf8'));
  const entry = Array.isArray(assetLinks)
    ? assetLinks.find((candidate) => candidate?.target?.package_name === 'com.agentic.wallet')
    : undefined;
  if (!entry) {
    failures.push('assetlinks.json missing com.agentic.wallet target');
  } else if (!Array.isArray(entry.target?.sha256_cert_fingerprints)) {
    failures.push('assetlinks.json missing sha256_cert_fingerprints array');
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  failures.push(`assetlinks.json is invalid: ${message}`);
}

if (failures.length > 0) {
  console.error('[release-links] Verification failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[release-links] Release assets and public CLI commands are documented and linked.');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
