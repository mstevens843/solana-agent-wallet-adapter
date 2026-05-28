import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WALLET_BALANCE_SOL_MINT,
  WALLET_BALANCE_USDC_MINT,
  type WalletBalanceSnapshot,
} from '@solana-agent-wallet-adapter/core';

import {
  buildCliWalletBalanceRows,
} from '../flows/walletBalanceSummary.js';

test('buildCliWalletBalanceRows renders total, SOL, and USDC values', () => {
  const rows = buildCliWalletBalanceRows(snapshot({
    totalUsd: 325.5,
    solAmount: 2,
    solUsd: 300,
    usdcAmount: 25.5,
    usdcUsd: 25.5,
  }));

  assert.equal(rows.total, '$325.50');
  assert.equal(rows.sol, '2 SOL  $300.00');
  assert.equal(rows.usdc, '25.50 USDC  $25.50');
  assert.equal(rows.priceWarning, false);
});

test('buildCliWalletBalanceRows reports unavailable USD pricing by cluster', () => {
  const rows = buildCliWalletBalanceRows(snapshot({
    cluster: 'devnet',
    priceStatus: 'unavailable',
    totalUsd: 0,
    solAmount: 1,
    usdcAmount: 5,
  }));

  assert.equal(rows.total, 'USD unavailable');
  assert.equal(rows.sol, '1 SOL  USD unavailable');
  assert.equal(rows.usdc, '5.00 USDC  USD unavailable');
  assert.equal(rows.priceWarning, true);
});

function snapshot(input: {
  cluster?: string;
  priceStatus?: WalletBalanceSnapshot['priceStatus'];
  totalUsd: number;
  solAmount: number;
  solUsd?: number;
  usdcAmount: number;
  usdcUsd?: number;
}): WalletBalanceSnapshot {
  return {
    walletAddress: 'Wallet111111111111111111111111111111111',
    cluster: input.cluster ?? 'mainnet-beta',
    loadedAt: 100,
    coverage: 'primary',
    totalUsd: input.totalUsd,
    hasMissingPrices: input.priceStatus === 'partial',
    priceStatus: input.priceStatus ?? 'ready',
    sol: {
      mint: WALLET_BALANCE_SOL_MINT,
      symbol: 'SOL',
      amount: input.solAmount,
      decimals: 9,
      source: 'native',
      ...(input.solUsd !== undefined ? { priceUsd: input.solUsd / input.solAmount, valueUsd: input.solUsd } : {}),
    },
    usdc: {
      mint: WALLET_BALANCE_USDC_MINT,
      symbol: 'USDC',
      amount: input.usdcAmount,
      decimals: 6,
      source: 'token',
      ...(input.usdcUsd !== undefined ? { priceUsd: input.usdcUsd / input.usdcAmount, valueUsd: input.usdcUsd } : {}),
    },
    others: [],
  };
}
