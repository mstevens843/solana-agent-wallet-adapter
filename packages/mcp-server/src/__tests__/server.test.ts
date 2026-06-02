import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { WalletBackend } from '@solana-agent-wallet-adapter/core';
import { IosLinkBackend } from '@solana-agent-wallet-adapter/ios-link';
import { generateEphemeralKeypair, signVoucher } from '@solana-agent-wallet-adapter/streaming-sessions';

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
  vi.unstubAllGlobals();
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
      actionConfig: {
        ...DEFAULT_CONFIG,
        mainnet: {
          ...DEFAULT_CONFIG.mainnet,
          enabled: true,
          allowArbitraryTransactions: true,
        },
      },
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toContain('solana_useful_prompts');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_connector_capabilities');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_connector_read_facts');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_wallet_status');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_portfolio_summary');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_prepare_transfer_sol');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_mpp_challenge_handler');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_mpp_list_inbound_requests');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_mpp_pay_with_session');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_prepare_blink_action');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_prepare_kamino_deposit');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_marginfi_health_preview');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_prepare_marginfi_borrow');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_project0_banks');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_prepare_project0_borrow');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_wormhole_quote');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_prepare_wormhole_transfer');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_prepare_wormhole_redeem');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_list_prepared_actions');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_execute_prepared_action');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_create_recurring_payment');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_transfer_sol');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_token_search');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_token_by_tag');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_token_category');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_token_recent');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_price');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_price_batch');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_token_risk_evidence');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_order_preview');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_swap');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_perps_status');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_perps_pool_snapshot');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_perps_custody_snapshot');
    expect(result.tools.map((tool) => tool.name)).toContain('solana_jupiter_perps_position_snapshot');
  });

  it('creates MPP prepared actions and enforces configured transfer caps', async () => {
    await closeServer?.();
    closeServer = undefined;

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'devnet',
        rpcUrl: 'https://api.devnet.solana.com',
      },
      preparedActions: new JsonPreparedActionStore(await tempStorePath()),
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const prepared = await callTool('solana_mpp_challenge_handler', {
      challenge: mppChallenge({ amount: '2.50' }),
    });
    const payload = JSON.parse(textOf(prepared));
    expect(payload.summary).toContain('via MPP');
    expect(payload.challengeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.preparedAction).toMatchObject({
      kind: 'transfer_spl',
      params: {
        metadata: {
          connectorId: 'mpp',
        },
      },
    });

    const capped = await callTool('solana_mpp_challenge_handler', {
      challenge: mppChallenge({ amount: '26' }),
    });
    expect(capped.isError).toBe(true);
    expect(textOf(capped)).toContain('exceeds configured maxTransfer');
  });

  it('lists inbound MPP requests through render-web with eligibility filtering', async () => {
    await closeServer?.();
    closeServer = undefined;

    vi.stubEnv('AGENTIC_RENDER_WEB_URL', 'http://render.test');
    vi.stubEnv('AGENTIC_RENDER_WEB_COOKIE', 'session=test-cookie');
    const requests: Array<{ method: string; path: string; cookie?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        cookie: headers?.cookie,
      });
      if (url.pathname === '/api/mpp/inbound') {
        return jsonResponse({
          inbound: [
            { id: 'eligible', metadata: { mppSessionEligibility: { eligible: true } } },
            { id: 'blocked', metadata: { mppSessionEligibility: { eligible: false } } },
          ],
        });
      }
      return jsonResponse({ error: 'not_found' }, 404);
    }));

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true },
      },
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = JSON.parse(textOf(await callTool('solana_mpp_list_inbound_requests', {
      eligibleOnly: true,
    })));

    expect(result.inbound).toEqual([{ id: 'eligible', metadata: { mppSessionEligibility: { eligible: true } } }]);
    expect(result.items).toEqual(result.inbound);
    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/api/mpp/inbound',
        cookie: 'session=test-cookie',
      },
    ]);
  });

  it('proxies MPP pay-with-session decisions to render-web', async () => {
    await closeServer?.();
    closeServer = undefined;

    vi.stubEnv('AGENTIC_RENDER_WEB_URL', 'http://render.test');
    vi.stubEnv('AGENTIC_RENDER_WEB_COOKIE', 'session=test-cookie');
    const requests: Array<{ method: string; path: string; body: unknown; cookie?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
        cookie: headers?.cookie,
      });
      if (url.pathname === '/api/mpp/session-pay') {
        return jsonResponse({
          approvalId: 'approval_mpp_1',
          accepted: true,
          finality: 'voucher_accepted',
          status: 'voucher_accepted',
          remaining: '4.50',
          spentAmount: '0.50',
          sessionPayment: {
            approvalId: 'approval_mpp_1',
            sessionId: 'sess_mpp_1',
            voucherId: 'voucher_mpp_1',
            voucherHash: 'voucher_hash_mpp_1',
          },
          voucher: {
            id: 'voucher_mpp_1',
            voucherHash: 'voucher_hash_mpp_1',
          },
          receiptId: 'evidence_mpp_1',
          receiptHash: 'a'.repeat(64),
        });
      }
      return jsonResponse({ error: 'not_found' }, 404);
    }));

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        mainnet: {
          ...DEFAULT_CONFIG.mainnet,
          enabled: true,
          allowArbitraryTransactions: true,
        },
      },
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = JSON.parse(textOf(await callTool('solana_mpp_pay_with_session', {
      approvalId: 'approval_mpp_1',
      sessionId: 'sess_mpp_1',
    })));

    expect(result).toMatchObject({
      approvalId: 'approval_mpp_1',
      accepted: true,
      finality: 'voucher_accepted',
      remaining: '4.50',
      sessionPayment: {
        sessionId: 'sess_mpp_1',
        voucherHash: 'voucher_hash_mpp_1',
      },
    });
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/mpp/session-pay',
        cookie: 'session=test-cookie',
        body: {
          approvalId: 'approval_mpp_1',
          sessionId: 'sess_mpp_1',
        },
      },
    ]);
  });

  it('describes connector write tools as wallet approval bounded', async () => {
    await closeServer?.();
    closeServer = undefined;

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true },
      },
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = await client.listTools();
    const kaminoDeposit = result.tools.find((tool) => tool.name === 'solana_prepare_kamino_deposit');
    const marginfiBorrow = result.tools.find((tool) => tool.name === 'solana_prepare_marginfi_borrow');
    const project0Borrow = result.tools.find((tool) => tool.name === 'solana_prepare_project0_borrow');
    const prepareSwap = result.tools.find((tool) => tool.name === 'solana_prepare_swap');

    expect(kaminoDeposit?.description).toContain('Prepares wallet approval work only');
    expect(kaminoDeposit?.description).toContain('does not sign, submit, or grant delegated authority');
    expect(marginfiBorrow?.description).toContain('Prepares wallet approval work only');
    expect(marginfiBorrow?.description).toContain('does not sign, submit, or grant delegated authority');
    expect(project0Borrow?.description).toContain('Prepares wallet approval work only');
    expect(project0Borrow?.description).toContain('does not sign, submit, or grant delegated authority');
    expect(prepareSwap?.description).toContain('does not sign');
    expect(prepareSwap?.description).toContain('delegated authority');
  });

  it('returns stable useful prompts when action config is supplied', async () => {
    await closeServer?.();
    closeServer = undefined;

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        mainnet: {
          ...DEFAULT_CONFIG.mainnet,
          enabled: true,
          allowArbitraryTransactions: true,
        },
      },
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

  it('proxies streaming session create and voucher spend to render-web', async () => {
    await closeServer?.();
    closeServer = undefined;

    vi.stubEnv('AGENTIC_RENDER_WEB_URL', 'http://render.test');
    vi.stubEnv('AGENTIC_RENDER_WEB_COOKIE', 'session=test-cookie');
    const requests: Array<{ method: string; path: string; body: unknown; cookie?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = init?.headers as Record<string, string> | undefined;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
      requests.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        body,
        cookie: headers?.cookie,
      });
      if (url.pathname === '/api/streaming/sessions') {
        return jsonResponse({
          sessionId: 'sess_create',
          approveTx: 'approve-tx-base64',
          ephemeralSignerPubkey: 'signer-pubkey',
        }, 201);
      }
      if (url.pathname === '/api/streaming/sessions/sess_create/voucher-relay') {
        return jsonResponse({
          accepted: true,
          remaining: '9.95',
          spentAmount: '0.05',
          voucherId: 'voucher_create_1',
          voucherHash: 'voucher_hash_create_1',
          voucher: {
            id: 'voucher_create_1',
            sessionId: 'sess_create',
            nonce: 'nonce_create_1',
            amount: '0.05',
            recipient: '11111111111111111111111111111111',
            voucherHash: 'voucher_hash_create_1',
            signature: 'signature_create_1',
            issuedAt: '2030-01-01T00:00:00.000Z',
            createdAt: '2030-01-01T00:00:00.000Z',
          },
          signedVoucher: {
            schema: 'streaming/voucher/0.1',
            sessionId: 'sess_create',
            nonce: 'nonce_create_1',
            amount: '0.05',
            recipient: '11111111111111111111111111111111',
            issuedAt: '2030-01-01T00:00:00.000Z',
            signature: 'signature_create_1',
          },
        });
      }
      return jsonResponse({ error: 'not_found' }, 404);
    }));

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

    const created = JSON.parse(textOf(await callTool('solana_streaming_session_create', {
      tokenMint: 'So11111111111111111111111111111111111111112',
      capAmount: '10',
      expiresAt: '2030-01-01T00:00:00.000Z',
      recipientAllowlist: ['11111111111111111111111111111111'],
    })));
    const spent = JSON.parse(textOf(await callTool('solana_streaming_voucher_sign', {
      sessionId: 'sess_create',
      amount: '0.05',
      recipient: '11111111111111111111111111111111',
    })));

    expect(created).toMatchObject({ sessionId: 'sess_create', approveTx: 'approve-tx-base64' });
    expect(spent).toMatchObject({
      accepted: true,
      remaining: '9.95',
      signedVoucher: {
        sessionId: 'sess_create',
        nonce: 'nonce_create_1',
        amount: '0.05',
        recipient: '11111111111111111111111111111111',
      },
    });
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/streaming/sessions',
        cookie: 'session=test-cookie',
        body: {
          tokenMint: 'So11111111111111111111111111111111111111112',
          capAmount: '10',
          expiresAt: '2030-01-01T00:00:00.000Z',
          recipientAllowlist: ['11111111111111111111111111111111'],
        },
      },
      {
        method: 'POST',
        path: '/api/streaming/sessions/sess_create/voucher-relay',
        cookie: 'session=test-cookie',
        body: {
          amount: '0.05',
          recipient: '11111111111111111111111111111111',
        },
      },
    ]);
  });

  it('verifies streaming vouchers against render-web session detail', async () => {
    await closeServer?.();
    closeServer = undefined;

    const keypair = generateEphemeralKeypair();
    const voucher = signVoucher(keypair, {
      sessionId: 'sess_verify',
      nonce: 'nonce-1',
      amount: '0.05',
      recipient: '11111111111111111111111111111111',
      issuedAt: '2030-01-01T00:00:00.000Z',
    });
    vi.stubEnv('AGENTIC_RENDER_WEB_URL', 'http://render.test');
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/streaming/sessions/sess_verify') {
        return jsonResponse({ session: { ephemeralSignerPubkey: keypair.publicKey } });
      }
      return jsonResponse({ error: 'not_found' }, 404);
    }));

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

    const result = await callTool('solana_streaming_voucher_verify', {
      sessionId: 'sess_verify',
      voucher,
    });
    const payload = JSON.parse(textOf(result));

    expect(payload.valid).toBe(true);
    expect(payload.sessionId).toBe('sess_verify');
    expect(typeof payload.voucherHash).toBe('string');
    expect(payload.ephemeralSignerPubkey).toBe(keypair.publicKey);
  });

  it('returns a structured streaming API error when render-web is still scaffolded', async () => {
    await closeServer?.();
    closeServer = undefined;

    vi.stubEnv('AGENTIC_RENDER_WEB_URL', 'http://render.test');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: 'not_implemented',
      message: 'Streaming session handler is Phase 2B.',
    }, 501)));

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

    const result = await callTool('solana_streaming_session_list', {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Code: unsupported_method');
    expect(textOf(result)).toContain('not_implemented: Streaming session handler is Phase 2B.');
  });

  it('returns connector capabilities through the MCP tool', async () => {
    await closeServer?.();
    closeServer = undefined;

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        mainnet: { ...DEFAULT_CONFIG.mainnet, enabled: true },
      },
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = await callTool('solana_connector_capabilities', { connectorId: 'raydium' });
    const payload = JSON.parse(textOf(result));

    expect(payload.connectors).toHaveLength(1);
    expect(payload.connectors[0]).toMatchObject({
      id: 'raydium',
      executionMode: 'first_class_prepare',
      actionTools: expect.arrayContaining(['solana_prepare_raydium_add_liquidity']),
      readiness: {
        reads: { ready: true },
        actions: { ready: true },
      },
    });
  });

  it('allows arbitrary mainnet transaction signing through wallet approval', async () => {
    await closeServer?.();
    closeServer = undefined;

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        mainnet: {
          ...DEFAULT_CONFIG.mainnet,
          enabled: true,
          allowArbitraryTransactions: true,
        },
      },
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

  it('blocks arbitrary mainnet transaction tools when mainnet policy disallows them', async () => {
    await closeServer?.();
    closeServer = undefined;

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: createMockBackend(),
      actionConfig: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        mainnet: {
          ...DEFAULT_CONFIG.mainnet,
          enabled: true,
          allowArbitraryTransactions: false,
        },
      },
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const signOnly = await callTool('solana_sign_transaction', {
      transactionBase64: 'AQID',
      cluster: 'mainnet-beta',
    });
    const signAndSend = await callTool('solana_sign_and_send_transaction', {
      transactionBase64: 'AQID',
      cluster: 'mainnet-beta',
    });
    const devnet = await callTool('solana_sign_transaction', {
      transactionBase64: 'AQID',
      cluster: 'devnet',
    });

    expect(signOnly.isError).toBe(true);
    expect(textOf(signOnly)).toContain('Arbitrary mainnet transaction signing is disabled');
    expect(signAndSend.isError).toBe(true);
    expect(textOf(signAndSend)).toContain('Arbitrary mainnet transaction signing is disabled');
    expect(devnet.isError).not.toBe(true);
    expect(textOf(devnet)).toContain('"status":"pending"');
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

  it('prepares a Blink action without submitting a wallet approval', async () => {
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
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return jsonResponse({
          title: 'Harvest Raydium farm',
          description: 'Harvest rewards from a farm position',
          label: 'Harvest',
        });
      }
      return jsonResponse({
        transaction: 'base64-blink-transaction',
        label: 'Harvest',
        message: 'Review before signing',
      });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const linked = InMemoryTransport.createLinkedPair();
    const server = createServer({
      backend: countingBackend,
      actionConfig: DEFAULT_CONFIG,
      preparedActions: new JsonPreparedActionStore(await tempStorePath()),
    });
    client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await Promise.all([server.connect(linked[1]), client.connect(linked[0])]);
    closeServer = async () => {
      await Promise.all([client.close(), server.close()]);
    };

    const result = await callTool('solana_prepare_blink_action', {
      protocol: 'Raydium',
      operation: 'Harvest',
      blinkUrl: 'blink:https://example.com/action',
      parameters: { position: 'Position111' },
      expectedAmount: '0.01',
      expectedToken: 'SOL',
    });
    const payload = JSON.parse(textOf(result));

    expect(submitCount).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(payload.preparedAction).toMatchObject({
      kind: 'blink_action',
      status: 'ready',
      summary: 'Raydium: Harvest',
      params: {
        protocol: 'Raydium',
        operation: 'Harvest',
        blinkUrl: 'https://example.com/action',
        actionUrl: 'https://example.com/action',
        transactionBase64: 'base64-blink-transaction',
        connectorActionSource: 'blink',
        blinkLabel: 'Harvest',
        blinkMessage: 'Review before signing',
        expectedAmount: '0.01',
        expectedToken: 'SOL',
      },
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

function mppChallenge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 'mpp/0.1',
    nonce: 'mpp_mcp_nonce',
    amount: '2.50',
    currency: 'USDC',
    resourceUrl: 'https://merchant.example/resource/123',
    expiresAt: '2030-01-01T00:00:00.000Z',
    paymentMethods: [
      {
        kind: 'solana-spl',
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        recipient: 'BvgrFr5Bcaa9NudH3DCxgMnHV1FT1nzD5JtMHsmpKnFB',
        network: 'devnet',
      },
    ],
    merchant: { id: 'merchant_1', name: 'Acme' },
    ...overrides,
  };
}

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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
