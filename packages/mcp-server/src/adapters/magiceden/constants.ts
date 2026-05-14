import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';
import { parsePositiveSolDecimal, solFromLamports as formatSolFromLamports } from '../solDecimal.js';

export const MAGICEDEN_ADAPTER_ID = 'magiceden' as const;
export const MAGICEDEN_NAME = 'Magic Eden';
export const MAGICEDEN_WEBSITE = 'https://magiceden.io';
export const MAGICEDEN_DESCRIPTION =
  'Read Magic Eden Solana NFT collections, listings, bids, activity, and wallet NFTs, then prepare marketplace buy, list, cancel, and bid actions for wallet approval. Transaction building is delegated to the Magic Eden API; the wallet signs.';

export const MAGICEDEN_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

export const MAGICEDEN_API_KEY_ENV = 'MAGICEDEN_API_KEY';
export const MAGICEDEN_API_BASE_URL_ENV = 'MAGICEDEN_API_BASE_URL';
export const MAGICEDEN_FEATURE_FLAG_ENV = 'MAGICEDEN_CONNECTOR_ENABLED';
export const MAGICEDEN_DEFAULT_API_BASE_URL = 'https://api-mainnet.magiceden.dev/v2';

export const MAGICEDEN_RESPONSE_BYTE_LIMIT = 262_144;

export const MAGICEDEN_MARKETPLACE_PROGRAM_ID = new PublicKey(
  'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K',
);

export const MAGICEDEN_PROGRAM_IDS = [MAGICEDEN_MARKETPLACE_PROGRAM_ID];

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const MAGICEDEN_API_TRANSITION_WARNING =
  'Magic Eden announced API infrastructure changes (help.magiceden.io 2026-02-27). The Solana API remains operational for now, but endpoint support may change without notice.';

export function shortMint(mint: string): string {
  const trimmed = mint.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function lamportsFromSol(value: string, label: string): bigint {
  return parsePositiveSolDecimal(value, label).lamports;
}

export function normalizeSolDecimal(value: string, label: string): string {
  return parsePositiveSolDecimal(value, label).sol;
}

export function solFromLamports(lamports: bigint | number | string): string {
  return formatSolFromLamports(lamports);
}
