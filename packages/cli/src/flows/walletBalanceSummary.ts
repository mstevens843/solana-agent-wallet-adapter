import {
  formatWalletBalanceAmount,
  formatWalletBalanceSnapshotUsd,
  formatWalletBalanceUsd,
  type WalletBalanceAsset,
  type WalletBalanceSnapshot,
} from '@solana-agent-wallet-adapter/core';

import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';
import { badge, divider, header, kv } from '../tui/index.js';

const WALLET_BALANCE_CLI_TIMEOUT_MS = 3_500;

interface CliWalletBalanceRows {
  total: string;
  sol: string;
  usdc: string;
  priceWarning: boolean;
}

export async function renderWalletBalanceSummary(options: GlobalOptions): Promise<void> {
  try {
    const snapshot = await loadCliWalletBalanceSnapshot(options);
    const rows = buildCliWalletBalanceRows(snapshot);
    console.log();
    console.log(header('Wallet value'));
    console.log(kv([
      [snapshot.coverage === 'primary' ? 'Total (SOL + USDC)' : 'Total', rows.total],
      ['SOL', rows.sol],
      ['USDC', rows.usdc],
    ]));
    console.log(divider());
    console.log(badge(rows.priceWarning ? walletBalanceWarningLabel(snapshot) : 'Balance summary loaded', rows.priceWarning ? 'warn' : 'ok'));
  } catch {
    console.log();
    console.log(header('Wallet value'));
    console.log(badge('Balance summary unavailable', 'warn'));
  }
}

export function buildCliWalletBalanceRows(snapshot: WalletBalanceSnapshot): CliWalletBalanceRows {
  return {
    total: formatWalletBalanceSnapshotUsd(snapshot),
    sol: formatCliWalletAsset(snapshot.sol, snapshot),
    usdc: formatCliWalletAsset(snapshot.usdc, snapshot),
    priceWarning: snapshot.priceStatus !== 'ready',
  };
}

async function loadCliWalletBalanceSnapshot(options: GlobalOptions): Promise<WalletBalanceSnapshot> {
  return withTimeout(bridgeRequest<WalletBalanceSnapshot>(options, '/bridge/action/wallet-balance-summary', {
    method: 'POST',
    body: JSON.stringify({ mode: 'primary' }),
  }), WALLET_BALANCE_CLI_TIMEOUT_MS);
}

function formatCliWalletAsset(asset: WalletBalanceAsset, snapshot: WalletBalanceSnapshot): string {
  const amount = formatWalletBalanceAmount(asset.amount, asset.symbol);
  if (asset.valueUsd !== undefined) return `${amount}  ${formatWalletBalanceUsd(asset.valueUsd)}`;
  return `${amount}  ${snapshot.priceStatus === 'unavailable' ? 'USD unavailable' : 'price unavailable'}`;
}

function walletBalanceWarningLabel(snapshot: WalletBalanceSnapshot): string {
  return snapshot.priceStatus === 'unavailable'
    ? `USD unavailable on ${snapshot.cluster}`
    : 'Prices partially unavailable';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Wallet balance summary timed out.')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
