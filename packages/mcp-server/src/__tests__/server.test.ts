import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { WalletBackend } from '@solana-agent-wallet-adapter/core';

import { createMockBackend } from '../mockBackend.js';
import { createServer } from '../server.js';

const TOOL_NAMES = [
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
