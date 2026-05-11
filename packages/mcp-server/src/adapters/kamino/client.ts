import type { Connection, Transaction } from '@solana/web3.js';

export interface KaminoReserveSnapshot {
  reserveAddress: string;
  reserveMint: string;
  reserveSymbol: string;
  decimals: number;
  supplyApy: number;
  borrowApy: number;
  utilization: number;
  totalSupply: string;
  totalBorrow: string;
  depositLimit?: string;
  depositLimitRemaining?: string;
  withdrawalDelaySec: number;
  withdrawAvailable: string;
  lastUpdateSlot: number;
  asOfBlockTime?: number;
}

export interface KaminoPosition {
  reserveAddress: string;
  reserveMint: string;
  reserveSymbol: string;
  decimals: number;
  suppliedAmount: string;
  currentValue: string;
  earnedInterest: string;
  supplyApy: number;
  withdrawAvailable: string;
  asOfSlot: number;
}

export interface KaminoBuildDepositInput {
  walletAddress: string;
  reserveMint: string;
  amountRaw: bigint;
}

export interface KaminoBuildDepositResult {
  transaction: Transaction;
  reserveAddress: string;
  reserveSymbol: string;
  decimals: number;
  amountUi: string;
  reserveSnapshot: KaminoReserveSnapshot;
}

export interface KaminoBuildWithdrawInput {
  walletAddress: string;
  reserveMint: string;
  amountRaw: bigint;
  withdrawAll?: boolean;
}

export interface KaminoBuildWithdrawResult {
  transaction: Transaction;
  reserveAddress: string;
  reserveSymbol: string;
  decimals: number;
  amountUi: string;
  reserveSnapshot: KaminoReserveSnapshot;
}

export interface KaminoClient {
  getReserveSnapshot(connection: Connection, reserveMint: string): Promise<KaminoReserveSnapshot>;
  listReserveSnapshots(connection: Connection): Promise<KaminoReserveSnapshot[]>;
  getPositions(connection: Connection, walletAddress: string): Promise<KaminoPosition[]>;
  buildDepositTransaction(
    connection: Connection,
    input: KaminoBuildDepositInput,
  ): Promise<KaminoBuildDepositResult>;
  buildWithdrawTransaction(
    connection: Connection,
    input: KaminoBuildWithdrawInput,
  ): Promise<KaminoBuildWithdrawResult>;
}

// The official @kamino-finance/klend-sdk is a runtime dependency added by the
// integrator. We expose a factory hook so:
//   * In production: install klend-sdk, then call setKaminoClientFactory()
//     once from boot to inject a real client backed by the SDK.
//   * In tests: setKaminoClientFactory() injects a mock client.
//   * By default: the unavailable client returns a clear error if a Kamino
//     tool is invoked before configuration. Other tools and the framework
//     itself keep working.

const UNAVAILABLE_REASON =
  '@kamino-finance/klend-sdk is not wired. Install the SDK and call setKaminoClientFactory(buildKaminoClient) at boot, or inject a mock for tests.';

class KlendSdkUnavailable implements KaminoClient {
  readonly reason = UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new Error(`Kamino adapter is not configured (${method}): ${this.reason}`);
  }

  async getReserveSnapshot(): Promise<KaminoReserveSnapshot> {
    this.fail('getReserveSnapshot');
  }

  async listReserveSnapshots(): Promise<KaminoReserveSnapshot[]> {
    this.fail('listReserveSnapshots');
  }

  async getPositions(): Promise<KaminoPosition[]> {
    this.fail('getPositions');
  }

  async buildDepositTransaction(): Promise<KaminoBuildDepositResult> {
    this.fail('buildDepositTransaction');
  }

  async buildWithdrawTransaction(): Promise<KaminoBuildWithdrawResult> {
    this.fail('buildWithdrawTransaction');
  }
}

let factory: () => KaminoClient = () => new KlendSdkUnavailable();
let cached: KaminoClient | undefined;

export function setKaminoClientFactory(next: () => KaminoClient): void {
  factory = next;
  cached = undefined;
}

export function resetKaminoClientFactory(): void {
  factory = () => new KlendSdkUnavailable();
  cached = undefined;
}

export function getKaminoClient(): KaminoClient {
  if (!cached) cached = factory();
  return cached;
}

export function isKaminoConfigured(): boolean {
  return !(getKaminoClient() instanceof KlendSdkUnavailable);
}

export function describeKaminoUnavailableReason(): string | undefined {
  const client = getKaminoClient();
  return client instanceof KlendSdkUnavailable ? client.reason : undefined;
}
