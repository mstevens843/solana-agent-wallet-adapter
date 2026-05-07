import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createBridgeServer } from '../bridgeServer.js';
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

  it('requires the bridge token for lab artifact access', async () => {
    const handle = await startTestBridge();
    try {
      const response = await fetch(new URL('/bridge/lab-artifacts', handle.url));
      expect(response.status).toBe(401);
    } finally {
      await handle.stop();
    }
  });
});

async function startTestBridge(): Promise<{ url: string; stop(): Promise<void> }> {
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
