import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const ORCA_ADAPTER_ID = 'orca' as const;
export const ORCA_NAME = 'Orca';
export const ORCA_WEBSITE = 'https://www.orca.so';
export const ORCA_DESCRIPTION =
  'Read Orca Whirlpool pool and position facts, then prepare liquidity and harvest actions for wallet approval.';

export const ORCA_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

export const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
export const ORCA_WHIRLPOOLS_CONFIG = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ');
export const ORCA_WHIRLPOOLS_CONFIG_EXTENSION = new PublicKey('777H5H3Tp9U11uRVRzFwM8BinfiakbaLT8vQpeuhvEiH');

export const ORCA_PROGRAM_IDS = {
  whirlpool: WHIRLPOOL_PROGRAM_ID.toBase58(),
  whirlpoolsConfig: ORCA_WHIRLPOOLS_CONFIG.toBase58(),
  whirlpoolsConfigExtension: ORCA_WHIRLPOOLS_CONFIG_EXTENSION.toBase58(),
} as const;

export function shortAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
