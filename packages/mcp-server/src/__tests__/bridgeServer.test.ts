import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  it('refuses non-loopback bridge binds by default', () => {
    const backend = new LocalBridgeBackend({
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      token: 'strong-test-token-1234567890123456',
    });

    expect(() => createBridgeServer({ backend, host: '0.0.0.0' })).toThrow(/non-loopback host "0\.0\.0\.0"/);
  });

  it('requires a strong non-default token for explicit private bridge binds', () => {
    vi.stubEnv('BRIDGE_ALLOW_PRIVATE_BIND', '1');
    const weakBackend = new LocalBridgeBackend({
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      token: 'local-agent-wallet',
    });

    expect(() => createBridgeServer({ backend: weakBackend, host: '0.0.0.0' })).toThrow(/weak or default bridge token/);

    const strongBackend = new LocalBridgeBackend({
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      token: 'strong-test-token-1234567890123456',
    });
    const bridge = createBridgeServer({ backend: strongBackend, host: '0.0.0.0', port: 8787 });

    expect(bridge.url).toBe('http://0.0.0.0:8787/');
  });

  it('rejects oversized bridge JSON bodies before parsing', async () => {
    const handle = await startTestBridge();
    try {
      const response = await fetch(new URL('/bridge/trace', handle.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-wallet-token': 'test-token',
        },
        body: JSON.stringify({ event: 'oversized', payload: { data: 'x'.repeat(1024 * 1024 + 1) } }),
      });
      const payload = await response.json() as { error?: { code?: string; message?: string } };

      expect(response.status).toBe(400);
      expect(payload.error?.code).toBe('invalid_request');
      expect(payload.error?.message).toContain('too large');
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

  it('detects connector availability via /bridge/ai/connector/detect', async () => {
    const handle = await startTestBridge();
    try {
      const response = await fetch(new URL('/bridge/ai/connector/detect?connector=codex', handle.url), {
        headers: { 'x-agent-wallet-token': 'test-token' },
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        connectors: Array<{ connector: string; authStatus: string; label: string; billing: string }>;
      };
      expect(payload.connectors).toHaveLength(1);
      expect(payload.connectors[0]?.connector).toBe('codex');
      expect(payload.connectors[0]?.billing).toBe('plan-included');
      expect(['connected', 'needs-auth', 'binary-not-found']).toContain(payload.connectors[0]?.authStatus);
    } finally {
      await handle.stop();
    }
  });

  it('rejects an unknown connector on /bridge/ai/connector/login', async () => {
    const handle = await startTestBridge();
    try {
      const response = await fetch(new URL('/bridge/ai/connector/login', handle.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-wallet-token': 'test-token' },
        body: JSON.stringify({ connector: 'not-a-thing' }),
      });
      expect(response.status).toBe(400);
    } finally {
      await handle.stop();
    }
  });

  it('claims a specific browser signing request by requestId', async () => {
    const handle = await startTestBridge({ connectedAddress: '11111111111111111111111111111111' });
    try {
      const first = {
        id: 'request-first',
        kind: 'sign_message',
        payload: { data: 'first', encoding: 'utf8' },
        cluster: 'devnet',
      };
      const second = {
        id: 'request-second',
        kind: 'sign_message',
        payload: { data: 'second', encoding: 'utf8' },
        cluster: 'devnet',
      };
      await bridgeFetch(handle.url, '/bridge/submit', {
        method: 'POST',
        body: JSON.stringify({ request: first }),
      });
      await bridgeFetch(handle.url, '/bridge/submit', {
        method: 'POST',
        body: JSON.stringify({ request: second }),
      });

      const claimed = await bridgeFetch<{ request: unknown }>(handle.url, '/bridge/next?requestId=request-second');
      const next = await bridgeFetch<{ request: unknown }>(handle.url, '/bridge/next');
      const empty = await bridgeFetch<{ request: unknown }>(handle.url, '/bridge/next');

      expect(claimed.request).toEqual(second);
      expect(next.request).toEqual(first);
      expect(empty.request).toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it('allows bundled Android app preflight requests', async () => {
    const handle = await startTestBridge();
    try {
      const origin = 'https://agentic.local';
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
    } finally {
      await handle.stop();
    }
  });

  it('allows private LAN browser origins only when mobile dev mode opts in', async () => {
    vi.stubEnv('BRIDGE_ALLOW_PRIVATE_ORIGINS', '1');
    const handle = await startTestBridge();
    try {
      const origin = 'http://192.168.1.50:5174';
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
    } finally {
      await handle.stop();
    }
  });

  it('does not allow private LAN browser origins without mobile dev opt-in', async () => {
    const handle = await startTestBridge();
    try {
      const response = await fetch(new URL('/bridge/ai/status', handle.url), {
        method: 'OPTIONS',
        headers: {
          origin: 'http://192.168.1.50:5174',
          'access-control-request-method': 'POST',
          'access-control-request-private-network': 'true',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
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

  it('prevents issued agent tokens from controlling the wallet host or resolving approvals', async () => {
    const registry = new AgentRegistry({ fallbackToken: 'test-token' });
    const issued = registry.issueAgent({ label: 'Full Codex', tier: 'full' });
    const handle = await startTestBridge({
      agentRegistry: registry,
      connectedAddress: '11111111111111111111111111111111',
    });
    const agentHeaders = {
      'content-type': 'application/json',
      'x-agent-wallet-token': issued.token,
    };
    try {
      const status = await fetch(new URL('/bridge/status', handle.url), {
        headers: { 'x-agent-wallet-token': issued.token },
      });
      expect(status.status).toBe(200);

      const connectDenied = await fetch(new URL('/bridge/connect', handle.url), {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({ address: '22222222222222222222222222222222' }),
      });
      expect(connectDenied.status).toBe(403);
      expect(await connectDenied.json()).toMatchObject({
        error: 'forbidden',
        requiredRole: 'wallet_host',
      });

      const request = {
        id: 'request-agent-cannot-resolve',
        kind: 'sign_message',
        payload: { data: 'hello', encoding: 'utf8' },
        cluster: 'devnet',
      };
      const submitted = await fetch(new URL('/bridge/submit', handle.url), {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({ request }),
      });
      expect(submitted.status).toBe(200);

      const resolveDenied = await fetch(new URL('/bridge/resolve', handle.url), {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({ requestId: request.id, signature: 'agent-sig' }),
      });
      expect(resolveDenied.status).toBe(403);
      expect(await resolveDenied.json()).toMatchObject({
        error: 'forbidden',
        requiredRole: 'wallet_host',
      });

      const rejectDenied = await fetch(new URL('/bridge/reject', handle.url), {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({ requestId: request.id, error: { code: 'rejected', message: 'No' } }),
      });
      expect(rejectDenied.status).toBe(403);

      const approved = await bridgeFetch<{ status: string; result?: { signature?: string } }>(
        handle.url,
        '/bridge/resolve',
        {
          method: 'POST',
          body: JSON.stringify({ requestId: request.id, signature: 'host-sig' }),
        },
      );
      expect(approved.status).toBe('approved');
      expect(approved.result?.signature).toBe('host-sig');
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

  it('round-trips browser wallet display metadata through connect and status', async () => {
    const handle = await startTestBridge();
    try {
      await bridgeFetch(handle.url, '/bridge/connect', {
        method: 'POST',
        body: JSON.stringify({
          address: '11111111111111111111111111111111',
          capabilities: {
            backend: 'test-browser',
            cluster: ['devnet'],
            supports: {
              signMessage: true,
              signTransaction: true,
              signAndSendTransaction: true,
              multiSign: false,
              simulationPreview: false,
            },
            walletName: 'Backpack',
            walletLogoId: 'backpack',
            walletIcon: 'data:image/svg+xml,<svg></svg>',
          },
        }),
      });

      await expect(bridgeFetch(handle.url, '/bridge/status')).resolves.toMatchObject({
        address: '11111111111111111111111111111111',
        walletName: 'Backpack',
        walletLogoId: 'backpack',
        walletIcon: 'data:image/svg+xml,<svg></svg>',
      });
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

  it('scopes BirdEye wallet token list to the connected bridge wallet', async () => {
    const originalFetch = globalThis.fetch;
    const upstreamCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubEnv('BIRDEYE_API_KEY', 'birdeye-test-key');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.hostname === 'public-api.birdeye.so') {
        upstreamCalls.push({ url: url.toString(), init });
        return jsonResponse({ data: { items: [{ address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }] } });
      }
      return originalFetch(input, init);
    }) as typeof fetch);

    const handle = await startTestBridge({ connectedAddress: '11111111111111111111111111111111' });
    try {
      await bridgeFetch(handle.url, '/bridge/birdeye/wallet-token-list', {
        method: 'POST',
        body: JSON.stringify({ walletAddress: '11111111111111111111111111111111' }),
      });

      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]?.url).toContain('/v1/wallet/token_list');
      expect(upstreamCalls[0]?.url).toContain('wallet=11111111111111111111111111111111');

      const mismatch = await fetch(new URL('/bridge/birdeye/wallet-token-list', handle.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-wallet-token': 'test-token',
        },
        body: JSON.stringify({ walletAddress: 'So11111111111111111111111111111111111111112' }),
      });
      expect(mismatch.status).toBe(400);
    } finally {
      await handle.stop();
    }
  });

  it('injects the connected bridge wallet into AI review requests', async () => {
    const originalFetch = globalThis.fetch;
    const providerBodies: Record<string, unknown>[] = [];
    vi.stubEnv('AGENTIC_AI_API_KEY', 'sk-test-openai');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.hostname === 'api.openai.com') {
        providerBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return jsonResponse({
          output_text: JSON.stringify({
            decision: 'approve',
            reason: 'Connected wallet context is present.',
            summary: 'Review passed.',
            evidence: {},
          }),
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch);

    const handle = await startTestBridge({ connectedAddress: '11111111111111111111111111111111' });
    try {
      const body = await bridgeFetch<{ decision: string }>(handle.url, '/bridge/ai/review-plan', {
        method: 'POST',
        body: JSON.stringify({
          walletAddress: '11111111111111111111111111111111',
          plan: {
            intent: 'Transfer SOL',
            route: 'SOL transfer',
            risk: 'Low',
            approval: 'Wallet approval required.',
            source: 'template',
            category: 'payments',
            actionType: 'transfer_sol',
            templateTitle: 'Transfer SOL',
            parameters: { recipient: 'So11111111111111111111111111111111111111112', amount: '0.01' },
            fields: [{ label: 'Amount', value: '0.01' }],
            safeguards: ['Check recipient.'],
          },
          instruction: 'Review before approval.',
        }),
      });

      expect(body.decision).toBe('approve');
      const providerInput = String(providerBodies[0]?.input ?? '');
      expect(providerInput).toContain('"walletAddress":"11111111111111111111111111111111"');
      expect(providerInput).toContain('"source":"connected_bridge_wallet"');
    } finally {
      await handle.stop();
    }
  });

  it('serves AI chat without requiring a connected wallet', async () => {
    const originalFetch = globalThis.fetch;
    const providerBodies: Record<string, unknown>[] = [];
    vi.stubEnv('AGENTIC_AI_API_KEY', 'sk-test-openai');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.hostname === 'api.openai.com') {
        providerBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return jsonResponse({
          output_text: 'Use /plan when you are ready to prepare a visible wallet request.',
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch);

    const handle = await startTestBridge();
    try {
      const body = await bridgeFetch<{ answer: string }>(handle.url, '/bridge/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'What should I check before using a swap route?' }],
        }),
      });

      expect(body.answer).toContain('/plan');
      const providerMessages = providerBodies[0]?.messages as Array<{ content?: string }> | undefined;
      const providerInput = JSON.parse(String(providerMessages?.[1]?.content ?? '{}')) as Record<string, unknown>;
      expect(providerInput.walletAddress).toBe('not_connected');
      expect(JSON.stringify(providerInput.messages)).toContain('What should I check before using a swap route?');
    } finally {
      await handle.stop();
    }
  });

  it('streams AI chat events over SSE without requiring a connected wallet', async () => {
    const originalFetch = globalThis.fetch;
    const providerBodies: Record<string, unknown>[] = [];
    vi.stubEnv('AGENTIC_AI_API_KEY', 'sk-test-openai');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.hostname === 'api.openai.com') {
        providerBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"Bridge "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"chat"}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return originalFetch(input, init);
    }) as typeof fetch);

    const handle = await startTestBridge();
    try {
      const events = await bridgeSse(handle.url, '/bridge/ai/chat/stream', {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'What should I check before swapping?' }],
        }),
      });

      expect(events.filter((event) => event.type === 'token').map((event) => event.text).join('')).toBe('Bridge chat');
      expect(events.at(-1)).toMatchObject({ type: 'done', result: { answer: 'Bridge chat', source: 'ai' } });
      const providerMessages = providerBodies[0]?.messages as Array<{ content?: string }> | undefined;
      expect(providerMessages?.[1]?.content).toContain('What should I check before swapping?');
      expect(JSON.stringify(providerMessages?.[0] ?? {})).toContain('not connected');
    } finally {
      await handle.stop();
    }
  });

  it('requires the bridge token for streaming AI chat', async () => {
    const handle = await startTestBridge();
    try {
      const response = await fetch(new URL('/bridge/ai/chat/stream', handle.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
      });
      expect(response.status).toBe(401);
    } finally {
      await handle.stop();
    }
  });

  it('emits SSE error frames when streaming AI chat is not configured', async () => {
    const handle = await startTestBridge();
    try {
      const events = await bridgeSse(handle.url, '/bridge/ai/chat/stream', {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Bridge AI is not configured. Set AGENTIC_AI_API_KEY or provide a bridge session key.',
      });
      expect(events.at(-1)).toMatchObject({ type: 'done' });
    } finally {
      await handle.stop();
    }
  });

  it('returns HTTP 200 with an { error } envelope when a connector review fails', async () => {
    // The 4 AI endpoints stream a keepalive heartbeat, so they commit a 200 head before the outcome
    // is known and can no longer send a 4xx — a failure must come back as a 200 body carrying the
    // REAL cause, not a transport-level "bridge offline". A connector pointed at a missing binary is
    // a deterministic failure that exercises this contract.
    const handle = await startTestBridge({ connectedAddress: CONNECTOR_TEST_WALLET });
    try {
      const configured = await fetch(new URL('/bridge/ai/session-key', handle.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-wallet-token': 'test-token' },
        body: JSON.stringify({ engine: 'connector', connector: 'codex', connectorPath: '/no/such/codex-binary' }),
      });
      expect(configured.ok).toBe(true);

      const response = await fetch(new URL('/bridge/ai/review-plan', handle.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-wallet-token': 'test-token' },
        body: JSON.stringify(connectorReviewBody()),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('unauthorized');
      expect(body.error?.message).toMatch(/Codex.*not found/i);
    } finally {
      await handle.stop();
    }
  });

  it('streams keepalive whitespace yet stays parseable for a slow connector', async () => {
    // Force a drip: a fake connector that sleeps past a shrunk heartbeat interval, then prints a valid
    // review. The body must carry leading whitespace AND still parse to the success result.
    vi.stubEnv('AGENT_WALLET_KEEPALIVE_MS', '10');
    const slowBin = makeDelayedFakeConnector(60, JSON.stringify({
      decision: 'approve',
      reason: 'Looks fine.',
      summary: 'Approved.',
      evidence: {},
    }));
    const handle = await startTestBridge({ connectedAddress: CONNECTOR_TEST_WALLET });
    try {
      await fetch(new URL('/bridge/ai/session-key', handle.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-wallet-token': 'test-token' },
        body: JSON.stringify({ engine: 'connector', connector: 'codex', connectorPath: slowBin }),
      });

      const response = await fetch(new URL('/bridge/ai/review-plan', handle.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-wallet-token': 'test-token' },
        body: JSON.stringify(connectorReviewBody()),
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.startsWith(' '), 'expected a leading keepalive space').toBe(true);
      const body = JSON.parse(text) as { decision?: string };
      expect(body.decision).toBe('approve');
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
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'http://127.0.0.1:1',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true },
      },
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
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'http://127.0.0.1:1',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true },
      },
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
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'http://127.0.0.1:1',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true },
      },
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

describe('bridge connector prepare-action', () => {
  afterEach(() => {
    resetKaminoClientFactory();
    clearReserveSnapshotCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('queues a prepared connector action from raw kind+params+wallet+cluster', async () => {
    const wallet = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
    setKaminoClientFactory(() => buildFakeKaminoClient());

    const store = new JsonPreparedActionStore(
      join(await mkdtemp(join(tmpdir(), 'sawa-bridge-connector-action-')), 'actions.json'),
    );
    const handle = await startTestBridge({
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'http://127.0.0.1:1',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true },
      },
      preparedActions: store,
      connectedAddress: wallet,
    });
    try {
      const response = await fetch(new URL('/bridge/connector/prepare-action', handle.url), {
        method: 'POST',
        headers: { 'x-agent-wallet-token': 'test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'kamino_deposit',
          params: { token: 'SOL', amount: '0.5' },
          walletAddress: wallet,
          cluster: 'mainnet-beta',
          summary: 'Custom Kamino deposit',
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        preparedAction?: {
          id?: string;
          kind?: string;
          status?: string;
          walletAddress?: string;
          cluster?: string;
          summary?: string;
        };
        preview?: Record<string, unknown>;
      };
      expect(body.preparedAction?.id).toMatch(/^pa_/);
      expect(body.preparedAction).toMatchObject({
        kind: 'kamino_deposit',
        status: 'ready',
        walletAddress: wallet,
        cluster: 'mainnet-beta',
        summary: 'Custom Kamino deposit',
      });
      expect(body.preview).toMatchObject({ reserveSymbol: 'SOL' });

      const stored = await store.listActions();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.id).toBe(body.preparedAction?.id);
    } finally {
      await handle.stop();
    }
  });

  it('rejects unsupported connectorSecrets shapes without leaking secret values', async () => {
    const wallet = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
    const store = new JsonPreparedActionStore(
      join(await mkdtemp(join(tmpdir(), 'sawa-bridge-connector-action-')), 'actions.json'),
    );
    const handle = await startTestBridge({
      actionConfig: { ...DEFAULT_CONFIG, rpcUrl: 'http://127.0.0.1:1' },
      preparedActions: store,
      connectedAddress: wallet,
    });
    try {
      const response = await fetch(new URL('/bridge/connector/prepare-action', handle.url), {
        method: 'POST',
        headers: { 'x-agent-wallet-token': 'test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'kamino_deposit',
          params: { token: 'SOL', amount: '0.5' },
          walletAddress: wallet,
          cluster: 'mainnet-beta',
          connectorSecrets: {
            unsupported: { apiKey: 'secret-value-should-not-leak' },
          },
        }),
      });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('unsupported connector');
      expect(text).not.toContain('secret-value-should-not-leak');
    } finally {
      await handle.stop();
    }
  });
});

describe('bridge connector stateless prepare-transaction', () => {
  afterEach(() => {
    resetKaminoClientFactory();
    clearReserveSnapshotCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('builds an unsigned transaction from raw kind+params+wallet+cluster without any pre-stored action', async () => {
    // This is what Approve-and-send for a browser-workflow action calls: the bridge
    // never saw the localStorage `browser-action_*` id, but it can still produce the
    // signable tx bytes by rerunning the adapter's prepare() with the supplied params.
    // The wallet signs locally either way; no Agentic Cloud or AI Bridge sign-in is involved.
    const wallet = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
    setKaminoClientFactory(() => buildFakeKaminoClient());

    const store = new JsonPreparedActionStore(
      join(await mkdtemp(join(tmpdir(), 'sawa-bridge-stateless-')), 'actions.json'),
    );
    const handle = await startTestBridge({
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'http://127.0.0.1:1',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true },
      },
      preparedActions: store,
      connectedAddress: wallet,
    });
    try {
      const response = await fetch(new URL('/bridge/connector/prepare-transaction', handle.url), {
        method: 'POST',
        headers: { 'x-agent-wallet-token': 'test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'kamino_deposit',
          params: { token: 'SOL', amount: '0.5' },
          walletAddress: wallet,
          cluster: 'mainnet-beta',
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        transactionBase64: string;
        summary: string;
        cluster: string;
        preview?: Record<string, unknown>;
      };
      expect(typeof body.transactionBase64).toBe('string');
      expect(body.transactionBase64.length).toBeGreaterThan(0);
      expect(body.summary).toMatch(/Deposit .* SOL .*Kamino/i);
      expect(body.cluster).toBe('mainnet-beta');
      expect(body.preview).toMatchObject({ reserveSymbol: 'SOL' });
    } finally {
      await handle.stop();
    }
  });

  it('returns 422 when the kind has no registered adapter', async () => {
    const wallet = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
    const store = new JsonPreparedActionStore(
      join(await mkdtemp(join(tmpdir(), 'sawa-bridge-stateless-')), 'actions.json'),
    );
    const handle = await startTestBridge({
      actionConfig: { ...DEFAULT_CONFIG, rpcUrl: 'http://127.0.0.1:1' },
      preparedActions: store,
      connectedAddress: wallet,
    });
    try {
      const response = await fetch(new URL('/bridge/connector/prepare-transaction', handle.url), {
        method: 'POST',
        headers: { 'x-agent-wallet-token': 'test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'manual_review',
          params: {},
          walletAddress: wallet,
          cluster: 'mainnet-beta',
        }),
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('unknown_kind');
    } finally {
      await handle.stop();
    }
  });

  it('returns 400 when params is missing or not an object', async () => {
    const wallet = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
    const store = new JsonPreparedActionStore(
      join(await mkdtemp(join(tmpdir(), 'sawa-bridge-stateless-')), 'actions.json'),
    );
    const handle = await startTestBridge({
      actionConfig: { ...DEFAULT_CONFIG, rpcUrl: 'http://127.0.0.1:1' },
      preparedActions: store,
      connectedAddress: wallet,
    });
    try {
      const response = await fetch(new URL('/bridge/connector/prepare-transaction', handle.url), {
        method: 'POST',
        headers: { 'x-agent-wallet-token': 'test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'kamino_deposit',
          params: 'not-an-object',
          walletAddress: wallet,
          cluster: 'mainnet-beta',
        }),
      });
      expect(response.status).toBe(400);
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

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function bridgeSse(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Array<Record<string, unknown>>> {
  const headers = new Headers(init.headers);
  headers.set('x-agent-wallet-token', 'test-token');
  headers.set('accept', 'text/event-stream');
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(new URL(path, baseUrl), { ...init, headers });
  expect(response.ok).toBe(true);
  const text = await response.text();
  return text
    .split('\n\n')
    .map((frame) => frame
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n'))
    .filter((data) => data && data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>);
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

// A minimal review request with no policy NOTE / outside facts, so it takes a single connector pass
// (no research) — keeping the keepalive/error-envelope assertions deterministic.
const CONNECTOR_TEST_WALLET = '11111111111111111111111111111111';

function connectorReviewBody(): Record<string, unknown> {
  return {
    walletAddress: CONNECTOR_TEST_WALLET,
    plan: {
      intent: 'Transfer SOL',
      route: 'SOL transfer',
      risk: 'Low',
      approval: 'Wallet approval required.',
      source: 'template',
      category: 'payments',
      actionType: 'transfer_sol',
      templateTitle: 'Transfer SOL',
      parameters: { recipient: 'So11111111111111111111111111111111111111112', amount: '0.01' },
      fields: [{ label: 'Amount', value: '0.01' }],
      safeguards: ['Check recipient.'],
    },
    instruction: 'No outside facts needed; just verify the draft.',
  };
}

// A fake connector CLI that prints `outputJson` after `delayMs`, so the bridge stays silent long
// enough for the keepalive heartbeat to drip at least once.
function makeDelayedFakeConnector(delayMs: number, outputJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sawa-fake-cli-'));
  const bin = join(dir, 'fake-cli.cjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node\n`
    + `setTimeout(() => { process.stdout.write(${JSON.stringify(outputJson)}); }, ${delayMs});\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
