import type { Connection } from '@solana/web3.js';

import type { DriftWithdrawUnit } from './constants.js';

export interface DriftUserDeposit {
  marketIndex: number;
  mint: string;
  symbol?: string;
  amount: string;
}

export interface DriftUserBorrow {
  marketIndex: number;
  mint: string;
  symbol?: string;
  amount: string;
}

export interface DriftUserSnapshot {
  walletAddress: string;
  subAccountId: number;
  userAccountAddress?: string;
  deposits: DriftUserDeposit[];
  borrows: DriftUserBorrow[];
  totalCollateral: string;
  freeCollateral: string;
  marginRatio: number;
  healthPercent?: number;
  asOfSlot: number;
}

export interface DriftVaultSnapshot {
  vaultAddress: string;
  name: string;
  manager: string;
  programId: string;
  depositMint: string;
  depositSymbol?: string;
  decimals: number;
  totalShares: string;
  totalValue: string;
  sharePrice: string;
  redeemPeriodSec: number;
  lockupSec: number;
  profitShareBps: number;
  managementFeeBps: number;
  hurdleRateBps?: number;
  minDepositAmount?: string;
  pendingWithdrawShares: string;
  asOfSlot: number;
}

export interface DriftVaultDepositor {
  vaultAddress: string;
  walletAddress: string;
  depositorAddress: string;
  shares: string;
  valueAtSharePrice: string;
  pendingWithdrawShares: string;
  pendingWithdrawRequestedAt?: number;
  redeemableAt?: number;
  asOfSlot: number;
}

export interface DriftWithdrawStatus {
  vaultAddress: string;
  walletAddress: string;
  hasPendingRequest: boolean;
  requestedShares: string;
  requestedValue?: string;
  requestedAt?: number;
  redeemableAt?: number;
  isReady: boolean;
  redeemPeriodSec: number;
  lockupSec: number;
  asOfSlot: number;
}

export interface DriftBuildVaultDepositInput {
  walletAddress: string;
  vaultAddress: string;
  amountRaw: bigint;
  initializeDepositorIfMissing?: boolean;
}

export interface DriftBuildVaultDepositResult {
  transactionBase64: string;
  vaultAddress: string;
  vaultName?: string;
  depositMint: string;
  depositSymbol?: string;
  decimals: number;
  amountUi: string;
  initializedDepositor: boolean;
  summarySnapshot: DriftVaultSnapshot;
}

export interface DriftBuildVaultRequestWithdrawInput {
  walletAddress: string;
  vaultAddress: string;
  withdrawUnit: DriftWithdrawUnit;
  amountRaw?: bigint;
  sharesRaw?: bigint;
}

export interface DriftBuildVaultRequestWithdrawResult {
  transactionBase64: string;
  vaultAddress: string;
  vaultName?: string;
  depositMint: string;
  depositSymbol?: string;
  decimals: number;
  amountUi?: string;
  sharesUi?: string;
  redeemableAt?: number;
  summarySnapshot: DriftVaultSnapshot;
}

export interface DriftBuildVaultCancelWithdrawInput {
  walletAddress: string;
  vaultAddress: string;
}

export interface DriftBuildVaultCancelWithdrawResult {
  transactionBase64: string;
  vaultAddress: string;
  vaultName?: string;
  cancelledShares?: string;
  summarySnapshot: DriftVaultSnapshot;
}

export interface DriftBuildVaultCompleteWithdrawInput {
  walletAddress: string;
  vaultAddress: string;
}

export interface DriftBuildVaultCompleteWithdrawResult {
  transactionBase64: string;
  vaultAddress: string;
  vaultName?: string;
  redeemedShares?: string;
  redeemedAmountUi?: string;
  summarySnapshot: DriftVaultSnapshot;
}

export interface DriftVaultClient {
  getUserSnapshot(
    connection: Connection,
    walletAddress: string,
    subAccountId?: number,
  ): Promise<DriftUserSnapshot>;
  getVaultSnapshot(connection: Connection, vaultAddress: string): Promise<DriftVaultSnapshot>;
  getWalletVaultPositions(
    connection: Connection,
    walletAddress: string,
    vaultAddress?: string,
  ): Promise<DriftVaultDepositor[]>;
  getWithdrawStatus(
    connection: Connection,
    walletAddress: string,
    vaultAddress: string,
  ): Promise<DriftWithdrawStatus>;
  buildVaultDepositTransaction(
    connection: Connection,
    input: DriftBuildVaultDepositInput,
  ): Promise<DriftBuildVaultDepositResult>;
  buildVaultRequestWithdrawTransaction(
    connection: Connection,
    input: DriftBuildVaultRequestWithdrawInput,
  ): Promise<DriftBuildVaultRequestWithdrawResult>;
  buildVaultCancelWithdrawTransaction(
    connection: Connection,
    input: DriftBuildVaultCancelWithdrawInput,
  ): Promise<DriftBuildVaultCancelWithdrawResult>;
  buildVaultCompleteWithdrawTransaction(
    connection: Connection,
    input: DriftBuildVaultCompleteWithdrawInput,
  ): Promise<DriftBuildVaultCompleteWithdrawResult>;
}

// The official @drift-labs/sdk and @drift-labs/vaults-sdk are runtime dependencies added by the
// integrator. We expose a factory hook so:
//   * In production: install both SDKs, then call setDriftVaultClientFactory() once from boot
//     to inject a real client backed by the SDKs.
//   * In tests: setDriftVaultClientFactory() injects a mock client.
//   * By default: the unavailable client returns a clear error if a Drift tool is invoked
//     before configuration. Other tools and the framework itself keep working.

const UNAVAILABLE_REASON =
  '@drift-labs/sdk and @drift-labs/vaults-sdk are not wired. Install both SDKs and call setDriftVaultClientFactory(buildDriftVaultClient) at boot, or inject a mock for tests.';

class DriftVaultsSdkUnavailable implements DriftVaultClient {
  readonly reason = UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new Error(`Drift adapter is not configured (${method}): ${this.reason}`);
  }

  async getUserSnapshot(): Promise<DriftUserSnapshot> {
    this.fail('getUserSnapshot');
  }

  async getVaultSnapshot(): Promise<DriftVaultSnapshot> {
    this.fail('getVaultSnapshot');
  }

  async getWalletVaultPositions(): Promise<DriftVaultDepositor[]> {
    this.fail('getWalletVaultPositions');
  }

  async getWithdrawStatus(): Promise<DriftWithdrawStatus> {
    this.fail('getWithdrawStatus');
  }

  async buildVaultDepositTransaction(): Promise<DriftBuildVaultDepositResult> {
    this.fail('buildVaultDepositTransaction');
  }

  async buildVaultRequestWithdrawTransaction(): Promise<DriftBuildVaultRequestWithdrawResult> {
    this.fail('buildVaultRequestWithdrawTransaction');
  }

  async buildVaultCancelWithdrawTransaction(): Promise<DriftBuildVaultCancelWithdrawResult> {
    this.fail('buildVaultCancelWithdrawTransaction');
  }

  async buildVaultCompleteWithdrawTransaction(): Promise<DriftBuildVaultCompleteWithdrawResult> {
    this.fail('buildVaultCompleteWithdrawTransaction');
  }
}

let factory: () => DriftVaultClient = () => new DriftVaultsSdkUnavailable();
let cached: DriftVaultClient | undefined;

export function setDriftVaultClientFactory(next: () => DriftVaultClient): void {
  factory = next;
  cached = undefined;
}

export function resetDriftVaultClientFactory(): void {
  factory = () => new DriftVaultsSdkUnavailable();
  cached = undefined;
}

export function getDriftVaultClient(): DriftVaultClient {
  if (!cached) cached = factory();
  return cached;
}

export function isDriftVaultConfigured(): boolean {
  return !(getDriftVaultClient() instanceof DriftVaultsSdkUnavailable);
}

export function describeDriftUnavailableReason(): string | undefined {
  const client = getDriftVaultClient();
  return client instanceof DriftVaultsSdkUnavailable ? client.reason : undefined;
}
