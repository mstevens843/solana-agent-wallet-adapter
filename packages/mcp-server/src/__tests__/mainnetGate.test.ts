import { describe, expect, it } from 'vitest';

import { AgentWalletActionService } from '../actionService.js';
import { DEFAULT_CONFIG, type AgentWalletConfig } from '../config.js';
import { createMockBackend } from '../mockBackend.js';
import type { PreparedAction, PreparedActionStore } from '../preparedActions.js';

const MOCK_ADDRESS = '11111111111111111111111111111111';

function mainnetConfig(enabled: boolean): AgentWalletConfig {
  return {
    ...DEFAULT_CONFIG,
    cluster: 'mainnet-beta',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    mainnet: { ...DEFAULT_CONFIG.mainnet, enabled, maxSolTransfer: '0.05' },
  };
}

function newService(config: AgentWalletConfig): AgentWalletActionService {
  return new AgentWalletActionService({
    backend: createMockBackend(),
    config,
    connection: {} as never,
    preparedActions: {} as PreparedActionStore,
  });
}

describe('mainnet kill-switch + transfer caps', () => {
  it('rejects transfer_sol above the configured mainnet cap before any network call', async () => {
    const service = newService(mainnetConfig(true));
    await expect(
      service.transferSol({ recipient: MOCK_ADDRESS, amountSol: '0.1' }),
    ).rejects.toThrow(/exceeds the configured mainnet cap/);
  });

  it('allows transfer_sol amounts within the cap to pass the cap check', async () => {
    // Within-cap amounts must NOT trip the cap guard; the call proceeds past the
    // cap check (and only then would hit network/sign paths, which we do not run).
    const service = newService(mainnetConfig(true));
    await expect(
      service.transferSol({ recipient: MOCK_ADDRESS, amountSol: '0.01' }),
    ).rejects.not.toThrow(/exceeds the configured mainnet cap/);
  });

  it('rejects executing a prepared action when mainnet is disabled (kill-switch)', async () => {
    const service = newService(mainnetConfig(false));
    const action = {
      id: 'act_test',
      kind: 'transfer_sol',
      status: 'ready',
      walletAddress: MOCK_ADDRESS,
      cluster: 'mainnet-beta',
      summary: 'Transfer 0.01 SOL',
      params: { recipient: MOCK_ADDRESS, amountSol: '0.01' },
    } as unknown as PreparedAction;
    await expect(service.executePreparedActionRecord(action)).rejects.toThrow(/Mainnet is disabled/);
  });

  it('does not enforce the kill-switch on devnet executes', async () => {
    const service = newService({ ...mainnetConfig(false), cluster: 'devnet' });
    const action = {
      id: 'act_test',
      kind: 'transfer_sol',
      status: 'ready',
      walletAddress: MOCK_ADDRESS,
      cluster: 'devnet',
      summary: 'Transfer 0.01 SOL',
      params: { recipient: MOCK_ADDRESS, amountSol: '0.01' },
    } as unknown as PreparedAction;
    await expect(service.executePreparedActionRecord(action)).rejects.not.toThrow(/Mainnet is disabled/);
  });
});
