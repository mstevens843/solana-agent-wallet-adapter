#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicAppRoutes } from './public-routes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultRepo = 'mstevens843/solana-agent-wallet-adapter';
const npmPackageName = '@solana-agent-wallet-adapter/cli';
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
const routePaths = publicAppRoutes;
const localOnlyCommands = ['pnpm desktop:dev', 'pnpm cli -- app'];

const cliArgs = parseArgs(process.argv.slice(2));
const live = cliArgs.flags.has('live');
const repo = cliArgs.options.repo ?? defaultRepo;
const releaseTag = cliArgs.options.tag ?? process.env.RELEASE_TAG ?? null;
const retries = parsePositiveInt(cliArgs.options.retries, live ? 1 : 1, 'retries');
const retryDelayMs = parsePositiveInt(cliArgs.options['retry-delay-ms'], 10_000, 'retry-delay-ms');

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

if (!homepage.includes(`https://github.com/${defaultRepo}/releases/latest/download`)) {
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
  reportFailures('[release-links] Verification failed:', failures);
  process.exit(1);
}

if (live) {
  const liveFailures = await verifyLiveRelease();
  if (liveFailures.length > 0) {
    reportFailures('[release-links] Live release verification failed:', liveFailures);
    process.exit(1);
  }
  console.log('[release-links] Live npm package and GitHub release assets are reachable.');
} else {
  console.log('[release-links] Release assets and public CLI commands are documented and linked.');
}

async function verifyLiveRelease() {
  let lastFailures = [];
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const attemptFailures = [];
    await verifyNpmPackage(attemptFailures);
    await verifyGithubRelease(attemptFailures);
    await verifyDownloadUrls(attemptFailures);

    if (attemptFailures.length === 0) {
      return [];
    }

    lastFailures = attemptFailures;
    if (attempt < retries) {
      console.warn(
        `[release-links] Live check ${attempt}/${retries} failed; retrying in ${retryDelayMs}ms.`,
      );
      await sleep(retryDelayMs);
    }
  }
  return lastFailures;
}

async function verifyNpmPackage(attemptFailures) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(npmPackageName)}`;
  const response = await fetchForVerification(url, attemptFailures);
  if (!response) return;
  if (!response.ok) {
    attemptFailures.push(`${npmPackageName} returned HTTP ${response.status} from npm registry`);
    return;
  }

  const metadata = await response.json();
  const expectedVersion = npmVersionFromTag(releaseTag);
  if (expectedVersion && !metadata.versions?.[expectedVersion]) {
    attemptFailures.push(`${npmPackageName}@${expectedVersion} is missing from npm registry`);
  }
}

async function verifyGithubRelease(attemptFailures) {
  const endpoint = releaseTag
    ? `https://api.github.com/repos/${repo}/releases/tags/${releaseTag}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const response = await fetchForVerification(endpoint, attemptFailures);
  if (!response) return;
  if (!response.ok) {
    attemptFailures.push(`${endpoint} returned HTTP ${response.status}`);
    return;
  }

  const release = await response.json();
  if (releaseTag && release.tag_name !== releaseTag) {
    attemptFailures.push(`GitHub release tag mismatch: expected ${releaseTag}, got ${release.tag_name}`);
  }

  const assetNames = new Set(Array.isArray(release.assets) ? release.assets.map((asset) => asset.name) : []);
  for (const asset of requiredAssets) {
    if (!assetNames.has(asset)) {
      attemptFailures.push(`${asset} missing from GitHub release ${release.tag_name ?? 'latest'}`);
    }
  }
}

async function verifyDownloadUrls(attemptFailures) {
  await Promise.all(requiredAssets.map(async (asset) => {
    const url = `https://github.com/${repo}/releases/latest/download/${asset}`;
    const response = await fetchForVerification(url, attemptFailures, { method: 'HEAD' });
    if (!response) return;
    if (!response.ok) {
      attemptFailures.push(`${url} returned HTTP ${response.status}`);
    }
  }));
}

async function fetchForVerification(url, attemptFailures, init = {}) {
  try {
    return await fetchWithHeaders(url, init);
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    const message = err instanceof Error ? `${err.message}${cause}` : String(err);
    attemptFailures.push(`${url} failed: ${message}`);
    return null;
  }
}

async function fetchWithHeaders(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('user-agent', 'agentic-release-link-verifier');
  if (url.startsWith('https://api.github.com/')) {
    headers.set('accept', 'application/vnd.github+json');
    if (process.env.GITHUB_TOKEN) {
      headers.set('authorization', `Bearer ${process.env.GITHUB_TOKEN}`);
    }
    headers.set('x-github-api-version', '2022-11-28');
  }
  return fetch(url, { ...init, headers, redirect: 'follow' });
}

function npmVersionFromTag(tag) {
  if (!tag) return null;
  const match = /^v(.+)$/.exec(tag);
  return match ? match[1] : null;
}

function parseArgs(argv) {
  const options = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) continue;
    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex >= 0) {
      options[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[withoutPrefix] = next;
      index += 1;
    } else {
      flags.add(withoutPrefix);
    }
  }
  return { flags, options };
}

function parsePositiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function reportFailures(title, items) {
  console.error(title);
  for (const item of items) {
    console.error(`- ${item}`);
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
