import type { Connection } from '@solana/web3.js';

import type {
  ProposalListStateFilter,
  ProposalStateName,
  ProposalVoteType,
  VoteKind,
} from './constants.js';

export interface RealmGovernanceListEntry {
  governanceAddress: string;
  governedAccount: string;
  proposalCount: number;
}

export interface RealmSnapshot {
  realmAddress: string;
  realmConfigAddress: string;
  name: string;
  authority?: string;
  communityMint: string;
  communityMintDecimals: number;
  councilMint?: string;
  councilMintDecimals?: number;
  governances: RealmGovernanceListEntry[];
  pluginsDetected: boolean;
  pluginNames: string[];
  asOfSlot: number;
}

export interface RealmSnapshotOptions {
  includeGovernances?: boolean;
  includeTokenMints?: boolean;
}

export interface GovernanceProposalListEntry {
  proposalAddress: string;
  name: string;
  state: ProposalStateName;
  votingAt?: number;
  votingCompletedAt?: number;
}

export interface GovernanceSnapshot {
  governanceAddress: string;
  realmAddress: string;
  governedAccount: string;
  voteThresholdType: string;
  voteThresholdPct?: number;
  votingBaseSec: number;
  votingCoolOffSec: number;
  minCommunityWeight?: string;
  minCouncilWeight?: string;
  proposals: GovernanceProposalListEntry[];
  asOfSlot: number;
}

export interface GovernanceSnapshotOptions {
  includeConfig?: boolean;
  includeProposals?: boolean;
}

export interface ProposalListInput {
  realmAddress: string;
  governanceAddress?: string;
  state: ProposalListStateFilter;
  limit: number;
}

export interface ProposalListEntry {
  proposalAddress: string;
  governanceAddress: string;
  realmAddress: string;
  name: string;
  state: ProposalStateName;
  governingTokenMint: string;
  votingAt?: number;
  votingCompletedAt?: number;
  voteType: ProposalVoteType;
}

export interface ProposalChoice {
  index: number;
  label: string;
  weight: string;
  tipped: boolean;
}

export interface ProposalVoteTally {
  yes: string;
  no: string;
  abstain: string;
  veto: string;
}

export interface ProposalInstructionRaw {
  index: number;
  programId: string;
  data: string;
  accounts: string[];
}

export interface ProposalInstructionDecoded {
  index: number;
  programId: string;
  decoded: boolean;
  kind?: string;
  details?: Record<string, unknown>;
  hint?: string;
}

export interface ProposalSnapshot {
  proposalAddress: string;
  realmAddress: string;
  governanceAddress: string;
  governingTokenMint: string;
  name: string;
  description?: string;
  state: ProposalStateName;
  voteType: ProposalVoteType;
  choices: ProposalChoice[];
  voteTally: ProposalVoteTally;
  draftAt?: number;
  signingOffAt?: number;
  votingAt?: number;
  votingExpiresAt?: number;
  votingCompletedAt?: number;
  coolOffEndsAt?: number;
  inCoolOff: boolean;
  rawInstructions: ProposalInstructionRaw[];
  pluginsDetected: boolean;
  pluginNames: string[];
  asOfSlot: number;
}

export interface ProposalSnapshotOptions {
  includeInstructions?: boolean;
  includeVoteBreakdown?: boolean;
}

export interface VoteRecordSnapshot {
  recordAddress: string;
  proposalAddress: string;
  walletAddress: string;
  governingTokenMint: string;
  voteKind: VoteKind;
  weight: string;
  choiceIndex?: number;
  isRelinquished: boolean;
  asOfSlot: number;
}

export interface WalletGovernanceTokenOwnerRecord {
  recordAddress: string;
  governingTokenDepositAmount: string;
  outstandingProposalCount: number;
  unrelinquishedVotesCount: number;
  governanceDelegate?: string;
}

export interface WalletGovernanceVotingPower {
  raw: string;
  pluginAffected: boolean;
}

export interface WalletGovernanceSnapshot {
  walletAddress: string;
  realmAddress: string;
  realmName: string;
  governingTokenMint: string;
  mintRole: 'community' | 'council';
  tokenOwnerRecord: WalletGovernanceTokenOwnerRecord;
  votingPower: WalletGovernanceVotingPower;
  pluginsDetected: boolean;
  pluginNames: string[];
  asOfSlot: number;
}

export interface WalletGovernanceOptions {
  realmAddress?: string;
  includeInactive?: boolean;
}

export interface RealmsBuildCastVoteInput {
  walletAddress: string;
  proposalAddress: string;
  governingTokenMint: string;
  voteKind: VoteKind;
  choiceIndex?: number;
}

export interface RealmsBuildCastVoteResult {
  transactionBase64: string;
  proposalAddress: string;
  realmAddress: string;
  governanceAddress: string;
  governingTokenMint: string;
  voteKind: VoteKind;
  choiceIndex?: number;
  proposalName: string;
  postWalletWeight: string;
}

export interface RealmsBuildRelinquishVoteInput {
  walletAddress: string;
  proposalAddress: string;
  governingTokenMint: string;
  beneficiaryAddress?: string;
}

export interface RealmsBuildRelinquishVoteResult {
  transactionBase64: string;
  proposalAddress: string;
  realmAddress: string;
  governanceAddress: string;
  governingTokenMint: string;
  proposalName: string;
  isFinalized: boolean;
}

export interface RealmsBuildDepositInput {
  walletAddress: string;
  realmAddress: string;
  governingTokenMint: string;
  amountRaw: bigint;
}

export interface RealmsBuildDepositResult {
  transactionBase64: string;
  realmAddress: string;
  realmName: string;
  governingTokenMint: string;
  amountRaw: string;
  amountUi: string;
  mintDecimals: number;
}

export interface RealmsBuildWithdrawInput {
  walletAddress: string;
  realmAddress: string;
  governingTokenMint: string;
  amountRaw?: bigint;
  withdrawAll: boolean;
}

export interface RealmsBuildWithdrawResult {
  transactionBase64: string;
  realmAddress: string;
  realmName: string;
  governingTokenMint: string;
  amountRaw: string;
  amountUi: string;
  mintDecimals: number;
  withdrawAll: boolean;
}

export interface RealmsClient {
  getRealmSnapshot(
    connection: Connection,
    realmAddress: string,
    options?: RealmSnapshotOptions,
  ): Promise<RealmSnapshot>;
  getGovernanceSnapshot(
    connection: Connection,
    governanceAddress: string,
    options?: GovernanceSnapshotOptions,
  ): Promise<GovernanceSnapshot>;
  getProposalList(
    connection: Connection,
    input: ProposalListInput,
  ): Promise<ProposalListEntry[]>;
  getProposalSnapshot(
    connection: Connection,
    proposalAddress: string,
    options?: ProposalSnapshotOptions,
  ): Promise<ProposalSnapshot>;
  getVoteRecord(
    connection: Connection,
    proposalAddress: string,
    walletAddress: string,
  ): Promise<VoteRecordSnapshot | null>;
  getWalletGovernance(
    connection: Connection,
    walletAddress: string,
    options?: WalletGovernanceOptions,
  ): Promise<WalletGovernanceSnapshot[]>;
  buildCastVoteTransaction(
    connection: Connection,
    input: RealmsBuildCastVoteInput,
  ): Promise<RealmsBuildCastVoteResult>;
  buildRelinquishVoteTransaction(
    connection: Connection,
    input: RealmsBuildRelinquishVoteInput,
  ): Promise<RealmsBuildRelinquishVoteResult>;
  buildDepositGovernanceTokensTransaction(
    connection: Connection,
    input: RealmsBuildDepositInput,
  ): Promise<RealmsBuildDepositResult>;
  buildWithdrawGovernanceTokensTransaction(
    connection: Connection,
    input: RealmsBuildWithdrawInput,
  ): Promise<RealmsBuildWithdrawResult>;
}

// The official @solana/spl-governance package is a runtime dependency that the
// integrator wires through setRealmsClientFactory(). The default factory below
// returns an "unavailable" client whose every method throws a clear, structured
// error, so the rest of the MCP server keeps working when Realms isn't enabled.

const UNAVAILABLE_REASON =
  '@solana/spl-governance is not wired. Install the package and call setRealmsClientFactory(buildRealmsClient) at boot, or inject a mock for tests.';

class RealmsSdkUnavailable implements RealmsClient {
  readonly reason = UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new Error(`Realms adapter is not configured (${method}): ${this.reason}`);
  }

  async getRealmSnapshot(): Promise<RealmSnapshot> {
    this.fail('getRealmSnapshot');
  }

  async getGovernanceSnapshot(): Promise<GovernanceSnapshot> {
    this.fail('getGovernanceSnapshot');
  }

  async getProposalList(): Promise<ProposalListEntry[]> {
    this.fail('getProposalList');
  }

  async getProposalSnapshot(): Promise<ProposalSnapshot> {
    this.fail('getProposalSnapshot');
  }

  async getVoteRecord(): Promise<VoteRecordSnapshot | null> {
    this.fail('getVoteRecord');
  }

  async getWalletGovernance(): Promise<WalletGovernanceSnapshot[]> {
    this.fail('getWalletGovernance');
  }

  async buildCastVoteTransaction(): Promise<RealmsBuildCastVoteResult> {
    this.fail('buildCastVoteTransaction');
  }

  async buildRelinquishVoteTransaction(): Promise<RealmsBuildRelinquishVoteResult> {
    this.fail('buildRelinquishVoteTransaction');
  }

  async buildDepositGovernanceTokensTransaction(): Promise<RealmsBuildDepositResult> {
    this.fail('buildDepositGovernanceTokensTransaction');
  }

  async buildWithdrawGovernanceTokensTransaction(): Promise<RealmsBuildWithdrawResult> {
    this.fail('buildWithdrawGovernanceTokensTransaction');
  }
}

let factory: () => RealmsClient = () => new RealmsSdkUnavailable();
let cached: RealmsClient | undefined;

export function setRealmsClientFactory(next: () => RealmsClient): void {
  factory = next;
  cached = undefined;
}

export function resetRealmsClientFactory(): void {
  factory = () => new RealmsSdkUnavailable();
  cached = undefined;
}

export function getRealmsClient(): RealmsClient {
  if (!cached) cached = factory();
  return cached;
}

export function isRealmsConfigured(): boolean {
  return !(getRealmsClient() instanceof RealmsSdkUnavailable);
}

export function describeRealmsUnavailableReason(): string | undefined {
  const client = getRealmsClient();
  return client instanceof RealmsSdkUnavailable ? client.reason : undefined;
}
