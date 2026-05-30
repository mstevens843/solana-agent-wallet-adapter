import { describe, expect, it } from 'vitest';

import {
  WALLET_BALANCE_SOL_MINT,
  WALLET_BALANCE_USDC_MINT,
  buildWalletBalanceSnapshot,
  formatWalletBalanceAmount,
  formatWalletBalanceUsd,
  walletBalancePriceInfoMapFromBirdeye,
  walletBalancePriceInfoMapFromJupiter,
  walletBalancePriceMapFromBirdeye,
  walletBalanceRowsFromParsedAccounts,
} from '../walletBalanceSummary.js';

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

describe('wallet balance summary helpers', () => {
  it('parses nonzero parsed token accounts', () => {
    const rows = walletBalanceRowsFromParsedAccounts({
      value: [
        parsedTokenAccount(WALLET_BALANCE_USDC_MINT, '12345600', 6, '12.3456'),
        parsedTokenAccount(JUP_MINT, '0', 6, '0'),
      ],
    }, 'token');

    expect(rows).toEqual([{
      mint: WALLET_BALANCE_USDC_MINT,
      amount: 12.3456,
      decimals: 6,
      rawAmount: '12345600',
      source: 'token',
    }]);
  });

  it('builds SOL plus USDC value without requiring full holdings', () => {
    const prices = new Map([
      [WALLET_BALANCE_SOL_MINT, 150],
      [WALLET_BALANCE_USDC_MINT, 1],
    ]);
    const snapshot = buildWalletBalanceSnapshot({
      walletAddress: 'Wallet111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      solLamports: 2_000_000_000,
      tokenRows: [{ mint: WALLET_BALANCE_USDC_MINT, amount: 25.5, decimals: 6, source: 'token' }],
      prices,
      loadedAt: 100,
    });

    expect(snapshot.totalUsd).toBe(325.5);
    expect(snapshot.hasMissingPrices).toBe(false);
    expect(snapshot.sol.valueUsd).toBe(300);
    expect(snapshot.usdc.valueUsd).toBe(25.5);
    expect(snapshot.others).toEqual([]);
  });

  it('hides full-token rows that have no reliable value', () => {
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
    });

    expect(snapshot.totalUsd).toBe(105);
    expect(snapshot.hasMissingPrices).toBe(false);
    expect(snapshot.others).toEqual([]);
  });

  it('parses Birdeye multi-price payload variants', () => {
    const prices = walletBalancePriceMapFromBirdeye({
      data: {
        [WALLET_BALANCE_SOL_MINT]: { value: 142.25 },
        [WALLET_BALANCE_USDC_MINT]: 1,
      },
    });

    expect(prices.get(WALLET_BALANCE_SOL_MINT)).toBe(142.25);
    expect(prices.get(WALLET_BALANCE_USDC_MINT)).toBe(1);
  });

  it('parses balance price metadata from Birdeye and Jupiter payloads', () => {
    expect(walletBalancePriceInfoMapFromBirdeye({
      data: { [WALLET_BALANCE_SOL_MINT]: { value: 142.25, liquidity: 7_000_000_000 } },
    }).get(WALLET_BALANCE_SOL_MINT)).toMatchObject({
      priceUsd: 142.25,
      liquidityUsd: 7_000_000_000,
      source: 'birdeye',
    });
    expect(walletBalancePriceInfoMapFromJupiter({
      [JUP_MINT]: { usdPrice: 0.5, liquidity: 50_000 },
    }).get(JUP_MINT)).toMatchObject({
      priceUsd: 0.5,
      liquidityUsd: 50_000,
      source: 'jupiter',
    });
  });

  it('keeps only liquid non-core balances worth at least one cent', () => {
    const liquidMint = 'Liquid11111111111111111111111111111111111';
    const dustMint = 'Dust1111111111111111111111111111111111111';
    const snapshot = buildWalletBalanceSnapshot({
      walletAddress: 'Wallet111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      solLamports: 0,
      tokenRows: [
        { mint: liquidMint, amount: 2, decimals: 6, source: 'token' },
        { mint: dustMint, amount: 0.001, decimals: 6, source: 'token' },
      ],
      prices: new Map(),
      priceInfo: new Map([
        [liquidMint, { priceUsd: 1, liquidityUsd: 1_001, source: 'jupiter' }],
        [dustMint, { priceUsd: 1, liquidityUsd: 1_001, source: 'jupiter' }],
      ]),
    });

    expect(snapshot.others.map((asset) => asset.mint)).toEqual([liquidMint]);
  });

  it('formats compact amounts and partial USD totals', () => {
    expect(formatWalletBalanceAmount(0.1234567, 'SOL')).toBe('0.123457 SOL');
    expect(formatWalletBalanceAmount(12.3, 'USDC')).toBe('12.30 USDC');
    expect(formatWalletBalanceUsd(1234.5, true)).toBe('$1,234.50+');
  });
});
