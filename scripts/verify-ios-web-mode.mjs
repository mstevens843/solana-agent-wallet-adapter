#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = String(process.argv[2] ?? '').trim().toLowerCase();
const LIVE_ORIGIN = 'https://agentic-signer.com';
const ALLOWED_ORIGINS = ['https://agentic-signer.com', 'https://agentic-seeker.com', 'capacitor://localhost'];
const ALLOW_NAVIGATION = ['agentic-signer.com', 'agentic-seeker.com'];
const EXPECTED_PACKAGE_CLASSES = [
  'AppPlugin',
  'AgenticSecureStatePlugin',
  'AgenticWalletConnectPlugin',
  'AgenticNativeWalletPlugin',
  'AgenticBiometricPlugin',
  'AgenticSystemPlugin',
  'AgenticRemoteConfigPlugin',
  'AgenticDeviceAgentPlugin',
  'AgenticStreamingSessionPlugin',
  'AgenticQrScannerPlugin',
];

if (!new Set(['live', 'local']).has(mode)) {
  fail(`Usage: node scripts/verify-ios-web-mode.mjs live|local`);
}

const capConfigPath = join(root, 'apps/ios-capacitor/ios/App/App/capacitor.config.json');
const infoPlistPath = join(root, 'apps/ios-capacitor/ios/App/App/Info.plist');
const storyboardPath = join(root, 'apps/ios-capacitor/ios/App/App/Base.lproj/Main.storyboard');

const capConfig = readJson(capConfigPath);
const infoPlist = readText(infoPlistPath);
const storyboard = readText(storyboardPath);

verifyCapacitorConfig(capConfig);
verifyInfoPlist(infoPlist);
verifyStoryboard(storyboard);

console.log(`[ios] verified ${mode} web mode`);

function verifyCapacitorConfig(config) {
  if (config.appId !== 'com.agentic.wallet') {
    fail(`capacitor.config.json appId drifted: ${JSON.stringify(config.appId)}`);
  }
  if (config.webDir !== 'dist') {
    fail(`capacitor.config.json webDir must be "dist", got ${JSON.stringify(config.webDir)}`);
  }
  if (config.ios?.contentInset !== 'never') {
    fail(`iOS contentInset must be "never" so CSS owns safe areas, got ${JSON.stringify(config.ios?.contentInset)}`);
  }

  if (mode === 'live') {
    if (config.server?.url !== LIVE_ORIGIN) {
      fail(`live mode must generate server.url=${LIVE_ORIGIN}, got ${JSON.stringify(config.server?.url)}`);
    }
    if (config.server?.cleartext !== false) {
      fail('live mode must keep server.cleartext=false');
    }
    assertArrayContainsExactly(config.server?.allowNavigation, ALLOW_NAVIGATION, 'server.allowNavigation');
  } else if (config.server?.url) {
    fail(`local mode must not generate a remote server.url, got ${JSON.stringify(config.server.url)}`);
  }

  assertArrayContainsExactly(config.packageClassList, EXPECTED_PACKAGE_CLASSES, 'packageClassList');
}

function verifyInfoPlist(plist) {
  const cloudBaseUrl = plistString(plist, 'AGENTIC_CLOUD_API_BASE_URL');
  if (cloudBaseUrl !== LIVE_ORIGIN) {
    fail(`Info.plist AGENTIC_CLOUD_API_BASE_URL must be ${LIVE_ORIGIN}, got ${JSON.stringify(cloudBaseUrl)}`);
  }

  const allowedOrigins = plistString(plist, 'AGENTIC_ALLOWED_ORIGINS');
  const parsed = String(allowedOrigins ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  assertArrayContainsExactly(parsed, ALLOWED_ORIGINS, 'Info.plist AGENTIC_ALLOWED_ORIGINS');

  if (!plist.includes('<string>agenticwallet</string>')) {
    fail('Info.plist must keep the agenticwallet URL scheme for wallet callbacks');
  }
}

function verifyStoryboard(xml) {
  if (!xml.includes('customClass="AgenticBridgeViewController"')) {
    fail('Main.storyboard must use AgenticBridgeViewController as the root web container');
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch (err) {
    fail(`Could not parse ${relativePath(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readText(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(`Could not read ${relativePath(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function plistString(plist, key) {
  const pattern = new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<string>([^<]*)</string>`);
  const match = plist.match(pattern);
  return match?.[1] ?? null;
}

function assertArrayContainsExactly(actual, expected, label) {
  if (!Array.isArray(actual)) {
    fail(`${label} must be an array`);
  }
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    fail(`${label} drifted. expected=${JSON.stringify(expectedSorted)} actual=${JSON.stringify(actualSorted)}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relativePath(filePath) {
  return filePath.startsWith(root) ? filePath.slice(root.length + 1) : filePath;
}

function fail(message) {
  console.error(`[ios] ${message}`);
  process.exit(1);
}
