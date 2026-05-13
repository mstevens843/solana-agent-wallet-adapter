import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const TENSOR_ADAPTER_ID = 'tensor' as const;
export const TENSOR_NAME = 'Tensor';
export const TENSOR_WEBSITE = 'https://www.tensor.trade';
export const TENSOR_DESCRIPTION =
  'Read Tensor NFT marketplace facts and prepare buy, list, bid, cancel, and capped sweep actions for wallet approval.';

export const TENSOR_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

export const TENSOR_MARKETPLACE_PROGRAM_ID = new PublicKey('TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp');
export const TENSOR_AMM_PROGRAM_ID = new PublicKey('TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg');
export const TENSOR_ESCROW_PROGRAM_ID = new PublicKey('TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN');
export const TENSOR_WHITELIST_PROGRAM_ID = new PublicKey('TL1ST2iRBzuGTqLn1KXnGdSnEow62BzPnGiqyRXhWtW');
export const TENSOR_FEES_PROGRAM_ID = new PublicKey('TFEEgwDP6nn1s8mMX2tTNPPz8j2VomkphLUmyxKm17A');

export const TENSOR_PROGRAM_IDS = {
  marketplace: TENSOR_MARKETPLACE_PROGRAM_ID.toBase58(),
  amm: TENSOR_AMM_PROGRAM_ID.toBase58(),
  escrow: TENSOR_ESCROW_PROGRAM_ID.toBase58(),
  whitelist: TENSOR_WHITELIST_PROGRAM_ID.toBase58(),
  fees: TENSOR_FEES_PROGRAM_ID.toBase58(),
} as const;

export const MAX_SWEEP_ITEMS = 10;
export const MAX_LISTINGS = 50;
export const MAX_BIDS = 50;
export const MAX_QUOTE_AGE_MS = 5 * 60 * 1000;

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export function shortAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function solFromLamports(lamports: bigint | string | number): string {
  let value: bigint;
  if (typeof lamports === 'bigint') value = lamports;
  else if (typeof lamports === 'number') value = BigInt(Math.trunc(lamports));
  else value = BigInt(lamports);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / LAMPORTS_PER_SOL;
  const fraction = abs % LAMPORTS_PER_SOL;
  let result: string;
  if (fraction === 0n) {
    result = whole.toString();
  } else {
    const fractionStr = fraction.toString().padStart(9, '0').replace(/0+$/, '');
    result = `${whole}.${fractionStr}`;
  }
  return negative ? `-${result}` : result;
}
