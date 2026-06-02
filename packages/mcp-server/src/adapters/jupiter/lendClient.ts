import { createRequire } from 'node:module';

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
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

  override async buildBorrowCreatePosition(): Promise<JupiterLendBuildResult> {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', REST_UNAVAILABLE_REASON);
  }

  override async buildBorrowDepositCollateral(): Promise<JupiterLendBuildResult> {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', REST_UNAVAILABLE_REASON);
  }

  override async buildBorrowBorrow(): Promise<JupiterLendBuildResult> {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', REST_UNAVAILABLE_REASON);
  }

  override async buildBorrowRepay(): Promise<JupiterLendBuildResult> {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'sdk_unavailable', REST_UNAVAILABLE_REASON);
  }

  override async buildBorrowWithdrawCollateral(): Promise<JupiterLendBuildResult> {
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
  return areJupiterLendEarnSdkDependenciesResolvable()
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
