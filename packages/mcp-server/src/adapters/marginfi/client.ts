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
import { parseDecimalAmount } from '../../amounts.js';

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
  createAccountIfMissing?: boolean;
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

type MarginfiSdkModule = Record<string, any>;
type MarginfiSdkLoader = () => Promise<MarginfiSdkModule>;

let loadedSdkModule: MarginfiSdkModule | undefined;
let sdkLoader: MarginfiSdkLoader = defaultMarginfiSdkLoader;
let factory: MarginfiClientFactory = (walletAddress) => new RealMarginfiClient(walletAddress);

export function setMarginfiClientFactory(next: MarginfiClientFactory): void {
  factory = next;
}

export function resetMarginfiClientFactory(): void {
  factory = (walletAddress) => new RealMarginfiClient(walletAddress);
}

export async function getMarginfiClient(walletAddress: string): Promise<MarginfiClient> {
  return factory(walletAddress);
}

export function setMarginfiSdkLoaderForTests(next: MarginfiSdkLoader): void {
  sdkLoader = next;
  loadedSdkModule = undefined;
}

export function resetMarginfiSdkLoaderForTests(): void {
  sdkLoader = defaultMarginfiSdkLoader;
  loadedSdkModule = undefined;
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

  constructor(private readonly walletAddress: string) {}

  async getBankSnapshot(connection: Connection, input: MarginfiBankLookupInput): Promise<MarginfiBankSnapshot> {
    const client = await this.sdkClient(connection, this.walletAddress);
    const bank = requireBank(client, input);
    return snapshotFromBank(client, bank);
  }

  async getWalletAccounts(connection: Connection, walletAddress: string): Promise<MarginfiAccountSummary[]> {
    const client = await this.sdkClient(connection, walletAddress);
    const accounts = (await discoverMarginfiAccounts(client, walletAddress)).accounts;
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
    const normalizedInput = normalizeMarginfiActionInput(input);
    const client = await this.sdkClient(connection, normalizedInput.walletAddress);
    const account = await resolveAccount(client, normalizedInput);
    const bank = requireBank(client, normalizedInput);
    const bankSnapshot = snapshotFromBank(client, bank);
    const resolvedAmount = resolveActionAmount(account, bankSnapshot, normalizedInput);
    const before = healthFromAccount(account);
    const warnings: string[] = [];
    let after: MarginfiHealthComponents | undefined;
    const wrapper = await actionIxs(
      account,
      bank.address,
      normalizedInput.operation,
      resolvedAmount.amount,
      resolvedAmount,
    );

    try {
      const transaction = await buildLegacyTransaction(connection, client.wallet.publicKey, wrapper);
      const simulation = await account.simulateBorrowLendTransaction(
        [transaction],
        [bank.address],
        { enabled: true, mandatoryBanks: [bank.address], excludedBanks: [] },
      );
      after = healthFromAccount(simulation.marginfiAccount);
    } catch (err) {
      warnings.push(`Health simulation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const minHealthRatio = normalizedInput.minHealthRatio ?? DEFAULT_MARGINFI_MIN_HEALTH_RATIO;
    const blocked = healthBlocked(normalizedInput.operation, after, warnings, minHealthRatio);
    return {
      operation: normalizedInput.operation,
      marginfiAccount: toBase58(account.address),
      bankAddress: bankSnapshot.bankAddress,
      bankMint: bankSnapshot.bankMint,
      ...(bankSnapshot.tokenSymbol ? { tokenSymbol: bankSnapshot.tokenSymbol } : {}),
      amount: resolvedAmount.amount,
      amountRaw: resolvedAmount.amountRaw,
      ...(resolvedAmount.withdrawAll ? { withdrawAll: true } : {}),
      ...(resolvedAmount.repayAll ? { repayAll: true } : {}),
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
    const normalizedInput = normalizeMarginfiActionInput(input);
    const client = await this.sdkClient(connection, normalizedInput.walletAddress);
    const account = await resolveAccount(client, normalizedInput);
    const bank = requireBank(client, normalizedInput);
    const bankSnapshot = snapshotFromBank(client, bank);
    const resolvedAmount = resolveActionAmount(account, bankSnapshot, normalizedInput);
    const wrapper = await actionIxs(
      account,
      bank.address,
      normalizedInput.operation,
      resolvedAmount.amount,
      resolvedAmount,
    );
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
      amount: resolvedAmount.amount,
      amountRaw: resolvedAmount.amountRaw,
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
type MarginfiDiscoveryResult = {
  accounts: AnyMarginfiAccount[];
  errors: string[];
};
type InstructionsWrapper = {
  instructions?: TransactionInstruction[];
  keys?: Keypair[];
};

async function defaultMarginfiSdkLoader(): Promise<MarginfiSdkModule> {
  try {
    return await import('@mrgnlabs/marginfi-client-v2');
  } catch {
    throw new AdapterError(MARGINFI_ADAPTER_ID, 'sdk_unavailable', SDK_UNAVAILABLE_REASON);
  }
}

async function loadMarginfiSdk(): Promise<MarginfiSdkModule> {
  const sdk = await sdkLoader();
  loadedSdkModule = sdk;
  return sdk;
}

async function buildSdkClient(connection: Connection, walletAddress: string): Promise<AnyMarginfiClient> {
  const sdk = await loadMarginfiSdk();
  const MarginfiClientCtor = sdk.MarginfiClient ?? sdk.default;
  if (!MarginfiClientCtor || typeof MarginfiClientCtor.fetch !== 'function' || typeof sdk.getConfig !== 'function') {
    throw new AdapterError(
      MARGINFI_ADAPTER_ID,
      'sdk_invalid',
      'MarginFi SDK did not expose MarginfiClient.fetch and getConfig.',
    );
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
  const client = await MarginfiClientCtor.fetch(config, wallet, connection, {
    readOnly: true,
    confirmOpts: { commitment: 'confirmed' },
  });
  requireClientMethod(client, 'getMarginfiAccountsForAuthority');
  requireClientMethod(client, 'getBankByPk');
  requireClientMethod(client, 'getBankByMint');
  requireClientMethod(client, 'getBankByTokenSymbol');
  requireClientMethod(client, 'getOraclePriceByBank');
  return client;
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
    return requireClientMethod(client, 'getBankByPk').call(client, new PublicKey(input.bankAddress.trim()));
  }
  if (input.bankMint?.trim()) {
    return requireClientMethod(client, 'getBankByMint').call(client, new PublicKey(input.bankMint.trim()));
  }
  if (input.token?.trim()) {
    return requireClientMethod(client, 'getBankByTokenSymbol').call(client, input.token.trim());
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
    return fetchMarginfiAccountWrapper(client, new PublicKey(input.marginfiAccount.trim()));
  }
  const discovery = await discoverMarginfiAccounts(client, input.walletAddress);
  const accounts = discovery.accounts;
  if (accounts.length === 1) {
    return accounts[0]!;
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
      `MarginFi account was not discoverable for this wallet. If app.marginfi.com shows an account, pass its account address as marginfiAccount.${discovery.errors.length ? ` Discovery errors: ${discovery.errors.slice(0, 3).join('; ')}.` : ''}`,
    );
  }
  throw new AdapterError(
    MARGINFI_ADAPTER_ID,
    'ambiguous_account',
    `Multiple MarginFi accounts were discovered (${accounts.map((account) => toBase58(account.address)).join(', ')}). Pass marginfiAccount explicitly.`,
  );
}

async function discoverMarginfiAccounts(
  client: AnyMarginfiClient,
  walletAddress: string,
): Promise<MarginfiDiscoveryResult> {
  const authority = new PublicKey(walletAddress);
  const errors: string[] = [];
  const accounts: AnyMarginfiAccount[] = [];

  try {
    const direct = await requireClientMethod(client, 'getMarginfiAccountsForAuthority').call(client, authority);
    if (Array.isArray(direct)) accounts.push(...direct);
  } catch (err) {
    errors.push(`SDK account scan failed: ${errorMessage(err)}`);
  }

  if (accounts.length === 0) {
    const addresses = await marginfiAccountAddressesForWallet(client, authority, errors);
    for (const address of addresses) {
      try {
        accounts.push(await fetchMarginfiAccountWrapper(client, address));
      } catch (err) {
        errors.push(`account fetch ${address.toBase58()} failed: ${errorMessage(err)}`);
      }
    }
  }

  return {
    accounts: dedupeMarginfiAccounts(accounts),
    errors,
  };
}

async function marginfiAccountAddressesForWallet(
  client: AnyMarginfiClient,
  authority: PublicKey,
  errors: string[],
): Promise<PublicKey[]> {
  const sdk = loadedSdkModule ?? await loadMarginfiSdk();
  const group = marginfiGroupAddress(client);
  if (!client.program || !group || typeof sdk.fetchMarginfiAccountAddresses !== 'function') {
    return [];
  }
  try {
    return normalizePublicKeys(await sdk.fetchMarginfiAccountAddresses(client.program, authority, group));
  } catch (err) {
    errors.push(`direct account scan failed: ${errorMessage(err)}`);
    return [];
  }
}

async function fetchMarginfiAccountWrapper(client: AnyMarginfiClient, address: PublicKey): Promise<AnyMarginfiAccount> {
  const sdk = loadedSdkModule ?? await loadMarginfiSdk();
  const wrapper = sdk.MarginfiAccountWrapper;
  if (!wrapper || typeof wrapper.fetch !== 'function') {
    throw new AdapterError(
      MARGINFI_ADAPTER_ID,
      'sdk_invalid',
      'MarginFi SDK did not expose MarginfiAccountWrapper.fetch.',
    );
  }
  return wrapper.fetch(address, client as any);
}

function marginfiGroupAddress(client: AnyMarginfiClient): PublicKey | undefined {
  return publicKeyFromUnknown(
    client.groupAddress ??
    client.group?.address ??
    client.config?.groupPk ??
    client.config?.groupAddress ??
    client.config?.group,
  );
}

function normalizePublicKeys(values: unknown): PublicKey[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const publicKey = publicKeyFromUnknown(value);
    return publicKey ? [publicKey] : [];
  });
}

function publicKeyFromUnknown(value: unknown): PublicKey | undefined {
  if (!value) return undefined;
  if (value instanceof PublicKey) return value;
  const text = toBase58(value);
  if (!text) return undefined;
  try {
    return new PublicKey(text);
  } catch {
    return undefined;
  }
}

function dedupeMarginfiAccounts(accounts: AnyMarginfiAccount[]): AnyMarginfiAccount[] {
  const seen = new Set<string>();
  const result: AnyMarginfiAccount[] = [];
  for (const account of accounts) {
    const address = toBase58(account.address);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    result.push(account);
  }
  return result;
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
      return requireInstructionsWrapper(
        await requireAccountMethod(account, 'makeDepositIx').call(account, amount, bankAddress),
        operation,
      );
    case 'withdraw':
      return requireInstructionsWrapper(
        await requireAccountMethod(account, 'makeWithdrawIx').call(account, amount, bankAddress, input.withdrawAll === true),
        operation,
      );
    case 'borrow':
      return requireInstructionsWrapper(
        await requireAccountMethod(account, 'makeBorrowIx').call(account, amount, bankAddress),
        operation,
      );
    case 'repay':
      return requireInstructionsWrapper(
        await requireAccountMethod(account, 'makeRepayIx').call(account, amount, bankAddress, input.repayAll === true),
        operation,
      );
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
    const bank = requireClientMethod(client, 'getBankByPk').call(client, balance.bankPk);
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
  const components = requireAccountMethod(account, 'computeHealthComponents')
    .call(account, sdkMarginRequirement.Maintenance);
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
  let sdk: { MarginRequirementType?: { Maintenance: unknown } };
  try {
    sdk = (loadedSdkModule ?? require('@mrgnlabs/marginfi-client-v2')) as {
      MarginRequirementType?: { Maintenance: unknown };
    };
  } catch {
    throw new AdapterError(MARGINFI_ADAPTER_ID, 'sdk_unavailable', SDK_UNAVAILABLE_REASON);
  }
  if (!sdk.MarginRequirementType) {
    throw new AdapterError(
      MARGINFI_ADAPTER_ID,
      'sdk_invalid',
      'MarginFi SDK did not expose MarginRequirementType.',
    );
  }
  return sdk.MarginRequirementType;
}

interface ResolvedMarginfiAmount {
  amount: string;
  amountRaw: string;
  withdrawAll?: boolean;
  repayAll?: boolean;
}

export function normalizeMarginfiActionInput<T extends MarginfiActionBuildInput>(input: T): T {
  const amount = input.amount?.trim();
  if (input.operation !== 'withdraw' && input.withdrawAll === true) {
    throw new AdapterError(
      MARGINFI_ADAPTER_ID,
      'invalid_amount',
      'withdrawAll is only valid for MarginFi withdraw actions.',
    );
  }
  if (input.operation !== 'repay' && input.repayAll === true) {
    throw new AdapterError(
      MARGINFI_ADAPTER_ID,
      'invalid_amount',
      'repayAll is only valid for MarginFi repay actions.',
    );
  }
  if (!isAllAmount(amount)) return input;
  if (input.operation === 'withdraw') {
    const { amount: _amount, ...rest } = input;
    return { ...rest, withdrawAll: true } as T;
  }
  if (input.operation === 'repay') {
    const { amount: _amount, ...rest } = input;
    return { ...rest, repayAll: true } as T;
  }
  throw new AdapterError(
    MARGINFI_ADAPTER_ID,
    'invalid_amount',
    `Amount "all" is only valid for MarginFi withdraw and repay actions.`,
  );
}

function resolveActionAmount(
  account: AnyMarginfiAccount,
  bank: MarginfiBankSnapshot,
  input: MarginfiActionBuildInput,
): ResolvedMarginfiAmount {
  const normalized = normalizeMarginfiActionInput(input);
  if (normalized.withdrawAll) {
    const position = positionForBank(account, bank.bankAddress);
    if (!position || !positiveDecimal(position.suppliedAmount)) {
      throw new AdapterError(MARGINFI_ADAPTER_ID, 'no_position', 'No supplied MarginFi balance is available to withdraw.');
    }
    return {
      amount: position.suppliedAmount,
      amountRaw: parseMarginfiAmount(position.suppliedAmount, bank.decimals, 'withdraw'),
      withdrawAll: true,
    };
  }
  if (normalized.repayAll) {
    const position = positionForBank(account, bank.bankAddress);
    if (!position || !positiveDecimal(position.borrowedAmount)) {
      throw new AdapterError(MARGINFI_ADAPTER_ID, 'no_debt', 'No MarginFi debt is available to repay for this bank.');
    }
    return {
      amount: position.borrowedAmount,
      amountRaw: parseMarginfiAmount(position.borrowedAmount, bank.decimals, 'repay'),
      repayAll: true,
    };
  }
  if (!normalized.amount?.trim()) {
    throw new AdapterError(
      MARGINFI_ADAPTER_ID,
      'invalid_amount',
      `Amount is required for MarginFi ${normalized.operation}.`,
    );
  }
  const amount = normalized.amount.trim();
  return {
    amount,
    amountRaw: parseMarginfiAmount(amount, bank.decimals, normalized.operation),
    ...(normalized.withdrawAll ? { withdrawAll: true } : {}),
    ...(normalized.repayAll ? { repayAll: true } : {}),
  };
}

function parseMarginfiAmount(amount: string, decimals: number, operation: MarginfiOperation): string {
  return parseDecimalAmount(amount, decimals, `MarginFi ${operation} amount`).toString();
}

function isAllAmount(amount: string | undefined): boolean {
  return amount?.toLowerCase() === 'all';
}

function requireClientMethod(client: AnyMarginfiClient, method: string): (...args: any[]) => any {
  const candidate = client?.[method];
  if (typeof candidate !== 'function') {
    throw new AdapterError(
      MARGINFI_ADAPTER_ID,
      'sdk_invalid',
      `MarginFi SDK client did not expose ${method}.`,
    );
  }
  return candidate;
}

function requireAccountMethod(account: AnyMarginfiAccount, method: string): (...args: any[]) => any {
  const candidate = account?.[method];
  if (typeof candidate !== 'function') {
    throw new AdapterError(
      MARGINFI_ADAPTER_ID,
      'sdk_invalid',
      `MarginFi account did not expose ${method}.`,
    );
  }
  return candidate;
}

function requireInstructionsWrapper(wrapper: InstructionsWrapper | undefined, operation: MarginfiOperation): InstructionsWrapper {
  if (!wrapper || !Array.isArray(wrapper.instructions) || wrapper.instructions.length === 0) {
    throw new AdapterError(
      MARGINFI_ADAPTER_ID,
      'invalid_response',
      `MarginFi SDK returned no instructions for ${operation}.`,
    );
  }
  return wrapper;
}

function positionForBank(account: AnyMarginfiAccount, bankAddress: string): MarginfiPosition | undefined {
  const client = account.client as AnyMarginfiClient;
  const balance = (account.activeBalances ?? []).find((entry: AnyBank) => toBase58(entry.bankPk) === bankAddress);
  if (!balance) return undefined;
  const bank = requireClientMethod(client, 'getBankByPk').call(client, balance.bankPk);
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
