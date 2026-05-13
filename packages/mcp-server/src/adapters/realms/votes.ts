import type { Connection } from '@solana/web3.js';

import { AdapterError } from '../types.js';

import {
  getRealmsClient,
  type ProposalSnapshot,
  type VoteRecordSnapshot,
  type WalletGovernanceSnapshot,
} from './client.js';
import { REALMS_ADAPTER_ID, type VoteKind } from './constants.js';
import { mayCastVoteWithRawTor } from './plugins.js';
import { requireAddress } from './realms.js';

export async function getVoteRecord(
  connection: Connection,
  proposalAddress: string,
  walletAddress: string,
): Promise<VoteRecordSnapshot | null> {
  const proposal = requireAddress(proposalAddress, 'proposalAddress');
  const wallet = requireAddress(walletAddress, 'walletAddress');
  return getRealmsClient().getVoteRecord(connection, proposal, wallet);
}

export function isProposalVotable(snapshot: ProposalSnapshot): boolean {
  return snapshot.state === 'voting';
}

export interface AssertVoteEligibilityInput {
  proposal: ProposalSnapshot;
  voteKind: VoteKind;
  choiceIndex?: number;
  walletGovernance: WalletGovernanceSnapshot;
  existingVoteRecord: VoteRecordSnapshot | null;
}

export function assertVoteEligibility(input: AssertVoteEligibilityInput): void {
  const { proposal, voteKind, choiceIndex, walletGovernance, existingVoteRecord } = input;

  if (!isProposalVotable(proposal)) {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'proposal_not_voting',
      `Proposal ${proposal.proposalAddress} is in state '${proposal.state}', not 'voting'. Voting is not accepted.`,
    );
  }

  if (proposal.inCoolOff && voteKind === 'approve') {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'cool_off_period',
      `Proposal ${proposal.proposalAddress} is in the cool-off window. Only deny, veto, or abstain votes are accepted until ${proposal.coolOffEndsAt ? new Date(proposal.coolOffEndsAt * 1000).toISOString() : 'cool-off ends'}.`,
    );
  }

  if (proposal.pluginsDetected && !mayCastVoteWithRawTor({
    pluginsDetected: proposal.pluginsDetected,
    pluginNames: proposal.pluginNames,
  })) {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'plugin_controlled_voting',
      `Realm uses a governance plugin (${proposal.pluginNames.join(', ')}). Plugin-controlled voting power is not supported in v1; cast vote is refused.`,
    );
  }

  if (voteKind === 'veto') {
    if (walletGovernance.mintRole !== 'council') {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'veto_requires_council',
        `Veto can only be cast from the council mint. Wallet's governing mint role is '${walletGovernance.mintRole}'.`,
      );
    }
    if (walletGovernance.governingTokenMint === proposal.governingTokenMint) {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'veto_requires_council',
        `Veto can only be cast on a proposal governed by a different mint. This proposal is governed by the same mint the wallet votes with.`,
      );
    }
  } else {
    if (walletGovernance.governingTokenMint !== proposal.governingTokenMint) {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'mint_mismatch',
        `Wallet's governing token mint ${walletGovernance.governingTokenMint} does not match the proposal's governing mint ${proposal.governingTokenMint}.`,
      );
    }
  }

  const rawWeight = BigInt(walletGovernance.tokenOwnerRecord.governingTokenDepositAmount || '0');
  if (rawWeight === 0n) {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'no_voting_power',
      `Wallet has no voting power in this realm for mint ${walletGovernance.governingTokenMint}.`,
    );
  }

  if (existingVoteRecord && !existingVoteRecord.isRelinquished) {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'already_voted',
      `Wallet has already cast a ${existingVoteRecord.voteKind} vote on this proposal. Relinquish it before casting a new vote.`,
    );
  }

  if (proposal.voteType === 'single_choice' && choiceIndex !== undefined) {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'choice_not_applicable',
      `Proposal ${proposal.proposalAddress} is single-choice; do not pass choiceIndex.`,
    );
  }
  if (proposal.voteType === 'multi_choice') {
    if (choiceIndex === undefined) {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'choice_required',
        `Proposal ${proposal.proposalAddress} is multi-choice; choiceIndex is required.`,
      );
    }
    if (
      !Number.isInteger(choiceIndex) ||
      choiceIndex < 0 ||
      choiceIndex >= proposal.choices.length
    ) {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'choice_out_of_range',
        `choiceIndex ${choiceIndex} is outside the choices range (0..${proposal.choices.length - 1}).`,
      );
    }
  }
}

export interface AssertWithdrawUnlockedInput {
  walletAddress: string;
  walletGovernance: WalletGovernanceSnapshot;
}

export function assertWithdrawUnlocked(input: AssertWithdrawUnlockedInput): void {
  const { walletAddress, walletGovernance } = input;
  const tor = walletGovernance.tokenOwnerRecord;

  if (tor.outstandingProposalCount > 0) {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'withdraw_locked_outstanding_proposals',
      `Cannot withdraw governance tokens: wallet has ${tor.outstandingProposalCount} outstanding proposal${tor.outstandingProposalCount === 1 ? '' : 's'}. Finalize or cancel them first.`,
    );
  }
  if (tor.unrelinquishedVotesCount > 0) {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'withdraw_locked_active_votes',
      `Cannot withdraw governance tokens: wallet has ${tor.unrelinquishedVotesCount} unrelinquished vote${tor.unrelinquishedVotesCount === 1 ? '' : 's'}. Relinquish them first.`,
    );
  }
  if (tor.governanceDelegate && tor.governanceDelegate !== walletAddress) {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'withdraw_locked_delegated',
      `Cannot withdraw governance tokens: token owner record delegates to ${tor.governanceDelegate}. Undelegate first.`,
    );
  }
}
