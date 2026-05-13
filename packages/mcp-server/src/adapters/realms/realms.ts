import { PublicKey, type Connection } from '@solana/web3.js';

import { AdapterError } from '../types.js';

import {
  getRealmsClient,
  type GovernanceSnapshot,
  type GovernanceSnapshotOptions,
  type RealmSnapshot,
  type RealmSnapshotOptions,
  type WalletGovernanceOptions,
  type WalletGovernanceSnapshot,
} from './client.js';
import { REALMS_ADAPTER_ID } from './constants.js';

export function requireAddress(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'invalid_request',
      `${field} is required.`,
    );
  }
  try {
    new PublicKey(normalized);
  } catch {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'invalid_address',
      `${field} ${normalized} is not a valid base58 public key.`,
    );
  }
  return normalized;
}

export async function getRealmSnapshot(
  connection: Connection,
  realmAddress: string,
  options: RealmSnapshotOptions = {},
): Promise<RealmSnapshot> {
  const normalized = requireAddress(realmAddress, 'realmAddress');
  return getRealmsClient().getRealmSnapshot(connection, normalized, options);
}

export async function getGovernanceSnapshot(
  connection: Connection,
  governanceAddress: string,
  options: GovernanceSnapshotOptions = {},
): Promise<GovernanceSnapshot> {
  const normalized = requireAddress(governanceAddress, 'governanceAddress');
  return getRealmsClient().getGovernanceSnapshot(connection, normalized, options);
}

export async function getWalletGovernance(
  connection: Connection,
  walletAddress: string,
  options: WalletGovernanceOptions = {},
): Promise<WalletGovernanceSnapshot[]> {
  const normalized = requireAddress(walletAddress, 'walletAddress');
  return getRealmsClient().getWalletGovernance(connection, normalized, options);
}

export interface WalletGovernanceSummary {
  realmCount: number;
  totalDepositedRaw: string;
  outstandingProposalCount: number;
  unrelinquishedVotesCount: number;
  pluginAffectedRealmCount: number;
  lockedRealmCount: number;
}

export function summarizeWalletGovernance(
  snapshots: WalletGovernanceSnapshot[],
): WalletGovernanceSummary {
  let outstanding = 0;
  let unrelinquished = 0;
  let pluginAffected = 0;
  let locked = 0;
  let totalDeposited = 0n;
  const seenRealms = new Set<string>();

  for (const entry of snapshots) {
    seenRealms.add(entry.realmAddress);
    outstanding += entry.tokenOwnerRecord.outstandingProposalCount;
    unrelinquished += entry.tokenOwnerRecord.unrelinquishedVotesCount;
    if (entry.pluginsDetected) pluginAffected += 1;
    if (
      entry.tokenOwnerRecord.outstandingProposalCount > 0 ||
      entry.tokenOwnerRecord.unrelinquishedVotesCount > 0 ||
      Boolean(entry.tokenOwnerRecord.governanceDelegate)
    ) {
      locked += 1;
    }
    try {
      totalDeposited += BigInt(entry.tokenOwnerRecord.governingTokenDepositAmount || '0');
    } catch {
      // ignore non-numeric balances
    }
  }

  return {
    realmCount: seenRealms.size,
    totalDepositedRaw: totalDeposited.toString(),
    outstandingProposalCount: outstanding,
    unrelinquishedVotesCount: unrelinquished,
    pluginAffectedRealmCount: pluginAffected,
    lockedRealmCount: locked,
  };
}
