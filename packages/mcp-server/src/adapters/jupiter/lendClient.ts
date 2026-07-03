import { createRequire } from 'node:module';

import {
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  type TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';

import { AdapterError } from '../types.js';
import type { AgentWalletConfig } from '../../config.js';

import { JUPITER_ADAPTER_ID, JUPITER_LEND_EARN_PROGRAM_ID, type JupiterLendOperation } from './constants.js';
import { jupiterFetchJson } from './client.js';

const WSOL_MINT_BASE58 = 'So11111111111111111111111111111111111111112';
const SPL_TOKEN_PACKAGE = '@solana/spl-token';
const SPL_TOKEN_UNAVAILABLE_REASON =
  '@solana/spl-token is not installed or could not be resolved. Jupiter Lend native-SOL earn deposits/withdrawals require it for wSOL wrap/sync/close.';

type SplTokenModule = typeof import('@solana/spl-token');
let cachedSplToken: SplTokenModule | undefined;
async function loadSplToken(): Promise<SplTokenModule> {
  if (cachedSplToken) return cachedSplToken;
  try {
    require.resolve(SPL_TOKEN_PACKAGE);
  } catch {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'spl_token_unavailable', SPL_TOKEN_UNAVAILABLE_REASON);
  }
  cachedSplToken = (await import(SPL_TOKEN_PACKAGE)) as SplTokenModule;
  return cachedSplToken;
}

export interface JupiterLendEarnTokenSnapshot {
  assetMint: string;
  shareMint: string;
  tokenSymbol?: string;
  decimals: number;
  shareDecimals: number;
  apy?: number;
  rewardApy?: number;
  totalSupplyUnderlying?: string;
  totalSupplyShares?: string;
  exchangePrice?: string;
  utilization?: number;
  availableLiquidity?: string;
  active?: boolean;
  rewards?: Array<{
    rewardMint: string;
    rewardSymbol?: string;
    apy?: number;
  }>;
  withdrawalSmoothing?: {
    enabled: boolean;
    note?: string;
  };
  asOf?: string;
}

export interface JupiterLendEarnPositionSnapshot {
  assetMint: string;
  shareMint: string;
  tokenSymbol?: string;
  decimals: number;
  shareDecimals: number;
  shares: string;
  sharesRaw: string;
  underlyingAmount: string;
  underlyingAmountRaw: string;
  walletBalanceUnderlying?: string;
  exchangePrice?: string;
  apy?: number;
  rewardApy?: number;
  asOf?: string;
}

export interface JupiterLendEarnEarningsSnapshot {
  assetMint: string;
  walletAddress: string;
  totalEarnings: string;
  rewardEarnings?: string;
  decimals: number;
  from?: string;
  to?: string;
  asOf?: string;
}

export interface JupiterLendOracleSnapshot {
  oracleAddress?: string;
  price?: string;
  confidenceBps?: number;
  publishedAt?: string;
  maxStalenessSeconds?: number;
  available: boolean;
  warnings?: string[];
}

export interface JupiterLendBorrowVaultSnapshot {
  vaultId: number;
  vaultAddress: string;
  supplyMint: string;
  borrowMint: string;
  supplySymbol?: string;
  borrowSymbol?: string;
  supplyDecimals: number;
  borrowDecimals: number;
  ltvBps: number;
  liquidationThresholdBps: number;
  liquidationPenaltyBps?: number;
  borrowApr?: number;
  supplyApy?: number;
  supplyAvailable?: string;
  borrowAvailable?: string;
  totalCollateral?: string;
  totalDebt?: string;
  oracle?: JupiterLendOracleSnapshot;
  active: boolean;
  asOf?: string;
}

export interface JupiterLendBorrowPositionSnapshot {
  vaultId: number;
  vaultAddress: string;
  positionId: number;
  positionAddress: string;
  owner: string;
  collateralAmount: string;
  collateralAmountRaw: string;
  debtAmount: string;
  debtAmountRaw: string;
  healthRatio: number | null;
  healthRatioText: string;
  liquidationStatus: 'safe' | 'at_risk' | 'liquidatable' | 'liquidated' | 'unknown';
  ltvBps: number;
  liquidationThresholdBps: number;
  collateralValueUsd?: string;
  debtValueUsd?: string;
  asOf?: string;
}

export interface JupiterLendBorrowHealthPreview {
  vaultId: number;
  vaultAddress: string;
  positionId?: number;
  walletAddress: string;
  collateralDelta?: string;
  debtDelta?: string;
  before?: {
    collateralAmount: string;
    debtAmount: string;
    healthRatio: number | null;
    healthRatioText: string;
    liquidationStatus: JupiterLendBorrowPositionSnapshot['liquidationStatus'];
  };
  after: {
    collateralAmount: string;
    debtAmount: string;
    healthRatio: number | null;
    healthRatioText: string;
    liquidationStatus: JupiterLendBorrowPositionSnapshot['liquidationStatus'];
  };
  minHealthRatio: number;
  maxLtvBps?: number;
  projectedLtvBps?: number;
  blocked: boolean;
  warnings: string[];
  oracle?: JupiterLendOracleSnapshot;
  simulatedAt: string;
}

export interface JupiterLendBuildOptions {
  walletAddress: string;
  cluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
}

export interface JupiterLendBuildResult {
  transactionBase64: string;
  refreshAtExecution: boolean;
  notes?: string[];
}

export interface JupiterLendEarnDepositArgs extends JupiterLendBuildOptions {
  assetMint: string;
  amount: string;
  amountRaw: string;
  minSharesOut?: string;
}

export interface JupiterLendEarnWithdrawArgs extends JupiterLendBuildOptions {
  assetMint: string;
  amount: string;
  amountRaw: string;
  minUnderlyingOut?: string;
}

export interface JupiterLendEarnMintArgs extends JupiterLendBuildOptions {
  assetMint: string;
  shares: string;
  sharesRaw: string;
}

export interface JupiterLendEarnRedeemArgs extends JupiterLendBuildOptions {
  assetMint: string;
  shares: string;
  sharesRaw: string;
  minUnderlyingOut?: string;
}

export interface JupiterLendBorrowCreatePositionArgs extends JupiterLendBuildOptions {
  vaultId: number;
  collateralAmount?: string;
  collateralAmountRaw?: string;
  borrowAmount?: string;
  borrowAmountRaw?: string;
}

export interface JupiterLendBorrowDepositCollateralArgs extends JupiterLendBuildOptions {
  vaultId: number;
  positionId: number;
  amount: string;
  amountRaw: string;
}

export interface JupiterLendBorrowBorrowArgs extends JupiterLendBuildOptions {
  vaultId: number;
  positionId: number;
  amount: string;
  amountRaw: string;
  minHealthRatio: number;
}

export interface JupiterLendBorrowRepayArgs extends JupiterLendBuildOptions {
  vaultId: number;
  positionId: number;
  amount: string;
  amountRaw: string;
  repayAll?: boolean;
}

export interface JupiterLendBorrowWithdrawCollateralArgs extends JupiterLendBuildOptions {
  vaultId: number;
  positionId: number;
  amount: string;
  amountRaw: string;
  minHealthRatio: number;
}

export interface JupiterLendClient {
  /** REST-backed earn reads. */
  getEarnTokens(input: { includeInactive?: boolean; assetMint?: string }): Promise<JupiterLendEarnTokenSnapshot[]>;
  getEarnTokenDetail(input: { assetMint: string }): Promise<JupiterLendEarnTokenSnapshot>;
  getEarnPositions(input: {
    walletAddress: string;
    assetMint?: string;
  }): Promise<JupiterLendEarnPositionSnapshot[]>;
  getEarnEarnings(input: {
    walletAddress: string;
    assetMint?: string;
    from?: string;
    to?: string;
  }): Promise<JupiterLendEarnEarningsSnapshot[]>;
  /** SDK-backed borrow reads. */
  getBorrowVaults(input: {
    vaultId?: number;
    supplyMint?: string;
    borrowMint?: string;
    includeUnavailable?: boolean;
  }): Promise<JupiterLendBorrowVaultSnapshot[]>;
  getBorrowVaultDetail(input: { vaultId: number }): Promise<JupiterLendBorrowVaultSnapshot>;
  getBorrowPositions(input: {
    walletAddress: string;
    vaultId?: number;
    positionId?: number;
  }): Promise<JupiterLendBorrowPositionSnapshot[]>;
  previewBorrowHealth(input: {
    walletAddress: string;
    vaultId: number;
    positionId?: number;
    collateralDelta?: string;
    debtDelta?: string;
    minHealthRatio: number;
    maxLtvBps?: number;
  }): Promise<JupiterLendBorrowHealthPreview>;
  /** Action builders. Earn deposit/withdraw should prefer REST endpoints when available. */
  buildEarnDeposit(args: JupiterLendEarnDepositArgs): Promise<JupiterLendBuildResult>;
  buildEarnWithdraw(args: JupiterLendEarnWithdrawArgs): Promise<JupiterLendBuildResult>;
  buildEarnMint(args: JupiterLendEarnMintArgs): Promise<JupiterLendBuildResult>;
  buildEarnRedeem(args: JupiterLendEarnRedeemArgs): Promise<JupiterLendBuildResult>;
  buildBorrowCreatePosition(args: JupiterLendBorrowCreatePositionArgs): Promise<JupiterLendBuildResult>;
  buildBorrowDepositCollateral(args: JupiterLendBorrowDepositCollateralArgs): Promise<JupiterLendBuildResult>;
  buildBorrowBorrow(args: JupiterLendBorrowBorrowArgs): Promise<JupiterLendBuildResult>;
  buildBorrowRepay(args: JupiterLendBorrowRepayArgs): Promise<JupiterLendBuildResult>;
  buildBorrowWithdrawCollateral(args: JupiterLendBorrowWithdrawCollateralArgs): Promise<JupiterLendBuildResult>;
}

export type JupiterLendClientFactory = (
  walletAddress: string,
  config?: AgentWalletConfig,
) => Promise<JupiterLendClient> | JupiterLendClient;

const SDK_UNAVAILABLE_REASON =
  '@jup-ag/lend-read and @jup-ag/lend are not installed. Install the optional Jupiter Lend SDK or inject a mock client for tests.';
const REST_UNAVAILABLE_REASON =
  'Jupiter Lend Borrow write endpoints are not yet exposed by REST and the Lend SDK is not available in this host.';

const require = createRequire(import.meta.url);

type BnCtor = new (value: string | number | bigint) => unknown;

interface JupiterLendEarnSdkBundle {
  getLendingTokens(input: {
    connection: Connection;
  }): Promise<PublicKey[]>;
  getLendingTokenDetails(input: {
    lendingToken: PublicKey;
    connection: Connection;
  }): Promise<{
    address: PublicKey;
    asset: PublicKey;
    decimals: number;
    totalAssets?: unknown;
    totalSupply?: unknown;
    convertToShares?: unknown;
    convertToAssets?: unknown;
  }>;
  getDepositIxs(input: {
    amount: unknown;
    asset: PublicKey;
    signer: PublicKey;
    connection: Connection;
  }): Promise<{ ixs: TransactionInstruction[] }>;
  getWithdrawIxs(input: {
    amount: unknown;
    asset: PublicKey;
    signer: PublicKey;
    connection: Connection;
  }): Promise<{ ixs: TransactionInstruction[] }>;
  getMintIxs(input: {
    shares: unknown;
    asset: PublicKey;
    signer: PublicKey;
    connection: Connection;
  }): Promise<{ ixs: TransactionInstruction[] }>;
  getRedeemIxs(input: {
    shares: unknown;
    asset: PublicKey;
    signer: PublicKey;
    connection: Connection;
  }): Promise<{ ixs: TransactionInstruction[] }>;
  BN: BnCtor;
}

let cachedEarnSdk: JupiterLendEarnSdkBundle | undefined;

export async function loadJupiterLendEarnSdkForSmokeTest(): Promise<JupiterLendEarnSdkBundle> {
  if (cachedEarnSdk) return cachedEarnSdk;
  const earn = await import('@jup-ag/lend/earn') as Partial<JupiterLendEarnSdkBundle>;
  const BN = loadJupiterLendBnCtor();
  if (
    typeof earn.getLendingTokens !== 'function' ||
    typeof earn.getLendingTokenDetails !== 'function' ||
    typeof earn.getDepositIxs !== 'function' ||
    typeof earn.getWithdrawIxs !== 'function' ||
    typeof earn.getMintIxs !== 'function' ||
    typeof earn.getRedeemIxs !== 'function'
  ) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'sdk_unavailable',
      '@jup-ag/lend/earn did not expose the Earn instruction builders.',
    );
  }
  cachedEarnSdk = {
    getLendingTokens: earn.getLendingTokens,
    getLendingTokenDetails: earn.getLendingTokenDetails,
    getDepositIxs: earn.getDepositIxs,
    getWithdrawIxs: earn.getWithdrawIxs,
    getMintIxs: earn.getMintIxs,
    getRedeemIxs: earn.getRedeemIxs,
    BN,
  };
  return cachedEarnSdk;
}

export function __resetJupiterLendEarnSdkCacheForTests(): void {
  cachedEarnSdk = undefined;
}

export function __setJupiterLendEarnSdkForTests(bundle: JupiterLendEarnSdkBundle | undefined): void {
  cachedEarnSdk = bundle;
}

export type { JupiterLendEarnSdkBundle };

export function describeJupiterLendSdkUnavailableReason(): string | undefined {
  try {
    require.resolve('@jup-ag/lend-read');
    require.resolve('@jup-ag/lend');
    return undefined;
  } catch {
    return SDK_UNAVAILABLE_REASON;
  }
}

export function describeJupiterLendReadUnavailableReason(): string | undefined {
  try {
    require.resolve('@jup-ag/lend-read');
    return undefined;
  } catch {
    return SDK_UNAVAILABLE_REASON;
  }
}

function areJupiterLendEarnSdkDependenciesResolvable(): boolean {
  try {
    require.resolve('@jup-ag/lend/earn');
    loadJupiterLendBnCtor();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Jupiter Lend BORROW SDK wiring
// Writes go through `@jup-ag/lend/borrow` (`getOperateIx` — one entry point for
// deposit/borrow/repay/withdraw, and with positionId:0 it bundles init+operate into one
// versioned tx). Reads go through `@jup-ag/lend-read` (`Client.vault`). Amounts passed to
// getOperateIx are RAW in the mint's own decimals — the SDK scales internally.
// ---------------------------------------------------------------------------

// The bn.js surface we consume. Values from the SDK are bn.js instances; we treat them
// through this minimal interface and only call methods we know exist.
interface BorrowBn {
  toString(radix?: number): string;
  toNumber(): number;
  isZero(): boolean;
  isNeg(): boolean;
  neg(): BorrowBn;
  add(other: BorrowBn): BorrowBn;
  mul(other: BorrowBn): BorrowBn;
  div(other: BorrowBn): BorrowBn;
  gt(other: BorrowBn): boolean;
}
type BorrowBnCtor = new (value: string | number | bigint) => BorrowBn;

interface JupiterLendBorrowSdkBundle {
  getInitPositionIx(input: { vaultId: number; connection: Connection; signer: PublicKey }): Promise<{ ix: TransactionInstruction; nftId: number }>;
  getOperateIx(input: {
    vaultId: number;
    positionId: number;
    colAmount: BorrowBn;
    debtAmount: BorrowBn;
    connection: Connection;
    signer: PublicKey;
    recipient?: PublicKey;
    positionOwner?: PublicKey;
  }): Promise<{ ixs: TransactionInstruction[]; addressLookupTableAccounts: AddressLookupTableAccount[]; nftId: number }>;
  getCurrentPosition(input: { vaultId: number; positionId: number; connection: Connection }): Promise<{ colRaw: BorrowBn; debtRaw: BorrowBn; userLiquidationStatus?: boolean }>;
  readOraclePrice(input: { connection: Connection; signer: PublicKey; oracle: PublicKey }): Promise<{ oraclePriceOperate: BorrowBn; oraclePriceLiquidate: BorrowBn }>;
  MAX_REPAY_AMOUNT: BorrowBn;
  MAX_WITHDRAW_AMOUNT: BorrowBn;
  BN: BorrowBnCtor;
}

// Minimal read-shapes we consume from @jup-ag/lend-read `VaultEntireData` / `NftPosition`.
// Nested numeric fields may be bn.js OR plain numbers depending on the field — read them
// through `bnLikeToNumber` / `bnLikeToBn` which handle both.
interface LendReadVaultData {
  vault: PublicKey;
  constantViews: { vaultId: number; supplyToken: PublicKey; borrowToken: PublicKey };
  configs: {
    collateralFactor: unknown;
    liquidationThreshold: unknown;
    liquidationPenalty: unknown;
    borrowFee: unknown;
    oracle: PublicKey;
  };
  exchangePricesAndRates: { borrowRateVault: unknown; supplyRateVault: unknown };
  limitsAndAvailability: { borrowable: unknown; withdrawable: unknown };
  totalSupplyAndBorrow?: { totalSupplyVault?: unknown; totalBorrowVault?: unknown };
}
interface LendReadNftPosition {
  nftId: number;
  owner: PublicKey;
  supply: unknown;
  borrow: unknown;
  isLiquidated?: boolean;
  vault: LendReadVaultData;
}
interface LendReadVaultApi {
  getAllVaults(): Promise<LendReadVaultData[]>;
  getVaultByVaultId(vaultId: number): Promise<LendReadVaultData>;
  getAllUserPositions(user: PublicKey): Promise<LendReadNftPosition[]>;
  getPositionByVaultId(vaultId: number, nftId: number): Promise<LendReadNftPosition>;
  getFinalPosition(input: { vaultId: number; positionId: number; newColAmount: BorrowBn; newDebtAmount: BorrowBn }): Promise<{ colRaw: BorrowBn; debtRaw: BorrowBn }>;
}
interface LendReadClientApi {
  vault: LendReadVaultApi;
}

let cachedBorrowSdk: JupiterLendBorrowSdkBundle | undefined;
let cachedLendReadClient: LendReadClientApi | undefined;

export async function loadJupiterLendBorrowSdk(): Promise<JupiterLendBorrowSdkBundle> {
  if (cachedBorrowSdk) return cachedBorrowSdk;
  const borrow = (await import('@jup-ag/lend/borrow')) as Partial<JupiterLendBorrowSdkBundle>;
  const BN = loadJupiterLendBnCtor() as unknown as BorrowBnCtor;
  if (
    typeof borrow.getInitPositionIx !== 'function' ||
    typeof borrow.getOperateIx !== 'function' ||
    typeof borrow.readOraclePrice !== 'function' ||
    borrow.MAX_REPAY_AMOUNT === undefined ||
    borrow.MAX_WITHDRAW_AMOUNT === undefined
  ) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', '@jup-ag/lend/borrow did not expose the Borrow instruction builders.');
  }
  cachedBorrowSdk = {
    getInitPositionIx: borrow.getInitPositionIx,
    getOperateIx: borrow.getOperateIx,
    getCurrentPosition: borrow.getCurrentPosition!,
    readOraclePrice: borrow.readOraclePrice,
    MAX_REPAY_AMOUNT: borrow.MAX_REPAY_AMOUNT,
    MAX_WITHDRAW_AMOUNT: borrow.MAX_WITHDRAW_AMOUNT,
    BN,
  };
  return cachedBorrowSdk;
}

async function getLendReadClient(connection: Connection): Promise<LendReadClientApi> {
  if (cachedLendReadClient) return cachedLendReadClient;
  const mod = (await import('@jup-ag/lend-read')) as { Client: new (rpc: Connection | string) => LendReadClientApi };
  if (typeof mod.Client !== 'function') {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', '@jup-ag/lend-read did not expose the read Client.');
  }
  cachedLendReadClient = new mod.Client(connection);
  return cachedLendReadClient;
}

export function areJupiterLendBorrowSdkDependenciesResolvable(): boolean {
  try {
    require.resolve('@jup-ag/lend/borrow');
    require.resolve('@jup-ag/lend-read');
    loadJupiterLendBnCtor();
    return true;
  } catch {
    return false;
  }
}

export function __resetJupiterLendBorrowSdkCacheForTests(): void {
  cachedBorrowSdk = undefined;
  cachedLendReadClient = undefined;
}
export function __setJupiterLendBorrowSdkForTests(bundle: JupiterLendBorrowSdkBundle | undefined): void {
  cachedBorrowSdk = bundle;
}
export function __setJupiterLendReadClientForTests(client: LendReadClientApi | undefined): void {
  cachedLendReadClient = client;
}
export type { JupiterLendBorrowSdkBundle, LendReadClientApi, LendReadVaultData, LendReadNftPosition, BorrowBn };

class JupiterLendUnavailable implements JupiterLendClient {
  protected deny(method: string): never {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'sdk_unavailable',
      `Jupiter Lend ${method} is not available: ${SDK_UNAVAILABLE_REASON}`,
    );
  }

  async getEarnTokens(_input: Parameters<JupiterLendClient['getEarnTokens']>[0]): Promise<JupiterLendEarnTokenSnapshot[]> {
    this.deny('earn tokens read');
  }
  async getEarnTokenDetail(_input: Parameters<JupiterLendClient['getEarnTokenDetail']>[0]): Promise<JupiterLendEarnTokenSnapshot> {
    this.deny('earn token detail read');
  }
  async getEarnPositions(_input: Parameters<JupiterLendClient['getEarnPositions']>[0]): Promise<JupiterLendEarnPositionSnapshot[]> {
    this.deny('earn positions read');
  }
  async getEarnEarnings(_input: Parameters<JupiterLendClient['getEarnEarnings']>[0]): Promise<JupiterLendEarnEarningsSnapshot[]> {
    this.deny('earn earnings read');
  }
  async getBorrowVaults(_input: Parameters<JupiterLendClient['getBorrowVaults']>[0]): Promise<JupiterLendBorrowVaultSnapshot[]> {
    this.deny('borrow vaults read');
  }
  async getBorrowVaultDetail(_input: Parameters<JupiterLendClient['getBorrowVaultDetail']>[0]): Promise<JupiterLendBorrowVaultSnapshot> {
    this.deny('borrow vault detail read');
  }
  async getBorrowPositions(_input: Parameters<JupiterLendClient['getBorrowPositions']>[0]): Promise<JupiterLendBorrowPositionSnapshot[]> {
    this.deny('borrow positions read');
  }
  async previewBorrowHealth(_input: Parameters<JupiterLendClient['previewBorrowHealth']>[0]): Promise<JupiterLendBorrowHealthPreview> {
    this.deny('borrow health preview');
  }
  async buildEarnDeposit(_args: JupiterLendEarnDepositArgs): Promise<JupiterLendBuildResult> {
    this.deny('earn deposit build');
  }
  async buildEarnWithdraw(_args: JupiterLendEarnWithdrawArgs): Promise<JupiterLendBuildResult> {
    this.deny('earn withdraw build');
  }
  async buildEarnMint(_args: JupiterLendEarnMintArgs): Promise<JupiterLendBuildResult> {
    this.deny('earn mint build');
  }
  async buildEarnRedeem(_args: JupiterLendEarnRedeemArgs): Promise<JupiterLendBuildResult> {
    this.deny('earn redeem build');
  }
  async buildBorrowCreatePosition(_args: JupiterLendBorrowCreatePositionArgs): Promise<JupiterLendBuildResult> {
    this.deny('borrow create position build');
  }
  async buildBorrowDepositCollateral(_args: JupiterLendBorrowDepositCollateralArgs): Promise<JupiterLendBuildResult> {
    this.deny('borrow deposit collateral build');
  }
  async buildBorrowBorrow(_args: JupiterLendBorrowBorrowArgs): Promise<JupiterLendBuildResult> {
    this.deny('borrow borrow build');
  }
  async buildBorrowRepay(_args: JupiterLendBorrowRepayArgs): Promise<JupiterLendBuildResult> {
    this.deny('borrow repay build');
  }
  async buildBorrowWithdrawCollateral(_args: JupiterLendBorrowWithdrawCollateralArgs): Promise<JupiterLendBuildResult> {
    this.deny('borrow withdraw collateral build');
  }
}

class JupiterLendRestClient extends JupiterLendUnavailable {
  constructor(private readonly config: AgentWalletConfig) {
    super();
  }

  override async buildEarnDeposit(input: JupiterLendEarnDepositArgs): Promise<JupiterLendBuildResult> {
    return this.buildEarnTransaction('deposit', {
      asset: input.assetMint,
      signer: input.walletAddress,
      amount: input.amountRaw,
    });
  }

  override async buildEarnWithdraw(input: JupiterLendEarnWithdrawArgs): Promise<JupiterLendBuildResult> {
    return this.buildEarnTransaction('withdraw', {
      asset: input.assetMint,
      signer: input.walletAddress,
      amount: input.amountRaw,
    });
  }

  override async buildEarnMint(input: JupiterLendEarnMintArgs): Promise<JupiterLendBuildResult> {
    return this.buildEarnTransaction('mint', {
      asset: input.assetMint,
      signer: input.walletAddress,
      shares: input.sharesRaw,
    });
  }

  override async buildEarnRedeem(input: JupiterLendEarnRedeemArgs): Promise<JupiterLendBuildResult> {
    return this.buildEarnTransaction('redeem', {
      asset: input.assetMint,
      signer: input.walletAddress,
      shares: input.sharesRaw,
    });
  }

  override async buildBorrowCreatePosition(_args: JupiterLendBorrowCreatePositionArgs): Promise<JupiterLendBuildResult> {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', REST_UNAVAILABLE_REASON);
  }

  override async buildBorrowDepositCollateral(_args: JupiterLendBorrowDepositCollateralArgs): Promise<JupiterLendBuildResult> {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', REST_UNAVAILABLE_REASON);
  }

  override async buildBorrowBorrow(_args: JupiterLendBorrowBorrowArgs): Promise<JupiterLendBuildResult> {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', REST_UNAVAILABLE_REASON);
  }

  override async buildBorrowRepay(_args: JupiterLendBorrowRepayArgs): Promise<JupiterLendBuildResult> {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', REST_UNAVAILABLE_REASON);
  }

  override async buildBorrowWithdrawCollateral(_args: JupiterLendBorrowWithdrawCollateralArgs): Promise<JupiterLendBuildResult> {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', REST_UNAVAILABLE_REASON);
  }

  private async buildEarnTransaction(
    operation: 'deposit' | 'withdraw' | 'mint' | 'redeem',
    body: Record<string, unknown>,
  ): Promise<JupiterLendBuildResult> {
    const response = await jupiterFetchJson(this.config, 'lend', `/earn/${operation}`, {
      method: 'POST',
      body,
    });
    const transactionBase64 = readTransactionBase64(response, operation);
    return {
      transactionBase64,
      refreshAtExecution: true,
      notes: ['Built via Jupiter Lend Earn REST API; refresh before wallet signing to avoid stale blockhashes.'],
    };
  }
}

class JupiterLendSdkClient extends JupiterLendRestClient {
  private readonly connection: Connection;

  constructor(config: AgentWalletConfig) {
    super(config);
    this.connection = new Connection(config.rpcUrl, 'confirmed');
  }

  override async getEarnTokens(input: Parameters<JupiterLendClient['getEarnTokens']>[0]): Promise<JupiterLendEarnTokenSnapshot[]> {
    const tokens = await this.loadEarnTokenSnapshots();
    if (!input.assetMint) return tokens;
    const requested = new PublicKey(input.assetMint);
    return tokens.filter((token) => new PublicKey(token.assetMint).equals(requested));
  }

  override async getEarnTokenDetail(input: Parameters<JupiterLendClient['getEarnTokenDetail']>[0]): Promise<JupiterLendEarnTokenSnapshot> {
    const requestedAsset = new PublicKey(input.assetMint);
    const [lendingToken] = PublicKey.findProgramAddressSync(
      [Buffer.from('f_token_mint'), requestedAsset.toBuffer()],
      JUPITER_LEND_EARN_PROGRAM_ID,
    );
    const sdk = await loadJupiterLendEarnSdkForSmokeTest();
    let detail: Awaited<ReturnType<JupiterLendEarnSdkBundle['getLendingTokenDetails']>>;
    try {
      detail = await sdk.getLendingTokenDetails({ lendingToken, connection: this.connection });
    } catch (err) {
      // The SDK's exchange-price math (getNewExchangePrice / getRewardsRate) divides by
      // on-chain values that can be 0 for low-TVL or freshly-initialized pools, surfacing
      // as bn.js "Assertion failed" with no further context. Reframe as sdk_unavailable so
      // lendEarn.ts:getEarnTokenDetail falls back to the REST snapshot path.
      throw new AdapterError(
        JUPITER_ADAPTER_ID,
        'sdk_unavailable',
        `Jupiter Lend Earn SDK could not load pool details for ${input.assetMint}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!detail?.asset || detail.asset.toBase58() !== requestedAsset.toBase58()) {
      throw new AdapterError(
        JUPITER_ADAPTER_ID,
        'unknown_asset',
        `Jupiter Lend Earn token "${input.assetMint}" was not found.`,
      );
    }
    return toEarnTokenSnapshot(detail, new Date().toISOString());
  }

  override async buildEarnDeposit(input: JupiterLendEarnDepositArgs): Promise<JupiterLendBuildResult> {
    return this.buildEarnSdkTransaction('deposit', input, input.amountRaw);
  }

  override async buildEarnWithdraw(input: JupiterLendEarnWithdrawArgs): Promise<JupiterLendBuildResult> {
    return this.buildEarnSdkTransaction('withdraw', input, input.amountRaw);
  }

  override async buildEarnMint(input: JupiterLendEarnMintArgs): Promise<JupiterLendBuildResult> {
    return this.buildEarnSdkTransaction('mint', input, input.sharesRaw);
  }

  override async buildEarnRedeem(input: JupiterLendEarnRedeemArgs): Promise<JupiterLendBuildResult> {
    return this.buildEarnSdkTransaction('redeem', input, input.sharesRaw);
  }

  private async buildEarnSdkTransaction(
    operation: 'deposit' | 'withdraw' | 'mint' | 'redeem',
    input: JupiterLendEarnDepositArgs | JupiterLendEarnWithdrawArgs | JupiterLendEarnMintArgs | JupiterLendEarnRedeemArgs,
    rawAmount: string,
  ): Promise<JupiterLendBuildResult> {
    const sdk = await loadJupiterLendEarnSdkForSmokeTest();
    const asset = new PublicKey(input.assetMint);
    const signer = new PublicKey(input.walletAddress);
    const amount = new sdk.BN(rawAmount);
    const isWsol = asset.toBase58() === WSOL_MINT_BASE58;
    // @jup-ag/lend@0.1.9 getDepositIxs emits only the f-token ATA + deposit ix; it never
    // wraps native SOL into the user's wSOL ATA. Mint requires a shares→underlying
    // conversion that we don't trust off a stale snapshot, so defer it.
    if (isWsol && operation === 'mint') {
      throw new AdapterError(
        JUPITER_ADAPTER_ID,
        'invalid_request',
        'Jupiter Lend Earn mint with native SOL is not yet supported — use earn_deposit instead.',
      );
    }
    const result = operation === 'deposit'
      ? await sdk.getDepositIxs({ amount, asset, signer, connection: this.connection })
      : operation === 'withdraw'
        ? await sdk.getWithdrawIxs({ amount, asset, signer, connection: this.connection })
        : operation === 'mint'
          ? await sdk.getMintIxs({ shares: amount, asset, signer, connection: this.connection })
          : await sdk.getRedeemIxs({ shares: amount, asset, signer, connection: this.connection });
    const lamportsToWrap = isWsol && operation === 'deposit' ? BigInt(rawAmount) : 0n;
    const unwrapAfter = isWsol && (operation === 'withdraw' || operation === 'redeem');
    const transactionBase64 = await serializeEarnInstructions(this.connection, signer, result.ixs, {
      operation,
      asset,
      lamportsToWrap,
      unwrapAfter,
    });
    return {
      transactionBase64,
      refreshAtExecution: true,
      notes: ['Built locally with @jup-ag/lend/earn SDK; refresh before wallet signing to avoid stale blockhashes.'],
    };
  }

  private async loadEarnTokenSnapshots(): Promise<JupiterLendEarnTokenSnapshot[]> {
    const sdk = await loadJupiterLendEarnSdkForSmokeTest();
    const lendingTokens = await sdk.getLendingTokens({ connection: this.connection });
    const asOf = new Date().toISOString();
    const settled = await Promise.allSettled(lendingTokens.map(async (lendingToken) => {
      const detail = await sdk.getLendingTokenDetails({
        lendingToken,
        connection: this.connection,
      });
      return toEarnTokenSnapshot(detail, asOf);
    }));
    const snapshots: JupiterLendEarnTokenSnapshot[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        snapshots.push(result.value);
        return;
      }
      const lendingToken = lendingTokens[index]?.toBase58() ?? '<unknown>';
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      // One pool's broken on-chain state (e.g. uninitialized exchange prices that trip
      // bn.js "Assertion failed") must not blank the entire Earn list.
      console.warn(`Jupiter Lend Earn snapshot skipped for ${lendingToken}: ${reason}`);
    });
    return snapshots.sort((left, right) =>
      (jupiterEarnSymbolRank(left.tokenSymbol) - jupiterEarnSymbolRank(right.tokenSymbol)) ||
      left.assetMint.localeCompare(right.assetMint)
    );
  }

  // ---- Borrow reads (via @jup-ag/lend-read) ----
  override async getBorrowVaults(input: Parameters<JupiterLendClient['getBorrowVaults']>[0]): Promise<JupiterLendBorrowVaultSnapshot[]> {
    const client = await getLendReadClient(this.connection);
    const borrowSdk = await loadJupiterLendBorrowSdk();
    const vaults = await client.vault.getAllVaults();
    const filtered = vaults.filter((v) =>
      (input.vaultId === undefined || v.constantViews.vaultId === input.vaultId) &&
      (input.supplyMint === undefined || v.constantViews.supplyToken.toBase58() === input.supplyMint) &&
      (input.borrowMint === undefined || v.constantViews.borrowToken.toBase58() === input.borrowMint));
    const settled = await Promise.allSettled(
      filtered.map((v) => toBorrowVaultSnapshot(v, this.connection, borrowSdk, READ_ONLY_SIGNER)),
    );
    const out: JupiterLendBorrowVaultSnapshot[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') out.push(r.value);
      // A single uninitialized/low-TVL vault must not blank the whole list (mirror the earn behavior).
      else console.warn(`Jupiter Lend Borrow vault snapshot skipped for vault ${filtered[i]?.constantViews.vaultId}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    });
    return out;
  }

  override async getBorrowVaultDetail(input: Parameters<JupiterLendClient['getBorrowVaultDetail']>[0]): Promise<JupiterLendBorrowVaultSnapshot> {
    const client = await getLendReadClient(this.connection);
    const borrowSdk = await loadJupiterLendBorrowSdk();
    try {
      const vault = await client.vault.getVaultByVaultId(input.vaultId);
      return await toBorrowVaultSnapshot(vault, this.connection, borrowSdk, READ_ONLY_SIGNER);
    } catch (err) {
      throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', `Jupiter Lend Borrow vault ${input.vaultId} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  override async getBorrowPositions(input: Parameters<JupiterLendClient['getBorrowPositions']>[0]): Promise<JupiterLendBorrowPositionSnapshot[]> {
    const client = await getLendReadClient(this.connection);
    const borrowSdk = await loadJupiterLendBorrowSdk();
    const owner = new PublicKey(input.walletAddress);
    const minHealthRatio = 1; // display-only; the action layer re-derives health with the configured min
    if (input.vaultId !== undefined && input.positionId !== undefined) {
      const position = await client.vault.getPositionByVaultId(input.vaultId, input.positionId);
      return [await toBorrowPositionSnapshot(position, this.connection, borrowSdk, owner, minHealthRatio)];
    }
    const positions = await client.vault.getAllUserPositions(owner);
    const filtered = input.vaultId !== undefined
      ? positions.filter((p) => p.vault.constantViews.vaultId === input.vaultId)
      : positions;
    const settled = await Promise.allSettled(
      filtered.map((p) => toBorrowPositionSnapshot(p, this.connection, borrowSdk, owner, minHealthRatio)),
    );
    const out: JupiterLendBorrowPositionSnapshot[] = [];
    settled.forEach((r) => { if (r.status === 'fulfilled') out.push(r.value); });
    return out;
  }

  override async previewBorrowHealth(input: Parameters<JupiterLendClient['previewBorrowHealth']>[0]): Promise<JupiterLendBorrowHealthPreview> {
    const client = await getLendReadClient(this.connection);
    const borrowSdk = await loadJupiterLendBorrowSdk();
    const owner = new PublicKey(input.walletAddress);
    const vaultData = await client.vault.getVaultByVaultId(input.vaultId);
    const supplyMint = vaultData.constantViews.supplyToken;
    const borrowMint = vaultData.constantViews.borrowToken;
    const [supplyDecimals, borrowDecimals] = await Promise.all([
      getMintDecimals(this.connection, supplyMint),
      getMintDecimals(this.connection, borrowMint),
    ]);
    const oracle = await readVaultOracle(borrowSdk, this.connection, owner, vaultData.configs.oracle);
    const liquidationThreshold = bnLikeToNumber(vaultData.configs.liquidationThreshold);
    const collateralFactor = bnLikeToNumber(vaultData.configs.collateralFactor);
    const borrowFee = bnLikeToNumber(vaultData.configs.borrowFee);
    const colDeltaRaw = decimalToRaw(input.collateralDelta, supplyDecimals);
    const debtDeltaRaw = decimalToRaw(input.debtDelta, borrowDecimals);

    let beforeColRaw = 0n;
    let beforeDebtRaw = 0n;
    let beforeLiquidated = false;
    if (input.positionId !== undefined) {
      try {
        const p = await client.vault.getPositionByVaultId(input.vaultId, input.positionId);
        beforeColRaw = bnLikeToBigInt(p.supply);
        beforeDebtRaw = bnLikeToBigInt(p.borrow);
        beforeLiquidated = p.isLiquidated === true;
      } catch { /* position not found yet → treat as zeros (create flow) */ }
    }
    const afterColRaw = beforeColRaw + colDeltaRaw;
    // Drawing new debt incurs the vault's borrow fee (added to owed debt).
    const borrowFeeRaw = debtDeltaRaw > 0n && Number.isFinite(borrowFee)
      ? (debtDeltaRaw * BigInt(Math.max(0, Math.round(borrowFee)))) / BORROW_FEE_DIVISOR
      : 0n;
    const afterDebtRaw = beforeDebtRaw + debtDeltaRaw + borrowFeeRaw;

    const beforeHealth = computeBorrowHealth({ colRaw: beforeColRaw, debtRaw: beforeDebtRaw, oraclePrice: oracle.liquidatePrice, liquidationThreshold, minHealthRatio: input.minHealthRatio, isLiquidated: beforeLiquidated });
    const afterHealth = computeBorrowHealth({ colRaw: afterColRaw < 0n ? 0n : afterColRaw, debtRaw: afterDebtRaw < 0n ? 0n : afterDebtRaw, oraclePrice: oracle.liquidatePrice, liquidationThreshold, minHealthRatio: input.minHealthRatio, isLiquidated: beforeLiquidated });
    const maxLtvBps = input.maxLtvBps ?? (Number.isFinite(collateralFactor) ? Math.round(collateralFactor * 10) : undefined);
    const projectedLtvBps = afterHealth.ltvBps;
    const warnings: string[] = [];
    if (afterHealth.liquidationStatus === 'unknown') warnings.push('Projected Jupiter Borrow liquidation status is unknown.');
    else if (afterHealth.healthRatio !== null && afterHealth.healthRatio < input.minHealthRatio) warnings.push(`Projected health ratio ${afterHealth.healthRatioText} is below minimum ${input.minHealthRatio}.`);
    if (maxLtvBps !== undefined && projectedLtvBps > maxLtvBps) warnings.push(`Projected LTV ${(projectedLtvBps / 100).toFixed(1)}% exceeds max ${(maxLtvBps / 100).toFixed(1)}%.`);
    const blocked =
      afterHealth.liquidationStatus === 'liquidatable' ||
      afterHealth.liquidationStatus === 'liquidated' ||
      afterHealth.liquidationStatus === 'unknown' ||
      (afterHealth.healthRatio !== null && afterHealth.healthRatio < input.minHealthRatio) ||
      (maxLtvBps !== undefined && projectedLtvBps > maxLtvBps);
    return {
      vaultId: input.vaultId,
      vaultAddress: vaultData.vault.toBase58(),
      ...(input.positionId !== undefined ? { positionId: input.positionId } : {}),
      walletAddress: input.walletAddress,
      ...(input.collateralDelta !== undefined ? { collateralDelta: input.collateralDelta } : {}),
      ...(input.debtDelta !== undefined ? { debtDelta: input.debtDelta } : {}),
      ...(input.positionId !== undefined
        ? { before: { collateralAmount: formatRawAmount(beforeColRaw, supplyDecimals), debtAmount: formatRawAmount(beforeDebtRaw, borrowDecimals), healthRatio: beforeHealth.healthRatio, healthRatioText: beforeHealth.healthRatioText, liquidationStatus: beforeHealth.liquidationStatus } }
        : {}),
      after: { collateralAmount: formatRawAmount(afterColRaw < 0n ? 0n : afterColRaw, supplyDecimals), debtAmount: formatRawAmount(afterDebtRaw < 0n ? 0n : afterDebtRaw, borrowDecimals), healthRatio: afterHealth.healthRatio, healthRatioText: afterHealth.healthRatioText, liquidationStatus: afterHealth.liquidationStatus },
      minHealthRatio: input.minHealthRatio,
      ...(maxLtvBps !== undefined ? { maxLtvBps } : {}),
      projectedLtvBps,
      blocked,
      warnings,
      oracle: oracle.snapshot,
      simulatedAt: new Date().toISOString(),
    };
  }

  // ---- Borrow writes (all via getOperateIx; create bundles init+deposit+borrow) ----
  private async operateAndSerialize(
    operation: JupiterLendOperation,
    walletAddress: string,
    vaultId: number,
    positionId: number,
    colAmount: BorrowBn,
    debtAmount: BorrowBn,
    wrapLamports: bigint,
    unwrapAfter: boolean,
  ): Promise<JupiterLendBuildResult> {
    const borrowSdk = await loadJupiterLendBorrowSdk();
    const signer = new PublicKey(walletAddress);
    const { ixs, addressLookupTableAccounts } = await borrowSdk.getOperateIx({
      vaultId,
      positionId,
      colAmount,
      debtAmount,
      connection: this.connection,
      signer,
    });
    const transactionBase64 = await serializeBorrowInstructions(this.connection, signer, ixs, addressLookupTableAccounts, {
      operation,
      wrapLamports,
      unwrapAfter,
    });
    return { transactionBase64, refreshAtExecution: true, notes: ['Built locally with @jup-ag/lend/borrow SDK; refresh before signing to avoid stale blockhashes.'] };
  }

  // Resolve the vault's collateral/debt mints so we can decide wSOL wrap/unwrap.
  private async borrowVaultMints(vaultId: number): Promise<{ supplyIsWsol: boolean; borrowIsWsol: boolean }> {
    const client = await getLendReadClient(this.connection);
    const vault = await client.vault.getVaultByVaultId(vaultId);
    return {
      supplyIsWsol: vault.constantViews.supplyToken.toBase58() === WSOL_MINT_BASE58,
      borrowIsWsol: vault.constantViews.borrowToken.toBase58() === WSOL_MINT_BASE58,
    };
  }

  override async buildBorrowCreatePosition(args: JupiterLendBorrowCreatePositionArgs): Promise<JupiterLendBuildResult> {
    const borrowSdk = await loadJupiterLendBorrowSdk();
    const { supplyIsWsol, borrowIsWsol } = await this.borrowVaultMints(args.vaultId);
    const colRaw = args.collateralAmountRaw ? BigInt(args.collateralAmountRaw) : 0n;
    const debtRaw = args.borrowAmountRaw ? BigInt(args.borrowAmountRaw) : 0n;
    return this.operateAndSerialize(
      'borrow_create_position',
      args.walletAddress,
      args.vaultId,
      0, // positionId 0 → SDK bundles init + deposit + borrow into one tx
      new borrowSdk.BN(colRaw.toString()),
      new borrowSdk.BN(debtRaw.toString()),
      supplyIsWsol && colRaw > 0n ? colRaw : 0n,
      borrowIsWsol && debtRaw > 0n,
    );
  }

  override async buildBorrowDepositCollateral(args: JupiterLendBorrowDepositCollateralArgs): Promise<JupiterLendBuildResult> {
    const borrowSdk = await loadJupiterLendBorrowSdk();
    const { supplyIsWsol } = await this.borrowVaultMints(args.vaultId);
    const colRaw = BigInt(args.amountRaw);
    return this.operateAndSerialize('borrow_deposit_collateral', args.walletAddress, args.vaultId, args.positionId,
      new borrowSdk.BN(colRaw.toString()), new borrowSdk.BN('0'), supplyIsWsol ? colRaw : 0n, false);
  }

  override async buildBorrowBorrow(args: JupiterLendBorrowBorrowArgs): Promise<JupiterLendBuildResult> {
    const borrowSdk = await loadJupiterLendBorrowSdk();
    const { borrowIsWsol } = await this.borrowVaultMints(args.vaultId);
    return this.operateAndSerialize('borrow_borrow', args.walletAddress, args.vaultId, args.positionId,
      new borrowSdk.BN('0'), new borrowSdk.BN(args.amountRaw), 0n, borrowIsWsol);
  }

  override async buildBorrowRepay(args: JupiterLendBorrowRepayArgs): Promise<JupiterLendBuildResult> {
    const borrowSdk = await loadJupiterLendBorrowSdk();
    const { borrowIsWsol } = await this.borrowVaultMints(args.vaultId);
    // Repay: debtAmount is negative (or MAX_REPAY_AMOUNT to zero the debt).
    const debtAmount = args.repayAll ? borrowSdk.MAX_REPAY_AMOUNT : new borrowSdk.BN('-' + args.amountRaw);
    // Fund the wSOL ATA when repaying SOL debt. For repay-all the exact debt is only known on-chain;
    // wrap the current debt (a close-account at the tail refunds any excess). [VERIFY repay-all wSOL funding]
    let wrapLamports = 0n;
    if (borrowIsWsol) {
      if (args.repayAll) {
        try {
          const pos = await borrowSdk.getCurrentPosition({ vaultId: args.vaultId, positionId: args.positionId, connection: this.connection });
          wrapLamports = bnLikeToBigInt(pos.debtRaw);
        } catch { wrapLamports = 0n; }
      } else {
        wrapLamports = BigInt(args.amountRaw);
      }
    }
    return this.operateAndSerialize('borrow_repay', args.walletAddress, args.vaultId, args.positionId,
      new borrowSdk.BN('0'), debtAmount, wrapLamports, borrowIsWsol);
  }

  override async buildBorrowWithdrawCollateral(args: JupiterLendBorrowWithdrawCollateralArgs): Promise<JupiterLendBuildResult> {
    const borrowSdk = await loadJupiterLendBorrowSdk();
    const { supplyIsWsol } = await this.borrowVaultMints(args.vaultId);
    return this.operateAndSerialize('borrow_withdraw_collateral', args.walletAddress, args.vaultId, args.positionId,
      new borrowSdk.BN('-' + args.amountRaw), new borrowSdk.BN('0'), 0n, supplyIsWsol);
  }
}

let factory: JupiterLendClientFactory = (_walletAddress, config) =>
  config ? buildDefaultJupiterLendClient(config) : new JupiterLendUnavailable();

export function setJupiterLendClientFactory(next: JupiterLendClientFactory): void {
  factory = next;
}

export function resetJupiterLendClientFactory(): void {
  factory = (_walletAddress, config) =>
    config ? buildDefaultJupiterLendClient(config) : new JupiterLendUnavailable();
}

export async function getJupiterLendClient(
  walletAddress: string,
  config?: AgentWalletConfig,
): Promise<JupiterLendClient> {
  return factory(walletAddress, config);
}

export function jupiterLendRestUnavailableReason(): string {
  return REST_UNAVAILABLE_REASON;
}

export function isJupiterLendBorrowOperation(operation: JupiterLendOperation): boolean {
  return operation.startsWith('borrow_');
}

function readTransactionBase64(body: Record<string, unknown>, operation: string): string {
  const value = body.transaction ?? body.transactionBase64;
  if (typeof value === 'string' && value.trim()) return value;
  throw new AdapterError(
    JUPITER_ADAPTER_ID,
    'wallet_unreachable',
    `Jupiter Lend Earn ${operation} response did not include transaction.`,
  );
}

function buildDefaultJupiterLendClient(config: AgentWalletConfig): JupiterLendClient {
  if (config.connectors?.jupiter?.useSdk === false) return new JupiterLendRestClient(config);
  // JupiterLendSdkClient serves BOTH earn and borrow via the SDK; pick it when either resolves
  // (borrow overrides live on it, earn methods fall back to REST if only borrow deps are present).
  return (areJupiterLendEarnSdkDependenciesResolvable() || areJupiterLendBorrowSdkDependenciesResolvable())
    ? new JupiterLendSdkClient(config)
    : new JupiterLendRestClient(config);
}

interface SerializeEarnOptions {
  operation: 'deposit' | 'withdraw' | 'mint' | 'redeem';
  asset: PublicKey;
  lamportsToWrap: bigint;
  unwrapAfter: boolean;
}

async function serializeEarnInstructions(
  connection: Connection,
  feePayer: PublicKey,
  ixs: TransactionInstruction[],
  opts: SerializeEarnOptions,
): Promise<string> {
  if (ixs.length === 0) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_transaction', 'Jupiter Lend SDK returned no instructions.');
  }

  const head: TransactionInstruction[] = [];
  const tail: TransactionInstruction[] = [];

  // Jupiter Lend deposit/withdraw CPIs into multiple programs; pad CU limit.
  head.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));

  // Keep explicit wrap/unwrap handling until upstream @jup-ag/lend handles
  // native SOL instructions consistently.
  if (opts.lamportsToWrap > 0n || opts.unwrapAfter) {
    const splToken = await loadSplToken();
    const wsolAta = splToken.getAssociatedTokenAddressSync(splToken.NATIVE_MINT, feePayer, true);
    if (opts.lamportsToWrap > 0n) {
      head.push(
        splToken.createAssociatedTokenAccountIdempotentInstruction(
          feePayer,
          wsolAta,
          feePayer,
          splToken.NATIVE_MINT,
        ),
      );
      head.push(
        SystemProgram.transfer({
          fromPubkey: feePayer,
          toPubkey: wsolAta,
          lamports: opts.lamportsToWrap,
        }),
      );
      head.push(splToken.createSyncNativeInstruction(wsolAta));
    }
    if (opts.unwrapAfter) {
      // Closes the wSOL ATA back to native SOL after withdraw/redeem.
      // Drains any pre-existing wSOL too, which matches the user expectation
      // ("I want my SOL back") for the Earn flow.
      tail.push(splToken.createCloseAccountInstruction(wsolAta, feePayer, feePayer));
    }
  }

  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer,
    recentBlockhash: latest.blockhash,
  });
  tx.add(...head, ...ixs, ...tail);

  if (process.env.AGENT_WALLET_JUPITER_LEND_DEBUG === '1') {
    emitJupiterLendIxDiagnostic(opts.operation, opts.asset, tx.instructions);
  }

  return tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).toString('base64');
}

function emitJupiterLendIxDiagnostic(
  operation: SerializeEarnOptions['operation'],
  asset: PublicKey,
  instructions: TransactionInstruction[],
): void {
  const summary = instructions.map((ix) => ({
    programId: ix.programId.toBase58(),
    accountCount: ix.keys.length,
    dataPrefix: ix.data.subarray(0, Math.min(8, ix.data.length)).toString('hex'),
  }));
  console.info('[jupiter-lend-ix]', JSON.stringify({
    operation,
    asset: asset.toBase58(),
    instructionCount: instructions.length,
    instructions: summary,
  }));
}

// ---------------------------------------------------------------------------
// Borrow helpers: raw-amount + oracle/health math + v0 transaction composition.
//
// SCALE CONVENTIONS (verified from the SDK where provable; [VERIFY] = confirm against a live
// vault + the Jupiter UI before trusting user-facing numbers — see the plan's risk checklist):
//   - liquidationThreshold / collateralFactor: config values, ÷1000 = fraction (×10 = bps).   [VERIFY collateralFactor scale]
//   - oracle price (operate/liquidate): 1e15-scaled collateral price in DEBT-token units.
//   - borrowRateVault / supplyRateVault: ÷100 = percent APR/APY.                                [VERIFY percent vs fraction]
//   - borrowFee: ÷1e4 = fraction of the drawn debt.
// ---------------------------------------------------------------------------

type BorrowLiquidationStatus = JupiterLendBorrowPositionSnapshot['liquidationStatus'];
const ORACLE_PRICE_SCALE = 1_000_000_000_000_000n; // 1e15
const CONFIG_FACTOR_DIVISOR = 1000; // collateralFactor / liquidationThreshold → ÷1000 fraction, ×10 bps
const RATE_DIVISOR = 100; // borrowRateVault / supplyRateVault → percent
const BORROW_FEE_DIVISOR = 10_000n; // borrowFee → ÷1e4 fraction

// bn.js instances expose toString(); numbers/strings/bigints are handled directly. Truncates any
// fractional part defensively (raw on-chain amounts are always integers).
function bnLikeToBigInt(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  const raw = typeof value === 'string' ? value : (value as { toString?: () => string }).toString?.() ?? '';
  const int = raw.trim().split('.')[0]!;
  return /^-?\d+$/.test(int) ? BigInt(int) : 0n;
}
function bnLikeToNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const raw = typeof value === 'string' ? value : (value as { toString?: () => string })?.toString?.() ?? '';
  return raw ? Number(raw) : NaN;
}
// Human decimal string (may be signed) → raw base-unit bigint.
function decimalToRaw(value: string | undefined, decimals: number): bigint {
  if (!value || !value.trim()) return 0n;
  const trimmed = value.trim();
  const neg = trimmed.startsWith('-');
  const [whole, frac = ''] = trimmed.replace(/^-/, '').split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const raw = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
  return neg ? -raw : raw;
}
// Format a raw integer amount (base units) into a human decimal string, trimming trailing zeros.
function formatRawAmount(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / base;
  const frac = abs % base;
  let out = whole.toString();
  if (decimals > 0 && frac > 0n) {
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    if (fracStr) out += `.${fracStr}`;
  }
  return neg ? `-${out}` : out;
}

function computeBorrowHealth(opts: {
  colRaw: bigint;
  debtRaw: bigint;
  oraclePrice: bigint; // 1e15-scaled: collateral price in debt-token units
  liquidationThreshold: number; // config value (÷1000 = fraction)
  minHealthRatio: number;
  isLiquidated: boolean;
}): { healthRatio: number | null; healthRatioText: string; liquidationStatus: BorrowLiquidationStatus; ltvBps: number; collateralValueInDebt: bigint } {
  if (opts.isLiquidated) return { healthRatio: null, healthRatioText: 'liquidated', liquidationStatus: 'liquidated', ltvBps: 0, collateralValueInDebt: 0n };
  if (opts.debtRaw <= 0n) return { healthRatio: null, healthRatioText: '∞', liquidationStatus: 'safe', ltvBps: 0, collateralValueInDebt: 0n }; // no debt ⇒ not liquidatable, guards div-by-zero
  if (opts.oraclePrice <= 0n || opts.colRaw <= 0n) return { healthRatio: null, healthRatioText: '—', liquidationStatus: 'unknown', ltvBps: 0, collateralValueInDebt: 0n };
  const collateralValueInDebt = (opts.colRaw * opts.oraclePrice) / ORACLE_PRICE_SCALE;
  if (collateralValueInDebt <= 0n) return { healthRatio: null, healthRatioText: '—', liquidationStatus: 'unknown', ltvBps: 0, collateralValueInDebt: 0n };
  const ltvFraction = Number((opts.debtRaw * 1_000_000n) / collateralValueInDebt) / 1_000_000;
  const ltvBps = Math.round(ltvFraction * 10_000);
  const liqFraction = opts.liquidationThreshold / CONFIG_FACTOR_DIVISOR;
  const healthRatio = ltvFraction > 0 ? liqFraction / ltvFraction : null;
  const liquidationStatus: BorrowLiquidationStatus =
    healthRatio == null ? 'unknown'
      : healthRatio <= 1 ? 'liquidatable'
        : healthRatio < opts.minHealthRatio ? 'at_risk'
          : 'safe';
  return { healthRatio, healthRatioText: healthRatio == null ? '—' : healthRatio.toFixed(2), liquidationStatus, ltvBps, collateralValueInDebt };
}

const mintDecimalsCache = new Map<string, number>();
export function __setJupiterLendMintDecimalsForTests(mint: string, decimals: number | undefined): void {
  if (decimals === undefined) mintDecimalsCache.delete(mint);
  else mintDecimalsCache.set(mint, decimals);
}
async function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const key = mint.toBase58();
  if (key === WSOL_MINT_BASE58) return 9;
  const cached = mintDecimalsCache.get(key);
  if (cached !== undefined) return cached;
  const splToken = await loadSplToken();
  const info = await splToken.getMint(connection, mint);
  mintDecimalsCache.set(key, info.decimals);
  return info.decimals;
}

interface SerializeBorrowOptions {
  operation: JupiterLendOperation;
  wrapLamports: bigint;
  unwrapAfter: boolean;
}
// Borrow operate ixs reference many accounts via address lookup tables, so this must build a v0
// VersionedTransaction (unlike the legacy earn path). wSOL wrap/unwrap mirrors serializeEarnInstructions.
async function serializeBorrowInstructions(
  connection: Connection,
  feePayer: PublicKey,
  ixs: TransactionInstruction[],
  addressLookupTableAccounts: AddressLookupTableAccount[],
  opts: SerializeBorrowOptions,
): Promise<string> {
  if (ixs.length === 0) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_transaction', 'Jupiter Lend Borrow SDK returned no instructions.');
  }
  const head: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })];
  const tail: TransactionInstruction[] = [];
  if (opts.wrapLamports > 0n || opts.unwrapAfter) {
    const splToken = await loadSplToken();
    const wsolAta = splToken.getAssociatedTokenAddressSync(splToken.NATIVE_MINT, feePayer, true);
    if (opts.wrapLamports > 0n) {
      head.push(splToken.createAssociatedTokenAccountIdempotentInstruction(feePayer, wsolAta, feePayer, splToken.NATIVE_MINT));
      head.push(SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: wsolAta, lamports: opts.wrapLamports }));
      head.push(splToken.createSyncNativeInstruction(wsolAta));
    }
    if (opts.unwrapAfter) {
      tail.push(splToken.createCloseAccountInstruction(wsolAta, feePayer, feePayer));
    }
  }
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: [...head, ...ixs, ...tail],
  }).compileToV0Message(addressLookupTableAccounts);
  const tx = new VersionedTransaction(message);
  if (process.env.AGENT_WALLET_JUPITER_LEND_DEBUG === '1') {
    emitJupiterLendIxDiagnostic('deposit', feePayer, [...head, ...ixs, ...tail]);
  }
  return Buffer.from(tx.serialize()).toString('base64');
}

function loadJupiterLendBnCtor(): BnCtor {
  try {
    const lendRequire = createRequire(require.resolve('@jup-ag/lend'));
    const bn = lendRequire('bn.js') as { default?: BnCtor; BN?: BnCtor } | BnCtor;
    if (typeof bn === 'function') return bn;
    if (typeof bn.default === 'function') return bn.default;
    if (typeof bn.BN === 'function') return bn.BN;
  } catch {
    // Fall through to the uniform SDK-unavailable error below.
  }
  throw new AdapterError(
    JUPITER_ADAPTER_ID,
    'sdk_unavailable',
    'Unable to load bn.js from @jup-ag/lend for Jupiter Lend Earn transaction building.',
  );
}

// USD values are only reliable when the debt token is a USD stablecoin (the oracle prices collateral
// in DEBT-token units, not USD). For other debt tokens we omit USD in v1 (a follow-up can price them).
const BORROW_USD_STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
const READ_ONLY_SIGNER = PublicKey.default; // readOraclePrice needs a signer pubkey but never signs on a read

async function readVaultOracle(
  borrowSdk: JupiterLendBorrowSdkBundle,
  connection: Connection,
  signer: PublicKey,
  oracle: PublicKey,
): Promise<{ snapshot: JupiterLendOracleSnapshot; operatePrice: bigint; liquidatePrice: bigint }> {
  try {
    const priced = await borrowSdk.readOraclePrice({ connection, signer, oracle });
    const operatePrice = bnLikeToBigInt(priced.oraclePriceOperate);
    const liquidatePrice = bnLikeToBigInt(priced.oraclePriceLiquidate);
    return {
      snapshot: { oracleAddress: oracle.toBase58(), price: operatePrice.toString(), available: operatePrice > 0n },
      operatePrice,
      liquidatePrice: liquidatePrice > 0n ? liquidatePrice : operatePrice,
    };
  } catch {
    // Oracle read failure → mark unavailable; health downstream degrades to 'unknown' (treated as blocked).
    return { snapshot: { oracleAddress: oracle.toBase58(), available: false }, operatePrice: 0n, liquidatePrice: 0n };
  }
}

async function toBorrowVaultSnapshot(
  vaultData: LendReadVaultData,
  connection: Connection,
  borrowSdk: JupiterLendBorrowSdkBundle,
  signer: PublicKey,
): Promise<JupiterLendBorrowVaultSnapshot> {
  const supplyMint = vaultData.constantViews.supplyToken;
  const borrowMint = vaultData.constantViews.borrowToken;
  const [supplyDecimals, borrowDecimals] = await Promise.all([
    getMintDecimals(connection, supplyMint),
    getMintDecimals(connection, borrowMint),
  ]);
  const oracle = await readVaultOracle(borrowSdk, connection, signer, vaultData.configs.oracle);
  const collateralFactor = bnLikeToNumber(vaultData.configs.collateralFactor);
  const liquidationThreshold = bnLikeToNumber(vaultData.configs.liquidationThreshold);
  const liquidationPenalty = bnLikeToNumber(vaultData.configs.liquidationPenalty);
  const borrowRate = bnLikeToNumber(vaultData.exchangePricesAndRates.borrowRateVault);
  const supplyRate = bnLikeToNumber(vaultData.exchangePricesAndRates.supplyRateVault);
  const limits = vaultData.limitsAndAvailability;
  const totals = vaultData.totalSupplyAndBorrow;
  return {
    vaultId: vaultData.constantViews.vaultId,
    vaultAddress: vaultData.vault.toBase58(),
    supplyMint: supplyMint.toBase58(),
    borrowMint: borrowMint.toBase58(),
    supplyDecimals,
    borrowDecimals,
    ltvBps: Number.isFinite(collateralFactor) ? Math.round(collateralFactor * 10) : 0,
    liquidationThresholdBps: Number.isFinite(liquidationThreshold) ? Math.round(liquidationThreshold * 10) : 0,
    ...(Number.isFinite(liquidationPenalty) ? { liquidationPenaltyBps: Math.round(liquidationPenalty * 10) } : {}),
    ...(Number.isFinite(borrowRate) ? { borrowApr: borrowRate / RATE_DIVISOR } : {}),
    ...(Number.isFinite(supplyRate) ? { supplyApy: supplyRate / RATE_DIVISOR } : {}),
    ...(limits?.borrowable !== undefined ? { borrowAvailable: formatRawAmount(bnLikeToBigInt(limits.borrowable), borrowDecimals) } : {}),
    ...(limits?.withdrawable !== undefined ? { supplyAvailable: formatRawAmount(bnLikeToBigInt(limits.withdrawable), supplyDecimals) } : {}),
    ...(totals?.totalSupplyVault !== undefined ? { totalCollateral: formatRawAmount(bnLikeToBigInt(totals.totalSupplyVault), supplyDecimals) } : {}),
    ...(totals?.totalBorrowVault !== undefined ? { totalDebt: formatRawAmount(bnLikeToBigInt(totals.totalBorrowVault), borrowDecimals) } : {}),
    oracle: oracle.snapshot,
    active: true,
    asOf: new Date().toISOString(),
  };
}

async function toBorrowPositionSnapshot(
  position: LendReadNftPosition,
  connection: Connection,
  borrowSdk: JupiterLendBorrowSdkBundle,
  signer: PublicKey,
  minHealthRatio: number,
): Promise<JupiterLendBorrowPositionSnapshot> {
  const vaultData = position.vault;
  const supplyMint = vaultData.constantViews.supplyToken;
  const borrowMint = vaultData.constantViews.borrowToken;
  const [supplyDecimals, borrowDecimals] = await Promise.all([
    getMintDecimals(connection, supplyMint),
    getMintDecimals(connection, borrowMint),
  ]);
  const oracle = await readVaultOracle(borrowSdk, connection, signer, vaultData.configs.oracle);
  const colRaw = bnLikeToBigInt(position.supply);
  const debtRaw = bnLikeToBigInt(position.borrow);
  const liquidationThreshold = bnLikeToNumber(vaultData.configs.liquidationThreshold);
  const health = computeBorrowHealth({
    colRaw,
    debtRaw,
    oraclePrice: oracle.liquidatePrice,
    liquidationThreshold,
    minHealthRatio,
    isLiquidated: position.isLiquidated === true,
  });
  const borrowIsStable = BORROW_USD_STABLE_MINTS.has(borrowMint.toBase58());
  return {
    vaultId: vaultData.constantViews.vaultId,
    vaultAddress: vaultData.vault.toBase58(),
    positionId: position.nftId,
    positionAddress: String(position.nftId),
    owner: position.owner.toBase58(),
    collateralAmount: formatRawAmount(colRaw, supplyDecimals),
    collateralAmountRaw: colRaw.toString(),
    debtAmount: formatRawAmount(debtRaw, borrowDecimals),
    debtAmountRaw: debtRaw.toString(),
    healthRatio: health.healthRatio,
    healthRatioText: health.healthRatioText,
    liquidationStatus: health.liquidationStatus,
    ltvBps: health.ltvBps,
    liquidationThresholdBps: Number.isFinite(liquidationThreshold) ? Math.round(liquidationThreshold * 10) : 0,
    ...(borrowIsStable
      ? {
          debtValueUsd: formatRawAmount(debtRaw, borrowDecimals),
          collateralValueUsd: formatRawAmount(health.collateralValueInDebt, borrowDecimals),
        }
      : {}),
    asOf: new Date().toISOString(),
  };
}

function optionalToString<K extends string>(value: unknown, key: K): Partial<Record<K, string>> {
  return value !== undefined && value !== null ? { [key]: String(value) } as Partial<Record<K, string>> : {};
}

function toEarnTokenSnapshot(
  detail: Awaited<ReturnType<JupiterLendEarnSdkBundle['getLendingTokenDetails']>>,
  asOf: string,
): JupiterLendEarnTokenSnapshot {
  const assetMint = detail.asset.toBase58();
  return {
    assetMint,
    shareMint: detail.address.toBase58(),
    ...jupiterEarnSymbol(assetMint),
    decimals: detail.decimals,
    shareDecimals: detail.decimals,
    ...optionalToString(detail.totalAssets, 'totalSupplyUnderlying'),
    ...optionalToString(detail.totalSupply, 'totalSupplyShares'),
    ...optionalToString(detail.convertToAssets, 'exchangePrice'),
    active: true,
    asOf,
  };
}

function jupiterEarnSymbol(assetMint: string): { tokenSymbol?: string } {
  switch (assetMint) {
    case 'So11111111111111111111111111111111111111112':
      return { tokenSymbol: 'SOL' };
    case 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':
      return { tokenSymbol: 'USDC' };
    case 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':
      return { tokenSymbol: 'USDT' };
    default:
      return {};
  }
}

function jupiterEarnSymbolRank(symbol: string | undefined): number {
  const normalized = symbol?.trim().toUpperCase();
  if (normalized === 'SOL') return 0;
  if (normalized === 'USDC') return 1;
  if (normalized === 'USDT') return 2;
  return 3;
}
