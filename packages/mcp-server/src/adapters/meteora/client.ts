import { createRequire } from 'node:module';

import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';

import { formatRawAmount, parseDecimalAmount } from '../../amounts.js';
import { AdapterError } from '../types.js';
import {
  METEORA_ADAPTER_ID,
  METEORA_DLMM_PROGRAM_ID,
  type MeteoraStrategyType,
} from './constants.js';

export interface MeteoraTokenAmount {
  mint: string;
  amount?: string;
  rawAmount?: string;
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
  transactionBase64?: string;
  transactionsBase64?: string[];
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
  positionAddress?: string;
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
  '@meteora-ag/dlmm and @coral-xyz/anchor are not installed or could not be resolved. Install optional Meteora SDK dependencies, or inject a mock with setMeteoraClientFactory().';

const requireFromHere = createRequire(import.meta.url);
const METEORA_SDK_PACKAGE = '@meteora-ag/dlmm';
const ANCHOR_PACKAGE = '@coral-xyz/anchor';

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

type AnyRecord = Record<string, any>;
type AnyTransaction = Transaction | VersionedTransaction | AnyRecord;
type AnyMeteoraSdkModule = AnyRecord & {
  create?: (connection: Connection, dlmm: PublicKey, opt?: AnyRecord) => Promise<AnyRecord>;
  getAllLbPairPositionsByUser?: (
    connection: Connection,
    userPubKey: PublicKey,
    opt?: AnyRecord,
    getPositionsOpt?: AnyRecord,
  ) => Promise<Map<string, AnyRecord>>;
  StrategyType?: AnyRecord;
};

class MeteoraSdkClient implements MeteoraClient {
  private readonly poolCache = new Map<string, Promise<AnyRecord>>();

  async getPoolSnapshot(connection: Connection, poolAddress: string): Promise<MeteoraPoolSnapshot> {
    const pool = await this.pool(connection, poolAddress);
    return this.poolSnapshot(connection, pool, poolAddress);
  }

  async getWalletPositions(
    connection: Connection,
    walletAddress: string,
    poolAddress?: string,
  ): Promise<MeteoraWalletPositionsResult> {
    const wallet = new PublicKey(walletAddress);
    const positions: MeteoraPosition[] = [];
    if (poolAddress) {
      const pool = await this.pool(connection, poolAddress);
      const result = await pool.getPositionsByUserAndLbPair(wallet);
      for (const position of arrayField(result?.userPositions)) {
        positions.push(this.positionFromSdk(poolAddress, pool, position, numberFromAny(result?.activeBin?.binId)));
      }
    } else {
      const sdk = loadMeteoraSdk();
      const opt = sdkCreateOptions();
      const map = await sdk.getAllLbPairPositionsByUser?.(connection, wallet, opt);
      if (!map) {
        throw new AdapterError(METEORA_ADAPTER_ID, 'sdk_unavailable', 'Meteora SDK did not expose getAllLbPairPositionsByUser.');
      }
      for (const [lbPairAddress, info] of map.entries()) {
        for (const position of arrayField(info?.lbPairPositionsData)) {
          positions.push(this.positionFromPositionInfo(lbPairAddress, info, position));
        }
      }
    }
    return {
      walletAddress,
      ...(poolAddress !== undefined && { poolAddress }),
      positions,
      totals: summarizePositions(positions),
    };
  }

  async getPositionDetail(
    connection: Connection,
    poolAddress: string,
    positionAddress: string,
  ): Promise<MeteoraPosition> {
    const pool = await this.pool(connection, poolAddress);
    const position = await pool.getPosition(new PublicKey(positionAddress));
    return this.positionFromSdk(poolAddress, pool, position);
  }

  async previewClaimFees(connection: Connection, input: MeteoraClaimInput): Promise<MeteoraLiquidityPreview> {
    return this.previewClaim(connection, input, 'fees');
  }

  async previewClaimRewards(connection: Connection, input: MeteoraClaimInput): Promise<MeteoraLiquidityPreview> {
    return this.previewClaim(connection, input, 'rewards');
  }

  async previewAddLiquidity(connection: Connection, input: MeteoraAddLiquidityInput): Promise<MeteoraLiquidityPreview> {
    const pool = await this.pool(connection, input.poolAddress);
    const position = input.positionAddress
      ? await this.positionForAction(connection, input.poolAddress, input.positionAddress, input.walletAddress)
      : undefined;
    const snapshot = await this.poolSnapshot(connection, pool, input.poolAddress);
    const tokenAmounts = liquidityInputTokenAmounts(input, snapshot);
    return stripUndefined({
      poolAddress: input.poolAddress,
      ...(input.positionAddress !== undefined && { positionAddress: input.positionAddress }),
      tokenMints: [snapshot.tokenMintX, snapshot.tokenMintY],
      tokenAmounts,
      binRange: { minBinId: input.minBinId, maxBinId: input.maxBinId },
      activeBinId: snapshot.activeBinId,
      strategyType: input.strategyType,
      quote: {
        positionLowerBinId: position?.lowerBinId ?? input.minBinId,
        positionUpperBinId: position?.upperBinId ?? input.maxBinId,
        newPosition: input.positionAddress === undefined,
        slippageBps: input.slippageBps,
      },
      warnings: liquidityWarnings(snapshot.activeBinId, input.minBinId, input.maxBinId, input.singleSidedX),
    }) as unknown as MeteoraLiquidityPreview;
  }

  async previewRemoveLiquidity(connection: Connection, input: MeteoraRemoveLiquidityInput): Promise<MeteoraLiquidityPreview> {
    const pool = await this.pool(connection, input.poolAddress);
    const position = await this.positionForAction(connection, input.poolAddress, input.positionAddress, input.walletAddress);
    const snapshot = await this.poolSnapshot(connection, pool, input.poolAddress);
    return stripUndefined({
      poolAddress: input.poolAddress,
      positionAddress: input.positionAddress,
      tokenMints: tokenMintsFromPosition(position, snapshot),
      tokenAmounts: proportionalTokenAmounts(position.tokenAmounts, input.liquidityBps),
      binRange: { minBinId: input.minBinId, maxBinId: input.maxBinId },
      activeBinId: snapshot.activeBinId,
      quote: {
        liquidityBps: input.liquidityBps,
        slippageBps: input.slippageBps,
      },
      warnings: liquidityWarnings(snapshot.activeBinId, input.minBinId, input.maxBinId, false),
    }) as unknown as MeteoraLiquidityPreview;
  }

  async previewClosePosition(connection: Connection, input: MeteoraClosePositionInput): Promise<MeteoraLiquidityPreview> {
    const pool = await this.pool(connection, input.poolAddress);
    const position = await this.positionForAction(connection, input.poolAddress, input.positionAddress, input.walletAddress);
    const snapshot = await this.poolSnapshot(connection, pool, input.poolAddress);
    return stripUndefined({
      poolAddress: input.poolAddress,
      positionAddress: input.positionAddress,
      tokenMints: tokenMintsFromPosition(position, snapshot),
      activeBinId: snapshot.activeBinId,
      quote: {
        positionLiquidity: position.liquidity,
      },
      warnings: position.warnings,
    }) as unknown as MeteoraLiquidityPreview;
  }

  async buildClaimFeesTransaction(
    connection: Connection,
    input: MeteoraClaimInput,
  ): Promise<MeteoraBuildTransactionResult> {
    return this.buildClaimTransactions(connection, input, 'fees');
  }

  async buildClaimRewardsTransaction(
    connection: Connection,
    input: MeteoraClaimInput,
  ): Promise<MeteoraBuildTransactionResult> {
    return this.buildClaimTransactions(connection, input, 'rewards');
  }

  async buildAddLiquidityTransaction(
    connection: Connection,
    input: MeteoraAddLiquidityInput,
  ): Promise<MeteoraBuildTransactionResult> {
    const pool = await this.pool(connection, input.poolAddress);
    const snapshot = await this.poolSnapshot(connection, pool, input.poolAddress);
    const wallet = new PublicKey(input.walletAddress);
    const addParams = {
      totalXAmount: rawAmountBn(input.tokenXAmount, snapshot.tokenXDecimals ?? 0, 'Meteora token X amount'),
      totalYAmount: rawAmountBn(input.tokenYAmount, snapshot.tokenYDecimals ?? 0, 'Meteora token Y amount'),
      strategy: {
        minBinId: input.minBinId,
        maxBinId: input.maxBinId,
        strategyType: sdkStrategyType(input.strategyType),
        ...(input.singleSidedX !== undefined && { singleSidedX: input.singleSidedX }),
      },
      user: wallet,
      slippage: input.slippageBps / 100,
    };
    let tx: AnyTransaction | AnyTransaction[];
    let positionAddress = input.positionAddress;
    let positionSigner: Keypair | undefined;
    if (input.positionAddress) {
      await this.positionForAction(connection, input.poolAddress, input.positionAddress, input.walletAddress);
      tx = await pool.addLiquidityByStrategy({
        positionPubKey: new PublicKey(input.positionAddress),
        ...addParams,
      });
    } else {
      const initializeAndAdd = requiredFunction(
        pool.initializePositionAndAddLiquidityByStrategy,
        'initializePositionAndAddLiquidityByStrategy',
      );
      positionSigner = Keypair.generate();
      positionAddress = positionSigner.publicKey.toBase58();
      tx = await initializeAndAdd.call(pool, {
        positionPubKey: positionSigner.publicKey,
        ...addParams,
      }) as AnyTransaction | AnyTransaction[];
    }
    const preview = await this.previewAddLiquidity(connection, input);
    return {
      ...await serializeTransactions(connection, wallet, tx, positionSigner ? [positionSigner] : []),
      preview: {
        ...preview,
        ...(positionAddress !== undefined && { positionAddress }),
      },
    };
  }

  async buildRemoveLiquidityTransaction(
    connection: Connection,
    input: MeteoraRemoveLiquidityInput,
  ): Promise<MeteoraBuildTransactionResult> {
    const pool = await this.pool(connection, input.poolAddress);
    await this.positionForAction(connection, input.poolAddress, input.positionAddress, input.walletAddress);
    const wallet = new PublicKey(input.walletAddress);
    const txs = await pool.removeLiquidity({
      user: wallet,
      position: new PublicKey(input.positionAddress),
      fromBinId: input.minBinId,
      toBinId: input.maxBinId,
      bps: makeBn(input.liquidityBps),
      shouldClaimAndClose: false,
    });
    return {
      ...await serializeTransactions(connection, wallet, txs),
      preview: await this.previewRemoveLiquidity(connection, input),
    };
  }

  async buildClosePositionTransaction(
    connection: Connection,
    input: MeteoraClosePositionInput,
  ): Promise<MeteoraBuildTransactionResult> {
    const pool = await this.pool(connection, input.poolAddress);
    const position = await pool.getPosition(new PublicKey(input.positionAddress));
    const normalized = this.positionFromSdk(input.poolAddress, pool, position);
    assertPositionOwner(normalized, input.walletAddress);
    const wallet = new PublicKey(input.walletAddress);
    const tx = await pool.closePositionIfEmpty({ owner: wallet, position });
    return {
      ...await serializeTransactions(connection, wallet, tx),
      preview: await this.previewClosePosition(connection, input),
    };
  }

  private async buildClaimTransactions(
    connection: Connection,
    input: MeteoraClaimInput,
    operation: 'fees' | 'rewards',
  ): Promise<MeteoraBuildTransactionResult> {
    const pool = await this.pool(connection, input.poolAddress);
    const wallet = new PublicKey(input.walletAddress);
    const positions = await this.sdkPositionsForClaim(connection, input);
    if (positions.length === 0) {
      throw new AdapterError(METEORA_ADAPTER_ID, 'missing_position', 'No Meteora positions were found to claim.');
    }
    const txs = operation === 'fees'
      ? input.claimAll
        ? await pool.claimAllSwapFee({ owner: wallet, positions })
        : await pool.claimSwapFee({ owner: wallet, position: positions[0] })
      : input.claimAll
        ? await pool.claimAllLMRewards({ owner: wallet, positions })
        : await pool.claimLMReward({ owner: wallet, position: positions[0] });
    return {
      ...await serializeTransactions(connection, wallet, txs),
      preview: await this.previewClaim(connection, input, operation),
    };
  }

  private async previewClaim(
    connection: Connection,
    input: MeteoraClaimInput,
    operation: 'fees' | 'rewards',
  ): Promise<MeteoraLiquidityPreview> {
    const positions = await this.positionsForClaim(connection, input);
    const tokenAmounts = operation === 'fees'
      ? positions.flatMap((position) => position.feesOwed ?? [])
      : positions.flatMap((position) => position.rewardsOwed ?? []);
    const positive = tokenAmounts.filter(isPositiveTokenAmount);
    if (positive.length === 0) {
      throw new AdapterError(
        METEORA_ADAPTER_ID,
        'nothing_to_claim',
        operation === 'fees'
          ? 'No claimable Meteora swap fees were found for this request.'
          : 'No claimable Meteora rewards were found for this request.',
      );
    }
    const first = positions[0];
    return stripUndefined({
      poolAddress: input.poolAddress,
      ...(input.positionAddress !== undefined && { positionAddress: input.positionAddress }),
      tokenMints: [...new Set(positive.map((amount) => amount.mint))],
      tokenAmounts: aggregateTokenAmounts(positive),
      binRange: first ? { minBinId: first.lowerBinId, maxBinId: first.upperBinId } : undefined,
      activeBinId: first?.activeBinId,
      quote: {
        positions: positions.length,
        claimAll: input.claimAll === true,
        claimTypes: operation === 'fees' ? ['fees'] : ['rewards'],
      },
      warnings: uniqueStrings(positions.flatMap((position) => position.warnings ?? [])),
    }) as unknown as MeteoraLiquidityPreview;
  }

  private async positionsForClaim(connection: Connection, input: MeteoraClaimInput): Promise<MeteoraPosition[]> {
    if (input.positionAddress) {
      const position = await this.positionForAction(connection, input.poolAddress, input.positionAddress, input.walletAddress);
      return [position];
    }
    if (!input.claimAll) return [];
    const result = await this.getWalletPositions(connection, input.walletAddress, input.poolAddress);
    return result.positions;
  }

  private async sdkPositionsForClaim(connection: Connection, input: MeteoraClaimInput): Promise<AnyRecord[]> {
    const pool = await this.pool(connection, input.poolAddress);
    if (input.positionAddress) {
      const position = await pool.getPosition(new PublicKey(input.positionAddress));
      assertPositionOwner(this.positionFromSdk(input.poolAddress, pool, position), input.walletAddress);
      return [position];
    }
    if (!input.claimAll) return [];
    const result = await pool.getPositionsByUserAndLbPair(new PublicKey(input.walletAddress));
    return arrayField(result?.userPositions);
  }

  private async positionForAction(
    connection: Connection,
    poolAddress: string,
    positionAddress: string,
    walletAddress: string,
  ): Promise<MeteoraPosition> {
    const position = await this.getPositionDetail(connection, poolAddress, positionAddress);
    assertPositionOwner(position, walletAddress);
    return position;
  }

  private async pool(connection: Connection, poolAddress: string): Promise<AnyRecord> {
    const key = `${connection.rpcEndpoint ?? 'connection'}:${poolAddress}`;
    let cached = this.poolCache.get(key);
    if (!cached) {
      const sdk = loadMeteoraSdk();
      const create = (sdk.create ?? sdk.default?.create ?? sdk.DLMM?.create) as
        | ((connection: Connection, dlmm: PublicKey, opt?: AnyRecord) => Promise<AnyRecord>)
        | undefined;
      if (typeof create !== 'function') {
        throw new AdapterError(METEORA_ADAPTER_ID, 'sdk_unavailable', 'Meteora SDK did not expose DLMM.create.');
      }
      cached = create(connection, new PublicKey(poolAddress), sdkCreateOptions());
      this.poolCache.set(key, cached);
    }
    return cached;
  }

  private async poolSnapshot(
    connection: Connection,
    pool: AnyRecord,
    poolAddress: string,
  ): Promise<MeteoraPoolSnapshot> {
    const activeBin = typeof pool.getActiveBin === 'function'
      ? await pool.getActiveBin().catch(() => undefined)
      : undefined;
    const feeInfo = pool.getFeeInfo?.();
    const dynamicFee = pool.getDynamicFee?.();
    const slot = typeof connection.getSlot === 'function'
      ? await connection.getSlot('confirmed').catch(() => undefined)
      : undefined;
    const tokenMintX = tokenMintString(pool.tokenX, pool.lbPair?.tokenXMint);
    const tokenMintY = tokenMintString(pool.tokenY, pool.lbPair?.tokenYMint);
    if (!tokenMintX || !tokenMintY) {
      throw new AdapterError(METEORA_ADAPTER_ID, 'invalid_pool', 'Meteora SDK did not return both DLMM token mints.');
    }
    return stripUndefined({
      poolAddress,
      programId: publicKeyString(pool.program?.programId) ?? METEORA_DLMM_PROGRAM_ID.toBase58(),
      tokenMintX,
      tokenMintY,
      tokenXDecimals: numberFromAny(pool.tokenX?.mint?.decimals),
      tokenYDecimals: numberFromAny(pool.tokenY?.mint?.decimals),
      activeBinId: numberFromAny(pool.lbPair?.activeId) ?? numberFromAny(activeBin?.binId) ?? 0,
      binStep: numberFromAny(pool.lbPair?.binStep) ?? 0,
      baseFeeBps: percentageToBps(feeInfo?.baseFeeRatePercentage),
      dynamicFeeBps: percentageToBps(dynamicFee),
      liquidity: stringFromAny(pool.lbPair?.liquidity ?? activeBin?.supply),
      statusFlags: statusFlags(pool.lbPair),
      asOfSlot: slot,
    }) as unknown as MeteoraPoolSnapshot;
  }

  private positionFromPositionInfo(poolAddress: string, info: AnyRecord, position: AnyRecord): MeteoraPosition {
    return this.positionFromSdk(poolAddress, {
      lbPair: info?.lbPair,
      tokenX: info?.tokenX,
      tokenY: info?.tokenY,
      rewards: info?.rewards ?? [],
    }, position);
  }

  private positionFromSdk(
    poolAddress: string,
    pool: AnyRecord,
    position: AnyRecord,
    activeBinIdHint?: number,
  ): MeteoraPosition {
    const data = position?.positionData ?? position;
    const activeBinId = activeBinIdHint ?? numberFromAny(pool.lbPair?.activeId);
    const lowerBinId = numberFromAny(data?.lowerBinId) ?? 0;
    const upperBinId = numberFromAny(data?.upperBinId) ?? 0;
    const tokenX = tokenAmountFromRaw(
      tokenMintString(pool.tokenX, pool.lbPair?.tokenXMint),
      data?.totalXAmountExcludeTransferFee ?? data?.totalXAmount,
      numberFromAny(pool.tokenX?.mint?.decimals),
    );
    const tokenY = tokenAmountFromRaw(
      tokenMintString(pool.tokenY, pool.lbPair?.tokenYMint),
      data?.totalYAmountExcludeTransferFee ?? data?.totalYAmount,
      numberFromAny(pool.tokenY?.mint?.decimals),
    );
    const feeX = tokenAmountFromRaw(
      tokenMintString(pool.tokenX, pool.lbPair?.tokenXMint),
      data?.feeXExcludeTransferFee ?? data?.feeX,
      numberFromAny(pool.tokenX?.mint?.decimals),
    );
    const feeY = tokenAmountFromRaw(
      tokenMintString(pool.tokenY, pool.lbPair?.tokenYMint),
      data?.feeYExcludeTransferFee ?? data?.feeY,
      numberFromAny(pool.tokenY?.mint?.decimals),
    );
    const rewardOne = rewardAmountFromRaw(pool.rewards?.[0], data?.rewardOneExcludeTransferFee ?? data?.rewardOne, 0);
    const rewardTwo = rewardAmountFromRaw(pool.rewards?.[1], data?.rewardTwoExcludeTransferFee ?? data?.rewardTwo, 1);
    const bins = arrayField(data?.positionBinData).map((bin) => stripUndefined({
      binId: numberFromAny(bin?.binId) ?? 0,
      liquidity: stringFromAny(bin?.positionLiquidity),
      tokenXAmount: uiAmountFromRaw(bin?.positionXAmount, numberFromAny(pool.tokenX?.mint?.decimals)),
      tokenYAmount: uiAmountFromRaw(bin?.positionYAmount, numberFromAny(pool.tokenY?.mint?.decimals)),
    })) as unknown as MeteoraBinAmount[];
    const warnings = positionWarnings(activeBinId, lowerBinId, upperBinId);
    return stripUndefined({
      positionAddress: publicKeyString(position?.publicKey) ?? publicKeyString(position?.positionAddress) ?? '',
      owner: publicKeyString(data?.owner),
      poolAddress,
      tokenMintX: tokenMintString(pool.tokenX, pool.lbPair?.tokenXMint),
      tokenMintY: tokenMintString(pool.tokenY, pool.lbPair?.tokenYMint),
      lowerBinId,
      upperBinId,
      activeBinId,
      inRange: activeBinId === undefined ? undefined : activeBinId >= lowerBinId && activeBinId <= upperBinId,
      liquidity: sumPositionLiquidity(data?.positionBinData).toString(),
      tokenAmounts: [tokenX, tokenY].filter(isDefinedTokenAmount),
      feesOwed: [feeX, feeY].filter(isDefinedTokenAmount),
      rewardsOwed: [rewardOne, rewardTwo].filter(isDefinedTokenAmount),
      bins,
      warnings,
      asOfSlot: numberFromAny(data?.lastUpdatedAt),
    }) as unknown as MeteoraPosition;
  }
}

function buildDefaultMeteoraClient(): MeteoraClient {
  return areMeteoraDependenciesResolvable() ? new MeteoraSdkClient() : new MeteoraSdkUnavailable();
}

let factory: () => MeteoraClient = () => buildDefaultMeteoraClient();
let cached: MeteoraClient | undefined;

export function setMeteoraClientFactory(next: () => MeteoraClient): void {
  factory = next;
  cached = undefined;
}

export function resetMeteoraClientFactory(): void {
  factory = () => buildDefaultMeteoraClient();
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

function areMeteoraDependenciesResolvable(): boolean {
  try {
    requireFromHere.resolve(METEORA_SDK_PACKAGE);
    requireFromHere.resolve(ANCHOR_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

function loadMeteoraSdk(): AnyMeteoraSdkModule {
  try {
    return requireFromHere(METEORA_SDK_PACKAGE) as AnyMeteoraSdkModule;
  } catch (err) {
    throw new AdapterError(
      METEORA_ADAPTER_ID,
      'sdk_unavailable',
      `Unable to load @meteora-ag/dlmm: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function makeBn(value: string | number | bigint): any {
  try {
    const anchor = requireFromHere(ANCHOR_PACKAGE) as { BN?: new (value: string | number | bigint) => any };
    if (!anchor.BN) throw new Error('BN export missing');
    return new anchor.BN(value.toString());
  } catch (err) {
    throw new AdapterError(
      METEORA_ADAPTER_ID,
      'sdk_unavailable',
      `Unable to load @coral-xyz/anchor BN: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sdkCreateOptions(): AnyRecord {
  return {
    cluster: 'mainnet-beta',
    programId: METEORA_DLMM_PROGRAM_ID,
  };
}

function sdkStrategyType(strategyType: MeteoraStrategyType): unknown {
  const sdk = loadMeteoraSdk();
  const strategy = sdk.StrategyType;
  if (!strategy) return strategyType;
  if (strategyType === 'curve') return strategy.Curve ?? 1;
  if (strategyType === 'bidask') return strategy.BidAsk ?? 2;
  return strategy.Spot ?? 0;
}

function rawAmountBn(value: string | undefined, decimals: number, label: string): any {
  if (value === undefined || value.trim() === '') return makeBn(0);
  return makeBn(parseDecimalAmount(value, decimals, label).toString());
}

function requiredFunction(value: unknown, name: string): (...args: unknown[]) => Promise<unknown> {
  if (typeof value !== 'function') {
    throw new AdapterError(METEORA_ADAPTER_ID, 'unsupported_method', `Meteora SDK function ${name} is unavailable.`);
  }
  return value as (...args: unknown[]) => Promise<unknown>;
}

async function serializeTransactions(
  connection: Connection,
  feePayer: PublicKey,
  value: AnyTransaction | AnyTransaction[],
  signers: Keypair[] = [],
): Promise<Pick<MeteoraBuildTransactionResult, 'transactionBase64' | 'transactionsBase64'>> {
  const transactions = Array.isArray(value) ? value : [value];
  if (transactions.length === 0) {
    throw new AdapterError(METEORA_ADAPTER_ID, 'empty_transaction', 'Meteora SDK returned no transactions.');
  }
  const serialized: string[] = [];
  for (const transaction of transactions) {
    serialized.push(await serializeTransaction(connection, feePayer, transaction, signers));
  }
  return {
    transactionBase64: serialized[0],
    transactionsBase64: serialized,
  };
}

async function serializeTransaction(
  connection: Connection,
  feePayer: PublicKey,
  transaction: AnyTransaction,
  signers: Keypair[] = [],
): Promise<string> {
  if (transaction instanceof VersionedTransaction) {
    const requiredSigners = signers.filter((signer) => versionedTransactionRequiresSigner(transaction, signer));
    if (requiredSigners.length > 0) transaction.sign(requiredSigners);
    return Buffer.from(transaction.serialize()).toString('base64');
  }
  if (transaction instanceof Transaction || typeof transaction.serialize === 'function') {
    const legacy = transaction as Transaction;
    if (!legacy.feePayer) legacy.feePayer = feePayer;
    if (!legacy.recentBlockhash) {
      const latest = await connection.getLatestBlockhash('confirmed');
      legacy.recentBlockhash = latest.blockhash;
    }
    if (signers.length > 0 && typeof legacy.partialSign === 'function') {
      const requiredSigners = signers.filter((signer) => legacyTransactionRequiresSigner(legacy, signer));
      if (requiredSigners.length > 0) legacy.partialSign(...requiredSigners);
    }
    return legacy.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }
  throw new AdapterError(METEORA_ADAPTER_ID, 'invalid_transaction', 'Meteora SDK returned an unsupported transaction object.');
}

function legacyTransactionRequiresSigner(transaction: Transaction, signer: Keypair): boolean {
  try {
    const message = transaction.compileMessage();
    const index = message.accountKeys.findIndex((key) => key.equals(signer.publicKey));
    return index >= 0 && message.isAccountSigner(index);
  } catch {
    return true;
  }
}

function versionedTransactionRequiresSigner(transaction: VersionedTransaction, signer: Keypair): boolean {
  const keys = transaction.message.staticAccountKeys;
  const signerCount = transaction.message.header.numRequiredSignatures;
  return keys.slice(0, signerCount).some((key) => key.equals(signer.publicKey));
}

function liquidityInputTokenAmounts(input: MeteoraAddLiquidityInput, snapshot: MeteoraPoolSnapshot): MeteoraTokenAmount[] {
  const amounts: Array<MeteoraTokenAmount | undefined> = [
    input.tokenXAmount
      ? {
          mint: snapshot.tokenMintX,
          amount: input.tokenXAmount,
          rawAmount: parseDecimalAmount(input.tokenXAmount, snapshot.tokenXDecimals ?? 0, 'Meteora token X amount').toString(),
          ...(snapshot.tokenXDecimals !== undefined && { decimals: snapshot.tokenXDecimals }),
          ...(snapshot.tokenXSymbol !== undefined && { symbol: snapshot.tokenXSymbol }),
        }
      : undefined,
    input.tokenYAmount
      ? {
          mint: snapshot.tokenMintY,
          amount: input.tokenYAmount,
          rawAmount: parseDecimalAmount(input.tokenYAmount, snapshot.tokenYDecimals ?? 0, 'Meteora token Y amount').toString(),
          ...(snapshot.tokenYDecimals !== undefined && { decimals: snapshot.tokenYDecimals }),
          ...(snapshot.tokenYSymbol !== undefined && { symbol: snapshot.tokenYSymbol }),
        }
      : undefined,
  ];
  return amounts.filter((amount): amount is MeteoraTokenAmount => amount !== undefined);
}

function tokenMintsFromPosition(position: MeteoraPosition, snapshot: MeteoraPoolSnapshot): string[] {
  return [
    position.tokenMintX ?? snapshot.tokenMintX,
    position.tokenMintY ?? snapshot.tokenMintY,
  ];
}

function proportionalTokenAmounts(
  amounts: MeteoraTokenAmount[] | undefined,
  bps: number,
): MeteoraTokenAmount[] | undefined {
  if (!amounts) return undefined;
  return amounts.map((amount) => {
    if (!amount.rawAmount || amount.decimals === undefined) return amount;
    const raw = (BigInt(amount.rawAmount) * BigInt(bps)) / 10_000n;
    return {
      ...amount,
      rawAmount: raw.toString(),
      amount: formatRawAmount(raw, amount.decimals),
    };
  });
}

function aggregateTokenAmounts(amounts: MeteoraTokenAmount[]): MeteoraTokenAmount[] {
  const byMint = new Map<string, MeteoraTokenAmount>();
  for (const amount of amounts) {
    const current = byMint.get(amount.mint);
    if (!current) {
      byMint.set(amount.mint, { ...amount });
      continue;
    }
    if (current.rawAmount && amount.rawAmount && current.decimals !== undefined) {
      const raw = BigInt(current.rawAmount) + BigInt(amount.rawAmount);
      byMint.set(amount.mint, {
        ...current,
        rawAmount: raw.toString(),
        amount: formatRawAmount(raw, current.decimals),
      });
    }
  }
  return [...byMint.values()];
}

function tokenAmountFromRaw(
  mint: string | undefined,
  raw: unknown,
  decimals: number | undefined,
): MeteoraTokenAmount | undefined {
  if (!mint) return undefined;
  const rawAmount = stringFromAny(raw);
  if (rawAmount === undefined) return undefined;
  return stripUndefined({
    mint,
    rawAmount,
    amount: decimals === undefined ? rawAmount : uiAmountFromRaw(rawAmount, decimals),
    decimals,
  }) as unknown as MeteoraTokenAmount;
}

function rewardAmountFromRaw(
  reward: AnyRecord | undefined,
  raw: unknown,
  rewardIndex: number,
): MeteoraRewardAmount | undefined {
  const mint = tokenMintString(reward);
  if (!mint || mint === PublicKey.default.toBase58()) return undefined;
  const amount = tokenAmountFromRaw(mint, raw, numberFromAny(reward?.mint?.decimals));
  return amount ? { ...amount, rewardIndex } : undefined;
}

function uiAmountFromRaw(raw: unknown, decimals: number | undefined): string | undefined {
  const rawAmount = stringFromAny(raw);
  if (rawAmount === undefined) return undefined;
  if (decimals === undefined) return rawAmount;
  return formatRawAmount(BigInt(rawAmount), decimals);
}

function isDefinedTokenAmount<T extends MeteoraTokenAmount | undefined>(amount: T): amount is Exclude<T, undefined> {
  return amount !== undefined;
}

function isPositiveTokenAmount(amount: MeteoraTokenAmount): boolean {
  const raw = amount.rawAmount ?? amount.amount;
  if (raw === undefined) return false;
  return !isZeroish(raw);
}

function assertPositionOwner(position: MeteoraPosition, walletAddress: string): void {
  if (position.owner && position.owner !== walletAddress) {
    throw new AdapterError(
      METEORA_ADAPTER_ID,
      'position_owner_mismatch',
      `Position belongs to wallet ${position.owner}, not ${walletAddress}.`,
    );
  }
}

function summarizePositions(positions: MeteoraPosition[]): NonNullable<MeteoraWalletPositionsResult['totals']> {
  const inRange = positions.filter((position) => position.inRange === true).length;
  const outOfRange = positions.filter((position) => position.inRange === false).length;
  return {
    positions: positions.length,
    inRange,
    outOfRange,
  };
}

function tokenMintString(tokenReserve: AnyRecord | undefined, fallback?: unknown): string | undefined {
  return publicKeyString(tokenReserve?.publicKey) ??
    publicKeyString(tokenReserve?.mint?.address) ??
    publicKeyString(tokenReserve?.mint?.publicKey) ??
    publicKeyString(tokenReserve?.mint) ??
    publicKeyString(fallback);
}

function publicKeyString(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === 'string') {
    try {
      return new PublicKey(value).toBase58();
    } catch {
      return undefined;
    }
  }
  if (typeof (value as { toBase58?: unknown }).toBase58 === 'function') {
    return (value as { toBase58: () => string }).toBase58();
  }
  if (typeof (value as { toString?: unknown }).toString === 'function') {
    const text = (value as { toString: () => string }).toString();
    try {
      return new PublicKey(text).toBase58();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stringFromAny(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof (value as { toString?: unknown }).toString === 'function') return (value as { toString: () => string }).toString();
  return undefined;
}

function numberFromAny(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = stringFromAny(value);
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function percentageToBps(value: unknown): number | undefined {
  const text = stringFromAny(value);
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? Math.round(number * 100) : undefined;
}

function statusFlags(lbPair: AnyRecord | undefined): string[] | undefined {
  const status = stringFromAny(lbPair?.status);
  if (status === undefined) return undefined;
  return [`status:${status}`];
}

function sumPositionLiquidity(bins: unknown): bigint {
  return arrayField(bins).reduce((total, bin) => {
    const raw = stringFromAny(bin?.positionLiquidity);
    return raw ? total + BigInt(raw) : total;
  }, 0n);
}

function positionWarnings(activeBinId: number | undefined, lowerBinId: number, upperBinId: number): string[] {
  if (activeBinId === undefined) return [];
  if (activeBinId < lowerBinId || activeBinId > upperBinId) {
    return [`Active bin ${activeBinId} is outside position range ${lowerBinId}-${upperBinId}.`];
  }
  return [];
}

function liquidityWarnings(
  activeBinId: number | undefined,
  minBinId: number,
  maxBinId: number,
  singleSidedX: boolean | undefined,
): string[] {
  const warnings = positionWarnings(activeBinId, minBinId, maxBinId);
  if (singleSidedX) warnings.push('Single-sided X liquidity can leave the position more exposed to active-bin movement.');
  return warnings;
}

function arrayField(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value as AnyRecord[] : [];
}

function isZeroish(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'bigint') return value === 0n;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return true;
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed) === 0n;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed === 0 : false;
  }
  return false;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
