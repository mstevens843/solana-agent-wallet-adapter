import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentWalletActionService } from '../../actionService.js';
import type { PreparedAction, PreparedActionStore } from '../../preparedActions.js';
import type { WalletBackend } from '@solana-agent-wallet-adapter/core';
import type { AgentWalletConfig } from '../../config.js';

afterEach(() => {
  delete process.env.PHOENIX_ACCESS_CODE;
});

function makeMockBackend(): WalletBackend {
  return {
    async getAddress() {
      return 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu';
    },
    async capabilities() {
      return {
        backend: 'mock',
        cluster: ['mainnet-beta'],
        address: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
        supports: {
          signMessage: false,
          signTransaction: false,
          signAndSendTransaction: false,
          multiSign: false,
          simulationPreview: false,
        },
      };
    },
    async submit() {
      throw new Error('unsupported');
    },
    async poll() {
      throw new Error('unsupported');
    },
  } as unknown as WalletBackend;
}

function makeMockStore(action?: PreparedAction): PreparedActionStore {
  const store: PreparedActionStore = {
    async getAction(id) {
      if (action && action.id === id) return action;
      return null;
    },
  } as PreparedActionStore;
  return store;
}

const CONFIG: AgentWalletConfig = {
  cluster: 'mainnet-beta',
  rpcUrl: 'http://127.0.0.1:8899',
  // Vulcan execution is a real mainnet action; enable it so the mainnet
  // kill-switch (requireMainnetEnabled) does not block these unit tests.
  mainnet: { enabled: true } as AgentWalletConfig['mainnet'],
} as AgentWalletConfig;

describe('executePreparedVulcanCall', () => {
  it('forwards to Vulcan with acknowledged: true at execute time', async () => {
    const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { ok: true, txid: 'sig123' },
      isError: false,
    }));
    const vulcanUpstreamClient = { callTool };

    const action: PreparedAction = {
      id: 'act-1',
      kind: 'phoenix_vulcan_call',
      status: 'approval_pending',
      walletAddress: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      cluster: 'mainnet-beta',
      summary: 'Phoenix via Vulcan: trade.place_market',
      params: { vulcanToolName: 'trade.place_market', vulcanArgs: { symbol: 'SOL-PERP', leverage: 3 } },
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const service = new AgentWalletActionService({
      backend: makeMockBackend(),
      config: CONFIG,
      preparedActions: makeMockStore(action),
      vulcanUpstreamClient,
    });

    const result = await service.executePreparedActionRecord(action);
    expect(callTool).toHaveBeenCalledTimes(1);
    const [toolName, args] = callTool.mock.calls[0]!;
    expect(toolName).toBe('trade.place_market');
    expect(args).toMatchObject({ symbol: 'SOL-PERP', leverage: 3, acknowledged: true });
    expect((result as { vulcanTool: string }).vulcanTool).toBe('trade.place_market');
  });

  it('throws when vulcanUpstreamClient is missing', async () => {
    const action: PreparedAction = {
      id: 'act-2',
      kind: 'phoenix_vulcan_call',
      status: 'approval_pending',
      walletAddress: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      cluster: 'mainnet-beta',
      summary: 'Phoenix via Vulcan',
      params: { vulcanToolName: 'trade.place_market', vulcanArgs: {} },
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const service = new AgentWalletActionService({
      backend: makeMockBackend(),
      config: CONFIG,
      preparedActions: makeMockStore(action),
    });
    await expect(service.executePreparedActionRecord(action)).rejects.toThrow(/Vulcan upstream client is not configured/);
  });

  it('throws when params.vulcanToolName is missing', async () => {
    const action: PreparedAction = {
      id: 'act-3',
      kind: 'phoenix_vulcan_call',
      status: 'approval_pending',
      walletAddress: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      cluster: 'mainnet-beta',
      summary: 'Phoenix via Vulcan',
      params: { vulcanArgs: {} },
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const service = new AgentWalletActionService({
      backend: makeMockBackend(),
      config: CONFIG,
      preparedActions: makeMockStore(action),
      vulcanUpstreamClient: { callTool: vi.fn() },
    });
    await expect(service.executePreparedActionRecord(action)).rejects.toThrow(/missing vulcanToolName/);
  });

  // T1.1: txid extraction.
  it('extracts txid from structuredContent.data.signature into result.txid', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { data: { signature: 'sigFromStructured' } },
      isError: false,
    }));
    const action: PreparedAction = {
      id: 'act-tx-1',
      kind: 'phoenix_vulcan_call',
      status: 'approval_pending',
      walletAddress: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      cluster: 'mainnet-beta',
      summary: 'Phoenix via Vulcan',
      params: { vulcanToolName: 'trade.place_market', vulcanArgs: {} },
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const service = new AgentWalletActionService({
      backend: makeMockBackend(),
      config: CONFIG,
      preparedActions: makeMockStore(action),
      vulcanUpstreamClient: { callTool },
    });
    const result = await service.executePreparedActionRecord(action);
    expect((result as { txid?: string }).txid).toBe('sigFromStructured');
  });

  it('extracts txid from content[0].text JSON when structuredContent is absent', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: JSON.stringify({ data: { txid: 'fromContentText' } }) }],
      isError: false,
    }));
    const action: PreparedAction = {
      id: 'act-tx-2',
      kind: 'phoenix_vulcan_call',
      status: 'approval_pending',
      walletAddress: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      cluster: 'mainnet-beta',
      summary: 'Phoenix via Vulcan',
      params: { vulcanToolName: 'trade.place_market', vulcanArgs: {} },
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const service = new AgentWalletActionService({
      backend: makeMockBackend(),
      config: CONFIG,
      preparedActions: makeMockStore(action),
      vulcanUpstreamClient: { callTool },
    });
    const result = await service.executePreparedActionRecord(action);
    expect((result as { txid?: string }).txid).toBe('fromContentText');
  });

  it('omits txid when the response has no recognizable signature key (paper-mode tools)', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'paper-mode receipt, no on-chain effect' }],
      isError: false,
    }));
    const action: PreparedAction = {
      id: 'act-tx-3',
      kind: 'phoenix_vulcan_call',
      status: 'approval_pending',
      walletAddress: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      cluster: 'mainnet-beta',
      summary: 'Phoenix via Vulcan (paper)',
      params: { vulcanToolName: 'paper.place_market', vulcanArgs: {} },
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const service = new AgentWalletActionService({
      backend: makeMockBackend(),
      config: CONFIG,
      preparedActions: makeMockStore(action),
      vulcanUpstreamClient: { callTool },
    });
    const result = await service.executePreparedActionRecord(action);
    expect((result as { txid?: string }).txid).toBeUndefined();
  });

  // T2.3: friendly error extraction.
  it('extracts the first text content payload when Vulcan returns isError:true', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'wallet is locked' }],
      isError: true,
    }));
    const action: PreparedAction = {
      id: 'act-err-1',
      kind: 'phoenix_vulcan_call',
      status: 'approval_pending',
      walletAddress: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      cluster: 'mainnet-beta',
      summary: 'Phoenix via Vulcan',
      params: { vulcanToolName: 'trade.place_market', vulcanArgs: {} },
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const service = new AgentWalletActionService({
      backend: makeMockBackend(),
      config: CONFIG,
      preparedActions: makeMockStore(action),
      vulcanUpstreamClient: { callTool },
    });
    await expect(service.executePreparedActionRecord(action)).rejects.toThrow(/wallet is locked/);
  });

  it('prefers structuredContent.error.message over content text', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'fallback text' }],
      structuredContent: { error: { message: 'oracle stale; refresh and retry' } },
      isError: true,
    }));
    const action: PreparedAction = {
      id: 'act-err-2',
      kind: 'phoenix_vulcan_call',
      status: 'approval_pending',
      walletAddress: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      cluster: 'mainnet-beta',
      summary: 'Phoenix via Vulcan',
      params: { vulcanToolName: 'trade.place_market', vulcanArgs: {} },
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const service = new AgentWalletActionService({
      backend: makeMockBackend(),
      config: CONFIG,
      preparedActions: makeMockStore(action),
      vulcanUpstreamClient: { callTool },
    });
    await expect(service.executePreparedActionRecord(action)).rejects.toThrow(/oracle stale/);
  });

  // D4: registry routing.
  it('routes through vulcanWalletRegistry when supplied (multi-wallet mode)', async () => {
    const aliceCallTool = vi.fn(async () => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { data: { signature: 'aliceSig' } },
      isError: false,
    }));
    const getOrStart = vi.fn(async (_name?: string) => ({ callTool: aliceCallTool }));
    const vulcanWalletRegistry = {
      getOrStart,
      getDefaultWalletName: () => 'alice',
    };
    const action: PreparedAction = {
      id: 'act-router-1',
      kind: 'phoenix_vulcan_call',
      status: 'approval_pending',
      walletAddress: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      cluster: 'mainnet-beta',
      summary: 'Phoenix via Vulcan',
      params: {
        vulcanToolName: 'trade.place_market',
        vulcanArgs: { symbol: 'SOL-PERP' },
        vulcanWalletName: 'alice',
      },
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const service = new AgentWalletActionService({
      backend: makeMockBackend(),
      config: CONFIG,
      preparedActions: makeMockStore(action),
      vulcanWalletRegistry,
    });
    const result = await service.executePreparedActionRecord(action);
    expect(getOrStart).toHaveBeenCalledWith('alice');
    expect(aliceCallTool).toHaveBeenCalledTimes(1);
    expect((result as { vulcanWallet?: string }).vulcanWallet).toBe('alice');
    expect((result as { txid?: string }).txid).toBe('aliceSig');
  });

  it('falls back to registry.getDefaultWalletName when no vulcanWalletName in params', async () => {
    const callTool = vi.fn(async () => ({ content: [], isError: false }));
    const getOrStart = vi.fn(async () => ({ callTool }));
    const vulcanWalletRegistry = {
      getOrStart,
      getDefaultWalletName: () => 'default-wallet',
    };
    const action: PreparedAction = {
      id: 'act-router-2',
      kind: 'phoenix_vulcan_call',
      status: 'approval_pending',
      walletAddress: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      cluster: 'mainnet-beta',
      summary: 'Phoenix via Vulcan',
      params: { vulcanToolName: 'trade.place_market', vulcanArgs: {} },
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const service = new AgentWalletActionService({
      backend: makeMockBackend(),
      config: CONFIG,
      preparedActions: makeMockStore(action),
      vulcanWalletRegistry,
    });
    await service.executePreparedActionRecord(action);
    // No explicit wallet name → registry resolves default itself.
    expect(getOrStart).toHaveBeenCalledWith(undefined);
  });

  // T2.4: idempotency.
  it('refuses to re-fire when the action already has a txid set', async () => {
    const callTool = vi.fn();
    const action: PreparedAction = {
      id: 'act-idem-1',
      kind: 'phoenix_vulcan_call',
      status: 'approval_pending',
      walletAddress: 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      cluster: 'mainnet-beta',
      summary: 'Phoenix via Vulcan',
      params: { vulcanToolName: 'trade.place_market', vulcanArgs: {} },
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      txid: 'alreadyExecutedSig',
    };
    const service = new AgentWalletActionService({
      backend: makeMockBackend(),
      config: CONFIG,
      preparedActions: makeMockStore(action),
      vulcanUpstreamClient: { callTool },
    });
    await expect(service.executePreparedActionRecord(action)).rejects.toThrow(/already executed/);
    expect(callTool).not.toHaveBeenCalled();
  });
});
