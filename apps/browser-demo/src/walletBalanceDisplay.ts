import { WALLET_BALANCE_SOL_MINT } from './walletBalanceSummary.js';

export interface WalletBalanceDisplayAsset {
  mint: string;
  symbol: string;
}

export interface WalletBalanceDisplayMetadata {
  name?: string;
}

export function walletBalanceAssetTitle(
  asset: WalletBalanceDisplayAsset,
  metadata?: WalletBalanceDisplayMetadata,
): string {
  if (asset.mint === WALLET_BALANCE_SOL_MINT) return 'SOL';
  const symbol = asset.symbol || '';
  const name = metadata?.name?.trim();
  return (name && name !== symbol ? name : symbol) || symbol;
}
