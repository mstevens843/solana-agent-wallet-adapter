import type { AdapterRead, DAppAdapter } from '../types.js';

import {
  getRealmsClient,
  type GovernanceSnapshot,
  type ProposalListEntry,
  type ProposalSnapshot,
  type RealmSnapshot,
  type VoteRecordSnapshot,
  type WalletGovernanceSnapshot,
} from './client.js';
import {
  REALMS_ADAPTER_ID,
  REALMS_DESCRIPTION,
  REALMS_NAME,
  REALMS_SUPPORTED_CLUSTERS,
  REALMS_WEBSITE,
  SPL_GOVERNANCE_PROGRAM_ID,
  type ProposalListStateFilter,
} from './constants.js';
import {
  realmsCastVoteAction,
  realmsDepositGovernanceTokensAction,
  realmsRelinquishVoteAction,
  realmsWithdrawGovernanceTokensAction,
  type RealmsCastVoteInput,
  type RealmsDepositGovernanceTokensInput,
  type RealmsRelinquishVoteInput,
  type RealmsWithdrawGovernanceTokensInput,
} from './actions.js';
import { getProposalList, getProposalSnapshot } from './proposals.js';
import { getGovernanceSnapshot, getRealmSnapshot, getWalletGovernance, summarizeWalletGovernance } from './realms.js';
import { getVoteRecord } from './votes.js';

interface WalletGovernanceReadInput {
  walletAddress?: string;
  realmAddress?: string;
  includeInactive?: boolean;
}

interface RealmReadInput {
  realmAddress: string;
  includeGovernances?: boolean;
  includeTokenMints?: boolean;
}

interface GovernanceReadInput {
  governanceAddress: string;
  includeConfig?: boolean;
  includeProposals?: boolean;
}

interface ProposalListReadInput {
  realmAddress: string;
  governanceAddress?: string;
  state?: ProposalListStateFilter;
  limit?: number;
}

interface ProposalSnapshotReadInput {
  proposalAddress: string;
  includeInstructions?: boolean;
  includeVoteBreakdown?: boolean;
}

interface VoteRecordReadInput {
  proposalAddress: string;
  walletAddress?: string;
}

const walletGovernanceRead: AdapterRead<WalletGovernanceReadInput, unknown> = {
  id: 'wallet_governance',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const snapshots = await getWalletGovernance(ctx.connection, walletAddress, {
      ...(input.realmAddress !== undefined && { realmAddress: input.realmAddress }),
      ...(input.includeInactive !== undefined && { includeInactive: input.includeInactive }),
    });
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      snapshots,
      facts: summarizeWalletGovernance(snapshots),
    };
  },
};

const realmSnapshotRead: AdapterRead<RealmReadInput, unknown> = {
  id: 'realm_snapshot',
  async read(input, ctx) {
    const snapshot: RealmSnapshot = await getRealmSnapshot(ctx.connection, input.realmAddress, {
      ...(input.includeGovernances !== undefined && { includeGovernances: input.includeGovernances }),
      ...(input.includeTokenMints !== undefined && { includeTokenMints: input.includeTokenMints }),
    });
    return {
      cluster: ctx.config.cluster,
      snapshot,
      facts: {
        realmAddress: snapshot.realmAddress,
        name: snapshot.name,
        communityMint: snapshot.communityMint,
        councilMint: snapshot.councilMint ?? null,
        governanceCount: snapshot.governances.length,
        pluginsDetected: snapshot.pluginsDetected,
        pluginNames: snapshot.pluginNames,
      },
    };
  },
};

const governanceSnapshotRead: AdapterRead<GovernanceReadInput, unknown> = {
  id: 'governance_snapshot',
  async read(input, ctx) {
    const snapshot: GovernanceSnapshot = await getGovernanceSnapshot(ctx.connection, input.governanceAddress, {
      ...(input.includeConfig !== undefined && { includeConfig: input.includeConfig }),
      ...(input.includeProposals !== undefined && { includeProposals: input.includeProposals }),
    });
    return {
      cluster: ctx.config.cluster,
      snapshot,
      facts: {
        governanceAddress: snapshot.governanceAddress,
        realmAddress: snapshot.realmAddress,
        governedAccount: snapshot.governedAccount,
        voteThresholdType: snapshot.voteThresholdType,
        voteThresholdPct: snapshot.voteThresholdPct ?? null,
        votingBaseSec: snapshot.votingBaseSec,
        votingCoolOffSec: snapshot.votingCoolOffSec,
        proposalCount: snapshot.proposals.length,
      },
    };
  },
};

const proposalListRead: AdapterRead<ProposalListReadInput, unknown> = {
  id: 'proposal_list',
  async read(input, ctx) {
    const proposals: ProposalListEntry[] = await getProposalList(ctx.connection, {
      realmAddress: input.realmAddress,
      ...(input.governanceAddress !== undefined && { governanceAddress: input.governanceAddress }),
      state: input.state ?? 'voting',
      limit: input.limit ?? 20,
    });
    return {
      cluster: ctx.config.cluster,
      proposals,
      facts: {
        proposalCount: proposals.length,
        votingCount: proposals.filter((entry) => entry.state === 'voting').length,
        states: Array.from(new Set(proposals.map((entry) => entry.state))),
      },
    };
  },
};

const proposalSnapshotRead: AdapterRead<ProposalSnapshotReadInput, unknown> = {
  id: 'proposal_snapshot',
  async read(input, ctx) {
    const snapshot: ProposalSnapshot & { decodedInstructions: unknown[] } = await getProposalSnapshot(
      ctx.connection,
      input.proposalAddress,
      {
        ...(input.includeInstructions !== undefined && { includeInstructions: input.includeInstructions }),
        ...(input.includeVoteBreakdown !== undefined && { includeVoteBreakdown: input.includeVoteBreakdown }),
      },
    );
    return {
      cluster: ctx.config.cluster,
      snapshot,
      facts: {
        proposalAddress: snapshot.proposalAddress,
        name: snapshot.name,
        state: snapshot.state,
        voteType: snapshot.voteType,
        choices: snapshot.choices.length,
        voteTally: snapshot.voteTally,
        votingExpiresAt: snapshot.votingExpiresAt ?? null,
        inCoolOff: snapshot.inCoolOff,
        pluginsDetected: snapshot.pluginsDetected,
        pluginNames: snapshot.pluginNames,
        unknownInstructionCount: snapshot.decodedInstructions.length,
      },
    };
  },
};

const voteRecordRead: AdapterRead<VoteRecordReadInput, unknown> = {
  id: 'vote_record',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const record: VoteRecordSnapshot | null = await getVoteRecord(
      ctx.connection,
      input.proposalAddress,
      walletAddress,
    );
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      record,
      facts: record
        ? {
            voteKind: record.voteKind,
            weight: record.weight,
            isRelinquished: record.isRelinquished,
            choiceIndex: record.choiceIndex ?? null,
          }
        : { exists: false },
    };
  },
};

export const realmsAdapter: DAppAdapter = {
  id: REALMS_ADAPTER_ID,
  name: REALMS_NAME,
  website: REALMS_WEBSITE,
  description: REALMS_DESCRIPTION,
  supportedClusters: REALMS_SUPPORTED_CLUSTERS,
  programIds: [SPL_GOVERNANCE_PROGRAM_ID],
  actions: {
    cast_vote: realmsCastVoteAction,
    relinquish_vote: realmsRelinquishVoteAction,
    deposit_governance_tokens: realmsDepositGovernanceTokensAction,
    withdraw_governance_tokens: realmsWithdrawGovernanceTokensAction,
  },
  reads: {
    wallet_governance: walletGovernanceRead,
    realm_snapshot: realmSnapshotRead,
    governance_snapshot: governanceSnapshotRead,
    proposal_list: proposalListRead,
    proposal_snapshot: proposalSnapshotRead,
    vote_record: voteRecordRead,
  },
};

export type {
  RealmsCastVoteInput,
  RealmsRelinquishVoteInput,
  RealmsDepositGovernanceTokensInput,
  RealmsWithdrawGovernanceTokensInput,
};
export {
  REALMS_ADAPTER_ID,
  REALMS_NAME,
  REALMS_DESCRIPTION,
  REALMS_SUPPORTED_CLUSTERS,
  SPL_GOVERNANCE_PROGRAM_ID,
};
// Re-export client surface so tests can swap factories without an extra subpath import.
export { describeRealmsUnavailableReason, getRealmsClient } from './client.js';
// Also re-export the side-effect-free unused getter so tree-shakers keep walletGovernance helpers
// available to tests if needed.
export { summarizeWalletGovernance } from './realms.js';
