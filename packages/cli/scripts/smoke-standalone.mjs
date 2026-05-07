#!/usr/bin/env node
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = process.argv[2] ? resolve(process.argv[2]) : null;
if (!executable || !existsSync(executable)) {
  throw new Error('Usage: node scripts/smoke-standalone.mjs <path-to-solana-agent-wallet-executable>');
}

const runtimeDir = await mkdtemp(join(tmpdir(), 'solana-agent-wallet-smoke-'));
const configPath = join(runtimeDir, 'agent-wallet.config.json');
const bridgeUrl = `http://127.0.0.1:${process.env.AGENT_WALLET_SMOKE_BRIDGE_PORT ?? '18787'}`;
const walletHostUrl = `http://127.0.0.1:${process.env.AGENT_WALLET_SMOKE_WALLET_HOST_PORT ?? '15174'}`;
const env = {
  ...process.env,
  AGENT_WALLET_HOME: runtimeDir,
  NO_COLOR: '1',
};
const children = [];

await writeFile(configPath, `${JSON.stringify({
  cluster: 'localnet',
  rpcUrl: 'http://127.0.0.1:8899',
  mainnet: {
    enabled: false,
    maxSolTransfer: '0.05',
    maxSwapInput: '0.05',
    maxSlippageBps: 100,
    allowArbitraryTransactions: false,
  },
  tokens: [],
  jupiter: {
    baseUrl: 'https://api.jup.ag/swap/v2',
    apiKeyEnv: 'JUPITER_API_KEY',
  },
}, null, 2)}\n`, 'utf8');

try {
  runOk(['--help']);
  runOk(['--runtime-dir', runtimeDir, '--config', configPath, 'doctor', '--json']);

  const walletHost = start([
    '--runtime-dir',
    runtimeDir,
    '--config',
    configPath,
    '--wallet-host-url',
    walletHostUrl,
    'wallet-host',
    'serve',
  ]);
  await waitForJson(`${walletHostUrl}/__agentic/health`, 15_000);

  const bridge = start([
    '--runtime-dir',
    runtimeDir,
    '--config',
    configPath,
    '--bridge-url',
    bridgeUrl,
    'bridge',
    'serve',
  ]);
  await waitForUrl(`${bridgeUrl}/bridge/health?token=local-agent-wallet`, 20_000);

  console.log(`[cli-smoke] ok: ${executable}`);
  bridge.kill('SIGTERM');
  walletHost.kill('SIGTERM');
} finally {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

function runOk(args) {
  const result = spawnSync(executable, args, {
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error([
      `${executable} ${args.join(' ')} failed with code ${result.status ?? 1}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
}

function start(args) {
  const child = spawn(executable, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (chunk) => process.stdout.write(`[smoke] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[smoke] ${chunk}`));
  child.on('exit', (code, signal) => {
    if (code && !signal) {
      console.error(`[cli-smoke] child exited with code ${code}: ${args.join(' ')}`);
    }
  });
  return child;
}

async function waitForUrl(url, timeoutMs) {
  const startTime = Date.now();
  let lastError = null;
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForJson(url, timeoutMs) {
  const startTime = Date.now();
  let lastError = null;
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.json();
        if (body && body.ok === true) {
          return body;
        }
        lastError = new Error(`unexpected JSON ${JSON.stringify(body)}`);
      } else {
        lastError = new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
