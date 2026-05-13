import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const REALMS_ADAPTER_ID = 'realms' as const;
export const REALMS_NAME = 'Realms';
export const REALMS_WEBSITE = 'https://app.realms.today';
export const REALMS_DESCRIPTION =
  'Read SPL Governance realms, proposals, vote records, and wallet voting power, and prepare cast vote, relinquish vote, and deposit/withdraw governance token approvals with plain-English presign review. V1 does not construct treasury, program-upgrade, or governance-config proposals and does not auto-vote.';

export const REALMS_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

// Canonical mainnet SPL Governance program id (the one Realms.today drives).
// Other governance program instances exist on mainnet; v1 targets this one only.
export const SPL_GOVERNANCE_PROGRAM_ID = new PublicKey(
  'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw',
);

// Voter Stake Registry (VSR) — the most common voting power plugin. Its presence
// makes the raw TOR `governingTokenDepositAmount` non-authoritative for voting power.
export const VSR_PROGRAM_ID = new PublicKey('vsr2nfGVNHmSY8uxoBGqq8AQbwz3JwaEaHqGVsjCdYC');

export type ProposalStateName =
  | 'draft'
  | 'signing_off'
  | 'voting'
  | 'succeeded'
  | 'executing'
  | 'completed'
  | 'cancelled'
  | 'defeated'
  | 'executing_with_errors'
  | 'vetoed';

export type ProposalListStateFilter = ProposalStateName | 'all';

export type VoteKind = 'approve' | 'deny' | 'abstain' | 'veto';

export type ProposalVoteType = 'single_choice' | 'multi_choice';
