import type { Connection, Transaction } from '@solana/web3.js';

export interface SaveReserveSnapshot {
  reserveAddress: string;
  reserveMint: string;
  reserveSymbol: string;
  decimals: number;
  marketAddress: string;
  supplyApy: number;
  borrowApy: number;
  utilization: number;
  totalSupply: string;
  totalBorrow: string;
  liquidity: string;
  collateralFactor: number;
  liquidationThreshold: number;
  liquidationBonus: number;
  depositLimit?: string;
  depositLimitRemaining?: string;
  borrowLimit?: string;
  borrowLimitRemaining?: string;
  withdrawAvailable: string;
  priceUsd?: number;
  lastUpdateSlot: number;
  asOfBlockTime?: number;
}

export interface SaveMarketSnapshot {
  marketAddress: string;
  programId: string;
  reserveCount: number;
  totalDeposits: string;
  totalBorrows: string;
  reserves: SaveReserveSnapshot[];
}

export interface SaveObligationDeposit {
  reserveAddress: string;
  reserveMint: string;
  reserveSymbol: string;
  decimals: number;
  amount: string;
  amountRaw: string;
  valueUsd?: number;
  collateralValueUsd?: number;
}

export interface SaveObligationBorrow {
  reserveAddress: string;
  reserveMint: string;
  reserveSymbol: string;
  decimals: number;
  amount: string;
  amountRaw: string;
  valueUsd?: number;
  weightedValueUsd?: number;
}

export interface SaveObligation {
  obligationAddress: string;
  marketAddress: string;
  walletAddress: string;
  deposits: SaveObligationDeposit[];
  borrows: SaveObligationBorrow[];
  totalDepositValueUsd: number;
  totalBorrowValueUsd: number;
  borrowLimitUsd: number;
  liquidationThresholdUsd: number;
  healthFactor: number;
  netApy?: number;
  asOfSlot: number;
}

export interface SaveBuildInput {
  walletAddress: string;
  marketAddress?: string;
  reserveMint: string;
  amountRaw: bigint;
  depositCollateral?: boolean;
  withdrawAll?: boolean;
  repayAll?: boolean;
}

export interface SaveBuildResult {
  transaction: Transaction;
  reserveAddress: string;
  reserveSymbol: string;
  decimals: number;
  amountUi: string;
  reserveSnapshot: SaveReserveSnapshot;
}

export interface SaveClient {
  getMarketSnapshot(connection: Connection, marketAddress?: string): Promise<SaveMarketSnapshot>;
  getReserveSnapshot(
    connection: Connection,
    reserveMint: string,
    marketAddress?: string,
  ): Promise<SaveReserveSnapshot>;
  listReserveSnapshots(connection: Connection, marketAddress?: string): Promise<SaveReserveSnapshot[]>;
  getObligation(
    connection: Connection,
    walletAddress: string,
    marketAddress?: string,
  ): Promise<SaveObligation | null>;
  buildDepositTransaction(connection: Connection, input: SaveBuildInput): Promise<SaveBuildResult>;
  buildWithdrawTransaction(connection: Connection, input: SaveBuildInput): Promise<SaveBuildResult>;
  buildBorrowTransaction(connection: Connection, input: SaveBuildInput): Promise<SaveBuildResult>;
  buildRepayTransaction(connection: Connection, input: SaveBuildInput): Promise<SaveBuildResult>;
}

// The official @solendprotocol/solend-sdk is a runtime dependency added by the
// integrator. We expose a factory hook so:
//   * In production: install solend-sdk, then call setSaveClientFactory()
//     once from boot to inject a real client backed by the SDK.
//   * In tests: setSaveClientFactory() injects a mock client.
//   * By default: the unavailable client returns a clear error if a Save tool
//     is invoked before configuration. Other tools and the framework itself
//     keep working.

const UNAVAILABLE_REASON =
  '@solendprotocol/solend-sdk is not wired. Install the SDK and call setSaveClientFactory(buildSaveClient) at boot, or inject a mock for tests.';

class SolendSdkUnavailable implements SaveClient {
  readonly reason = UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new Error(`Save adapter is not configured (${method}): ${this.reason}`);
  }

  async getMarketSnapshot(): Promise<SaveMarketSnapshot> {
    this.fail('getMarketSnapshot');
  }

  async getReserveSnapshot(): Promise<SaveReserveSnapshot> {
    this.fail('getReserveSnapshot');
  }

  async listReserveSnapshots(): Promise<SaveReserveSnapshot[]> {
    this.fail('listReserveSnapshots');
  }

  async getObligation(): Promise<SaveObligation | null> {
    this.fail('getObligation');
  }

  async buildDepositTransaction(): Promise<SaveBuildResult> {
    this.fail('buildDepositTransaction');
  }

  async buildWithdrawTransaction(): Promise<SaveBuildResult> {
    this.fail('buildWithdrawTransaction');
  }

  async buildBorrowTransaction(): Promise<SaveBuildResult> {
    this.fail('buildBorrowTransaction');
  }

  async buildRepayTransaction(): Promise<SaveBuildResult> {
    this.fail('buildRepayTransaction');
  }
}

let factory: () => SaveClient = () => new SolendSdkUnavailable();
let cached: SaveClient | undefined;

export function setSaveClientFactory(next: () => SaveClient): void {
  factory = next;
  cached = undefined;
}

export function resetSaveClientFactory(): void {
  factory = () => new SolendSdkUnavailable();
  cached = undefined;
}

export function getSaveClient(): SaveClient {
  if (!cached) cached = factory();
  return cached;
}

export function isSaveConfigured(): boolean {
  return !(getSaveClient() instanceof SolendSdkUnavailable);
}

export function describeSolendUnavailableReason(): string | undefined {
  const client = getSaveClient();
  return client instanceof SolendSdkUnavailable ? client.reason : undefined;
}
