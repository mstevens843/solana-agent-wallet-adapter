#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const action = process.argv[2] ?? 'add';
const name = 'solana-agent-wallet';

if (!['add', 'remove'].includes(action)) {
  console.error('Usage: node scripts/codex-mcp.mjs [add|remove]');
  process.exit(1);
}

if (action === 'remove') {
  run('codex', ['mcp', 'remove', name], { allowFailure: true });
  process.exit(0);
}

const serverPath = join(root, 'packages/mcp-server/dist/bin/server.js');
const envPath = join(root, '.env');
const configPath = join(root, 'agent-wallet.config.json');
const preparedActionsPath = join(root, '.agent-wallet/prepared-actions.json');

if (!existsSync(serverPath)) {
  console.log('[codex-mcp] Building MCP server...');
  run('pnpm', ['--filter', '@solana-agent-wallet-adapter/mcp-server', 'build']);
}

if (!existsSync(envPath)) {
  console.error('[codex-mcp] Missing .env. Copy .env.example to .env first.');
  process.exit(1);
}

if (!existsSync(configPath)) {
  console.error('[codex-mcp] Missing agent-wallet.config.json. Copy agent-wallet.config.example.json first.');
  process.exit(1);
}

run('codex', ['mcp', 'remove', name], { allowFailure: true });
run('codex', [
  'mcp',
  'add',
  name,
  '--',
  'node',
  serverPath,
  '--bridge-url',
  'http://127.0.0.1:8787',
  '--bridge-token',
  'local-agent-wallet',
  '--env',
  envPath,
  '--config',
  configPath,
  '--prepared-actions',
  preparedActionsPath,
]);

console.log('[codex-mcp] Registered solana-agent-wallet for Codex.');
console.log('[codex-mcp] Start the bridge/browser with: npm run dev');
console.log('[codex-mcp] Restart Codex after changing MCP registration.');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: options.allowFailure ? 'ignore' : 'inherit',
  });
  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1);
  }
}
