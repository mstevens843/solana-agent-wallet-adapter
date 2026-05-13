import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const JITO_ADAPTER_ID = 'jito' as const;
export const JITO_NAME = 'Jito';
export const JITO_WEBSITE = 'https://www.jito.network';
export const JITO_DESCRIPTION =
  'Read JitoSOL liquid staking facts and prepare stake, unstake, existing-stake deposit, and deactivated stake-account withdrawal actions for wallet approval.';

export const JITO_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

export const JITOSOL_MINT = new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn');
export const JITO_STAKE_POOL_ADDRESS = new PublicKey('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb');
export const SPL_STAKE_POOL_PROGRAM_ID = new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy');
export const JITO_STAKE_DEPOSIT_INTERCEPTOR_PROGRAM_ID = new PublicKey('5TAiuAh3YGDbwjEruC1ZpXTJWdNDS7Ur7VeqNNiHMmGV');

export const JITOSOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL_BIGINT = 1_000_000_000n;
export const U64_MAX_EPOCH = '18446744073709551615';
export const JITO_MIN_STAKE_SOL_LAMPORTS = 1_000_000n;

export const JITO_OFFCHAIN_MIN_OUTPUT_WARNING =
  'Min-output protection is enforced immediately before the wallet prompt as an execution-time off-chain guard; the high-level SDK helper used here does not encode this threshold on chain.';

export function shortAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
