import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { WalletBackend } from '@solana-agent-wallet-adapter/core';
import { IosLinkBackend } from '@solana-agent-wallet-adapter/ios-link';

import { createMockBackend } from '../mockBackend.js';
import { createServer } from '../server.js';
import { DEFAULT_CONFIG } from '../config.js';
import { JsonPreparedActionStore } from '../preparedActions.js';

const TOOL_NAMES = [
  'solana_connect_wallet',
  'solana_get_address',
  'solana_sign_message',
  'solana_sign_transaction',
  'solana_sign_and_send_transaction',
  'solana_simulate_transaction',
  'solana_check_approval',
];

let client: Client;
let closeServer: (() => Promise<void>) | undefined;

beforeEach(async () => {
  const linked = InMemoryTransport.createLinkedPair();
  const clientTransport = linked[0];
  const serverTransport = linked[1];
  const server = createServer({ backend: createMockBackend() });
  client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeServer = async () => {
    await Promise.all([client.close(), server.close()]);
  };
});

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe('mcp server tools', () => {
  it('lists the expected Solana wallet tools', async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('returns the mock wallet address', async () => {
    const result = await callTool('solana_get_address', {});
    expect(textOf(result)).toBe('{"address":"11111111111111111111111111111111"}');
  });

  it('creates iOS wallet connect approvals through the MCP tool', async () => {
    await closeServer?.();
    closeServer = undefined;

    const linked = InMemoryTransport.createLinkedPair();
    const backend = new IosLinkBackend({
      provider: 'phantom',
      cluster: 'devnet',
      appUrl: 'https://example.com',
      callbackBaseUrl: 'http://127.0.0.1:8787',
      callbackToken: 'token',
      logLevel: 'silent',
    });
    const server = createServer({ backend });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = await callTool('solana_connect_wallet', {});
    const text = textOf(result);

    expect(text).toContain('Solana wallet approval pending.');
    expect(text).toContain('/ios/approval');
    expect(text).toContain('"status":"pending"');
  });

  it('submits signing approvals with a pending resource', async () => {
    const result = await callTool('solana_sign_message', {
      message: 'hello',
      cluster: 'devnet',
      summary: 'test',
    });

    const text = textOf(result);
    expect(text).toContain('Solana wallet approval pending.');
    expect(text).toContain('mock://approve/sar_');
    expect(text).toContain('"status":"pending"');
  });

  it('simulates transactions when the backend supports simulation', async () => {
    const result = await callTool('solana_simulate_transaction', {
      transactionBase64: 'AQID',
      cluster: 'devnet',
      summary: 'simulate',
    });

    expect(JSON.parse(textOf(result))).toEqual({
      simulation: {
        err: null,
        logs: ['mock simulation'],
        unitsConsumed: 0,
      },
    });
  });

  it('returns a structured protocol error for unknown approval ids', async () => {
    const result = await callTool('solana_check_approval', {
      requestId: 'sar_missing',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Code: invalid_request');
    expect(textOf(result)).toContain('"code":"invalid_request"');
  });

  it('returns unsupported_method when simulation is unavailable', async () => {
    await closeServer?.();
    closeServer = undefined;

    const backend = createMockBackend();
    const noSimulationBackend: WalletBackend = {
      capabilities: backend.capabilities,
      getAddress: backend.getAddress,
      submit: backend.submit,
      poll: backend.poll,
      cancel: backend.cancel,
    };
    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({ backend: noSimulationBackend });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = await callTool('solana_simulate_transaction', {
      transactionBase64: 'AQID',
      cluster: 'devnet',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Code: unsupported_method');
  });

  it('registers high-level product tools when action config is supplied', async () => {
    await closeServer?.();
    closeServer = undefined;

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: DEFAULT_CONFIG,
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toContain('solana_useful_prompts');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_wallet_status');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_portfolio_summary');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_prepare_transfer_sol');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_list_prepared_actions');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_execute_prepared_action');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_create_recurring_payment');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_transfer_sol');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_swap');
  });

  it('returns stable useful prompts when action config is supplied', async () => {
    await closeServer?.();
    closeServer = undefined;

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: DEFAULT_CONFIG,
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = await callTool('solana_useful_prompts', {});
    const payload = JSON.parse(textOf(result));
    expect(payload.title).toBe('Useful solana-agent-wallet prompts');
    expect(payload.worksNow[0].category).toBe('Wallet status');
    expect(JSON.stringify(payload)).toContain('Use solana-agent-wallet to show my wallet status.');
    expect(JSON.stringify(payload)).toContain('roadmapNotAutomatedYet');
  });

  it('allows arbitrary mainnet transaction signing through wallet approval', async () => {
    await closeServer?.();
    closeServer = undefined;

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: DEFAULT_CONFIG,
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = await callTool('solana_sign_transaction', {
      transactionBase64: 'AQID',
      cluster: 'mainnet-beta',
    });

    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('"status":"pending"');
  });

  it('prepares a capped transfer without submitting a wallet approval', async () => {
    await closeServer?.();
    closeServer = undefined;

    let submitCount = 0;
    const backend = createMockBackend();
    const countingBackend: WalletBackend = {
      ...backend,
      async submit(request) {
        submitCount += 1;
        return backend.submit(request);
      },
    };
    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: countingBackend,
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'devnet',
        rpcUrl: 'https://api.devnet.solana.com',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true },
      },
      preparedActions: new JsonPreparedActionStore(await tempStorePath()),
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = await callTool('solana_prepare_transfer_sol', {
      recipient: '11111111111111111111111111111111',
      amountSol: '0.01',
      dueAt: '2030-01-01T00:00:00.000Z',
    });
    const payload = JSON.parse(textOf(result));

    expect(submitCount).toBe(0);
    expect(payload.preparedAction).toMatchObject({
      kind: 'transfer_sol',
      status: 'scheduled',
      summary: 'Transfer 0.01 SOL to 11111111111111111111111111111111',
    });
  });

  it('blocks executing scheduled prepared actions before they are due', async () => {
    await closeServer?.();
    closeServer = undefined;

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'devnet',
        rpcUrl: 'https://api.devnet.solana.com',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true },
      },
      preparedActions: new JsonPreparedActionStore(await tempStorePath()),
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const prepared = await callTool('solana_prepare_transfer_sol', {
      recipient: '11111111111111111111111111111111',
      amountSol: '0.01',
      dueAt: '2030-01-01T00:00:00.000Z',
    });
    const actionId = JSON.parse(textOf(prepared)).preparedAction.id;
    const executed = await callTool('solana_execute_prepared_action', { actionId });

    expect(executed.isError).toBe(true);
    expect(textOf(executed)).toContain('is not due yet');
  });
});

async function callTool(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

function textOf(result: Awaited<ReturnType<typeof callTool>>): string {
  if (!('content' in result) || !Array.isArray(result.content)) {
    throw new Error('Expected content tool result.');
  }
  const [content] = result.content;
  if (!content || content.type !== 'text') {
    throw new Error('Expected text tool result.');
  }
  return content.text;
}

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sawa-server-test-'));
  return join(dir, 'prepared-actions.json');
}
