import { describe, expect, it } from 'vitest';

import {
  WALLET_BALANCE_SOL_MINT,
  WALLET_BALANCE_USDC_MINT,
  buildWalletBalanceSnapshot,
  formatWalletBalanceSnapshotUsd,
  formatWalletBalanceUsd,
  walletBalanceFallbackPriceMap,
  walletBalancePriceInfoMapFromBirdeye,
  walletBalancePriceInfoMapFromJupiter,
  walletBalancePriceMapFromBirdeye,
  walletBalanceRowsFromParsedAccounts,
  walletBalanceUsdPricingEnabled,
} from '../walletBalance.js';

const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function parsedTokenAccount(mint: string, amount: string, decimals: number, uiAmountString: string) {
  return {
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: {
              amount,
              decimals,
              uiAmountString,
            },
          },
        },
      },
    },
  };
}

describe('wallet balance helpers', () => {
  it('parses parsed token accounts into nonzero token rows', () => {
    expect(walletBalanceRowsFromParsedAccounts({
      value: [
        parsedTokenAccount(WALLET_BALANCE_USDC_MINT, '12345600', 6, '12.3456'),
        parsedTokenAccount(JUP_MINT, '0', 6, '0'),
      ],
    }, 'token')).toEqual([{
      mint: WALLET_BALANCE_USDC_MINT,
      amount: 12.3456,
      decimals: 6,
      rawAmount: '12345600',
      source: 'token',
    }]);
  });

  it('builds primary and full snapshots with explicit coverage', () => {
    const prices = new Map([
      [WALLET_BALANCE_SOL_MINT, 150],
      [WALLET_BALANCE_USDC_MINT, 1],
    ]);
    const primary = buildWalletBalanceSnapshot({
      walletAddress: 'Wallet111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      solLamports: 2_000_000_000,
      tokenRows: [{ mint: WALLET_BALANCE_USDC_MINT, amount: 25.5, decimals: 6, source: 'token' }],
      prices,
      coverage: 'primary',
      loadedAt: 100,
    });
    const full = buildWalletBalanceSnapshot({
      walletAddress: 'Wallet111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      solLamports: 2_000_000_000,
      tokenRows: [{ mint: WALLET_BALANCE_USDC_MINT, amount: 25.5, decimals: 6, source: 'token' }],
      prices,
      coverage: 'full',
      loadedAt: 100,
    });

    expect(primary.totalUsd).toBe(325.5);
    expect(primary.coverage).toBe('primary');
    expect(primary.priceStatus).toBe('ready');
    expect(formatWalletBalanceSnapshotUsd(primary, { markPartialCoverage: true })).toBe('$325.50+');
    expect(formatWalletBalanceSnapshotUsd(full, { markPartialCoverage: true })).toBe('$325.50');
  });

  it('hides missing-price full-token dust instead of marking totals partial', () => {
    const snapshot = buildWalletBalanceSnapshot({
      walletAddress: 'Wallet111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      solLamports: 1_000_000_000,
      tokenRows: [
        { mint: WALLET_BALANCE_USDC_MINT, amount: 5, decimals: 6, source: 'token' },
        { mint: JUP_MINT, amount: 10, decimals: 6, source: 'token' },
      ],
      prices: new Map([
        [WALLET_BALANCE_SOL_MINT, 100],
        [WALLET_BALANCE_USDC_MINT, 1],
      ]),
      coverage: 'full',
    });

    expect(snapshot.priceStatus).toBe('ready');
    expect(snapshot.hasMissingPrices).toBe(false);
    expect(snapshot.others).toEqual([]);
    expect(formatWalletBalanceSnapshotUsd(snapshot)).toBe('$105.00');
  });

  it('marks visible core balances partial when their price is missing', () => {
    const snapshot = buildWalletBalanceSnapshot({
      walletAddress: 'Wallet111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      solLamports: 1_000_000_000,
      tokenRows: [{ mint: WALLET_BALANCE_USDC_MINT, amount: 5, decimals: 6, source: 'token' }],
      prices: new Map([[WALLET_BALANCE_USDC_MINT, 1]]),
      coverage: 'full',
    });

    expect(snapshot.priceStatus).toBe('partial');
    expect(snapshot.hasMissingPrices).toBe(true);
    expect(formatWalletBalanceSnapshotUsd(snapshot)).toBe('$5.00+');
  });

  it('treats non-mainnet USD pricing as unavailable', () => {
    const snapshot = buildWalletBalanceSnapshot({
      walletAddress: 'Wallet111111111111111111111111111111111',
      cluster: 'devnet',
      solLamports: 1_000_000_000,
      tokenRows: [],
      prices: walletBalanceFallbackPriceMap([WALLET_BALANCE_USDC_MINT], 'devnet'),
      pricingEnabled: walletBalanceUsdPricingEnabled('devnet'),
    });

    expect(snapshot.priceStatus).toBe('unavailable');
    expect(snapshot.hasMissingPrices).toBe(false);
    expect(formatWalletBalanceSnapshotUsd(snapshot)).toBe('USD unavailable');
  });

  it('parses Birdeye multi-price payload variants and tiny USD values', () => {
    const prices = walletBalancePriceMapFromBirdeye({
      data: {
        [WALLET_BALANCE_SOL_MINT]: { data: { value: '142.25' } },
        [WALLET_BALANCE_USDC_MINT]: 1,
      },
    });

    expect(prices.get(WALLET_BALANCE_SOL_MINT)).toBe(142.25);
    expect(prices.get(WALLET_BALANCE_USDC_MINT)).toBe(1);
    expect(formatWalletBalanceUsd(0.004)).toBe('<$0.01');
  });

  it('parses Birdeye and Jupiter liquidity metadata', () => {
    const birdeye = walletBalancePriceInfoMapFromBirdeye({
      data: {
        [WALLET_BALANCE_SOL_MINT]: { value: '142.25', liquidity: '7000000000' },
      },
    });
    const jupiter = walletBalancePriceInfoMapFromJupiter({
      [JUP_MINT]: { usdPrice: 0.5, liquidity: 50_000 },
    });

    expect(birdeye.get(WALLET_BALANCE_SOL_MINT)).toMatchObject({
      priceUsd: 142.25,
      liquidityUsd: 7_000_000_000,
      source: 'birdeye',
    });
    expect(jupiter.get(JUP_MINT)).toMatchObject({
      priceUsd: 0.5,
      liquidityUsd: 50_000,
      source: 'jupiter',
    });
  });

  it('filters non-core tokens below value or liquidity floors', () => {
    const liquidMint = 'Liquid11111111111111111111111111111111111';
    const lowValueMint = 'LowValue111111111111111111111111111111111';
    const lowLiquidityMint = 'LowLiq1111111111111111111111111111111111';
    const snapshot = buildWalletBalanceSnapshot({
      walletAddress: 'Wallet111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      solLamports: 0,
      tokenRows: [
        { mint: liquidMint, amount: 10, decimals: 6, source: 'token' },
        { mint: lowValueMint, amount: 0.001, decimals: 6, source: 'token' },
        { mint: lowLiquidityMint, amount: 10, decimals: 6, source: 'token' },
      ],
      prices: new Map(),
      priceInfo: new Map([
        [liquidMint, { priceUsd: 0.25, liquidityUsd: 10_000, source: 'jupiter' }],
        [lowValueMint, { priceUsd: 0.25, liquidityUsd: 10_000, source: 'jupiter' }],
        [lowLiquidityMint, { priceUsd: 0.25, liquidityUsd: 999, source: 'jupiter' }],
      ]),
      coverage: 'full',
    });

    expect(snapshot.others.map((asset) => asset.mint)).toEqual([liquidMint]);
    expect(snapshot.totalUsd).toBe(2.5);
    expect(snapshot.hasMissingPrices).toBe(false);
  });
});
