import { PublicKey } from '@solana/web3.js';
import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const METEORA_ADAPTER_ID = 'meteora' as const;
export const METEORA_NAME = 'Meteora';
export const METEORA_WEBSITE = 'https://app.meteora.ag';
export const METEORA_DESCRIPTION =
  'Meteora DLMM pool and position reads plus prepare-only DLMM liquidity and claim actions.';
export const METEORA_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];
export const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
export const METEORA_PROGRAM_IDS = [METEORA_DLMM_PROGRAM_ID.toBase58()];

export type MeteoraStrategyType = 'spot' | 'curve' | 'bidask';

export function shortAddress(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function normalizeMeteoraStrategyType(value: string | undefined): MeteoraStrategyType {
  const normalized = (value ?? 'spot').trim().toLowerCase();
  if (normalized === 'curve') return 'curve';
  if (normalized === 'bidask' || normalized === 'bid_ask' || normalized === 'bid-ask') return 'bidask';
  return 'spot';
}
