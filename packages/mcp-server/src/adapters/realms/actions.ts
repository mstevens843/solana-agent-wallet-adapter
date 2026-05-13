import type { Connection } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { parseDecimalAmount } from '../../amounts.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import { AdapterError } from '../types.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
} from '../types.js';

import {
  getRealmsClient,
  type ProposalSnapshot,
  type WalletGovernanceSnapshot,
} from './client.js';
import {
  REALMS_ADAPTER_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
  type VoteKind,
} from './constants.js';
import { mayCastVoteWithRawTor } from './plugins.js';
import { getProposalSnapshot } from './proposals.js';
import { getRealmSnapshot, requireAddress } from './realms.js';
import {
  assertVoteEligibility,
  assertWithdrawUnlocked,
  getVoteRecord,
} from './votes.js';

export interface RealmsCastVoteInput {
  proposalAddress: string;
  vote: VoteKind;
  choiceIndex?: number;
  comment?: string;
  dueAt?: string;
  note?: string;
}

export interface RealmsRelinquishVoteInput {
  proposalAddress: string;
  beneficiaryAddress?: string;
  dueAt?: string;
  note?: string;
}

export interface RealmsDepositGovernanceTokensInput {
  realmAddress: string;
  governingTokenMint: string;
  amount: string;
  dueAt?: string;
  note?: string;
}

export interface RealmsWithdrawGovernanceTokensInput {
  realmAddress: string;
  governingTokenMint: string;
  amount?: string;
  withdrawAll?: boolean;
  dueAt?: string;
  note?: string;
}

export const realmsCastVoteAction: AdapterAction<RealmsCastVoteInput> = {
  id: 'cast_vote',
  kind: 'realms_cast_vote',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const proposalAddress = requireAddress(input.proposalAddress, 'proposalAddress');
    const walletAddress = await ctx.backend.getAddress();
    const proposal = await getProposalSnapshot(ctx.connection, proposalAddress, {
      includeInstructions: true,
      includeVoteBreakdown: true,
    });
    const walletGovs = await getRealmsClient().getWalletGovernance(ctx.connection, walletAddress, {
      realmAddress: proposal.realmAddress,
    });
    const walletGov = pickWalletGovernanceForVote(walletGovs, proposal, input.vote);
    const existingVoteRecord = await getRealmsClient().getVoteRecord(
      ctx.connection,
      proposalAddress,
      walletAddress,
    );

    assertVoteEligibility({
      proposal,
      voteKind: input.vote,
      ...(input.choiceIndex !== undefined && { choiceIndex: input.choiceIndex }),
      walletGovernance: walletGov,
      existingVoteRecord,
    });

    const summary = buildCastVoteSummary(proposal, input.vote, input.choiceIndex);
    const previewParams: Record<string, unknown> = {
      adapter: REALMS_ADAPTER_ID,
      connectorId: REALMS_ADAPTER_ID,
      action: 'cast_vote',
      operation: 'cast_vote',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      proposalAddress: proposal.proposalAddress,
      proposalName: proposal.name,
      realmAddress: proposal.realmAddress,
      governanceAddress: proposal.governanceAddress,
      governingTokenMint: proposal.governingTokenMint,
      governingTokenMintRole: walletGov.mintRole,
      voteKind: input.vote,
      ...(input.choiceIndex !== undefined && { choiceIndex: input.choiceIndex }),
      voteType: proposal.voteType,
      proposalStateAtPrepare: proposal.state,
      votingExpiresAt: proposal.votingExpiresAt ?? null,
      inCoolOffAtPrepare: proposal.inCoolOff,
      coolOffEndsAt: proposal.coolOffEndsAt ?? null,
      pluginsDetectedAtPrepare: proposal.pluginsDetected,
      pluginNamesAtPrepare: proposal.pluginNames,
      voteRecordExistedAtPrepare: existingVoteRecord !== null,
      walletWeightAtPrepare: walletGov.tokenOwnerRecord.governingTokenDepositAmount,
      voteTallyAtPrepare: proposal.voteTally,
      programId: SPL_GOVERNANCE_PROGRAM_ID.toBase58(),
      executionNote:
        'Voting is not execution. A vote tipping a threshold does not guarantee proposal execution.',
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
      ...(input.comment !== undefined && { comment: input.comment }),
    };

    return {
      addInput: {
        kind: 'realms_cast_vote',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params: previewParams,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: previewParams,
    };
  },

  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    const proposalAddress = requireString(action, 'proposalAddress');
    const governingTokenMint = requireString(action, 'governingTokenMint');
    const voteKind = requireVoteKind(action);
    const choiceIndex = optionalNumber(action, 'choiceIndex');

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Realms cast vote belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const proposal = await getProposalSnapshot(ctx.connection, proposalAddress, {
      includeVoteBreakdown: true,
    });
    if (proposal.state !== 'voting') {
      throw new ProtocolError(
        'invalid_request',
        `Proposal ${proposalAddress} is now '${proposal.state}', not 'voting'. Re-prepare before executing.`,
      );
    }
    if (proposal.inCoolOff && voteKind === 'approve') {
      throw new ProtocolError(
        'invalid_request',
        `Proposal ${proposalAddress} entered cool-off; approve is not accepted. Re-prepare with deny, veto, or abstain.`,
      );
    }
    if (
      proposal.pluginsDetected &&
      !mayCastVoteWithRawTor({
        pluginsDetected: proposal.pluginsDetected,
        pluginNames: proposal.pluginNames,
      })
    ) {
      throw new ProtocolError(
        'invalid_request',
        `Realm now uses a governance plugin (${proposal.pluginNames.join(', ')}); plugin-controlled voting is not supported in v1.`,
      );
    }
    if (proposal.governingTokenMint !== governingTokenMint) {
      throw new ProtocolError(
        'invalid_request',
        `Proposal governing mint changed from ${governingTokenMint} to ${proposal.governingTokenMint} since prepare time. Re-prepare before executing.`,
      );
    }

    const walletGovs = await getRealmsClient().getWalletGovernance(ctx.connection, walletAddress, {
      realmAddress: proposal.realmAddress,
    });
    const walletGov = pickWalletGovernanceForVote(walletGovs, proposal, voteKind);
    const rawWeight = BigInt(walletGov.tokenOwnerRecord.governingTokenDepositAmount || '0');
    if (rawWeight === 0n) {
      throw new ProtocolError(
        'invalid_request',
        `Wallet now has no voting power for mint ${governingTokenMint} in realm ${proposal.realmAddress}.`,
      );
    }

    const built = await getRealmsClient().buildCastVoteTransaction(ctx.connection, {
      walletAddress,
      proposalAddress,
      governingTokenMint,
      voteKind,
      ...(choiceIndex !== undefined && { choiceIndex }),
    });
    const summary = buildCastVoteSummary(proposal, voteKind, choiceIndex);
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        proposalAddress: built.proposalAddress,
        proposalName: built.proposalName,
        realmAddress: built.realmAddress,
        governanceAddress: built.governanceAddress,
        voteKind: built.voteKind,
        ...(built.choiceIndex !== undefined && { choiceIndex: built.choiceIndex }),
        postWalletWeight: built.postWalletWeight,
      },
    };
  },
};

export const realmsRelinquishVoteAction: AdapterAction<RealmsRelinquishVoteInput> = {
  id: 'relinquish_vote',
  kind: 'realms_relinquish_vote',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const proposalAddress = requireAddress(input.proposalAddress, 'proposalAddress');
    const walletAddress = await ctx.backend.getAddress();
    const beneficiary = input.beneficiaryAddress
      ? requireAddress(input.beneficiaryAddress, 'beneficiaryAddress')
      : undefined;

    const voteRecord = await getRealmsClient().getVoteRecord(
      ctx.connection,
      proposalAddress,
      walletAddress,
    );
    if (!voteRecord || voteRecord.isRelinquished) {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'no_vote_record',
        `No relinquishable vote record found for wallet ${walletAddress} on proposal ${proposalAddress}.`,
      );
    }

    const proposal = await getProposalSnapshot(ctx.connection, proposalAddress, {
      includeVoteBreakdown: true,
    });
    const isFinalized = proposal.state !== 'voting';

    const summary = `Relinquish ${voteRecord.voteKind} vote on Realms proposal ${displayProposalName(proposal)}`;
    const previewParams: Record<string, unknown> = {
      adapter: REALMS_ADAPTER_ID,
      connectorId: REALMS_ADAPTER_ID,
      action: 'relinquish_vote',
      operation: 'relinquish_vote',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      proposalAddress: proposal.proposalAddress,
      proposalName: proposal.name,
      realmAddress: proposal.realmAddress,
      governanceAddress: proposal.governanceAddress,
      governingTokenMint: voteRecord.governingTokenMint,
      voteRecordAddress: voteRecord.recordAddress,
      voteKindAtPrepare: voteRecord.voteKind,
      voteWeightAtPrepare: voteRecord.weight,
      proposalStateAtPrepare: proposal.state,
      isFinalizedAtPrepare: isFinalized,
      relinquishEffect: isFinalized
        ? 'Refunds the vote deposit; does not change the recorded tally because the proposal is finalized.'
        : 'Removes this vote from the current tally and refunds the vote deposit.',
      ...(beneficiary !== undefined && { beneficiaryAddress: beneficiary }),
      programId: SPL_GOVERNANCE_PROGRAM_ID.toBase58(),
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
    };

    return {
      addInput: {
        kind: 'realms_relinquish_vote',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params: previewParams,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: previewParams,
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const proposalAddress = requireString(action, 'proposalAddress');
    const governingTokenMint = requireString(action, 'governingTokenMint');
    const beneficiary = optionalString(action, 'beneficiaryAddress');

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Realms relinquish vote belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const refreshed = await getRealmsClient().getVoteRecord(
      ctx.connection,
      proposalAddress,
      walletAddress,
    );
    if (!refreshed || refreshed.isRelinquished) {
      throw new ProtocolError(
        'invalid_request',
        `Vote record for ${proposalAddress} no longer exists or is already relinquished.`,
      );
    }
    if (refreshed.governingTokenMint !== governingTokenMint) {
      throw new ProtocolError(
        'invalid_request',
        `Vote record governing mint changed since prepare time. Re-prepare before executing.`,
      );
    }

    const built = await getRealmsClient().buildRelinquishVoteTransaction(ctx.connection, {
      walletAddress,
      proposalAddress,
      governingTokenMint,
      ...(beneficiary !== undefined && { beneficiaryAddress: beneficiary }),
    });
    const summary = `Relinquish vote on Realms proposal ${built.proposalName || short(built.proposalAddress)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        proposalAddress: built.proposalAddress,
        proposalName: built.proposalName,
        realmAddress: built.realmAddress,
        governanceAddress: built.governanceAddress,
        isFinalized: built.isFinalized,
      },
    };
  },
};

export const realmsDepositGovernanceTokensAction: AdapterAction<RealmsDepositGovernanceTokensInput> = {
  id: 'deposit_governance_tokens',
  kind: 'realms_deposit_governance_tokens',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const realmAddress = requireAddress(input.realmAddress, 'realmAddress');
    const governingTokenMint = requireAddress(input.governingTokenMint, 'governingTokenMint');
    const walletAddress = await ctx.backend.getAddress();

    const realm = await getRealmSnapshot(ctx.connection, realmAddress, {
      includeGovernances: false,
      includeTokenMints: true,
    });
    const role = resolveMintRole(realm, governingTokenMint);
    const decimals = role === 'community' ? realm.communityMintDecimals : realm.councilMintDecimals;
    if (decimals === undefined) {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'mint_decimals_unknown',
        `Cannot resolve decimals for governing mint ${governingTokenMint}.`,
      );
    }
    const amountRaw = parseDecimalAmount(input.amount, decimals, 'Realms governance token deposit amount');

    const summary = `Deposit ${input.amount} governance tokens into Realms ${displayRealmName(realm)} (${role})`;
    const previewParams: Record<string, unknown> = {
      adapter: REALMS_ADAPTER_ID,
      connectorId: REALMS_ADAPTER_ID,
      action: 'deposit_governance_tokens',
      operation: 'deposit_governance_tokens',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      realmAddress: realm.realmAddress,
      realmName: realm.name,
      governingTokenMint,
      governingTokenMintRole: role,
      amount: input.amount,
      amountRaw: amountRaw.toString(),
      mintDecimals: decimals,
      pluginsDetectedAtPrepare: realm.pluginsDetected,
      pluginNamesAtPrepare: realm.pluginNames,
      pluginsWarning: realm.pluginsDetected
        ? 'Realm uses a voting power plugin. Deposit updates the raw token-owner-record balance, but actual voting weight may be plugin-computed.'
        : null,
      programId: SPL_GOVERNANCE_PROGRAM_ID.toBase58(),
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
    };

    return {
      addInput: {
        kind: 'realms_deposit_governance_tokens',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params: previewParams,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: previewParams,
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const realmAddress = requireString(action, 'realmAddress');
    const governingTokenMint = requireString(action, 'governingTokenMint');
    const amountRawText = requireString(action, 'amountRaw');

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Realms deposit belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const realm = await getRealmSnapshot(ctx.connection, realmAddress, {
      includeTokenMints: true,
    });
    const role = resolveMintRoleStrict(realm, governingTokenMint);
    if (!role) {
      throw new ProtocolError(
        'invalid_request',
        `Mint ${governingTokenMint} is no longer either community or council mint of realm ${realmAddress}. Re-prepare before executing.`,
      );
    }

    const built = await getRealmsClient().buildDepositGovernanceTokensTransaction(ctx.connection, {
      walletAddress,
      realmAddress,
      governingTokenMint,
      amountRaw: BigInt(amountRawText),
    });
    const summary = `Deposit ${built.amountUi} governance tokens into Realms ${built.realmName || short(built.realmAddress)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        realmAddress: built.realmAddress,
        realmName: built.realmName,
        governingTokenMint: built.governingTokenMint,
        amountUi: built.amountUi,
        amountRaw: built.amountRaw,
      },
    };
  },
};

export const realmsWithdrawGovernanceTokensAction: AdapterAction<RealmsWithdrawGovernanceTokensInput> = {
  id: 'withdraw_governance_tokens',
  kind: 'realms_withdraw_governance_tokens',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const realmAddress = requireAddress(input.realmAddress, 'realmAddress');
    const governingTokenMint = requireAddress(input.governingTokenMint, 'governingTokenMint');
    const walletAddress = await ctx.backend.getAddress();
    const withdrawAll = input.withdrawAll === true;

    if (!withdrawAll && !input.amount) {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'invalid_amount',
        'Provide amount, or set withdrawAll: true to withdraw the full deposit.',
      );
    }

    const realm = await getRealmSnapshot(ctx.connection, realmAddress, {
      includeTokenMints: true,
    });
    const role = resolveMintRole(realm, governingTokenMint);
    const decimals = role === 'community' ? realm.communityMintDecimals : realm.councilMintDecimals;
    if (decimals === undefined) {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'mint_decimals_unknown',
        `Cannot resolve decimals for governing mint ${governingTokenMint}.`,
      );
    }

    const walletGovs = await getRealmsClient().getWalletGovernance(ctx.connection, walletAddress, {
      realmAddress,
    });
    const walletGov = walletGovs.find(
      (entry) =>
        entry.realmAddress === realmAddress && entry.governingTokenMint === governingTokenMint,
    );
    if (!walletGov) {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'no_token_owner_record',
        `Wallet has no token owner record in realm ${realmAddress} for mint ${governingTokenMint}.`,
      );
    }
    assertWithdrawUnlocked({ walletAddress, walletGovernance: walletGov });

    const depositedRaw = BigInt(walletGov.tokenOwnerRecord.governingTokenDepositAmount || '0');
    if (depositedRaw === 0n) {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'nothing_to_withdraw',
        `Wallet has no deposited governance tokens to withdraw in realm ${realmAddress}.`,
      );
    }

    let amountRaw: bigint;
    let amountText: string;
    if (withdrawAll) {
      amountRaw = depositedRaw;
      amountText = formatRawAsDecimal(depositedRaw, decimals);
    } else {
      amountRaw = parseDecimalAmount(input.amount!, decimals, 'Realms governance token withdraw amount');
      if (amountRaw > depositedRaw) {
        throw new AdapterError(
          REALMS_ADAPTER_ID,
          'insufficient_balance',
          `Requested withdraw ${input.amount} exceeds deposited balance ${formatRawAsDecimal(depositedRaw, decimals)}.`,
        );
      }
      amountText = input.amount!;
    }

    const summary = `Withdraw ${withdrawAll ? 'all ' : ''}${amountText} governance tokens from Realms ${displayRealmName(realm)} (${role})`;
    const previewParams: Record<string, unknown> = {
      adapter: REALMS_ADAPTER_ID,
      connectorId: REALMS_ADAPTER_ID,
      action: 'withdraw_governance_tokens',
      operation: 'withdraw_governance_tokens',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      realmAddress: realm.realmAddress,
      realmName: realm.name,
      governingTokenMint,
      governingTokenMintRole: role,
      amount: amountText,
      amountRaw: amountRaw.toString(),
      mintDecimals: decimals,
      withdrawAll,
      depositedAtPrepare: walletGov.tokenOwnerRecord.governingTokenDepositAmount,
      outstandingProposalsAtPrepare: walletGov.tokenOwnerRecord.outstandingProposalCount,
      unrelinquishedVotesAtPrepare: walletGov.tokenOwnerRecord.unrelinquishedVotesCount,
      delegateAtPrepare: walletGov.tokenOwnerRecord.governanceDelegate ?? null,
      pluginsDetectedAtPrepare: realm.pluginsDetected,
      pluginNamesAtPrepare: realm.pluginNames,
      pluginsWarning: realm.pluginsDetected
        ? 'Realm uses a voting power plugin. Plugin-imposed lockups may cause this withdraw to fail on-chain even though the connector accepted it.'
        : null,
      programId: SPL_GOVERNANCE_PROGRAM_ID.toBase58(),
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
    };

    return {
      addInput: {
        kind: 'realms_withdraw_governance_tokens',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params: previewParams,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: previewParams,
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const realmAddress = requireString(action, 'realmAddress');
    const governingTokenMint = requireString(action, 'governingTokenMint');
    const withdrawAll = action.params.withdrawAll === true;
    const amountRawText = optionalString(action, 'amountRaw');

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Realms withdraw belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const walletGovs = await getRealmsClient().getWalletGovernance(ctx.connection, walletAddress, {
      realmAddress,
    });
    const walletGov = walletGovs.find(
      (entry) =>
        entry.realmAddress === realmAddress && entry.governingTokenMint === governingTokenMint,
    );
    if (!walletGov) {
      throw new ProtocolError(
        'invalid_request',
        `Wallet no longer has a token owner record in realm ${realmAddress} for mint ${governingTokenMint}.`,
      );
    }
    assertWithdrawUnlockedAtExecute({ walletAddress, walletGovernance: walletGov });

    const built = await getRealmsClient().buildWithdrawGovernanceTokensTransaction(ctx.connection, {
      walletAddress,
      realmAddress,
      governingTokenMint,
      ...(amountRawText !== undefined && !withdrawAll && { amountRaw: BigInt(amountRawText) }),
      withdrawAll,
    });
    const summary = `Withdraw ${withdrawAll ? 'all ' : ''}${built.amountUi} governance tokens from Realms ${built.realmName || short(built.realmAddress)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        realmAddress: built.realmAddress,
        realmName: built.realmName,
        governingTokenMint: built.governingTokenMint,
        amountUi: built.amountUi,
        amountRaw: built.amountRaw,
        withdrawAll: built.withdrawAll,
      },
    };
  },
};

function buildCastVoteSummary(
  proposal: ProposalSnapshot,
  voteKind: VoteKind,
  choiceIndex: number | undefined,
): string {
  const proposalName = displayProposalName(proposal);
  if (proposal.voteType === 'multi_choice' && choiceIndex !== undefined) {
    const label = proposal.choices[choiceIndex]?.label ?? `choice ${choiceIndex}`;
    return `Vote ${voteKind} (${label}) on Realms proposal ${proposalName}`;
  }
  return `Vote ${voteKind} on Realms proposal ${proposalName}`;
}

function pickWalletGovernanceForVote(
  walletGovs: WalletGovernanceSnapshot[],
  proposal: ProposalSnapshot,
  voteKind: VoteKind,
): WalletGovernanceSnapshot {
  if (voteKind === 'veto') {
    const council = walletGovs.find(
      (entry) =>
        entry.realmAddress === proposal.realmAddress && entry.mintRole === 'council',
    );
    if (!council) {
      throw new AdapterError(
        REALMS_ADAPTER_ID,
        'no_council_record',
        `Wallet has no council token owner record in realm ${proposal.realmAddress}; cannot veto.`,
      );
    }
    return council;
  }
  const match = walletGovs.find(
    (entry) =>
      entry.realmAddress === proposal.realmAddress &&
      entry.governingTokenMint === proposal.governingTokenMint,
  );
  if (!match) {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'no_token_owner_record',
      `Wallet has no token owner record for mint ${proposal.governingTokenMint} in realm ${proposal.realmAddress}.`,
    );
  }
  return match;
}

function resolveMintRole(
  realm: { communityMint: string; councilMint?: string },
  mint: string,
): 'community' | 'council' {
  if (realm.communityMint === mint) return 'community';
  if (realm.councilMint && realm.councilMint === mint) return 'council';
  throw new AdapterError(
    REALMS_ADAPTER_ID,
    'mint_not_in_realm',
    `Mint ${mint} is neither the community nor the council mint of this realm.`,
  );
}

function resolveMintRoleStrict(
  realm: { communityMint: string; councilMint?: string },
  mint: string,
): 'community' | 'council' | null {
  if (realm.communityMint === mint) return 'community';
  if (realm.councilMint && realm.councilMint === mint) return 'council';
  return null;
}

function assertWithdrawUnlockedAtExecute(input: {
  walletAddress: string;
  walletGovernance: WalletGovernanceSnapshot;
}): void {
  try {
    assertWithdrawUnlocked(input);
  } catch (err) {
    if (err instanceof AdapterError) {
      throw new ProtocolError('invalid_request', err.message);
    }
    throw err;
  }
}

function displayRealmName(realm: { name: string; realmAddress: string }): string {
  return realm.name?.trim() || short(realm.realmAddress);
}

function displayProposalName(proposal: { name: string; proposalAddress: string }): string {
  return proposal.name?.trim() || short(proposal.proposalAddress);
}

function formatRawAsDecimal(rawAmount: bigint, decimals: number): string {
  if (decimals <= 0) return rawAmount.toString();
  const raw = rawAmount.toString();
  if (raw.length <= decimals) {
    const fraction = raw.padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? `0.${fraction}` : '0';
  }
  const head = raw.slice(0, raw.length - decimals);
  const tail = raw.slice(raw.length - decimals).replace(/0+$/, '');
  return tail ? `${head}.${tail}` : head;
}

function requireString(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `Realms action ${action.id} is missing ${key}.`);
  }
  return value;
}

function optionalString(action: PreparedAction, key: string): string | undefined {
  const value = action.params[key];
  return typeof value === 'string' && value ? value : undefined;
}

function optionalNumber(action: PreparedAction, key: string): number | undefined {
  const value = action.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requireVoteKind(action: PreparedAction): VoteKind {
  const value = action.params.voteKind;
  if (value === 'approve' || value === 'deny' || value === 'abstain' || value === 'veto') {
    return value;
  }
  throw new ProtocolError(
    'invalid_request',
    `Realms action ${action.id} has invalid voteKind '${String(value)}'.`,
  );
}

function short(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
