import { createRequire } from 'node:module';

import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from '@solana/web3.js';

import { AdapterError } from '../types.js';
import {
  DEFAULT_MARGINFI_MIN_HEALTH_RATIO,
  MARGINFI_ADAPTER_ID,
} from './constants.js';

export type MarginfiOperation = 'deposit' | 'withdraw' | 'borrow' | 'repay';

export interface MarginfiBankLookupInput {
  bankAddress?: string;
  bankMint?: string;
  token?: string;
}

export interface MarginfiBankSnapshot {
  bankAddress: string;
  bankMint: string;
  tokenSymbol?: string;
  decimals: number;
  depositApy?: number;
  borrowApr?: number;
  utilization?: number;
  totalAssets?: string;
  totalLiabilities?: string;
  depositCapacity?: string;
  borrowCapacity?: string;
  assetWeightInit?: string;
  assetWeightMaint?: string;
  liabilityWeightInit?: string;
  liabilityWeightMaint?: string;
  oraclePrice?: string;
  oracleTimestamp?: string;
  oracleMaxAge?: number;
  riskTier?: string;
  operationalState?: string;
  lastUpdateSlot?: number;
}

export interface MarginfiPosition {
  bankAddress: string;
  bankMint: string;
  tokenSymbol?: string;
  decimals: number;
  suppliedAmount: string;
  borrowedAmount: string;
  suppliedUsd?: string;
  borrowedUsd?: string;
  assetShares?: string;
  liabilityShares?: string;
  lastUpdateSlot?: number;
}

export interface MarginfiHealthComponents {
  assets: string;
  liabilities: string;
  netValue: string;
  healthRatio: number | null;
  healthRatioText: string;
  healthy: boolean;
}

export interface MarginfiAccountSummary {
  marginfiAccount: string;
  authority: string;
  activeBalances: number;
  health: MarginfiHealthComponents;
}

export interface MarginfiAccountDetail extends MarginfiAccountSummary {
  positions: MarginfiPosition[];
  netApy?: number;
}

export interface MarginfiHealthPreview {
  operation: MarginfiOperation;
  marginfiAccount: string;
  bankAddress: string;
  bankMint: string;
  tokenSymbol?: string;
  amount: string;
  amountRaw: string;
  withdrawAll?: boolean;
  repayAll?: boolean;
  before: MarginfiHealthComponents;
  after?: MarginfiHealthComponents;
  minHealthRatio: number;
  blocked: boolean;
  warnings: string[];
  simulatedAt: string;
}

export interface MarginfiActionBuildInput extends MarginfiBankLookupInput {
  operation: MarginfiOperation;
  walletAddress: string;
  marginfiAccount?: string;
  amount?: string;
  withdrawAll?: boolean;
  repayAll?: boolean;
}

export interface MarginfiBuildTransactionResult {
  transactionBase64: string;
  marginfiAccount: string;
  bankSnapshot: MarginfiBankSnapshot;
  amount: string;
  amountRaw: string;
}

export interface MarginfiClient {
  getBankSnapshot(connection: Connection, input: MarginfiBankLookupInput): Promise<MarginfiBankSnapshot>;
  getWalletAccounts(connection: Connection, walletAddress: string): Promise<MarginfiAccountSummary[]>;
  getAccountDetail(
    connection: Connection,
    input: { walletAddress: string; marginfiAccount?: string },
  ): Promise<MarginfiAccountDetail>;
  previewHealth(
    connection: Connection,
    input: MarginfiActionBuildInput & { minHealthRatio?: number },
  ): Promise<MarginfiHealthPreview>;
  buildActionTransaction(
    connection: Connection,
    input: MarginfiActionBuildInput,
  ): Promise<MarginfiBuildTransactionResult>;
}

export type MarginfiClientFactory = (walletAddress: string) => Promise<MarginfiClient> | MarginfiClient;

const require = createRequire(import.meta.url);
const SDK_UNAVAILABLE_REASON =
  '@mrgnlabs/marginfi-client-v2 and @mrgnlabs/mrgn-common are not installed. Install optional MarginFi SDK dependencies or inject a mock client for tests.';

class MarginfiSdkUnavailable implements MarginfiClient {
  readonly reason = SDK_UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new Error(`MarginFi adapter is not configured (${method}): ${this.reason}`);
  }

  async getBankSnapshot(): Promise<MarginfiBankSnapshot> {
    this.fail('getBankSnapshot');
  }

  async getWalletAccounts(): Promise<MarginfiAccountSummary[]> {
    this.fail('getWalletAccounts');
  }

  async getAccountDetail(): Promise<MarginfiAccountDetail> {
    this.fail('getAccountDetail');
  }

  async previewHealth(): Promise<MarginfiHealthPreview> {
    this.fail('previewHealth');
  }

  async buildActionTransaction(): Promise<MarginfiBuildTransactionResult> {
    this.fail('buildActionTransaction');
  }
}

let factory: MarginfiClientFactory = () => new RealMarginfiClient();

export function setMarginfiClientFactory(next: MarginfiClientFactory): void {
  factory = next;
}

export function resetMarginfiClientFactory(): void {
  factory = () => new RealMarginfiClient();
}

export async function getMarginfiClient(walletAddress: string): Promise<MarginfiClient> {
  return factory(walletAddress);
}

export function describeMarginfiUnavailableReason(): string | undefined {
  try {
    require.resolve('@mrgnlabs/marginfi-client-v2');
    require.resolve('@mrgnlabs/mrgn-common');
    return undefined;
  } catch {
    return SDK_UNAVAILABLE_REASON;
  }
}

class RealMarginfiClient implements MarginfiClient {
  private clientCache = new Map<string, Promise<AnyMarginfiClient>>();

  async getBankSnapshot(connection: Connection, input: MarginfiBankLookupInput): Promise<MarginfiBankSnapshot> {
    const client = await this.sdkClient(connection, PublicKey.default.toBase58());
    const bank = requireBank(client, input);
    return snapshotFromBank(client, bank);
  }

  async getWalletAccounts(connection: Connection, walletAddress: string): Promise<MarginfiAccountSummary[]> {
    const client = await this.sdkClient(connection, walletAddress);
    const accounts = await client.getMarginfiAccountsForAuthority(new PublicKey(walletAddress));
    return accounts.map((account: any) => summaryFromAccount(account));
  }

  async getAccountDetail(
    connection: Connection,
    input: { walletAddress: string; marginfiAccount?: string },
  ): Promise<MarginfiAccountDetail> {
    const client = await this.sdkClient(connection, input.walletAddress);
    const account = await resolveAccount(client, input);
    return detailFromAccount(client, account);
  }

  async previewHealth(
    connection: Connection,
    input: MarginfiActionBuildInput & { minHealthRatio?: number },
  ): Promise<MarginfiHealthPreview> {
    const client = await this.sdkClient(connection, input.walletAddress);
    const account = await resolveAccount(client, input);
    const bank = requireBank(client, input);
    const bankSnapshot = snapshotFromBank(client, bank);
    const amount = resolveUiAmount(account, bankSnapshot, input);
    const amountRaw = rawAmount(amount, bankSnapshot.decimals);
    const before = healthFromAccount(account);
    const warnings: string[] = [];
    let after: MarginfiHealthComponents | undefined;

    try {
      const transaction = await buildLegacyTransaction(connection, client.wallet.publicKey, await actionIxs(account, bank.address, input.operation, amount, input));
      const simulation = await account.simulateBorrowLendTransaction(
        [transaction],
        [bank.address],
        { enabled: true, mandatoryBanks: [bank.address], excludedBanks: [] },
      );
      after = healthFromAccount(simulation.marginfiAccount);
    } catch (err) {
      warnings.push(`Health simulation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const minHealthRatio = input.minHealthRatio ?? DEFAULT_MARGINFI_MIN_HEALTH_RATIO;
    const blocked = healthBlocked(input.operation, after, warnings, minHealthRatio);
    return {
      operation: input.operation,
      marginfiAccount: toBase58(account.address),
      bankAddress: bankSnapshot.bankAddress,
      bankMint: bankSnapshot.bankMint,
      ...(bankSnapshot.tokenSymbol ? { tokenSymbol: bankSnapshot.tokenSymbol } : {}),
      amount,
      amountRaw,
      ...(input.withdrawAll ? { withdrawAll: true } : {}),
      ...(input.repayAll ? { repayAll: true } : {}),
      before,
      ...(after ? { after } : {}),
      minHealthRatio,
      blocked,
      warnings,
      simulatedAt: new Date().toISOString(),
    };
  }

  async buildActionTransaction(
    connection: Connection,
    input: MarginfiActionBuildInput,
  ): Promise<MarginfiBuildTransactionResult> {
    const client = await this.sdkClient(connection, input.walletAddress);
    const account = await resolveAccount(client, input);
    const bank = requireBank(client, input);
    const bankSnapshot = snapshotFromBank(client, bank);
    const amount = resolveUiAmount(account, bankSnapshot, input);
    const wrapper = await actionIxs(account, bank.address, input.operation, amount, input);
    const transaction = await buildLegacyTransaction(connection, client.wallet.publicKey, wrapper);
    const signers = signerArray(wrapper);
    if (signers.length > 0) {
      transaction.partialSign(...signers);
    }
    return {
      transactionBase64: transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      marginfiAccount: toBase58(account.address),
      bankSnapshot,
      amount,
      amountRaw: rawAmount(amount, bankSnapshot.decimals),
    };
  }

  private async sdkClient(connection: Connection, walletAddress: string): Promise<AnyMarginfiClient> {
    const key = `${connection.rpcEndpoint ?? 'connection'}:${walletAddress}`;
    const cached = this.clientCache.get(key);
    if (cached) return cached;
    const promise = buildSdkClient(connection, walletAddress);
    this.clientCache.set(key, promise);
    return promise;
  }
}

type AnyMarginfiClient = Record<string, any>;
type AnyMarginfiAccount = Record<string, any>;
type AnyBank = Record<string, any>;
type InstructionsWrapper = {
  instructions?: TransactionInstruction[];
  keys?: Keypair[];
};

async function buildSdkClient(connection: Connection, walletAddress: string): Promise<AnyMarginfiClient> {
  let sdk: Record<string, any>;
  try {
    sdk = await import('@mrgnlabs/marginfi-client-v2');
  } catch {
    return new MarginfiSdkUnavailable() as unknown as AnyMarginfiClient;
  }
  const MarginfiClientCtor = sdk.MarginfiClient ?? sdk.default;
  if (!MarginfiClientCtor || typeof sdk.getConfig !== 'function') {
    throw new Error('MarginFi SDK did not expose MarginfiClient and getConfig.');
  }
  const publicKey = new PublicKey(walletAddress);
  const wallet = {
    publicKey,
    async signTransaction<T>(transaction: T): Promise<T> {
      return transaction;
    },
    async signAllTransactions<T>(transactions: T[]): Promise<T[]> {
      return transactions;
    },
  };
  const config = sdk.getConfig('production');
  return MarginfiClientCtor.fetch(config, wallet, connection, {
    readOnly: true,
    confirmOpts: { commitment: 'confirmed' },
  });
}

function requireBank(client: AnyMarginfiClient, input: MarginfiBankLookupInput): AnyBank {
  const bank = resolveBank(client, input);
  if (!bank) {
    throw new AdapterError(
      MARGINFI_ADAPTER_ID,
      'missing_bank',
      'MarginFi bank was not found. Pass bankAddress, bankMint, or token.',
    );
  }
  return bank;
}

function resolveBank(client: AnyMarginfiClient, input: MarginfiBankLookupInput): AnyBank | null {
  if (input.bankAddress?.trim()) {
    return client.getBankByPk(new PublicKey(input.bankAddress.trim()));
  }
  if (input.bankMint?.trim()) {
    return client.getBankByMint(new PublicKey(input.bankMint.trim()));
  }
  if (input.token?.trim()) {
    return client.getBankByTokenSymbol(input.token.trim());
  }
  throw new AdapterError(
    MARGINFI_ADAPTER_ID,
    'missing_bank',
    'MarginFi bank lookup requires bankAddress, bankMint, or token.',
  );
}

async function resolveAccount(
  client: AnyMarginfiClient,
  input: { walletAddress: string; marginfiAccount?: string; operation?: MarginfiOperation; createAccountIfMissing?: boolean },
): Promise<AnyMarginfiAccount> {
  if (input.marginfiAccount?.trim()) {
    const sdk = await import('@mrgnlabs/marginfi-client-v2');
    const wrapper = sdk.MarginfiAccountWrapper;
    return wrapper.fetch(new PublicKey(input.marginfiAccount.trim()), client as any);
  }
  const accounts = await client.getMarginfiAccountsForAuthority(new PublicKey(input.walletAddress));
  if (accounts.length === 1) {
    return accounts[0];
  }
  if (accounts.length === 0) {
    if (input.operation === 'deposit' && input.createAccountIfMissing) {
      throw new AdapterError(
        MARGINFI_ADAPTER_ID,
        'create_account_not_supported',
        'MarginFi account creation is not supported by this connector version. Create a MarginFi account first, then retry the deposit.',
      );
    }
    throw new AdapterError(
      MARGINFI_ADAPTER_ID,
      'missing_account',
      'No MarginFi account found for this wallet. Pass marginfiAccount or create one in MarginFi first.',
    );
  }
  throw new AdapterError(
    MARGINFI_ADAPTER_ID,
    'ambiguous_account',
    'Multiple MarginFi accounts found. Pass marginfiAccount explicitly.',
  );
}

async function actionIxs(
  account: AnyMarginfiAccount,
  bankAddress: PublicKey,
  operation: MarginfiOperation,
  amount: string,
  input: { withdrawAll?: boolean; repayAll?: boolean },
): Promise<InstructionsWrapper> {
  switch (operation) {
    case 'deposit':
      return account.makeDepositIx(amount, bankAddress);
    case 'withdraw':
      return account.makeWithdrawIx(amount, bankAddress, input.withdrawAll === true);
    case 'borrow':
      return account.makeBorrowIx(amount, bankAddress);
    case 'repay':
      return account.makeRepayIx(amount, bankAddress, input.repayAll === true);
  }
}

async function buildLegacyTransaction(
  connection: Connection,
  feePayer: PublicKey,
  wrapper: InstructionsWrapper,
): Promise<Transaction> {
  const transaction = new Transaction().add(...(wrapper.instructions ?? []));
  transaction.feePayer = feePayer;
  const latest = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = latest.blockhash;
  return transaction;
}

function snapshotFromBank(client: AnyMarginfiClient, bank: AnyBank): MarginfiBankSnapshot {
  const rates = safeCall(() => bank.computeInterestRates());
  const utilization = safeCall(() => bank.computeUtilizationRate());
  const capacity = safeCall(() => bank.computeRemainingCapacity());
  const oracle = safeCall(() => client.getOraclePriceByBank(bank.address));
  return {
    bankAddress: toBase58(bank.address),
    bankMint: toBase58(bank.mint),
    ...(typeof bank.tokenSymbol === 'string' && bank.tokenSymbol ? { tokenSymbol: bank.tokenSymbol } : {}),
    decimals: Number(bank.mintDecimals ?? 0),
    ...(rates?.lendingRate !== undefined ? { depositApy: percentNumber(rates.lendingRate) } : {}),
    ...(rates?.borrowingRate !== undefined ? { borrowApr: percentNumber(rates.borrowingRate) } : {}),
    ...(utilization !== undefined ? { utilization: percentNumber(utilization) } : {}),
    ...(bank.getTotalAssetQuantity ? { totalAssets: decimalString(bank.getTotalAssetQuantity()) } : {}),
    ...(bank.getTotalLiabilityQuantity ? { totalLiabilities: decimalString(bank.getTotalLiabilityQuantity()) } : {}),
    ...(capacity?.depositCapacity !== undefined ? { depositCapacity: decimalString(capacity.depositCapacity) } : {}),
    ...(capacity?.borrowCapacity !== undefined ? { borrowCapacity: decimalString(capacity.borrowCapacity) } : {}),
    ...(bank.config?.assetWeightInit !== undefined ? { assetWeightInit: decimalString(bank.config.assetWeightInit) } : {}),
    ...(bank.config?.assetWeightMaint !== undefined ? { assetWeightMaint: decimalString(bank.config.assetWeightMaint) } : {}),
    ...(bank.config?.liabilityWeightInit !== undefined ? { liabilityWeightInit: decimalString(bank.config.liabilityWeightInit) } : {}),
    ...(bank.config?.liabilityWeightMaint !== undefined ? { liabilityWeightMaint: decimalString(bank.config.liabilityWeightMaint) } : {}),
    ...(oracle?.priceRealtime?.price !== undefined ? { oraclePrice: decimalString(oracle.priceRealtime.price) } : {}),
    ...(oracle?.timestamp !== undefined ? { oracleTimestamp: decimalString(oracle.timestamp) } : {}),
    ...(typeof bank.config?.oracleMaxAge === 'number' ? { oracleMaxAge: bank.config.oracleMaxAge } : {}),
    ...(bank.config?.riskTier !== undefined ? { riskTier: String(bank.config.riskTier) } : {}),
    ...(bank.config?.operationalState !== undefined ? { operationalState: String(bank.config.operationalState) } : {}),
    ...(typeof bank.lastUpdate === 'number' ? { lastUpdateSlot: bank.lastUpdate } : {}),
  };
}

function detailFromAccount(client: AnyMarginfiClient, account: AnyMarginfiAccount): MarginfiAccountDetail {
  const positions = (account.activeBalances ?? []).flatMap((balance: AnyBank) => {
    const bank = client.getBankByPk(balance.bankPk);
    if (!bank) return [];
    return [positionFromBalance(client, balance, bank)];
  });
  return {
    ...summaryFromAccount(account),
    positions,
    ...(typeof account.computeNetApy === 'function' ? { netApy: account.computeNetApy() } : {}),
  };
}

function summaryFromAccount(account: AnyMarginfiAccount): MarginfiAccountSummary {
  return {
    marginfiAccount: toBase58(account.address),
    authority: toBase58(account.authority),
    activeBalances: Array.isArray(account.activeBalances) ? account.activeBalances.length : 0,
    health: healthFromAccount(account),
  };
}

function positionFromBalance(client: AnyMarginfiClient, balance: AnyBank, bank: AnyBank): MarginfiPosition {
  const quantities = safeCall(() => balance.computeQuantityUi(bank));
  const oracle = safeCall(() => client.getOraclePriceByBank(bank.address));
  const usd = oracle ? safeCall(() => balance.computeUsdValue(bank, oracle)) : undefined;
  return {
    bankAddress: toBase58(bank.address),
    bankMint: toBase58(bank.mint),
    ...(typeof bank.tokenSymbol === 'string' && bank.tokenSymbol ? { tokenSymbol: bank.tokenSymbol } : {}),
    decimals: Number(bank.mintDecimals ?? 0),
    suppliedAmount: decimalString(quantities?.assets ?? '0'),
    borrowedAmount: decimalString(quantities?.liabilities ?? '0'),
    ...(usd?.assets !== undefined ? { suppliedUsd: decimalString(usd.assets) } : {}),
    ...(usd?.liabilities !== undefined ? { borrowedUsd: decimalString(usd.liabilities) } : {}),
    ...(balance.assetShares !== undefined ? { assetShares: decimalString(balance.assetShares) } : {}),
    ...(balance.liabilityShares !== undefined ? { liabilityShares: decimalString(balance.liabilityShares) } : {}),
    ...(typeof balance.lastUpdate === 'number' ? { lastUpdateSlot: balance.lastUpdate } : {}),
  };
}

function healthFromAccount(account: AnyMarginfiAccount): MarginfiHealthComponents {
  const sdkMarginRequirement = marginRequirementType();
  const components = account.computeHealthComponents(sdkMarginRequirement.Maintenance);
  const assets = decimalString(components.assets);
  const liabilities = decimalString(components.liabilities);
  const assetNumber = Number(assets);
  const liabilityNumber = Number(liabilities);
  const ratio = liabilityNumber > 0 ? assetNumber / liabilityNumber : null;
  const netValue = Number.isFinite(assetNumber) && Number.isFinite(liabilityNumber)
    ? trimDecimal(assetNumber - liabilityNumber)
    : '0';
  return {
    assets,
    liabilities,
    netValue,
    healthRatio: ratio,
    healthRatioText: ratio === null ? 'unlevered' : trimDecimal(ratio),
    healthy: ratio === null || ratio > 1,
  };
}

function marginRequirementType(): { Maintenance: unknown } {
  const sdk = require('@mrgnlabs/marginfi-client-v2') as { MarginRequirementType?: { Maintenance: unknown } };
  if (!sdk.MarginRequirementType) {
    throw new Error('MarginFi SDK did not expose MarginRequirementType.');
  }
  return sdk.MarginRequirementType;
}

function resolveUiAmount(
  account: AnyMarginfiAccount,
  bank: MarginfiBankSnapshot,
  input: MarginfiActionBuildInput,
): string {
  if (input.withdrawAll) {
    const position = positionForBank(account, bank.bankAddress);
    if (!position || !positiveDecimal(position.suppliedAmount)) {
      throw new AdapterError(MARGINFI_ADAPTER_ID, 'no_position', 'No supplied MarginFi balance is available to withdraw.');
    }
    return position.suppliedAmount;
  }
  if (input.repayAll) {
    const position = positionForBank(account, bank.bankAddress);
    if (!position || !positiveDecimal(position.borrowedAmount)) {
      throw new AdapterError(MARGINFI_ADAPTER_ID, 'no_debt', 'No MarginFi debt is available to repay for this bank.');
    }
    return position.borrowedAmount;
  }
  if (!input.amount?.trim()) {
    throw new AdapterError(MARGINFI_ADAPTER_ID, 'invalid_amount', `Amount is required for MarginFi ${input.operation}.`);
  }
  return input.amount.trim();
}

function positionForBank(account: AnyMarginfiAccount, bankAddress: string): MarginfiPosition | undefined {
  const client = account.client as AnyMarginfiClient;
  const balance = (account.activeBalances ?? []).find((entry: AnyBank) => toBase58(entry.bankPk) === bankAddress);
  if (!balance) return undefined;
  const bank = client.getBankByPk(balance.bankPk);
  return bank ? positionFromBalance(client, balance, bank) : undefined;
}

function healthBlocked(
  operation: MarginfiOperation,
  after: MarginfiHealthComponents | undefined,
  warnings: string[],
  minHealthRatio: number,
): boolean {
  if (operation !== 'borrow' && operation !== 'withdraw') return false;
  if (!after) return true;
  if (!after.healthy) return true;
  if (after.healthRatio !== null && after.healthRatio < minHealthRatio) return true;
  return warnings.some((warning) => /stale|oracle|risk engine|simulation failed/i.test(warning));
}

function rawAmount(amount: string, decimals: number): string {
  const [whole = '0', fractional = ''] = amount.trim().split('.');
  const normalizedFractional = fractional.padEnd(decimals, '0').slice(0, decimals);
  const digits = `${whole}${normalizedFractional}`.replace(/^0+(?=\d)/, '');
  return digits || '0';
}

function signerArray(wrapper: InstructionsWrapper): Keypair[] {
  return Array.isArray(wrapper.keys) ? wrapper.keys : [];
}

function safeCall<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

function percentNumber(value: unknown): number {
  const parsed = Number(decimalString(value));
  if (!Number.isFinite(parsed)) return Number.NaN;
  return parsed <= 1 ? parsed * 100 : parsed;
}

function decimalString(value: unknown): string {
  if (value === undefined || value === null) return '0';
  if (typeof value === 'number') return trimDecimal(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  const stringifier = (value as { toString?: () => string }).toString;
  return typeof stringifier === 'function' ? stringifier.call(value) : String(value);
}

function trimDecimal(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(12).replace(/\.?0+$/, '');
}

function positiveDecimal(value: string | undefined): boolean {
  if (!value) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function toBase58(value: unknown): string {
  if (value instanceof PublicKey) return value.toBase58();
  const method = (value as { toBase58?: () => string } | undefined)?.toBase58;
  if (typeof method === 'function') return method.call(value);
  return String(value ?? '');
}

export function isVersionedTransaction(transaction: Transaction | VersionedTransaction): transaction is VersionedTransaction {
  return transaction instanceof VersionedTransaction;
}
