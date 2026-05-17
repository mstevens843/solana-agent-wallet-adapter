import { describe, expect, it } from 'vitest';

import { resolveAtom, type AgentAtom } from '@solana-agent-wallet-adapter/workflow';

import { AlternativeMeClient } from '../../adapters/alternative_me/index.js';
import type { AgentWalletConfig } from '../../config.js';
import {
  KNOWN_SYMBOL_COINGECKO_IDS,
  KNOWN_SYMBOL_MINTS,
  coingeckoIdForSymbol,
  createMcpCapabilityResolver,
  mintForSymbol,
} from '../index.js';

function priceAtom(subject: string): AgentAtom {
  return { id: `atom.price.${subject.toLowerCase()}.gt.0`, type: 'price', rawText: '', subject, op: 'gt', value: 0, unit: 'USD' };
}
function fearGreedAtom(): AgentAtom {
  return { id: 'atom.market_regime.fear_and_greed.gt.20', type: 'market_regime', rawText: '', subject: 'fear_and_greed', op: 'gt', value: 20 };
}
function btcDominanceAtom(): AgentAtom {
  return { id: 'atom.market_regime.btc_dominance.gt.50', type: 'market_regime', rawText: '', subject: 'btc_dominance', op: 'gt', value: 50 };
}
function externalPriceAtom(): AgentAtom {
  return { id: 'atom.external_price.foo.lt.20', type: 'external_price', rawText: '', subject: 'foo plan', op: 'lt', value: 20, unit: 'USD' };
}
function txGateAtom(): AgentAtom {
  return { id: 'atom.tx_gate.no_extra_transfers', type: 'tx_gate', rawText: '', rule: 'no_extra_transfers' };
}

const STUB_CONFIG: AgentWalletConfig = {
  cluster: 'mainnet-beta',
  rpcUrl: 'https://api.mainnet-beta.solana.com',
} as unknown as AgentWalletConfig;

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

describe('symbol mapping helpers', () => {
  it('maps canonical Solana symbols to their mainnet mints', () => {
    expect(mintForSymbol('SOL')).toBe(KNOWN_SYMBOL_MINTS.SOL);
    expect(mintForSymbol('usdc')).toBe(KNOWN_SYMBOL_MINTS.USDC);
    expect(mintForSymbol('UNKNOWN_TOKEN')).toBeUndefined();
  });

  it('maps cross-chain symbols to CoinGecko ids', () => {
    expect(coingeckoIdForSymbol('BTC')).toBe(KNOWN_SYMBOL_COINGECKO_IDS.BTC);
    expect(coingeckoIdForSymbol('eth')).toBe(KNOWN_SYMBOL_COINGECKO_IDS.ETH);
    expect(coingeckoIdForSymbol('SOL')).toBe('solana');
    expect(coingeckoIdForSymbol('BONK')).toBeUndefined();
  });
});

describe('createMcpCapabilityResolver — alternative_me fear_and_greed', () => {
  it('resolves via the AlternativeMeClient', async () => {
    const alt = new AlternativeMeClient({
      fetchImpl: jsonFetch({ data: [{ value: '42', value_classification: 'Fear', timestamp: '1700000000' }] }),
      ttlMs: 60_000,
    });
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG, alternativeMe: alt });
    const result = await resolveAtom(fearGreedAtom(), resolver, { retryDelayMs: 0 });
    expect(result.resolved?.source).toBe('alternative_me');
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(42);
  });

  it('falls through when AlternativeMeClient returns nothing', async () => {
    const alt = new AlternativeMeClient({
      fetchImpl: jsonFetch({ data: [] }),
      ttlMs: 60_000,
    });
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG, alternativeMe: alt });
    const result = await resolveAtom(fearGreedAtom(), resolver, { retryDelayMs: 0 });
    // First tier (alternative_me) returns missing; chain continues to coingecko (which fails
    // without a real fetch) then to web (which intentionally defers).
    expect(result.attempts[0]!.source).toBe('alternative_me');
    expect(result.attempts[0]!.status).toBe('missing');
  });
});

describe('createMcpCapabilityResolver — tx_gate atoms', () => {
  it('returns missing because tx_gate atoms are handled by the post-process analyzer, not the resolver', async () => {
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG });
    const result = await resolveAtom(txGateAtom(), resolver, { retryDelayMs: 0 });
    expect(result.exhausted).toBe(true);
    expect(result.attempts[0]!.status).toBe('missing');
    expect(result.attempts[0]!.detail).toMatch(/post-processed/);
  });
});

describe('createMcpCapabilityResolver — external_price atoms', () => {
  it('deferred to research pass (web tier returns missing with the deferred marker)', async () => {
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG });
    const result = await resolveAtom(externalPriceAtom(), resolver, { retryDelayMs: 0 });
    // The whole chain for external_price is web-only; web returns "deferred_to_research_pass".
    expect(result.exhausted).toBe(true);
    expect(result.attempts.every((a) => a.source === 'web')).toBe(true);
    expect(result.attempts[0]!.detail).toBe('deferred_to_research_pass');
  });
});

describe('createMcpCapabilityResolver — price atoms (Jupiter unmapped symbol falls through)', () => {
  it('returns missing on jupiter when the symbol has no Solana mint mapping', async () => {
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG });
    // 'XYZ' is not in KNOWN_SYMBOL_MINTS and is too short to be a mint address.
    const result = await resolveAtom(priceAtom('XYZ'), resolver, { retryDelayMs: 0 });
    expect(result.attempts[0]!.source).toBe('jupiter');
    expect(result.attempts[0]!.status).toBe('missing');
  });
});

describe('createMcpCapabilityResolver — market_regime btc_dominance routes to coingecko first', () => {
  it('skips alternative_me for non-fear-and-greed subjects', async () => {
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG });
    const result = await resolveAtom(btcDominanceAtom(), resolver, { retryDelayMs: 0 });
    // First tier of btc_dominance chain is coingecko (alternative_me is gated to fear_and_greed only).
    expect(result.attempts[0]!.source).toBe('coingecko');
  });
});
