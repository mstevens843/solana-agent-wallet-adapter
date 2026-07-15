#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const ports = [8787, 5174];
const gracefulShutdownMs = 1500;

const listeners = await findListeners();
if (listeners.size === 0) {
  console.log(`[dev:stop] No local dev listeners found on ports ${ports.join(', ')}.`);
  process.exit(0);
}

const processTable = await readProcessTable();
const targets = selectTargets(listeners, processTable);
const targetLabels = formatTargets(targets);
console.log(`[dev:stop] Stopping ${targetLabels} for ports ${ports.join(', ')}...`);

signalTargets(targets, 'SIGCONT');
await delay(100);
signalTargets(targets, 'SIGTERM');
await delay(gracefulShutdownMs);

let remaining = await findListeners();
if (remaining.size > 0) {
  const fallbackTargets = selectTargets(remaining, await readProcessTable());
  console.log('[dev:stop] Some listeners did not exit after SIGTERM; sending SIGKILL...');
  signalTargets(fallbackTargets, 'SIGCONT');
  signalTargets(fallbackTargets, 'SIGKILL');
  await delay(250);
  remaining = await findListeners();
}

if (remaining.size > 0) {
  console.error(`[dev:stop] Failed to free ports ${ports.join(', ')}.`);
  for (const [port, pids] of remaining) {
    console.error(`[dev:stop] Port ${port} still held by PID(s): ${[...pids].join(', ')}`);
  }
  process.exit(1);
}

console.log(`[dev:stop] Freed ports ${ports.join(', ')}.`);

async function findListeners() {
  const result = new Map();
  for (const port of ports) {
    const output = await execFileText('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      allowFailure: true,
    });
    const pids = output
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (pids.length > 0) {
      result.set(port, new Set(pids));
    }
  }
  return result;
}

function selectTargets(listenersByPort, processTable) {
  const listenerPids = new Set([...listenersByPort.values()].flatMap((pids) => [...pids]));
  const groups = new Set();
  const pids = new Set();

  for (const pid of listenerPids) {
    const group = devProcessGroupFor(pid, processTable);
    if (group !== undefined) {
      groups.add(group);
    } else {
      pids.add(pid);
    }
  }

  for (const pid of listenerPids) {
    const processInfo = processTable.get(pid);
    if (processInfo && groups.has(processInfo.pgid)) {
      pids.delete(pid);
    }
  }

  return { groups, pids };
}

function devProcessGroupFor(pid, processTable) {
  const processInfo = processTable.get(pid);
  if (!processInfo) return undefined;
  if (processGroupLooksLikeDev(processInfo.pgid, processTable)) {
    return processInfo.pgid;
  }

  let current = processInfo;
  const visited = new Set();
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    if (isDevSupervisorCommand(current.command)) {
      return current.pgid;
    }
    current = processTable.get(current.ppid);
  }

  return undefined;
}

function processGroupLooksLikeDev(pgid, processTable) {
  for (const processInfo of processTable.values()) {
    if (processInfo.pgid === pgid && isDevSupervisorCommand(processInfo.command)) {
      return true;
    }
  }
  return false;
}

function isDevSupervisorCommand(command) {
  const normalized = command.trim();
  return (
    /\bnode\b.*\bscripts\/dev\.mjs\b/.test(normalized) ||
    /^npm run dev(?::mobile|:trace)?(?:\s|$)/.test(normalized)
  );
}

async function readProcessTable() {
  const output = await execFileText('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command='], {
    allowFailure: true,
  });
  const processes = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const [, pid, ppid, pgid, stat, command] = match;
    processes.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      stat,
      command,
    });
  }
  return processes;
}

function signalTargets(targets, signal) {
  for (const pgid of targets.groups) {
    sendSignal(-pgid, signal, `process group ${pgid}`);
  }
  for (const pid of targets.pids) {
    sendSignal(pid, signal, `PID ${pid}`);
  }
}

function sendSignal(target, signal, label) {
  try {
    process.kill(target, signal);
  } catch (err) {
    if (err?.code !== 'ESRCH') {
      console.error(`[dev:stop] Could not send ${signal} to ${label}: ${err.message}`);
    }
  }
}

function formatTargets(targets) {
  const labels = [
    ...[...targets.groups].map((pgid) => `process group ${pgid}`),
    ...[...targets.pids].map((pid) => `PID ${pid}`),
  ];
  return labels.join(', ');
}

function execFileText(command, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout.toString());
    });
  });
}
