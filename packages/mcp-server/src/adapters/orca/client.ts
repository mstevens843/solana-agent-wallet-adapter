import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';

import { PublicKey, type Connection } from '@solana/web3.js';

import { AdapterError } from '../types.js';
import { ORCA_ADAPTER_ID, WHIRLPOOL_PROGRAM_ID } from './constants.js';

type SolanaKitModule = typeof import('@solana/kit');
type AnyRecord = Record<string, unknown>;

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
  tokenDecimalsA?: number;
  tokenDecimalsB?: number;
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

interface LoadedOrcaSdk {
  orca: AnyRecord;
  kit: SolanaKitModule;
  whirlpoolsClient: AnyRecord;
  whirlpoolsCore: AnyRecord;
}

interface PositionAccount {
  address?: unknown;
  data?: {
    positionMint?: unknown;
    whirlpool?: unknown;
    liquidity?: unknown;
    tickLowerIndex?: unknown;
    tickUpperIndex?: unknown;
    feeOwedA?: unknown;
    feeOwedB?: unknown;
    rewardInfos?: unknown;
  };
}

interface WhirlpoolAccount {
  address?: unknown;
  data?: {
    whirlpoolsConfig?: unknown;
    tokenMintA?: unknown;
    tokenMintB?: unknown;
    tokenVaultA?: unknown;
    tokenVaultB?: unknown;
    tickSpacing?: unknown;
    feeRate?: unknown;
    tickCurrentIndex?: unknown;
    sqrtPrice?: unknown;
    liquidity?: unknown;
    rewardInfos?: unknown;
  };
}

const requireFromHere = createRequire(import.meta.url);

const REQUIRED_RUNTIME_PACKAGES = [
  '@orca-so/whirlpools',
  '@solana/kit',
] as const;

const REQUIRED_NESTED_ORCA_PACKAGES = [
  '@orca-so/whirlpools-client',
  '@orca-so/whirlpools-core',
] as const;

const UNAVAILABLE_REASON =
  'Install optional dependencies @orca-so/whirlpools and @solana/kit, then restart the MCP server.';

class OrcaSdkUnavailable implements OrcaClient {
  readonly reason: string;

  constructor(reason = UNAVAILABLE_REASON) {
    this.reason = reason;
  }

  private fail(method: string): never {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'unsupported_method',
      `Orca adapter is not configured (${method}): ${this.reason}`,
    );
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

class OrcaSdkClient implements OrcaClient {
  private loaded: Promise<LoadedOrcaSdk> | undefined;

  async getWhirlpoolSnapshot(connection: Connection, whirlpoolAddress: string): Promise<OrcaWhirlpoolSnapshot> {
    const sdk = await this.load();
    const rpc = this.rpc(sdk, connection);
    const account = await fetchWhirlpoolAccount(sdk, rpc, whirlpoolAddress);
    return this.snapshotFromAccount(connection, sdk, account);
  }

  async getWalletPositions(
    connection: Connection,
    walletAddress: string,
    whirlpoolAddress?: string,
  ): Promise<OrcaWalletPositionsResult> {
    const sdk = await this.load();
    const rpc = this.rpc(sdk, connection);
    const fetchPositionsForOwner = requiredFunction(sdk.orca.fetchPositionsForOwner, 'fetchPositionsForOwner');
    const entries = await fetchPositionsForOwner(rpc, sdk.kit.address(walletAddress));
    const snapshots = new Map<string, OrcaWhirlpoolSnapshot>();
    const positions: OrcaPosition[] = [];

    for (const entry of flattenPositionAccounts(entries)) {
      const positionWhirlpool = asAddress(entry.data?.whirlpool);
      if (whirlpoolAddress && positionWhirlpool !== whirlpoolAddress) continue;
      let snapshot = snapshots.get(positionWhirlpool);
      if (!snapshot) {
        const whirlpool = await fetchWhirlpoolAccount(sdk, rpc, positionWhirlpool);
        snapshot = await this.snapshotFromAccount(connection, sdk, whirlpool);
        snapshots.set(positionWhirlpool, snapshot);
      }
      positions.push(positionFromAccount(entry, snapshot, walletAddress));
    }

    return {
      walletAddress,
      ...(whirlpoolAddress !== undefined && { whirlpoolAddress }),
      positions,
      totals: summarizePositions(positions),
    };
  }

  async getPositionDetail(
    connection: Connection,
    positionMint: string,
    whirlpoolAddress?: string,
  ): Promise<OrcaPosition> {
    const sdk = await this.load();
    const rpc = this.rpc(sdk, connection);
    const positionAddress = await derivePositionAddress(sdk, positionMint);
    const position = await fetchPositionAccount(sdk, rpc, positionAddress);
    const snapshot = await this.getWhirlpoolSnapshot(connection, asAddress(position.data?.whirlpool));
    const detail = positionFromAccount(position, snapshot);
    if (whirlpoolAddress && detail.whirlpoolAddress !== whirlpoolAddress) {
      throw new AdapterError(
        ORCA_ADAPTER_ID,
        'position_pool_mismatch',
        `Position belongs to Whirlpool ${detail.whirlpoolAddress}, not ${whirlpoolAddress}.`,
      );
    }
    return detail;
  }

  async previewIncreaseLiquidity(connection: Connection, input: OrcaIncreaseLiquidityInput): Promise<OrcaLiquidityPreview> {
    return withOrcaErrors('preview increase liquidity', async () => {
      const sdk = await this.load();
      const { quote, snapshot, positionMint, tickRange } = await this.increaseLiquidityInstructions(connection, input);
      return increasePreview(sdk, snapshot, input, quote, positionMint, tickRange);
    });
  }

  async previewDecreaseLiquidity(connection: Connection, input: OrcaDecreaseLiquidityInput): Promise<OrcaLiquidityPreview> {
    const sdk = await this.load();
    const { quote, snapshot, position } = await this.decreaseLiquidityInstructions(connection, input);
    return decreasePreview(sdk, snapshot, input, position, quote);
  }

  async previewCollectFees(connection: Connection, input: OrcaCollectInput): Promise<OrcaLiquidityPreview> {
    const sdk = await this.load();
    const { harvested, snapshot } = await this.harvestInstructions(connection, input);
    return collectFeesPreview(harvested.feesQuote, snapshot, input);
  }

  async previewCollectRewards(connection: Connection, input: OrcaCollectInput): Promise<OrcaLiquidityPreview> {
    const sdk = await this.load();
    const { harvested, snapshot } = await this.harvestInstructions(connection, input);
    return collectRewardsPreview(harvested.rewardsQuote, snapshot, input);
  }

  async buildIncreaseLiquidityTransaction(
    connection: Connection,
    input: OrcaIncreaseLiquidityInput,
  ): Promise<OrcaBuildTransactionResult> {
    return withOrcaErrors('build increase-liquidity transaction', async () => {
      const sdk = await this.load();
      const { instructions, quote, snapshot, positionMint, tickRange } = await this.increaseLiquidityInstructions(connection, input);
      return {
        transactionBase64: await buildTransactionBase64(sdk, connection, input.walletAddress, instructions),
        preview: increasePreview(sdk, snapshot, input, quote, positionMint, tickRange),
      };
    });
  }

  async buildDecreaseLiquidityTransaction(
    connection: Connection,
    input: OrcaDecreaseLiquidityInput,
  ): Promise<OrcaBuildTransactionResult> {
    const sdk = await this.load();
    const { instructions, quote, snapshot, position } = await this.decreaseLiquidityInstructions(connection, input);
    return {
      transactionBase64: await buildTransactionBase64(sdk, connection, input.walletAddress, instructions),
      preview: decreasePreview(sdk, snapshot, input, position, quote),
    };
  }

  async buildCollectFeesTransaction(
    connection: Connection,
    input: OrcaCollectInput,
  ): Promise<OrcaBuildTransactionResult> {
    const sdk = await this.load();
    const { harvested, snapshot } = await this.harvestInstructions(connection, input);
    const instructions = filterHarvestInstructions(sdk, harvested.instructions, 'fees');
    assertHarvestCollectInstruction(sdk, instructions, 'fees');
    return {
      transactionBase64: await buildTransactionBase64(sdk, connection, input.walletAddress, instructions),
      preview: collectFeesPreview(harvested.feesQuote, snapshot, input),
    };
  }

  async buildCollectRewardsTransaction(
    connection: Connection,
    input: OrcaCollectInput,
  ): Promise<OrcaBuildTransactionResult> {
    const sdk = await this.load();
    const { harvested, snapshot } = await this.harvestInstructions(connection, input);
    const instructions = filterHarvestInstructions(sdk, harvested.instructions, 'rewards');
    assertHarvestCollectInstruction(sdk, instructions, 'rewards');
    return {
      transactionBase64: await buildTransactionBase64(sdk, connection, input.walletAddress, instructions),
      preview: collectRewardsPreview(harvested.rewardsQuote, snapshot, input),
    };
  }

  private async increaseLiquidityInstructions(
    connection: Connection,
    input: OrcaIncreaseLiquidityInput,
  ): Promise<{
    instructions: unknown[];
    quote: unknown;
    snapshot: OrcaWhirlpoolSnapshot;
    positionMint?: string;
    tickRange: { lowerTick: number; upperTick: number };
  }> {
    const sdk = await this.load();
    const rpc = this.rpc(sdk, connection);
    const snapshot = await this.getWhirlpoolSnapshot(connection, input.whirlpoolAddress);
    const param = liquidityIncreaseParam(input, snapshot);
    const authority = sdk.kit.createNoopSigner(sdk.kit.address(input.walletAddress));

    if (input.positionMint) {
      const position = await this.getPositionDetail(connection, input.positionMint, input.whirlpoolAddress);
      const increaseLiquidityInstructions = requiredFunction(
        sdk.orca.increaseLiquidityInstructions,
        'increaseLiquidityInstructions',
      );
      const built = await increaseLiquidityInstructions(
        rpc,
        sdk.kit.address(input.positionMint),
        param,
        input.slippageBps,
        authority,
      ) as AnyRecord;
      assertIncreaseMaxCaps(input, snapshot, built.quote);
      return {
        instructions: asInstructionArray(built.instructions),
        quote: built.quote,
        snapshot,
        positionMint: input.positionMint,
        tickRange: { lowerTick: position.tickLowerIndex, upperTick: position.tickUpperIndex },
      };
    }

    const lowerTick = requireInteger(input.lowerTick, 'lowerTick');
    const upperTick = requireInteger(input.upperTick, 'upperTick');
    const lowerPrice = priceFromTick(sdk, lowerTick, snapshot, 'lowerTick');
    const upperPrice = priceFromTick(sdk, upperTick, snapshot, 'upperTick');
    const openPositionInstructions = requiredFunction(sdk.orca.openPositionInstructions, 'openPositionInstructions');
    const built = await openPositionInstructions(
      rpc,
      sdk.kit.address(input.whirlpoolAddress),
      param,
      lowerPrice,
      upperPrice,
      input.slippageBps,
      authority,
    ) as AnyRecord;
    assertIncreaseMaxCaps(input, snapshot, built.quote);
    return {
      instructions: asInstructionArray(built.instructions),
      quote: built.quote,
      snapshot,
      positionMint: asOptionalAddress(built.positionMint),
      tickRange: { lowerTick, upperTick },
    };
  }

  private async decreaseLiquidityInstructions(
    connection: Connection,
    input: OrcaDecreaseLiquidityInput,
  ): Promise<{
    instructions: unknown[];
    quote: unknown;
    snapshot: OrcaWhirlpoolSnapshot;
    position: OrcaPosition;
  }> {
    const sdk = await this.load();
    const rpc = this.rpc(sdk, connection);
    const position = await this.getPositionDetail(connection, input.positionMint, input.whirlpoolAddress);
    const snapshot = await this.getWhirlpoolSnapshot(connection, position.whirlpoolAddress);
    const param = decreaseLiquidityParam(input, position);
    const authority = sdk.kit.createNoopSigner(sdk.kit.address(input.walletAddress));
    const decreaseLiquidityInstructions = requiredFunction(
      sdk.orca.decreaseLiquidityInstructions,
      'decreaseLiquidityInstructions',
    );
    const built = await decreaseLiquidityInstructions(
      rpc,
      sdk.kit.address(input.positionMint),
      param,
      input.slippageBps,
      authority,
    ) as AnyRecord;
    return {
      instructions: asInstructionArray(built.instructions),
      quote: built.quote,
      snapshot,
      position,
    };
  }

  private async harvestInstructions(
    connection: Connection,
    input: OrcaCollectInput,
  ): Promise<{ harvested: AnyRecord; snapshot: OrcaWhirlpoolSnapshot; position: OrcaPosition }> {
    const sdk = await this.load();
    const rpc = this.rpc(sdk, connection);
    const position = await this.getPositionDetail(connection, input.positionMint, input.whirlpoolAddress);
    const snapshot = await this.getWhirlpoolSnapshot(connection, position.whirlpoolAddress);
    const authority = sdk.kit.createNoopSigner(sdk.kit.address(input.walletAddress));
    const harvestPositionInstructions = requiredFunction(
      sdk.orca.harvestPositionInstructions,
      'harvestPositionInstructions',
    );
    const harvested = await harvestPositionInstructions(
      rpc,
      sdk.kit.address(input.positionMint),
      authority,
    );
    return { harvested: harvested as AnyRecord, snapshot, position };
  }

  private async snapshotFromAccount(
    connection: Connection,
    sdk: LoadedOrcaSdk,
    account: WhirlpoolAccount,
  ): Promise<OrcaWhirlpoolSnapshot> {
    const whirlpoolAddress = asAddress(account.address);
    const data = account.data;
    if (!data) {
      throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_response', 'Orca SDK returned a Whirlpool account without data.');
    }
    const [decimalsA, decimalsB, owner, slot] = await Promise.all([
      readMintDecimals(connection, asAddress(data.tokenMintA)),
      readMintDecimals(connection, asAddress(data.tokenMintB)),
      readAccountOwner(connection, whirlpoolAddress),
      readSlot(connection),
    ]);
    const sqrtPrice = bigintString(data.sqrtPrice);
    const currentPrice = decimalsA !== undefined && decimalsB !== undefined
      ? callNumber(sdk.whirlpoolsCore.sqrtPriceToPrice, BigInt(sqrtPrice), decimalsA, decimalsB).toString()
      : undefined;
    const rewardMints = rewardInfos(data.rewardInfos)
      .map((reward) => asOptionalAddress(reward.mint))
      .filter((mint): mint is string => mint !== undefined && mint !== DEFAULT_ADDRESS);

    return {
      whirlpoolAddress,
      programId: owner ?? WHIRLPOOL_PROGRAM_ID.toBase58(),
      configAddress: asOptionalAddress(data.whirlpoolsConfig),
      tokenMintA: asAddress(data.tokenMintA),
      tokenMintB: asAddress(data.tokenMintB),
      ...(decimalsA !== undefined && { tokenDecimalsA: decimalsA }),
      ...(decimalsB !== undefined && { tokenDecimalsB: decimalsB }),
      tokenVaultA: asOptionalAddress(data.tokenVaultA),
      tokenVaultB: asOptionalAddress(data.tokenVaultB),
      tickSpacing: numberField(data.tickSpacing, 'tickSpacing'),
      feeRateBps: numberField(data.feeRate, 'feeRate') / 100,
      currentTickIndex: numberField(data.tickCurrentIndex, 'tickCurrentIndex'),
      ...(currentPrice !== undefined && { currentPrice }),
      sqrtPrice,
      liquidity: bigintString(data.liquidity),
      rewardMints,
      ...(slot !== undefined && { asOfSlot: slot }),
    };
  }

  private async load(): Promise<LoadedOrcaSdk> {
    if (!this.loaded) {
      this.loaded = loadOrcaSdk();
    }
    return this.loaded;
  }

  private rpc(sdk: LoadedOrcaSdk, connection: Connection): unknown {
    const endpoint = typeof connection.rpcEndpoint === 'string' && connection.rpcEndpoint.trim()
      ? connection.rpcEndpoint
      : undefined;
    if (!endpoint) {
      throw new AdapterError(ORCA_ADAPTER_ID, 'missing_rpc_endpoint', 'Connection RPC endpoint is required for Orca SDK calls.');
    }
    return sdk.kit.createSolanaRpc(endpoint);
  }
}

async function loadOrcaSdk(): Promise<LoadedOrcaSdk> {
  const reason = resolveOrcaUnavailableReason();
  if (reason) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'unsupported_method', `Orca SDK is unavailable: ${reason}`);
  }

  const orca = await import('@orca-so/whirlpools');
  const kit = await import('@solana/kit');
  const requireFromOrca = createRequire(requireFromHere.resolve('@orca-so/whirlpools'));
  const [whirlpoolsClient, whirlpoolsCore] = await Promise.all([
    importResolved(requireFromOrca, '@orca-so/whirlpools-client'),
    importResolved(requireFromOrca, '@orca-so/whirlpools-core'),
  ]);

  return {
    orca: orca as unknown as AnyRecord,
    kit,
    whirlpoolsClient: whirlpoolsClient as AnyRecord,
    whirlpoolsCore: whirlpoolsCore as AnyRecord,
  };
}

async function importResolved(requireFrom: NodeRequire, specifier: string): Promise<unknown> {
  return import(pathToFileURL(requireFrom.resolve(specifier)).href);
}

function resolveOrcaUnavailableReason(): string | undefined {
  for (const specifier of REQUIRED_RUNTIME_PACKAGES) {
    try {
      requireFromHere.resolve(specifier);
    } catch {
      return `Missing package ${specifier}. ${UNAVAILABLE_REASON}`;
    }
  }
  try {
    const requireFromOrca = createRequire(requireFromHere.resolve('@orca-so/whirlpools'));
    for (const specifier of REQUIRED_NESTED_ORCA_PACKAGES) {
      requireFromOrca.resolve(specifier);
    }
  } catch (err) {
    return `Installed @orca-so/whirlpools package is missing a required nested dependency: ${err instanceof Error ? err.message : String(err)}`;
  }
  return undefined;
}

async function fetchWhirlpoolAccount(
  sdk: LoadedOrcaSdk,
  rpc: unknown,
  whirlpoolAddress: string,
): Promise<WhirlpoolAccount> {
  const fetchWhirlpool = requiredFunction(sdk.whirlpoolsClient.fetchWhirlpool, 'fetchWhirlpool');
  try {
    return await fetchWhirlpool(rpc, sdk.kit.address(whirlpoolAddress)) as WhirlpoolAccount;
  } catch (err) {
    throw friendlyOrcaAccountError(err, 'Whirlpool', whirlpoolAddress);
  }
}

async function derivePositionAddress(sdk: LoadedOrcaSdk, positionMint: string): Promise<string> {
  const getPositionAddress = requiredFunction(sdk.whirlpoolsClient.getPositionAddress, 'getPositionAddress');
  const result = await getPositionAddress(sdk.kit.address(positionMint));
  if (Array.isArray(result) && result[0]) return asAddress(result[0]);
  return asAddress(result);
}

async function fetchPositionAccount(
  sdk: LoadedOrcaSdk,
  rpc: unknown,
  positionAddress: string,
): Promise<PositionAccount> {
  const fetchPosition = requiredFunction(sdk.whirlpoolsClient.fetchPosition, 'fetchPosition');
  try {
    return await fetchPosition(rpc, sdk.kit.address(positionAddress)) as PositionAccount;
  } catch (err) {
    throw friendlyOrcaAccountError(err, 'position', positionAddress);
  }
}

function friendlyOrcaAccountError(error: unknown, accountKind: string, fallbackAddress: string): Error {
  if (error instanceof AdapterError) return error;
  const message = errorMessage(error);
  if (!message.includes('#3230000') && !/account.*not\s+found/i.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  const decodedAddress = decodedSolanaErrorAddress(message);
  const address = decodedAddress || fallbackAddress;
  return new AdapterError(
    ORCA_ADAPTER_ID,
    'account_not_found',
    `Orca ${accountKind} account not found: ${address}. Refresh the pool list or choose another pool.`,
  );
}

function decodedSolanaErrorAddress(message: string): string | undefined {
  const encoded = message.match(/['"]([A-Za-z0-9+/=]{16,})['"]/)?.[1];
  if (!encoded) return undefined;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return decoded.match(/address=([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1];
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function withOrcaErrors<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw friendlyOrcaError(err, operation);
  }
}

function friendlyOrcaError(error: unknown, operation: string): Error {
  if (error instanceof AdapterError) return error;
  const message = errorMessage(error);
  if (message.includes('#5508000')) {
    return new AdapterError(
      ORCA_ADAPTER_ID,
      'quote_failed',
      `Orca ${operation} failed while quoting liquidity. Check the amount, price range, and paired token max, then refresh the pool and try again. Solana error #5508000.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function buildTransactionBase64(
  sdk: LoadedOrcaSdk,
  connection: Connection,
  walletAddress: string,
  instructions: unknown[],
): Promise<string> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const kit = sdk.kit as unknown as Record<string, any>;
  const feePayer = kit.createNoopSigner(kit.address(walletAddress));
  let message = kit.createTransactionMessage({ version: 0 });
  message = kit.setTransactionMessageFeePayerSigner(feePayer, message);
  message = kit.setTransactionMessageLifetimeUsingBlockhash({
    blockhash: kit.blockhash(latest.blockhash),
    lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
  }, message);
  message = kit.appendTransactionMessageInstructions(instructions, message);
  const transaction = await kit.partiallySignTransactionMessageWithSigners(message);
  return kit.getBase64EncodedWireTransaction(transaction);
}

function increasePreview(
  sdk: LoadedOrcaSdk,
  snapshot: OrcaWhirlpoolSnapshot,
  input: OrcaIncreaseLiquidityInput,
  quote: unknown,
  positionMint: string | undefined,
  tickRange: { lowerTick: number; upperTick: number },
): OrcaLiquidityPreview {
  return stripUndefined({
    whirlpoolAddress: input.whirlpoolAddress,
    ...(positionMint !== undefined && { positionMint }),
    tokenMints: [snapshot.tokenMintA, snapshot.tokenMintB],
    tokenAmounts: [
      tokenAmount(snapshot.tokenMintA, quoteField(quote, ['tokenMaxA', 'tokenA']), snapshot.tokenDecimalsA),
      tokenAmount(snapshot.tokenMintB, quoteField(quote, ['tokenMaxB', 'tokenB']), snapshot.tokenDecimalsB),
    ].filter((amount): amount is OrcaTokenAmount => amount !== undefined),
    tickRange,
    priceRange: priceRangeFromTicks(sdk, snapshot, tickRange),
    quote: normalizeQuote(quote),
  }) as unknown as OrcaLiquidityPreview;
}

function decreasePreview(
  sdk: LoadedOrcaSdk,
  snapshot: OrcaWhirlpoolSnapshot,
  input: OrcaDecreaseLiquidityInput,
  position: OrcaPosition,
  quote: unknown,
): OrcaLiquidityPreview {
  const tickRange = { lowerTick: position.tickLowerIndex, upperTick: position.tickUpperIndex };
  return stripUndefined({
    whirlpoolAddress: input.whirlpoolAddress,
    positionMint: input.positionMint,
    tokenMints: [snapshot.tokenMintA, snapshot.tokenMintB],
    tokenAmounts: [
      tokenAmount(snapshot.tokenMintA, quoteField(quote, ['tokenMinA', 'tokenEstA', 'tokenA']), snapshot.tokenDecimalsA),
      tokenAmount(snapshot.tokenMintB, quoteField(quote, ['tokenMinB', 'tokenEstB', 'tokenB']), snapshot.tokenDecimalsB),
    ].filter((amount): amount is OrcaTokenAmount => amount !== undefined),
    tickRange,
    priceRange: priceRangeFromTicks(sdk, snapshot, tickRange),
    quote: normalizeQuote(quote),
  }) as unknown as OrcaLiquidityPreview;
}

function collectFeesPreview(
  quote: unknown,
  snapshot: OrcaWhirlpoolSnapshot,
  input: OrcaCollectInput,
): OrcaLiquidityPreview {
  return stripUndefined({
    whirlpoolAddress: input.whirlpoolAddress ?? snapshot.whirlpoolAddress,
    positionMint: input.positionMint,
    tokenMints: [snapshot.tokenMintA, snapshot.tokenMintB],
    tokenAmounts: [
      tokenAmount(snapshot.tokenMintA, quoteField(quote, ['feeOwedA', 'feeAmountA']), snapshot.tokenDecimalsA),
      tokenAmount(snapshot.tokenMintB, quoteField(quote, ['feeOwedB', 'feeAmountB']), snapshot.tokenDecimalsB),
    ].filter((amount): amount is OrcaTokenAmount => amount !== undefined),
    quote: normalizeQuote(quote),
  }) as unknown as OrcaLiquidityPreview;
}

function collectRewardsPreview(
  quote: unknown,
  snapshot: OrcaWhirlpoolSnapshot,
  input: OrcaCollectInput,
): OrcaLiquidityPreview {
  const rewards = Array.isArray((quote as { rewards?: unknown[] })?.rewards)
    ? (quote as { rewards: unknown[] }).rewards
    : [];
  const tokenAmounts = rewards
    .map((reward, index) => tokenAmount(
      snapshot.rewardMints?.[index] ?? DEFAULT_ADDRESS,
      quoteField(reward, ['rewardsOwed', 'amountOwed', 'amount']),
      undefined,
      index,
    ))
    .filter((amount): amount is OrcaRewardAmount => amount !== undefined && amount.mint !== DEFAULT_ADDRESS);
  return stripUndefined({
    whirlpoolAddress: input.whirlpoolAddress ?? snapshot.whirlpoolAddress,
    positionMint: input.positionMint,
    tokenMints: tokenAmounts.map((amount) => amount.mint),
    tokenAmounts,
    priceRange: snapshot.currentPrice ? { currentPrice: snapshot.currentPrice } : undefined,
    quote: normalizeQuote(quote),
  }) as unknown as OrcaLiquidityPreview;
}

function positionFromAccount(
  account: PositionAccount,
  snapshot: OrcaWhirlpoolSnapshot,
  owner?: string,
): OrcaPosition {
  const data = account.data;
  if (!data) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_response', 'Orca SDK returned a position account without data.');
  }
  const tickLowerIndex = numberField(data.tickLowerIndex, 'tickLowerIndex');
  const tickUpperIndex = numberField(data.tickUpperIndex, 'tickUpperIndex');
  const currentTickIndex = snapshot.currentTickIndex;
  const rewardAmounts = rewardInfos(data.rewardInfos)
    .map((reward, index) => tokenAmount(
      snapshot.rewardMints?.[index] ?? DEFAULT_ADDRESS,
      reward.amountOwed ?? reward.owedAmount,
      undefined,
      index,
    ))
    .filter((amount): amount is OrcaRewardAmount => amount !== undefined && amount.mint !== DEFAULT_ADDRESS);

  return stripUndefined({
    positionMint: asAddress(data.positionMint),
    positionAddress: asOptionalAddress(account.address),
    ...(owner !== undefined && { owner }),
    whirlpoolAddress: asAddress(data.whirlpool),
    tokenMintA: snapshot.tokenMintA,
    tokenMintB: snapshot.tokenMintB,
    tickLowerIndex,
    tickUpperIndex,
    currentTickIndex,
    inRange: currentTickIndex >= tickLowerIndex && currentTickIndex < tickUpperIndex,
    liquidity: bigintString(data.liquidity),
    feesOwed: [
      tokenAmount(snapshot.tokenMintA, data.feeOwedA, snapshot.tokenDecimalsA),
      tokenAmount(snapshot.tokenMintB, data.feeOwedB, snapshot.tokenDecimalsB),
    ].filter((amount): amount is OrcaTokenAmount => amount !== undefined),
    rewardsOwed: rewardAmounts,
    ...(snapshot.asOfSlot !== undefined && { asOfSlot: snapshot.asOfSlot }),
  }) as unknown as OrcaPosition;
}

function liquidityIncreaseParam(
  input: OrcaIncreaseLiquidityInput,
  snapshot: OrcaWhirlpoolSnapshot,
): { tokenA: bigint } | { tokenB: bigint } {
  if (input.tokenAAmount !== undefined) {
    return { tokenA: parseUiAmount(input.tokenAAmount, requireDecimals(snapshot.tokenDecimalsA, snapshot.tokenMintA)) };
  }
  if (input.maxTokenAAmount !== undefined) {
    return { tokenA: parseUiAmount(input.maxTokenAAmount, requireDecimals(snapshot.tokenDecimalsA, snapshot.tokenMintA)) };
  }
  if (input.tokenBAmount !== undefined) {
    return { tokenB: parseUiAmount(input.tokenBAmount, requireDecimals(snapshot.tokenDecimalsB, snapshot.tokenMintB)) };
  }
  if (input.maxTokenBAmount !== undefined) {
    return { tokenB: parseUiAmount(input.maxTokenBAmount, requireDecimals(snapshot.tokenDecimalsB, snapshot.tokenMintB)) };
  }
  throw new AdapterError(ORCA_ADAPTER_ID, 'missing_amount', 'Provide one token amount for Orca increase liquidity.');
}

function assertIncreaseMaxCaps(
  input: OrcaIncreaseLiquidityInput,
  snapshot: OrcaWhirlpoolSnapshot,
  quote: unknown,
): void {
  if (input.tokenAAmount !== undefined && input.maxTokenBAmount !== undefined) {
    assertQuotedTokenWithinMax(
      quoteField(quote, ['tokenMaxB', 'tokenB']),
      input.maxTokenBAmount,
      requireDecimals(snapshot.tokenDecimalsB, snapshot.tokenMintB),
      'token B',
    );
  }
  if (input.tokenBAmount !== undefined && input.maxTokenAAmount !== undefined) {
    assertQuotedTokenWithinMax(
      quoteField(quote, ['tokenMaxA', 'tokenA']),
      input.maxTokenAAmount,
      requireDecimals(snapshot.tokenDecimalsA, snapshot.tokenMintA),
      'token A',
    );
  }
}

function assertQuotedTokenWithinMax(
  quotedRawValue: unknown,
  maxUiAmount: string,
  decimals: number,
  label: string,
): void {
  const quotedRaw = optionalBigintString(quotedRawValue);
  if (quotedRaw === undefined) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_response', `Orca quote did not include ${label} max spend.`);
  }
  const maxRaw = parseUiAmount(maxUiAmount, decimals);
  const quoted = BigInt(quotedRaw);
  if (quoted > maxRaw) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'amount_exceeds_max',
      `Orca quote needs up to ${formatRawAmount(quotedRaw, decimals)} ${label}, above the ${maxUiAmount} ${label} max.`,
    );
  }
}

function decreaseLiquidityParam(input: OrcaDecreaseLiquidityInput, position: OrcaPosition): { liquidity: bigint } {
  if (input.liquidityAmount !== undefined) {
    return { liquidity: parsePositiveInteger(input.liquidityAmount, 'liquidityAmount') };
  }
  if (input.liquidityPercent !== undefined) {
    const bps = BigInt(Math.round(input.liquidityPercent * 10_000));
    const liquidity = BigInt(position.liquidity);
    const amount = (liquidity * bps) / 1_000_000n;
    return { liquidity: amount > 0n ? amount : 1n };
  }
  throw new AdapterError(ORCA_ADAPTER_ID, 'missing_amount', 'Provide liquidityPercent or liquidityAmount for Orca decrease liquidity.');
}

function filterHarvestInstructions(
  sdk: LoadedOrcaSdk,
  instructions: unknown,
  mode: 'fees' | 'rewards',
): unknown[] {
  const values = asInstructionArray(instructions);
  const identifyWhirlpoolInstruction = sdk.whirlpoolsClient.identifyWhirlpoolInstruction;
  const enumValues = sdk.whirlpoolsClient.WhirlpoolInstruction as AnyRecord | undefined;
  if (typeof identifyWhirlpoolInstruction !== 'function' || !enumValues) return values;

  const allowed = new Set<unknown>(mode === 'fees'
    ? [
        enumValues.UpdateFeesAndRewards,
        enumValues.CollectFees,
        enumValues.CollectFeesV2,
      ]
    : [
        enumValues.UpdateFeesAndRewards,
        enumValues.CollectReward,
        enumValues.CollectRewardV2,
      ]);

  return values.filter((instruction) => {
    if (!isWhirlpoolInstruction(instruction)) return true;
    try {
      return allowed.has(identifyWhirlpoolInstruction(instruction));
    } catch {
      return true;
    }
  });
}

function assertHarvestCollectInstruction(
  sdk: LoadedOrcaSdk,
  instructions: unknown[],
  mode: 'fees' | 'rewards',
): void {
  const identifyWhirlpoolInstruction = sdk.whirlpoolsClient.identifyWhirlpoolInstruction;
  const enumValues = sdk.whirlpoolsClient.WhirlpoolInstruction as AnyRecord | undefined;
  if (typeof identifyWhirlpoolInstruction !== 'function' || !enumValues) return;
  const targets = new Set<unknown>(mode === 'fees'
    ? [enumValues.CollectFees, enumValues.CollectFeesV2]
    : [enumValues.CollectReward, enumValues.CollectRewardV2]);
  const hasCollect = instructions.some((instruction) => {
    if (!isWhirlpoolInstruction(instruction)) return false;
    try {
      return targets.has(identifyWhirlpoolInstruction(instruction));
    } catch {
      return false;
    }
  });
  if (!hasCollect) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'nothing_to_collect',
      mode === 'fees' ? 'No claimable Orca fees were found for this position.' : 'No claimable Orca rewards were found for this position.',
    );
  }
}

function isWhirlpoolInstruction(instruction: unknown): boolean {
  if (!instruction || typeof instruction !== 'object') return false;
  const programAddress = (instruction as { programAddress?: unknown; programId?: unknown }).programAddress
    ?? (instruction as { programId?: unknown }).programId;
  return asOptionalAddress(programAddress) === WHIRLPOOL_PROGRAM_ID.toBase58();
}

function priceRangeFromTicks(
  sdk: LoadedOrcaSdk,
  snapshot: OrcaWhirlpoolSnapshot,
  tickRange: { lowerTick: number; upperTick: number },
): OrcaLiquidityPreview['priceRange'] {
  if (snapshot.tokenDecimalsA === undefined || snapshot.tokenDecimalsB === undefined) {
    return snapshot.currentPrice ? { currentPrice: snapshot.currentPrice } : undefined;
  }
  return {
    lowerPrice: priceFromTick(sdk, tickRange.lowerTick, snapshot, 'lowerTick').toString(),
    upperPrice: priceFromTick(sdk, tickRange.upperTick, snapshot, 'upperTick').toString(),
    ...(snapshot.currentPrice !== undefined && { currentPrice: snapshot.currentPrice }),
  };
}

function priceFromTick(
  sdk: LoadedOrcaSdk,
  tick: number,
  snapshot: OrcaWhirlpoolSnapshot,
  field: string,
): number {
  const decimalsA = requireDecimals(snapshot.tokenDecimalsA, snapshot.tokenMintA);
  const decimalsB = requireDecimals(snapshot.tokenDecimalsB, snapshot.tokenMintB);
  const price = callNumber(sdk.whirlpoolsCore.tickIndexToPrice, tick, decimalsA, decimalsB);
  if (!Number.isFinite(price) || price <= 0) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_tick_range', `${field} converted to an invalid Orca price.`);
  }
  return price;
}

function flattenPositionAccounts(entries: unknown): PositionAccount[] {
  if (!Array.isArray(entries)) return [];
  const out: PositionAccount[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const maybeBundle = entry as { isPositionBundle?: boolean; positions?: unknown };
    if (maybeBundle.isPositionBundle && Array.isArray(maybeBundle.positions)) {
      for (const position of maybeBundle.positions) out.push(position as PositionAccount);
    } else {
      out.push(entry as PositionAccount);
    }
  }
  return out;
}

function rewardInfos(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter((entry): entry is AnyRecord => !!entry && typeof entry === 'object') : [];
}

function summarizePositions(positions: OrcaPosition[]): NonNullable<OrcaWalletPositionsResult['totals']> {
  let inRange = 0;
  let outOfRange = 0;
  for (const position of positions) {
    if (position.inRange === true) inRange += 1;
    if (position.inRange === false) outOfRange += 1;
  }
  return { positions: positions.length, inRange, outOfRange };
}

async function readMintDecimals(connection: Connection, mint: string): Promise<number | undefined> {
  if (typeof connection.getParsedAccountInfo !== 'function') return undefined;
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    const data = info.value?.data;
    if (data && typeof data === 'object' && 'parsed' in data) {
      const decimals = (data as { parsed?: { info?: { decimals?: unknown } } }).parsed?.info?.decimals;
      return typeof decimals === 'number' && Number.isInteger(decimals) ? decimals : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readAccountOwner(connection: Connection, address: string): Promise<string | undefined> {
  if (typeof connection.getAccountInfo !== 'function') return undefined;
  try {
    return (await connection.getAccountInfo(new PublicKey(address), 'confirmed'))?.owner?.toBase58();
  } catch {
    return undefined;
  }
}

async function readSlot(connection: Connection): Promise<number | undefined> {
  if (typeof connection.getSlot !== 'function') return undefined;
  try {
    return await connection.getSlot('confirmed');
  } catch {
    return undefined;
  }
}

function parseUiAmount(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(trimmed)) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_amount', 'Orca token amount must be a positive decimal string.');
  }
  const [wholePart, fractionalPart = ''] = trimmed.split('.');
  if (fractionalPart.length > decimals) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'invalid_amount',
      `Orca token amount has more decimal places than the mint supports (${decimals}).`,
    );
  }
  const whole = wholePart === '' ? '0' : wholePart;
  const raw = `${whole}${fractionalPart.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  const amount = BigInt(raw || '0');
  if (amount <= 0n) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_amount', 'Orca token amount must be greater than zero.');
  }
  return amount;
}

function parsePositiveInteger(value: string, field: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_amount', `${field} must be a positive integer string.`);
  }
  const amount = BigInt(trimmed);
  if (amount <= 0n) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_amount', `${field} must be greater than zero.`);
  }
  return amount;
}

function tokenAmount(
  mint: string,
  rawValue: unknown,
  decimals?: number,
  rewardIndex?: number,
): OrcaTokenAmount | OrcaRewardAmount | undefined {
  const raw = optionalBigintString(rawValue);
  if (raw === undefined) return undefined;
  const amount = decimals !== undefined ? formatRawAmount(raw, decimals) : raw;
  return stripUndefined({
    mint,
    amount,
    ...(decimals !== undefined && { decimals }),
    ...(rewardIndex !== undefined && { rewardIndex }),
  }) as unknown as OrcaTokenAmount | OrcaRewardAmount;
}

function quoteField(input: unknown, keys: string[]): unknown {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function normalizeQuote(input: unknown): Record<string, unknown> | undefined {
  const normalized = normalizeValue(input);
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : undefined;
}

function normalizeValue(input: unknown): unknown {
  if (typeof input === 'bigint') return input.toString();
  if (Array.isArray(input)) return input.map((value) => normalizeValue(value));
  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .filter(([, value]) => typeof value !== 'function')
        .map(([key, value]) => [key, normalizeValue(value)]),
    );
  }
  return input;
}

function formatRawAmount(raw: string, decimals: number): string {
  if (decimals <= 0) return raw;
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const padded = unsigned.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '') || '0';
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function requireDecimals(value: number | undefined, mint: string): number {
  if (value === undefined) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_response', `Could not read decimals for Orca token mint ${mint}.`);
  }
  return value;
}

function asInstructionArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredFunction(value: unknown, name: string): (...args: unknown[]) => Promise<unknown> {
  if (typeof value !== 'function') {
    throw new AdapterError(ORCA_ADAPTER_ID, 'unsupported_method', `Orca SDK function ${name} is unavailable.`);
  }
  return value as (...args: unknown[]) => Promise<unknown>;
}

function callNumber(fn: unknown, ...args: unknown[]): number {
  if (typeof fn !== 'function') {
    throw new AdapterError(ORCA_ADAPTER_ID, 'unsupported_method', 'Required Orca price helper is unavailable.');
  }
  const value = fn(...args);
  if (typeof value !== 'number') {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_response', 'Orca price helper returned a non-number value.');
  }
  return value;
}

function numberField(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_response', `Orca SDK returned invalid ${field}.`);
  }
  return number;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_request', `${field} is required and must be an integer.`);
  }
  return value as number;
}

function asAddress(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return normalizeAddress(value.trim());
  if (value && typeof value === 'object') {
    const toString = (value as { toString?: unknown }).toString;
    if (typeof toString === 'function' && toString !== Object.prototype.toString) {
      const stringified = toString.call(value);
      if (typeof stringified === 'string' && stringified.trim()) return normalizeAddress(stringified.trim());
    }
  }
  throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_response', 'Orca SDK returned an invalid address.');
}

function normalizeAddress(value: string): string {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_response', 'Orca SDK returned an invalid address.');
  }
}

function asOptionalAddress(value: unknown): string | undefined {
  try {
    return value === undefined || value === null ? undefined : asAddress(value);
  } catch {
    return undefined;
  }
}

function bigintString(value: unknown): string {
  const parsed = optionalBigintString(value);
  if (parsed === undefined) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_response', 'Orca SDK returned an invalid bigint field.');
  }
  return parsed;
}

function optionalBigintString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString();
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
  if (value && typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    const stringified = (value as { toString: () => string }).toString();
    if (/^-?\d+$/.test(stringified)) return stringified;
  }
  return undefined;
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

const DEFAULT_ADDRESS = '11111111111111111111111111111111';

function defaultOrcaClientFactory(): OrcaClient {
  const reason = resolveOrcaUnavailableReason();
  return reason ? new OrcaSdkUnavailable(reason) : new OrcaSdkClient();
}

let factory: () => OrcaClient = defaultOrcaClientFactory;
let cached: OrcaClient | undefined;

export function setOrcaClientFactory(next: () => OrcaClient): void {
  factory = next;
  cached = undefined;
}

export function resetOrcaClientFactory(): void {
  factory = defaultOrcaClientFactory;
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
