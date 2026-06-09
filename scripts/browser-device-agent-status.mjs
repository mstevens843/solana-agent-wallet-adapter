#!/usr/bin/env node
/**
 * Browser-native Device Agent status probe.
 *
 * Read-only derivation of the gate state for the browser-native runtime. Mirrors
 * the parsing logic in apps/browser-demo/src/devGate.ts and the Render-side flags
 * in apps/render-web/src/cloud/devGate.ts so a tester can confirm a local bundle
 * would produce the runtime tier they expect without booting the app.
 *
 * Phase 8 deliverable for docs/plans/browser-device-agent-runtime-plan.md.
 *
 * Exit codes:
 *   0 — derivation succeeded
 *   2 — bad CLI input (e.g., missing --env-file)
 *   3 — unexpected I/O error
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();

const ENABLED_TOKENS = new Set(['1', 'true', 'yes', 'on']);

const BROWSER_ENV_FILES = [
  'apps/browser-demo/.env',
  'apps/browser-demo/.env.local',
  'apps/browser-demo/.env.production',
];

const RENDER_ENV_FILES = [
  'apps/render-web/.env',
  'apps/render-web/.env.local',
  'apps/render-web/.env.production',
];

const BROWSER_KEYS = [
  'VITE_AGENTIC_DEVICE_AGENT',
  'VITE_AGENTIC_BROWSER_DEVICE_AGENT',
  'VITE_AGENTIC_ANDROID_DEVICE_AGENT',
  'VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST',
];

const RENDER_KEYS = [
  'AGENTIC_DEVICE_AGENT',
  'AGENTIC_BROWSER_DEVICE_AGENT',
  'AGENTIC_ANDROID_DEVICE_AGENT',
  'AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST',
];

function exitError(message, code) {
  process.stderr.write(`browser-device-agent-status: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = new Set();
  const options = { 'env-file': [], wallet: [] };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      flags.add('help');
      continue;
    }
    if (arg === '--json') {
      flags.add('json');
      continue;
    }
    if (arg === '--is-android-app') {
      flags.add('is-android-app');
      continue;
    }
    const match = arg.match(/^--([a-z][a-z0-9-]*)=(.*)$/i);
    if (!match) {
      exitError(`unknown argument: ${arg}`, 2);
    }
    const key = match[1];
    const value = match[2];
    if (key === 'env-file' || key === 'wallet') {
      options[key].push(value);
    } else {
      options[key] = value;
    }
  }
  return { flags, options };
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/browser-device-agent-status.mjs [options]',
      '',
      'Options:',
      '  --env-file=<path>    Additional env file to merge (repeatable)',
      '  --wallet=<address>   Check effective runtime for this wallet (repeatable)',
      '  --is-android-app     Simulate IS_ANDROID_APP=true for precedence test',
      '  --json               Emit JSON report',
      '  --help               Print this usage',
      '',
      'Exit codes:',
      '  0  derivation succeeded',
      '  2  bad CLI input',
      '  3  unexpected I/O error',
      '',
    ].join('\n'),
  );
}

function parseEnvFileContent(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) {
      key = key.slice('export '.length).trim();
    }
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function loadEnvFile(relPath, { required }) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { abs, present: false, values: {} };
  } catch (err) {
    if (required) {
      exitError(`env file not found: ${relPath}`, 2);
    }
    return { abs, present: false, values: {} };
  }
  try {
    const text = await readFile(abs, 'utf8');
    return { abs, present: true, values: parseEnvFileContent(text) };
  } catch (err) {
    exitError(`failed to read ${relPath}: ${err?.message ?? err}`, 3);
    return { abs, present: false, values: {} };
  }
}

function isEnabled(value) {
  if (value === undefined || value === null) return false;
  return ENABLED_TOKENS.has(String(value).trim().toLowerCase());
}

function parseAllowlist(value) {
  const raw = (value ?? '').trim();
  const items = raw
    ? raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  return Object.freeze(items);
}

function maskWallet(address) {
  if (!address) return address;
  if (address.length <= 12) return address;
  return `${address.slice(0, 8)}…${address.slice(-5)}`;
}

function deriveEffectiveRuntime({
  deviceAgentEnabled,
  browserDeviceAgentEnabled,
  androidPresent,
  hasWallet,
}) {
  if (!deviceAgentEnabled) return 'unavailable';
  if (androidPresent) return 'android-native';
  if (browserDeviceAgentEnabled && hasWallet) return 'browser-native';
  if (deviceAgentEnabled) return 'browser-dev';
  return 'unavailable';
}

function padCell(value, width) {
  const str = String(value);
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

function formatTable(rows, headers) {
  const widths = headers.map((header, idx) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[idx] ?? '').length),
    ),
  );
  const headerLine = headers.map((header, idx) => padCell(header, widths[idx])).join('  ');
  const lines = [headerLine];
  for (const row of rows) {
    lines.push(row.map((cell, idx) => padCell(cell ?? '', widths[idx])).join('  '));
  }
  return lines.join('\n');
}

async function main() {
  const { flags, options } = parseArgs(process.argv.slice(2));
  if (flags.has('help')) {
    printHelp();
    return 0;
  }

  const sources = [];

  for (const rel of [...BROWSER_ENV_FILES, ...RENDER_ENV_FILES]) {
    sources.push(await loadEnvFile(rel, { required: false }));
  }
  for (const rel of options['env-file']) {
    sources.push(await loadEnvFile(rel, { required: true }));
  }

  // Merge order: process.env wins last so callers can override on the command line.
  const merged = {};
  for (const source of sources) {
    Object.assign(merged, source.values);
  }
  for (const key of [...BROWSER_KEYS, ...RENDER_KEYS]) {
    if (process.env[key] !== undefined) {
      merged[key] = process.env[key];
    }
  }

  const sourceRows = [];
  for (const source of sources) {
    if (!source.present) continue;
    const relAbs = path.relative(ROOT, source.abs) || source.abs;
    for (const key of [...BROWSER_KEYS, ...RENDER_KEYS]) {
      if (Object.prototype.hasOwnProperty.call(source.values, key)) {
        const value = source.values[key];
        sourceRows.push([relAbs, key, value]);
      }
    }
  }
  for (const key of [...BROWSER_KEYS, ...RENDER_KEYS]) {
    if (process.env[key] !== undefined) {
      sourceRows.push(['process.env', key, process.env[key]]);
    }
  }

  const browserDeviceAgentEnabled = isEnabled(merged.VITE_AGENTIC_DEVICE_AGENT);
  const browserNativeEnabled = isEnabled(merged.VITE_AGENTIC_BROWSER_DEVICE_AGENT);
  const browserAndroidFlag = isEnabled(merged.VITE_AGENTIC_ANDROID_DEVICE_AGENT);
  const browserAllowlist = parseAllowlist(merged.VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST);

  const renderDeviceAgentEnabled = isEnabled(merged.AGENTIC_DEVICE_AGENT);
  const renderBrowserNativeEnabled = isEnabled(merged.AGENTIC_BROWSER_DEVICE_AGENT);
  const renderAndroidFlag =
    merged.AGENTIC_ANDROID_DEVICE_AGENT === undefined
      ? true
      : merged.AGENTIC_ANDROID_DEVICE_AGENT !== '0';
  const renderAllowlist = parseAllowlist(merged.AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST);

  const renderRuntimes = {
    android: renderDeviceAgentEnabled && renderAndroidFlag,
    browserNative: renderDeviceAgentEnabled && renderBrowserNativeEnabled,
  };

  const isAndroidApp = flags.has('is-android-app');
  const wallets = options.wallet.length > 0
    ? options.wallet
    : ['11111111111111111111111111111111'];

  const walletResults = wallets.map((address) => {
    const effective = deriveEffectiveRuntime({
      deviceAgentEnabled: browserDeviceAgentEnabled,
      browserDeviceAgentEnabled: browserNativeEnabled,
      androidPresent: isAndroidApp,
      hasWallet: address.trim().length > 0,
    });
    return { address, effective };
  });

  const derived = {
    DEVICE_AGENT_ENABLED: browserDeviceAgentEnabled,
    BROWSER_DEVICE_AGENT_ENABLED: browserNativeEnabled,
    ANDROID_DEVICE_AGENT_ENABLED: browserAndroidFlag,
    browserAllowlist,
    renderRuntimes,
    renderAllowlist,
    isAndroidApp,
  };

  if (flags.has('json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          ranAt: new Date().toISOString(),
          sources: sources
            .filter((source) => source.present)
            .map((source) => path.relative(ROOT, source.abs) || source.abs),
          variables: sourceRows.map(([file, key, value]) => ({ file, key, value })),
          derived,
          wallets: walletResults,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write('Sources\n');
  if (sourceRows.length === 0) {
    process.stdout.write('  (no relevant env vars detected in .env files or process.env)\n');
  } else {
    process.stdout.write(`${formatTable(sourceRows, ['File', 'Var', 'Value'])
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')}\n`);
  }

  process.stdout.write('\nDerived\n');
  const derivedRows = [
    ['DEVICE_AGENT_ENABLED', String(browserDeviceAgentEnabled)],
    ['BROWSER_DEVICE_AGENT_ENABLED', String(browserNativeEnabled)],
    ['ANDROID_DEVICE_AGENT_ENABLED (browser flag)', String(browserAndroidFlag)],
    ['Browser allowlist (deprecated)', `[${browserAllowlist.join(', ')}]`],
    ['Render runtimes', `android=${renderRuntimes.android}, browserNative=${renderRuntimes.browserNative}`],
    ['Render allowlist (deprecated)', `[${renderAllowlist.join(', ')}]`],
    ['IS_ANDROID_APP (simulated)', String(isAndroidApp)],
  ];
  process.stdout.write(`${formatTable(derivedRows, ['Setting', 'Value'])
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')}\n`);

  process.stdout.write('\nWallets\n');
  const walletRows = walletResults.map((entry) => [
    maskWallet(entry.address),
    entry.effective,
    entry.address.trim().length > 0 ? 'wallet present' : 'missing wallet',
  ]);
  process.stdout.write(`${formatTable(walletRows, ['Wallet', 'Effective runtime', 'Wallet'])
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')}\n`);

  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`browser-device-agent-status: ${err?.stack ?? err}\n`);
    process.exit(3);
  });
