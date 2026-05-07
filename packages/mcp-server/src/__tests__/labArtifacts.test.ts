import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonLabArtifactStore, type LabArtifact } from '../labArtifacts.js';

describe('JsonLabArtifactStore', () => {
  it('persists signed lab artifacts across store instances', async () => {
    const path = await tempStorePath();
    const first = new JsonLabArtifactStore(path);
    const artifact = sampleArtifact({ id: 'lab_one', createdAt: '2026-05-07T18:00:00.000Z' });

    await first.upsertArtifact(artifact);

    const second = new JsonLabArtifactStore(path);
    await expect(second.listArtifacts()).resolves.toEqual([artifact]);
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('"lab_one"');
    expect(raw).toContain('"artifactHash"');
  });

  it('dedupes repeated artifact ids and sorts newest first', async () => {
    const store = new JsonLabArtifactStore(await tempStorePath());
    const older = sampleArtifact({ id: 'lab_same', title: 'Older', createdAt: '2026-05-07T18:00:00.000Z' });
    const newer = sampleArtifact({ id: 'lab_same', title: 'Newer', createdAt: '2026-05-07T19:00:00.000Z' });
    const other = sampleArtifact({ id: 'lab_other', title: 'Other', createdAt: '2026-05-07T18:30:00.000Z' });

    await store.upsertArtifact(older);
    await store.upsertArtifact(other);
    await store.upsertArtifact(newer);

    await expect(store.listArtifacts()).resolves.toMatchObject([
      { id: 'lab_same', title: 'Newer' },
      { id: 'lab_other', title: 'Other' },
    ]);
  });
});

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sawa-lab-artifacts-'));
  return join(dir, 'lab-artifacts.json');
}

function sampleArtifact(overrides: Partial<LabArtifact> = {}): LabArtifact {
  return {
    id: 'lab_sample',
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
    signingMessage: 'Solana Agent Wallet Adapter\nArtifact: lab_sample',
    signature: 'signature',
    verified: true,
    artifactHash: 'artifact_hash',
    ...overrides,
  };
}
