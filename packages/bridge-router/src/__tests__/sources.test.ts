import { describe, expect, it } from 'vitest';

import {
  createDirectStablecoinSource,
  createJupiterSource,
  createSanctumSource,
  createStubStablecoinSource,
  createWormholeSource,
  type JupiterRouterQuote,
  type JupiterSwapClient,
  type SanctumLstClient,
  type SanctumRouterQuote,
  type WormholeQuoteClient,
  type WormholeRouterQuote,
} from '../sources.js';
import type { QuoteContext, SettlementRequest } from '../types.js';
import { USDC_MINT_MAINNET } from '../usdc.js';

const RECIPIENT = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JITO_SOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';

function ctx(request: SettlementRequest): QuoteContext {
  return {
    request,
    signal: new AbortController().signal,
    now: () => new Date('2026-01-01T00:00:00Z'),
  };
}

describe('createStubStablecoinSource', () => {
  it('returns a deterministic 1:1 USDC route for a valid USD amount', async () => {
    const source = createStubStablecoinSource();
    const route = await source.quote(ctx({ usdAmount: '50', recipient: RECIPIENT }));
    expect(route).not.toBeNull();
    expect(route!.sourceId).toBe('stub-stablecoin');
    expect(route!.expectedUsdOut).toBe('50');
    expect(route!.estimatedCostUsd).toBe('50');
    expect(route!.slippageBps).toBe(50);
    expect(route!.hops).toHaveLength(1);
    const hop = route!.hops[0]!;
    if (hop.kind !== 'direct') throw new Error('expected direct hop');
    expect(hop.mint).toBe(USDC_MINT_MAINNET);
    expect(hop.amountRaw).toBe('50000000');
    expect(hop.decimals).toBe(6);
    expect(route!.warnings).toContain('Synthetic 1:1 quote — no live pricing.');
  });

  it('honors a custom slippageBps option', async () => {
    const source = createStubStablecoinSource({ slippageBps: 200 });
    const route = await source.quote(ctx({ usdAmount: '50', recipient: RECIPIENT }));
    expect(route!.slippageBps).toBe(200);
  });

  it('honors a custom estimatedFeeUsd (folded into estimatedCostUsd)', async () => {
    const source = createStubStablecoinSource({ estimatedFeeUsd: '0.50' });
    const route = await source.quote(ctx({ usdAmount: '50', recipient: RECIPIENT }));
    expect(route!.estimatedCostUsd).toBe('50.5');
  });

  it('sets expiresAtIso based on injected now()', async () => {
    const fixed = new Date('2026-01-01T00:00:00Z');
    const source = createStubStablecoinSource({ ttlMs: 30_000 });
    const route = await source.quote({
      request: { usdAmount: '50', recipient: RECIPIENT },
      signal: new AbortController().signal,
      now: () => fixed,
    });
    expect(route!.expiresAtIso).toBe(new Date(fixed.getTime() + 30_000).toISOString());
  });

  it('returns null when targetMint is a non-USDC mint', async () => {
    const source = createStubStablecoinSource();
    const route = await source.quote(
      ctx({ usdAmount: '50', recipient: RECIPIENT, targetMint: SOL_MINT }),
    );
    expect(route).toBeNull();
  });

  it('returns null when usdAmount is malformed', async () => {
    const source = createStubStablecoinSource();
    const route = await source.quote(ctx({ usdAmount: 'abc', recipient: RECIPIENT }));
    expect(route).toBeNull();
  });

  it('honors a fixedUsdcMint override', async () => {
    const source = createStubStablecoinSource({ fixedUsdcMint: USDC_MINT_MAINNET });
    const route = await source.quote(
      ctx({ usdAmount: '50', recipient: RECIPIENT, cluster: 'devnet' }),
    );
    expect(route).not.toBeNull();
    const hop = route!.hops[0]!;
    if (hop.kind !== 'direct') throw new Error('expected direct hop');
    expect(hop.mint).toBe(USDC_MINT_MAINNET);
  });
});

describe('createDirectStablecoinSource', () => {
  const source = createDirectStablecoinSource();

  it('returns null when payerHoldings is empty', async () => {
    const route = await source.quote(ctx({ usdAmount: '50', recipient: RECIPIENT }));
    expect(route).toBeNull();
  });

  it('returns null when target is not USDC', async () => {
    const route = await source.quote(
      ctx({
        usdAmount: '50',
        recipient: RECIPIENT,
        targetMint: SOL_MINT,
        payerHoldings: [{ mint: USDC_MINT_MAINNET, amountRaw: '100000000', decimals: 6 }],
      }),
    );
    expect(route).toBeNull();
  });

  it('returns null when payer has insufficient USDC', async () => {
    const route = await source.quote(
      ctx({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [{ mint: USDC_MINT_MAINNET, amountRaw: '1000000', decimals: 6 }],
      }),
    );
    expect(route).toBeNull();
  });

  it('returns a direct route with zero slippage when payer holds enough USDC', async () => {
    const route = await source.quote(
      ctx({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [{ mint: USDC_MINT_MAINNET, amountRaw: '100000000', decimals: 6 }],
      }),
    );
    expect(route).not.toBeNull();
    expect(route!.sourceId).toBe('direct-usdc');
    expect(route!.expectedUsdOut).toBe('50');
    expect(route!.estimatedCostUsd).toBe('50');
    expect(route!.slippageBps).toBe(0);
    expect(route!.hops).toHaveLength(1);
    const hop = route!.hops[0]!;
    expect(hop.kind).toBe('direct');
    if (hop.kind !== 'direct') throw new Error('expected direct hop');
    expect(hop.mint).toBe(USDC_MINT_MAINNET);
    expect(hop.amountRaw).toBe('50000000');
    expect(hop.decimals).toBe(6);
  });
});

describe('createJupiterSource', () => {
  function stubClient(quote: JupiterRouterQuote | null): JupiterSwapClient {
    return { async getQuote() { return quote; } };
  }

  it('returns null when no payer holdings (no input mint chosen)', async () => {
    const source = createJupiterSource(stubClient(null));
    const route = await source.quote(ctx({ usdAmount: '50', recipient: RECIPIENT }));
    expect(route).toBeNull();
  });

  it('returns null when injected client returns null', async () => {
    const source = createJupiterSource(stubClient(null));
    const route = await source.quote(
      ctx({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [{ mint: SOL_MINT, amountRaw: '1000000000', decimals: 9 }],
      }),
    );
    expect(route).toBeNull();
  });

  it('shapes a Jupiter route with slippage cost folded into estimatedCostUsd', async () => {
    const source = createJupiterSource(
      stubClient({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT_MAINNET,
        inputAmountRaw: '500000000',
        outputAmountRaw: '50000000',
        slippageBps: 50,
        inputUsdValue: '50',
        estimatedFeeUsd: '0.10',
      }),
    );
    const route = await source.quote(
      ctx({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [{ mint: SOL_MINT, amountRaw: '1000000000', decimals: 9 }],
      }),
    );
    expect(route).not.toBeNull();
    expect(route!.sourceId).toBe('jupiter');
    expect(route!.expectedUsdOut).toBe('50');
    expect(Number(route!.estimatedCostUsd)).toBeGreaterThan(50.1);
    expect(Number(route!.estimatedCostUsd)).toBeLessThan(50.5);
    expect(route!.slippageBps).toBe(50);
    const hop = route!.hops[0]!;
    expect(hop.kind).toBe('jupiter-swap');
    if (hop.kind !== 'jupiter-swap') throw new Error('expected jupiter-swap hop');
    expect(hop.inputMint).toBe(SOL_MINT);
    expect(hop.outputMint).toBe(USDC_MINT_MAINNET);
  });

  it('propagates warnings from the injected client into the final route', async () => {
    const source = createJupiterSource(
      stubClient({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT_MAINNET,
        inputAmountRaw: '500000000',
        outputAmountRaw: '50000000',
        slippageBps: 50,
        inputUsdValue: '50',
        warnings: ['high price impact', 'low liquidity'],
      }),
    );
    const route = await source.quote(
      ctx({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [{ mint: SOL_MINT, amountRaw: '1000000000', decimals: 9 }],
      }),
    );
    expect(route!.warnings).toEqual(['high price impact', 'low liquidity']);
  });
});

describe('createSanctumSource', () => {
  function stubClient(quote: SanctumRouterQuote | null): SanctumLstClient {
    return { async getQuote() { return quote; } };
  }

  it('returns null when target is USDC (not an LST)', async () => {
    const source = createSanctumSource(stubClient({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT_MAINNET,
      inputAmountRaw: '0',
      outputAmountRaw: '0',
      routeSources: ['Inf'],
    }));
    const route = await source.quote(
      ctx({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [{ mint: SOL_MINT, amountRaw: '1000000000', decimals: 9 }],
      }),
    );
    expect(route).toBeNull();
  });

  it('returns a sanctum-swap route when target is an LST and client returns a quote', async () => {
    const source = createSanctumSource(stubClient({
      inputMint: SOL_MINT,
      outputMint: JITO_SOL_MINT,
      inputAmountRaw: '1000000000',
      outputAmountRaw: '900000000',
      routeSources: ['Inf', 'SanctumRouter'],
      slippageBps: 25,
      inputUsdValue: '50',
      estimatedFeeUsd: '0.05',
    }));
    const route = await source.quote(
      ctx({
        usdAmount: '50',
        recipient: RECIPIENT,
        targetMint: JITO_SOL_MINT,
        payerHoldings: [{ mint: SOL_MINT, amountRaw: '1000000000', decimals: 9 }],
      }),
    );
    expect(route).not.toBeNull();
    expect(route!.sourceId).toBe('sanctum');
    expect(route!.slippageBps).toBe(25);
    const hop = route!.hops[0]!;
    expect(hop.kind).toBe('sanctum-swap');
    if (hop.kind !== 'sanctum-swap') throw new Error('expected sanctum-swap hop');
    expect(hop.routeSources).toEqual(['Inf', 'SanctumRouter']);
  });
});

describe('createWormholeSource', () => {
  function stubClient(quote: WormholeRouterQuote | null): WormholeQuoteClient {
    return { async getQuote() { return quote; } };
  }

  it('returns null when no destinationChain override is set', async () => {
    const source = createWormholeSource(stubClient(null));
    const route = await source.quote(
      ctx({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [{ mint: SOL_MINT, amountRaw: '1000000000', decimals: 9 }],
      }),
    );
    expect(route).toBeNull();
  });

  it('returns null when client returns null even with destinationChain override', async () => {
    const source = createWormholeSource(stubClient(null), { destinationChain: 'Ethereum' });
    const route = await source.quote(
      ctx({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [{ mint: SOL_MINT, amountRaw: '1000000000', decimals: 9 }],
      }),
    );
    expect(route).toBeNull();
  });

  it('shapes a wormhole-bridge route when the client returns a quote', async () => {
    const source = createWormholeSource(
      stubClient({
        sourceChain: 'Solana',
        destinationChain: 'Ethereum',
        sourceMint: SOL_MINT,
        destinationToken: '0xUSDCmainnet',
        inputAmountRaw: '1000000000',
        outputAmountRaw: '50000000',
        bridgeFee: '50000',
        bridgeFeeUsd: '0.50',
        etaSeconds: 600,
        inputUsdValue: '50',
      }),
      { destinationChain: 'Ethereum' },
    );
    const route = await source.quote(
      ctx({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [{ mint: SOL_MINT, amountRaw: '1000000000', decimals: 9 }],
      }),
    );
    expect(route).not.toBeNull();
    expect(route!.sourceId).toBe('wormhole');
    const hop = route!.hops[0]!;
    expect(hop.kind).toBe('wormhole-bridge');
    if (hop.kind !== 'wormhole-bridge') throw new Error('expected wormhole-bridge hop');
    expect(hop.destinationChain).toBe('Ethereum');
    expect(hop.etaSeconds).toBe(600);
    expect(Number(route!.estimatedCostUsd)).toBeGreaterThan(50.5);
  });
});
