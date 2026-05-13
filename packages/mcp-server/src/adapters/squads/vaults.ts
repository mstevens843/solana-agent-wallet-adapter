import type { Connection } from '@solana/web3.js';

import { AdapterError } from '../types.js';

import {
  getSquadsMultisigClient,
  type SquadsVaultSnapshot,
} from './client.js';
import { SQUADS_ADAPTER_ID, SQUADS_APPROVAL_LIMITS } from './constants.js';
import { requireMultisigAddress, requirePublicKey } from './multisigs.js';

export interface VaultDescriptor {
  vaultIndex?: number;
  vaultAddress?: string;
}

export function requireVaultDescriptor(input: VaultDescriptor): VaultDescriptor {
  const hasIndex = input.vaultIndex !== undefined && Number.isFinite(input.vaultIndex);
  const hasAddress = typeof input.vaultAddress === 'string' && input.vaultAddress.trim().length > 0;
  if (!hasIndex && !hasAddress) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'invalid_request',
      'Provide vaultIndex or vaultAddress for the Squads vault.',
    );
  }
  if (hasIndex) {
    const normalized = Number(input.vaultIndex);
    if (!Number.isInteger(normalized) || normalized < 0 || normalized > SQUADS_APPROVAL_LIMITS.vaultIndexScanCap) {
      throw new AdapterError(
        SQUADS_ADAPTER_ID,
        'invalid_vault',
        `vaultIndex must be an integer between 0 and ${SQUADS_APPROVAL_LIMITS.vaultIndexScanCap}.`,
      );
    }
  }
  return {
    ...(hasIndex && { vaultIndex: Number(input.vaultIndex) }),
    ...(hasAddress && { vaultAddress: requirePublicKey(input.vaultAddress, 'vaultAddress') }),
  };
}

export async function getVaultSnapshot(
  connection: Connection,
  multisigAddress: string,
  opts: VaultDescriptor & { includeBalances?: boolean },
): Promise<SquadsVaultSnapshot> {
  const normalizedMultisig = requireMultisigAddress(multisigAddress);
  const descriptor = requireVaultDescriptor(opts);
  return getSquadsMultisigClient().getVaultSnapshot(connection, normalizedMultisig, {
    ...descriptor,
    ...(opts.includeBalances !== undefined && { includeBalances: opts.includeBalances }),
  });
}

export function assertSufficientVaultBalance(
  snapshot: SquadsVaultSnapshot,
  mintAddress: string | null,
  amountRaw: bigint,
): void {
  if (mintAddress === null) {
    const lamports = safeBigInt(snapshot.lamports);
    if (lamports < amountRaw) {
      throw new AdapterError(
        SQUADS_ADAPTER_ID,
        'insufficient_vault_balance',
        `Squads vault ${snapshot.vaultAddress} holds ${snapshot.solUi} SOL; cannot transfer ${formatRaw(amountRaw, 9)} SOL.`,
      );
    }
    return;
  }
  const tokenAccount = snapshot.tokenAccounts.find((entry) => entry.mint === mintAddress);
  if (!tokenAccount) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'missing_token_account',
      `Squads vault ${snapshot.vaultAddress} has no token account for mint ${mintAddress}.`,
    );
  }
  const balance = safeBigInt(tokenAccount.amountRaw);
  if (balance < amountRaw) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'insufficient_vault_balance',
      `Squads vault token account holds ${tokenAccount.amountUi} ${tokenAccount.symbol ?? mintAddress}; cannot transfer ${formatRaw(amountRaw, tokenAccount.decimals)}.`,
    );
  }
}

export function assertVaultMintDecimals(
  snapshot: SquadsVaultSnapshot,
  mintAddress: string,
  expectedDecimals: number,
): void {
  const tokenAccount = snapshot.tokenAccounts.find((entry) => entry.mint === mintAddress);
  if (!tokenAccount) return;
  if (tokenAccount.decimals !== expectedDecimals) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'mint_decimals_mismatch',
      `Squads vault expected ${expectedDecimals} decimals for mint ${mintAddress}, but token account reports ${tokenAccount.decimals}.`,
    );
  }
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function formatRaw(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const padded = amount.toString().padStart(decimals + 1, '0');
  const integer = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}
