import { describe, expect, it, vi } from 'vitest';

import { registerVulcanTools } from '../../upstreamMcp/vulcanTools.js';
import type { VulcanUpstreamClient } from '../../upstreamMcp/vulcanClient.js';
import type { AddPreparedActionInput, PreparedAction, PreparedActionStore } from '../../preparedActions.js';
import type { AgentWalletConfig } from '../../config.js';

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function makeMockServer(): {
  registered: Map<string, RegisteredTool>;
  server: { registerTool: (name: string, schema: { description: string; inputSchema: Record<string, unknown> }, handler: RegisteredTool['handler']) => void };
} {
  const registered = new Map<string, RegisteredTool>();
  return {
    registered,
    server: {
      registerTool: (name, schema, handler) => {
        registered.set(name, { name, description: schema.description, inputSchema: schema.inputSchema, handler });
      },
    },
  };
}

function makeMockStore(): { store: PreparedActionStore; added: AddPreparedActionInput[] } {
  const added: AddPreparedActionInput[] = [];
  const store: PreparedActionStore = {
    async addAction(input) {
      added.push(input);
      const action: PreparedAction = {
        id: `act-${added.length}`,
        kind: input.kind,
        status: 'approval_pending',
        walletAddress: input.walletAddress,
        cluster: input.cluster,
        summary: input.summary,
        params: input.params,
        dueAt: input.dueAt ?? new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return action;
    },
  } as PreparedActionStore;
  return { store, added };
}

function makeMockClient(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): {
  client: VulcanUpstreamClient;
  callTool: ReturnType<typeof vi.fn>;
} {
  const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    content: [{ type: 'text', text: '{"ok":true}' }],
    isError: false,
  }));
  const client = {
    isRunning: () => true,
    async start() {
      // no-op
    },
    async stop() {
      // no-op
    },
    async listTools(_force?: boolean) {
      return tools.map((t) => ({
        name: t.name,
        ...(t.description !== undefined && { description: t.description }),
        ...(t.inputSchema !== undefined && { inputSchema: t.inputSchema }),
      }));
    },
    callTool,
  } as unknown as VulcanUpstreamClient;
  return { client, callTool };
}

const ENABLED_CONFIG: AgentWalletConfig = {
  cluster: 'mainnet-beta',
  connectors: {
    phoenix: {
      perps: { enabled: true, paperModeOnly: false, allowedSymbols: ['SOL-PERP'], maxLeverage: 5 },
    },
  },
} as AgentWalletConfig;

describe('registerVulcanTools', () => {
  it('registers read tools and forwards calls directly', async () => {
    const { server, registered } = makeMockServer();
    const { client, callTool } = makeMockClient([
      { name: 'market.snapshot', description: 'snapshot', inputSchema: { properties: { symbol: { type: 'string' } } } },
    ]);
    const { store } = makeMockStore();

    const summary = await registerVulcanTools({
      server: server as never,
      client,
      config: ENABLED_CONFIG,
      getWalletAddress: async () => 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      getStore: () => store,
    });

    expect(summary.readonly).toEqual(['solana_vulcan_market_snapshot']);
    expect(summary.dangerous).toEqual([]);
    expect(registered.has('solana_vulcan_market_snapshot')).toBe(true);

    const tool = registered.get('solana_vulcan_market_snapshot')!;
    const result = await tool.handler({ symbol: 'SOL-PERP' });
    expect(callTool).toHaveBeenCalledWith('market.snapshot', { symbol: 'SOL-PERP' });
    expect((result as { content: { text: string }[] }).content[0]!.text).toMatch(/upstreamTool/);
  });

  it('routes dangerous tools through the prepared-action inbox instead of calling Vulcan', async () => {
    const { server, registered } = makeMockServer();
    const { client, callTool } = makeMockClient([
      {
        name: 'trade.place_market',
        description: 'place a market order',
        inputSchema: { properties: { symbol: { type: 'string' }, leverage: { type: 'number' }, acknowledged: { type: 'boolean' } } },
      },
    ]);
    const { store, added } = makeMockStore();

    const summary = await registerVulcanTools({
      server: server as never,
      client,
      config: ENABLED_CONFIG,
      getWalletAddress: async () => 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      getStore: () => store,
    });

    expect(summary.dangerous).toEqual(['solana_vulcan_trade_place_market']);
    const tool = registered.get('solana_vulcan_trade_place_market')!;
    const result = await tool.handler({ symbol: 'SOL-PERP', leverage: 3, mode: 'paper' });

    expect(callTool).not.toHaveBeenCalled();
    expect(added).toHaveLength(1);
    expect(added[0]!.kind).toBe('phoenix_vulcan_call');
    const params = added[0]!.params as { vulcanToolName: string; vulcanArgs: Record<string, unknown> };
    expect(params.vulcanToolName).toBe('trade.place_market');
    expect(params.vulcanArgs.symbol).toBe('SOL-PERP');
    expect(params.vulcanArgs.acknowledged).toBeUndefined(); // injected only at execute time
    const replyText = (result as { content: { text: string }[] }).content[0]!.text;
    expect(replyText).toMatch(/preparedAction/);
  });

  it('rejects dangerous calls that violate policy without queueing', async () => {
    const { server, registered } = makeMockServer();
    const { client, callTool } = makeMockClient([
      {
        name: 'trade.place_market',
        inputSchema: { properties: { acknowledged: { type: 'boolean' } } },
      },
    ]);
    const { store, added } = makeMockStore();

    await registerVulcanTools({
      server: server as never,
      client,
      config: ENABLED_CONFIG,
      getWalletAddress: async () => 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      getStore: () => store,
    });

    const tool = registered.get('solana_vulcan_trade_place_market')!;
    const result = await tool.handler({ symbol: 'BTC-PERP', leverage: 3, mode: 'paper' });
    expect(callTool).not.toHaveBeenCalled();
    expect(added).toHaveLength(0);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('skips dangerous tools when no store is available', async () => {
    const { server, registered } = makeMockServer();
    const { client } = makeMockClient([
      { name: 'trade.place_market', inputSchema: { properties: { acknowledged: { type: 'boolean' } } } },
      { name: 'market.snapshot' },
    ]);

    const summary = await registerVulcanTools({
      server: server as never,
      client,
      config: ENABLED_CONFIG,
      getWalletAddress: async () => 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      getStore: () => undefined,
    });

    expect(registered.has('solana_vulcan_market_snapshot')).toBe(true);
    expect(registered.has('solana_vulcan_trade_place_market')).toBe(false);
    expect(summary.skipped.length).toBe(1);
  });

  // T1.5: collision check.
  it('skips a second tool that sanitizes to the same name as a previously-registered one', async () => {
    const { server, registered } = makeMockServer();
    // 'market.snapshot' and 'market-snapshot' both → 'solana_vulcan_market_snapshot'.
    const { client } = makeMockClient([
      { name: 'market.snapshot', description: 'first' },
      { name: 'market-snapshot', description: 'second (collides with first)' },
      { name: 'market_snapshot', description: 'third (also collides)' },
    ]);
    const { store } = makeMockStore();

    const summary = await registerVulcanTools({
      server: server as never,
      client,
      config: ENABLED_CONFIG,
      getWalletAddress: async () => 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      getStore: () => store,
    });

    expect(registered.has('solana_vulcan_market_snapshot')).toBe(true);
    expect(summary.readonly).toEqual(['solana_vulcan_market_snapshot']);
    expect(summary.skipped.length).toBe(2);
    expect(summary.skipped[0]!.reason).toMatch(/duplicate sanitized name/);
    expect(summary.skipped[0]!.reason).toContain('market.snapshot');
  });

  // T3.1: normalizeArgs safety gate.
  it('does NOT auto-unwrap "args" when the upstream tool actually declares an "args" property', async () => {
    const { server, registered } = makeMockServer();
    const { client, callTool } = makeMockClient([
      {
        name: 'market.snapshot',
        inputSchema: { properties: { args: { type: 'object' } } },
      },
    ]);
    const { store } = makeMockStore();

    await registerVulcanTools({
      server: server as never,
      client,
      config: ENABLED_CONFIG,
      getWalletAddress: async () => 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      getStore: () => store,
    });

    const tool = registered.get('solana_vulcan_market_snapshot')!;
    await tool.handler({ args: { nested: 'value' } });
    // The caller's `{ args: {...} }` is passed THROUGH (not unwrapped) because the upstream schema declares `args`.
    expect(callTool).toHaveBeenCalledWith('market.snapshot', { args: { nested: 'value' } });
  });

  it('does auto-unwrap "args" wrapper when the upstream tool does NOT declare an "args" property', async () => {
    const { server, registered } = makeMockServer();
    const { client, callTool } = makeMockClient([
      {
        name: 'market.snapshot',
        inputSchema: { properties: { symbol: { type: 'string' } } },
      },
    ]);

    await registerVulcanTools({
      server: server as never,
      client,
      config: ENABLED_CONFIG,
      getWalletAddress: async () => 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      getStore: () => makeMockStore().store,
    });

    const tool = registered.get('solana_vulcan_market_snapshot')!;
    await tool.handler({ args: { symbol: 'SOL-PERP' } });
    expect(callTool).toHaveBeenCalledWith('market.snapshot', { symbol: 'SOL-PERP' });
  });

  it('emits a skipped trace event with reason on collision', async () => {
    const { server } = makeMockServer();
    const { client } = makeMockClient([
      { name: 'market.snapshot' },
      { name: 'market-snapshot' },
    ]);
    const traceEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

    await registerVulcanTools({
      server: server as never,
      client,
      config: ENABLED_CONFIG,
      getWalletAddress: async () => 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu',
      getStore: () => makeMockStore().store,
      trace: (event, payload) => traceEvents.push({ event, payload }),
    });

    expect(traceEvents.find((e) => e.event === 'vulcan.tool.skipped')).toBeDefined();
    expect(traceEvents.find((e) => e.event === 'vulcan.upstream.tools_ready')).toBeDefined();
  });
});
