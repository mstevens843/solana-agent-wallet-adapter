import { describe, expect, it } from 'vitest';

import {
  WALLET_BALANCE_SOL_MINT,
  WALLET_BALANCE_USDC_MINT,
  buildWalletBalanceSnapshot,
  formatWalletBalanceSnapshotUsd,
  formatWalletBalanceUsd,
  walletBalanceFallbackPriceMap,
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

  it('marks missing full-token prices as partial', () => {
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

    expect(snapshot.priceStatus).toBe('partial');
    expect(snapshot.hasMissingPrices).toBe(true);
    expect(formatWalletBalanceSnapshotUsd(snapshot)).toBe('$105.00+');
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
});
