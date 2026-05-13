import {
  SQUADS_ADAPTER_ID,
  SQUADS_APPROVAL_LIMITS,
  SQUADS_DESCRIPTION,
  SQUADS_NAME,
  SQUADS_PROGRAM_ID,
  SQUADS_SUPPORTED_CLUSTERS,
  SQUADS_WEBSITE,
  type SquadsProposalStatus,
} from './constants.js';
import {
  getWalletAuthority,
  getMultisigSnapshot,
  resolveMemberPermissions,
  roleFromPermissions,
  summarizeMultisig,
} from './multisigs.js';
import {
  getProposalSnapshot,
  listProposals,
} from './proposals.js';
import {
  getVaultSnapshot,
} from './vaults.js';
import {
  squadsCreateTransferProposalAction,
  squadsExecuteProposalAction,
  squadsVoteAction,
  type SquadsCreateTransferProposalInput,
  type SquadsExecuteProposalInput,
  type SquadsVoteInput,
} from './actions.js';
import type { AdapterRead, DAppAdapter } from '../types.js';

const walletAuthorityRead: AdapterRead<
  { walletAddress?: string; includeProposals?: boolean },
  unknown
> = {
  id: 'wallet_authority',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const authority = await getWalletAuthority(ctx.connection, walletAddress, {
      ...(input.includeProposals !== undefined && { includeProposals: input.includeProposals }),
    });
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      authority,
      facts: {
        multisigCount: authority.multisigs.length,
        roles: authority.multisigs.map((entry) => ({
          multisigAddress: entry.multisigAddress,
          role: entry.role,
          threshold: entry.threshold,
          memberCount: entry.memberCount,
        })),
      },
    };
  },
};

const multisigSnapshotRead: AdapterRead<
  {
    multisigAddress: string;
    includeMembers?: boolean;
    includeVaults?: boolean;
    includeProposals?: boolean;
  },
  unknown
> = {
  id: 'multisig_snapshot',
  async read(input, ctx) {
    const walletAddress = await ctx.backend.getAddress();
    const snapshot = await getMultisigSnapshot(ctx.connection, input.multisigAddress, {
      includeMembers: input.includeMembers ?? true,
      includeVaults: input.includeVaults ?? true,
      includeProposals: input.includeProposals ?? false,
    });
    const permissions = resolveMemberPermissions(snapshot, walletAddress);
    return {
      cluster: ctx.config.cluster,
      walletAddress,
      snapshot,
      summary: summarizeMultisig(snapshot, walletAddress),
      walletRole: roleFromPermissions(permissions),
      facts: {
        multisigAddress: snapshot.multisigAddress,
        threshold: snapshot.threshold,
        memberCount: snapshot.members.length,
        timeLockSec: snapshot.timeLockSec,
        vaultCount: snapshot.vaultCount,
        configAuthority: snapshot.configAuthority,
        transactionIndex: snapshot.transactionIndex,
      },
    };
  },
};

const vaultSnapshotRead: AdapterRead<
  {
    multisigAddress: string;
    vaultIndex?: number;
    vaultAddress?: string;
    includeBalances?: boolean;
  },
  unknown
> = {
  id: 'vault_snapshot',
  async read(input, ctx) {
    const snapshot = await getVaultSnapshot(ctx.connection, input.multisigAddress, {
      ...(input.vaultIndex !== undefined && { vaultIndex: input.vaultIndex }),
      ...(input.vaultAddress !== undefined && { vaultAddress: input.vaultAddress }),
      includeBalances: input.includeBalances ?? true,
    });
    return {
      cluster: ctx.config.cluster,
      snapshot,
      facts: {
        multisigAddress: snapshot.multisigAddress,
        vaultIndex: snapshot.vaultIndex,
        vaultAddress: snapshot.vaultAddress,
        lamports: snapshot.lamports,
        solUi: snapshot.solUi,
        tokenAccounts: snapshot.tokenAccounts.map((entry) => ({
          mint: entry.mint,
          symbol: entry.symbol ?? null,
          decimals: entry.decimals,
          amountUi: entry.amountUi,
        })),
      },
    };
  },
};

const proposalSnapshotRead: AdapterRead<
  {
    multisigAddress: string;
    proposalAddress?: string;
    transactionIndex?: number;
    includeInstructions?: boolean;
  },
  unknown
> = {
  id: 'proposal_snapshot',
  async read(input, ctx) {
    const snapshot = await getProposalSnapshot(ctx.connection, input.multisigAddress, {
      ...(input.proposalAddress !== undefined && { proposalAddress: input.proposalAddress }),
      ...(input.transactionIndex !== undefined && { transactionIndex: input.transactionIndex }),
      includeInstructions: input.includeInstructions ?? true,
    });
    return {
      cluster: ctx.config.cluster,
      snapshot,
      facts: {
        proposalAddress: snapshot.proposalAddress,
        transactionIndex: snapshot.transactionIndex,
        status: snapshot.status,
        approvalCount: snapshot.approvalCount,
        rejectionCount: snapshot.rejectionCount,
        threshold: snapshot.threshold,
        approvalsRequired: snapshot.approvalsRequired,
        ...(snapshot.lockoutExpiresAt !== undefined && { lockoutExpiresAt: snapshot.lockoutExpiresAt }),
        ...(snapshot.executableAt !== undefined && { executableAt: snapshot.executableAt }),
        instructionCount: snapshot.instructionCount,
        unknownInstructions: snapshot.instructionPreview.filter((entry) => entry.kind === 'unknown').length,
        warnings: snapshot.warnings,
      },
    };
  },
};

const proposalListRead: AdapterRead<
  { multisigAddress: string; status?: SquadsProposalStatus | 'all'; limit?: number },
  unknown
> = {
  id: 'proposal_list',
  async read(input, ctx) {
    const items = await listProposals(ctx.connection, input.multisigAddress, {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.limit !== undefined && { limit: input.limit }),
    });
    return {
      cluster: ctx.config.cluster,
      multisigAddress: input.multisigAddress,
      items,
      facts: {
        total: items.length,
        active: items.filter((entry) => entry.status === 'active').length,
        approved: items.filter((entry) => entry.status === 'approved').length,
        rejected: items.filter((entry) => entry.status === 'rejected').length,
        executed: items.filter((entry) => entry.status === 'executed').length,
        cancelled: items.filter((entry) => entry.status === 'cancelled').length,
      },
    };
  },
};

export const squadsAdapter: DAppAdapter = {
  id: SQUADS_ADAPTER_ID,
  name: SQUADS_NAME,
  website: SQUADS_WEBSITE,
  description: SQUADS_DESCRIPTION,
  supportedClusters: SQUADS_SUPPORTED_CLUSTERS,
  programIds: [SQUADS_PROGRAM_ID],
  actions: {
    create_transfer_proposal: squadsCreateTransferProposalAction,
    approve_proposal: squadsVoteAction('approve'),
    reject_proposal: squadsVoteAction('reject'),
    cancel_proposal: squadsVoteAction('cancel'),
    execute_proposal: squadsExecuteProposalAction,
  },
  reads: {
    wallet_authority: walletAuthorityRead,
    multisig_snapshot: multisigSnapshotRead,
    vault_snapshot: vaultSnapshotRead,
    proposal_snapshot: proposalSnapshotRead,
    proposal_list: proposalListRead,
  },
};

export type {
  SquadsCreateTransferProposalInput,
  SquadsExecuteProposalInput,
  SquadsVoteInput,
};
export {
  SQUADS_ADAPTER_ID,
  SQUADS_APPROVAL_LIMITS,
  SQUADS_DESCRIPTION,
  SQUADS_NAME,
  SQUADS_PROGRAM_ID,
  SQUADS_SUPPORTED_CLUSTERS,
  SQUADS_WEBSITE,
};
