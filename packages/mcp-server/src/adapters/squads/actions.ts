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
  getSquadsMultisigClient,
  type SquadsProposalSnapshot,
} from './client.js';
import {
  SQUADS_ADAPTER_ID,
  SQUADS_PROGRAM_ID,
  type SquadsProposalStatus,
  type SquadsVoteOperation,
} from './constants.js';
import {
  getMultisigSnapshot,
  resolveMemberPermissions,
  requireMultisigAddress,
  requirePublicKey,
  requireString,
  requireNumber,
  optionalString,
  short,
} from './multisigs.js';
import {
  assertCanExecute,
  assertCanVote,
  assertExecuteStateUnchanged,
  assertProposalState,
  collectInstructionWarnings,
  getProposalSnapshot,
  requireProposalDescriptor,
} from './proposals.js';
import {
  assertSufficientVaultBalance,
  assertVaultMintDecimals,
  getVaultSnapshot,
  requireVaultDescriptor,
} from './vaults.js';

export interface SquadsCreateTransferProposalInput {
  multisigAddress: string;
  recipient: string;
  amount: string;
  /** Omit for SOL transfer. */
  mintAddress?: string;
  vaultIndex?: number;
  vaultAddress?: string;
  memo?: string;
  title: string;
  description?: string;
  dueAt?: string;
  note?: string;
}

export interface SquadsVoteInput {
  multisigAddress: string;
  proposalAddress?: string;
  transactionIndex?: number;
  reason?: string;
  dueAt?: string;
  note?: string;
}

export interface SquadsExecuteProposalInput {
  multisigAddress: string;
  proposalAddress?: string;
  transactionIndex?: number;
  dueAt?: string;
  note?: string;
}

const SOL_DECIMALS = 9;

export const squadsCreateTransferProposalAction: AdapterAction<SquadsCreateTransferProposalInput> = {
  id: 'create_transfer_proposal',
  kind: 'squads_create_transfer_proposal',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const multisigAddress = requireMultisigAddress(input.multisigAddress);
    const recipient = requirePublicKey(input.recipient, 'recipient');
    if (input.mintAddress !== undefined) requirePublicKey(input.mintAddress, 'mintAddress');
    if (!input.title || !input.title.trim()) {
      throw new AdapterError(SQUADS_ADAPTER_ID, 'invalid_request', 'title is required for a Squads transfer proposal.');
    }

    const walletAddress = await ctx.backend.getAddress();
    const multisigSnapshot = await getMultisigSnapshot(ctx.connection, multisigAddress, {
      includeMembers: true,
    });
    const permissions = resolveMemberPermissions(multisigSnapshot, walletAddress);
    if (!permissions.member) {
      throw new AdapterError(
        SQUADS_ADAPTER_ID,
        'not_a_member',
        `Connected wallet ${walletAddress} is not a member of Squads multisig ${short(multisigAddress)}.`,
      );
    }
    if (!permissions.canInitiate) {
      throw new AdapterError(
        SQUADS_ADAPTER_ID,
        'no_proposer_permission',
        'Connected wallet does not have proposer permission on this Squads multisig.',
      );
    }

    const descriptor = requireVaultDescriptor({
      ...(input.vaultIndex !== undefined && { vaultIndex: input.vaultIndex }),
      ...(input.vaultAddress !== undefined && { vaultAddress: input.vaultAddress }),
    });
    const vaultSnapshot = await getVaultSnapshot(ctx.connection, multisigAddress, {
      ...descriptor,
      includeBalances: true,
    });

    const mintAddress = input.mintAddress?.trim() || null;
    let decimals = SOL_DECIMALS;
    let tokenSymbol: string | undefined;
    if (mintAddress) {
      const tokenAccount = vaultSnapshot.tokenAccounts.find((entry) => entry.mint === mintAddress);
      if (!tokenAccount) {
        throw new AdapterError(
          SQUADS_ADAPTER_ID,
          'missing_token_account',
          `Squads vault ${short(vaultSnapshot.vaultAddress)} has no token account for mint ${mintAddress}.`,
        );
      }
      decimals = tokenAccount.decimals;
      tokenSymbol = tokenAccount.symbol;
      assertVaultMintDecimals(vaultSnapshot, mintAddress);
    }

    const amountRaw = parseDecimalAmount(input.amount, decimals, 'Squads transfer amount');
    if (amountRaw <= 0n) {
      throw new AdapterError(SQUADS_ADAPTER_ID, 'invalid_amount', 'amount must be greater than zero.');
    }
    assertSufficientVaultBalance(vaultSnapshot, mintAddress, amountRaw);

    const nextTransactionIndex = multisigSnapshot.transactionIndex + 1;
    const summary = mintAddress
      ? `Propose Squads transfer of ${input.amount} ${tokenSymbol ?? short(mintAddress)} to ${short(recipient)}`
      : `Propose Squads transfer of ${input.amount} SOL to ${short(recipient)}`;
    const previewParams: Record<string, unknown> = {
      adapter: SQUADS_ADAPTER_ID,
      connectorId: SQUADS_ADAPTER_ID,
      action: 'create_transfer_proposal',
      operation: 'create_transfer_proposal',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      multisigAddress,
      vaultIndex: vaultSnapshot.vaultIndex,
      vaultAddress: vaultSnapshot.vaultAddress,
      recipient,
      mintAddress,
      ...(tokenSymbol && { tokenSymbol }),
      decimals,
      amount: input.amount,
      amountRaw: amountRaw.toString(),
      vaultLamports: vaultSnapshot.lamports,
      vaultSolUi: vaultSnapshot.solUi,
      vaultTokenBalance: mintAddress
        ? vaultSnapshot.tokenAccounts.find((entry) => entry.mint === mintAddress)?.amountUi ?? null
        : null,
      thresholdSnapshot: {
        threshold: multisigSnapshot.threshold,
        memberCount: multisigSnapshot.members.length,
        timeLockSec: multisigSnapshot.timeLockSec,
      },
      memberSnapshot: {
        publicKey: permissions.member.publicKey,
        canInitiate: permissions.canInitiate,
        canVote: permissions.canVote,
        canExecute: permissions.canExecute,
      },
      proposedTransactionIndex: nextTransactionIndex,
      programIds: [SQUADS_PROGRAM_ID.toBase58()],
      ...(input.memo !== undefined && { memo: input.memo }),
      title: input.title.trim(),
      ...(input.description !== undefined && { description: input.description }),
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
    };

    return {
      addInput: {
        kind: 'squads_create_transfer_proposal',
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
    assertOriginalWallet(action, await ctx.backend.getAddress());
    const multisigAddress = requireString(action, 'multisigAddress');
    const vaultIndex = requireNumber(action, 'vaultIndex');
    const recipient = requireString(action, 'recipient');
    const amountRaw = BigInt(requireString(action, 'amountRaw'));
    const decimals = requireNumber(action, 'decimals');
    const mintAddress = optionalString(action, 'mintAddress') ?? null;
    const memo = optionalString(action, 'memo');
    const title = requireString(action, 'title');
    const description = optionalString(action, 'description');
    const expectedNextIndex = requireNumber(action, 'proposedTransactionIndex');

    const freshMultisig = await getMultisigSnapshot(ctx.connection, multisigAddress, {
      includeMembers: true,
    });
    if (freshMultisig.transactionIndex + 1 !== expectedNextIndex) {
      throw new ProtocolError(
        'invalid_request',
        `Squads transactionIndex advanced from ${expectedNextIndex - 1} to ${freshMultisig.transactionIndex} since prepare. Re-prepare before signing.`,
      );
    }
    const permissions = resolveMemberPermissions(freshMultisig, action.walletAddress);
    if (!permissions.canInitiate) {
      throw new ProtocolError(
        'unauthorized',
        'Connected wallet no longer has proposer permission on this Squads multisig.',
      );
    }

    const freshVault = await getVaultSnapshot(ctx.connection, multisigAddress, {
      vaultIndex,
      includeBalances: true,
    });
    assertSufficientVaultBalance(freshVault, mintAddress, amountRaw);

    const built = await getSquadsMultisigClient().buildCreateTransferProposalTransaction(ctx.connection, {
      walletAddress: action.walletAddress,
      multisigAddress,
      vaultIndex,
      recipient,
      mintAddress,
      amountRaw,
      decimals,
      ...(memo !== undefined && { memo }),
      title,
      ...(description !== undefined && { description }),
      transactionIndex: expectedNextIndex,
    });
    const summary = mintAddress
      ? `Propose Squads transfer of ${built.amountUi} ${short(mintAddress)} to ${short(recipient)}`
      : `Propose Squads transfer of ${built.amountUi} SOL to ${short(recipient)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);

    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        multisigAddress: built.multisigAddress,
        vaultIndex: built.vaultIndex,
        vaultAddress: built.vaultAddress,
        recipient: built.recipient,
        mintAddress: built.mintAddress,
        amountUi: built.amountUi,
        transactionIndex: built.transactionIndex,
        proposalAddress: built.proposalAddress,
        transactionAddress: built.transactionAddress,
        instructionPreview: built.instructionPreview,
      },
    };
  },
};

export function squadsVoteAction(operation: SquadsVoteOperation): AdapterAction<SquadsVoteInput> {
  const kind = (
    operation === 'approve'
      ? 'squads_approve_proposal'
      : operation === 'reject'
        ? 'squads_reject_proposal'
        : 'squads_cancel_proposal'
  ) as AdapterAction<SquadsVoteInput>['kind'];
  const allowed: SquadsProposalStatus[] = operation === 'cancel' ? ['approved'] : ['active'];
  const id = `${operation}_proposal`;

  return {
    id,
    kind,

    async prepare(input, ctx): Promise<AdapterPrepareResult> {
      const multisigAddress = requireMultisigAddress(input.multisigAddress);
      const descriptor = requireProposalDescriptor({
        ...(input.proposalAddress !== undefined && { proposalAddress: input.proposalAddress }),
        ...(input.transactionIndex !== undefined && { transactionIndex: input.transactionIndex }),
      });
      const walletAddress = await ctx.backend.getAddress();
      const multisigSnapshot = await getMultisigSnapshot(ctx.connection, multisigAddress, {
        includeMembers: true,
      });
      const permissions = resolveMemberPermissions(multisigSnapshot, walletAddress);
      const proposalSnapshot = await getProposalSnapshot(ctx.connection, multisigAddress, {
        ...descriptor,
        includeInstructions: true,
      });
      assertProposalState(proposalSnapshot, allowed, operation);
      assertCanVote(permissions, operation, proposalSnapshot.status);

      const warnings = collectInstructionWarnings(proposalSnapshot.instructionPreview);
      const summary = formatVoteSummary(operation, proposalSnapshot);
      const previewParams: Record<string, unknown> = {
        adapter: SQUADS_ADAPTER_ID,
        connectorId: SQUADS_ADAPTER_ID,
        action: id,
        operation,
        approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
        multisigAddress,
        proposalAddress: proposalSnapshot.proposalAddress,
        transactionAddress: proposalSnapshot.transactionAddress,
        transactionIndex: proposalSnapshot.transactionIndex,
        proposalStatus: proposalSnapshot.status,
        approvalCount: proposalSnapshot.approvalCount,
        rejectionCount: proposalSnapshot.rejectionCount,
        threshold: proposalSnapshot.threshold,
        approvalsRequired: proposalSnapshot.approvalsRequired,
        thresholdSnapshot: {
          threshold: multisigSnapshot.threshold,
          memberCount: multisigSnapshot.members.length,
          timeLockSec: multisigSnapshot.timeLockSec,
        },
        memberSnapshot: {
          publicKey: permissions.member!.publicKey,
          canInitiate: permissions.canInitiate,
          canVote: permissions.canVote,
          canExecute: permissions.canExecute,
        },
        instructionPreview: proposalSnapshot.instructionPreview,
        instructionWarnings: warnings,
        ...(proposalSnapshot.lockoutExpiresAt !== undefined && { lockoutExpiresAt: proposalSnapshot.lockoutExpiresAt }),
        ...(proposalSnapshot.executableAt !== undefined && { executableAt: proposalSnapshot.executableAt }),
        ...(input.reason !== undefined && { reason: input.reason }),
        preparedSnapshotAt: new Date().toISOString(),
        refreshAtExecution: true,
      };

      return {
        addInput: {
          kind,
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
      assertOriginalWallet(action, await ctx.backend.getAddress());
      const multisigAddress = requireString(action, 'multisigAddress');
      const proposalAddress = requireString(action, 'proposalAddress');
      const transactionIndex = requireNumber(action, 'transactionIndex');
      const preparedStatus = requireString(action, 'proposalStatus') as SquadsProposalStatus;
      const preparedApprovals = requireNumber(action, 'approvalCount');
      const preparedExecutableAt = typeof action.params.executableAt === 'number'
        ? action.params.executableAt
        : undefined;

      const freshMultisig = await getMultisigSnapshot(ctx.connection, multisigAddress, {
        includeMembers: true,
      });
      const permissions = resolveMemberPermissions(freshMultisig, action.walletAddress);
      assertCanVote(permissions, operation, preparedStatus);

      const freshProposal = await getProposalSnapshot(ctx.connection, multisigAddress, {
        proposalAddress,
        includeInstructions: false,
      });
      assertProposalState(freshProposal, allowed, operation);
      assertExecuteStateUnchanged(
        {
          approvalCount: preparedApprovals,
          status: preparedStatus,
          ...(preparedExecutableAt !== undefined && { executableAt: preparedExecutableAt }),
        },
        freshProposal,
      );

      const reason = optionalString(action, 'reason');
      const built = await getSquadsMultisigClient().buildVoteTransaction(ctx.connection, {
        walletAddress: action.walletAddress,
        multisigAddress,
        transactionIndex,
        proposalAddress,
        operation,
        ...(reason !== undefined && { reason }),
      });
      const summary = formatVoteSummary(operation, freshProposal);
      const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);

      return {
        txid,
        signedAt: new Date().toISOString(),
        preview: {
          multisigAddress: built.multisigAddress,
          proposalAddress: built.proposalAddress,
          transactionIndex: built.transactionIndex,
          operation: built.operation,
        },
      };
    },
  };
}

export const squadsExecuteProposalAction: AdapterAction<SquadsExecuteProposalInput> = {
  id: 'execute_proposal',
  kind: 'squads_execute_proposal',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const multisigAddress = requireMultisigAddress(input.multisigAddress);
    const descriptor = requireProposalDescriptor({
      ...(input.proposalAddress !== undefined && { proposalAddress: input.proposalAddress }),
      ...(input.transactionIndex !== undefined && { transactionIndex: input.transactionIndex }),
    });
    const walletAddress = await ctx.backend.getAddress();
    const multisigSnapshot = await getMultisigSnapshot(ctx.connection, multisigAddress, {
      includeMembers: true,
    });
    const permissions = resolveMemberPermissions(multisigSnapshot, walletAddress);
    const proposalSnapshot = await getProposalSnapshot(ctx.connection, multisigAddress, {
      ...descriptor,
      includeInstructions: true,
    });
    assertCanExecute(permissions, proposalSnapshot, Date.now());

    const warnings = collectInstructionWarnings(proposalSnapshot.instructionPreview);
    const summary = `Execute Squads proposal #${proposalSnapshot.transactionIndex}`;
    const previewParams: Record<string, unknown> = {
      adapter: SQUADS_ADAPTER_ID,
      connectorId: SQUADS_ADAPTER_ID,
      action: 'execute_proposal',
      operation: 'execute',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      multisigAddress,
      proposalAddress: proposalSnapshot.proposalAddress,
      transactionAddress: proposalSnapshot.transactionAddress,
      transactionIndex: proposalSnapshot.transactionIndex,
      proposalStatus: proposalSnapshot.status,
      approvalCount: proposalSnapshot.approvalCount,
      rejectionCount: proposalSnapshot.rejectionCount,
      threshold: proposalSnapshot.threshold,
      approvalsRequired: proposalSnapshot.approvalsRequired,
      thresholdSnapshot: {
        threshold: multisigSnapshot.threshold,
        memberCount: multisigSnapshot.members.length,
        timeLockSec: multisigSnapshot.timeLockSec,
      },
      memberSnapshot: {
        publicKey: permissions.member!.publicKey,
        canInitiate: permissions.canInitiate,
        canVote: permissions.canVote,
        canExecute: permissions.canExecute,
      },
      instructionPreview: proposalSnapshot.instructionPreview,
      instructionWarnings: warnings,
      ...(proposalSnapshot.lockoutExpiresAt !== undefined && { lockoutExpiresAt: proposalSnapshot.lockoutExpiresAt }),
      ...(proposalSnapshot.executableAt !== undefined && { executableAt: proposalSnapshot.executableAt }),
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
    };

    return {
      addInput: {
        kind: 'squads_execute_proposal',
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
    assertOriginalWallet(action, await ctx.backend.getAddress());
    const multisigAddress = requireString(action, 'multisigAddress');
    const proposalAddress = requireString(action, 'proposalAddress');
    const transactionIndex = requireNumber(action, 'transactionIndex');
    const preparedStatus = requireString(action, 'proposalStatus') as SquadsProposalStatus;
    const preparedApprovals = requireNumber(action, 'approvalCount');
    const preparedExecutableAt = typeof action.params.executableAt === 'number'
      ? action.params.executableAt
      : undefined;

    const freshMultisig = await getMultisigSnapshot(ctx.connection, multisigAddress, {
      includeMembers: true,
    });
    const permissions = resolveMemberPermissions(freshMultisig, action.walletAddress);
    const freshProposal = await getProposalSnapshot(ctx.connection, multisigAddress, {
      proposalAddress,
      includeInstructions: false,
    });
    assertCanExecute(permissions, freshProposal, Date.now());
    assertExecuteStateUnchanged(
      {
        approvalCount: preparedApprovals,
        status: preparedStatus,
        ...(preparedExecutableAt !== undefined && { executableAt: preparedExecutableAt }),
      },
      freshProposal,
    );

    const built = await getSquadsMultisigClient().buildExecuteTransaction(ctx.connection, {
      walletAddress: action.walletAddress,
      multisigAddress,
      transactionIndex,
      proposalAddress,
    });
    const summary = `Execute Squads proposal #${transactionIndex}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);

    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        multisigAddress: built.multisigAddress,
        proposalAddress: built.proposalAddress,
        transactionIndex: built.transactionIndex,
        transactionAddress: built.transactionAddress,
        instructionPreview: built.instructionPreview,
      },
    };
  },
};

function formatVoteSummary(operation: SquadsVoteOperation, proposal: SquadsProposalSnapshot): string {
  const action = operation === 'approve' ? 'Approve' : operation === 'reject' ? 'Reject' : 'Cancel';
  return `${action} Squads proposal #${proposal.transactionIndex} (${proposal.approvalCount}/${proposal.threshold})`;
}

function assertOriginalWallet(action: PreparedAction, walletAddress: string): void {
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Squads action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
}
