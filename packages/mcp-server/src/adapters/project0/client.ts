import { createRequire } from 'node:module';

import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';

import { parseDecimalAmount } from '../../amounts.js';
import { AdapterError } from '../types.js';
import {
  DEFAULT_PROJECT0_MIN_HEALTH_RATIO,
  PROJECT0_ADAPTER_ID,
  PROJECT0_API_BASE_URL,
} from './constants.js';

export type Project0Operation = 'deposit' | 'withdraw' | 'borrow' | 'repay';
export type Project0ActionOperation = 'create_account' | Project0Operation;

export interface Project0BankLookupInput {
  bankAddress?: string;
  bankMint?: string;
  token?: string;
}

export interface Project0Bank {
  bankAddress: string;
  symbol: string;
  mint: string;
  mintDecimals: number;
  venue: string;
  depositApy: number;
  borrowApy: number;
  usdPrice: number;
  tokenProgram?: string;
}

export interface Project0Strategy {
  heading: string;
  primaryBankAddress: string;
  secondaryBankAddress?: string;
  spread?: number;
  leverage?: number;
  apy?: number;
  capacity?: string | number;
}

export interface Project0WalletToken {
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  balance: string;
  usdPrice?: number;
  usdValue?: number;
}

export interface Project0WalletSnapshot {
  wallet: string;
  totalUsdValue?: number;
  tokens: Project0WalletToken[];
}

export interface Project0Position {
  bankAddress: string;
  bankMint: string;
  tokenSymbol?: string;
  venue?: string;
  decimals: number;
  suppliedAmount: string;
  borrowedAmount: string;
  suppliedUsd?: string;
  borrowedUsd?: string;
  assetShares?: string;
  liabilityShares?: string;
}

export interface Project0HealthComponents {
  assets: string;
  liabilities: string;
  netValue: string;
  healthRatio: number | null;
  healthRatioText: string;
  healthy: boolean;
}

export interface Project0AccountDetail {
  project0Account: string;
  authority: string;
  activeBalances: number;
  health: Project0HealthComponents;
  positions: Project0Position[];
  netApy?: number;
}

export interface Project0HealthPreview {
  operation: Project0ActionOperation;
  project0Account?: string;
  accountIndex?: number;
  bankAddress?: string;
  bankMint?: string;
  tokenSymbol?: string;
  venue?: string;
  amount?: string;
  amountRaw?: string;
  withdrawAll?: boolean;
  repayAll?: boolean;
  before?: Project0HealthComponents;
  after?: Project0HealthComponents;
  minHealthRatio: number;
  blocked: boolean;
  warnings: string[];
  simulatedAt: string;
}

export interface Project0ActionInput extends Project0BankLookupInput {
  operation: Project0ActionOperation;
  walletAddress: string;
  project0Account?: string;
  accountIndex?: number;
  amount?: string;
  withdrawAll?: boolean;
  repayAll?: boolean;
  minHealthRatio?: number;
}

export interface Project0BuildTransactionResult {
  transactionsBase64: string[];
  project0Account?: string;
  accountIndex?: number;
  bank?: Project0Bank;
  amount?: string;
  amountRaw?: string;
}

export interface Project0Client {
  listBanks(input?: Project0BankLookupInput): Promise<Project0Bank[]>;
  listStrategies(): Promise<Project0Strategy[]>;
  getWallet(walletAddress: string): Promise<Project0WalletSnapshot>;
  getAccountDetail(connection: Connection, input: { walletAddress: string; project0Account?: string }): Promise<Project0AccountDetail>;
  previewHealth(connection: Connection, input: Project0ActionInput): Promise<Project0HealthPreview>;
  buildActionTransaction(connection: Connection, input: Project0ActionInput): Promise<Project0BuildTransactionResult>;
}

export type Project0ClientFactory = (apiBaseUrl?: string) => Project0Client;

const require = createRequire(import.meta.url);
const SDK_UNAVAILABLE_REASON =
  '@0dotxyz/p0-ts-sdk is not installed. Install the optional Project 0 SDK dependency or inject a mock client for tests.';

type Project0SdkModule = Record<string, any>;
type Project0SdkLoader = () => Promise<Project0SdkModule>;
type AnyProject0Client = Record<string, any>;
type AnyProject0Account = Record<string, any>;
type AnyProject0Bank = Record<string, any>;
type Project0DiscoveryResult = {
  addresses: PublicKey[];
  errors: string[];
};

const PROJECT0_ACCOUNT_SCAN_LIMIT = 256;
const PROJECT0_ACCOUNT_SCAN_BATCH_SIZE = 64;

let sdkLoader: Project0SdkLoader = defaultProject0SdkLoader;
let loadedSdkModule: Project0SdkModule | undefined;
let factory: Project0ClientFactory = (apiBaseUrl) => new RealProject0Client(apiBaseUrl);

export function setProject0ClientFactory(next: Project0ClientFactory): void {
  factory = next;
}

export function resetProject0ClientFactory(): void {
  factory = (apiBaseUrl) => new RealProject0Client(apiBaseUrl);
}

export function getProject0Client(apiBaseUrl?: string): Project0Client {
  return factory(apiBaseUrl);
}

export function setProject0SdkLoaderForTests(next: Project0SdkLoader): void {
  sdkLoader = next;
  loadedSdkModule = undefined;
}

export function resetProject0SdkLoaderForTests(): void {
  sdkLoader = defaultProject0SdkLoader;
  loadedSdkModule = undefined;
}

export function describeProject0SdkUnavailableReason(): string | undefined {
  try {
    require.resolve('@0dotxyz/p0-ts-sdk');
    return undefined;
  } catch {
    return SDK_UNAVAILABLE_REASON;
  }
}

class RealProject0Client implements Project0Client {
  private sdkClientCache = new Map<string, Promise<AnyProject0Client>>();
  private readonly apiBaseUrl: string;

  constructor(apiBaseUrl?: string) {
    this.apiBaseUrl = stripTrailingSlashes(apiBaseUrl ?? PROJECT0_API_BASE_URL);
  }

  async listBanks(input: Project0BankLookupInput = {}): Promise<Project0Bank[]> {
    const banks = await fetchProject0Json<unknown[]>(`${this.apiBaseUrl}/api/banks`);
    const normalized = banks.flatMap(normalizeBank);
    return filterBanks(normalized, input);
  }

  async listStrategies(): Promise<Project0Strategy[]> {
    const strategies = await fetchProject0Json<unknown[]>(`${this.apiBaseUrl}/api/strategies`);
    return strategies.flatMap(normalizeStrategy);
  }

  async getWallet(walletAddress: string): Promise<Project0WalletSnapshot> {
    const wallet = walletAddress.trim();
    if (!wallet) {
      throw new AdapterError(PROJECT0_ADAPTER_ID, 'invalid_wallet', 'Project 0 wallet read requires a wallet address.');
    }
    const body = await fetchProject0Json<Record<string, unknown>>(`${this.apiBaseUrl}/api/wallet/${encodeURIComponent(wallet)}`);
    const tokensRaw = Array.isArray(body.tokens) ? body.tokens : [];
    return {
      wallet: stringValue(body.wallet) ?? wallet,
      ...(numberValue(body.total_usd_value, body.totalUsdValue) !== undefined
        ? { totalUsdValue: numberValue(body.total_usd_value, body.totalUsdValue) }
        : {}),
      tokens: tokensRaw.flatMap(normalizeWalletToken),
    };
  }

  async getAccountDetail(
    connection: Connection,
    input: { walletAddress: string; project0Account?: string },
  ): Promise<Project0AccountDetail> {
    const sdkClient = await this.sdkClient(connection);
    const account = await resolveProject0Account(connection, sdkClient, input);
    const banks = await this.listBanks();
    return accountDetailFromSdkAccount(sdkClient, account, banks);
  }

  async previewHealth(connection: Connection, input: Project0ActionInput): Promise<Project0HealthPreview> {
    const minHealthRatio = input.minHealthRatio ?? DEFAULT_PROJECT0_MIN_HEALTH_RATIO;
    if (input.operation === 'create_account') {
      const accountIndex = await resolveCreateAccountIndex(connection, await this.sdkClient(connection), input);
      return {
        operation: 'create_account',
        accountIndex,
        minHealthRatio,
        blocked: false,
        warnings: [],
        simulatedAt: new Date().toISOString(),
      };
    }

    const sdkClient = await this.sdkClient(connection);
    const account = await resolveProject0Account(connection, sdkClient, input);
    const bank = await this.requireBank(input);
    const sdkBank = requireSdkBank(sdkClient, bank.bankAddress);
    const resolvedAmount = resolveProject0Amount(account, bank, input);
    const before = healthFromProject0Account(account);
    const warnings: string[] = [];
    let after: Project0HealthComponents | undefined;

    try {
      const txs = await buildOperationTransactions(connection, sdkClient, account, sdkBank, input.operation, resolvedAmount);
      if (typeof account.simulateBorrowLendTransaction === 'function' && txs.length > 0) {
        const simulation = await account.simulateBorrowLendTransaction(
          txs,
          [sdkBank.address ?? new PublicKey(bank.bankAddress)],
          { enabled: true, mandatoryBanks: [sdkBank.address ?? new PublicKey(bank.bankAddress)], excludedBanks: [] },
        );
        after = healthFromProject0Account(simulation.marginfiAccount ?? simulation.account ?? simulation);
      } else {
        const capacityWarning = project0CapacityWarning(account, sdkBank, input.operation, resolvedAmount.amount, bank.symbol);
        if (capacityWarning) warnings.push(capacityWarning);
      }
    } catch (err) {
      warnings.push(`Health simulation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const blocked = healthBlocked(input.operation, after, warnings, minHealthRatio);
    return {
      operation: input.operation,
      project0Account: toBase58(account.address),
      bankAddress: bank.bankAddress,
      bankMint: bank.mint,
      tokenSymbol: bank.symbol,
      venue: bank.venue,
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

  async buildActionTransaction(connection: Connection, input: Project0ActionInput): Promise<Project0BuildTransactionResult> {
    const sdkClient = await this.sdkClient(connection);
    const walletAddress = new PublicKey(input.walletAddress);
    if (input.operation === 'create_account') {
      const accountIndex = await resolveCreateAccountIndex(connection, sdkClient, input);
      const tx = await requireSdkMethod(sdkClient, 'createMarginfiAccountTx').call(sdkClient, walletAddress, accountIndex);
      return {
        transactionsBase64: [await serializeTransaction(connection, tx, walletAddress)],
        accountIndex,
      };
    }

    const account = await resolveProject0Account(connection, sdkClient, input);
    const bank = await this.requireBank(input);
    const sdkBank = requireSdkBank(sdkClient, bank.bankAddress);
    const resolvedAmount = resolveProject0Amount(account, bank, input);
    const txs = await buildOperationTransactions(connection, sdkClient, account, sdkBank, input.operation, resolvedAmount);
    return {
      transactionsBase64: await Promise.all(txs.map((tx) => serializeTransaction(connection, tx, walletAddress))),
      project0Account: toBase58(account.address),
      bank,
      amount: resolvedAmount.amount,
      amountRaw: resolvedAmount.amountRaw,
    };
  }

  private async requireBank(input: Project0BankLookupInput): Promise<Project0Bank> {
    const banks = await this.listBanks(input);
    const bank = banks[0];
    if (!bank) {
      throw new AdapterError(
        PROJECT0_ADAPTER_ID,
        'missing_bank',
        'Project 0 bank was not found. Pass bankAddress, bankMint, or token.',
      );
    }
    return bank;
  }

  private async sdkClient(connection: Connection): Promise<AnyProject0Client> {
    const key = connection.rpcEndpoint ?? 'connection';
    const cached = this.sdkClientCache.get(key);
    if (cached) return cached;
    const promise = buildSdkClient(connection);
    this.sdkClientCache.set(key, promise);
    return promise;
  }
}

async function defaultProject0SdkLoader(): Promise<Project0SdkModule> {
  try {
    return await import('@0dotxyz/p0-ts-sdk');
  } catch {
    throw new AdapterError(PROJECT0_ADAPTER_ID, 'sdk_unavailable', SDK_UNAVAILABLE_REASON);
  }
}

async function loadProject0Sdk(): Promise<Project0SdkModule> {
  const sdk = await sdkLoader();
  loadedSdkModule = sdk;
  return sdk;
}

async function buildSdkClient(connection: Connection): Promise<AnyProject0Client> {
  const sdk = loadedSdkModule ?? await loadProject0Sdk();
  const Project0ClientCtor = sdk.Project0Client ?? sdk.default;
  if (!Project0ClientCtor || typeof Project0ClientCtor.initialize !== 'function' || typeof sdk.getConfig !== 'function') {
    throw new AdapterError(
      PROJECT0_ADAPTER_ID,
      'sdk_invalid',
      'Project 0 SDK did not expose Project0Client.initialize and getConfig.',
    );
  }
  const config = sdk.getConfig('production');
  const client = await Project0ClientCtor.initialize(connection, config);
  requireSdkMethod(client, 'getBank');
  return client;
}

async function resolveProject0Account(
  connection: Connection,
  client: AnyProject0Client,
  input: { walletAddress: string; project0Account?: string },
): Promise<AnyProject0Account> {
  if (input.project0Account?.trim()) {
    if (typeof client.fetchAccount === 'function') {
      return client.fetchAccount(new PublicKey(input.project0Account.trim()));
    }
    const sdk = await loadProject0Sdk();
    if (!sdk.MarginfiAccount || !sdk.MarginfiAccountWrapper) {
      throw new AdapterError(PROJECT0_ADAPTER_ID, 'sdk_invalid', 'Project 0 SDK did not expose account fetch helpers.');
    }
    const account = await sdk.MarginfiAccount.fetch(new PublicKey(input.project0Account.trim()), client.program);
    return new sdk.MarginfiAccountWrapper(account, client);
  }
  const discovery = await accountAddressesForWallet(connection, client, input.walletAddress);
  const addresses = discovery.addresses;
  if (addresses.length === 1) {
    const address = addresses[0]!;
    return typeof client.fetchAccount === 'function'
      ? client.fetchAccount(address)
      : resolveProject0Account(connection, client, { walletAddress: input.walletAddress, project0Account: toBase58(address) });
  }
  if (addresses.length === 0) {
    const discoveryHint = discovery.errors.length
      ? ` Discovery errors: ${discovery.errors.slice(0, 3).join('; ')}.`
      : '';
    throw new AdapterError(
      PROJECT0_ADAPTER_ID,
      'missing_account',
      `Project 0 account was not discoverable for this wallet after SDK scan and PDA probes. If app.0.xyz shows an account, pass its account address as project0Account.${discoveryHint}`,
    );
  }
  const addressList = addresses.map((address) => toBase58(address)).join(', ');
  throw new AdapterError(
    PROJECT0_ADAPTER_ID,
    'ambiguous_account',
    `Multiple Project 0 accounts were discovered (${addressList}). Pass project0Account explicitly.`,
  );
}

async function accountAddressesForWallet(
  connection: Connection,
  client: AnyProject0Client,
  walletAddress: string,
): Promise<Project0DiscoveryResult> {
  const authority = new PublicKey(walletAddress);
  const errors: string[] = [];
  const discovered: PublicKey[] = [];

  if (typeof client.getAccountAddresses === 'function') {
    try {
      discovered.push(...normalizePublicKeys(await client.getAccountAddresses(authority)));
    } catch (err) {
      errors.push(`SDK account scan failed: ${errorMessage(err)}`);
    }
  }

  const sdk = await loadProject0Sdk();
  const group = project0GroupAddress(client);
  const program = client.program;
  if (program && group && typeof sdk.fetchMarginfiAccountAddresses === 'function') {
    try {
      discovered.push(...normalizePublicKeys(await sdk.fetchMarginfiAccountAddresses(program, authority, group)));
    } catch (err) {
      errors.push(`direct account scan failed: ${errorMessage(err)}`);
    }
  }

  if (
    group &&
    program?.programId &&
    typeof sdk.deriveMarginfiAccount === 'function' &&
    typeof connection.getMultipleAccountsInfo === 'function'
  ) {
    try {
      discovered.push(...await probeProject0PdaAccounts(connection, sdk, program.programId, group, authority));
    } catch (err) {
      errors.push(`PDA probe failed: ${errorMessage(err)}`);
    }
  }

  return {
    addresses: dedupePublicKeys(discovered),
    errors,
  };
}

async function probeProject0PdaAccounts(
  connection: Connection,
  sdk: Project0SdkModule,
  programId: PublicKey,
  group: PublicKey,
  authority: PublicKey,
): Promise<PublicKey[]> {
  const thirdPartyIds = dedupeNumbers([
    0,
    Number(sdk.MARGINFI_SPONSORED_SHARD_ID),
  ]).filter((value) => Number.isInteger(value) && value >= 0 && value <= 65_535);
  const candidates: PublicKey[] = [];
  for (const thirdPartyId of thirdPartyIds) {
    for (let accountIndex = 0; accountIndex < PROJECT0_ACCOUNT_SCAN_LIMIT; accountIndex += 1) {
      candidates.push(sdk.deriveMarginfiAccount(programId, group, authority, accountIndex, thirdPartyId)[0]);
    }
  }
  const found: PublicKey[] = [];
  for (let start = 0; start < candidates.length; start += PROJECT0_ACCOUNT_SCAN_BATCH_SIZE) {
    const batch = candidates.slice(start, start + PROJECT0_ACCOUNT_SCAN_BATCH_SIZE);
    const infos = await connection.getMultipleAccountsInfo(batch);
    infos.forEach((info, index) => {
      if (info) found.push(batch[index]!);
    });
  }
  return found;
}

async function resolveCreateAccountIndex(
  connection: Connection,
  client: AnyProject0Client,
  input: Project0ActionInput,
): Promise<number> {
  if (input.accountIndex !== undefined) {
    if (!Number.isInteger(input.accountIndex) || input.accountIndex < 0) {
      throw new AdapterError(PROJECT0_ADAPTER_ID, 'invalid_account_index', 'Project 0 accountIndex must be a non-negative integer.');
    }
    return input.accountIndex;
  }
  const addresses = (await accountAddressesForWallet(connection, client, input.walletAddress)).addresses;
  if (addresses.length > 0) {
    throw new AdapterError(
      PROJECT0_ADAPTER_ID,
      'account_index_required',
      `This wallet already has Project 0 accounts (${addresses.map((address) => toBase58(address)).join(', ')}). Pass an explicit accountIndex for the new account.`,
    );
  }
  return 0;
}

function project0GroupAddress(client: AnyProject0Client): PublicKey | undefined {
  return publicKeyFromUnknown(
    client.group?.address ??
    client.groupAddress ??
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

function dedupePublicKeys(values: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const result: PublicKey[] = [];
  for (const value of values) {
    const key = value.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function dedupeNumbers(values: number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (!Number.isFinite(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireSdkBank(client: AnyProject0Client, bankAddress: string): AnyProject0Bank {
  const bank = requireSdkMethod(client, 'getBank').call(client, new PublicKey(bankAddress));
  if (!bank) {
    throw new AdapterError(PROJECT0_ADAPTER_ID, 'missing_bank', `Project 0 SDK did not find bank ${bankAddress}.`);
  }
  return bank;
}

interface ResolvedProject0Amount {
  amount: string;
  amountRaw: string;
  withdrawAll?: boolean;
  repayAll?: boolean;
}

function resolveProject0Amount(
  account: AnyProject0Account,
  bank: Project0Bank,
  input: Project0ActionInput,
): ResolvedProject0Amount {
  const normalized = normalizeProject0ActionInput(input);
  if (normalized.withdrawAll) {
    const position = positionForBank(account, bank.bankAddress, bank);
    if (!position || !positiveDecimal(position.suppliedAmount)) {
      throw new AdapterError(PROJECT0_ADAPTER_ID, 'no_position', 'No Project 0 supplied balance is available to withdraw for this bank.');
    }
    return {
      amount: position.suppliedAmount,
      amountRaw: parseProject0Amount(position.suppliedAmount, bank.mintDecimals, 'withdraw'),
      withdrawAll: true,
    };
  }
  if (normalized.repayAll) {
    const position = positionForBank(account, bank.bankAddress, bank);
    if (!position || !positiveDecimal(position.borrowedAmount)) {
      throw new AdapterError(PROJECT0_ADAPTER_ID, 'no_debt', 'No Project 0 debt is available to repay for this bank.');
    }
    return {
      amount: position.borrowedAmount,
      amountRaw: parseProject0Amount(position.borrowedAmount, bank.mintDecimals, 'repay'),
      repayAll: true,
    };
  }
  if (!normalized.amount?.trim()) {
    throw new AdapterError(PROJECT0_ADAPTER_ID, 'invalid_amount', `Amount is required for Project 0 ${normalized.operation}.`);
  }
  const amount = normalized.amount.trim();
  return {
    amount,
    amountRaw: parseProject0Amount(amount, bank.mintDecimals, normalized.operation),
  };
}

export function normalizeProject0ActionInput<T extends Project0ActionInput>(input: T): T {
  const amount = input.amount?.trim();
  if (input.operation !== 'withdraw' && input.withdrawAll === true) {
    throw new AdapterError(PROJECT0_ADAPTER_ID, 'invalid_amount', 'withdrawAll is only valid for Project 0 withdraw actions.');
  }
  if (input.operation !== 'repay' && input.repayAll === true) {
    throw new AdapterError(PROJECT0_ADAPTER_ID, 'invalid_amount', 'repayAll is only valid for Project 0 repay actions.');
  }
  if (amount?.toLowerCase() !== 'all') return input;
  if (input.operation === 'withdraw') {
    const { amount: _amount, ...rest } = input;
    return { ...rest, withdrawAll: true } as T;
  }
  if (input.operation === 'repay') {
    const { amount: _amount, ...rest } = input;
    return { ...rest, repayAll: true } as T;
  }
  throw new AdapterError(PROJECT0_ADAPTER_ID, 'invalid_amount', 'Amount "all" is only valid for Project 0 withdraw and repay actions.');
}

async function buildOperationTransactions(
  connection: Connection,
  client: AnyProject0Client,
  account: AnyProject0Account,
  bank: AnyProject0Bank,
  operation: Project0Operation,
  amount: ResolvedProject0Amount,
): Promise<any[]> {
  const bankAddress = bank.address ?? new PublicKey(toBase58(bank.publicKey));
  const raw = await buildOperationResult(account, bankAddress, operation, amount.amount, amount);
  return normalizeTransactions(raw, connection, client);
}

async function buildOperationResult(
  account: AnyProject0Account,
  bankAddress: PublicKey,
  operation: Project0Operation,
  amount: string,
  input: { withdrawAll?: boolean; repayAll?: boolean },
): Promise<unknown> {
  switch (operation) {
    case 'deposit':
      return requireAccountMethod(account, 'makeDepositTx').call(account, bankAddress, amount);
    case 'withdraw':
      return requireAccountMethod(account, 'makeWithdrawTx').call(account, bankAddress, amount, input.withdrawAll === true);
    case 'borrow':
      return requireAccountMethod(account, 'makeBorrowTx').call(account, bankAddress, amount);
    case 'repay':
      return requireAccountMethod(account, 'makeRepayTx').call(account, bankAddress, amount, input.repayAll === true);
  }
}

function normalizeTransactions(raw: unknown, _connection: Connection, _client: AnyProject0Client): any[] {
  if (Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown> | undefined;
  if (Array.isArray(record?.transactions)) return record.transactions;
  if (record?.transaction) return [record.transaction];
  if (raw) return [raw];
  throw new AdapterError(PROJECT0_ADAPTER_ID, 'invalid_response', 'Project 0 SDK returned no transaction.');
}

async function serializeTransaction(connection: Connection, transaction: any, feePayer: PublicKey): Promise<string> {
  if (isVersionedTransaction(transaction)) {
    return Buffer.from(transaction.serialize()).toString('base64');
  }
  if (transaction instanceof Transaction || typeof transaction.serialize === 'function') {
    if (!transaction.feePayer) transaction.feePayer = feePayer;
    if (!transaction.recentBlockhash) {
      const latest = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = latest.blockhash;
    }
    try {
      return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    } catch {
      return Buffer.from(transaction.serialize()).toString('base64');
    }
  }
  throw new AdapterError(PROJECT0_ADAPTER_ID, 'invalid_response', 'Project 0 SDK returned an unserializable transaction.');
}

function isVersionedTransaction(value: unknown): value is VersionedTransaction {
  return value instanceof VersionedTransaction || (
    value !== null &&
    typeof value === 'object' &&
    'version' in value &&
    'message' in value &&
    typeof (value as { serialize?: unknown }).serialize === 'function'
  );
}

function accountDetailFromSdkAccount(
  client: AnyProject0Client,
  account: AnyProject0Account,
  banks: Project0Bank[],
): Project0AccountDetail {
  const positions = (account.activeBalances ?? []).flatMap((balance: AnyProject0Bank) => {
    const bankAddress = toBase58(balance.bankPk);
    const metadata = banks.find((bank) => bank.bankAddress === bankAddress);
    const sdkBank = safeCall(() => requireSdkMethod(client, 'getBank').call(client, balance.bankPk));
    if (!sdkBank && !metadata) return [];
    return [positionFromBalance(balance, sdkBank, metadata)];
  });
  return {
    project0Account: toBase58(account.address),
    authority: toBase58(account.authority),
    activeBalances: Array.isArray(account.activeBalances) ? account.activeBalances.length : 0,
    health: healthFromProject0Account(account),
    positions,
    ...(typeof account.computeNetApy === 'function' ? { netApy: Number(account.computeNetApy()) } : {}),
  };
}

function positionForBank(account: AnyProject0Account, bankAddress: string, metadata: Project0Bank): Project0Position | undefined {
  const balance = (account.activeBalances ?? []).find((entry: AnyProject0Bank) => toBase58(entry.bankPk) === bankAddress);
  return balance ? positionFromBalance(balance, undefined, metadata) : undefined;
}

function positionFromBalance(
  balance: AnyProject0Bank,
  sdkBank: AnyProject0Bank | undefined,
  metadata: Project0Bank | undefined,
): Project0Position {
  const quantities = safeCall(() => {
    if (sdkBank) return balance.computeQuantityUi(sdkBank);
    return undefined;
  }) ?? { assets: '0', liabilities: '0' };
  const suppliedAmount = decimalString(quantities.assets);
  const borrowedAmount = decimalString(quantities.liabilities);
  const price = metadata?.usdPrice;
  return {
    bankAddress: metadata?.bankAddress ?? toBase58(balance.bankPk),
    bankMint: metadata?.mint ?? toBase58(sdkBank?.mint),
    ...(metadata?.symbol ? { tokenSymbol: metadata.symbol } : {}),
    ...(metadata?.venue ? { venue: metadata.venue } : {}),
    decimals: metadata?.mintDecimals ?? Number(sdkBank?.mintDecimals ?? 0),
    suppliedAmount,
    borrowedAmount,
    ...(price !== undefined ? { suppliedUsd: trimDecimal(Number(suppliedAmount) * price) } : {}),
    ...(price !== undefined ? { borrowedUsd: trimDecimal(Number(borrowedAmount) * price) } : {}),
    ...(balance.assetShares !== undefined ? { assetShares: decimalString(balance.assetShares) } : {}),
    ...(balance.liabilityShares !== undefined ? { liabilityShares: decimalString(balance.liabilityShares) } : {}),
  };
}

function healthFromProject0Account(account: AnyProject0Account): Project0HealthComponents {
  const marginRequirement = marginRequirementType();
  const components = typeof account.computeHealthComponentsFromCache === 'function'
    ? account.computeHealthComponentsFromCache(marginRequirement.Maintenance)
    : requireAccountMethod(account, 'computeHealthComponents').call(account, marginRequirement.Maintenance);
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
  const sdk = loadedSdkModule ?? (safeCall(() => require('@0dotxyz/p0-ts-sdk')) as Project0SdkModule | undefined);
  if (!sdk?.MarginRequirementType) {
    throw new AdapterError(PROJECT0_ADAPTER_ID, 'sdk_invalid', 'Project 0 SDK did not expose MarginRequirementType.');
  }
  return sdk.MarginRequirementType as { Maintenance: unknown };
}

function healthBlocked(
  operation: Project0Operation,
  after: Project0HealthComponents | undefined,
  warnings: string[],
  minHealthRatio: number,
): boolean {
  if (operation !== 'borrow' && operation !== 'withdraw') return false;
  if (!after) return warnings.length === 0 || warnings.some((warning) => /exceeds|capacity is unavailable|stale|oracle|risk engine|simulation failed/i.test(warning));
  if (!after.healthy) return true;
  if (after.healthRatio !== null && after.healthRatio < minHealthRatio) return true;
  return warnings.some((warning) => /stale|oracle|risk engine|simulation failed/i.test(warning));
}

function project0CapacityWarning(
  account: AnyProject0Account,
  bank: AnyProject0Bank,
  operation: Project0Operation,
  amount: string,
  tokenSymbol: string,
): string | undefined {
  if (operation !== 'borrow' && operation !== 'withdraw') return undefined;
  const method = operation === 'borrow' ? 'computeMaxBorrowForBank' : 'computeMaxWithdrawForBank';
  if (typeof account[method] !== 'function') {
    return 'Project 0 borrow/withdraw capacity is unavailable: SDK did not expose a max borrow/withdraw helper.';
  }
  const bankAddress = bank.address ?? new PublicKey(toBase58(bank.publicKey));
  const max = numberFromSdkDecimal(account[method](bankAddress));
  const requested = Number(amount);
  if (!Number.isFinite(max) || max < 0) {
    return `Projected health ratio unavailable; Project 0 ${operation} capacity is unavailable.`;
  }
  if (Number.isFinite(requested) && requested > max) {
    return `Requested ${operation} ${amount} ${tokenSymbol} exceeds Project 0 max ${operation} ${trimDecimal(max)} ${tokenSymbol}.`;
  }
  return `Projected health ratio unavailable; Project 0 max ${operation} check passed up to ${trimDecimal(max)} ${tokenSymbol}.`;
}

function normalizeBank(value: unknown): Project0Bank[] {
  if (!value || typeof value !== 'object') return [];
  const entry = value as Record<string, unknown>;
  const bankAddress = stringValue(entry.bank_address, entry.bankAddress);
  const symbol = stringValue(entry.symbol);
  const mint = stringValue(entry.mint);
  const mintDecimals = numberValue(entry.mint_decimals, entry.mintDecimals);
  const venue = stringValue(entry.venue) ?? 'P0';
  if (!bankAddress || !symbol || !mint || mintDecimals === undefined) return [];
  return [{
    bankAddress,
    symbol,
    mint,
    mintDecimals,
    venue,
    depositApy: numberValue(entry.deposit_apy, entry.depositApy) ?? Number.NaN,
    borrowApy: numberValue(entry.borrow_apy, entry.borrowApy) ?? Number.NaN,
    usdPrice: numberValue(entry.usd_price, entry.usdPrice) ?? Number.NaN,
    ...(stringValue(entry.token_program, entry.tokenProgram) ? { tokenProgram: stringValue(entry.token_program, entry.tokenProgram)! } : {}),
  }];
}

function normalizeStrategy(value: unknown): Project0Strategy[] {
  if (!value || typeof value !== 'object') return [];
  const entry = value as Record<string, unknown>;
  const heading = stringValue(entry.heading, entry.name, entry.title);
  const primaryBankAddress = stringValue(entry.primaryBankAddress, entry.primary_bank_address);
  if (!heading || !primaryBankAddress) return [];
  return [{
    heading,
    primaryBankAddress,
    ...(stringValue(entry.secondaryBankAddress, entry.secondary_bank_address) ? {
      secondaryBankAddress: stringValue(entry.secondaryBankAddress, entry.secondary_bank_address)!,
    } : {}),
    ...(numberValue(entry.spread) !== undefined ? { spread: numberValue(entry.spread) } : {}),
    ...(numberValue(entry.leverage) !== undefined ? { leverage: numberValue(entry.leverage) } : {}),
    ...(numberValue(entry.apy) !== undefined ? { apy: numberValue(entry.apy) } : {}),
    ...(strategyCapacity(entry.capacity) !== undefined ? { capacity: strategyCapacity(entry.capacity)! } : {}),
  }];
}

function normalizeWalletToken(value: unknown): Project0WalletToken[] {
  if (!value || typeof value !== 'object') return [];
  const entry = value as Record<string, unknown>;
  const address = stringValue(entry.address, entry.mint);
  const symbol = stringValue(entry.symbol);
  const decimals = numberValue(entry.decimals);
  const balance = stringValue(entry.balance);
  if (!address || !symbol || decimals === undefined || !balance) return [];
  return [{
    address,
    symbol,
    ...(stringValue(entry.name) ? { name: stringValue(entry.name)! } : {}),
    decimals,
    balance,
    ...(numberValue(entry.usd_price, entry.usdPrice) !== undefined ? { usdPrice: numberValue(entry.usd_price, entry.usdPrice) } : {}),
    ...(numberValue(entry.usd_value, entry.usdValue) !== undefined ? { usdValue: numberValue(entry.usd_value, entry.usdValue) } : {}),
  }];
}

function filterBanks(banks: Project0Bank[], input: Project0BankLookupInput): Project0Bank[] {
  const bankAddress = input.bankAddress?.trim();
  const bankMint = input.bankMint?.trim();
  const token = input.token?.trim().toLowerCase();
  if (bankAddress) return banks.filter((bank) => bank.bankAddress === bankAddress);
  if (bankMint) return banks.filter((bank) => bank.mint === bankMint);
  if (token) return banks.filter((bank) => bank.symbol.toLowerCase() === token);
  return banks;
}

async function fetchProject0Json<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new AdapterError(
      PROJECT0_ADAPTER_ID,
      'api_unavailable',
      `Project 0 API request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new AdapterError(PROJECT0_ADAPTER_ID, 'api_error', `Project 0 API returned HTTP ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

function parseProject0Amount(amount: string, decimals: number, operation: string): string {
  return parseDecimalAmount(amount, decimals, `Project 0 ${operation} amount`).toString();
}

function requireSdkMethod(client: AnyProject0Client, method: string): (...args: any[]) => any {
  const candidate = client?.[method];
  if (typeof candidate !== 'function') {
    throw new AdapterError(PROJECT0_ADAPTER_ID, 'sdk_invalid', `Project 0 SDK client did not expose ${method}.`);
  }
  return candidate;
}

function requireAccountMethod(account: AnyProject0Account, method: string): (...args: any[]) => any {
  const candidate = account?.[method];
  if (typeof candidate !== 'function') {
    throw new AdapterError(PROJECT0_ADAPTER_ID, 'sdk_invalid', `Project 0 account did not expose ${method}.`);
  }
  return candidate;
}

function safeCall<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function numberFromSdkDecimal(value: unknown): number {
  if (typeof value === 'number') return value;
  const toNumber = (value as { toNumber?: () => number } | undefined)?.toNumber;
  if (typeof toNumber === 'function') return toNumber.call(value);
  return Number(decimalString(value));
}

function strategyCapacity(value: unknown): string | number | undefined {
  return stringValue(value) ?? numberValue(value);
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
  if (!value) return '';
  if (typeof value === 'string') return value;
  const stringifier = (value as { toBase58?: () => string; toString?: () => string }).toBase58;
  if (typeof stringifier === 'function') return stringifier.call(value);
  const fallback = (value as { toString?: () => string }).toString;
  return typeof fallback === 'function' ? fallback.call(value) : String(value);
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
