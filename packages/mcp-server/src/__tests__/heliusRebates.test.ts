import { describe, expect, it, vi } from 'vitest';

import {
  isRebateEligibleRpcUrl,
  resolveRebateAddress,
  sendRawTransactionWithRebate,
} from '../helius.js';

const REBATE = '8tBrK2HnTsc2kk73kaTFoWWxAEibgn67WKCfEv5i5AZn';
const HELIUS_RPC = 'https://mainnet.helius-rpc.com/?api-key=abc';
const SIGNED_TX_B64 = Buffer.from('signed-tx-bytes').toString('base64');

function okFetch(result: unknown): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: '1', result }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('resolveRebateAddress', () => {
  it('returns null when unset, blank, or invalid base58', () => {
    expect(resolveRebateAddress({})).toBeNull();
    expect(resolveRebateAddress({ HELIUS_REBATE_ADDRESS: '   ' })).toBeNull();
    expect(resolveRebateAddress({ HELIUS_REBATE_ADDRESS: 'not-a-pubkey!' })).toBeNull();
  });

  it('returns the normalized base58 wallet when valid', () => {
    expect(resolveRebateAddress({ HELIUS_REBATE_ADDRESS: REBATE })).toBe(REBATE);
  });
});

describe('isRebateEligibleRpcUrl', () => {
  it('accepts standard + regional Helius RPC hosts', () => {
    expect(isRebateEligibleRpcUrl('https://mainnet.helius-rpc.com/?api-key=x')).toBe(true);
    expect(isRebateEligibleRpcUrl('https://fra.helius-rpc.com/?api-key=x')).toBe(true);
  });

  it('rejects Sender, non-Helius providers, and junk', () => {
    expect(isRebateEligibleRpcUrl('https://sender.helius-rpc.com/fast')).toBe(false);
    expect(isRebateEligibleRpcUrl('https://api.mainnet-beta.solana.com')).toBe(false);
    expect(isRebateEligibleRpcUrl('not a url')).toBe(false);
    expect(isRebateEligibleRpcUrl(undefined)).toBe(false);
  });
});

describe('sendRawTransactionWithRebate', () => {
  it('uses the plain fallback (no fetch) when no rebate address is configured', async () => {
    const { fetchImpl, calls } = okFetch('REBATE_SIG');
    const fallback = vi.fn(async () => 'FALLBACK_SIG');
    const sig = await sendRawTransactionWithRebate(SIGNED_TX_B64, fallback, {
      env: {},
      rpcUrl: HELIUS_RPC,
      fetchImpl,
    });
    expect(sig).toBe('FALLBACK_SIG');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('POSTs sendTransaction with ?rebate-address to the caller Helius RPC and skips fallback', async () => {
    const { fetchImpl, calls } = okFetch('REBATE_SIG');
    const fallback = vi.fn(async () => 'FALLBACK_SIG');
    const sig = await sendRawTransactionWithRebate(SIGNED_TX_B64, fallback, {
      env: { HELIUS_REBATE_ADDRESS: REBATE },
      rpcUrl: HELIUS_RPC,
      fetchImpl,
    });
    expect(sig).toBe('REBATE_SIG');
    expect(fallback).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);

    const url = new URL(calls[0]!.url);
    expect(url.host).toBe('mainnet.helius-rpc.com');
    expect(url.searchParams.get('rebate-address')).toBe(REBATE);
    expect(url.searchParams.get('api-key')).toBe('abc');

    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.method).toBe('sendTransaction');
    expect(body.params[0]).toBe(SIGNED_TX_B64);
    expect(body.params[1]).toMatchObject({ encoding: 'base64', skipPreflight: false });
  });

  it('falls back to the Helius env RPC when the caller RPC is non-Helius', async () => {
    const { fetchImpl, calls } = okFetch('REBATE_SIG');
    const fallback = vi.fn(async () => 'FALLBACK_SIG');
    const sig = await sendRawTransactionWithRebate(SIGNED_TX_B64, fallback, {
      env: { HELIUS_REBATE_ADDRESS: REBATE, HELIUS_API_KEY: 'envkey' },
      rpcUrl: 'https://some-other-rpc.example',
      fetchImpl,
    });
    expect(sig).toBe('REBATE_SIG');
    const url = new URL(calls[0]!.url);
    expect(url.host).toBe('mainnet.helius-rpc.com');
    expect(url.searchParams.get('api-key')).toBe('envkey');
    expect(url.searchParams.get('rebate-address')).toBe(REBATE);
  });

  it('falls back (no fetch) when neither the caller RPC nor env is Helius', async () => {
    const { fetchImpl, calls } = okFetch('REBATE_SIG');
    const fallback = vi.fn(async () => 'FALLBACK_SIG');
    const sig = await sendRawTransactionWithRebate(SIGNED_TX_B64, fallback, {
      env: { HELIUS_REBATE_ADDRESS: REBATE },
      rpcUrl: 'https://some-other-rpc.example',
      fetchImpl,
    });
    expect(sig).toBe('FALLBACK_SIG');
    expect(calls).toHaveLength(0);
  });

  it('falls back when the rebate POST throws (landing never degraded)', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const fallback = vi.fn(async () => 'FALLBACK_SIG');
    const sig = await sendRawTransactionWithRebate(SIGNED_TX_B64, fallback, {
      env: { HELIUS_REBATE_ADDRESS: REBATE },
      rpcUrl: HELIUS_RPC,
      fetchImpl,
    });
    expect(sig).toBe('FALLBACK_SIG');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('falls back when the rebate POST returns no signature', async () => {
    const { fetchImpl } = okFetch(null);
    const fallback = vi.fn(async () => 'FALLBACK_SIG');
    const sig = await sendRawTransactionWithRebate(SIGNED_TX_B64, fallback, {
      env: { HELIUS_REBATE_ADDRESS: REBATE },
      rpcUrl: HELIUS_RPC,
      fetchImpl,
    });
    expect(sig).toBe('FALLBACK_SIG');
  });
});
