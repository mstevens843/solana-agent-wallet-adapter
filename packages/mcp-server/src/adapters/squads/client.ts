import type { Connection } from '@solana/web3.js';

import type {
  SquadsInstructionKind,
  SquadsInstructionRiskTier,
  SquadsProposalStatus,
  SquadsVoteOperation,
} from './constants.js';

export interface SquadsMemberSnapshot {
  publicKey: string;
  canInitiate: boolean;
  canVote: boolean;
  canExecute: boolean;
}

export interface SquadsMultisigSnapshot {
  multisigAddress: string;
  createKey: string;
  configAuthority: string;
  rentCollector?: string;
  threshold: number;
  timeLockSec: number;
  transactionIndex: number;
  staleTransactionIndex: number;
  members: SquadsMemberSnapshot[];
  vaultCount: number;
  asOfSlot: number;
}

export interface SquadsVaultTokenAccount {
  mint: string;
  symbol?: string;
  decimals: number;
  amountRaw: string;
  amountUi: string;
  tokenAccountAddress: string;
}

export interface SquadsVaultSnapshot {
  multisigAddress: string;
  vaultIndex: number;
  vaultAddress: string;
  lamports: string;
  solUi: string;
  tokenAccounts: SquadsVaultTokenAccount[];
  asOfSlot: number;
}

export interface SquadsInstructionPreview {
  index: number;
  kind: SquadsInstructionKind;
  programId: string;
  riskTier: SquadsInstructionRiskTier;
  summary: string;
  detail?: Record<string, unknown>;
  warning?: string;
}

export interface SquadsProposalSnapshot {
  multisigAddress: string;
  transactionIndex: number;
  proposalAddress: string;
  transactionAddress: string;
  status: SquadsProposalStatus;
  approvals: string[];
  rejections: string[];
  cancellations: string[];
  approvalCount: number;
  rejectionCount: number;
  threshold: number;
  approvalsRequired: number;
  approvedAt?: number;
  rejectedAt?: number;
  cancelledAt?: number;
  executedAt?: number;
  staleAtIndex: number;
  timeLockSec: number;
  lockoutExpiresAt?: number;
  executableAt?: number;
  instructionCount: number;
  instructionPreview: SquadsInstructionPreview[];
  warnings: string[];
  asOfSlot: number;
}

export interface SquadsProposalListEntry {
  transactionIndex: number;
  proposalAddress: string;
  status: SquadsProposalStatus;
  approvalCount: number;
  rejectionCount: number;
  threshold: number;
  createdAt?: number;
}

export type SquadsWalletRole = 'none' | 'proposer' | 'voter' | 'executor' | 'voter_executor' | 'all';

export interface SquadsWalletAuthorityMembership {
  multisigAddress: string;
  role: SquadsWalletRole;
  threshold: number;
  memberCount: number;
  activeProposalCount?: number;
}

export interface SquadsWalletAuthority {
  walletAddress: string;
  multisigs: SquadsWalletAuthorityMembership[];
}

export interface SquadsBuildCreateTransferProposalInput {
  walletAddress: string;
  multisigAddress: string;
  vaultIndex: number;
  recipient: string;
  /** null for native SOL transfer. */
  mintAddress: string | null;
  amountRaw: bigint;
  decimals: number;
  memo?: string;
  title: string;
  description?: string;
  /** Transaction index the new proposal will occupy; supplied by the adapter so the prepared params can be re-verified at execute time. */
  transactionIndex: number;
}

export interface SquadsBuildCreateTransferProposalResult {
  transactionBase64: string;
  multisigAddress: string;
  vaultIndex: number;
  vaultAddress: string;
  recipient: string;
  mintAddress: string | null;
  amountRaw: string;
  amountUi: string;
  decimals: number;
  transactionIndex: number;
  proposalAddress: string;
  transactionAddress: string;
  instructionPreview: SquadsInstructionPreview[];
}

export interface SquadsBuildVoteInput {
  walletAddress: string;
  multisigAddress: string;
  transactionIndex: number;
  proposalAddress: string;
  operation: SquadsVoteOperation;
  reason?: string;
}

export interface SquadsBuildVoteResult {
  transactionBase64: string;
  multisigAddress: string;
  transactionIndex: number;
  proposalAddress: string;
  operation: SquadsVoteOperation;
}

export interface SquadsBuildExecuteInput {
  walletAddress: string;
  multisigAddress: string;
  transactionIndex: number;
  proposalAddress: string;
}

export interface SquadsBuildExecuteResult {
  transactionBase64: string;
  multisigAddress: string;
  transactionIndex: number;
  proposalAddress: string;
  transactionAddress: string;
  instructionPreview: SquadsInstructionPreview[];
}

export interface SquadsMultisigClient {
  getWalletAuthority(
    connection: Connection,
    walletAddress: string,
    opts?: { includeProposals?: boolean },
  ): Promise<SquadsWalletAuthority>;
  getMultisigSnapshot(
    connection: Connection,
    multisigAddress: string,
    opts?: { includeMembers?: boolean; includeVaults?: boolean; includeProposals?: boolean },
  ): Promise<SquadsMultisigSnapshot>;
  getVaultSnapshot(
    connection: Connection,
    multisigAddress: string,
    opts: { vaultIndex?: number; vaultAddress?: string; includeBalances?: boolean },
  ): Promise<SquadsVaultSnapshot>;
  getProposalSnapshot(
    connection: Connection,
    multisigAddress: string,
    opts: { proposalAddress?: string; transactionIndex?: number; includeInstructions?: boolean },
  ): Promise<SquadsProposalSnapshot>;
  listProposals(
    connection: Connection,
    multisigAddress: string,
    opts: { status?: SquadsProposalStatus | 'all'; limit?: number },
  ): Promise<SquadsProposalListEntry[]>;
  buildCreateTransferProposalTransaction(
    connection: Connection,
    input: SquadsBuildCreateTransferProposalInput,
  ): Promise<SquadsBuildCreateTransferProposalResult>;
  buildVoteTransaction(
    connection: Connection,
    input: SquadsBuildVoteInput,
  ): Promise<SquadsBuildVoteResult>;
  buildExecuteTransaction(
    connection: Connection,
    input: SquadsBuildExecuteInput,
  ): Promise<SquadsBuildExecuteResult>;
}

// The official @sqds/multisig SDK is a runtime dependency added by the integrator. We expose a
// factory hook so:
//   * In production: install @sqds/multisig, then call setSquadsMultisigClientFactory() once at
//     boot to inject a real client backed by the SDK. The wiring code MUST assert that
//     multisig.PROGRAM_ID matches SQUADS_PROGRAM_ID before returning the client.
//   * In tests: setSquadsMultisigClientFactory() injects a mock client.
//   * By default: the unavailable client returns a clear error if a Squads tool is invoked
//     before configuration. Other tools and the framework itself keep working.

const UNAVAILABLE_REASON =
  '@sqds/multisig is not wired. Install the SDK and call setSquadsMultisigClientFactory(buildSquadsClient) at boot, or inject a mock for tests.';

class SquadsMultisigSdkUnavailable implements SquadsMultisigClient {
  readonly reason = UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new Error(`Squads adapter is not configured (${method}): ${this.reason}`);
  }

  async getWalletAuthority(): Promise<SquadsWalletAuthority> {
    this.fail('getWalletAuthority');
  }

  async getMultisigSnapshot(): Promise<SquadsMultisigSnapshot> {
    this.fail('getMultisigSnapshot');
  }

  async getVaultSnapshot(): Promise<SquadsVaultSnapshot> {
    this.fail('getVaultSnapshot');
  }

  async getProposalSnapshot(): Promise<SquadsProposalSnapshot> {
    this.fail('getProposalSnapshot');
  }

  async listProposals(): Promise<SquadsProposalListEntry[]> {
    this.fail('listProposals');
  }

  async buildCreateTransferProposalTransaction(): Promise<SquadsBuildCreateTransferProposalResult> {
    this.fail('buildCreateTransferProposalTransaction');
  }

  async buildVoteTransaction(): Promise<SquadsBuildVoteResult> {
    this.fail('buildVoteTransaction');
  }

  async buildExecuteTransaction(): Promise<SquadsBuildExecuteResult> {
    this.fail('buildExecuteTransaction');
  }
}

let factory: () => SquadsMultisigClient = () => new SquadsMultisigSdkUnavailable();
let cached: SquadsMultisigClient | undefined;

export function setSquadsMultisigClientFactory(next: () => SquadsMultisigClient): void {
  factory = next;
  cached = undefined;
}

export function resetSquadsMultisigClientFactory(): void {
  factory = () => new SquadsMultisigSdkUnavailable();
  cached = undefined;
}

export function getSquadsMultisigClient(): SquadsMultisigClient {
  if (!cached) cached = factory();
  return cached;
}

export function isSquadsMultisigConfigured(): boolean {
  return !(getSquadsMultisigClient() instanceof SquadsMultisigSdkUnavailable);
}

export function describeSquadsUnavailableReason(): string | undefined {
  const client = getSquadsMultisigClient();
  return client instanceof SquadsMultisigSdkUnavailable ? client.reason : undefined;
}
