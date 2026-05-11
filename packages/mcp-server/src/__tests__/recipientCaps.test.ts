import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';
import { describe, expect, it } from 'vitest';

import { AgentWalletActionService } from '../actionService.js';
import { DEFAULT_CONFIG, type AgentWalletConfig } from '../config.js';
import { createMockBackend } from '../mockBackend.js';
import { JsonPreparedActionStore } from '../preparedActions.js';

const WALLET = '11111111111111111111111111111111';
const TREASURY = '7NUSC4HBn5pFqGZRouwa3xQ5y4MNoYxqaG3HfYwwekoF';

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sawa-recipient-caps-'));
  return join(dir, 'prepared-actions.json');
}

function configWithCap(overrides: Partial<AgentWalletConfig['recipients']> = {}): AgentWalletConfig {
  return {
    ...DEFAULT_CONFIG,
    cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true, allowArbitraryTransactions: true },
    recipients: {
      [TREASURY]: {
        label: 'Treasury',
        lifetimeMax: { SOL: '0.1' },
      },
      ...overrides,
    },
  };
}

describe('AgentWalletActionService recipient caps', () => {
  it('allows transfers under the configured lifetime cap', async () => {
    const path = await tempPath();
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: configWithCap(),
      preparedActions: new JsonPreparedActionStore(path),
    });
    await expect(
      service.prepareTransferSol({ recipient: TREASURY, amountSol: '0.05' }),
    ).resolves.toHaveProperty('preparedAction');
  });

  it('rejects transfers that would exceed the lifetime cap once approved history exists', async () => {
    const path = await tempPath();
    const store = new JsonPreparedActionStore(path);
    await store.addAction({
      kind: 'transfer_sol',
      walletAddress: WALLET,
      cluster: 'devnet',
      summary: 'Transfer 0.08 SOL',
      params: { recipient: TREASURY, amountSol: '0.08' },
      status: 'approved',
    });
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: configWithCap(),
      preparedActions: store,
    });
    await expect(
      service.prepareTransferSol({ recipient: TREASURY, amountSol: '0.05' }),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('ignores non-approved receipts when summing prior spend', async () => {
    const path = await tempPath();
    const store = new JsonPreparedActionStore(path);
    await store.addAction({
      kind: 'transfer_sol',
      walletAddress: WALLET,
      cluster: 'devnet',
      summary: 'Rejected 0.09 SOL',
      params: { recipient: TREASURY, amountSol: '0.09' },
      status: 'rejected',
    });
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: configWithCap(),
      preparedActions: store,
    });
    await expect(
      service.prepareTransferSol({ recipient: TREASURY, amountSol: '0.05' }),
    ).resolves.toHaveProperty('preparedAction');
  });

  it('returns the recipient label in the rejection message', async () => {
    const path = await tempPath();
    const store = new JsonPreparedActionStore(path);
    await store.addAction({
      kind: 'transfer_sol',
      walletAddress: WALLET,
      cluster: 'devnet',
      summary: 'Transfer 0.08 SOL',
      params: { recipient: TREASURY, amountSol: '0.08' },
      status: 'approved',
    });
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: configWithCap(),
      preparedActions: store,
    });
    await expect(
      service.prepareTransferSol({ recipient: TREASURY, amountSol: '0.05' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Treasury'),
    });
  });
});
