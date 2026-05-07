import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(distDir, 'index.js');
type CliChild = ChildProcessByStdio<null, Readable, Readable>;
const children = new Set<CliChild>();

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
});

test('doctor creates installed runtime config and reports packaged wallet host assets', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-test-runtime-'));
  const result = runCli(['--runtime-dir', runtimeDir, 'doctor', '--json']);
  assert.equal(result.status, 0, result.stderr);

  const doctor = JSON.parse(result.stdout) as {
    runtimeDir?: string;
    configPath?: string;
    preparedActionsPath?: string;
    labArtifactsPath?: string;
    files?: {
      config?: boolean;
      preparedActionsDir?: boolean;
      labArtifactsDir?: boolean;
      walletHostAssets?: boolean;
    };
  };
  assert.equal(doctor.runtimeDir, runtimeDir);
  assert.equal(doctor.configPath, join(runtimeDir, 'agent-wallet.config.json'));
  assert.equal(doctor.preparedActionsPath, join(runtimeDir, 'prepared-actions.json'));
  assert.equal(doctor.labArtifactsPath, join(runtimeDir, 'lab-artifacts.json'));
  assert.equal(doctor.files?.config, true);
  assert.equal(doctor.files?.preparedActionsDir, true);
  assert.equal(doctor.files?.labArtifactsDir, true);
  assert.equal(doctor.files?.walletHostAssets, true);
});

test('wallet-host serve exposes health, static assets, SPA fallback, and rejects traversal', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-test-host-'));
  const walletHostUrl = `http://127.0.0.1:${await freePort()}`;
  const child = startCli(['--runtime-dir', runtimeDir, '--wallet-host-url', walletHostUrl, 'wallet-host', 'serve']);

  const health = await waitForJson(`${walletHostUrl}/__agentic/health`);
  assert.deepEqual(health, { ok: true, service: 'agentic-wallet-host' });

  const root = await fetch(walletHostUrl);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /<html/i);

  const fallback = await fetch(`${walletHostUrl}/nested/client/route`);
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /<html/i);

  const traversal = await fetch(`${walletHostUrl}/%2e%2e/package.json`);
  assert.equal(traversal.status, 404);

  const post = await fetch(walletHostUrl, { method: 'POST' });
  assert.equal(post.status, 405);

  await stopChild(child);
  assert.equal(child.stdout.read()?.toString() ?? '', '');
});

test('bridge start self-spawns a reachable bridge serve process', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-test-bridge-'));
  const configPath = join(runtimeDir, 'agent-wallet.config.json');
  const bridgeUrl = `http://127.0.0.1:${await freePort()}`;
  await writeFile(configPath, `${JSON.stringify(localnetConfig(), null, 2)}\n`, 'utf8');

  const result = runCli([
    '--runtime-dir',
    runtimeDir,
    '--config',
    configPath,
    '--bridge-url',
    bridgeUrl,
    'bridge',
    'start',
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const started = JSON.parse(result.stdout) as { started?: boolean; pid?: number };
  assert.equal(started.started, true);
  assert.equal(typeof started.pid, 'number');

  const health = await waitForJson(`${bridgeUrl}/bridge/health?token=local-agent-wallet`);
  assert.equal(health.cluster, 'localnet');
  assert.equal(health.preparedActionStorePath, join(runtimeDir, 'prepared-actions.json'));
  assert.equal(health.labArtifactStorePath, join(runtimeDir, 'lab-artifacts.json'));

  if (started.pid) {
    process.kill(started.pid, 'SIGTERM');
  }
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
    encoding: 'utf8',
  });
}

function startCli(args: string[]): CliChild {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  return child;
}

async function stopChild(child: CliChild): Promise<void> {
  if (!children.has(child)) {
    return;
  }
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolveStop) => {
    child.once('exit', () => resolveStop());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 1_500).unref();
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) {
          resolvePort(address.port);
        } else {
          rejectPort(new Error('Could not allocate test port.'));
        }
      });
    });
  });
}

async function waitForJson(url: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return JSON.parse(await response.text()) as Record<string, unknown>;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function localnetConfig(): Record<string, unknown> {
  return {
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
  };
}
