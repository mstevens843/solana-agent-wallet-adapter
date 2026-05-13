import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const SANCTUM_ADAPTER_ID = 'sanctum' as const;
export const SANCTUM_NAME = 'Sanctum';
export const SANCTUM_WEBSITE = 'https://app.sanctum.so';
export const SANCTUM_DESCRIPTION =
  'Read Sanctum LST and Infinity facts, then prepare LST swap, Infinity add/remove liquidity, and SOL/LST stake or unstake actions for wallet approval.';

export const SANCTUM_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

export const SANCTUM_API_KEY_ENV = 'SANCTUM_API_KEY';
export const SANCTUM_API_BASE_URL_ENV = 'SANCTUM_API_BASE_URL';
export const SANCTUM_FEATURE_FLAG_ENV = 'SANCTUM_CONNECTOR_ENABLED';
export const SANCTUM_DEFAULT_API_BASE_URL = 'https://sanctum-api.ironforge.network';
export const SANCTUM_RESPONSE_BYTE_LIMIT = 512_000;

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SANCTUM_INF_MINT = '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm';

export const SANCTUM_DEFAULT_SLIPPAGE_BPS = 30;
export const SANCTUM_DEFAULT_MAX_FEE_BPS = 100;
export const SANCTUM_STALE_QUOTE_MS = 60_000;

export type SanctumSwapSource = 'Inf' | 'SanctumRouter';

export const SANCTUM_INFINITY_SWAP_SOURCES: SanctumSwapSource[] = ['Inf'];
export const SANCTUM_ROUTER_SWAP_SOURCES: SanctumSwapSource[] = ['Inf', 'SanctumRouter'];

export const SANCTUM_S_CONTROLLER_PROGRAM_ID = new PublicKey(
  '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx',
);
export const SANCTUM_FLAT_SLAB_PROGRAM_ID = new PublicKey(
  's1b6NRXj6ygNu1QMKXh2H9LUR2aPApAAm1UQ2DjdhNV',
);
export const SANCTUM_SPL_SOL_VALUE_CALCULATOR_PROGRAM_ID = new PublicKey(
  'sp1V4h2gWorkGhVcazBc22Hfo2f5sd7jcjT4EDPrWFF',
);
export const SANCTUM_SPL_STAKE_POOL_PROGRAM_ID = new PublicKey(
  'SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY',
);
export const SANCTUM_SPL_MULTI_STAKE_POOL_PROGRAM_ID = new PublicKey(
  'SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn',
);

export const SANCTUM_PROGRAM_IDS = [
  SANCTUM_S_CONTROLLER_PROGRAM_ID,
  SANCTUM_FLAT_SLAB_PROGRAM_ID,
  SANCTUM_SPL_SOL_VALUE_CALCULATOR_PROGRAM_ID,
  SANCTUM_SPL_STAKE_POOL_PROGRAM_ID,
  SANCTUM_SPL_MULTI_STAKE_POOL_PROGRAM_ID,
];

export function shortAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
