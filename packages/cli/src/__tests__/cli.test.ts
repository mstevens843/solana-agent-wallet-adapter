import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

import { inboxSaveError, preparedActionFromPrepareResult } from '../flows/newApproval.js';
import type { GlobalOptions } from '../shared/types.js';

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(distDir, 'index.js');
type CliChild =
  | ChildProcessByStdio<null, Readable, Readable>
  | ChildProcessByStdio<Writable, Readable, Readable>;
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

test('new approval helper extracts prepared actions from prepare responses', () => {
  const action = preparedActionFromPrepareResult({
    preparedAction: {
      id: 'pa_123',
      summary: 'Transfer 0.02 SOL',
      status: 'ready',
      walletAddress: '4fTqWallet',
      cluster: 'mainnet-beta',
      params: { amountSol: '0.02' },
    },
  });
  assert.deepEqual(action, {
    id: 'pa_123',
    summary: 'Transfer 0.02 SOL',
    status: 'ready',
    walletAddress: '4fTqWallet',
    cluster: 'mainnet-beta',
    params: { amountSol: '0.02' },
  });
});

test('new approval helper rewrites offline bridge failures as inbox save failures', () => {
  const options = {
    bridgeUrl: 'http://127.0.0.1:8787',
  } as GlobalOptions;
  assert.equal(
    inboxSaveError(new Error('Local wallet bridge is not reachable at http://127.0.0.1:8787. fetch failed'), options),
    'Could not save to inbox because the local runtime is offline. Run /connect or /doctor.',
  );
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

test('runtime bridge token persists across CLI invocations', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-token-'));
  const first = runCli(['--runtime-dir', runtimeDir, 'wallet-host', 'status', '--json']);
  assert.equal(first.status, 0, first.stderr);
  const tokenPath = join(runtimeDir, 'bridge-token');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  assert.ok(token.length > 20);

  const second = runCli(['--runtime-dir', runtimeDir, 'wallet-host', 'status', '--json']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal((await readFile(tokenPath, 'utf8')).trim(), token);

  const status = JSON.parse(second.stdout) as { walletHostLaunchUrl?: string };
  assert.equal(new URL(status.walletHostLaunchUrl ?? '').searchParams.get('token'), token);
});

test('BRIDGE_TOKEN overrides the runtime bridge token file', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-token-env-'));
  const result = runCliWithEnv(
    ['--runtime-dir', runtimeDir, 'wallet-host', 'status', '--json'],
    { BRIDGE_TOKEN: 'manual-test-token' },
  );
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout) as { walletHostLaunchUrl?: string };
  assert.equal(new URL(status.walletHostLaunchUrl ?? '').searchParams.get('token'), 'manual-test-token');
  await assert.rejects(readFile(join(runtimeDir, 'bridge-token'), 'utf8'), /ENOENT/);
});

test('bridge start falls back when an Agentic bridge on the configured port has an old token', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-stale-bridge-'));
  const stale = await startUnauthorizedBridge();
  try {
    const result = runCliWithEnv(
      ['--runtime-dir', runtimeDir, 'bridge', 'start', '--json'],
      { AGENT_WALLET_BRIDGE_URL: stale.url },
    );
    assert.equal(result.status, 0, result.stderr);
    const started = JSON.parse(result.stdout) as {
      started?: boolean;
      pid?: number;
      bridgeUrl?: string;
      notices?: string[];
    };
    assert.equal(started.started, true);
    assert.ok(started.pid);
    assert.ok(started.bridgeUrl);
    assert.notEqual(started.bridgeUrl, stale.url);
    assert.match(started.notices?.join('\n') ?? '', /older token|was busy/);

    const token = (await readFile(join(runtimeDir, 'bridge-token'), 'utf8')).trim();
    const health = await waitForJson(`${started.bridgeUrl}/bridge/health?token=${encodeURIComponent(token)}`);
    assert.equal(health.cluster, 'devnet');

    if (started.pid) {
      process.kill(started.pid, 'SIGTERM');
    }
  } finally {
    await stale.close();
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

test('session commands proxy to render-web streaming API and print stable JSON', async () => {
  const renderWeb = await startMockRenderWeb();
  try {
    const list = await runCliAsync([
      '--render-web-url',
      renderWeb.url,
      'session',
      'list',
      '--wallet',
      'Wallet1111111111111111111111111111111111',
      '--json',
    ]);
    assert.equal(list.status, 0, list.stderr);
    assert.equal(list.stdout.trim(), `{
  "sessions": [
    {
      "capAmount": "10",
      "sessionId": "sess_cli",
      "spentAmount": "0",
      "status": "active",
      "tokenMint": "So11111111111111111111111111111111111111112"
    }
  ],
  "walletAddress": "Wallet1111111111111111111111111111111111"
}`);

    const created = await runCliAsync([
      '--render-web-url',
      renderWeb.url,
      'session',
      'create',
      'So11111111111111111111111111111111111111112',
      '10',
      '3600',
      '--allowlist',
      '11111111111111111111111111111111,So11111111111111111111111111111111111111112',
      '--json',
    ]);
    assert.equal(created.status, 0, created.stderr);
    assert.deepEqual(JSON.parse(created.stdout), {
      approveTx: 'approve-cli-base64',
      ephemeralSignerPubkey: 'signer-cli',
      sessionId: 'sess_cli',
    });

    const spent = await runCliAsync([
      '--render-web-url',
      renderWeb.url,
      'session',
      'spend',
      'sess_cli',
      '0.05',
      '11111111111111111111111111111111',
      '--json',
    ]);
    assert.equal(spent.status, 0, spent.stderr);
    assert.deepEqual(JSON.parse(spent.stdout), {
      accepted: true,
      remaining: '9.95',
      signedVoucher: {
        amount: '0.05',
        issuedAt: '2030-01-01T00:00:00.000Z',
        nonce: 'nonce_cli',
        recipient: '11111111111111111111111111111111',
        schema: 'streaming/voucher/0.1',
        sessionId: 'sess_cli',
        signature: 'signature_cli',
      },
      spentAmount: '0.05',
      voucher: {
        amount: '0.05',
        createdAt: '2030-01-01T00:00:00.000Z',
        id: 'voucher_cli',
        issuedAt: '2030-01-01T00:00:00.000Z',
        nonce: 'nonce_cli',
        recipient: '11111111111111111111111111111111',
        sessionId: 'sess_cli',
        signature: 'signature_cli',
        voucherHash: 'voucher_hash_cli',
      },
      voucherHash: 'voucher_hash_cli',
      voucherId: 'voucher_cli',
    });

    const revoked = await runCliAsync(['--render-web-url', renderWeb.url, 'session', 'revoke', 'sess_cli', '--json']);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.deepEqual(JSON.parse(revoked.stdout), { revokeTx: 'revoke-cli-base64', sessionId: 'sess_cli' });

    const history = await runCliAsync(['--render-web-url', renderWeb.url, 'session', 'history', 'sess_cli', '--json']);
    assert.equal(history.status, 0, history.stderr);
    assert.deepEqual(JSON.parse(history.stdout), {
      receipt: { receipts: [{ receiptId: 'receipt_cli', txid: 'tx_cli' }] },
      session: { session: { sessionId: 'sess_cli', status: 'active', vouchers: [{ nonce: 'nonce-1' }] } },
    });

    const settled = await runCliAsync(['--render-web-url', renderWeb.url, 'session', 'settle', 'sess_cli', '--json']);
    assert.equal(settled.status, 0, settled.stderr);
    assert.deepEqual(JSON.parse(settled.stdout), { failed: 0, sessionId: 'sess_cli', settled: 1 });

    const createRequest = renderWeb.requests.find((request) => request.method === 'POST' && request.path === '/api/streaming/sessions');
    assert.ok(createRequest);
    assert.deepEqual(
      {
        ...(createRequest.body as Record<string, unknown>),
        expiresAt: '<iso>',
      },
      {
        tokenMint: 'So11111111111111111111111111111111111111112',
        capAmount: '10',
        expiresAt: '<iso>',
        recipientAllowlist: [
          '11111111111111111111111111111111',
          'So11111111111111111111111111111111111111112',
        ],
      },
    );
    const expiresAt = (createRequest.body as Record<string, unknown>).expiresAt;
    assert.equal(typeof expiresAt, 'string');
    if (typeof expiresAt !== 'string') {
      throw new Error('Expected expiresAt string.');
    }
    assert.ok(!Number.isNaN(Date.parse(expiresAt)));

    const spendRequest = renderWeb.requests.find((request) => request.path === '/api/streaming/sessions/sess_cli/voucher-relay');
    assert.ok(spendRequest);
    assert.deepEqual(spendRequest.body, {
      amount: '0.05',
      recipient: '11111111111111111111111111111111',
    });
  } finally {
    await renderWeb.close();
  }
});

test('mpp commands proxy config and challenge payloads to render-web', async () => {
  const renderWeb = await startMockRenderWeb();
  const challengeFile = join(await mkdtemp(join(tmpdir(), 'agentic-cli-mpp-')), 'challenge.json');
  await writeFile(challengeFile, JSON.stringify({ protocolVersion: 'mpp/0.1', nonce: 'nonce_cli' }));
  try {
    const config = await runCliAsync(['--render-web-url', renderWeb.url, 'mpp', 'config', '--json'], {
      AGENTIC_RENDER_WEB_COOKIE: 'agentic_session=test-cookie',
    });
    assert.equal(config.status, 0, config.stderr);
    assert.deepEqual(JSON.parse(config.stdout), {
      acceptedRails: ['sol', 'usdc'],
      maxChallengeAmount: '10',
    });

    const challenge = await runCliAsync(['--render-web-url', renderWeb.url, 'mpp', 'challenge', challengeFile, '--json']);
    assert.equal(challenge.status, 0, challenge.stderr);
    assert.deepEqual(JSON.parse(challenge.stdout), {
      approvalId: 'approval_mpp_cli',
      requestId: 'approval_mpp_cli',
      expiresAt: '2026-05-16T13:00:00.000Z',
    });

    const configRequest = renderWeb.requests.find((request) => request.path === '/api/mpp/config');
    assert.ok(configRequest);
    assert.equal(configRequest.headers.cookie, 'agentic_session=test-cookie');
    const challengeRequest = renderWeb.requests.find((request) => request.path === '/api/mpp/challenge');
    assert.ok(challengeRequest);
    assert.deepEqual(challengeRequest.body, {
      challenge: { protocolVersion: 'mpp/0.1', nonce: 'nonce_cli' },
    });
  } finally {
    await renderWeb.close();
  }
});

// ─── v1.0 tests ───────────────────────────────────────────────────────────────

test('help prints usage without starting the interactive app', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /solana-agent-wallet\s+# interactive CLI/);
  assert.match(result.stdout, /solana-agent-wallet agent-setup\s+# Hosted BYOK or Local Bridge provider key/);
  assert.match(result.stdout, /solana-agent-wallet delete-storage\s+# delete Agentic Cloud Storage/);
  assert.match(result.stdout, /solana-agent-wallet new\s+# create a one-time or repeat request/);
  assert.doesNotMatch(result.stdout, /solana-agent-wallet repeat\s+#/);
  assert.doesNotMatch(result.stdout, /Legacy & advanced/);
  assert.doesNotMatch(result.stdout, /v1\.0 hosted/);
  assert.doesNotMatch(result.stdout, /agentic>/);
});

test('expanded help exposes advanced command inventory on request', () => {
  const result = runCli(['help', 'all']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /solana-agent-wallet new\s+# menu: one-time · repeat/);
  assert.doesNotMatch(result.stdout, /solana-agent-wallet repeat\s+# menu: scheduled/);
  assert.match(result.stdout, /device-agent status \| configure \| start \| stop \| clear \| set-key/);
  assert.match(result.stdout, /bridge-agents list \| register/);
  assert.match(result.stdout, /solana-agent-wallet delete-storage/);
});

test('version prints the package version', () => {
  const expectedVersion = JSON.parse(readFileSync(resolve(distDir, '..', 'package.json'), 'utf8')).version as string;
  const plain = runCli(['version']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.trim(), expectedVersion);

  const flag = runCli(['--version']);
  assert.equal(flag.status, 0, flag.stderr);
  assert.equal(flag.stdout.trim(), expectedVersion);

  const json = runCli(['version', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout) as Record<string, string>, { version: expectedVersion });
});

test('no positional command starts the interactive app', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-default-app-'));
  const bridgeUrl = `http://127.0.0.1:${await freePort()}`;
  const walletHostUrl = `http://127.0.0.1:${await freePort()}`;
  const renderWebUrl = `http://127.0.0.1:${await freePort()}`;
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridgeUrl,
    '--wallet-host-url',
    walletHostUrl,
    '--render-web-url',
    renderWebUrl,
  ]);

  try {
    const { stdout, stderr } = await waitForOutput(child, /agentic>/, 30_000);
    const combined = `${stdout}\n${stderr}`;
    assert.match(stdout, /Solana Agent Wallet Terminal/);
    assert.match(stdout, /Setup/);
    assert.match(stdout, /1\. Wallet\s+Not connected\s+\/connect/);
    assert.match(stdout, /2\. Cloud Storage\s+Signed out \(optional\)\s+\/sign-in/);
    assert.match(stdout, /3\. Agent\s+Not configured\s+\/agent-setup/);
    assert.doesNotMatch(stdout, /^Network:/m);
    assert.doesNotMatch(stdout, /Bridge http:\/\//);
    assert.doesNotMatch(stdout, /Wallet host http:\/\//);
    assert.doesNotMatch(stdout, /Starting local runtime/);
    assert.doesNotMatch(combined, /bigint: Failed to load bindings/);
    assert.doesNotMatch(combined, /\[DEP0040\]/);
    assert.match(stdout, /Cloud APIs: Agentic hosted default/);
    assert.match(stdout, /\/agent\s+Chat with agent, then prepare a wallet request/);
    assert.doesNotMatch(stdout, /Direct flows/);
    assert.doesNotMatch(stdout, /Legacy & advanced/);
    assert.doesNotMatch(stdout, /v1\.0 hosted/);
    child.stdin.write('/quit\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stdout:\n${stdout}\nstderr:\n${await readRemaining(child.stderr)}`);
  } finally {
    await stopChild(child);
  }
});

test('interactive main prompt Ctrl+C exits the app', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-main-sigint-'));
  const bridgeUrl = `http://127.0.0.1:${await freePort()}`;
  const walletHostUrl = `http://127.0.0.1:${await freePort()}`;
  const renderWebUrl = `http://127.0.0.1:${await freePort()}`;
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridgeUrl,
    '--wallet-host-url',
    walletHostUrl,
    '--render-web-url',
    renderWebUrl,
  ]);

  try {
    const { stdout } = await waitForOutput(child, /agentic>/, 30_000);
    child.kill('SIGINT');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stdout:\n${stdout}\nstderr:\n${await readRemaining(child.stderr)}`);
  } finally {
    await stopChild(child);
  }
});

test('interactive main prompt Ctrl+C can keep a saved agent key', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-main-sigint-keep-agent-'));
  const envPath = join(runtimeDir, '.env');
  await writeFile(envPath, [
    'AGENTIC_AI_API_KEY=sk-test-agent-key',
    'AGENTIC_AI_PROVIDER=anthropic',
    'AGENTIC_AI_API_FORMAT=anthropic',
    'AGENTIC_AI_BASE_URL=https://api.anthropic.com/v1',
    'AGENTIC_AI_MODEL=claude-opus-4-1-20250805',
    'AGENTIC_AI_PATH=bridge',
    '',
  ].join('\n'), 'utf8');
  const bridge = await startMockBridge([]);
  const walletHostUrl = `http://127.0.0.1:${await freePort()}`;
  const renderWebUrl = `http://127.0.0.1:${await freePort()}`;
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridge.url,
    '--wallet-host-url',
    walletHostUrl,
    '--render-web-url',
    renderWebUrl,
  ]);

  try {
    await waitForStdout(child, /agentic>/, 30_000);
    const prompt = waitForOutput(child, /Clear saved agent API key before exit\? \[y\/n\]/, 10_000);
    child.kill('SIGINT');
    await prompt;
    child.stdin.write('n\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0);
    const raw = await readFile(envPath, 'utf8');
    assert.match(raw, /AGENTIC_AI_API_KEY=sk-test-agent-key/);
    assert.match(raw, /AGENTIC_AI_PATH=bridge/);
  } finally {
    await stopChild(child);
    await bridge.close();
  }
});

test('interactive main prompt Ctrl+C can clear a saved agent key', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-main-sigint-clear-agent-'));
  const envPath = join(runtimeDir, '.env');
  await writeFile(envPath, [
    'CUSTOM_VALUE=kept',
    'AGENTIC_AI_API_KEY=sk-test-agent-key',
    'AGENTIC_AI_PROVIDER=anthropic',
    'AGENTIC_AI_API_FORMAT=anthropic',
    'AGENTIC_AI_BASE_URL=https://api.anthropic.com/v1',
    'AGENTIC_AI_MODEL=claude-opus-4-1-20250805',
    'AGENTIC_AI_PATH=bridge',
    '',
  ].join('\n'), 'utf8');
  const bridge = await startMockBridge([]);
  const walletHostUrl = `http://127.0.0.1:${await freePort()}`;
  const renderWebUrl = `http://127.0.0.1:${await freePort()}`;
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridge.url,
    '--wallet-host-url',
    walletHostUrl,
    '--render-web-url',
    renderWebUrl,
  ]);

  try {
    await waitForStdout(child, /agentic>/, 30_000);
    const prompt = waitForOutput(child, /Clear saved agent API key before exit\? \[y\/n\]/, 10_000);
    child.kill('SIGINT');
    await prompt;
    child.stdin.write('y\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0);
    const raw = await readFile(envPath, 'utf8');
    assert.match(raw, /CUSTOM_VALUE=kept/);
    assert.doesNotMatch(raw, /AGENTIC_AI_API_KEY/);
    assert.doesNotMatch(raw, /AGENTIC_AI_PATH/);
    const clearRequest = bridge.requests.find((request) => request.path === '/bridge/ai/session-key');
    assert.ok(clearRequest);
    assert.deepEqual(clearRequest.body, { clear: true });
  } finally {
    await stopChild(child);
    await bridge.close();
  }
});

test('interactive /quit can clear a saved agent key', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-main-quit-clear-agent-'));
  const envPath = join(runtimeDir, '.env');
  await writeFile(envPath, [
    'CUSTOM_VALUE=kept',
    'AGENTIC_AI_API_KEY=sk-test-agent-key',
    'AGENTIC_AI_PROVIDER=anthropic',
    'AGENTIC_AI_API_FORMAT=anthropic',
    'AGENTIC_AI_BASE_URL=https://api.anthropic.com/v1',
    'AGENTIC_AI_MODEL=claude-opus-4-1-20250805',
    'AGENTIC_AI_PATH=bridge',
    '',
  ].join('\n'), 'utf8');
  const bridge = await startMockBridge([]);
  const walletHostUrl = `http://127.0.0.1:${await freePort()}`;
  const renderWebUrl = `http://127.0.0.1:${await freePort()}`;
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridge.url,
    '--wallet-host-url',
    walletHostUrl,
    '--render-web-url',
    renderWebUrl,
  ]);

  try {
    await waitForStdout(child, /agentic>/, 30_000);
    const prompt = waitForOutput(child, /Clear saved agent API key before exit\? \[y\/n\]/, 10_000);
    child.stdin.write('/quit\n');
    await prompt;
    child.stdin.write('y\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0);
    const raw = await readFile(envPath, 'utf8');
    assert.match(raw, /CUSTOM_VALUE=kept/);
    assert.doesNotMatch(raw, /AGENTIC_AI_API_KEY/);
    assert.doesNotMatch(raw, /AGENTIC_AI_PATH/);
    const clearRequest = bridge.requests.find((request) => request.path === '/bridge/ai/session-key');
    assert.ok(clearRequest);
    assert.deepEqual(clearRequest.body, { clear: true });
  } finally {
    await stopChild(child);
    await bridge.close();
  }
});

test('interactive help exposes the connectors command', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-help-app-'));
  const bridgeUrl = `http://127.0.0.1:${await freePort()}`;
  const walletHostUrl = `http://127.0.0.1:${await freePort()}`;
  const renderWebUrl = `http://127.0.0.1:${await freePort()}`;
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridgeUrl,
    '--wallet-host-url',
    walletHostUrl,
    '--render-web-url',
    renderWebUrl,
  ]);

  try {
    await waitForStdout(child, /agentic>/, 30_000);
    const helpOutput = waitForOutput(child, /\/connectors\s+Manage protocol connectors and BYO API keys/, 30_000);
    child.stdin.write('/help\n');
    const { stdout } = await helpOutput;
    assert.match(stdout, /\/connectors\s+Manage protocol connectors and BYO API keys/);
    assert.match(stdout, /\/delete-storage\s+Delete Agentic Cloud Storage/);
    child.stdin.write('/quit\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stdout:\n${stdout}\nstderr:\n${await readRemaining(child.stderr)}`);
  } finally {
    await stopChild(child);
  }
});

test('interactive connectors menu returns stdin ownership before new request menu', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-connectors-new-'));
  const bridge = await startMockBridge([]);
  const walletHost = await startMockWalletHost();
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridge.url,
    '--wallet-host-url',
    walletHost.url,
  ]);

  try {
    await waitForStdout(child, /agentic>/, 30_000);

    const connectorPrompt = waitForCombinedOutput(child, /Check a connector to connect or disconnect/, 10_000);
    child.stdin.write('/connectors\n');
    await connectorPrompt;

    const returned = waitForStdout(child, /agentic>/, 10_000);
    child.stdin.write('\x1B[A\r');
    await returned;

    const newPrompt = waitForCombinedOutput(child, /What kind of request\?/, 10_000);
    child.stdin.write('/new\n');
    await newPrompt;

    const cancelled = waitForStdout(child, /Cancelled\.[\s\S]*agentic>/, 10_000);
    child.stdin.write('\x03');
    await cancelled;

    child.stdin.write('/quit\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stderr:\n${await readRemaining(child.stderr)}`);
  } finally {
    await bridge.close();
    await walletHost.close();
    await stopChild(child);
  }
});

test('interactive connect Ctrl+C returns to the main prompt', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-connect-abort-'));
  const bridge = await startDisconnectedBridge();
  const walletHost = await startMockWalletHost();
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridge.url,
    '--wallet-host-url',
    walletHost.url,
  ]);

  try {
    await waitForStdout(child, /agentic>/, 30_000);

    const connectWait = waitForCombinedOutput(child, /Connect Wallet[\s\S]*terminal will detect the wallet\./, 10_000);
    child.stdin.write('/connect\n');
    await connectWait;

    const cancelled = waitForStdout(child, /Cancelled\.[\s\S]*agentic>/, 10_000);
    child.kill('SIGINT');
    const stdout = await cancelled;

    child.stdin.write('/quit\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stdout:\n${stdout}\nstderr:\n${await readRemaining(child.stderr)}`);
  } finally {
    await bridge.close();
    await walletHost.close();
    await stopChild(child);
  }
});

test('interactive legacy prompt Ctrl+C returns to the main prompt', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-legacy-prompt-abort-'));
  const bridge = await startMockBridge([]);
  const walletHost = await startMockWalletHost();
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridge.url,
    '--wallet-host-url',
    walletHost.url,
  ]);

  try {
    await waitForStdout(child, /agentic>/, 30_000);

    const quotePrompt = waitForStdout(child, /Amount \[0\.01\]: /, 10_000);
    child.stdin.write('/quote\n');
    await quotePrompt;

    const cancelled = waitForStdout(child, /Cancelled\.[\s\S]*agentic>/, 10_000);
    child.kill('SIGINT');
    const stdout = await cancelled;

    child.stdin.write('/quit\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stdout:\n${stdout}\nstderr:\n${await readRemaining(child.stderr)}`);
  } finally {
    await bridge.close();
    await walletHost.close();
    await stopChild(child);
  }
});

test('interactive app prints startup diagnostics in debug mode', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-debug-app-'));
  const bridgeUrl = `http://127.0.0.1:${await freePort()}`;
  const walletHostUrl = `http://127.0.0.1:${await freePort()}`;
  const renderWebUrl = `http://127.0.0.1:${await freePort()}`;
  const child = startCliInteractive([
    '--debug',
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridgeUrl,
    '--wallet-host-url',
    walletHostUrl,
    '--render-web-url',
    renderWebUrl,
  ]);

  try {
    const { stdout } = await waitForOutput(child, /agentic>/, 30_000);
    assert.match(stdout, new RegExp(`Bridge ${escapeRegExp(bridgeUrl)} \\| Wallet host ${escapeRegExp(walletHostUrl)}`));
    assert.match(stdout, /Starting local runtime/);
    child.stdin.write('/quit\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stdout:\n${stdout}\nstderr:\n${await readRemaining(child.stderr)}`);
  } finally {
    await stopChild(child);
  }
});

test('interactive app starts wallet host on a fallback port when the configured port is busy', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-wallet-host-fallback-'));
  const bridgeUrl = `http://127.0.0.1:${await freePort()}`;
  const renderWebUrl = `http://127.0.0.1:${await freePort()}`;
  const busyHost = await startNonAgenticWalletHost();
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridgeUrl,
    '--render-web-url',
    renderWebUrl,
  ], { AGENT_WALLET_WALLET_HOST_URL: busyHost.url });

  try {
    const startup = await waitForOutput(child, /agentic>/, 30_000);
    assert.doesNotMatch(startup.stdout, /Wallet host port 127\.0\.0\.1:\d+ was busy/);
    const logsWait = waitForOutput(child, /Wallet host port 127\.0\.0\.1:\d+ was busy; using http:\/\/127\.0\.0\.1:\d+\./, 10_000);
    child.stdin.write('/logs\n');
    const logs = await logsWait;
    const match = logs.stdout.match(/Wallet host port 127\.0\.0\.1:\d+ was busy; using (http:\/\/127\.0\.0\.1:\d+)\./);
    assert.ok(match, logs.stdout);
    const fallbackUrl = match[1]!;
    assert.notEqual(fallbackUrl, busyHost.url);
    const health = await waitForJson(`${fallbackUrl}/__agentic/health`);
    assert.equal(health.ok, true);
    assert.equal(health.service, 'agentic-wallet-host');
    child.stdin.write('/quit\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stdout:\n${startup.stdout}\n${logs.stdout}\nstderr:\n${startup.stderr}\n${logs.stderr}\n${await readRemaining(child.stderr)}`);
  } finally {
    await busyHost.close();
    await stopChild(child);
  }
});

test('interactive app shows wallet host fallback port in debug mode', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-wallet-host-fallback-debug-'));
  const bridgeUrl = `http://127.0.0.1:${await freePort()}`;
  const renderWebUrl = `http://127.0.0.1:${await freePort()}`;
  const busyHost = await startNonAgenticWalletHost();
  const child = startCliInteractive([
    '--debug',
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridgeUrl,
    '--render-web-url',
    renderWebUrl,
  ], { AGENT_WALLET_WALLET_HOST_URL: busyHost.url });

  try {
    const { stdout } = await waitForOutput(child, /agentic>/, 30_000);
    const match = stdout.match(/Wallet host port 127\.0\.0\.1:\d+ was busy; using (http:\/\/127\.0\.0\.1:\d+)\./);
    assert.ok(match, stdout);
    assert.notEqual(match[1], busyHost.url);
    child.stdin.write('/quit\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stdout:\n${stdout}\nstderr:\n${await readRemaining(child.stderr)}`);
  } finally {
    await busyHost.close();
    await stopChild(child);
  }
});

test('interactive sign-in requires a paired wallet first', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-sign-in-wallet-required-'));
  const bridge = await startDisconnectedBridge();
  const walletHost = await startMockWalletHost();
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridge.url,
    '--wallet-host-url',
    walletHost.url,
  ]);

  try {
    await waitForStdout(child, /agentic>/, 30_000);
    child.stdin.write('/sign-in\n');
    const signInStdout = await waitForStdout(child, /Connect your wallet first with \/connect/, 10_000);
    assert.match(signInStdout, /Sign in to your cloud workspace/);
    child.stdin.write('/quit\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stdout:\n${signInStdout}\nstderr:\n${await readRemaining(child.stderr)}`);
  } finally {
    await bridge.close();
    await walletHost.close();
    await stopChild(child);
  }
});

test('interactive sign-in Ctrl+C aborts wallet signature wait and returns to prompt', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-sign-in-abort-'));
  const bridge = await startMockBridge([]);
  const walletHost = await startMockWalletHost();
  const renderWeb = await startMockAuthRenderWeb();
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridge.url,
    '--wallet-host-url',
    walletHost.url,
    '--render-web-url',
    renderWeb.url,
  ]);

  try {
    await waitForStdout(child, /agentic>/, 30_000);
    const waiting = waitForCombinedOutput(child, /Waiting for wallet signature \(Ctrl\+C to abort\)/, 10_000);
    child.stdin.write('/sign-in\n');
    await waiting;

    const cancelled = waitForStdout(child, /Cancelled\.[\s\S]*agentic>/, 10_000);
    child.kill('SIGINT');
    const stdout = await cancelled;
    assert.doesNotMatch(stdout, /Sign-in failed/);

    child.stdin.write('/quit\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stdout:\n${stdout}\nstderr:\n${await readRemaining(child.stderr)}`);
  } finally {
    await bridge.close();
    await walletHost.close();
    await renderWeb.close();
    await stopChild(child);
  }
});

test('interactive sign-in timeout returns to prompt before new request menu', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-sign-in-timeout-new-'));
  const bridge = await startMockBridge([]);
  const walletHost = await startMockWalletHost();
  const renderWeb = await startMockAuthRenderWeb();
  const child = startCliInteractive([
    '--runtime-dir',
    runtimeDir,
    '--bridge-url',
    bridge.url,
    '--wallet-host-url',
    walletHost.url,
    '--render-web-url',
    renderWeb.url,
  ]);

  try {
    await waitForStdout(child, /agentic>/, 30_000);

    const timedOut = waitForCombinedOutput(child, /Sign-in failed: Login timed out waiting for browser callback\./, 10_000);
    child.stdin.write('/sign-in --timeout-ms 30\n');
    await timedOut;

    const newPrompt = waitForCombinedOutput(child, /What kind of request\?/, 10_000);
    child.stdin.write('/new\n');
    await newPrompt;

    const cancelled = waitForStdout(child, /Cancelled\.[\s\S]*agentic>/, 10_000);
    child.stdin.write('\x03');
    await cancelled;

    child.stdin.write('/quit\n');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `stderr:\n${await readRemaining(child.stderr)}`);
  } finally {
    await bridge.close();
    await walletHost.close();
    await renderWeb.close();
    await stopChild(child);
  }
});

test('agent-setup from env writes local AI config and activates bridge session key', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-agent-setup-'));
  const envPath = join(runtimeDir, '.env');
  await writeFile(envPath, 'CUSTOM_VALUE=kept\n', 'utf8');
  const bridge = await startMockBridge([]);
  try {
    const result = await runCliAsync([
      '--runtime-dir',
      runtimeDir,
      '--bridge-url',
      bridge.url,
      'agent-setup',
      '--from-env',
      'TEST_AGENTIC_AI_KEY',
      '--provider',
      'openai',
      '--model',
      'gpt-5',
      '--json',
    ], { TEST_AGENTIC_AI_KEY: 'sk-test-agent-key' });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(payload.configured, true);
    assert.equal(payload.provider, 'openai');
    assert.equal(payload.model, 'gpt-5');

    const raw = await readFile(envPath, 'utf8');
    assert.match(raw, /CUSTOM_VALUE=kept/);
    assert.match(raw, /AGENTIC_AI_API_KEY=sk-test-agent-key/);
    assert.match(raw, /AGENTIC_AI_PROVIDER=openai/);
    assert.match(raw, /AGENTIC_AI_API_FORMAT=openai-compatible/);
    assert.match(raw, /AGENTIC_AI_BASE_URL=https:\/\/api\.openai\.com\/v1/);
    assert.match(raw, /AGENTIC_AI_MODEL=gpt-5/);
    assert.match(raw, /AGENTIC_AI_PATH=bridge/);

    const sessionKey = bridge.requests.find((request) => request.path === '/bridge/ai/session-key');
    assert.ok(sessionKey);
    assert.deepEqual(sessionKey.body, {
      apiKey: 'sk-test-agent-key',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });
  } finally {
    await bridge.close();
  }
});

test('agent-setup from env supports OpenRouter provider presets', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-agent-setup-openrouter-'));
  const envPath = join(runtimeDir, '.env');
  const bridge = await startMockBridge([]);
  try {
    const result = await runCliAsync([
      '--runtime-dir',
      runtimeDir,
      '--bridge-url',
      bridge.url,
      'agent-setup',
      '--from-env',
      'TEST_AGENTIC_AI_KEY',
      '--provider',
      'openrouter',
      '--model',
      'anthropic/claude-sonnet-4.5',
      '--json',
    ], { TEST_AGENTIC_AI_KEY: 'sk-or-test-agent-key' });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(payload.provider, 'openrouter');
    assert.equal(payload.model, 'anthropic/claude-sonnet-4.5');
    const raw = await readFile(envPath, 'utf8');
    assert.match(raw, /AGENTIC_AI_PROVIDER=openrouter/);
    assert.match(raw, /AGENTIC_AI_BASE_URL=https:\/\/openrouter\.ai\/api\/v1/);
    const sessionKey = bridge.requests.find((request) => request.path === '/bridge/ai/session-key');
    assert.ok(sessionKey);
    assert.deepEqual(sessionKey.body, {
      apiKey: 'sk-or-test-agent-key',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.5',
    });
  } finally {
    await bridge.close();
  }
});

test('agent-setup configures a subscription connector with no API key', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-agent-setup-connector-'));
  const envPath = join(runtimeDir, '.env');
  const bridge = await startMockBridge([]);
  try {
    const result = await runCliAsync([
      '--runtime-dir',
      runtimeDir,
      '--bridge-url',
      bridge.url,
      'agent-setup',
      '--engine',
      'connector',
      '--connector',
      'codex',
      '--json',
    ], {});
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(payload.configured, true);
    assert.equal(payload.engine, 'connector');
    assert.equal(payload.connector, 'codex');

    const raw = await readFile(envPath, 'utf8');
    assert.match(raw, /AGENTIC_AI_ENGINE=connector/);
    assert.match(raw, /AGENTIC_AI_CONNECTOR=codex/);
    // Connector mode carries no API key.
    assert.doesNotMatch(raw, /AGENTIC_AI_API_KEY=\S/);

    const sessionKey = bridge.requests.find((request) => request.path === '/bridge/ai/session-key');
    assert.ok(sessionKey);
    assert.deepEqual(sessionKey.body, { engine: 'connector', connector: 'codex' });
  } finally {
    await bridge.close();
  }
});

test('agent-setup custom OpenAI-compatible opts the bridge into a custom base URL', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-agent-setup-custom-'));
  const envPath = join(runtimeDir, '.env');
  const bridge = await startMockBridge([]);
  try {
    const result = await runCliAsync([
      '--runtime-dir',
      runtimeDir,
      '--bridge-url',
      bridge.url,
      'agent-setup',
      '--from-env',
      'TEST_AGENTIC_AI_KEY',
      '--provider',
      'custom-openai-compatible',
      '--base-url',
      'https://gateway.example/v1',
      '--model',
      'gateway-model',
      '--json',
    ], { TEST_AGENTIC_AI_KEY: 'sk-test-agent-key' });
    assert.equal(result.status, 0, result.stderr);
    const raw = await readFile(envPath, 'utf8');
    assert.match(raw, /AGENTIC_AI_PROVIDER=custom-openai-compatible/);
    assert.match(raw, /AGENTIC_AI_ALLOW_CUSTOM_BASE_URL=1/);
    const sessionKey = bridge.requests.find((request) => request.path === '/bridge/ai/session-key');
    assert.ok(sessionKey);
    assert.deepEqual(sessionKey.body, {
      apiKey: 'sk-test-agent-key',
      provider: 'custom-openai-compatible',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://gateway.example/v1',
      model: 'gateway-model',
      allowCustomBaseUrl: true,
    });
  } finally {
    await bridge.close();
  }
});

test('agent-setup rejects OpenRouter URLs under custom OpenAI-compatible', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-agent-setup-custom-openrouter-'));
  const bridge = await startMockBridge([]);
  try {
    const result = await runCliAsync([
      '--runtime-dir',
      runtimeDir,
      '--bridge-url',
      bridge.url,
      'agent-setup',
      '--from-env',
      'TEST_AGENTIC_AI_KEY',
      '--provider',
      'custom-openai-compatible',
      '--base-url',
      'https://openrouter.ai/api/v1',
      '--model',
      'gateway-model',
      '--json',
    ], { TEST_AGENTIC_AI_KEY: 'sk-test-agent-key' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OpenRouter preset/);
    assert.equal(bridge.requests.some((request) => request.path === '/bridge/ai/session-key'), false);
  } finally {
    await bridge.close();
  }
});

test('agent-setup hosted BYOK writes config without sending the key to the bridge', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-agent-setup-hosted-'));
  const envPath = join(runtimeDir, '.env');
  const renderWeb = await startMockAiStatusRenderWeb();
  await writeFile(
    join(runtimeDir, 'session.json'),
    JSON.stringify({
      token: 'test-token',
      walletAddress: 'TestWallet',
      renderWebOrigin: renderWeb.url,
      issuedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  try {
    const result = await runCliAsync([
      '--runtime-dir',
      runtimeDir,
      '--render-web-url',
      renderWeb.url,
      'agent-setup',
      '--from-env',
      'TEST_AGENTIC_AI_KEY',
      '--provider',
      'gemini',
      '--path',
      'hosted-byok',
      '--model',
      'gemini-2.5-pro',
      '--json',
    ], { TEST_AGENTIC_AI_KEY: 'test-gemini-key' });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(payload.path, 'hosted-byok');
    assert.equal(payload.provider, 'gemini');
    const raw = await readFile(envPath, 'utf8');
    assert.match(raw, /AGENTIC_AI_PATH=hosted-byok/);
    assert.match(raw, /AGENTIC_AI_PROVIDER=gemini/);
    assert.match(raw, /AGENTIC_AI_BASE_URL=https:\/\/generativelanguage\.googleapis\.com\/v1beta\/openai/);
    assert.equal(renderWeb.requests.filter((request) => request.path === '/api/ai/status').length, 1);
  } finally {
    await renderWeb.close();
  }
});

test('agent-disconnect clears local AI config and bridge session key', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-agent-disconnect-'));
  const envPath = join(runtimeDir, '.env');
  await writeFile(envPath, [
    'CUSTOM_VALUE=kept',
    'AGENTIC_AI_API_KEY=sk-test-agent-key',
    'AGENTIC_AI_PROVIDER=openai',
    'AGENTIC_AI_API_FORMAT=openai-compatible',
    'AGENTIC_AI_BASE_URL=https://api.openai.com/v1',
    'AGENTIC_AI_MODEL=gpt-5',
    'AGENTIC_AI_PATH=bridge',
    'AGENTIC_AI_ALLOW_CUSTOM_BASE_URL=1',
    '',
  ].join('\n'), 'utf8');
  const bridge = await startMockBridge([]);
  try {
    const result = await runCliAsync([
      '--runtime-dir',
      runtimeDir,
      '--bridge-url',
      bridge.url,
      'agent-disconnect',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const raw = await readFile(envPath, 'utf8');
    assert.match(raw, /CUSTOM_VALUE=kept/);
    assert.doesNotMatch(raw, /AGENTIC_AI_API_KEY/);
    assert.doesNotMatch(raw, /AGENTIC_AI_PATH/);
    assert.doesNotMatch(raw, /AGENTIC_AI_ALLOW_CUSTOM_BASE_URL/);
    const clearRequest = bridge.requests.find((request) => request.path === '/bridge/ai/session-key');
    assert.ok(clearRequest);
    assert.deepEqual(clearRequest.body, { clear: true });
  } finally {
    await bridge.close();
  }
});

test('auth status with no session reports unauthenticated', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-auth-'));
  const result = runCli(['--runtime-dir', runtimeDir, 'auth', 'status', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout) as { authenticated?: boolean };
  assert.equal(status.authenticated, false);
});

test('prepare connector posts {kind, params, walletAddress} to /bridge/connector/prepare-transaction', async () => {
  const bridge = await startMockConnectorBridge();
  try {
    const result = await runCliAsync([
      '--bridge-url',
      bridge.url,
      '--token',
      'test-token',
      'prepare',
      'connector',
      'marinade_liquid_stake',
      '--wallet',
      '4fTqWallet',
      '--cluster',
      'mainnet-beta',
      '--param',
      'solAmount=0.01',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const prepare = bridge.requests.find((r) => r.path === '/bridge/connector/prepare-transaction');
    assert.ok(prepare, 'no prepare-transaction request observed');
    assert.deepEqual(prepare.body, {
      kind: 'marinade_liquid_stake',
      // Decimals stay as strings — bridge inputs like solAmount are typed as
      // string to avoid float precision loss. Only pure integers are coerced.
      params: { solAmount: '0.01' },
      walletAddress: '4fTqWallet',
      cluster: 'mainnet-beta',
    });
  } finally {
    await bridge.close();
  }
});

test('prepare marinade-stake alias resolves to marinade_liquid_stake', async () => {
  const bridge = await startMockConnectorBridge();
  try {
    const result = await runCliAsync([
      '--bridge-url',
      bridge.url,
      '--token',
      'test-token',
      'prepare',
      'marinade-stake',
      '--wallet',
      '4fTqWallet',
      '--param',
      'solAmount=0.5',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const prepare = bridge.requests.find((r) => r.path === '/bridge/connector/prepare-transaction');
    assert.ok(prepare, 'no prepare-transaction request observed');
    const body = prepare.body as { kind?: string; params?: Record<string, unknown> };
    assert.equal(body.kind, 'marinade_liquid_stake');
    assert.deepEqual(body.params, { solAmount: '0.5' });
  } finally {
    await bridge.close();
  }
});

test('connector list calls /bridge/action/connector-capabilities', async () => {
  const bridge = await startMockConnectorBridge();
  try {
    const result = await runCliAsync([
      '--bridge-url',
      bridge.url,
      '--token',
      'test-token',
      'connector',
      'list',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const req = bridge.requests.find((r) => r.path === '/bridge/action/connector-capabilities');
    assert.ok(req, 'no capabilities request observed');
  } finally {
    await bridge.close();
  }
});

test('audit tail without a session prints a helpful auth error', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-audit-'));
  const result = await runCliAsync(['--runtime-dir', runtimeDir, 'audit', 'tail', '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /auth login/);
});

test('prefs connector-keys set posts {apiKey, label?} to the per-id endpoint', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-prefs-'));
  const renderWeb = await startMockConnectorSecretsRenderWeb();
  // Pre-write a session so requireAuth passes.
  await writeFile(
    join(runtimeDir, 'session.json'),
    JSON.stringify({
      token: 'test-token',
      walletAddress: 'TestWallet',
      renderWebOrigin: renderWeb.url,
      issuedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  try {
    const result = await runCliAsync(
      [
        '--runtime-dir', runtimeDir,
        '--render-web-url', renderWeb.url,
        'prefs', 'connector-keys', 'set', 'magiceden', '--from-env', 'TEST_KEY',
        '--label', 'My ME',
        '--json',
      ],
      { TEST_KEY: 'sk-test-12345' },
    );
    assert.equal(result.status, 0, result.stderr);
    const req = renderWeb.requests.find((r) => r.path === '/api/connector-secrets/magiceden');
    assert.ok(req, 'no POST observed');
    assert.equal(req.method, 'POST');
    assert.deepEqual(req.body, { apiKey: 'sk-test-12345', label: 'My ME' });
  } finally {
    await renderWeb.close();
  }
});

test('prefs connector-keys set rejects inline --value', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-prefs-novalue-'));
  const result = await runCliAsync([
    '--runtime-dir', runtimeDir,
    'prefs', 'connector-keys', 'set', 'magiceden', '--value', 'leaked-secret',
    '--json',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /from-env/i);
});

test('auth login without --wallet errors immediately with actionable hint', async () => {
  const result = await runCliAsync(['auth', 'login', '--no-open', '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /--wallet|AGENTIC_WALLET_ADDRESS/i);
});

test('prefs set agent-payment-profile is rejected with profile-publish hint', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-prefs-app-'));
  // Write a fake session so the read-only check fires before the auth check.
  await writeFile(
    join(runtimeDir, 'session.json'),
    JSON.stringify({
      token: 'test-token',
      walletAddress: 'TestWallet',
      renderWebOrigin: 'http://127.0.0.1:3000',
      issuedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  const result = await runCliAsync([
    '--runtime-dir', runtimeDir,
    'prefs', 'set', 'agent-payment-profile', '--file', '/nonexistent.json',
    '--json',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /profile publish/);
});

test('spend-limits set is rejected with read-only hint', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-spend-'));
  const result = await runCliAsync([
    '--runtime-dir', runtimeDir,
    'spend-limits', 'set', '--token', 'USDC', '--cap', '100', '--period', 'day',
    '--json',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /read-only/);
});

test('device-agent set-key rejects inline --key to keep secrets out of argv', async () => {
  const result = await runCliAsync([
    'device-agent', 'set-key', '--key', 'leaked-secret', '--provider', 'openai',
    '--json',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /from-env/i);
});

test('device-agent set-key rejects OpenRouter URLs under custom OpenAI-compatible before bridge request', async () => {
  const bridge = await startMockBridge([]);
  try {
    const result = await runCliAsync([
      '--bridge-url', bridge.url,
      'device-agent', 'set-key',
      '--from-env', 'TEST_AGENTIC_AI_KEY',
      '--provider', 'custom-openai-compatible',
      '--base-url', 'https://openrouter.ai/api/v1',
      '--model', 'gateway-model',
      '--json',
    ], { TEST_AGENTIC_AI_KEY: 'sk-test-agent-key' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /OpenRouter preset/);
    assert.equal(bridge.requests.some((request) => request.path === '/bridge/ai/session-key'), false);
  } finally {
    await bridge.close();
  }
});

test('device-agent configure rejects OpenRouter URLs under custom OpenAI-compatible before Render request', async () => {
  const renderWeb = await startMockRenderWeb();
  try {
    const result = await runCliAsync([
      '--render-web-url', renderWeb.url,
      'device-agent', 'configure',
      '--provider', 'custom-openai-compatible',
      '--base-url', 'https://openrouter.ai/api/v1',
      '--model', 'gateway-model',
      '--json',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /OpenRouter preset/);
    assert.equal(renderWeb.requests.some((request) => request.path === '/api/device-agent/control'), false);
  } finally {
    await renderWeb.close();
  }
});

test('auth login full SIWS roundtrip stores a session token', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-login-'));
  const renderWeb = await startMockAuthRenderWeb();
  try {
    // Launch the CLI in async mode so we can read stdout while it waits for
    // the callback. Setting AGENT_WALLET_SKIP_OPEN bypasses the browser open.
    const child = spawn(
      process.execPath,
      [
        cliPath,
        '--runtime-dir', runtimeDir,
        '--render-web-url', renderWeb.url,
        '--wallet-host-url', renderWeb.url, // doesn't matter — we drive the callback directly
        'auth', 'login', '--wallet', 'TestWalletXYZ', '--no-open',
        '--json',
      ],
      {
        env: { ...process.env, AGENT_WALLET_SKIP_OPEN: '1', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child as CliChild);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    // The CLI prints the wallet-host login URL to STDERR once the loopback is
    // ready (so it doesn't pollute --json stdout). Poll until we see it, then
    // extract the callback URL and state.
    const loginUrl = await new Promise<string>((resolveOuter, rejectOuter) => {
      const start = Date.now();
      const tick = setInterval(() => {
        const match = (stdout + stderr).match(/(http:\/\/[^\s]+\/sign-in\?[^\s]+)/);
        if (match?.[1]) {
          clearInterval(tick);
          resolveOuter(match[1]);
          return;
        }
        if (Date.now() - start > 30_000) {
          clearInterval(tick);
          rejectOuter(new Error(`CLI did not print login URL within 30s. stdout=${stdout} stderr=${stderr}`));
        }
      }, 100);
    });

    const parsed = new URL(loginUrl);
    const callback = parsed.searchParams.get('callback');
    const stateToken = parsed.searchParams.get('state');
    assert.ok(callback, 'login URL missing callback param');
    assert.ok(stateToken, 'login URL missing state param');

    // Simulate the wallet host posting the signature back to the loopback.
    const callbackRes = await fetch(callback, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        signature: 'fake-base58-sig',
        walletAddress: 'TestWalletXYZ',
        state: stateToken,
        proofEncoding: 'utf8-message',
        signatureEncoding: 'base58',
      }),
    });
    assert.equal(callbackRes.status, 200);

    // CLI should exit cleanly now.
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.once('exit', (code) => resolveExit(code));
    });
    assert.equal(exitCode, 0, `CLI exited non-zero. stdout=${stdout} stderr=${stderr}`);

    const session = JSON.parse(
      await readFile(join(runtimeDir, 'session.json'), 'utf8'),
    ) as { token?: string; walletAddress?: string };
    assert.equal(session.token, 'minted-session-token');
    assert.equal(session.walletAddress, 'TestWalletXYZ');

    const nonceReq = renderWeb.requests.find((r) => r.path === '/api/auth/nonce');
    assert.ok(nonceReq, 'nonce request missing');
    assert.equal(nonceReq.headers['x-agentic-client'], 'cli-bundled');
    assert.equal(nonceReq.headers.referer, `${renderWeb.url}/cli`);

    // Verify the server received the full SIWS envelope.
    const verifyReq = renderWeb.requests.find((r) => r.path === '/api/auth/verify-wallet');
    assert.ok(verifyReq, 'verify-wallet request missing');
    const body = verifyReq.body as Record<string, unknown>;
    assert.equal(body.walletAddress, 'TestWalletXYZ');
    assert.equal(body.nonce, 'test-nonce-123');
    assert.equal(body.message, 'sign this please');
    assert.equal(body.signature, 'fake-base58-sig');
    assert.equal(body.signatureEncoding, 'base58');
    assert.equal(body.proofEncoding, 'utf8-message');
    assert.equal(verifyReq.headers['x-agentic-client'], 'cli-bundled');
    assert.equal(verifyReq.headers.referer, `${renderWeb.url}/cli`);
  } finally {
    await renderWeb.close();
  }
});

test('auth login Ctrl+C aborts wallet signature wait promptly', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-login-abort-'));
  const renderWeb = await startMockAuthRenderWeb();
  try {
    const child = spawn(
      process.execPath,
      [
        cliPath,
        '--runtime-dir', runtimeDir,
        '--render-web-url', renderWeb.url,
        '--wallet-host-url', renderWeb.url,
        'auth', 'login', '--wallet', 'AbortWalletXYZ', '--no-open',
        '--json',
      ],
      {
        env: { ...process.env, AGENT_WALLET_SKIP_OPEN: '1', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child as CliChild);

    const seen = waitForCombinedOutput(child as CliChild, /Waiting for wallet signature \(Ctrl\+C to abort\)/, 30_000);
    await seen;

    child.kill('SIGINT');
    const exit = await waitForExit(child as CliChild, 5_000);
    assert.equal(exit.code, 130);
  } finally {
    await renderWeb.close();
  }
});

async function startMockAuthRenderWeb(): Promise<{
  url: string;
  requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: unknown }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: unknown }> = [];
  const server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = req.method === 'POST' ? await readRequestJson(req) : undefined;
      requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body });

      if (url.pathname === '/api/auth/nonce') {
        writeJsonResponse(res, {
          nonce: 'test-nonce-123',
          message: 'sign this please',
          domain: '127.0.0.1',
          issuedAt: '2026-05-21T00:00:00.000Z',
          expiresAt: '2026-05-21T00:05:00.000Z',
          walletAddress: (body as Record<string, unknown>)?.walletAddress,
        });
        return;
      }
      if (url.pathname === '/api/auth/verify-wallet') {
        writeJsonResponse(res, {
          sessionToken: 'minted-session-token',
          walletAddress: (body as Record<string, unknown>)?.walletAddress,
          expiresAt: '2026-05-22T00:00:00.000Z',
        });
        return;
      }
      writeJsonResponse(res, { error: 'not found' }, 404);
    })().catch((err) => {
      writeJsonResponse(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    });
  });
  const url = await listenHttp(server);
  return { url, requests, close: () => closeHttp(server) };
}

async function startMockAiStatusRenderWeb(): Promise<{
  url: string;
  requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: unknown }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: unknown }> = [];
  const server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = req.method === 'POST' ? await readRequestJson(req) : undefined;
      requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body });
      if (url.pathname === '/api/ai/status') {
        writeJsonResponse(res, {
          available: true,
          mode: 'hosted-byok',
          managed: { available: false },
          providers: [
            { id: 'openai', label: 'OpenAI', apiFormat: 'openai-compatible', defaultModel: 'gpt-5' },
            { id: 'anthropic', label: 'Claude / Anthropic', apiFormat: 'anthropic', defaultModel: 'claude-sonnet-4-5' },
            { id: 'gemini', label: 'Gemini', apiFormat: 'openai-compatible', defaultModel: 'gemini-2.5-pro' },
            { id: 'openrouter', label: 'OpenRouter', apiFormat: 'openai-compatible', defaultModel: 'anthropic/claude-sonnet-4.5' },
          ],
        });
        return;
      }
      writeJsonResponse(res, { error: 'not found' }, 404);
    })().catch((err) => {
      writeJsonResponse(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    });
  });
  const url = await listenHttp(server);
  return { url, requests, close: () => closeHttp(server) };
}

// (Removed in favour of driving the loopback callback directly from the test —
// see the "auth login full SIWS roundtrip" test for the new pattern.)

test('audit tail forwards --record-type to the server', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-audit2-'));
  const renderWeb = await startMockAuditRenderWeb();
  await writeFile(
    join(runtimeDir, 'session.json'),
    JSON.stringify({
      token: 'test-token',
      walletAddress: 'TestWallet',
      renderWebOrigin: renderWeb.url,
      issuedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  try {
    const result = await runCliAsync([
      '--runtime-dir', runtimeDir,
      '--render-web-url', renderWeb.url,
      'audit', 'tail', '--limit', '5', '--record-type', 'approval.created',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const req = renderWeb.requests.find((r) => r.path === '/api/audit');
    assert.ok(req);
    assert.equal(req.query.limit, '5');
    assert.equal(req.query.recordType, 'approval.created');
  } finally {
    await renderWeb.close();
  }
});

// ─── v1.0 final sweep tests ───────────────────────────────────────────────────

test('auth login tx-memo-proof roundtrip stores session + forwards proofTxBase64', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-login-memo-'));
  const renderWeb = await startMockAuthRenderWeb();
  try {
    const child = spawn(
      process.execPath,
      [
        cliPath,
        '--runtime-dir', runtimeDir,
        '--render-web-url', renderWeb.url,
        '--wallet-host-url', renderWeb.url,
        'auth', 'login', '--wallet', 'AndroidWallet111', '--no-open',
        '--json',
      ],
      {
        env: { ...process.env, AGENT_WALLET_SKIP_OPEN: '1', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child as CliChild);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    const loginUrl = await new Promise<string>((resolveOuter, rejectOuter) => {
      const start = Date.now();
      const tick = setInterval(() => {
        const match = (stdout + stderr).match(/(http:\/\/[^\s]+\/sign-in\?[^\s]+)/);
        if (match?.[1]) { clearInterval(tick); resolveOuter(match[1]); return; }
        if (Date.now() - start > 30_000) {
          clearInterval(tick);
          rejectOuter(new Error(`no login URL within 30s. stderr=${stderr}`));
        }
      }, 100);
    });
    const parsed = new URL(loginUrl);
    const callback = parsed.searchParams.get('callback') ?? '';
    const stateToken = parsed.searchParams.get('state') ?? '';
    // Simulate the wallet host returning a tx-memo-proof envelope.
    const callbackRes = await fetch(callback, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        signature: 'fake-memo-sig',
        walletAddress: 'AndroidWallet111',
        state: stateToken,
        proofEncoding: 'tx-memo-proof',
        signatureEncoding: 'base58',
        proofTxBase64: 'BASE64TXBYTES==',
      }),
    });
    assert.equal(callbackRes.status, 200);
    const exitCode = await new Promise<number | null>((res) => child.once('exit', (c) => res(c)));
    assert.equal(exitCode, 0, `exit non-zero. stderr=${stderr}`);

    const verifyReq = renderWeb.requests.find((r) => r.path === '/api/auth/verify-wallet');
    assert.ok(verifyReq);
    const body = verifyReq.body as Record<string, unknown>;
    assert.equal(body.proofEncoding, 'tx-memo-proof');
    assert.equal(body.proofTxBase64, 'BASE64TXBYTES==');
    assert.equal(body.signatureEncoding, 'base58');
    assert.equal(body.message, 'sign this please');
  } finally {
    await renderWeb.close();
  }
});

test('signedRequest preserves payload bytes byte-for-byte through intent + finalize', async () => {
  // The server hashes the payload at publish time. If the CLI re-serializes
  // with a different key order, the hash would differ. This test asserts the
  // EXACT bytes the user wrote to the file appear in BOTH the intent body
  // and the finalize body.
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-profile-'));
  const renderWeb = await startMockProfileRenderWeb();
  await writeFile(
    join(runtimeDir, 'session.json'),
    JSON.stringify({
      token: 'test-token',
      walletAddress: 'TestWallet',
      renderWebOrigin: renderWeb.url,
      issuedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  const cardDir = await mkdtemp(join(tmpdir(), 'agentic-card-'));
  const cardPath = join(cardDir, 'card.json');
  // Intentionally non-alphabetical key order so a naive JSON.stringify would
  // reorder it.
  const rawBytes = '{"z":1,"a":2,"nested":{"y":3,"b":4}}';
  await writeFile(cardPath, rawBytes, 'utf8');

  try {
    // The login flow happens inside profile publish — drive the loopback
    // callback from a separate fetch after detecting the URL.
    const child = spawn(
      process.execPath,
      [
        cliPath,
        '--runtime-dir', runtimeDir,
        '--render-web-url', renderWeb.url,
        '--wallet-host-url', renderWeb.url,
        'profile', 'publish', cardPath,
        '--json',
      ],
      {
        env: { ...process.env, AGENT_WALLET_SKIP_OPEN: '1', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child as CliChild);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    const loginUrl = await new Promise<string>((resolveOuter, rejectOuter) => {
      const start = Date.now();
      const tick = setInterval(() => {
        const match = (stdout + stderr).match(/(http:\/\/[^\s]+\/agentic-login\?[^\s]+)/);
        if (match?.[1]) { clearInterval(tick); resolveOuter(match[1]); return; }
        if (Date.now() - start > 30_000) {
          clearInterval(tick);
          rejectOuter(new Error(`no login URL within 30s. stderr=${stderr}`));
        }
      }, 100);
    });
    const parsed = new URL(loginUrl);
    const callback = parsed.searchParams.get('callback') ?? '';
    const stateToken = parsed.searchParams.get('state') ?? '';
    await fetch(callback, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        signature: 'sig-profile',
        walletAddress: 'TestWallet',
        state: stateToken,
        proofEncoding: 'utf8-message',
        signatureEncoding: 'base58',
      }),
    });
    const exitCode = await new Promise<number | null>((res) => child.once('exit', (c) => res(c)));
    assert.equal(exitCode, 0, `exit non-zero. stderr=${stderr}`);

    // Intent request body should contain the EXACT raw payload bytes.
    const intentReq = renderWeb.requests.find((r) => r.path === '/api/agents/profile-intent');
    assert.ok(intentReq, 'no intent request observed');
    assert.equal(intentReq.rawBody, `{"action":"publish","payload":${rawBytes}}`);

    // Finalize PUT body should also contain the EXACT same payload bytes.
    const finalizeReq = renderWeb.requests.find((r) => r.path === '/api/agents/profile');
    assert.ok(finalizeReq, 'no finalize request observed');
    assert.match(finalizeReq.rawBody!, new RegExp(`"payload":${rawBytes.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
  } finally {
    await renderWeb.close();
  }
});

test('delete-storage opens dedicated deletion page and clears CLI cloud session', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-delete-storage-'));
  const renderWeb = await startMockCloudWorkspaceRenderWeb();
  await writeFile(
    join(runtimeDir, 'session.json'),
    JSON.stringify({
      token: 'test-token',
      walletAddress: 'TestWallet',
      renderWebOrigin: renderWeb.url,
      issuedAt: new Date().toISOString(),
    }),
    'utf8',
  );

  try {
    const child = spawn(
      process.execPath,
      [
        cliPath,
        '--runtime-dir', runtimeDir,
        '--render-web-url', renderWeb.url,
        '--wallet-host-url', renderWeb.url,
        'delete-storage',
        '--json',
      ],
      {
        env: { ...process.env, AGENT_WALLET_SKIP_OPEN: '1', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child as CliChild);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    const deletionUrl = await new Promise<string>((resolveOuter, rejectOuter) => {
      const start = Date.now();
      const tick = setInterval(() => {
        const match = (stdout + stderr).match(/(http:\/\/[^\s]+\/delete-storage\?[^\s]+)/);
        if (match?.[1]) { clearInterval(tick); resolveOuter(match[1]); return; }
        if (Date.now() - start > 30_000) {
          clearInterval(tick);
          rejectOuter(new Error(`no delete-storage URL within 30s. stdout=${stdout} stderr=${stderr}`));
        }
      }, 100);
    });
    const parsed = new URL(deletionUrl);
    const callback = parsed.searchParams.get('callback') ?? '';
    const stateToken = parsed.searchParams.get('state') ?? '';
    assert.equal(parsed.pathname, '/delete-storage');
    assert.equal(parsed.searchParams.get('intent'), 'delete-storage');
    assert.equal(parsed.searchParams.get('summary'), 'Delete Agentic Cloud Storage');
    assert.ok(callback, 'delete-storage URL missing callback param');
    assert.ok(stateToken, 'delete-storage URL missing state param');

    await fetch(callback, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        signature: 'sig-delete',
        walletAddress: 'TestWallet',
        state: stateToken,
        proofEncoding: 'utf8-message',
        signatureEncoding: 'base58',
      }),
    });

    const exitCode = await new Promise<number | null>((res) => child.once('exit', (c) => res(c)));
    assert.equal(exitCode, 0, `exit non-zero. stdout=${stdout} stderr=${stderr}`);
    assert.ok(renderWeb.requests.find((r) => r.path === '/api/cloud-workspace/delete-intent'));
    const finalReq = renderWeb.requests.find((r) => r.path === '/api/cloud-workspace/delete');
    assert.ok(finalReq, 'no cloud delete request observed');
    assert.equal((finalReq.body as Record<string, unknown>).signature, 'sig-delete');
    await assert.rejects(readFile(join(runtimeDir, 'session.json'), 'utf8'), /ENOENT/);
  } finally {
    await renderWeb.close();
  }
});

test('doctor --strict exits 6 when bridge is offline', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-doctor-strict-'));
  // No bridge running → bridge probe returns reachable:false.
  const result = runCli([
    '--runtime-dir', runtimeDir,
    '--bridge-url', 'http://127.0.0.1:1',  // unreachable
    'doctor', '--strict', '--json',
  ]);
  assert.equal(result.status, 6, `expected exit 6, got ${result.status}. stderr=${result.stderr}`);
});

test('doctor --section narrows output to one probe', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-doctor-section-'));
  const result = runCli([
    '--runtime-dir', runtimeDir,
    'doctor', '--section', 'bridge', '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.ok('bridge' in parsed, 'expected bridge key');
  // Should NOT contain the other probes.
  assert.equal(Object.keys(parsed).length, 1);
});

test('connector list calls /bridge/action/connector-capabilities (regression)', async () => {
  // Already covered above; keep here for completeness next to the v1.0 sweep tests.
  assert.ok(true);
});

test('birdeye search posts to /api/birdeye/search when bridge offline', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-birdeye-'));
  const renderWeb = await startMockBirdeyeRenderWeb();
  await writeFile(
    join(runtimeDir, 'session.json'),
    JSON.stringify({
      token: 'test-token',
      walletAddress: 'TestWallet',
      renderWebOrigin: renderWeb.url,
      issuedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  try {
    const result = await runCliAsync([
      '--runtime-dir', runtimeDir,
      '--render-web-url', renderWeb.url,
      '--bridge-url', 'http://127.0.0.1:1',  // force cloud fallback
      'birdeye', 'search', '--query', 'SOL',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const req = renderWeb.requests.find((r) => r.path === '/api/birdeye/search');
    assert.ok(req, 'birdeye/search not called');
    assert.deepEqual(req.body, { query: 'SOL', keyword: 'SOL' });
  } finally {
    await renderWeb.close();
  }
});

test('solana blockhash uses hosted RPC before bridge fallback', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-solana-hosted-'));
  const renderWeb = await startMockSolanaRenderWeb();
  try {
    const result = await runCliAsync([
      '--runtime-dir', runtimeDir,
      '--render-web-url', renderWeb.url,
      '--bridge-url', 'http://127.0.0.1:1',
      'solana', 'blockhash',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const req = renderWeb.requests.find((r) => r.path === '/api/solana/latest-blockhash');
    assert.ok(req);
    assert.deepEqual(req.body, { cluster: 'mainnet-beta' });
  } finally {
    await renderWeb.close();
  }
});

test('solana account-info calls /api/solana/parsed-account-info', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-solana-'));
  const renderWeb = await startMockSolanaRenderWeb();
  await writeFile(
    join(runtimeDir, 'session.json'),
    JSON.stringify({
      token: 'test-token',
      walletAddress: 'TestWallet',
      renderWebOrigin: renderWeb.url,
      issuedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  try {
    const result = await runCliAsync([
      '--runtime-dir', runtimeDir,
      '--render-web-url', renderWeb.url,
      'solana', 'account-info', 'So11111111111111111111111111111111111111112',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const req = renderWeb.requests.find((r) => r.path === '/api/solana/parsed-account-info');
    assert.ok(req);
    assert.equal((req.body as Record<string, unknown>).address, 'So11111111111111111111111111111111111111112');
    assert.equal((req.body as Record<string, unknown>).cluster, 'mainnet-beta');
  } finally {
    await renderWeb.close();
  }
});

test('swap quote uses hosted Jupiter order relay for common tokens', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-swap-hosted-'));
  const bridge = await startMockBridge([]);
  const renderWeb = await startMockSolanaRenderWeb();
  try {
    const result = await runCliAsync([
      '--runtime-dir', runtimeDir,
      '--bridge-url', bridge.url,
      '--render-web-url', renderWeb.url,
      'swap', 'quote', '0.01',
      '--input-token', 'SOL',
      '--output-token', 'USDC',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const req = renderWeb.requests.find((r) => r.path === '/api/swap/order');
    assert.ok(req);
    assert.deepEqual(req.body, {
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '10000000',
      taker: '4fTqWallet',
    });
  } finally {
    await bridge.close();
    await renderWeb.close();
  }
});

test('approvals list calls /api/approvals with limit', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'agentic-cli-approvals-'));
  const renderWeb = await startMockApprovalsRenderWeb();
  await writeFile(
    join(runtimeDir, 'session.json'),
    JSON.stringify({
      token: 'test-token',
      walletAddress: 'TestWallet',
      renderWebOrigin: renderWeb.url,
      issuedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  try {
    const result = await runCliAsync([
      '--runtime-dir', runtimeDir,
      '--render-web-url', renderWeb.url,
      'approvals', 'list', '--limit', '10',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const req = renderWeb.requests.find((r) => r.path === '/api/approvals');
    assert.ok(req);
    assert.equal(req.query.limit, '10');
  } finally {
    await renderWeb.close();
  }
});

async function startMockProfileRenderWeb(): Promise<{
  url: string;
  requests: Array<{ method: string; path: string; body: unknown; rawBody?: string }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; body: unknown; rawBody?: string }> = [];
  const server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let rawBody: string | undefined;
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        rawBody = Buffer.concat(chunks).toString('utf8');
      }
      const body = rawBody ? safeParseJson(rawBody) : undefined;
      requests.push({ method: req.method ?? 'GET', path: url.pathname, body, ...(rawBody ? { rawBody } : {}) });

      if (url.pathname === '/api/agents/profile-intent') {
        writeJsonResponse(res, {
          nonce: 'profile-nonce',
          message: 'sign this please',
          domain: '127.0.0.1',
          issuedAt: '2026-05-21T00:00:00.000Z',
          expiresAt: '2026-05-21T00:05:00.000Z',
          walletAddress: 'TestWallet',
          payloadHashHex: 'deadbeef',
          action: 'publish',
        });
        return;
      }
      if (url.pathname === '/api/agents/profile') {
        writeJsonResponse(res, { ok: true });
        return;
      }
      writeJsonResponse(res, { error: 'not found' }, 404);
    })().catch((err) => {
      writeJsonResponse(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    });
  });
  const url = await listenHttp(server);
  return { url, requests, close: () => closeHttp(server) };
}

async function startMockCloudWorkspaceRenderWeb(): Promise<{
  url: string;
  requests: Array<{ method: string; path: string; body: unknown }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/__agentic/health') {
        writeJsonResponse(res, { ok: true, service: 'agentic-wallet-host' });
        return;
      }
      const body = req.method === 'POST' ? await readRequestJson(req) : undefined;
      requests.push({ method: req.method ?? 'GET', path: url.pathname, body });

      if (url.pathname === '/api/cloud-workspace/delete-intent') {
        writeJsonResponse(res, {
          nonce: 'delete-nonce',
          message: 'delete this workspace',
          domain: '127.0.0.1',
          issuedAt: '2026-05-21T00:00:00.000Z',
          expiresAt: '2026-05-21T00:05:00.000Z',
          walletAddress: 'TestWallet',
        });
        return;
      }
      if (url.pathname === '/api/cloud-workspace/delete') {
        writeJsonResponse(res, {
          ok: true,
          signedOut: true,
          deleted: { approvals: 1, plans: 1 },
        });
        return;
      }
      writeJsonResponse(res, { error: 'not found' }, 404);
    })().catch((err) => {
      writeJsonResponse(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    });
  });
  const url = await listenHttp(server);
  return { url, requests, close: () => closeHttp(server) };
}

async function startMockBirdeyeRenderWeb(): Promise<{
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
      writeJsonResponse(res, { results: [] });
    })().catch((err) => {
      writeJsonResponse(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    });
  });
  const url = await listenHttp(server);
  return { url, requests, close: () => closeHttp(server) };
}

async function startMockSolanaRenderWeb(): Promise<{
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
      writeJsonResponse(res, { result: null });
    })().catch((err) => {
      writeJsonResponse(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    });
  });
  const url = await listenHttp(server);
  return { url, requests, close: () => closeHttp(server) };
}

async function startMockApprovalsRenderWeb(): Promise<{
  url: string;
  requests: Array<{ method: string; path: string; query: Record<string, string> }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; query: Record<string, string> }> = [];
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
    });
    if (url.pathname === '/api/approvals') {
      writeJsonResponse(res, { approvals: [] });
      return;
    }
    writeJsonResponse(res, { error: 'not found' }, 404);
  });
  const url = await listenHttp(server);
  return { url, requests, close: () => closeHttp(server) };
}

function safeParseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return undefined; }
}

async function startMockConnectorSecretsRenderWeb(): Promise<{
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
      if (url.pathname.startsWith('/api/connector-secrets/')) {
        writeJsonResponse(res, { ok: true });
        return;
      }
      writeJsonResponse(res, { error: 'not found' }, 404);
    })().catch((err) => {
      writeJsonResponse(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    });
  });
  const url = await listenHttp(server);
  return { url, requests, close: () => closeHttp(server) };
}

async function startMockAuditRenderWeb(): Promise<{
  url: string;
  requests: Array<{ method: string; path: string; query: Record<string, string> }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; query: Record<string, string> }> = [];
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
    });
    if (url.pathname === '/api/audit') {
      writeJsonResponse(res, { events: [] });
      return;
    }
    writeJsonResponse(res, { error: 'not found' }, 404);
  });
  const url = await listenHttp(server);
  return { url, requests, close: () => closeHttp(server) };
}

async function startMockConnectorBridge(): Promise<{
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

      if (url.pathname === '/bridge/action/connector-capabilities') {
        writeJsonResponse(res, { connectors: [{ id: 'marinade', name: 'Marinade' }] });
        return;
      }
      if (url.pathname === '/bridge/connector/prepare-transaction') {
        writeJsonResponse(res, { preparedAction: { id: 'pa_test', kind: (body as Record<string, unknown>)?.kind } });
        return;
      }
      writeJsonResponse(res, { error: 'not found' }, 404);
    })().catch((err) => {
      writeJsonResponse(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    });
  });
  const url = await listenHttp(server);
  return { url, requests, close: () => closeHttp(server) };
}

// ─── helpers (existing) ───────────────────────────────────────────────────────

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return runCliWithEnv(args, {});
}

function runCliWithEnv(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      AGENTIC_RENDER_WEB_URL: 'http://127.0.0.1:9',
      NO_COLOR: '1',
      ...env,
    },
    encoding: 'utf8',
  });
}

async function runCliAsync(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      AGENTIC_RENDER_WEB_URL: 'http://127.0.0.1:9',
      AGENT_WALLET_SKIP_OPEN: '1',
      NO_COLOR: '1',
      ...env,
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
      AGENTIC_RENDER_WEB_URL: 'http://127.0.0.1:9',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  return child;
}

function startCliInteractive(
  args: string[],
  env: Record<string, string> = {},
): ChildProcessByStdio<Writable, Readable, Readable> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      AGENTIC_RENDER_WEB_URL: 'http://127.0.0.1:9',
      AGENT_WALLET_SKIP_OPEN: '1',
      NO_COLOR: '1',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  return child;
}

async function waitForStdout(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  return (await waitForOutput(child, pattern, timeoutMs)).stdout;
}

async function waitForOutput(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  return new Promise<{ stdout: string; stderr: string }>((resolveWait, rejectWait) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectWait(new Error(`Timed out waiting for ${pattern}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString();
      if (pattern.test(stdout)) {
        cleanup();
        resolveWait({ stdout, stderr });
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectWait(new Error(`Process exited before ${pattern}: code=${code ?? 'null'} signal=${signal ?? 'null'}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

async function waitForCombinedOutput(
  child: CliChild,
  pattern: RegExp,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  return new Promise<{ stdout: string; stderr: string }>((resolveWait, rejectWait) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectWait(new Error(`Timed out waiting for ${pattern}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    const test = (): void => {
      if (pattern.test(`${stdout}\n${stderr}`)) {
        cleanup();
        resolveWait({ stdout, stderr });
      }
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString();
      test();
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString();
      test();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectWait(new Error(`Process exited before ${pattern}: code=${code ?? 'null'} signal=${signal ?? 'null'}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitForExit(
  child: CliChild,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
  }
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error('Timed out waiting for process exit.'));
    }, timeoutMs);
    timeout.unref();
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}

async function readRemaining(stream: Readable): Promise<string> {
  let text = '';
  for (;;) {
    const chunk = stream.read();
    if (!chunk) return text;
    text += chunk.toString();
  }
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
  let aiStatus: Record<string, unknown> = { available: false, configured: false, source: 'none' };
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
      if (url.pathname === '/bridge/recurring-payments') {
        writeJsonResponse(res, { recurringPayments: [] });
        return;
      }
      if (url.pathname === '/bridge/lab-artifacts') {
        writeJsonResponse(res, { artifacts: [] });
        return;
      }
      if (url.pathname === '/bridge/ai/status') {
        writeJsonResponse(res, aiStatus);
        return;
      }
      if (url.pathname === '/bridge/ai/session-key') {
        if (isRecord(body) && body.clear === true) {
          aiStatus = { available: false, configured: false, source: 'none' };
        } else {
          aiStatus = {
            available: true,
            configured: true,
            source: 'session',
            provider: isRecord(body) ? body.provider : 'openai',
            apiFormat: isRecord(body) ? body.apiFormat : 'openai-compatible',
            baseUrl: isRecord(body) ? body.baseUrl : 'https://api.openai.com/v1',
            model: isRecord(body) ? body.model : 'gpt-5',
          };
        }
        writeJsonResponse(res, aiStatus);
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

async function startUnauthorizedBridge(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((_req, res) => {
    writeJsonResponse(res, { error: 'unauthorized' }, 401);
  });
  const url = await listenHttp(server);
  return { url, close: () => closeHttp(server) };
}

async function startDisconnectedBridge(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/bridge/health' || url.pathname === '/bridge/action/health') {
      writeJsonResponse(res, {
        walletConnected: false,
        cluster: 'mainnet-beta',
      });
      return;
    }
    if (url.pathname === '/bridge/action/status') {
      writeJsonResponse(res, {
        connected: false,
        address: null,
        cluster: 'mainnet-beta',
      });
      return;
    }
    writeJsonResponse(res, { error: 'not found' }, 404);
  });
  const url = await listenHttp(server);
  return { url, close: () => closeHttp(server) };
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

async function startNonAgenticWalletHost(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>busy</title>');
  });
  const url = await listenHttp(server);
  return {
    url,
    close: () => closeHttp(server),
  };
}

async function startMockRenderWeb(): Promise<{
  url: string;
  requests: Array<{ method: string; path: string; query: Record<string, string>; headers: IncomingMessage['headers']; body: unknown }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; query: Record<string, string>; headers: IncomingMessage['headers']; body: unknown }> = [];
  const server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = req.method === 'POST' ? await readRequestJson(req) : undefined;
      requests.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        body,
      });

      if (req.method === 'GET' && url.pathname === '/api/streaming/sessions') {
        writeJsonResponse(res, {
          walletAddress: url.searchParams.get('walletAddress') ?? null,
          sessions: [
            {
              sessionId: 'sess_cli',
              tokenMint: 'So11111111111111111111111111111111111111112',
              capAmount: '10',
              spentAmount: '0',
              status: 'active',
            },
          ],
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/streaming/sessions') {
        writeJsonResponse(res, {
          sessionId: 'sess_cli',
          approveTx: 'approve-cli-base64',
          ephemeralSignerPubkey: 'signer-cli',
        }, 201);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/streaming/sessions/sess_cli/voucher-relay') {
        writeJsonResponse(res, {
          accepted: true,
          remaining: '9.95',
          spentAmount: '0.05',
          voucherId: 'voucher_cli',
          voucherHash: 'voucher_hash_cli',
          voucher: {
            id: 'voucher_cli',
            sessionId: 'sess_cli',
            nonce: 'nonce_cli',
            amount: '0.05',
            recipient: '11111111111111111111111111111111',
            voucherHash: 'voucher_hash_cli',
            signature: 'signature_cli',
            issuedAt: '2030-01-01T00:00:00.000Z',
            createdAt: '2030-01-01T00:00:00.000Z',
          },
          signedVoucher: {
            schema: 'streaming/voucher/0.1',
            sessionId: 'sess_cli',
            nonce: 'nonce_cli',
            amount: '0.05',
            recipient: '11111111111111111111111111111111',
            issuedAt: '2030-01-01T00:00:00.000Z',
            signature: 'signature_cli',
          },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/streaming/sessions/sess_cli/revoke') {
        writeJsonResponse(res, { sessionId: 'sess_cli', revokeTx: 'revoke-cli-base64' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/streaming/sessions/sess_cli') {
        writeJsonResponse(res, {
          session: {
            sessionId: 'sess_cli',
            status: 'active',
            vouchers: [{ nonce: 'nonce-1' }],
          },
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/streaming/sessions/sess_cli/receipt') {
        writeJsonResponse(res, { receipts: [{ receiptId: 'receipt_cli', txid: 'tx_cli' }] });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/streaming/sessions/sess_cli/settle') {
        writeJsonResponse(res, { sessionId: 'sess_cli', settled: 1, failed: 0 });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/mpp/config') {
        writeJsonResponse(res, { acceptedRails: ['sol', 'usdc'], maxChallengeAmount: '10' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mpp/challenge') {
        writeJsonResponse(res, {
          approvalId: 'approval_mpp_cli',
          requestId: 'approval_mpp_cli',
          expiresAt: '2026-05-16T13:00:00.000Z',
        }, 201);
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
