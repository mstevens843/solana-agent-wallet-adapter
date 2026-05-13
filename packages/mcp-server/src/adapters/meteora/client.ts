import type { Connection } from '@solana/web3.js';
import type { MeteoraStrategyType } from './constants.js';

export interface MeteoraTokenAmount {
  mint: string;
  amount?: string;
  decimals?: number;
  symbol?: string;
}

export interface MeteoraRewardAmount extends MeteoraTokenAmount {
  rewardIndex?: number;
  familiar?: boolean;
}

export interface MeteoraPoolSnapshot {
  poolAddress: string;
  programId: string;
  tokenMintX: string;
  tokenMintY: string;
  tokenXSymbol?: string;
  tokenYSymbol?: string;
  tokenXDecimals?: number;
  tokenYDecimals?: number;
  activeBinId: number;
  binStep: number;
  baseFeeBps?: number;
  dynamicFeeBps?: number;
  liquidity?: string;
  statusFlags?: string[];
  asOfSlot?: number;
  asOfBlockTime?: number;
}

export interface MeteoraBinAmount {
  binId: number;
  liquidity?: string;
  tokenXAmount?: string;
  tokenYAmount?: string;
}

export interface MeteoraPosition {
  positionAddress: string;
  owner?: string;
  poolAddress: string;
  tokenMintX?: string;
  tokenMintY?: string;
  lowerBinId: number;
  upperBinId: number;
  activeBinId?: number;
  inRange?: boolean;
  liquidity: string;
  tokenAmounts?: MeteoraTokenAmount[];
  feesOwed?: MeteoraTokenAmount[];
  rewardsOwed?: MeteoraRewardAmount[];
  bins?: MeteoraBinAmount[];
  warnings?: string[];
  asOfSlot?: number;
}

export interface MeteoraWalletPositionsResult {
  walletAddress: string;
  poolAddress?: string;
  positions: MeteoraPosition[];
  totals?: {
    positions: number;
    inRange?: number;
    outOfRange?: number;
  };
}

export interface MeteoraLiquidityPreview {
  poolAddress: string;
  positionAddress?: string;
  tokenMints?: string[];
  tokenAmounts?: MeteoraTokenAmount[];
  binRange?: {
    minBinId: number;
    maxBinId: number;
  };
  activeBinId?: number;
  strategyType?: MeteoraStrategyType;
  quote?: Record<string, unknown>;
  warnings?: string[];
}

export interface MeteoraBuildTransactionResult {
  transactionBase64: string;
  preview?: MeteoraLiquidityPreview;
}

export interface MeteoraClaimInput {
  walletAddress: string;
  poolAddress: string;
  positionAddress?: string;
  claimAll?: boolean;
}

export interface MeteoraAddLiquidityInput {
  walletAddress: string;
  poolAddress: string;
  positionAddress: string;
  tokenXAmount?: string;
  tokenYAmount?: string;
  minBinId: number;
  maxBinId: number;
  strategyType: MeteoraStrategyType;
  singleSidedX?: boolean;
  slippageBps: number;
}

export interface MeteoraRemoveLiquidityInput {
  walletAddress: string;
  poolAddress: string;
  positionAddress: string;
  liquidityBps: number;
  minBinId: number;
  maxBinId: number;
  slippageBps: number;
}

export interface MeteoraClosePositionInput {
  walletAddress: string;
  poolAddress: string;
  positionAddress: string;
}

export interface MeteoraClient {
  getPoolSnapshot(connection: Connection, poolAddress: string): Promise<MeteoraPoolSnapshot>;
  getWalletPositions(
    connection: Connection,
    walletAddress: string,
    poolAddress?: string,
  ): Promise<MeteoraWalletPositionsResult>;
  getPositionDetail(
    connection: Connection,
    poolAddress: string,
    positionAddress: string,
  ): Promise<MeteoraPosition>;
  previewClaimFees(connection: Connection, input: MeteoraClaimInput): Promise<MeteoraLiquidityPreview>;
  previewClaimRewards(connection: Connection, input: MeteoraClaimInput): Promise<MeteoraLiquidityPreview>;
  previewAddLiquidity(connection: Connection, input: MeteoraAddLiquidityInput): Promise<MeteoraLiquidityPreview>;
  previewRemoveLiquidity(connection: Connection, input: MeteoraRemoveLiquidityInput): Promise<MeteoraLiquidityPreview>;
  previewClosePosition(connection: Connection, input: MeteoraClosePositionInput): Promise<MeteoraLiquidityPreview>;
  buildClaimFeesTransaction(
    connection: Connection,
    input: MeteoraClaimInput,
  ): Promise<MeteoraBuildTransactionResult>;
  buildClaimRewardsTransaction(
    connection: Connection,
    input: MeteoraClaimInput,
  ): Promise<MeteoraBuildTransactionResult>;
  buildAddLiquidityTransaction(
    connection: Connection,
    input: MeteoraAddLiquidityInput,
  ): Promise<MeteoraBuildTransactionResult>;
  buildRemoveLiquidityTransaction(
    connection: Connection,
    input: MeteoraRemoveLiquidityInput,
  ): Promise<MeteoraBuildTransactionResult>;
  buildClosePositionTransaction(
    connection: Connection,
    input: MeteoraClosePositionInput,
  ): Promise<MeteoraBuildTransactionResult>;
}

const UNAVAILABLE_REASON =
  '@meteora-ag/dlmm is not wired. Install @meteora-ag/dlmm and @coral-xyz/anchor, then call setMeteoraClientFactory(buildMeteoraClient) at boot, or inject a mock for tests.';

class MeteoraSdkUnavailable implements MeteoraClient {
  readonly reason = UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new Error(`Meteora adapter is not configured (${method}): ${this.reason}`);
  }

  async getPoolSnapshot(): Promise<MeteoraPoolSnapshot> {
    this.fail('getPoolSnapshot');
  }

  async getWalletPositions(): Promise<MeteoraWalletPositionsResult> {
    this.fail('getWalletPositions');
  }

  async getPositionDetail(): Promise<MeteoraPosition> {
    this.fail('getPositionDetail');
  }

  async previewClaimFees(): Promise<MeteoraLiquidityPreview> {
    this.fail('previewClaimFees');
  }

  async previewClaimRewards(): Promise<MeteoraLiquidityPreview> {
    this.fail('previewClaimRewards');
  }

  async previewAddLiquidity(): Promise<MeteoraLiquidityPreview> {
    this.fail('previewAddLiquidity');
  }

  async previewRemoveLiquidity(): Promise<MeteoraLiquidityPreview> {
    this.fail('previewRemoveLiquidity');
  }

  async previewClosePosition(): Promise<MeteoraLiquidityPreview> {
    this.fail('previewClosePosition');
  }

  async buildClaimFeesTransaction(): Promise<MeteoraBuildTransactionResult> {
    this.fail('buildClaimFeesTransaction');
  }

  async buildClaimRewardsTransaction(): Promise<MeteoraBuildTransactionResult> {
    this.fail('buildClaimRewardsTransaction');
  }

  async buildAddLiquidityTransaction(): Promise<MeteoraBuildTransactionResult> {
    this.fail('buildAddLiquidityTransaction');
  }

  async buildRemoveLiquidityTransaction(): Promise<MeteoraBuildTransactionResult> {
    this.fail('buildRemoveLiquidityTransaction');
  }

  async buildClosePositionTransaction(): Promise<MeteoraBuildTransactionResult> {
    this.fail('buildClosePositionTransaction');
  }
}

let factory: () => MeteoraClient = () => new MeteoraSdkUnavailable();
let cached: MeteoraClient | undefined;

export function setMeteoraClientFactory(next: () => MeteoraClient): void {
  factory = next;
  cached = undefined;
}

export function resetMeteoraClientFactory(): void {
  factory = () => new MeteoraSdkUnavailable();
  cached = undefined;
}

export function getMeteoraClient(): MeteoraClient {
  if (!cached) cached = factory();
  return cached;
}

export function isMeteoraConfigured(): boolean {
  return !(getMeteoraClient() instanceof MeteoraSdkUnavailable);
}

export function describeMeteoraUnavailableReason(): string | undefined {
  const client = getMeteoraClient();
  return client instanceof MeteoraSdkUnavailable ? client.reason : undefined;
}
