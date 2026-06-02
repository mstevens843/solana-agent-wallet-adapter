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
const zeroFingerprint = '00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00';

const cliAssets = [
  'solana-agent-wallet-macos-arm64.tar.gz',
  'solana-agent-wallet-macos-x64.tar.gz',
  'solana-agent-wallet-linux-x64.tar.gz',
  'solana-agent-wallet-windows-x64.zip',
];
const desktopAssets = [
  'agentic-desktop-macos-arm64.dmg',
  'agentic-desktop-macos-x64.dmg',
  'agentic-desktop-windows-x64.msi',
  'agentic-desktop-linux-x64.AppImage',
];
const androidAssets = [
  'agentic-android.apk',
  'agentic-android.aab',
];
const releaseProducts = [
  { id: 'cli', tagPrefix: 'cli-v', assets: cliAssets },
  { id: 'desktop', tagPrefix: 'desktop-v', assets: desktopAssets },
  { id: 'android', tagPrefix: 'v', assets: androidAssets, releaseOnlyAssets: ['assetlinks.json'] },
];
const requiredAssets = releaseProducts.flatMap((product) => product.assets);

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

if (!homepage.includes('/api/releases/downloads')) {
  failures.push('dynamic release downloads endpoint missing from apps/browser-demo/src/main.ts');
}

for (const product of ['cli', 'desktop']) {
  if (!homepage.includes(`${product.toUpperCase()}_RELEASE_BASE_URL, '${product}'`)) {
    failures.push(`${product} download cards must opt into dynamic release hydration`);
  }
  if (!homepage.includes(`data-release-page-product="${product}"`)) {
    failures.push(`${product} release page link must opt into dynamic release hydration`);
  }
}

if (homepage.includes('APP_RELEASE_BASE_URL') || homepage.includes('APP_RELEASE_PAGE_URL')) {
  failures.push('legacy APP_RELEASE_* desktop/android link base must not be used in apps/browser-demo/src/main.ts');
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

if (!live) {
  verifyAssetLinksJson(readFileSync(assetLinksFile, 'utf8'), failures, 'assetlinks.json');
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
  console.log('[release-links] Live release assets and package metadata are reachable.');
} else {
  console.log('[release-links] Release assets and public CLI commands are documented and linked.');
}

async function verifyLiveRelease() {
  let lastFailures = [];
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const attemptFailures = [];
    await verifyNpmPackage(attemptFailures);
    const resolvedReleases = await verifyGithubReleaseProducts(attemptFailures);
    if (resolvedReleases) {
      await verifyDownloadUrls(attemptFailures, resolvedReleases);
    }

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
  const expectedVersion = cliVersionFromTag(releaseTag);
  if (expectedVersion && !metadata.versions?.[expectedVersion]) {
    attemptFailures.push(`${npmPackageName}@${expectedVersion} is missing from npm registry`);
  }
}

async function verifyGithubReleaseProducts(attemptFailures) {
  if (releaseTag) {
    const product = productForTag(releaseTag);
    if (!product) {
      attemptFailures.push(`Unsupported release tag for link verification: ${releaseTag}`);
      return null;
    }
    const endpoint = `https://api.github.com/repos/${repo}/releases/tags/${releaseTag}`;
    const response = await fetchForVerification(endpoint, attemptFailures);
    if (!response) return null;
    if (!response.ok) {
      attemptFailures.push(`${endpoint} returned HTTP ${response.status}`);
      return null;
    }
    const release = await response.json();
    if (release.tag_name !== releaseTag) {
      attemptFailures.push(`GitHub release tag mismatch: expected ${releaseTag}, got ${release.tag_name}`);
      return null;
    }
    const missing = missingReleaseAssets(release, product);
    for (const asset of missing) {
      attemptFailures.push(`${asset} missing from GitHub release ${releaseTag}`);
    }
    return missing.length === 0 ? { [product.id]: { product, release } } : null;
  }

  const endpoint = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const response = await fetchForVerification(endpoint, attemptFailures);
  if (!response) return null;
  if (!response.ok) {
    attemptFailures.push(`${endpoint} returned HTTP ${response.status}`);
    return null;
  }

  const releases = await response.json();
  if (!Array.isArray(releases)) {
    attemptFailures.push(`${endpoint} did not return a release array`);
    return null;
  }

  const resolved = {};
  for (const product of releaseProducts) {
    const release = pickLatestProductRelease(releases, product);
    if (!release) {
      attemptFailures.push(`No complete ${product.id} release found for tag prefix ${product.tagPrefix}`);
      continue;
    }
    resolved[product.id] = { product, release };
  }
  return Object.keys(resolved).length > 0 ? resolved : null;
}

async function verifyDownloadUrls(attemptFailures, resolvedReleases) {
  const checks = [];
  for (const { product, release } of Object.values(resolvedReleases)) {
    for (const asset of productReleaseAssets(product)) {
      const url = releaseAssetUrl(release, asset) ??
        `https://github.com/${repo}/releases/download/${release.tag_name}/${asset}`;
      checks.push({ asset, url });
    }
  }

  await Promise.all(checks.map(async ({ url }) => {
    const response = await fetchForVerification(url, attemptFailures, { method: 'HEAD' });
    if (!response) return;
    if (!response.ok) {
      attemptFailures.push(`${url} returned HTTP ${response.status}`);
    }
  }));

  await Promise.all(checks.filter((check) => check.asset === 'assetlinks.json').map(async ({ url }) => {
    const response = await fetchForVerification(url, attemptFailures);
    if (!response) return;
    if (!response.ok) {
      attemptFailures.push(`${url} returned HTTP ${response.status}`);
      return;
    }
    verifyAssetLinksJson(await response.text(), attemptFailures, url);
  }));
}

function productForTag(tag) {
  return releaseProducts.find((product) => tag.startsWith(product.tagPrefix)) ?? null;
}

function pickLatestProductRelease(releases, product) {
  const candidates = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => {
      const version = semverFromTag(String(release.tag_name ?? ''), product.tagPrefix);
      if (!version) return null;
      return missingReleaseAssets(release, product).length === 0 ? { release, version } : null;
    })
    .filter(Boolean);
  candidates.sort((left, right) => {
    const versionOrder = compareSemver(right.version, left.version);
    if (versionOrder !== 0) return versionOrder;
    return dateMs(right.release.published_at ?? right.release.created_at ?? '') -
      dateMs(left.release.published_at ?? left.release.created_at ?? '');
  });
  return candidates[0]?.release ?? null;
}

function missingReleaseAssets(release, product) {
  const assetNames = new Set(Array.isArray(release.assets) ? release.assets.map((asset) => asset.name) : []);
  return productReleaseAssets(product).filter((asset) => !assetNames.has(asset));
}

function productReleaseAssets(product) {
  return [...product.assets, ...(product.releaseOnlyAssets ?? [])];
}

function releaseAssetUrl(release, assetName) {
  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate) => candidate.name === assetName)
    : null;
  return typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : null;
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

function cliVersionFromTag(tag) {
  if (!tag) return null;
  const match = /^cli-v(.+)$/.exec(tag);
  return match ? match[1] : null;
}

function semverFromTag(tag, prefix) {
  if (!tag.startsWith(prefix)) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(tag.slice(prefix.length));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function dateMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

function normalizeFingerprint(value) {
  const hex = value.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  if (hex.length !== 64) return '';
  return hex.match(/.{2}/g)?.join(':') ?? '';
}

function verifyAssetLinksJson(text, failures, label) {
  try {
    const assetLinks = JSON.parse(text);
    const entry = Array.isArray(assetLinks)
      ? assetLinks.find((candidate) => candidate?.target?.package_name === 'com.agentic.wallet')
      : undefined;
    if (!entry) {
      failures.push(`${label} missing com.agentic.wallet target`);
    } else if (!Array.isArray(entry.target?.sha256_cert_fingerprints)) {
      failures.push(`${label} missing sha256_cert_fingerprints array`);
    } else {
      const fingerprints = entry.target.sha256_cert_fingerprints
        .map((value) => normalizeFingerprint(String(value)))
        .filter(Boolean);
      if (fingerprints.length === 0) {
        failures.push(`${label} has no usable sha256_cert_fingerprints entries`);
      }
      if (fingerprints.includes(zeroFingerprint)) {
        failures.push(`${label} contains the placeholder zero fingerprint`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${label} is invalid: ${message}`);
  }
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
