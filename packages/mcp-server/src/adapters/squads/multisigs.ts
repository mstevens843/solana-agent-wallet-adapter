import { PublicKey, type Connection } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import type { PreparedAction } from '../../preparedActions.js';
import { AdapterError } from '../types.js';

import {
  getSquadsMultisigClient,
  type SquadsMemberSnapshot,
  type SquadsMultisigSnapshot,
  type SquadsWalletAuthority,
} from './client.js';
import { SQUADS_ADAPTER_ID } from './constants.js';

export interface ResolvedMemberPermissions {
  member?: SquadsMemberSnapshot;
  canInitiate: boolean;
  canVote: boolean;
  canExecute: boolean;
}

export async function getMultisigSnapshot(
  connection: Connection,
  multisigAddress: string,
  opts: { includeMembers?: boolean; includeVaults?: boolean; includeProposals?: boolean } = {},
): Promise<SquadsMultisigSnapshot> {
  const normalized = requireMultisigAddress(multisigAddress);
  return getSquadsMultisigClient().getMultisigSnapshot(connection, normalized, opts);
}

export async function getWalletAuthority(
  connection: Connection,
  walletAddress: string,
  opts: { includeProposals?: boolean } = {},
): Promise<SquadsWalletAuthority> {
  if (!walletAddress || !walletAddress.trim()) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'invalid_request',
      'walletAddress is required to read Squads wallet authority.',
    );
  }
  return getSquadsMultisigClient().getWalletAuthority(connection, walletAddress.trim(), opts);
}

export function resolveMemberPermissions(
  snapshot: SquadsMultisigSnapshot,
  walletAddress: string,
): ResolvedMemberPermissions {
  const member = snapshot.members.find((entry) => entry.publicKey === walletAddress);
  if (!member) {
    return { canInitiate: false, canVote: false, canExecute: false };
  }
  return {
    member,
    canInitiate: member.canInitiate,
    canVote: member.canVote,
    canExecute: member.canExecute,
  };
}

export interface MultisigMemberSummary {
  memberCount: number;
  threshold: number;
  timeLockSec: number;
  vaultCount: number;
  walletRole: 'none' | 'proposer' | 'voter' | 'executor' | 'voter_executor' | 'all';
}

export function summarizeMultisig(
  snapshot: SquadsMultisigSnapshot,
  walletAddress?: string,
): MultisigMemberSummary {
  const permissions = walletAddress
    ? resolveMemberPermissions(snapshot, walletAddress)
    : ({ canInitiate: false, canVote: false, canExecute: false } as ResolvedMemberPermissions);
  return {
    memberCount: snapshot.members.length,
    threshold: snapshot.threshold,
    timeLockSec: snapshot.timeLockSec,
    vaultCount: snapshot.vaultCount,
    walletRole: roleFromPermissions(permissions),
  };
}

export function roleFromPermissions(
  permissions: Pick<ResolvedMemberPermissions, 'canInitiate' | 'canVote' | 'canExecute'>,
): 'none' | 'proposer' | 'voter' | 'executor' | 'voter_executor' | 'all' {
  if (permissions.canInitiate && permissions.canVote && permissions.canExecute) return 'all';
  if (permissions.canVote && permissions.canExecute) return 'voter_executor';
  if (permissions.canInitiate) return 'proposer';
  if (permissions.canVote) return 'voter';
  if (permissions.canExecute) return 'executor';
  return 'none';
}

export function requireMultisigAddress(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'invalid_request',
      'multisigAddress is required for Squads actions.',
    );
  }
  try {
    // eslint-disable-next-line no-new
    new PublicKey(normalized);
  } catch {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'invalid_multisig',
      `multisigAddress ${normalized} is not a valid base58 public key.`,
    );
  }
  return normalized;
}

export function requirePublicKey(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new AdapterError(SQUADS_ADAPTER_ID, 'invalid_request', `${label} is required.`);
  }
  try {
    // eslint-disable-next-line no-new
    new PublicKey(normalized);
  } catch {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'invalid_pubkey',
      `${label} ${normalized} is not a valid base58 public key.`,
    );
  }
  return normalized;
}

export function requireString(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError(
      'invalid_request',
      `Squads action ${action.id} is missing ${key}.`,
    );
  }
  return value;
}

export function requireNumber(action: PreparedAction, key: string): number {
  const value = action.params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(
      'invalid_request',
      `Squads action ${action.id} is missing numeric ${key}.`,
    );
  }
  return value;
}

export function optionalString(action: PreparedAction, key: string): string | undefined {
  const value = action.params[key];
  return typeof value === 'string' && value ? value : undefined;
}

export function short(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
