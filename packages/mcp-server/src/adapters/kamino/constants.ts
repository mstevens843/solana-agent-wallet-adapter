import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const KAMINO_ADAPTER_ID = 'kamino' as const;
export const KAMINO_NAME = 'Kamino Finance';
export const KAMINO_WEBSITE = 'https://app.kamino.finance';
export const KAMINO_DESCRIPTION =
  'Supply SOL or SPL tokens to a Kamino Lend reserve to earn supply APY. Plain-English presign review with pool health and withdrawal expectations.';

export const KAMINO_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

// klend (Kamino Lend) program — mainnet.
export const KLEND_PROGRAM_ID = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

// Kamino Main Market on mainnet — the canonical multi-asset market.
export const KAMINO_MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

export interface KaminoKnownReserve {
  mint: string;
  symbol: string;
  decimals: number;
  market: PublicKey;
}

// Curated list of reserves we surface by default. Each entry is the underlying
// token mint, the user-facing symbol, and which Kamino market owns the reserve.
// Additional reserves can be addressed via raw mint address.
export const KAMINO_KNOWN_RESERVES: KaminoKnownReserve[] = [
  {
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    decimals: 9,
    market: KAMINO_MAIN_MARKET,
  },
  {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    market: KAMINO_MAIN_MARKET,
  },
  {
    mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    symbol: 'JitoSOL',
    decimals: 9,
    market: KAMINO_MAIN_MARKET,
  },
  {
    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    symbol: 'mSOL',
    decimals: 9,
    market: KAMINO_MAIN_MARKET,
  },
  {
    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
    symbol: 'bSOL',
    decimals: 9,
    market: KAMINO_MAIN_MARKET,
  },
];

export function findKnownReserveByMint(mint: string): KaminoKnownReserve | undefined {
  const normalized = mint.trim();
  return KAMINO_KNOWN_RESERVES.find((reserve) => reserve.mint === normalized);
}

export function findKnownReserveBySymbol(symbol: string): KaminoKnownReserve | undefined {
  const normalized = symbol.trim().toUpperCase();
  return KAMINO_KNOWN_RESERVES.find((reserve) => reserve.symbol.toUpperCase() === normalized);
}

export function resolveKnownReserve(token: string): KaminoKnownReserve | undefined {
  return findKnownReserveBySymbol(token) ?? findKnownReserveByMint(token);
}

export const EARNINGS_PROOF_SCHEMA = 'kamino-earnings-v1' as const;
