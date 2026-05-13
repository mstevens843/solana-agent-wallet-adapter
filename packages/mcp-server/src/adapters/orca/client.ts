import type { Connection } from '@solana/web3.js';

export interface OrcaTokenAmount {
  mint: string;
  amount: string;
  decimals?: number;
  symbol?: string;
}

export interface OrcaRewardAmount extends OrcaTokenAmount {
  rewardIndex?: number;
  familiar?: boolean;
}

export interface OrcaWhirlpoolSnapshot {
  whirlpoolAddress: string;
  programId: string;
  configAddress?: string;
  tokenMintA: string;
  tokenMintB: string;
  tokenVaultA?: string;
  tokenVaultB?: string;
  tickSpacing: number;
  feeRateBps?: number;
  currentTickIndex: number;
  currentPrice?: string;
  sqrtPrice?: string;
  liquidity: string;
  rewardMints?: string[];
  asOfSlot?: number;
  asOfBlockTime?: number;
}

export interface OrcaPosition {
  positionMint: string;
  positionAddress?: string;
  owner?: string;
  tokenAccount?: string;
  whirlpoolAddress: string;
  tokenMintA?: string;
  tokenMintB?: string;
  tickLowerIndex: number;
  tickUpperIndex: number;
  currentTickIndex?: number;
  inRange?: boolean;
  liquidity: string;
  tokenAmounts?: OrcaTokenAmount[];
  feesOwed?: OrcaTokenAmount[];
  rewardsOwed?: OrcaRewardAmount[];
  asOfSlot?: number;
  warnings?: string[];
}

export interface OrcaWalletPositionsResult {
  walletAddress: string;
  whirlpoolAddress?: string;
  positions: OrcaPosition[];
  totals?: {
    positions: number;
    inRange?: number;
    outOfRange?: number;
  };
}

export interface OrcaLiquidityPreview {
  whirlpoolAddress: string;
  positionMint?: string;
  tokenMints?: string[];
  tokenAmounts?: OrcaTokenAmount[];
  tickRange?: {
    lowerTick: number;
    upperTick: number;
  };
  priceRange?: {
    lowerPrice?: string;
    upperPrice?: string;
    currentPrice?: string;
  };
  quote?: Record<string, unknown>;
  warnings?: string[];
}

export interface OrcaBuildTransactionResult {
  transactionBase64: string;
  preview?: OrcaLiquidityPreview;
}

export interface OrcaIncreaseLiquidityInput {
  walletAddress: string;
  whirlpoolAddress: string;
  positionMint?: string;
  tokenAAmount?: string;
  tokenBAmount?: string;
  maxTokenAAmount?: string;
  maxTokenBAmount?: string;
  lowerTick?: number;
  upperTick?: number;
  slippageBps: number;
}

export interface OrcaDecreaseLiquidityInput {
  walletAddress: string;
  whirlpoolAddress: string;
  positionMint: string;
  liquidityPercent?: number;
  liquidityAmount?: string;
  minTokenAAmount?: string;
  minTokenBAmount?: string;
  slippageBps: number;
}

export interface OrcaCollectInput {
  walletAddress: string;
  positionMint: string;
  whirlpoolAddress?: string;
}

export interface OrcaClient {
  getWhirlpoolSnapshot(connection: Connection, whirlpoolAddress: string): Promise<OrcaWhirlpoolSnapshot>;
  getWalletPositions(
    connection: Connection,
    walletAddress: string,
    whirlpoolAddress?: string,
  ): Promise<OrcaWalletPositionsResult>;
  getPositionDetail(
    connection: Connection,
    positionMint: string,
    whirlpoolAddress?: string,
  ): Promise<OrcaPosition>;
  previewIncreaseLiquidity(connection: Connection, input: OrcaIncreaseLiquidityInput): Promise<OrcaLiquidityPreview>;
  previewDecreaseLiquidity(connection: Connection, input: OrcaDecreaseLiquidityInput): Promise<OrcaLiquidityPreview>;
  previewCollectFees(connection: Connection, input: OrcaCollectInput): Promise<OrcaLiquidityPreview>;
  previewCollectRewards(connection: Connection, input: OrcaCollectInput): Promise<OrcaLiquidityPreview>;
  buildIncreaseLiquidityTransaction(
    connection: Connection,
    input: OrcaIncreaseLiquidityInput,
  ): Promise<OrcaBuildTransactionResult>;
  buildDecreaseLiquidityTransaction(
    connection: Connection,
    input: OrcaDecreaseLiquidityInput,
  ): Promise<OrcaBuildTransactionResult>;
  buildCollectFeesTransaction(
    connection: Connection,
    input: OrcaCollectInput,
  ): Promise<OrcaBuildTransactionResult>;
  buildCollectRewardsTransaction(
    connection: Connection,
    input: OrcaCollectInput,
  ): Promise<OrcaBuildTransactionResult>;
}

const UNAVAILABLE_REASON =
  '@orca-so/whirlpools is not wired. Install @orca-so/whirlpools and @solana/kit, then call setOrcaClientFactory(buildOrcaClient) at boot, or inject a mock for tests.';

class OrcaSdkUnavailable implements OrcaClient {
  readonly reason = UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new Error(`Orca adapter is not configured (${method}): ${this.reason}`);
  }

  async getWhirlpoolSnapshot(): Promise<OrcaWhirlpoolSnapshot> {
    this.fail('getWhirlpoolSnapshot');
  }

  async getWalletPositions(): Promise<OrcaWalletPositionsResult> {
    this.fail('getWalletPositions');
  }

  async getPositionDetail(): Promise<OrcaPosition> {
    this.fail('getPositionDetail');
  }

  async previewIncreaseLiquidity(): Promise<OrcaLiquidityPreview> {
    this.fail('previewIncreaseLiquidity');
  }

  async previewDecreaseLiquidity(): Promise<OrcaLiquidityPreview> {
    this.fail('previewDecreaseLiquidity');
  }

  async previewCollectFees(): Promise<OrcaLiquidityPreview> {
    this.fail('previewCollectFees');
  }

  async previewCollectRewards(): Promise<OrcaLiquidityPreview> {
    this.fail('previewCollectRewards');
  }

  async buildIncreaseLiquidityTransaction(): Promise<OrcaBuildTransactionResult> {
    this.fail('buildIncreaseLiquidityTransaction');
  }

  async buildDecreaseLiquidityTransaction(): Promise<OrcaBuildTransactionResult> {
    this.fail('buildDecreaseLiquidityTransaction');
  }

  async buildCollectFeesTransaction(): Promise<OrcaBuildTransactionResult> {
    this.fail('buildCollectFeesTransaction');
  }

  async buildCollectRewardsTransaction(): Promise<OrcaBuildTransactionResult> {
    this.fail('buildCollectRewardsTransaction');
  }
}

let factory: () => OrcaClient = () => new OrcaSdkUnavailable();
let cached: OrcaClient | undefined;

export function setOrcaClientFactory(next: () => OrcaClient): void {
  factory = next;
  cached = undefined;
}

export function resetOrcaClientFactory(): void {
  factory = () => new OrcaSdkUnavailable();
  cached = undefined;
}

export function getOrcaClient(): OrcaClient {
  if (!cached) cached = factory();
  return cached;
}

export function isOrcaConfigured(): boolean {
  return !(getOrcaClient() instanceof OrcaSdkUnavailable);
}

export function describeOrcaUnavailableReason(): string | undefined {
  const client = getOrcaClient();
  return client instanceof OrcaSdkUnavailable ? client.reason : undefined;
}
