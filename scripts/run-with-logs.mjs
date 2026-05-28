#!/usr/bin/env node
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
let label = 'command';
const separator = args.indexOf('--');
if (separator === -1 || separator === args.length - 1) {
  console.error('[run-with-logs] Usage: node scripts/run-with-logs.mjs --label <name> -- <command> [args...]');
  process.exit(2);
}

for (let index = 0; index < separator; index += 1) {
  if (args[index] === '--label') {
    label = args[index + 1] ?? label;
    index += 1;
  }
}

const command = args[separator + 1];
const commandArgs = args.slice(separator + 2);
const startedAt = Date.now();
const formatSeconds = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
const memorySummary = () => {
  const used = process.memoryUsage();
  return `rss=${Math.round(used.rss / 1024 / 1024)}MiB heap=${Math.round(used.heapUsed / 1024 / 1024)}MiB`;
};

console.log(`[run-with-logs] start ${label}: ${[command, ...commandArgs].join(' ')}`);
const child = spawn(command, commandArgs, {
  env: process.env,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

const heartbeat = setInterval(() => {
  console.log(`[run-with-logs] still running ${label}: elapsed=${formatSeconds()} ${memorySummary()}`);
}, Number(process.env.AGENTIC_BUILD_HEARTBEAT_MS ?? 30_000));

child.on('error', (err) => {
  clearInterval(heartbeat);
  console.error(`[run-with-logs] failed to start ${label}: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearInterval(heartbeat);
  if (code === 0) {
    console.log(`[run-with-logs] done ${label}: elapsed=${formatSeconds()} ${memorySummary()}`);
    process.exit(0);
  }
  console.error(`[run-with-logs] failed ${label}: code=${code ?? 'null'} signal=${signal ?? 'null'} elapsed=${formatSeconds()} ${memorySummary()}`);
  process.exit(code ?? 1);
});
