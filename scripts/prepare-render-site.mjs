#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidScript = join(root, 'scripts/android.mjs');
const assetLinksPath = join(root, 'apps/browser-demo/public/.well-known/assetlinks.json');
const requireTrust = isTruthy(process.env.AGENTIC_ANDROID_REQUIRE_TRUST);

if (!process.env.AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS) {
  const message =
    '[render] AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS is not set. Keeping checked-in placeholder assetlinks.json.';
  if (requireTrust) {
    console.error(`${message} AGENTIC_ANDROID_REQUIRE_TRUST=1 requires a production signing fingerprint.`);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

runAndroid(['assetlinks:write', '--out', assetLinksPath]);
runAndroid(['assetlinks:verify', '--file', assetLinksPath]);

function runAndroid(args) {
  const result = spawnSync(process.execPath, [androidScript, ...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function isTruthy(value) {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}
