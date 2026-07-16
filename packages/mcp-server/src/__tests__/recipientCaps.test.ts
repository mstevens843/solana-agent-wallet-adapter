import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';
import { validateChatProposedAction } from '@solana-agent-wallet-adapter/workflow';
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

describe('AgentWalletActionService prepare-time hardening', () => {
  it('rejects an invalid recipient address with a clear error at prepare (not a raw PublicKey throw)', async () => {
    const path = await tempPath();
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: configWithCap(),
      preparedActions: new JsonPreparedActionStore(path),
    });
    await expect(
      service.prepareTransferSol({ recipient: 'not-a-real-address', amountSol: '0.01' }),
    ).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('valid Solana address') });
  });

  it('enforces the mainnet transfer cap at prepare time, not only at execute', async () => {
    const path = await tempPath();
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true, maxSolTransfer: '0.05', allowArbitraryTransactions: true },
      },
      preparedActions: new JsonPreparedActionStore(path),
    });
    await expect(
      service.prepareTransferSol({ recipient: TREASURY, amountSol: '1' }),
    ).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringContaining('exceeds the configured mainnet cap') });
  });
});

describe('chat-proposal amounts hit the mainnet transfer cap when prepared', () => {
  // Answers the critique "no test that a spend cap blocks an oversized chat proposal". A chat
  // proposal is INERT (validated, requiresApproval) and carries no cap — the deterministic cap is
  // the real gate, and it fires when the proposal is promoted to a prepared action. This test wires
  // the two halves: the workflow proposal validator's output params → the capped prepare path.
  it('an oversized chat-proposed SOL transfer is blocked once prepared on a capped mainnet wallet', async () => {
    const { proposal, error } = validateChatProposedAction({
      kind: 'transfer_sol',
      summary: 'Send 1 SOL',
      params: { recipient: TREASURY, amountSol: '1' },
      resolution: { recipientSource: 'user_input' },
    });
    expect(error).toBeUndefined();
    expect(proposal?.requiresApproval).toBe(true); // proposal itself cannot move funds

    const path = await tempPath();
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true, maxSolTransfer: '0.05', allowArbitraryTransactions: true },
      },
      preparedActions: new JsonPreparedActionStore(path),
    });
    await expect(
      service.prepareTransferSol(proposal!.params as { recipient: string; amountSol: string }),
    ).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringContaining('exceeds the configured mainnet cap') });
  });
});
