import { createRequire } from 'node:module';

import { AdapterError } from '../types.js';
import type { AgentWalletConfig } from '../../config.js';

import { JUPITER_ADAPTER_ID, type JupiterLendOperation } from './constants.js';
import { jupiterFetchJson } from './client.js';

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

let factory: JupiterLendClientFactory = (_walletAddress, config) =>
  config ? new JupiterLendRestClient(config) : new JupiterLendUnavailable();

export function setJupiterLendClientFactory(next: JupiterLendClientFactory): void {
  factory = next;
}

export function resetJupiterLendClientFactory(): void {
  factory = (_walletAddress, config) =>
    config ? new JupiterLendRestClient(config) : new JupiterLendUnavailable();
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
