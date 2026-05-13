import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const RAYDIUM_ADAPTER_ID = 'raydium' as const;
export const RAYDIUM_NAME = 'Raydium';
export const RAYDIUM_WEBSITE = 'https://raydium.io';
export const RAYDIUM_DESCRIPTION =
  'Read Raydium CPMM, AMM, CLMM, and farm facts, then prepare liquidity, fee-collection, and farm actions for wallet approval.';

export const RAYDIUM_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

export const RAYDIUM_AMM_V4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
export const RAYDIUM_FARM_PROGRAM_ID_V3 = new PublicKey('EhhTKczWMGQt46ynNeRX1WfeagwwJd7ufHvCDjRxjo5Q');
export const RAYDIUM_FARM_PROGRAM_ID_V4 = new PublicKey('CBuCnLe26faBpcBP2fktp4rp8abpcAnTWft6ZrP5Q4T');
export const RAYDIUM_FARM_PROGRAM_ID_V5 = new PublicKey('9KEPoZmtHUrBbhWN1v1KWLMkkvwY6WLtAVUCPRtRjP4z');
export const RAYDIUM_FARM_PROGRAM_ID_V6 = new PublicKey('FarmqiPv5eAj3j1GMdMCMUGXqPUvmquZtMy86QH6rzhG');

export const RAYDIUM_PROGRAM_IDS = {
  ammV4: RAYDIUM_AMM_V4_PROGRAM_ID.toBase58(),
  cpmm: RAYDIUM_CPMM_PROGRAM_ID.toBase58(),
  clmm: RAYDIUM_CLMM_PROGRAM_ID.toBase58(),
  farmV3: RAYDIUM_FARM_PROGRAM_ID_V3.toBase58(),
  farmV4: RAYDIUM_FARM_PROGRAM_ID_V4.toBase58(),
  farmV5: RAYDIUM_FARM_PROGRAM_ID_V5.toBase58(),
  farmV6: RAYDIUM_FARM_PROGRAM_ID_V6.toBase58(),
} as const;

export const RAYDIUM_POOL_PROGRAM_IDS = [
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  RAYDIUM_FARM_PROGRAM_ID_V3,
  RAYDIUM_FARM_PROGRAM_ID_V4,
  RAYDIUM_FARM_PROGRAM_ID_V5,
  RAYDIUM_FARM_PROGRAM_ID_V6,
];

export function shortAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
