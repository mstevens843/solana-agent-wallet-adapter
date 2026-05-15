import type { SupportedCluster } from './types.js';

export const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export function defaultUsdcMint(cluster?: SupportedCluster): string {
  return cluster === 'devnet' ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
}

export function isUsdcMint(mint: string): boolean {
  return mint === USDC_MINT_MAINNET || mint === USDC_MINT_DEVNET;
}
