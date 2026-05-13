import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const SQUADS_ADAPTER_ID = 'squads' as const;
export const SQUADS_NAME = 'Squads Multisig';
export const SQUADS_WEBSITE = 'https://squads.so';
export const SQUADS_DESCRIPTION =
  'Read Squads multisigs, members, thresholds, vaults, and proposals; prepare transfer-only vault proposals and approve, reject, cancel, or execute existing proposals with plain-English presign review. V1 does not expose member/threshold admin changes, program upgrades, treasury swaps, or automated proposal execution.';

export const SQUADS_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

// Squads Multisig v4 program on mainnet.
// Reference: https://docs.squads.so/main/development/typescript/accounts/multisig
// The production factory (see client.ts) MUST validate this against multisig.PROGRAM_ID
// from @sqds/multisig at boot and refuse to wire if mismatched. Tests use a mocked client
// factory and never hit this address on-chain.
export const SQUADS_PROGRAM_ID = new PublicKey('SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu');

export const SQUADS_APPROVAL_LIMITS = {
  /** Maximum inner instructions in a single create-transfer-proposal in V1. V1 always builds exactly one transfer. */
  maxTransferInstructions: 1,
  /** Largest proposal-list page the read tool returns. */
  proposalListMax: 100,
  /** Default proposal-list page when the caller does not specify a limit. */
  proposalListDefault: 20,
  /** Cluster-wide cap on the number of vault indices scanned when back-resolving a vaultAddress to an index. */
  vaultIndexScanCap: 256,
} as const;

export type SquadsProposalStatus =
  | 'draft'
  | 'active'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'cancelled'
  | 'expired';

export type SquadsVoteOperation = 'approve' | 'reject' | 'cancel';

export type SquadsMemberPermissionFlag = 'initiate' | 'vote' | 'execute';

export type SquadsInstructionKind =
  | 'sol_transfer'
  | 'sol_transfer_with_seed'
  | 'system_create_account'
  | 'system_assign'
  | 'spl_transfer'
  | 'spl_transfer_checked'
  | 'spl_close_account'
  | 'spl_sync_native'
  | 'spl_approve'
  | 'spl_revoke'
  | 'spl_burn'
  | 'memo'
  | 'compute_budget_set_limit'
  | 'compute_budget_set_price'
  | 'squads_config_transaction_create'
  | 'squads_vault_transaction_create'
  | 'squads_proposal_create'
  | 'squads_proposal_approve'
  | 'squads_proposal_reject'
  | 'squads_proposal_cancel'
  | 'squads_vault_transaction_execute'
  | 'squads_config_transaction_execute'
  | 'squads_add_member'
  | 'squads_remove_member'
  | 'squads_change_threshold'
  | 'squads_set_time_lock'
  | 'squads_set_config_authority'
  | 'unknown';

export type SquadsInstructionRiskTier = 'transfer' | 'governance' | 'admin' | 'compute' | 'unknown';
