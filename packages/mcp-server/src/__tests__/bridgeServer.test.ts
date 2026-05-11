import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentRegistry, type PublicRegisteredAgent } from '../agentRegistry.js';
import { createBridgeServer } from '../bridgeServer.js';
import { DEFAULT_CONFIG, type AgentWalletConfig } from '../config.js';
import { JsonLabArtifactStore, type LabArtifact } from '../labArtifacts.js';
import { LocalBridgeBackend } from '../localBridgeBackend.js';

describe('bridge lab artifact routes', () => {
  it('stores and lists signed lab artifacts through the bridge API', async () => {
    const handle = await startTestBridge();
    try {
      const artifact = sampleArtifact();
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
    const handle = await startTestBridge();
    try {
      const artifact = sampleArtifact();
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
});

async function startTestBridge(
  options: { actionConfig?: AgentWalletConfig; agentRegistry?: AgentRegistry } = {},
): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'sawa-bridge-labs-'));
  const bridge = createBridgeServer({
    host: '127.0.0.1',
    port,
    backend: new LocalBridgeBackend({
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      token: 'test-token',
    }),
    ...(options.actionConfig ? { actionConfig: options.actionConfig } : {}),
    ...(options.agentRegistry ? { agentRegistry: options.agentRegistry } : {}),
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
