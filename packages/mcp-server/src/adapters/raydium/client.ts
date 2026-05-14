import { createRequire } from 'node:module';

import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Connection,
  type Signer,
} from '@solana/web3.js';
import { Decimal } from 'decimal.js';

import { formatRawAmount, parseDecimalAmount } from '../../amounts.js';
import { AdapterError } from '../types.js';
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_ADAPTER_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_FARM_PROGRAM_ID_V3,
  RAYDIUM_FARM_PROGRAM_ID_V4,
  RAYDIUM_FARM_PROGRAM_ID_V5,
  RAYDIUM_FARM_PROGRAM_ID_V6,
} from './constants.js';

export type RaydiumPoolType = 'cpmm' | 'clmm' | 'amm_v4';
export type RaydiumLiquidityPoolType = 'cpmm' | 'clmm';
export type RaydiumPositionType = RaydiumLiquidityPoolType | 'farm';

export interface RaydiumTokenInfo {
  mint: string;
  decimals: number;
  symbol?: string;
  name?: string;
  programId?: string;
  vault?: string;
}

export interface RaydiumPoolSnapshot {
  poolId: string;
  poolType: RaydiumPoolType;
  programId: string;
  mintA: RaydiumTokenInfo;
  mintB: RaydiumTokenInfo;
  lpMint?: RaydiumTokenInfo;
  price?: string;
  liquidity?: string;
  tvl?: string;
  feeRateBps?: number;
  tickCurrent?: number;
  tickSpacing?: number;
  rewardMints?: string[];
  asOfSlot?: number;
  raw?: Record<string, unknown>;
}

export interface RaydiumTokenAmount {
  mint: string;
  amount: string;
  decimals?: number;
  symbol?: string;
  rawAmount?: string;
}

export interface RaydiumPosition {
  positionType: RaydiumPositionType;
  poolId?: string;
  poolType?: RaydiumLiquidityPoolType;
  farmId?: string;
  positionMint?: string;
  positionAddress?: string;
  lpMint?: string;
  tickLower?: number;
  tickUpper?: number;
  currentTick?: number;
  inRange?: boolean;
  liquidity?: string;
  lpAmount?: string;
  depositedAmount?: string;
  rawAmount?: string;
  tokenAmounts?: RaydiumTokenAmount[];
  feesOwed?: RaydiumTokenAmount[];
  rewardsOwed?: RaydiumTokenAmount[];
  warnings?: string[];
  asOfSlot?: number;
  raw?: Record<string, unknown>;
}

export interface RaydiumWalletPositionsResult {
  walletAddress: string;
  poolId?: string;
  farmId?: string;
  positions: RaydiumPosition[];
  totals?: {
    positions: number;
    clmmPositions: number;
    cpmmPositions: number;
    farmPositions: number;
  };
}

export interface RaydiumActionPreview {
  poolId?: string;
  poolType?: RaydiumPoolType;
  farmId?: string;
  positionMint?: string;
  tokenMints?: string[];
  tokenAmounts?: RaydiumTokenAmount[];
  tickRange?: {
    lowerTick: number;
    upperTick: number;
  };
  priceRange?: {
    lowerPrice?: string;
    upperPrice?: string;
    currentPrice?: string;
  };
  lpMint?: string;
  rewardMints?: string[];
  quote?: Record<string, unknown>;
  warnings?: string[];
}

export interface RaydiumBuildTransactionResult {
  transactionBase64: string;
  programIds: string[];
  preview?: RaydiumActionPreview;
  sdkVersion?: string;
  signerCount?: number;
}

export interface RaydiumAddLiquidityInput {
  walletAddress: string;
  poolId: string;
  poolType: RaydiumLiquidityPoolType;
  positionMint?: string;
  tokenAAmount?: string;
  tokenBAmount?: string;
  maxTokenAAmount?: string;
  maxTokenBAmount?: string;
  lowerTick?: number;
  upperTick?: number;
  lowerPrice?: string;
  upperPrice?: string;
  rangePreset?: string;
  slippageBps: number;
}

export interface RaydiumRemoveLiquidityInput {
  walletAddress: string;
  poolId: string;
  poolType: RaydiumLiquidityPoolType;
  positionMint?: string;
  liquidityPercent?: number;
  liquidityAmount?: string;
  minTokenAAmount?: string;
  minTokenBAmount?: string;
  closePosition?: boolean;
  slippageBps: number;
}

export interface RaydiumCollectFeesInput {
  walletAddress: string;
  positionMint: string;
  poolId?: string;
}

export interface RaydiumFarmInput {
  walletAddress: string;
  farmId: string;
  amount?: string;
}

export interface RaydiumClient {
  getPoolSnapshot(connection: Connection, poolId: string, poolType?: RaydiumPoolType): Promise<RaydiumPoolSnapshot>;
  getWalletPositions(
    connection: Connection,
    walletAddress: string,
    input?: { poolId?: string; poolType?: RaydiumLiquidityPoolType; farmId?: string },
  ): Promise<RaydiumWalletPositionsResult>;
  getPositionDetail(
    connection: Connection,
    walletAddress: string,
    input: { positionMint: string; poolId?: string },
  ): Promise<RaydiumPosition>;
  previewAddLiquidity(connection: Connection, input: RaydiumAddLiquidityInput): Promise<RaydiumActionPreview>;
  previewRemoveLiquidity(connection: Connection, input: RaydiumRemoveLiquidityInput): Promise<RaydiumActionPreview>;
  previewCollectFees(connection: Connection, input: RaydiumCollectFeesInput): Promise<RaydiumActionPreview>;
  previewFarmStake(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumActionPreview>;
  previewFarmUnstake(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumActionPreview>;
  previewHarvest(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumActionPreview>;
  buildAddLiquidityTransaction(
    connection: Connection,
    input: RaydiumAddLiquidityInput,
  ): Promise<RaydiumBuildTransactionResult>;
  buildRemoveLiquidityTransaction(
    connection: Connection,
    input: RaydiumRemoveLiquidityInput,
  ): Promise<RaydiumBuildTransactionResult>;
  buildCollectFeesTransaction(
    connection: Connection,
    input: RaydiumCollectFeesInput,
  ): Promise<RaydiumBuildTransactionResult>;
  buildFarmStakeTransaction(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumBuildTransactionResult>;
  buildFarmUnstakeTransaction(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumBuildTransactionResult>;
  buildHarvestTransaction(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumBuildTransactionResult>;
}

const requireFromHere = createRequire(import.meta.url);
const SDK_PACKAGE = '@raydium-io/raydium-sdk-v2';
const UNAVAILABLE_REASON =
  '@raydium-io/raydium-sdk-v2 is not installed or could not be resolved. Install it as an optional MCP server dependency, or inject a mock with setRaydiumClientFactory().';

class RaydiumSdkUnavailable implements RaydiumClient {
  readonly reason = UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new AdapterError(RAYDIUM_ADAPTER_ID, 'sdk_unavailable', `Raydium adapter is not configured (${method}): ${this.reason}`);
  }

  async getPoolSnapshot(): Promise<RaydiumPoolSnapshot> {
    this.fail('getPoolSnapshot');
  }
  async getWalletPositions(): Promise<RaydiumWalletPositionsResult> {
    this.fail('getWalletPositions');
  }
  async getPositionDetail(): Promise<RaydiumPosition> {
    this.fail('getPositionDetail');
  }
  async previewAddLiquidity(): Promise<RaydiumActionPreview> {
    this.fail('previewAddLiquidity');
  }
  async previewRemoveLiquidity(): Promise<RaydiumActionPreview> {
    this.fail('previewRemoveLiquidity');
  }
  async previewCollectFees(): Promise<RaydiumActionPreview> {
    this.fail('previewCollectFees');
  }
  async previewFarmStake(): Promise<RaydiumActionPreview> {
    this.fail('previewFarmStake');
  }
  async previewFarmUnstake(): Promise<RaydiumActionPreview> {
    this.fail('previewFarmUnstake');
  }
  async previewHarvest(): Promise<RaydiumActionPreview> {
    this.fail('previewHarvest');
  }
  async buildAddLiquidityTransaction(): Promise<RaydiumBuildTransactionResult> {
    this.fail('buildAddLiquidityTransaction');
  }
  async buildRemoveLiquidityTransaction(): Promise<RaydiumBuildTransactionResult> {
    this.fail('buildRemoveLiquidityTransaction');
  }
  async buildCollectFeesTransaction(): Promise<RaydiumBuildTransactionResult> {
    this.fail('buildCollectFeesTransaction');
  }
  async buildFarmStakeTransaction(): Promise<RaydiumBuildTransactionResult> {
    this.fail('buildFarmStakeTransaction');
  }
  async buildFarmUnstakeTransaction(): Promise<RaydiumBuildTransactionResult> {
    this.fail('buildFarmUnstakeTransaction');
  }
  async buildHarvestTransaction(): Promise<RaydiumBuildTransactionResult> {
    this.fail('buildHarvestTransaction');
  }
}

type RaydiumSdkModule = Record<string, any>;
type RaydiumInstance = Record<string, any>;
type RaydiumFarmVersion = 3 | 4 | 5 | 6;

class RaydiumSdkClient implements RaydiumClient {
  async getPoolSnapshot(connection: Connection, poolId: string, poolType?: RaydiumPoolType): Promise<RaydiumPoolSnapshot> {
    const walletAddress = PublicKey.default.toBase58();
    return withRaydiumErrors('read pool snapshot', async () => {
      const { raydium } = await loadRaydium(connection, walletAddress);
      return fetchPoolSnapshot(raydium, poolId, poolType);
    });
  }

  async getWalletPositions(
    connection: Connection,
    walletAddress: string,
    input: { poolId?: string; poolType?: RaydiumLiquidityPoolType; farmId?: string } = {},
  ): Promise<RaydiumWalletPositionsResult> {
    return withRaydiumErrors('read wallet positions', async () => {
      const { raydium, sdk } = await loadRaydium(connection, walletAddress, { loadTokenAccounts: true });
      const wallet = new PublicKey(walletAddress);
      const positions: RaydiumPosition[] = [];

      if (!input.poolType || input.poolType === 'clmm') {
        const ownerPositions = await raydium.clmm.getOwnerPositionInfo({
          programId: RAYDIUM_CLMM_PROGRAM_ID,
        }).catch(() => []);
        for (const position of ownerPositions as any[]) {
          const poolId = publicKeyString(position?.poolId);
          if (input.poolId && poolId !== input.poolId) continue;
          const snapshot = poolId
            ? await fetchPoolSnapshot(raydium, poolId, 'clmm').catch(() => undefined)
            : undefined;
          positions.push(positionFromClmmLayout(position, snapshot));
        }
      }

      if (input.poolId && (!input.poolType || input.poolType === 'cpmm')) {
        const snapshot = await fetchPoolSnapshot(raydium, input.poolId, 'cpmm').catch(() => undefined);
        const lpMint = snapshot?.lpMint?.mint;
        if (lpMint) {
          const lpPositions = await tokenPositionsForMint(connection, wallet, lpMint, snapshot);
          positions.push(...lpPositions);
        }
      }

      if (input.farmId) {
        const farmInfo = await fetchFarmInfo(raydium, input.farmId).catch(() => undefined);
        const farmPosition = farmInfo
          ? await farmPositionForWallet(connection, sdk, wallet, input.farmId, farmInfo).catch(() => undefined)
          : undefined;
        if (farmPosition) positions.push(farmPosition);
      }

      return {
        walletAddress,
        ...(input.poolId !== undefined && { poolId: input.poolId }),
        ...(input.farmId !== undefined && { farmId: input.farmId }),
        positions,
        totals: summarizePositions(positions),
      };
    });
  }

  async getPositionDetail(
    connection: Connection,
    walletAddress: string,
    input: { positionMint: string; poolId?: string },
  ): Promise<RaydiumPosition> {
    return withRaydiumErrors('read position detail', async () => {
      const result = await this.getWalletPositions(connection, walletAddress, {
        ...(input.poolId !== undefined && { poolId: input.poolId }),
        poolType: 'clmm',
      });
      const position = result.positions.find((entry) => entry.positionMint === input.positionMint);
      if (!position) {
        throw new Error(`Raydium CLMM position ${input.positionMint} was not found for wallet ${walletAddress}.`);
      }
      return position;
    });
  }

  async previewAddLiquidity(connection: Connection, input: RaydiumAddLiquidityInput): Promise<RaydiumActionPreview> {
    return withRaydiumErrors('preview add liquidity', async () => {
      const { raydium } = await loadRaydium(connection, input.walletAddress);
      const snapshot = await fetchPoolSnapshot(raydium, input.poolId, input.poolType);
      return previewLiquidity(input, snapshot);
    });
  }

  async previewRemoveLiquidity(connection: Connection, input: RaydiumRemoveLiquidityInput): Promise<RaydiumActionPreview> {
    return withRaydiumErrors('preview remove liquidity', async () => {
      const { raydium } = await loadRaydium(connection, input.walletAddress);
      const snapshot = await fetchPoolSnapshot(raydium, input.poolId, input.poolType);
      return previewLiquidity(input, snapshot);
    });
  }

  async previewCollectFees(connection: Connection, input: RaydiumCollectFeesInput): Promise<RaydiumActionPreview> {
    const position = await this.getPositionDetail(connection, input.walletAddress, {
      positionMint: input.positionMint,
      ...(input.poolId !== undefined && { poolId: input.poolId }),
    });
    return {
      poolId: position.poolId,
      poolType: 'clmm',
      positionMint: input.positionMint,
      tokenAmounts: position.feesOwed,
      warnings: position.warnings,
    };
  }

  async previewFarmStake(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumActionPreview> {
    return this.previewFarm(connection, input, 'stake');
  }

  async previewFarmUnstake(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumActionPreview> {
    return this.previewFarm(connection, input, 'unstake');
  }

  async previewHarvest(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumActionPreview> {
    return this.previewFarm(connection, input, 'harvest');
  }

  async buildAddLiquidityTransaction(
    connection: Connection,
    input: RaydiumAddLiquidityInput,
  ): Promise<RaydiumBuildTransactionResult> {
    return withRaydiumErrors('build add-liquidity transaction', async () => this.buildAddLiquidityTransactionUnchecked(connection, input));
  }

  private async buildAddLiquidityTransactionUnchecked(
    connection: Connection,
    input: RaydiumAddLiquidityInput,
  ): Promise<RaydiumBuildTransactionResult> {
    const loaded = await loadRaydium(connection, input.walletAddress, { loadTokenAccounts: true });
    const { raydium, sdk } = loaded;
    const wallet = new PublicKey(input.walletAddress);

    if (input.poolType === 'cpmm') {
      const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(input.poolId);
      const baseIn = Boolean(input.tokenAAmount);
      const amount = input.tokenAAmount ?? input.tokenBAmount;
      if (!amount) throw new Error('Raydium CPMM add-liquidity requires tokenAAmount or tokenBAmount.');
      const decimals = baseIn ? tokenDecimals(poolInfo.mintA, 'mintA') : tokenDecimals(poolInfo.mintB, 'mintB');
      const built = await raydium.cpmm.addLiquidity({
        poolInfo,
        poolKeys,
        payer: wallet,
        inputAmount: sdk.toBN(parseDecimalAmount(amount, decimals, 'Raydium liquidity amount').toString(), 0),
        baseIn,
        slippage: new sdk.Percent(input.slippageBps, 10_000),
        txVersion: sdk.TxVersion.LEGACY,
        feePayer: wallet,
      });
      return serializeBuiltTransaction(connection, input.walletAddress, built, previewLiquidity(input, poolSnapshotFromCpmm(poolInfo, poolKeys)));
    }

    const pool = await raydium.clmm.getPoolInfoFromRpc(input.poolId);
    const poolInfo = pool.poolInfo;
    const base = input.tokenAAmount ? 'MintA' : 'MintB';
    const baseAmountText = input.tokenAAmount ?? input.tokenBAmount;
    if (!baseAmountText) throw new Error('Raydium CLMM add-liquidity requires tokenAAmount or tokenBAmount.');
    const otherMaxText = base === 'MintA' ? input.maxTokenBAmount : input.maxTokenAAmount;
    if (!otherMaxText) {
      throw new Error('Raydium CLMM add-liquidity requires the opposite max token amount for slippage-bounded approval.');
    }
    const baseDecimals = base === 'MintA' ? tokenDecimals(poolInfo.mintA, 'mintA') : tokenDecimals(poolInfo.mintB, 'mintB');
    const otherDecimals = base === 'MintA' ? tokenDecimals(poolInfo.mintB, 'mintB') : tokenDecimals(poolInfo.mintA, 'mintA');
    const common = {
      poolInfo,
      ownerInfo: { useSOLBalance: true },
      base,
      baseAmount: sdk.toBN(parseDecimalAmount(baseAmountText, baseDecimals, 'Raydium CLMM base amount').toString(), 0),
      otherAmountMax: sdk.toBN(parseDecimalAmount(otherMaxText, otherDecimals, 'Raydium CLMM max opposite amount').toString(), 0),
      associatedOnly: false,
      checkCreateATAOwner: true,
      txVersion: sdk.TxVersion.LEGACY,
      feePayer: wallet,
    };
    const built = input.positionMint
      ? await raydium.clmm.increasePositionFromBase({
          ...common,
          ownerPosition: await findClmmOwnerPosition(raydium, input.positionMint, input.poolId),
        })
      : await raydium.clmm.openPositionFromBase({
          ...common,
          poolKeys: pool.poolKeys,
          tickLower: await tickForBoundary(sdk, poolInfo, input, 'lower'),
          tickUpper: await tickForBoundary(sdk, poolInfo, input, 'upper'),
          withMetadata: 'create',
        });
    return serializeBuiltTransaction(connection, input.walletAddress, built, previewLiquidity(input, poolSnapshotFromClmm(poolInfo, pool.poolKeys)));
  }

  async buildRemoveLiquidityTransaction(
    connection: Connection,
    input: RaydiumRemoveLiquidityInput,
  ): Promise<RaydiumBuildTransactionResult> {
    return withRaydiumErrors('build remove-liquidity transaction', async () => this.buildRemoveLiquidityTransactionUnchecked(connection, input));
  }

  private async buildRemoveLiquidityTransactionUnchecked(
    connection: Connection,
    input: RaydiumRemoveLiquidityInput,
  ): Promise<RaydiumBuildTransactionResult> {
    const loaded = await loadRaydium(connection, input.walletAddress, { loadTokenAccounts: true });
    const { raydium, sdk } = loaded;
    const wallet = new PublicKey(input.walletAddress);

    if (input.poolType === 'cpmm') {
      const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(input.poolId);
      const lpAmount = await cpmmLpAmount(connection, input, poolSnapshotFromCpmm(poolInfo, poolKeys));
      const built = await raydium.cpmm.withdrawLiquidity({
        poolInfo,
        poolKeys,
        payer: wallet,
        lpAmount: sdk.toBN(lpAmount.toString(), 0),
        slippage: new sdk.Percent(input.slippageBps, 10_000),
        txVersion: sdk.TxVersion.LEGACY,
        feePayer: wallet,
      });
      return serializeBuiltTransaction(connection, input.walletAddress, built, previewLiquidity(input, poolSnapshotFromCpmm(poolInfo, poolKeys)));
    }

    const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(input.poolId);
    const ownerPosition = await findClmmOwnerPosition(raydium, requireText(input.positionMint, 'positionMint'), input.poolId);
    const liquidity = clmmLiquidityAmount(ownerPosition, input);
    assertClmmClosePositionSafe(ownerPosition, input, liquidity);
    const built = await raydium.clmm.decreaseLiquidity({
      poolInfo,
      poolKeys,
      ownerPosition,
      ownerInfo: { useSOLBalance: true, closePosition: input.closePosition === true },
      liquidity: sdk.toBN(liquidity.toString(), 0),
      amountMinA: sdk.toBN(rawAmountOrZero(input.minTokenAAmount, tokenDecimals(poolInfo.mintA, 'mintA')).toString(), 0),
      amountMinB: sdk.toBN(rawAmountOrZero(input.minTokenBAmount, tokenDecimals(poolInfo.mintB, 'mintB')).toString(), 0),
      associatedOnly: false,
      checkCreateATAOwner: true,
      txVersion: sdk.TxVersion.LEGACY,
      feePayer: wallet,
    });
    return serializeBuiltTransaction(connection, input.walletAddress, built, previewLiquidity(input, poolSnapshotFromClmm(poolInfo, poolKeys)));
  }

  async buildCollectFeesTransaction(
    connection: Connection,
    input: RaydiumCollectFeesInput,
  ): Promise<RaydiumBuildTransactionResult> {
    return withRaydiumErrors('build collect-fees transaction', async () => this.buildCollectFeesTransactionUnchecked(connection, input));
  }

  private async buildCollectFeesTransactionUnchecked(
    connection: Connection,
    input: RaydiumCollectFeesInput,
  ): Promise<RaydiumBuildTransactionResult> {
    const loaded = await loadRaydium(connection, input.walletAddress, { loadTokenAccounts: true });
    const { raydium, sdk } = loaded;
    const ownerPosition = await findClmmOwnerPosition(raydium, input.positionMint, input.poolId);
    const poolId = publicKeyString(ownerPosition.poolId);
    const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(poolId);
    const wallet = new PublicKey(input.walletAddress);
    const built = await raydium.clmm.decreaseLiquidity({
      poolInfo,
      poolKeys,
      ownerPosition,
      ownerInfo: { useSOLBalance: true, closePosition: false },
      liquidity: sdk.toBN('0', 0),
      amountMinA: sdk.toBN('0', 0),
      amountMinB: sdk.toBN('0', 0),
      associatedOnly: false,
      checkCreateATAOwner: true,
      txVersion: sdk.TxVersion.LEGACY,
      feePayer: wallet,
    });
    return serializeBuiltTransaction(connection, input.walletAddress, built, {
      poolId,
      poolType: 'clmm',
      positionMint: input.positionMint,
    });
  }

  async buildFarmStakeTransaction(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumBuildTransactionResult> {
    return this.buildFarmTransaction(connection, input, 'stake');
  }

  async buildFarmUnstakeTransaction(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumBuildTransactionResult> {
    return this.buildFarmTransaction(connection, input, 'unstake');
  }

  async buildHarvestTransaction(connection: Connection, input: RaydiumFarmInput): Promise<RaydiumBuildTransactionResult> {
    return this.buildFarmTransaction(connection, input, 'harvest');
  }

  private async previewFarm(connection: Connection, input: RaydiumFarmInput, operation: 'stake' | 'unstake' | 'harvest') {
    return withRaydiumErrors(`preview farm ${operation}`, async () => {
      const { raydium } = await loadRaydium(connection, input.walletAddress);
      const farmInfo = await fetchFarmInfo(raydium, input.farmId);
      return previewFarmFromInfo(input, farmInfo, operation);
    });
  }

  private async buildFarmTransaction(
    connection: Connection,
    input: RaydiumFarmInput,
    operation: 'stake' | 'unstake' | 'harvest',
  ): Promise<RaydiumBuildTransactionResult> {
    return withRaydiumErrors(`build farm ${operation} transaction`, async () => {
      const { raydium, sdk } = await loadRaydium(connection, input.walletAddress, { loadTokenAccounts: true });
      const farmInfo = await fetchFarmInfo(raydium, input.farmId);
      const amountRaw = operation === 'harvest'
        ? 0n
        : parseDecimalAmount(requireText(input.amount, 'amount'), tokenDecimals(farmInfo.lpMint, 'lpMint'), 'Raydium farm LP amount');
      const params = {
        farmInfo,
        amount: sdk.toBN(amountRaw.toString(), 0),
        useSOLBalance: true,
        associatedOnly: false,
        checkCreateATAOwner: true,
        txVersion: sdk.TxVersion.LEGACY,
        feePayer: new PublicKey(input.walletAddress),
      };
      const built = operation === 'stake'
        ? await raydium.farm.deposit(params)
        : await raydium.farm.withdraw(params);
      return serializeBuiltTransaction(connection, input.walletAddress, built, previewFarmFromInfo(input, farmInfo, operation));
    });
  }
}

function canResolveRaydiumSdk(): boolean {
  try {
    requireFromHere.resolve(SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

const defaultFactory = (): RaydiumClient => canResolveRaydiumSdk()
  ? new RaydiumSdkClient()
  : new RaydiumSdkUnavailable();

let factory: () => RaydiumClient = defaultFactory;
let cached: RaydiumClient | undefined;

export function setRaydiumClientFactory(next: () => RaydiumClient): void {
  factory = next;
  cached = undefined;
}

export function resetRaydiumClientFactory(): void {
  factory = defaultFactory;
  cached = undefined;
}

export function getRaydiumClient(): RaydiumClient {
  if (!cached) cached = factory();
  return cached;
}

export function isRaydiumConfigured(): boolean {
  return !(getRaydiumClient() instanceof RaydiumSdkUnavailable);
}

export function describeRaydiumUnavailableReason(): string | undefined {
  const client = getRaydiumClient();
  return client instanceof RaydiumSdkUnavailable ? client.reason : undefined;
}

async function withRaydiumErrors<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(
      RAYDIUM_ADAPTER_ID,
      'raydium_sdk_error',
      `Raydium ${operation} failed: ${errorMessage(error)}`,
    );
  }
}

async function loadRaydium(
  connection: Connection,
  walletAddress: string,
  options: { loadTokenAccounts?: boolean } = {},
): Promise<{
  raydium: RaydiumInstance;
  sdk: RaydiumSdkModule;
}> {
  const sdk = await import(SDK_PACKAGE);
  const owner = new PublicKey(walletAddress);
  const raydium = await sdk.Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: 'confirmed',
  });
  if (options.loadTokenAccounts) {
    await refreshWalletTokenAccounts(raydium);
  }
  return { raydium, sdk };
}

async function refreshWalletTokenAccounts(raydium: RaydiumInstance): Promise<void> {
  const fetchWalletTokenAccounts = raydium.account?.fetchWalletTokenAccounts;
  if (typeof fetchWalletTokenAccounts !== 'function') {
    throw new Error('Raydium SDK account.fetchWalletTokenAccounts is not available.');
  }
  await fetchWalletTokenAccounts.call(raydium.account, { forceUpdate: true });
}

async function fetchPoolSnapshot(
  raydium: RaydiumInstance,
  poolId: string,
  poolType?: RaydiumPoolType,
): Promise<RaydiumPoolSnapshot> {
  if (poolType === 'cpmm' || !poolType) {
    const result = await raydium.cpmm.getPoolInfoFromRpc(poolId).catch(() => undefined);
    if (result) return poolSnapshotFromCpmm(result.poolInfo, result.poolKeys);
  }
  if (poolType === 'clmm' || !poolType) {
    const result = await raydium.clmm.getPoolInfoFromRpc(poolId).catch(() => undefined);
    if (result) return poolSnapshotFromClmm(result.poolInfo, result.poolKeys);
  }
  const [pool] = await raydium.api.fetchPoolById({ ids: poolId });
  if (!pool) throw new Error(`Raydium pool ${poolId} was not found.`);
  return poolSnapshotFromApi(pool);
}

function poolSnapshotFromCpmm(poolInfo: any, poolKeys: any): RaydiumPoolSnapshot {
  return {
    poolId: stringValue(poolInfo.id ?? poolKeys?.id),
    poolType: 'cpmm',
    programId: stringValue(poolInfo.programId ?? poolKeys?.programId ?? RAYDIUM_CPMM_PROGRAM_ID),
    mintA: tokenInfo(poolInfo.mintA ?? poolKeys?.mintA),
    mintB: tokenInfo(poolInfo.mintB ?? poolKeys?.mintB),
    ...(poolInfo.lpMint || poolKeys?.mintLp ? { lpMint: tokenInfo(poolInfo.lpMint ?? poolKeys?.mintLp) } : {}),
    ...(stringMaybe(poolInfo.price) !== undefined && { price: stringMaybe(poolInfo.price) }),
    ...(stringMaybe(poolInfo.liquidity) !== undefined && { liquidity: stringMaybe(poolInfo.liquidity) }),
    ...(stringMaybe(poolInfo.tvl) !== undefined && { tvl: stringMaybe(poolInfo.tvl) }),
    ...(feeRateBps(poolInfo.feeRate) !== undefined && { feeRateBps: feeRateBps(poolInfo.feeRate) }),
    raw: redactLarge(poolInfo),
  };
}

function poolSnapshotFromClmm(poolInfo: any, poolKeys: any): RaydiumPoolSnapshot {
  const currentPrice = stringMaybe(poolInfo.price ?? poolInfo.currentPrice);
  return {
    poolId: stringValue(poolInfo.id ?? poolKeys?.id),
    poolType: 'clmm',
    programId: stringValue(poolInfo.programId ?? poolKeys?.programId ?? RAYDIUM_CLMM_PROGRAM_ID),
    mintA: tokenInfo(poolInfo.mintA ?? poolKeys?.mintA),
    mintB: tokenInfo(poolInfo.mintB ?? poolKeys?.mintB),
    ...(currentPrice !== undefined && { price: currentPrice }),
    ...(stringMaybe(poolInfo.liquidity) !== undefined && { liquidity: stringMaybe(poolInfo.liquidity) }),
    ...(stringMaybe(poolInfo.tvl) !== undefined && { tvl: stringMaybe(poolInfo.tvl) }),
    ...(feeRateBps(poolInfo.feeRate) !== undefined && { feeRateBps: feeRateBps(poolInfo.feeRate) }),
    ...(numberMaybe(poolInfo.tickCurrent ?? poolInfo.tickCurrentIndex) !== undefined && { tickCurrent: numberMaybe(poolInfo.tickCurrent ?? poolInfo.tickCurrentIndex) }),
    ...(numberMaybe(poolInfo.tickSpacing ?? poolInfo.config?.tickSpacing) !== undefined && { tickSpacing: numberMaybe(poolInfo.tickSpacing ?? poolInfo.config?.tickSpacing) }),
    rewardMints: rewardMints(poolInfo),
    raw: redactLarge(poolInfo),
  };
}

function poolSnapshotFromApi(poolInfo: any): RaydiumPoolSnapshot {
  const programId = stringValue(poolInfo.programId);
  const poolType: RaydiumPoolType = programId === RAYDIUM_CLMM_PROGRAM_ID.toBase58()
    ? 'clmm'
    : programId === RAYDIUM_CPMM_PROGRAM_ID.toBase58()
      ? 'cpmm'
      : 'amm_v4';
  return {
    poolId: stringValue(poolInfo.id),
    poolType,
    programId,
    mintA: tokenInfo(poolInfo.mintA),
    mintB: tokenInfo(poolInfo.mintB),
    ...(poolInfo.lpMint ? { lpMint: tokenInfo(poolInfo.lpMint) } : {}),
    ...(stringMaybe(poolInfo.price) !== undefined && { price: stringMaybe(poolInfo.price) }),
    ...(stringMaybe(poolInfo.liquidity) !== undefined && { liquidity: stringMaybe(poolInfo.liquidity) }),
    ...(stringMaybe(poolInfo.tvl) !== undefined && { tvl: stringMaybe(poolInfo.tvl) }),
    ...(feeRateBps(poolInfo.feeRate) !== undefined && { feeRateBps: feeRateBps(poolInfo.feeRate) }),
    ...(numberMaybe(poolInfo.tickCurrent ?? poolInfo.tickCurrentIndex) !== undefined && { tickCurrent: numberMaybe(poolInfo.tickCurrent ?? poolInfo.tickCurrentIndex) }),
    ...(numberMaybe(poolInfo.tickSpacing ?? poolInfo.config?.tickSpacing) !== undefined && { tickSpacing: numberMaybe(poolInfo.tickSpacing ?? poolInfo.config?.tickSpacing) }),
    rewardMints: rewardMints(poolInfo),
    raw: redactLarge(poolInfo),
  };
}

async function fetchFarmInfo(raydium: RaydiumInstance, farmId: string): Promise<any> {
  const [farmInfo] = await raydium.api.fetchFarmInfoById({ ids: farmId });
  if (!farmInfo) throw new Error(`Raydium farm ${farmId} was not found.`);
  return farmInfo;
}

async function serializeBuiltTransaction(
  connection: Connection,
  walletAddress: string,
  built: any,
  preview?: RaydiumActionPreview,
): Promise<RaydiumBuildTransactionResult> {
  if (Array.isArray(built?.transactions) || Array.isArray(built?.builder?.allTxData)) {
    throw new Error('Raydium SDK returned multiple transactions; this connector only prepares single wallet approvals.');
  }
  const tx = built.transaction;
  if (!tx) {
    throw new Error('Raydium SDK did not return a single transaction for this action.');
  }
  const signers: Signer[] = Array.isArray(built.signers) ? built.signers : [];
  if (tx instanceof Transaction) {
    if (!tx.feePayer) tx.feePayer = new PublicKey(walletAddress);
    if (!tx.recentBlockhash) {
      const blockhash = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash.blockhash;
    }
    if (signers.length > 0) tx.partialSign(...signers);
    return {
      transactionBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      programIds: programIdsFromLegacyTransaction(tx),
      signerCount: signers.length,
      ...(preview ? { preview } : {}),
    };
  }
  if (tx instanceof VersionedTransaction) {
    if (signers.length > 0) tx.sign(signers);
    return {
      transactionBase64: Buffer.from(tx.serialize()).toString('base64'),
      programIds: programIdsFromVersionedTransaction(tx),
      signerCount: signers.length,
      ...(preview ? { preview } : {}),
    };
  }
  throw new Error('Raydium SDK returned an unknown transaction type.');
}

function programIdsFromLegacyTransaction(transaction: Transaction): string[] {
  return [...new Set(transaction.instructions.map((instruction) => instruction.programId.toBase58()))];
}

function programIdsFromVersionedTransaction(transaction: VersionedTransaction): string[] {
  const keys = transaction.message.staticAccountKeys;
  return [...new Set(transaction.message.compiledInstructions
    .map((instruction) => keys[instruction.programIdIndex]?.toBase58())
    .filter((programId): programId is string => Boolean(programId)))];
}

function previewLiquidity(
  input: RaydiumAddLiquidityInput | RaydiumRemoveLiquidityInput,
  snapshot: RaydiumPoolSnapshot,
): RaydiumActionPreview {
  const tokenAmounts: RaydiumTokenAmount[] = [];
  if ('tokenAAmount' in input && input.tokenAAmount) {
    tokenAmounts.push({ mint: snapshot.mintA.mint, amount: input.tokenAAmount, decimals: snapshot.mintA.decimals, symbol: snapshot.mintA.symbol });
  }
  if ('tokenBAmount' in input && input.tokenBAmount) {
    tokenAmounts.push({ mint: snapshot.mintB.mint, amount: input.tokenBAmount, decimals: snapshot.mintB.decimals, symbol: snapshot.mintB.symbol });
  }
  if ('liquidityAmount' in input && input.liquidityAmount && snapshot.lpMint) {
    tokenAmounts.push({ mint: snapshot.lpMint.mint, amount: input.liquidityAmount, decimals: snapshot.lpMint.decimals, symbol: snapshot.lpMint.symbol });
  }
  return {
    poolId: snapshot.poolId,
    poolType: snapshot.poolType,
    ...(input.positionMint !== undefined && { positionMint: input.positionMint }),
    tokenMints: [snapshot.mintA.mint, snapshot.mintB.mint],
    ...(tokenAmounts.length > 0 && { tokenAmounts }),
    ...(snapshot.lpMint !== undefined && { lpMint: snapshot.lpMint.mint }),
    ...(tickRange(input) !== undefined && { tickRange: tickRange(input) }),
    priceRange: {
      ...('lowerPrice' in input && input.lowerPrice !== undefined ? { lowerPrice: input.lowerPrice } : {}),
      ...('upperPrice' in input && input.upperPrice !== undefined ? { upperPrice: input.upperPrice } : {}),
      ...(snapshot.price !== undefined ? { currentPrice: snapshot.price } : {}),
    },
    warnings: rangeWarnings(snapshot.tickCurrent, tickRange(input)),
  };
}

function previewFarmFromInfo(
  input: RaydiumFarmInput,
  farmInfo: any,
  operation: 'stake' | 'unstake' | 'harvest',
): RaydiumActionPreview {
  return {
    farmId: input.farmId,
    lpMint: tokenMintAddress(farmInfo.lpMint),
    rewardMints: rewardMints(farmInfo),
    tokenAmounts: operation === 'harvest' || !input.amount
      ? undefined
      : [{ mint: tokenMintAddress(farmInfo.lpMint), amount: input.amount, decimals: tokenDecimals(farmInfo.lpMint, 'lpMint') }],
    quote: { operation },
  };
}

function tickRange(input: RaydiumAddLiquidityInput | RaydiumRemoveLiquidityInput): { lowerTick: number; upperTick: number } | undefined {
  if (!('lowerTick' in input)) return undefined;
  return Number.isInteger(input.lowerTick) && Number.isInteger(input.upperTick)
    ? { lowerTick: input.lowerTick as number, upperTick: input.upperTick as number }
    : undefined;
}

function rangeWarnings(currentTick: number | undefined, range: { lowerTick: number; upperTick: number } | undefined): string[] | undefined {
  if (!range || typeof currentTick !== 'number' || !Number.isInteger(currentTick)) return undefined;
  const current = currentTick;
  if (current < range.lowerTick || current >= range.upperTick) {
    return ['Current Raydium CLMM tick is outside the selected position range.'];
  }
  return undefined;
}

function positionFromClmmLayout(position: any, snapshot: RaydiumPoolSnapshot | undefined): RaydiumPosition {
  const lower = numberMaybe(position.tickLower);
  const upper = numberMaybe(position.tickUpper);
  const currentTick = snapshot?.tickCurrent;
  return {
    positionType: 'clmm',
    poolType: 'clmm',
    poolId: publicKeyString(position.poolId),
    positionMint: publicKeyString(position.nftMint),
    tickLower: lower,
    tickUpper: upper,
    ...(currentTick !== undefined && { currentTick }),
    ...(lower !== undefined && upper !== undefined && currentTick !== undefined
      ? { inRange: currentTick >= lower && currentTick < upper }
      : {}),
    liquidity: stringValue(position.liquidity),
    feesOwed: [
      ...(snapshot?.mintA ? [{ mint: snapshot.mintA.mint, amount: stringValue(position.tokenFeesOwedA), decimals: snapshot.mintA.decimals, symbol: snapshot.mintA.symbol }] : []),
      ...(snapshot?.mintB ? [{ mint: snapshot.mintB.mint, amount: stringValue(position.tokenFeesOwedB), decimals: snapshot.mintB.decimals, symbol: snapshot.mintB.symbol }] : []),
    ],
    raw: redactLarge(position),
  };
}

async function tokenPositionsForMint(
  connection: Connection,
  wallet: PublicKey,
  lpMint: string,
  snapshot: RaydiumPoolSnapshot | undefined,
): Promise<RaydiumPosition[]> {
  const result = await connection
    .getParsedTokenAccountsByOwner(wallet, { mint: new PublicKey(lpMint) }, 'confirmed')
    .catch(() => ({ value: [] }));
  return result.value
    .map((entry): RaydiumPosition | undefined => {
      const parsed = entry.account.data.parsed as {
        info?: { tokenAmount?: { uiAmountString?: string; amount?: string; decimals?: number } };
      };
      const tokenAmount = parsed.info?.tokenAmount;
      if (!tokenAmount || BigInt(tokenAmount.amount ?? '0') <= 0n) return undefined;
      return {
        positionType: 'cpmm',
        poolType: 'cpmm',
        ...(snapshot?.poolId !== undefined && { poolId: snapshot.poolId }),
        lpMint,
        lpAmount: tokenAmount.uiAmountString ?? '0',
        rawAmount: tokenAmount.amount ?? '0',
      };
    })
    .filter((entry): entry is RaydiumPosition => entry !== undefined);
}

async function farmPositionForWallet(
  connection: Connection,
  sdk: RaydiumSdkModule,
  wallet: PublicKey,
  farmId: string,
  farmInfo: any,
): Promise<RaydiumPosition | undefined> {
  const programIdText = stringMaybe(farmInfo.programId);
  const programId = publicKeyFromString(programIdText);
  const version = farmVersionForProgram(sdk, programIdText);
  if (!programId || version === undefined) return undefined;
  const getAssociatedLedgerAccount = sdk.getAssociatedLedgerAccount;
  const getFarmLedgerLayout = sdk.getFarmLedgerLayout;
  if (typeof getAssociatedLedgerAccount !== 'function' || typeof getFarmLedgerLayout !== 'function') {
    return undefined;
  }
  const ledgerAddress = getAssociatedLedgerAccount({
    programId,
    poolId: new PublicKey(farmId),
    owner: wallet,
    version,
  }) as PublicKey;
  const account = await connection.getAccountInfo(ledgerAddress, 'confirmed').catch(() => null);
  if (!account) return undefined;
  const layout = getFarmLedgerLayout(version);
  if (!layout || typeof layout.decode !== 'function') return undefined;
  const ledger = layout.decode(account.data) as { deposited?: unknown; rewardDebts?: unknown };
  const depositedText = stringValue(ledger.deposited);
  if (!/^\d+$/.test(depositedText)) return undefined;
  const depositedRaw = BigInt(depositedText);
  if (depositedRaw <= 0n) return undefined;
  const lpDecimals = tokenDecimals(farmInfo.lpMint, 'lpMint');
  const depositedAmount = formatRawAmount(depositedRaw, lpDecimals);
  return {
    positionType: 'farm',
    farmId,
    positionAddress: ledgerAddress.toBase58(),
    lpMint: tokenMintAddress(farmInfo.lpMint),
    lpAmount: depositedAmount,
    depositedAmount,
    rawAmount: depositedRaw.toString(),
    rewardsOwed: rewardMints(farmInfo).map((mint) => ({ mint, amount: 'unknown' })),
    warnings: ['Raydium farm reward amounts are not estimated by this connector yet; reward mint metadata is provided only.'],
    raw: redactLarge({ farmInfo, ledger }),
  };
}

async function findClmmOwnerPosition(raydium: RaydiumInstance, positionMint: string, poolId?: string): Promise<any> {
  const positions = await raydium.clmm.getOwnerPositionInfo({
    programId: RAYDIUM_CLMM_PROGRAM_ID,
  });
  const position = (positions as any[]).find((entry) => {
    const mintMatches = publicKeyString(entry?.nftMint) === positionMint;
    const poolMatches = !poolId || publicKeyString(entry?.poolId) === poolId;
    return mintMatches && poolMatches;
  });
  if (!position) {
    throw new Error(`Raydium CLMM position ${positionMint} was not found for the connected wallet.`);
  }
  return position;
}

async function cpmmLpAmount(connection: Connection, input: RaydiumRemoveLiquidityInput, snapshot: RaydiumPoolSnapshot): Promise<bigint> {
  if (input.liquidityAmount) {
    const decimals = snapshot.lpMint?.decimals ?? 0;
    return parseDecimalAmount(input.liquidityAmount, decimals, 'Raydium LP amount');
  }
  if (input.liquidityPercent === undefined) {
    throw new Error('Raydium CPMM remove-liquidity requires liquidityAmount or liquidityPercent.');
  }
  const lpMint = requireText(snapshot.lpMint?.mint, 'lpMint');
  const positions = await tokenPositionsForMint(connection, new PublicKey(input.walletAddress), lpMint, snapshot);
  const raw = positions.reduce((sum, position) => sum + BigInt(position.rawAmount ?? '0'), 0n);
  if (raw <= 0n) throw new Error(`No Raydium LP balance found for pool ${input.poolId}.`);
  const scaledPercent = BigInt(Math.round(input.liquidityPercent * 10_000));
  return raw * scaledPercent / 1_000_000n;
}

function clmmLiquidityAmount(ownerPosition: any, input: RaydiumRemoveLiquidityInput): bigint {
  if (input.liquidityAmount) return BigInt(input.liquidityAmount);
  if (input.liquidityPercent === undefined) {
    throw new Error('Raydium CLMM remove-liquidity requires liquidityAmount or liquidityPercent.');
  }
  const raw = BigInt(stringValue(ownerPosition.liquidity));
  const scaledPercent = BigInt(Math.round(input.liquidityPercent * 10_000));
  return raw * scaledPercent / 1_000_000n;
}

function assertClmmClosePositionSafe(ownerPosition: any, input: RaydiumRemoveLiquidityInput, liquidity: bigint): void {
  if (input.closePosition !== true) return;
  const fullLiquidity = BigInt(stringValue(ownerPosition.liquidity));
  if (liquidity !== fullLiquidity) {
    throw new Error('Raydium closePosition requires removing the full CLMM liquidity amount.');
  }
}

async function tickForBoundary(
  sdk: RaydiumSdkModule,
  poolInfo: any,
  input: RaydiumAddLiquidityInput,
  boundary: 'lower' | 'upper',
): Promise<number> {
  const tick = boundary === 'lower' ? input.lowerTick : input.upperTick;
  if (Number.isInteger(tick)) return tick as number;
  const price = boundary === 'lower' ? input.lowerPrice : input.upperPrice;
  if (!price) throw new Error(`Raydium CLMM ${boundary} tick or price is required.`);
  return sdk.TickUtils.getPriceAndTick({
    poolInfo,
    price: Decimal(price),
    baseIn: true,
  }).tick;
}

function rawAmountOrZero(amount: string | undefined, decimals: number): bigint {
  return amount ? parseDecimalAmount(amount, decimals, 'Raydium minimum token amount') : 0n;
}

function tokenInfo(value: any): RaydiumTokenInfo {
  return {
    mint: tokenMintAddress(value),
    decimals: tokenDecimals(value, 'token'),
    ...(stringMaybe(value?.symbol) !== undefined && { symbol: stringMaybe(value.symbol) }),
    ...(stringMaybe(value?.name) !== undefined && { name: stringMaybe(value.name) }),
    ...(stringMaybe(value?.programId) !== undefined && { programId: stringMaybe(value.programId) }),
    ...(stringMaybe(value?.vault) !== undefined && { vault: stringMaybe(value.vault) }),
  };
}

function tokenMintAddress(value: any): string {
  return stringValue(value?.address ?? value?.mint ?? value?.id ?? value);
}

function tokenDecimals(value: any, label: string): number {
  const parsed = numberMaybe(value?.decimals ?? value?.decimal ?? value?.mintDecimal);
  if (parsed === undefined) throw new Error(`Raydium ${label} decimals are not available.`);
  return parsed;
}

function rewardMints(value: any): string[] {
  const rewards = Array.isArray(value?.rewardInfos) ? value.rewardInfos : [];
  return rewards.map((reward: any) => tokenMintAddress(reward?.mint ?? reward?.tokenMint ?? reward?.rewardMint)).filter(Boolean);
}

function farmVersionForProgram(sdk: RaydiumSdkModule, programId: string | undefined): RaydiumFarmVersion | undefined {
  if (!programId) return undefined;
  const sdkVersion = numberMaybe(sdk.FARM_PROGRAM_TO_VERSION?.[programId]);
  if (isFarmVersion(sdkVersion)) return sdkVersion;
  if (programId === RAYDIUM_FARM_PROGRAM_ID_V3.toBase58()) return 3;
  if (programId === RAYDIUM_FARM_PROGRAM_ID_V4.toBase58()) return 4;
  if (programId === RAYDIUM_FARM_PROGRAM_ID_V5.toBase58()) return 5;
  if (programId === RAYDIUM_FARM_PROGRAM_ID_V6.toBase58()) return 6;
  return undefined;
}

function isFarmVersion(value: number | undefined): value is RaydiumFarmVersion {
  return value === 3 || value === 4 || value === 5 || value === 6;
}

function summarizePositions(positions: RaydiumPosition[]): RaydiumWalletPositionsResult['totals'] {
  return {
    positions: positions.length,
    clmmPositions: positions.filter((position) => position.positionType === 'clmm').length,
    cpmmPositions: positions.filter((position) => position.positionType === 'cpmm').length,
    farmPositions: positions.filter((position) => position.positionType === 'farm').length,
  };
}

function publicKeyString(value: unknown): string {
  if (value instanceof PublicKey) return value.toBase58();
  return stringValue(value);
}

function stringValue(value: unknown): string {
  if (value instanceof PublicKey) return value.toBase58();
  if (value && typeof value === 'object' && 'toString' in value && typeof value.toString === 'function') {
    return value.toString();
  }
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ? String(value) : '';
}

function stringMaybe(value: unknown): string | undefined {
  const text = stringValue(value).trim();
  return text ? text : undefined;
}

function publicKeyFromString(value: string | undefined): PublicKey | undefined {
  if (!value) return undefined;
  try {
    return new PublicKey(value);
  } catch {
    return undefined;
  }
}

function numberMaybe(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function feeRateBps(value: unknown): number | undefined {
  const feeRate = numberMaybe(value);
  if (feeRate === undefined) return undefined;
  if (Math.abs(feeRate) <= 1) return Number((feeRate * 10_000).toFixed(6));
  return feeRate;
}

function requireText(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`Raydium ${field} is required.`);
  return value.trim();
}

function redactLarge(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof PublicKey) return item.toBase58();
      if (typeof item === 'bigint') return item.toString();
      if (item && typeof item === 'object' && 'toString' in item && item.constructor?.name === 'BN') {
        return item.toString();
      }
      return item;
    })) as Record<string, unknown>;
  } catch {
    return { unserializable: true, type: value.constructor?.name ?? 'object' };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
