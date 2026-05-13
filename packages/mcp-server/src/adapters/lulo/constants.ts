import { PublicKey, type Connection } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

import { AdapterError } from '../types.js';

export const LULO_ADAPTER_ID = 'lulo' as const;
export const LULO_NAME = 'Lulo';
export const LULO_WEBSITE = 'https://app.lulo.fi';
export const LULO_DESCRIPTION =
  'Read Lulo Protected and Boost rates and balances, then prepare lending deposit/withdraw actions for wallet approval. Transaction building is delegated to the Lulo API; the wallet signs.';

export const LULO_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

// Lulo program ids are surfaced per-action by the Lulo API response and stored
// in prepared-action params. The adapter does not build instructions locally,
// so the static programIds list is intentionally empty.
export const LULO_PROGRAM_IDS: PublicKey[] = [];

export const LULO_DEFAULT_API_BASE_URL = 'https://api.lulo.fi';
export const LULO_API_KEY_ENV = 'LULO_API_KEY';
export const LULO_API_BASE_URL_ENV = 'LULO_API_BASE_URL';

export const LULO_DEPOSIT_TYPES = ['protected', 'boost', 'regular'] as const;
export type LuloDepositType = (typeof LULO_DEPOSIT_TYPES)[number];

export const LULO_WITHDRAW_TYPES = ['protected', 'regular'] as const;
export type LuloWithdrawType = (typeof LULO_WITHDRAW_TYPES)[number];

export const LULO_RESPONSE_BYTE_LIMIT = 262_144;

export function depositTypeLabel(type: LuloDepositType): string {
  switch (type) {
    case 'protected':
      return 'Protected';
    case 'boost':
      return 'Boost';
    case 'regular':
      return 'Regular';
  }
}

export function withdrawTypeLabel(type: LuloWithdrawType): string {
  return type === 'protected' ? 'Protected' : 'Regular';
}

export function shortMint(mint: string): string {
  const trimmed = mint.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export async function resolveLuloDecimals(
  connection: Connection,
  mintAddress: string,
  hint?: number,
): Promise<number> {
  if (typeof hint === 'number' && Number.isFinite(hint) && hint >= 0 && hint <= 18) {
    return hint;
  }
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mintAddress);
  } catch {
    throw new AdapterError(LULO_ADAPTER_ID, 'invalid_mint', `Lulo mint "${mintAddress}" is not a valid base58 public key.`);
  }
  try {
    const info = await connection.getParsedAccountInfo(mintKey, 'confirmed');
    const data = info.value?.data;
    if (data && typeof data === 'object' && 'parsed' in data) {
      const parsed = (data as { parsed?: { info?: { decimals?: number } } }).parsed;
      const decimals = parsed?.info?.decimals;
      if (typeof decimals === 'number' && Number.isFinite(decimals)) {
        return decimals;
      }
    }
  } catch {
    // Fall through to the structured error below.
  }
  throw new AdapterError(
    LULO_ADAPTER_ID,
    'unknown_mint_decimals',
    `Could not resolve decimals for Lulo mint ${mintAddress}. Confirm the mint exists on the configured cluster.`,
  );
}
