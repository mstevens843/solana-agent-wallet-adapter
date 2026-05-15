#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';

const root = new URL('..', import.meta.url).pathname;
const preparedActionsPath = new URL('../.agent-wallet/prepared-actions.json', import.meta.url).pathname;
const children = new Set();
const mobileMode = process.argv.includes('--mobile');
const host = mobileMode ? '0.0.0.0' : '127.0.0.1';
const browserEnv = browserDevEnv();
const bridgeEnv = bridgeDevEnv();

if (!existsSync(new URL('../.env', import.meta.url))) {
  console.error('[dev] Missing .env. Copy .env.example to .env first.');
  process.exit(1);
}

if (!existsSync(new URL('../agent-wallet.config.json', import.meta.url))) {
  console.error('[dev] Missing agent-wallet.config.json. Copy agent-wallet.config.example.json first.');
  process.exit(1);
}

await assertPortFree(8787, host);
await assertPortFree(5174, host);

await run('pnpm', ['--filter', '@solana-agent-wallet-adapter/a2a-agent-card', 'build']);
await run('pnpm', ['--filter', '@solana-agent-wallet-adapter/mcp-server', 'build']);

const bridge = start('bridge', 'node', [
  'packages/mcp-server/dist/bin/bridge.js',
  '--token',
  'local-agent-wallet',
  '--env',
  './.env',
  '--config',
  './agent-wallet.config.json',
  '--prepared-actions',
  preparedActionsPath,
  '--host',
  host,
], bridgeEnv);

const browser = start('browser', 'pnpm', [
  '-F',
  '@solana-agent-wallet-adapter/browser-demo',
  'exec',
  'vite',
  '--host',
  host,
  '--port',
  '5174',
  '--strictPort',
], browserEnv);

printUrls();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[dev] ${signal} received, stopping local dev processes...`);
    shutdown(0);
  });
}

bridge.on('exit', (code, signal) => {
  if (signal) return;
  console.error(`[dev] bridge exited with code ${code ?? 0}`);
  shutdown(code ?? 1);
});

browser.on('exit', (code, signal) => {
  if (signal) return;
  console.error(`[dev] browser exited with code ${code ?? 0}`);
  shutdown(code ?? 1);
});

function start(label, command, args, env = process.env) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.on('data', (chunk) => prefix(label, chunk));
  child.stderr.on('data', (chunk) => prefix(label, chunk));
  child.on('exit', () => {
    children.delete(child);
  });
  return child;
}

function browserDevEnv() {
  const env = { ...process.env };
  if (!env.VITE_AGENTIC_APP_SURFACE && !env.VITE_AGENTIC_DEV_CONTROLS) {
    env.VITE_AGENTIC_APP_SURFACE = 'public';
  }
  return env;
}

function bridgeDevEnv() {
  const env = { ...process.env };
  if (mobileMode && !env.BRIDGE_ALLOW_PRIVATE_ORIGINS) {
    env.BRIDGE_ALLOW_PRIVATE_ORIGINS = '1';
  }
  return env;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

function assertPortFree(port, listenHost) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[dev] Port ${port} is already in use.`);
        console.error(`[dev] Stop local dev first: npm run dev:stop`);
      } else {
        console.error(`[dev] Cannot listen on ${listenHost}:${port}: ${err.code ?? err.message}`);
      }
      process.exit(1);
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(port, listenHost);
  });
}

function printUrls() {
  const localBrowserUrl = new URL('http://127.0.0.1:5174/');
  localBrowserUrl.searchParams.set('bridgeUrl', 'http://127.0.0.1:8787');
  localBrowserUrl.searchParams.set('token', 'local-agent-wallet');
  console.log(`[dev] browser: ${localBrowserUrl.toString()}`);
  console.log(`[dev] bridge:  http://127.0.0.1:8787/?token=local-agent-wallet`);
  if (!mobileMode) return;
  for (const address of lanAddresses()) {
    console.log(`[dev] mobile browser: http://${address}:5174/?bridgeUrl=http://${address}:8787&token=local-agent-wallet`);
  }
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function prefix(label, chunk) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.length > 0) {
      console.log(`[${label}] ${line}`);
    }
  }
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const exitCode = code === 0 && children.size > 0 ? 0 : code;
  for (const child of children) {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of children) {
      child.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, 1500).unref();
}
