import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
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

test('setup writes local runtime env aliases and redacts JSON status', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-test-setup-'));
  const envPath = join(runtimeDir, '.env');
  await writeFile(envPath, 'CUSTOM_VALUE=kept\n', 'utf8');
  const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=rpc-secret-value';
  const jupiterKey = 'jupiter-secret-value';
  const birdeyeKey = 'birdeye-secret-value';

  const result = runCli([
    '--runtime-dir',
    runtimeDir,
    'setup',
    '--rpc-url',
    rpcUrl,
    '--jupiter-api-key',
    jupiterKey,
    '--birdeye-api-key',
    birdeyeKey,
    '--yes',
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const setup = JSON.parse(result.stdout) as {
    rpcUrlConfigured?: boolean;
    rpcUrlRedacted?: string;
    jupiterApiKeyConfigured?: boolean;
    jupiterApiKeyRedacted?: string;
    birdeyeApiKeyConfigured?: boolean;
    birdeyeApiKeyRedacted?: string;
    swapsReady?: boolean;
    marketDataReady?: boolean;
  };
  assert.equal(setup.rpcUrlConfigured, true);
  assert.equal(setup.jupiterApiKeyConfigured, true);
  assert.equal(setup.birdeyeApiKeyConfigured, true);
  assert.equal(setup.swapsReady, true);
  assert.equal(setup.marketDataReady, true);
  assert.ok(!setup.rpcUrlRedacted?.includes('rpc-secret-value'));
  assert.ok(!setup.jupiterApiKeyRedacted?.includes('secret-value'));
  assert.ok(!setup.birdeyeApiKeyRedacted?.includes('secret-value'));

  const raw = await readFile(envPath, 'utf8');
  assert.match(raw, /CUSTOM_VALUE=kept/);
  assert.match(raw, /SOLANA_RPC_URL=https:\/\/mainnet\.helius-rpc\.com\/\?api-key=rpc-secret-value/);
  assert.match(raw, /HELIUS_RPC_URL=https:\/\/mainnet\.helius-rpc\.com\/\?api-key=rpc-secret-value/);
  assert.match(raw, /JUPITER_API_KEY=jupiter-secret-value/);
  assert.match(raw, /JUP_API_KEY=jupiter-secret-value/);
  assert.match(raw, /JUPITER_SWAP_BASE_URL=https:\/\/api\.jup\.ag\/swap\/v2/);
  assert.match(raw, /JUP_ULTRA_BASE=https:\/\/api\.jup\.ag\/swap\/v2/);
  assert.match(raw, /JUPITER_API_URL=https:\/\/quote-api\.jup\.ag/);
  assert.match(raw, /BIRDEYE_API_KEY=birdeye-secret-value/);
  assert.match(raw, /BIRDEYE_REST_BASE=https:\/\/public-api\.birdeye\.so/);
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
    '--token',
    'local-agent-wallet',
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

test('inbox list renders Blink prepared actions without raw transaction bytes', async () => {
  const bridge = await startMockBridge([blinkPreparedAction()]);
  try {
    const result = await runCliAsync(['--bridge-url', bridge.url, '--token', 'test-token', 'inbox', 'list']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Blink action/);
    assert.match(result.stdout, /Protocol: Meteora/);
    assert.match(result.stdout, /Operation: Claim fees/);
    assert.match(result.stdout, /Host: actions\.meteora\.ag/);
    assert.match(result.stdout, /Prepared Blink action\. Wallet approval required\./);
    assert.doesNotMatch(result.stdout, /transactionBase64/);
    assert.doesNotMatch(result.stdout, /base64-transaction/);
  } finally {
    await bridge.close();
  }
});

test('inbox inspect renders Blink detail fields and expected constraints', async () => {
  const bridge = await startMockBridge([blinkPreparedAction()]);
  try {
    const result = await runCliAsync(['--bridge-url', bridge.url, '--token', 'test-token', 'inbox', 'inspect', 'pa_blink']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Prepared Action pa_blink/);
    assert.match(result.stdout, /URL: https:\/\/actions\.meteora\.ag\/claim/);
    assert.match(result.stdout, /Expected: 1\.25 USDC to 9xRecipient/);
    assert.match(result.stdout, /Message: Review before signing/);
  } finally {
    await bridge.close();
  }
});

test('prepare blink calls bridge prepare route with connector metadata', async () => {
  const bridge = await startMockBridge([]);
  const walletHost = await startMockWalletHost();
  try {
    const result = await runCliAsync([
      '--bridge-url',
      bridge.url,
      '--wallet-host-url',
      walletHost.url,
      '--token',
      'test-token',
      'prepare',
      'blink',
      '--url',
      'https://actions.meteora.ag/claim',
      '--connector',
      'meteora',
      '--protocol',
      'Meteora',
      '--operation',
      'Claim fees',
      '--expected-amount',
      '1.25',
      '--expected-token',
      'USDC',
      '--expected-recipient',
      '9xRecipient',
      '--parameter',
      'position=dlmm-1',
      '--note',
      'Prepared from CLI test',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);

    const prepare = bridge.requests.find((request) => request.path === '/bridge/action/prepare-blink');
    assert.ok(prepare);
    assert.deepEqual(prepare.body, {
      blinkUrl: 'https://actions.meteora.ag/claim',
      connector: 'meteora',
      protocol: 'Meteora',
      operation: 'Claim fees',
      expectedAmount: '1.25',
      expectedToken: 'USDC',
      expectedRecipient: '9xRecipient',
      parameters: { position: 'dlmm-1' },
      note: 'Prepared from CLI test',
    });
  } finally {
    await bridge.close();
    await walletHost.close();
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

async function runCliAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      AGENT_WALLET_SKIP_OPEN: '1',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const status = await new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
  });
  return { status, stdout, stderr };
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

function blinkPreparedAction(): Record<string, unknown> {
  return {
    id: 'pa_blink',
    kind: 'blink_action',
    status: 'ready',
    walletAddress: '4fTqWallet',
    cluster: 'mainnet-beta',
    summary: 'Claim Meteora fees',
    params: {
      connectorId: 'meteora',
      protocol: 'Meteora',
      operation: 'Claim fees',
      blinkUrl: 'https://actions.meteora.ag/claim',
      actionUrl: 'https://actions.meteora.ag/claim',
      blinkMessage: 'Review before signing',
      expectedAmount: '1.25',
      expectedToken: 'USDC',
      expectedRecipient: '9xRecipient',
      transactionBase64: 'base64-transaction',
      connectorActionSource: 'blink',
    },
    dueAt: '2026-05-12T12:00:00.000Z',
    createdAt: '2026-05-12T12:00:00.000Z',
    updatedAt: '2026-05-12T12:00:00.000Z',
  };
}

async function startMockBridge(actions: Record<string, unknown>[]): Promise<{
  url: string;
  requests: Array<{ method: string; path: string; body: unknown }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = req.method === 'POST' ? await readRequestJson(req) : undefined;
      requests.push({ method: req.method ?? 'GET', path: url.pathname, body });
      if (url.pathname === '/bridge/health' || url.pathname === '/bridge/action/health') {
        writeJsonResponse(res, {
          walletConnected: true,
          walletAddress: '4fTqWallet',
          cluster: 'mainnet-beta',
        });
        return;
      }
      if (url.pathname === '/bridge/action/status') {
        writeJsonResponse(res, {
          connected: true,
          address: '4fTqWallet',
          cluster: 'mainnet-beta',
        });
        return;
      }
      if (url.pathname === '/bridge/prepared-actions') {
        writeJsonResponse(res, { actions });
        return;
      }
      if (url.pathname === '/bridge/prepared-actions/tx-status') {
        writeJsonResponse(res, { actions });
        return;
      }
      if (url.pathname === '/bridge/action/prepare-blink') {
        writeJsonResponse(res, {
          preparedAction: {
            ...blinkPreparedAction(),
            params: {
              ...(blinkPreparedAction().params as Record<string, unknown>),
              ...(isRecord(body) ? body : {}),
            },
          },
        });
        return;
      }
      writeJsonResponse(res, { error: 'not found' }, 404);
    })().catch((err) => {
      writeJsonResponse(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    });
  });
  const url = await listenHttp(server);
  return {
    url,
    requests,
    close: () => closeHttp(server),
  };
}

async function startMockWalletHost(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/__agentic/health') {
      writeJsonResponse(res, { ok: true, service: 'agentic-wallet-host' });
      return;
    }
    writeJsonResponse(res, { ok: true });
  });
  const url = await listenHttp(server);
  return {
    url,
    close: () => closeHttp(server),
  };
}

async function listenHttp(server: ReturnType<typeof createHttpServer>): Promise<string> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeHttp(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((err) => (err ? rejectClose(err) : resolveClose()));
  });
}

async function readRequestJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as unknown : {};
}

function writeJsonResponse(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(body)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
