import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PublicKey, Transaction } from '@solana/web3.js';

import {
  resetKaminoClientFactory,
  setKaminoClientFactory,
  type KaminoClient,
  type KaminoReserveSnapshot,
} from '../adapters/kamino/client.js';
import { clearReserveSnapshotCache } from '../adapters/kamino/reserveSnapshot.js';
import { AgentRegistry, type PublicRegisteredAgent } from '../agentRegistry.js';
import { createBridgeServer } from '../bridgeServer.js';
import { DEFAULT_CONFIG, type AgentWalletConfig } from '../config.js';
import { JsonLabArtifactStore, type LabArtifact } from '../labArtifacts.js';
import { LocalBridgeBackend } from '../localBridgeBackend.js';
import {
  JsonPreparedActionStore,
  type PreparedActionKind,
  type PreparedActionStore,
} from '../preparedActions.js';

describe('bridge lab artifact routes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('stores and lists signed lab artifacts through the bridge API', async () => {
    const artifact = sampleArtifact();
    const handle = await startTestBridge({ connectedAddress: artifact.walletAddress });
    try {
      const saved = await bridgeFetch<{ artifact: LabArtifact }>(handle.url, '/bridge/lab-artifacts', {
        method: 'POST',
        body: JSON.stringify({ artifact }),
      });
      const listed = await bridgeFetch<{ artifacts: LabArtifact[] }>(handle.url, '/bridge/lab-artifacts');
      const health = await bridgeFetch<{ labArtifactStorePath?: string | null }>(handle.url, '/bridge/health');

      expect(saved.artifact).toEqual(artifact);
      expect(listed.artifacts).toEqual([artifact]);
      expect(health.labArtifactStorePath).toContain('lab-artifacts.json');
    } finally {
      await handle.stop();
    }
  });

  it('deletes signed lab artifacts through the bridge API', async () => {
    const artifact = sampleArtifact();
    const handle = await startTestBridge({ connectedAddress: artifact.walletAddress });
    try {
      await bridgeFetch<{ artifact: LabArtifact }>(handle.url, '/bridge/lab-artifacts', {
        method: 'POST',
        body: JSON.stringify({ artifact }),
      });

      const deleted = await bridgeFetch<{ deleted: boolean }>(handle.url, '/bridge/lab-artifacts/delete', {
        method: 'POST',
        body: JSON.stringify({ artifactId: artifact.id }),
      });
      const listed = await bridgeFetch<{ artifacts: LabArtifact[] }>(handle.url, '/bridge/lab-artifacts');

      expect(deleted.deleted).toBe(true);
      expect(listed.artifacts).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  it('requires the bridge token for lab artifact access', async () => {
    const handle = await startTestBridge();
    try {
      const response = await fetch(new URL('/bridge/lab-artifacts', handle.url));
      expect(response.status).toBe(401);
    } finally {
      await handle.stop();
    }
  });

  it('rejects the legacy default bridge token when a different token is configured', async () => {
    const handle = await startTestBridge();
    try {
      const response = await fetch(new URL('/bridge/lab-artifacts', handle.url), {
        headers: {
          'x-agent-wallet-token': 'local-agent-wallet',
        },
      });
      expect(response.status).toBe(401);
    } finally {
      await handle.stop();
    }
  });

  it('allows browser private-network preflight requests', async () => {
    const handle = await startTestBridge();
    try {
      const origin = 'https://agenticwalletadapter.com';
      const response = await fetch(new URL('/bridge/ai/status', handle.url), {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-private-network': 'true',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-private-network')).toBe('true');
      expect(response.headers.get('access-control-allow-headers')).toContain('x-agent-wallet-token');
      expect(response.headers.get('vary')).toContain('Access-Control-Request-Private-Network');
    } finally {
      await handle.stop();
    }
  });

  it('does not grant CORS access to untrusted browser origins', async () => {
    const handle = await startTestBridge();
    try {
      const response = await fetch(new URL('/bridge/ai/status', handle.url), {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
          'access-control-request-private-network': 'true',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('access-control-allow-private-network')).toBe('true');
    } finally {
      await handle.stop();
    }
  });

  it('issues, lists, and revokes registered agents', async () => {
    const handle = await startTestBridge();
    try {
      const initial = await bridgeFetch<{ agents: PublicRegisteredAgent[] }>(handle.url, '/bridge/agents');
      expect(initial.agents).toEqual([]);

      const issued = await bridgeFetch<{ agent: PublicRegisteredAgent & { token: string } }>(
        handle.url,
        '/bridge/agents/issue',
        {
          method: 'POST',
          body: JSON.stringify({ label: 'Codex devnet', tier: 'capped' }),
        },
      );
      expect(issued.agent.label).toBe('Codex devnet');
      expect(issued.agent.tier).toBe('capped');
      expect(issued.agent.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(issued.agent.tokenHint).toContain('…');

      const listed = await bridgeFetch<{ agents: PublicRegisteredAgent[] }>(handle.url, '/bridge/agents');
      expect(listed.agents).toHaveLength(1);
      expect(listed.agents[0]?.label).toBe('Codex devnet');
      expect(listed.agents[0]).not.toHaveProperty('token');

      const removed = await bridgeFetch<{ removed: boolean }>(handle.url, '/bridge/agents/delete', {
        method: 'POST',
        body: JSON.stringify({ agentId: issued.agent.id }),
      });
      expect(removed.removed).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('enforces read-only tier on protected endpoints', async () => {
    const registry = new AgentRegistry({ fallbackToken: 'test-token' });
    const issued = registry.issueAgent({ label: 'Read-only Claude', tier: 'read_only' });
    const handle = await startTestBridge({ agentRegistry: registry });
    try {
      const allowed = await fetch(new URL('/bridge/status', handle.url), {
        headers: { 'x-agent-wallet-token': issued.token },
      });
      expect(allowed.status).toBe(200);

      const denied = await fetch(new URL('/bridge/action/prepare-transfer-sol', handle.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-wallet-token': issued.token,
        },
        body: JSON.stringify({ recipient: '11111111111111111111111111111111', amountSol: '0.01' }),
      });
      expect(denied.status).toBe(403);
      const payload = (await denied.json()) as { error?: string; requiredTier?: string };
      expect(payload.error).toBe('forbidden');
      expect(payload.requiredTier).toBe('capped');
    } finally {
      await handle.stop();
    }
  });

  it('rejects disabled agents with 401', async () => {
    const registry = new AgentRegistry({ fallbackToken: 'test-token' });
    const issued = registry.issueAgent({ label: 'Paused agent', tier: 'full' });
    registry.upsert({ ...issued, enabled: false });
    const handle = await startTestBridge({ agentRegistry: registry });
    try {
      const response = await fetch(new URL('/bridge/status', handle.url), {
        headers: { 'x-agent-wallet-token': issued.token },
      });
      expect(response.status).toBe(401);
    } finally {
      await handle.stop();
    }
  });

  it('falls back to the legacy single-token when the registry is empty', async () => {
    const handle = await startTestBridge();
    try {
      const response = await fetch(new URL('/bridge/status', handle.url), {
        headers: { 'x-agent-wallet-token': 'test-token' },
      });
      expect(response.status).toBe(200);
    } finally {
      await handle.stop();
    }
  });

  it('validates bridge Solana helper clusters before RPC calls', async () => {
    const handle = await startTestBridge({
      actionConfig: { ...DEFAULT_CONFIG, cluster: 'devnet', rpcUrl: 'http://127.0.0.1:1' },
    });
    try {
      const response = await fetch(new URL('/bridge/solana/latest-blockhash', handle.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-wallet-token': 'test-token',
        },
        body: JSON.stringify({ cluster: 'mainnet-beta' }),
      });
      const payload = await response.json() as { error?: { code?: string; message?: string } };

      expect(response.status).toBe(400);
      expect(payload.error?.code).toBe('cluster_mismatch');
      expect(payload.error?.message).toContain('Bridge is configured for devnet');
    } finally {
      await handle.stop();
    }
  });

  it('records externally signed prepared-action transactions without executing through the bridge', async () => {
    const store = new JsonPreparedActionStore(join(await mkdtemp(join(tmpdir(), 'sawa-bridge-actions-')), 'actions.json'));
    const action = await store.addAction({
      kind: 'transfer_sol',
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      summary: 'Transfer 0.01 SOL',
      params: {
        recipient: '22222222222222222222222222222222',
        amountSol: '0.01',
      },
    });
    const handle = await startTestBridge({
      actionConfig: { ...DEFAULT_CONFIG, cluster: 'devnet', rpcUrl: 'http://127.0.0.1:1' },
      preparedActions: store,
      connectedAddress: action.walletAddress,
    });
    try {
      const recorded = await bridgeFetch<{ preparedAction: { status: string; txid?: string; txStatus?: string } }>(
        handle.url,
        '/bridge/prepared-actions/record-transaction',
        {
          method: 'POST',
          body: JSON.stringify({ actionId: action.id, txid: 'tx-browser-signed', txStatus: 'confirmed' }),
        },
      );
      const receipts = await bridgeFetch<{ receipts: Array<{ actionId: string; txid?: string; txStatus?: string }> }>(
        handle.url,
        '/bridge/receipts',
      );

      expect(recorded.preparedAction.status).toBe('approved');
      expect(recorded.preparedAction.txid).toBe('tx-browser-signed');
      expect(recorded.preparedAction.txStatus).toBe('confirmed');
      expect(receipts.receipts).toMatchObject([
        {
          actionId: action.id,
          txid: 'tx-browser-signed',
          txStatus: 'confirmed',
        },
      ]);
    } finally {
      await handle.stop();
    }
  });

  it('prepares Blink actions through the bridge without submitting a signing request', async () => {
    const originalFetch = globalThis.fetch;
    const store = new JsonPreparedActionStore(join(await mkdtemp(join(tmpdir(), 'sawa-bridge-actions-')), 'actions.json'));
    const upstreamCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.hostname === 'example.com') {
        upstreamCalls.push({ url: url.toString(), init });
        if (init?.method === 'GET') {
          return jsonResponse({
            title: 'Harvest Raydium farm',
            description: 'Harvest rewards from a farm position',
            label: 'Harvest',
          });
        }
        return jsonResponse({
          transaction: 'base64-bridge-blink-transaction',
          label: 'Harvest',
          message: 'Review before signing',
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch);

    const handle = await startTestBridge({
      actionConfig: DEFAULT_CONFIG,
      preparedActions: store,
      connectedAddress: '11111111111111111111111111111111',
    });
    try {
      const body = await bridgeFetch<{ preparedAction: { kind: string; summary: string; params: Record<string, unknown> } }>(
        handle.url,
        '/bridge/action/prepare-blink',
        {
          method: 'POST',
          body: JSON.stringify({
            protocol: 'Raydium',
            operation: 'Harvest',
            blinkUrl: 'https://example.com/action',
            parameters: { position: 'Position111' },
            expectedToken: 'SOL',
          }),
        },
      );

      expect(upstreamCalls).toHaveLength(2);
      expect(body.preparedAction).toMatchObject({
        kind: 'blink_action',
        summary: 'Raydium: Harvest',
        params: {
          transactionBase64: 'base64-bridge-blink-transaction',
          connectorActionSource: 'blink',
          expectedToken: 'SOL',
        },
      });
    } finally {
      await handle.stop();
    }
  });

  it('proxies BirdEye price requests with the configured API key', async () => {
    const originalFetch = globalThis.fetch;
    const upstreamCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubEnv('BIRDEYE_API_KEY', 'birdeye-test-key');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.hostname === 'public-api.birdeye.so') {
        upstreamCalls.push({ url: url.toString(), init });
        return jsonResponse({
          data: {
            So11111111111111111111111111111111111111112: {
              value: 142.25,
            },
          },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch);

    const handle = await startTestBridge();
    try {
      const body = await bridgeFetch<{ data: Record<string, unknown> }>(handle.url, '/bridge/birdeye/price-multi', {
        method: 'POST',
        body: JSON.stringify({
          addresses: ['So11111111111111111111111111111111111111112'],
          includeLiquidity: false,
        }),
      });

      expect(body.data).toHaveProperty('So11111111111111111111111111111111111111112');
      expect(upstreamCalls).toHaveLength(1);
      const upstream = upstreamCalls[0];
      expect(upstream?.url).toContain('/defi/multi_price');
      expect(upstream?.url).toContain('include_liquidity=false');
      expect(new Headers(upstream?.init?.headers).get('x-api-key')).toBe('birdeye-test-key');
      expect(JSON.parse(String(upstream?.init?.body))).toEqual({
        list_address: 'So11111111111111111111111111111111111111112',
      });
    } finally {
      await handle.stop();
    }
  });
});

describe('bridge prepared-action prepare-transaction', () => {
  afterEach(() => {
    resetKaminoClientFactory();
    clearReserveSnapshotCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns 200 with captured base64 for a registered adapter kind', async () => {
    const wallet = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
    setKaminoClientFactory(() => buildFakeKaminoClient());

    const store = new JsonPreparedActionStore(
      join(await mkdtemp(join(tmpdir(), 'sawa-bridge-prepare-tx-')), 'actions.json'),
    );
    const action = await store.addAction({
      kind: 'kamino_deposit',
      walletAddress: wallet,
      cluster: 'mainnet-beta',
      summary: 'Deposit 0.5 SOL into Kamino',
      params: {
        reserveMint: 'So11111111111111111111111111111111111111112',
        amountRaw: '500000000',
        decimals: 9,
        // Sentinel that signals these params already went through adapter.prepare().
        // Without it, prepareTransactionForApproval will auto-enrich by re-running prepare().
        preparedSnapshotAt: new Date().toISOString(),
      },
    });
    const handle = await startTestBridge({
      actionConfig: { ...DEFAULT_CONFIG, rpcUrl: 'http://127.0.0.1:1' },
      preparedActions: store,
      connectedAddress: wallet,
    });
    try {
      const response = await fetch(
        new URL(`/bridge/prepared-actions/${action.id}/prepare-transaction`, handle.url),
        {
          method: 'POST',
          headers: { 'x-agent-wallet-token': 'test-token' },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        transactionBase64: string;
        summary: string;
        cluster: string;
        preview?: Record<string, unknown>;
      };
      expect(typeof body.transactionBase64).toBe('string');
      expect(body.transactionBase64.length).toBeGreaterThan(0);
      expect(body.summary).toBe('Deposit 0.5 SOL into Kamino');
      expect(body.cluster).toBe('mainnet-beta');
      expect(body.preview).toMatchObject({ reserveSymbol: 'SOL' });

      const stored = await store.getAction(action.id);
      expect(stored?.status).toBe('ready');
    } finally {
      await handle.stop();
    }
  });

  it('returns 422 when no adapter is registered for the action kind', async () => {
    const wallet = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
    const store = new JsonPreparedActionStore(
      join(await mkdtemp(join(tmpdir(), 'sawa-bridge-prepare-tx-')), 'actions.json'),
    );
    const action = await store.addAction({
      kind: 'manual_review' as PreparedActionKind,
      walletAddress: wallet,
      cluster: 'mainnet-beta',
      summary: 'Manual review',
      params: {},
    });
    const handle = await startTestBridge({
      actionConfig: { ...DEFAULT_CONFIG, rpcUrl: 'http://127.0.0.1:1' },
      preparedActions: store,
      connectedAddress: wallet,
    });
    try {
      const response = await fetch(
        new URL(`/bridge/prepared-actions/${action.id}/prepare-transaction`, handle.url),
        {
          method: 'POST',
          headers: { 'x-agent-wallet-token': 'test-token' },
        },
      );
      expect(response.status).toBe(422);
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('unknown_kind');
    } finally {
      await handle.stop();
    }
  });

  it('returns 409 when the action is already in a terminal status', async () => {
    const wallet = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
    const store = new JsonPreparedActionStore(
      join(await mkdtemp(join(tmpdir(), 'sawa-bridge-prepare-tx-')), 'actions.json'),
    );
    const action = await store.addAction({
      kind: 'kamino_deposit',
      walletAddress: wallet,
      cluster: 'mainnet-beta',
      summary: 'Deposit 0.5 SOL into Kamino',
      params: {
        reserveMint: 'So11111111111111111111111111111111111111112',
        amountRaw: '500000000',
        decimals: 9,
        // Sentinel that signals these params already went through adapter.prepare().
        // Without it, prepareTransactionForApproval will auto-enrich by re-running prepare().
        preparedSnapshotAt: new Date().toISOString(),
      },
    });
    await store.updateAction(action.id, { status: 'approved' });

    const handle = await startTestBridge({
      actionConfig: { ...DEFAULT_CONFIG, rpcUrl: 'http://127.0.0.1:1' },
      preparedActions: store,
      connectedAddress: wallet,
    });
    try {
      const response = await fetch(
        new URL(`/bridge/prepared-actions/${action.id}/prepare-transaction`, handle.url),
        {
          method: 'POST',
          headers: { 'x-agent-wallet-token': 'test-token' },
        },
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('invalid_request');
      expect(body.error?.message).toMatch(/is already approved/);
    } finally {
      await handle.stop();
    }
  });

  it('returns 404 when the action does not exist', async () => {
    const wallet = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
    const store = new JsonPreparedActionStore(
      join(await mkdtemp(join(tmpdir(), 'sawa-bridge-prepare-tx-')), 'actions.json'),
    );
    const handle = await startTestBridge({
      actionConfig: { ...DEFAULT_CONFIG, rpcUrl: 'http://127.0.0.1:1' },
      preparedActions: store,
      connectedAddress: wallet,
    });
    try {
      const response = await fetch(
        new URL('/bridge/prepared-actions/does-not-exist/prepare-transaction', handle.url),
        {
          method: 'POST',
          headers: { 'x-agent-wallet-token': 'test-token' },
        },
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('invalid_request');
      expect(body.error?.message).toMatch(/Unknown prepared action/);
    } finally {
      await handle.stop();
    }
  });

  it('returns 404 when the action belongs to a different wallet', async () => {
    const ownerWallet = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
    const otherWallet = 'HnXY7XBN3iLkz9aXVH3xukNNa1aAvK7Crh1MDBQTRJVA';
    const store = new JsonPreparedActionStore(
      join(await mkdtemp(join(tmpdir(), 'sawa-bridge-prepare-tx-')), 'actions.json'),
    );
    const action = await store.addAction({
      kind: 'kamino_deposit',
      walletAddress: ownerWallet,
      cluster: 'mainnet-beta',
      summary: 'Deposit 0.5 SOL into Kamino',
      params: {
        reserveMint: 'So11111111111111111111111111111111111111112',
        amountRaw: '500000000',
        decimals: 9,
      },
    });
    const handle = await startTestBridge({
      actionConfig: { ...DEFAULT_CONFIG, rpcUrl: 'http://127.0.0.1:1' },
      preparedActions: store,
      connectedAddress: otherWallet,
    });
    try {
      const response = await fetch(
        new URL(`/bridge/prepared-actions/${action.id}/prepare-transaction`, handle.url),
        {
          method: 'POST',
          headers: { 'x-agent-wallet-token': 'test-token' },
        },
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('unauthorized');
    } finally {
      await handle.stop();
    }
  });
});

function buildFakeKaminoClient(): KaminoClient {
  const snapshot: KaminoReserveSnapshot = {
    reserveAddress: 'ReserveAddressForSolPlaceholder111111111111',
    reserveMint: 'So11111111111111111111111111111111111111112',
    reserveSymbol: 'SOL',
    decimals: 9,
    supplyApy: 5.4,
    borrowApy: 7.2,
    utilization: 68,
    totalSupply: '10000',
    totalBorrow: '6800',
    depositLimit: '50000',
    depositLimitRemaining: '40000',
    withdrawalDelaySec: 0,
    withdrawAvailable: '3200',
    lastUpdateSlot: 280_000_000,
    asOfBlockTime: 1_770_000_000,
  };
  return {
    async getReserveSnapshot() {
      return snapshot;
    },
    async listReserveSnapshots() {
      return [snapshot];
    },
    async getPositions() {
      return [];
    },
    async buildDepositTransaction(_connection, input) {
      const tx = new Transaction();
      tx.feePayer = new PublicKey(input.walletAddress);
      tx.recentBlockhash = '11111111111111111111111111111111';
      return {
        transaction: tx,
        reserveAddress: snapshot.reserveAddress,
        reserveSymbol: snapshot.reserveSymbol,
        decimals: snapshot.decimals,
        amountUi: (Number(input.amountRaw) / 10 ** snapshot.decimals).toString(),
        reserveSnapshot: snapshot,
      };
    },
    async buildWithdrawTransaction(_connection, input) {
      const tx = new Transaction();
      tx.feePayer = new PublicKey(input.walletAddress);
      tx.recentBlockhash = '11111111111111111111111111111111';
      return {
        transaction: tx,
        reserveAddress: snapshot.reserveAddress,
        reserveSymbol: snapshot.reserveSymbol,
        decimals: snapshot.decimals,
        amountUi: (Number(input.amountRaw) / 10 ** snapshot.decimals).toString(),
        reserveSnapshot: snapshot,
      };
    },
  };
}

async function startTestBridge(
  options: {
    actionConfig?: AgentWalletConfig;
    agentRegistry?: AgentRegistry;
    preparedActions?: PreparedActionStore;
    connectedAddress?: string;
  } = {},
): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'sawa-bridge-labs-'));
  const backend = new LocalBridgeBackend({
    cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    token: 'test-token',
  });
  if (options.connectedAddress) {
    backend.connectHost(options.connectedAddress, {
      backend: 'test-browser',
      cluster: ['devnet', 'mainnet-beta'],
      supports: {
        signMessage: true,
        signTransaction: true,
        signAndSendTransaction: true,
        multiSign: false,
        simulationPreview: false,
      },
      address: options.connectedAddress,
    });
  }
  const bridge = createBridgeServer({
    host: '127.0.0.1',
    port,
    backend,
    ...(options.actionConfig ? { actionConfig: options.actionConfig } : {}),
    ...(options.agentRegistry ? { agentRegistry: options.agentRegistry } : {}),
    ...(options.preparedActions ? { preparedActions: options.preparedActions } : {}),
    labArtifacts: new JsonLabArtifactStore(join(dir, 'lab-artifacts.json')),
  });
  await bridge.start();
  return bridge;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a test port.')));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function bridgeFetch<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-agent-wallet-token', 'test-token');
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(new URL(path, baseUrl), { ...init, headers });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

function sampleArtifact(): LabArtifact {
  return {
    id: 'lab_bridge',
    labId: 'flight',
    title: '1. Flight Recorder',
    kind: 'agent_flight_recorder',
    createdAt: '2026-05-07T18:00:00.000Z',
    walletAddress: '11111111111111111111111111111111',
    cluster: 'devnet',
    input: 'Swap 0.05 SOL to USDC within policy.',
    payload: {
      status: 'warn',
      thesis: 'The request is reviewable.',
      nextSignatureGate: 'Only sign settlement if the future transaction preview matches this signed envelope.',
      metrics: [
        { label: 'Decision', value: 'warn', tone: 'warn' },
        { label: 'Custody', value: 'user wallet', tone: 'good' },
        { label: 'Settlement', value: 'future gated', tone: 'neutral' },
      ],
      evidence: [
        { title: 'Request', detail: 'Swap 0.05 SOL to USDC within policy.', tone: 'neutral', hash: 'hash_request' },
      ],
    },
    preSignatureHash: 'pre_hash',
    signingMessage: 'Solana Agent Wallet Adapter\nArtifact: lab_bridge',
    signature: 'signature',
    verified: true,
    artifactHash: 'artifact_hash',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
