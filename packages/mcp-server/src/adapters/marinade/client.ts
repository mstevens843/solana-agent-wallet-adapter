import { createRequire } from 'node:module';

import {
  PublicKey,
  StakeProgram,
  Transaction,
  VersionedTransaction,
  type Connection,
  type ParsedAccountData,
  type Signer,
} from '@solana/web3.js';
import { ProtocolError } from '@solana-agent-wallet-adapter/core';
import { Decimal } from 'decimal.js';

import { formatRawAmount } from '../../amounts.js';
import type { AgentWalletConfig } from '../../config.js';
import { AdapterError } from '../types.js';
import {
  MARINADE_ADAPTER_ID,
  MARINADE_PROGRAM_ID,
  MARINADE_STATE_ADDRESS,
  MARINADE_STATE_PUBLIC_KEY,
  MSOL_DECIMALS,
  MSOL_MINT,
  MSOL_MINT_PUBLIC_KEY,
  SOL_DECIMALS,
} from './constants.js';

export type MarinadeOperation =
  | 'liquid_stake'
  | 'liquid_unstake'
  | 'delayed_unstake'
  | 'claim_delayed_unstake';

export interface MarinadeValidatorSummary {
  voteAccount?: string;
  validatorIdentity?: string;
  name?: string;
  activeStakeSol?: string;
  score?: number;
}

export interface MarinadeStateSnapshot {
  connectorId: typeof MARINADE_ADAPTER_ID;
  stateAddress: string;
  programId: string;
  msolMint: string;
  asOfSlot?: number;
  msolPrice?: string;
  totalVirtualStakedSol?: string;
  circulatingMsol?: string;
  availableReserveSol?: string;
  delayedUnstakeCoolingDownSeconds?: number;
  rewardFeeBps?: number;
  liquidityTargetSol?: string;
  validators?: MarinadeValidatorSummary[];
  warnings?: string[];
  raw?: Record<string, unknown>;
}

export interface MarinadeStakeAccount {
  stakeAccount: string;
  lamports: string;
  solAmount: string;
  state: 'active' | 'activating' | 'deactivating' | 'inactive' | 'unknown';
  delegated?: boolean;
  validatorVoteAccount?: string;
  activationEpoch?: string;
  deactivationEpoch?: string;
  rentExemptReserve?: string;
}

export interface MarinadeUnstakeTicket {
  ticketAccount: string;
  beneficiary?: string;
  lamports?: string;
  solAmount?: string;
  msolAmount?: string;
  createdEpoch?: string;
  claimableAt?: string;
  claimableSlot?: number;
  status: 'claimable' | 'pending' | 'expired' | 'unknown';
  reason?: string;
}

export interface MarinadeWalletPositionsResult {
  connectorId: typeof MARINADE_ADAPTER_ID;
  walletAddress: string;
  asOfSlot?: number;
  msolMint: string;
  msolBalanceRaw: string;
  msolBalance: string;
  estimatedSolValue?: string;
  nativeStakeAccounts: MarinadeStakeAccount[];
  unstakeTickets: MarinadeUnstakeTicket[];
  warnings?: string[];
}

export interface MarinadeQuote {
  connectorId: typeof MARINADE_ADAPTER_ID;
  operation: MarinadeOperation;
  inputAmount: string;
  inputAmountRaw: string;
  outputAmount?: string;
  outputAmountRaw?: string;
  minOutputAmount?: string;
  minOutputAmountRaw?: string;
  feeBps?: number;
  price?: string;
  route?: 'marinade' | 'jupiter';
  warnings?: string[];
  raw?: Record<string, unknown>;
}

export interface MarinadeBuildTransactionInput {
  walletAddress: string;
  amountRaw?: bigint;
  minOutputAmountRaw?: bigint;
  ticketAccount?: string;
  slippageBps?: number;
  config: AgentWalletConfig;
}

export interface MarinadeBuiltTransaction {
  transactionBase64: string;
  programIds: string[];
  quote?: MarinadeQuote;
  preview?: Record<string, unknown>;
}

export interface MarinadeQuoteInput {
  walletAddress?: string;
  operation: MarinadeOperation;
  inputAmountRaw: bigint;
  minOutputAmountRaw?: bigint;
  slippageBps?: number;
  config: AgentWalletConfig;
}

export interface MarinadeClient {
  getStateSnapshot(connection: Connection): Promise<MarinadeStateSnapshot>;
  getWalletPositions(connection: Connection, walletAddress: string): Promise<MarinadeWalletPositionsResult>;
  getStakeAccounts(connection: Connection, walletAddress: string): Promise<MarinadeStakeAccount[]>;
  getUnstakeTickets(connection: Connection, walletAddress: string): Promise<MarinadeUnstakeTicket[]>;
  getQuote(connection: Connection, input: MarinadeQuoteInput): Promise<MarinadeQuote>;
  buildLiquidStakeTransaction(
    connection: Connection,
    input: MarinadeBuildTransactionInput,
  ): Promise<MarinadeBuiltTransaction>;
  buildDelayedUnstakeTransaction(
    connection: Connection,
    input: MarinadeBuildTransactionInput,
  ): Promise<MarinadeBuiltTransaction>;
  buildClaimDelayedUnstakeTransaction(
    connection: Connection,
    input: MarinadeBuildTransactionInput,
  ): Promise<MarinadeBuiltTransaction>;
}

export type MarinadeClientFactory = () => MarinadeClient;

const SDK_PACKAGE_NAME = '@marinade.finance/marinade-ts-sdk';
const SDK_UNAVAILABLE_REASON =
  `Marinade connector requires ${SDK_PACKAGE_NAME}. Install optional MCP server dependencies, or inject a MarinadeClient with setMarinadeClientFactory().`;
const requireFromHere = createRequire(import.meta.url);

type MarinadeSdkModule = typeof import('@marinade.finance/marinade-ts-sdk');
type AnyRecord = Record<string, any>;

class MarinadeUnavailableClient implements MarinadeClient {
  constructor(private readonly reason: string) {}

  getReason(): string {
    return this.reason;
  }

  async getStateSnapshot(): Promise<MarinadeStateSnapshot> {
    throw this.error();
  }

  async getWalletPositions(): Promise<MarinadeWalletPositionsResult> {
    throw this.error();
  }

  async getStakeAccounts(): Promise<MarinadeStakeAccount[]> {
    throw this.error();
  }

  async getUnstakeTickets(): Promise<MarinadeUnstakeTicket[]> {
    throw this.error();
  }

  async getQuote(): Promise<MarinadeQuote> {
    throw this.error();
  }

  async buildLiquidStakeTransaction(): Promise<MarinadeBuiltTransaction> {
    throw this.error();
  }

  async buildDelayedUnstakeTransaction(): Promise<MarinadeBuiltTransaction> {
    throw this.error();
  }

  async buildClaimDelayedUnstakeTransaction(): Promise<MarinadeBuiltTransaction> {
    throw this.error();
  }

  private error(): ProtocolError {
    return new ProtocolError('unsupported_method', this.reason);
  }
}

class MarinadeSdkClient implements MarinadeClient {
  async getStateSnapshot(connection: Connection): Promise<MarinadeStateSnapshot> {
    return withMarinadeSdkErrors('read state snapshot', async () => {
      const marinade = createMarinadeSdk(connection);
      const state = await marinade.getMarinadeState();
      const warnings: string[] = [];
      const validators = await state.getValidatorRecords()
        .then(({ validatorRecords }: { validatorRecords: AnyRecord[] }) =>
          validatorRecords
            .slice()
            .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
            .slice(0, 10)
            .map((validator) => ({
              voteAccount: publicKeyString(validator.validatorAccount),
              activeStakeSol: formatOptionalLamports(validator.activeBalance),
              score: numberOrUndefined(validator.score),
            })),
        )
        .catch((error: unknown) => {
          warnings.push(`Validator records unavailable: ${errorMessage(error)}`);
          return undefined;
        });
      const asOfSlot = await connection.getSlot('confirmed').catch(() => undefined);
      return baseMarinadeStateSnapshot({
        asOfSlot,
        msolPrice: decimalString(state.mSolPrice),
        totalVirtualStakedSol: formatOptionalLamports(state.state?.validatorSystem?.totalActiveBalance),
        circulatingMsol: formatOptionalRawAmount(state.state?.msolSupply, MSOL_DECIMALS),
        availableReserveSol: formatOptionalLamports(state.state?.availableReserveBalance),
        rewardFeeBps: numberOrUndefined(state.state?.rewardFee?.basisPoints),
        liquidityTargetSol: formatOptionalLamports(state.state?.liqPool?.lpLiquidityTarget),
        ...(validators ? { validators } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        raw: stripUndefined({
          stateAddress: state.marinadeStateAddress?.toBase58?.() ?? MARINADE_STATE_ADDRESS,
          msolMint: publicKeyString(state.mSolMintAddress) ?? MSOL_MINT,
          reserveAddress: publicKeyString(await state.reserveAddress().catch(() => undefined)),
          msolSupplyRaw: stringFromBn(state.state?.msolSupply),
          totalActiveBalanceRaw: stringFromBn(state.state?.validatorSystem?.totalActiveBalance),
          availableReserveBalanceRaw: stringFromBn(state.state?.availableReserveBalance),
          circulatingTicketBalanceRaw: stringFromBn(state.state?.circulatingTicketBalance),
        }),
      });
    });
  }

  async getWalletPositions(connection: Connection, walletAddress: string): Promise<MarinadeWalletPositionsResult> {
    return withMarinadeSdkErrors('read wallet positions', async () => {
      const owner = new PublicKey(walletAddress);
      const warnings: string[] = [];
      const [msolBalance, state, nativeStakeAccounts, unstakeTickets] = await Promise.all([
        getMsolBalance(connection, owner),
        createMarinadeSdk(connection, walletAddress).getMarinadeState(),
        this.getStakeAccounts(connection, walletAddress).catch((error: unknown) => {
          warnings.push(`Native stake accounts unavailable: ${errorMessage(error)}`);
          return [];
        }),
        this.getUnstakeTickets(connection, walletAddress).catch((error: unknown) => {
          warnings.push(`Unstake tickets unavailable: ${errorMessage(error)}`);
          return [];
        }),
      ]);
      const price = decimalOrUndefined(state.mSolPrice);
      const estimatedSolValue = price
        ? price.mul(new Decimal(msolBalance.amountRaw.toString())).div(10 ** MSOL_DECIMALS)
        : undefined;
      return {
        connectorId: MARINADE_ADAPTER_ID,
        walletAddress: owner.toBase58(),
        asOfSlot: msolBalance.asOfSlot,
        msolMint: MSOL_MINT,
        msolBalanceRaw: msolBalance.amountRaw.toString(),
        msolBalance: formatRawAmount(msolBalance.amountRaw, MSOL_DECIMALS),
        ...(estimatedSolValue ? { estimatedSolValue: trimDecimal(estimatedSolValue) } : {}),
        nativeStakeAccounts,
        unstakeTickets,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    });
  }

  async getStakeAccounts(connection: Connection, walletAddress: string): Promise<MarinadeStakeAccount[]> {
    return withMarinadeSdkErrors('read stake accounts', async () => {
      const owner = new PublicKey(walletAddress);
      const rows = await connection.getParsedProgramAccounts(StakeProgram.programId, {
        commitment: 'confirmed',
        filters: [
          { dataSize: 200 },
          { memcmp: { offset: 44, bytes: owner.toBase58() } },
        ],
      });
      const accounts = await Promise.all(rows.map(async (row) => {
        const base = stakeAccountFromParsed(row.pubkey, row.account);
        if (!base) return undefined;
        const activation = await connection.getStakeActivation(row.pubkey, 'confirmed').catch(() => undefined);
        return {
          ...base,
          state: activationState(activation?.state, base),
        };
      }));
      return accounts.filter((account): account is MarinadeStakeAccount => account !== undefined);
    });
  }

  async getUnstakeTickets(connection: Connection, walletAddress: string): Promise<MarinadeUnstakeTicket[]> {
    return withMarinadeSdkErrors('read unstake tickets', async () => {
      const owner = new PublicKey(walletAddress);
      const marinade = createMarinadeSdk(connection, walletAddress);
      const tickets = await marinade.getDelayedUnstakeTickets(owner);
      return [...tickets.entries()].map(([ticketAccount, ticket]: [PublicKey, AnyRecord]) =>
        unstakeTicketFromSdk(ticketAccount, ticket),
      );
    });
  }

  async getQuote(connection: Connection, input: MarinadeQuoteInput): Promise<MarinadeQuote> {
    return withMarinadeSdkErrors('quote', async () => {
      if (input.operation === 'liquid_unstake') {
        throw new ProtocolError(
          'invalid_request',
          'Marinade instant liquid unstake quotes are routed through Jupiter, not the Marinade SDK client.',
        );
      }
      if (input.operation === 'claim_delayed_unstake') {
        throw new ProtocolError('invalid_request', 'Claim quote requires a ticket account lookup.');
      }
      const marinade = createMarinadeSdk(connection, input.walletAddress);
      const state = await marinade.getMarinadeState();
      const price = decimalOrUndefined(state.mSolPrice) ?? new Decimal(1);
      const inputRaw = new Decimal(input.inputAmountRaw.toString());
      const outputRawDecimal = input.operation === 'liquid_stake'
        ? inputRaw.div(price).floor()
        : inputRaw.mul(price).floor();
      const outputRaw = BigInt(outputRawDecimal.toFixed(0));
      const dueDate = input.operation === 'delayed_unstake'
        ? await marinade.getEstimatedUnstakeTicketDueDate().catch(() => undefined)
        : undefined;
      return {
        connectorId: MARINADE_ADAPTER_ID,
        operation: input.operation,
        inputAmount: formatRawAmount(input.inputAmountRaw, input.operation === 'liquid_stake' ? SOL_DECIMALS : MSOL_DECIMALS),
        inputAmountRaw: input.inputAmountRaw.toString(),
        outputAmount: formatRawAmount(outputRaw, input.operation === 'liquid_stake' ? MSOL_DECIMALS : SOL_DECIMALS),
        outputAmountRaw: outputRaw.toString(),
        ...(input.minOutputAmountRaw !== undefined
          ? {
              minOutputAmount: formatRawAmount(input.minOutputAmountRaw, input.operation === 'liquid_stake' ? MSOL_DECIMALS : SOL_DECIMALS),
              minOutputAmountRaw: input.minOutputAmountRaw.toString(),
            }
          : {}),
        price: trimDecimal(price),
        route: 'marinade',
        raw: stripUndefined({
          stateAddress: MARINADE_STATE_ADDRESS,
          programId: MARINADE_PROGRAM_ID,
          estimatedTicketDue: dueDate?.ticketDueDate instanceof Date ? dueDate.ticketDueDate.toISOString() : undefined,
          ticketDue: dueDate?.ticketDue,
        }),
      };
    });
  }

  async buildLiquidStakeTransaction(
    connection: Connection,
    input: MarinadeBuildTransactionInput,
  ): Promise<MarinadeBuiltTransaction> {
    return withMarinadeSdkErrors('build liquid stake transaction', async () => {
      const wallet = new PublicKey(input.walletAddress);
      const marinade = createMarinadeSdk(connection, wallet.toBase58());
      const amountRaw = requireAmountRaw(input, 'liquid stake');
      const built = await marinade.deposit(toSdkBn(amountRaw));
      return serializeSdkTransaction(connection, wallet, built.transaction, [], {
        operation: 'liquid_stake',
        solAmount: formatRawAmount(amountRaw, SOL_DECIMALS),
        solAmountRaw: amountRaw.toString(),
        associatedMSolTokenAccount: publicKeyString(built.associatedMSolTokenAccountAddress),
      });
    });
  }

  async buildDelayedUnstakeTransaction(
    connection: Connection,
    input: MarinadeBuildTransactionInput,
  ): Promise<MarinadeBuiltTransaction> {
    return withMarinadeSdkErrors('build delayed unstake transaction', async () => {
      const wallet = new PublicKey(input.walletAddress);
      const marinade = createMarinadeSdk(connection, wallet.toBase58());
      const amountRaw = requireAmountRaw(input, 'delayed unstake');
      const built = await marinade.orderUnstake(toSdkBn(amountRaw));
      const ticketAccount = built.ticketAccountKeypair.publicKey.toBase58();
      return serializeSdkTransaction(connection, wallet, built.transaction, [built.ticketAccountKeypair], {
        operation: 'delayed_unstake',
        msolAmount: formatRawAmount(amountRaw, MSOL_DECIMALS),
        msolAmountRaw: amountRaw.toString(),
        ticketAccount,
        associatedMSolTokenAccount: publicKeyString(built.associatedMSolTokenAccountAddress),
        ephemeralSigner: ticketAccount,
      });
    });
  }

  async buildClaimDelayedUnstakeTransaction(
    connection: Connection,
    input: MarinadeBuildTransactionInput,
  ): Promise<MarinadeBuiltTransaction> {
    return withMarinadeSdkErrors('build delayed unstake claim transaction', async () => {
      if (!input.ticketAccount) {
        throw new ProtocolError('invalid_request', 'ticketAccount is required.');
      }
      const wallet = new PublicKey(input.walletAddress);
      const ticketAccount = new PublicKey(input.ticketAccount);
      const marinade = createMarinadeSdk(connection, wallet.toBase58());
      const built = await marinade.claim(ticketAccount);
      return serializeSdkTransaction(connection, wallet, built.transaction, [], {
        operation: 'claim_delayed_unstake',
        ticketAccount: ticketAccount.toBase58(),
      });
    });
  }
}

function defaultFactory(): MarinadeClient {
  return canResolvePackage(SDK_PACKAGE_NAME)
    ? new MarinadeSdkClient()
    : new MarinadeUnavailableClient(SDK_UNAVAILABLE_REASON);
}

let clientFactory: MarinadeClientFactory = defaultFactory;
let cachedClient: MarinadeClient | undefined;

export function setMarinadeClientFactory(factory?: MarinadeClientFactory): void {
  clientFactory = factory ?? defaultFactory;
  cachedClient = undefined;
}

export function resetMarinadeClientFactory(): void {
  setMarinadeClientFactory();
}

export function getMarinadeClient(): MarinadeClient {
  if (!cachedClient) cachedClient = clientFactory();
  return cachedClient;
}

export function describeMarinadeUnavailableReason(): string | undefined {
  const client = getMarinadeClient();
  if (client instanceof MarinadeUnavailableClient) {
    return client.getReason();
  }
  return undefined;
}

export function baseMarinadeStateSnapshot(overrides: Partial<MarinadeStateSnapshot> = {}): MarinadeStateSnapshot {
  return {
    connectorId: MARINADE_ADAPTER_ID,
    stateAddress: MARINADE_STATE_ADDRESS,
    programId: MARINADE_PROGRAM_ID,
    msolMint: MSOL_MINT,
    ...overrides,
  };
}

function canResolvePackage(packageName: string): boolean {
  try {
    requireFromHere.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

function loadMarinadeSdk(): MarinadeSdkModule {
  try {
    return requireFromHere(SDK_PACKAGE_NAME) as MarinadeSdkModule;
  } catch (error) {
    throw new AdapterError(
      MARINADE_ADAPTER_ID,
      'sdk_unavailable',
      `${SDK_UNAVAILABLE_REASON} (${errorMessage(error)})`,
    );
  }
}

function createMarinadeSdk(connection: Connection, walletAddress?: string): AnyRecord {
  const sdk = loadMarinadeSdk();
  const publicKey = walletAddress ? new PublicKey(walletAddress) : PublicKey.default;
  const config = new sdk.MarinadeConfig({
    connection,
    publicKey,
    marinadeFinanceProgramId: new PublicKey(MARINADE_PROGRAM_ID),
    marinadeStateAddress: MARINADE_STATE_PUBLIC_KEY,
  });
  return new sdk.Marinade(config) as AnyRecord;
}

function toSdkBn(value: bigint): AnyRecord {
  const sdk = loadMarinadeSdk();
  return new sdk.BN(value.toString()) as AnyRecord;
}

function requireAmountRaw(input: MarinadeBuildTransactionInput, operation: string): bigint {
  if (input.amountRaw === undefined || input.amountRaw <= 0n) {
    throw new ProtocolError('invalid_request', `Marinade ${operation} amount is required.`);
  }
  return input.amountRaw;
}

async function getMsolBalance(connection: Connection, owner: PublicKey): Promise<{ amountRaw: bigint; asOfSlot?: number }> {
  const response = await connection.getParsedTokenAccountsByOwner(owner, { mint: MSOL_MINT_PUBLIC_KEY }, 'confirmed');
  let total = 0n;
  for (const row of response.value) {
    const parsed = row.account.data as ParsedAccountData;
    const amount = parsed.parsed?.info?.tokenAmount?.amount;
    if (typeof amount === 'string') {
      total += BigInt(amount);
    }
  }
  return { amountRaw: total, asOfSlot: response.context.slot };
}

function stakeAccountFromParsed(pubkey: PublicKey, account: AnyRecord): MarinadeStakeAccount | undefined {
  const parsed = account.data?.parsed;
  if (!parsed?.info) return undefined;
  const info = parsed.info;
  const delegation = info.stake?.delegation;
  const lamports = BigInt(account.lamports ?? 0).toString();
  const activationEpoch = stringValue(delegation?.activationEpoch);
  const deactivationEpoch = stringValue(delegation?.deactivationEpoch);
  const validatorVoteAccount = stringValue(delegation?.voter);
  return {
    stakeAccount: pubkey.toBase58(),
    lamports,
    solAmount: formatRawAmount(BigInt(lamports), SOL_DECIMALS),
    state: parsedStakeType(parsed.type, deactivationEpoch),
    delegated: Boolean(delegation),
    ...(validatorVoteAccount ? { validatorVoteAccount } : {}),
    ...(activationEpoch ? { activationEpoch } : {}),
    ...(deactivationEpoch ? { deactivationEpoch } : {}),
    ...(stringValue(info.meta?.rentExemptReserve) ? { rentExemptReserve: stringValue(info.meta?.rentExemptReserve) } : {}),
  };
}

function parsedStakeType(type: unknown, deactivationEpoch?: string): MarinadeStakeAccount['state'] {
  if (type === 'delegated') {
    return deactivationEpoch && deactivationEpoch !== '18446744073709551615' ? 'deactivating' : 'active';
  }
  if (type === 'initialized') return 'inactive';
  return 'unknown';
}

function activationState(
  state: string | undefined,
  fallback: MarinadeStakeAccount,
): MarinadeStakeAccount['state'] {
  if (state === 'active' || state === 'activating' || state === 'deactivating' || state === 'inactive') {
    return state;
  }
  return fallback.state;
}

function unstakeTicketFromSdk(ticketAccount: PublicKey, ticket: AnyRecord): MarinadeUnstakeTicket {
  const lamportsRaw = stringFromBn(ticket.lamportsAmount);
  const claimableAt = ticket.ticketDueDate instanceof Date ? ticket.ticketDueDate.toISOString() : undefined;
  const status = ticket.ticketDue === true ? 'claimable' : 'pending';
  return {
    ticketAccount: ticketAccount.toBase58(),
    beneficiary: publicKeyString(ticket.beneficiary),
    ...(lamportsRaw ? { lamports: lamportsRaw, solAmount: formatRawAmount(BigInt(lamportsRaw), SOL_DECIMALS) } : {}),
    createdEpoch: stringFromBn(ticket.createdEpoch),
    ...(claimableAt ? { claimableAt } : {}),
    status,
    ...(status === 'pending' ? { reason: claimableAt ? `Ticket is expected to be claimable at ${claimableAt}.` : 'Ticket is not claimable yet.' } : {}),
  };
}

async function serializeSdkTransaction(
  connection: Connection,
  wallet: PublicKey,
  transaction: Transaction | VersionedTransaction | AnyRecord,
  signers: Signer[],
  preview: Record<string, unknown>,
): Promise<MarinadeBuiltTransaction> {
  if (transaction instanceof VersionedTransaction || isVersionedTransactionLike(transaction)) {
    if (signers.length > 0) transaction.sign(signers);
    return {
      transactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
      programIds: programIdsFromVersionedTransaction(transaction),
      preview: stripUndefined({ ...preview, signerCount: signers.length }),
    };
  }
  if (transaction instanceof Transaction || isLegacyTransactionLike(transaction)) {
    if (!transaction.feePayer) transaction.feePayer = wallet;
    if (!transaction.recentBlockhash) {
      const blockhash = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash.blockhash;
    }
    if (signers.length > 0) transaction.partialSign(...signers);
    return {
      transactionBase64: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      programIds: programIdsFromLegacyTransaction(transaction),
      preview: stripUndefined({ ...preview, signerCount: signers.length }),
    };
  }
  throw new AdapterError(MARINADE_ADAPTER_ID, 'sdk_transaction_error', 'Marinade SDK returned an unknown transaction type.');
}

function isLegacyTransactionLike(value: AnyRecord): value is Transaction {
  return Array.isArray(value?.instructions) && typeof value.serialize === 'function';
}

function isVersionedTransactionLike(value: AnyRecord): value is VersionedTransaction {
  return value?.message !== undefined && typeof value.serialize === 'function' && typeof value.sign === 'function';
}

function programIdsFromLegacyTransaction(transaction: Transaction): string[] {
  return [...new Set([
    ...transaction.instructions.map((instruction) => instruction.programId.toBase58()),
    MARINADE_PROGRAM_ID,
  ])];
}

function programIdsFromVersionedTransaction(transaction: VersionedTransaction): string[] {
  const keys = transaction.message.staticAccountKeys;
  return [...new Set([
    ...transaction.message.compiledInstructions
      .map((instruction) => keys[instruction.programIdIndex]?.toBase58())
      .filter((programId): programId is string => Boolean(programId)),
    MARINADE_PROGRAM_ID,
  ])];
}

async function withMarinadeSdkErrors<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ProtocolError || error instanceof AdapterError) throw error;
    throw new AdapterError(
      MARINADE_ADAPTER_ID,
      'sdk_error',
      `Marinade SDK failed to ${operation}: ${errorMessage(error)}`,
    );
  }
}

function stringFromBn(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value).toString() : undefined;
  if (typeof value === 'string') return value;
  if (typeof (value as { toString?: unknown }).toString === 'function') {
    const text = (value as { toString: () => string }).toString();
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function bnToBigint(value: unknown): bigint | undefined {
  const text = stringFromBn(value);
  return text ? BigInt(text) : undefined;
}

function formatOptionalLamports(value: unknown): string | undefined {
  const raw = bnToBigint(value);
  return raw === undefined ? undefined : formatRawAmount(raw, SOL_DECIMALS);
}

function formatOptionalRawAmount(value: unknown, decimals: number): string | undefined {
  const raw = bnToBigint(value);
  return raw === undefined ? undefined : formatRawAmount(raw, decimals);
}

function decimalOrUndefined(value: unknown): Decimal | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const decimal = new Decimal(String(value));
    return decimal.isFinite() && decimal.gt(0) ? decimal : undefined;
  } catch {
    return undefined;
  }
}

function decimalString(value: unknown): string | undefined {
  const decimal = decimalOrUndefined(value);
  return decimal ? trimDecimal(decimal) : undefined;
}

function trimDecimal(value: Decimal): string {
  const text = value.toSignificantDigits(18).toFixed();
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function publicKeyString(value: unknown): string | undefined {
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof (value as { toBase58?: unknown } | undefined)?.toBase58 === 'function') {
    return (value as { toBase58: () => string }).toBase58();
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : stringFromBn(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
