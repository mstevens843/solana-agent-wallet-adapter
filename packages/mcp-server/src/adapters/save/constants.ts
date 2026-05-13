import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const SAVE_ADAPTER_ID = 'save' as const;
export const SAVE_NAME = 'Save';
export const SAVE_WEBSITE = 'https://save.finance';
export const SAVE_DESCRIPTION =
  'Supply, withdraw, borrow, or repay against Save (formerly Solend) Lend reserves. Health-aware presign review so borrow and withdraw refuse to execute when projected health factor breaches the configured minimum.';

export const SAVE_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

// Solend (Save) lending program — mainnet.
export const SOLEND_PROGRAM_ID = new PublicKey('So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo');

// Save Main Market on mainnet — the canonical multi-asset pool.
export const SAVE_MAIN_MARKET = new PublicKey('4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY');

// Default minimum projected health factor for borrow/withdraw gating.
// Liquidation threshold is 1.0; 1.10 leaves a 10% buffer.
export const DEFAULT_MIN_HEALTH_FACTOR = 1.1;

export interface SaveKnownReserve {
  mint: string;
  symbol: string;
  decimals: number;
  market: PublicKey;
}

export const SAVE_KNOWN_RESERVES: SaveKnownReserve[] = [
  {
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    decimals: 9,
    market: SAVE_MAIN_MARKET,
  },
  {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    market: SAVE_MAIN_MARKET,
  },
  {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
    decimals: 6,
    market: SAVE_MAIN_MARKET,
  },
];

export function findKnownReserveByMint(mint: string): SaveKnownReserve | undefined {
  const normalized = mint.trim();
  return SAVE_KNOWN_RESERVES.find((reserve) => reserve.mint === normalized);
}

export function findKnownReserveBySymbol(symbol: string): SaveKnownReserve | undefined {
  const normalized = symbol.trim().toUpperCase();
  return SAVE_KNOWN_RESERVES.find((reserve) => reserve.symbol.toUpperCase() === normalized);
}

export function resolveKnownReserve(token: string): SaveKnownReserve | undefined {
  return findKnownReserveBySymbol(token) ?? findKnownReserveByMint(token);
}
