import { createRequire } from 'node:module';

import {
  PublicKey,
  StakeProgram,
  Transaction,
  type AccountInfo,
  type Connection,
  type ParsedAccountData,
  type Signer,
  type TransactionInstruction,
} from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { formatRawAmount, parseDecimalAmount } from '../../amounts.js';
import { AdapterError } from '../types.js';
import {
  JITO_ADAPTER_ID,
  JITO_OFFCHAIN_MIN_OUTPUT_WARNING,
  JITO_STAKE_POOL_ADDRESS,
  JITOSOL_DECIMALS,
  JITOSOL_MINT,
  SPL_STAKE_POOL_PROGRAM_ID,
  U64_MAX_EPOCH,
} from './constants.js';

const requireFromHere = createRequire(import.meta.url);
const STAKE_POOL_PACKAGE = '@solana/spl-stake-pool';
const STAKE_DEPOSIT_INTERCEPTOR_PACKAGE = '@jito-foundation/stake-deposit-interceptor-sdk';
const SPL_TOKEN_PACKAGE = '@solana/spl-token';
const FEATURE_DISABLED_REASON = 'JITO_CONNECTOR_ENABLED=false disables the Jito connector.';
const STAKE_POOL_UNAVAILABLE_REASON =
  '@solana/spl-stake-pool is not installed or could not be resolved. Install it as an optional MCP server dependency, or inject a mock with setJitoClientFactory().';
const INTERCEPTOR_UNAVAILABLE_REASON =
  '@jito-foundation/stake-deposit-interceptor-sdk is not installed or could not be resolved. Existing stake-account deposits, deposit receipt reads, and receipt claims are unavailable, but other JitoSOL actions can still work.';
const SPL_TOKEN_UNAVAILABLE_REASON =
  '@solana/spl-token is not installed or could not be resolved. Jito deposit receipt claims are unavailable because the connector cannot derive or create the wallet JitoSOL token account.';

type SplStakePoolModule = typeof import('@solana/spl-stake-pool');
type JitoInterceptorModule = typeof import('@jito-foundation/stake-deposit-interceptor-sdk');
type SplTokenModule = typeof import('@solana/spl-token');

export type JitoQuoteOperation =
  | 'stake_sol'
  | 'deposit_stake_account'
  | 'unstake_jitosol'
  | 'withdraw_sol';

export type JitoWithdrawMode = 'stake_account' | 'reserve_sol';

export interface JitoFeeSnapshot {
  numerator: string;
  denominator: string;
  bps: number;
}

export interface JitoStakePoolSnapshot {
  stakePoolAddress: string;
  jitoSolMint: string;
  poolMint: string;
  reserveStake: string;
  manager: string;
  staker: string;
  validatorList: string;
  totalLamports: string;
  poolTokenSupply: string;
  exchangeRateSolPerJitoSol: string;
  exchangeRateJitoSolPerSol: string;
  lastUpdateEpoch: string;
  fees: {
    solDeposit: JitoFeeSnapshot;
    solWithdrawal: JitoFeeSnapshot;
    stakeDeposit: JitoFeeSnapshot;
    stakeWithdrawal: JitoFeeSnapshot;
  };
  validators?: JitoValidatorStakeInfo[];
  asOfSlot?: number;
  asOfBlockTime?: number;
  programIds: string[];
  warnings: string[];
}

export interface JitoValidatorStakeInfo {
  voteAccountAddress: string;
  activeStakeLamports: string;
  transientStakeLamports: string;
  lastUpdateEpoch: string;
  status: string;
}

export interface JitoTokenAccountBalance {
  tokenAccount: string;
  mint: string;
  amount: string;
  amountRaw: string;
  decimals: number;
}

export interface JitoStakeAccount {
  stakeAccount: string;
  walletAddress?: string;
  withdrawer?: string;
  staker?: string;
  voter?: string;
  delegatedStakeLamports?: string;
  lamports: string;
  rentExemptReserve?: string;
  activationEpoch?: string;
  deactivationEpoch?: string;
  activationState?: string;
  state: string;
  locked: boolean;
  deactivating: boolean;
  eligibleForJitoDeposit: boolean;
  ineligibleReason?: string;
  warnings: string[];
}

export interface JitoWalletPositionsResult {
  walletAddress: string;
  jitoSol: {
    mint: string;
    decimals: number;
    amount: string;
    amountRaw: string;
    tokenAccounts: JitoTokenAccountBalance[];
  };
  stakeAccounts?: JitoStakeAccount[];
  totals: {
    jitoSolTokenAccounts: number;
    stakeAccounts: number;
    eligibleStakeAccounts: number;
  };
}

export interface JitoDepositReceipt {
  depositReceipt: string;
  base: string;
  owner: string;
  stakePool: string;
  stakePoolDepositStakeAuthority: string;
  lstAmount: string;
  lstAmountRaw: string;
  depositTime: string;
  depositedAt: string;
  coolDownSeconds: string;
  claimableAt: string;
  cooldownComplete: boolean;
  secondsUntilClaimable: number;
  initialFeeBps: number;
  programIds: string[];
  warnings: string[];
}

export interface JitoDepositReceiptsResult {
  walletAddress: string;
  receipts: JitoDepositReceipt[];
  totals: {
    receipts: number;
    claimableReceipts: number;
    pendingReceipts: number;
    lstAmountRaw: string;
    lstAmount: string;
  };
}

export interface JitoQuoteInput {
  operation: JitoQuoteOperation;
  solAmount?: string;
  jitoSolAmount?: string;
  stakeAccount?: string;
  amount?: string;
  withdrawMode?: JitoWithdrawMode;
}

export interface JitoQuote {
  operation: JitoQuoteOperation;
  amount?: string;
  amountRaw?: string;
  stakeAccount?: string;
  withdrawMode?: JitoWithdrawMode;
  expectedJitoSolAmount?: string;
  expectedJitoSolRaw?: string;
  expectedSolAmount?: string;
  expectedSolRaw?: string;
  exchangeRateSnapshot: Pick<
    JitoStakePoolSnapshot,
    'stakePoolAddress' | 'jitoSolMint' | 'totalLamports' | 'poolTokenSupply' | 'exchangeRateSolPerJitoSol' | 'exchangeRateJitoSolPerSol' | 'lastUpdateEpoch'
  >;
  warnings: string[];
}

export interface JitoBuildStakeSolInput {
  walletAddress: string;
  amountLamports: bigint;
}

export interface JitoBuildDepositStakeInput {
  walletAddress: string;
  stakeAccount: string;
  minJitoSolRaw?: bigint;
}

export interface JitoBuildUnstakeInput {
  walletAddress: string;
  jitoSolAmountRaw: bigint;
  withdrawMode: JitoWithdrawMode;
}

export interface JitoBuildWithdrawSolInput {
  walletAddress: string;
  stakeAccount: string;
  amountLamports?: bigint;
  withdrawAll?: boolean;
}

export interface JitoBuildClaimDepositReceiptInput {
  walletAddress: string;
  receiptAddress: string;
  allowEarlyClaim?: boolean;
}

export interface JitoBuildTransactionResult {
  transactionBase64: string;
  programIds: string[];
  preview: Record<string, unknown>;
  signerCount: number;
}

export interface JitoClient {
  getStakePoolSnapshot(
    connection: Connection,
    input?: { includeValidators?: boolean },
  ): Promise<JitoStakePoolSnapshot>;
  getWalletPositions(
    connection: Connection,
    walletAddress: string,
    input?: { includeStakeAccounts?: boolean; delegatedOnly?: boolean; eligibleForJitoDepositOnly?: boolean },
  ): Promise<JitoWalletPositionsResult>;
  getWalletStakeAccounts(
    connection: Connection,
    walletAddress: string,
    input?: { delegatedOnly?: boolean; eligibleForJitoDepositOnly?: boolean },
  ): Promise<JitoStakeAccount[]>;
  getWalletDepositReceipts(
    connection: Connection,
    walletAddress: string,
    input?: { claimableOnly?: boolean },
  ): Promise<JitoDepositReceiptsResult>;
  getStakeAccount(connection: Connection, stakeAccount: string, walletAddress?: string): Promise<JitoStakeAccount>;
  getDepositReceipt(connection: Connection, receiptAddress: string): Promise<JitoDepositReceipt>;
  quote(connection: Connection, input: JitoQuoteInput): Promise<JitoQuote>;
  buildStakeSolTransaction(connection: Connection, input: JitoBuildStakeSolInput): Promise<JitoBuildTransactionResult>;
  buildDepositStakeAccountTransaction(connection: Connection, input: JitoBuildDepositStakeInput): Promise<JitoBuildTransactionResult>;
  buildUnstakeJitosolTransaction(connection: Connection, input: JitoBuildUnstakeInput): Promise<JitoBuildTransactionResult>;
  buildWithdrawSolTransaction(connection: Connection, input: JitoBuildWithdrawSolInput): Promise<JitoBuildTransactionResult>;
  buildClaimDepositReceiptTransaction(connection: Connection, input: JitoBuildClaimDepositReceiptInput): Promise<JitoBuildTransactionResult>;
}

class JitoSdkUnavailable implements JitoClient {
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  private fail(method: string): never {
    throw new Error(`Jito adapter is not configured (${method}): ${this.reason}`);
  }

  async getStakePoolSnapshot(): Promise<JitoStakePoolSnapshot> {
    this.fail('getStakePoolSnapshot');
  }
  async getWalletPositions(): Promise<JitoWalletPositionsResult> {
    this.fail('getWalletPositions');
  }
  async getWalletStakeAccounts(): Promise<JitoStakeAccount[]> {
    this.fail('getWalletStakeAccounts');
  }
  async getWalletDepositReceipts(): Promise<JitoDepositReceiptsResult> {
    this.fail('getWalletDepositReceipts');
  }
  async getStakeAccount(): Promise<JitoStakeAccount> {
    this.fail('getStakeAccount');
  }
  async getDepositReceipt(): Promise<JitoDepositReceipt> {
    this.fail('getDepositReceipt');
  }
  async quote(): Promise<JitoQuote> {
    this.fail('quote');
  }
  async buildStakeSolTransaction(): Promise<JitoBuildTransactionResult> {
    this.fail('buildStakeSolTransaction');
  }
  async buildDepositStakeAccountTransaction(): Promise<JitoBuildTransactionResult> {
    this.fail('buildDepositStakeAccountTransaction');
  }
  async buildUnstakeJitosolTransaction(): Promise<JitoBuildTransactionResult> {
    this.fail('buildUnstakeJitosolTransaction');
  }
  async buildWithdrawSolTransaction(): Promise<JitoBuildTransactionResult> {
    this.fail('buildWithdrawSolTransaction');
  }
  async buildClaimDepositReceiptTransaction(): Promise<JitoBuildTransactionResult> {
    this.fail('buildClaimDepositReceiptTransaction');
  }
}

class JitoSdkClient implements JitoClient {
  async getStakePoolSnapshot(
    connection: Connection,
    input: { includeValidators?: boolean } = {},
  ): Promise<JitoStakePoolSnapshot> {
    const sdk = await loadStakePoolSdk();
    const stakePoolAccount = await sdk.getStakePoolAccount(connection, JITO_STAKE_POOL_ADDRESS);
    const pool = stakePoolAccount.account.data;
    const totalLamports = bnToBigInt(pool.totalLamports);
    const poolTokenSupply = bnToBigInt(pool.poolTokenSupply);
    const asOfSlot = await connection.getSlot('confirmed').catch(() => undefined);
    const asOfBlockTime = asOfSlot !== undefined
      ? await connection.getBlockTime(asOfSlot).catch(() => null)
      : null;
    const warnings = pool.poolMint.equals(JITOSOL_MINT)
      ? []
      : [`Stake pool mint ${pool.poolMint.toBase58()} did not match the expected JitoSOL mint ${JITOSOL_MINT.toBase58()}.`];

    const snapshot: JitoStakePoolSnapshot = {
      stakePoolAddress: JITO_STAKE_POOL_ADDRESS.toBase58(),
      jitoSolMint: JITOSOL_MINT.toBase58(),
      poolMint: pool.poolMint.toBase58(),
      reserveStake: pool.reserveStake.toBase58(),
      manager: pool.manager.toBase58(),
      staker: pool.staker.toBase58(),
      validatorList: pool.validatorList.toBase58(),
      totalLamports: totalLamports.toString(),
      poolTokenSupply: poolTokenSupply.toString(),
      exchangeRateSolPerJitoSol: ratioString(totalLamports, poolTokenSupply),
      exchangeRateJitoSolPerSol: ratioString(poolTokenSupply, totalLamports),
      lastUpdateEpoch: bnToBigInt(pool.lastUpdateEpoch).toString(),
      fees: {
        solDeposit: feeSnapshot(pool.solDepositFee),
        solWithdrawal: feeSnapshot(pool.solWithdrawalFee),
        stakeDeposit: feeSnapshot(pool.stakeDepositFee),
        stakeWithdrawal: feeSnapshot(pool.stakeWithdrawalFee),
      },
      ...(input.includeValidators ? { validators: await readValidators(connection, sdk, pool.validatorList) } : {}),
      ...(asOfSlot !== undefined ? { asOfSlot } : {}),
      ...(typeof asOfBlockTime === 'number' ? { asOfBlockTime } : {}),
      programIds: [SPL_STAKE_POOL_PROGRAM_ID.toBase58()],
      warnings,
    };
    return snapshot;
  }

  async getWalletPositions(
    connection: Connection,
    walletAddress: string,
    input: { includeStakeAccounts?: boolean; delegatedOnly?: boolean; eligibleForJitoDepositOnly?: boolean } = {},
  ): Promise<JitoWalletPositionsResult> {
    const owner = new PublicKey(walletAddress);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: JITOSOL_MINT }, 'confirmed');
    const balances: JitoTokenAccountBalance[] = [];
    let totalRaw = 0n;
    for (const row of tokenAccounts.value) {
      const parsed = parsedInfo(row.account.data);
      const amountRaw = stringPath(parsed, ['tokenAmount', 'amount']) ?? '0';
      const raw = safeBigInt(amountRaw);
      totalRaw += raw;
      balances.push({
        tokenAccount: row.pubkey.toBase58(),
        mint: stringPath(parsed, ['mint']) ?? JITOSOL_MINT.toBase58(),
        amount: stringPath(parsed, ['tokenAmount', 'uiAmountString']) ?? formatRawAmount(raw, JITOSOL_DECIMALS),
        amountRaw: raw.toString(),
        decimals: numberPath(parsed, ['tokenAmount', 'decimals']) ?? JITOSOL_DECIMALS,
      });
    }
    const stakeAccounts = input.includeStakeAccounts
      ? await this.getWalletStakeAccounts(connection, walletAddress, {
          ...(input.delegatedOnly !== undefined && { delegatedOnly: input.delegatedOnly }),
          ...(input.eligibleForJitoDepositOnly !== undefined && { eligibleForJitoDepositOnly: input.eligibleForJitoDepositOnly }),
        })
      : undefined;
    return {
      walletAddress: owner.toBase58(),
      jitoSol: {
        mint: JITOSOL_MINT.toBase58(),
        decimals: JITOSOL_DECIMALS,
        amount: formatRawAmount(totalRaw, JITOSOL_DECIMALS),
        amountRaw: totalRaw.toString(),
        tokenAccounts: balances,
      },
      ...(stakeAccounts ? { stakeAccounts } : {}),
      totals: {
        jitoSolTokenAccounts: balances.length,
        stakeAccounts: stakeAccounts?.length ?? 0,
        eligibleStakeAccounts: stakeAccounts?.filter((account) => account.eligibleForJitoDeposit).length ?? 0,
      },
    };
  }

  async getWalletStakeAccounts(
    connection: Connection,
    walletAddress: string,
    input: { delegatedOnly?: boolean; eligibleForJitoDepositOnly?: boolean } = {},
  ): Promise<JitoStakeAccount[]> {
    const owner = new PublicKey(walletAddress);
    const epochInfo = await connection.getEpochInfo('confirmed').catch(() => undefined);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rows = await connection.getParsedProgramAccounts(StakeProgram.programId, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 44, bytes: owner.toBase58() } }],
    });
    const normalized = rows
      .map((row) => normalizeStakeAccount(row.pubkey, row.account, owner.toBase58(), epochInfo?.epoch, nowSeconds))
      .filter((account): account is JitoStakeAccount => account !== null);
    const accounts = await Promise.all(normalized.map(async (account) => {
      const activation = await connection.getStakeActivation(new PublicKey(account.stakeAccount), 'confirmed').catch(() => undefined);
      return withConfirmedDepositEligibility(account, activation?.state);
    }));
    return accounts
      .filter((account) => !input.delegatedOnly || account.state === 'delegated')
      .filter((account) => !input.eligibleForJitoDepositOnly || account.eligibleForJitoDeposit);
  }

  async getWalletDepositReceipts(
    connection: Connection,
    walletAddress: string,
    input: { claimableOnly?: boolean } = {},
  ): Promise<JitoDepositReceiptsResult> {
    const interceptor = await loadStakeDepositInterceptorSdk();
    const owner = new PublicKey(walletAddress);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rows = await connection.getProgramAccounts(interceptor.PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 40, bytes: owner.toBase58() } }],
    });
    const receipts = rows
      .map((row) => normalizeDepositReceipt(row.pubkey, interceptor.DepositReceipt.fromAccountInfo(row.account)[0], nowSeconds, interceptor.PROGRAM_ID))
      .filter((receipt) => !input.claimableOnly || receipt.cooldownComplete);
    const totalRaw = receipts.reduce((sum, receipt) => sum + safeBigInt(receipt.lstAmountRaw), 0n);
    return {
      walletAddress: owner.toBase58(),
      receipts,
      totals: {
        receipts: receipts.length,
        claimableReceipts: receipts.filter((receipt) => receipt.cooldownComplete).length,
        pendingReceipts: receipts.filter((receipt) => !receipt.cooldownComplete).length,
        lstAmountRaw: totalRaw.toString(),
        lstAmount: formatRawAmount(totalRaw, JITOSOL_DECIMALS),
      },
    };
  }

  async getStakeAccount(connection: Connection, stakeAccount: string, walletAddress?: string): Promise<JitoStakeAccount> {
    const pubkey = new PublicKey(stakeAccount);
    const account = await connection.getParsedAccountInfo(pubkey, 'confirmed');
    const value = account.value;
    if (!value) {
      throw new AdapterError(JITO_ADAPTER_ID, 'stake_account_not_found', `Stake account ${pubkey.toBase58()} was not found.`);
    }
    const epochInfo = await connection.getEpochInfo('confirmed').catch(() => undefined);
    const normalized = normalizeStakeAccount(pubkey, value, walletAddress, epochInfo?.epoch, Math.floor(Date.now() / 1000));
    if (!normalized) {
      throw new AdapterError(JITO_ADAPTER_ID, 'invalid_stake_account', `${pubkey.toBase58()} is not a parsed stake account.`);
    }
    const activation = await connection.getStakeActivation(pubkey, 'confirmed').catch(() => undefined);
    return withConfirmedDepositEligibility(normalized, activation?.state);
  }

  async getDepositReceipt(connection: Connection, receiptAddress: string): Promise<JitoDepositReceipt> {
    const interceptor = await loadStakeDepositInterceptorSdk();
    const pubkey = new PublicKey(receiptAddress);
    const account = await connection.getAccountInfo(pubkey, 'confirmed');
    if (!account) {
      throw new AdapterError(JITO_ADAPTER_ID, 'deposit_receipt_not_found', `Jito deposit receipt ${pubkey.toBase58()} was not found.`);
    }
    const [receipt] = interceptor.DepositReceipt.fromAccountInfo(account);
    return normalizeDepositReceipt(pubkey, receipt, Math.floor(Date.now() / 1000), interceptor.PROGRAM_ID);
  }

  async quote(connection: Connection, input: JitoQuoteInput): Promise<JitoQuote> {
    const snapshot = await this.getStakePoolSnapshot(connection);
    const pool = poolMath(snapshot);
    const warnings = [...snapshot.warnings];
    const exchangeRateSnapshot = exchangeSnapshot(snapshot);

    if (input.operation === 'stake_sol') {
      const amount = input.solAmount ?? input.amount;
      if (!amount) throw new ProtocolError('invalid_request', 'solAmount is required for a Jito stake quote.');
      const lamports = parseDecimalAmount(amount, 9, 'Jito SOL stake amount');
      const expectedRaw = poolTokensFromLamports(applyFee(lamports, snapshot.fees.solDeposit), pool);
      warnings.push(JITO_OFFCHAIN_MIN_OUTPUT_WARNING);
      return {
        operation: input.operation,
        amount,
        amountRaw: lamports.toString(),
        expectedJitoSolAmount: formatRawAmount(expectedRaw, JITOSOL_DECIMALS),
        expectedJitoSolRaw: expectedRaw.toString(),
        exchangeRateSnapshot,
        warnings,
      };
    }

    if (input.operation === 'deposit_stake_account') {
      if (!input.stakeAccount?.trim()) {
        throw new ProtocolError('invalid_request', 'stakeAccount is required for a Jito stake-account deposit quote.');
      }
      const stake = await this.getStakeAccount(connection, input.stakeAccount);
      const delegated = safeBigInt(stake.delegatedStakeLamports ?? '0');
      const expectedRaw = poolTokensFromLamports(applyFee(delegated, snapshot.fees.stakeDeposit), pool);
      warnings.push(JITO_OFFCHAIN_MIN_OUTPUT_WARNING);
      if (!stake.eligibleForJitoDeposit && stake.ineligibleReason) warnings.push(stake.ineligibleReason);
      return {
        operation: input.operation,
        stakeAccount: stake.stakeAccount,
        amountRaw: delegated.toString(),
        expectedJitoSolAmount: formatRawAmount(expectedRaw, JITOSOL_DECIMALS),
        expectedJitoSolRaw: expectedRaw.toString(),
        exchangeRateSnapshot,
        warnings,
      };
    }

    if (input.operation === 'unstake_jitosol') {
      const amount = input.jitoSolAmount ?? input.amount;
      if (!amount) throw new ProtocolError('invalid_request', 'jitoSolAmount is required for a Jito unstake quote.');
      const raw = parseDecimalAmount(amount, JITOSOL_DECIMALS, 'JitoSOL unstake amount');
      const mode = input.withdrawMode ?? 'stake_account';
      const fee = mode === 'reserve_sol' ? snapshot.fees.solWithdrawal : snapshot.fees.stakeWithdrawal;
      const expectedRaw = applyFee(lamportsFromPoolTokens(raw, pool), fee);
      warnings.push(JITO_OFFCHAIN_MIN_OUTPUT_WARNING);
      return {
        operation: input.operation,
        amount,
        amountRaw: raw.toString(),
        withdrawMode: mode,
        expectedSolAmount: formatRawAmount(expectedRaw, 9),
        expectedSolRaw: expectedRaw.toString(),
        exchangeRateSnapshot,
        warnings,
      };
    }

    if (input.operation === 'withdraw_sol') {
      if (!input.stakeAccount?.trim()) {
        throw new ProtocolError('invalid_request', 'stakeAccount is required for a Jito stake-account SOL withdrawal quote.');
      }
      const stake = await this.getStakeAccount(connection, input.stakeAccount);
      const amountRaw = input.solAmount || input.amount
        ? parseDecimalAmount(input.solAmount ?? input.amount ?? '', 9, 'Jito stake-account withdraw amount')
        : safeBigInt(stake.lamports);
      return {
        operation: input.operation,
        stakeAccount: stake.stakeAccount,
        amount: formatRawAmount(amountRaw, 9),
        amountRaw: amountRaw.toString(),
        expectedSolAmount: formatRawAmount(amountRaw, 9),
        expectedSolRaw: amountRaw.toString(),
        exchangeRateSnapshot,
        warnings,
      };
    }

    throw new ProtocolError('invalid_request', `Unsupported Jito quote operation ${input.operation}.`);
  }

  async buildStakeSolTransaction(
    connection: Connection,
    input: JitoBuildStakeSolInput,
  ): Promise<JitoBuildTransactionResult> {
    const sdk = await loadStakePoolSdk();
    const wallet = new PublicKey(input.walletAddress);
    const amount = safeNumber(input.amountLamports, 'Jito SOL stake amount');
    const built = await sdk.depositSol(connection, JITO_STAKE_POOL_ADDRESS, wallet, amount);
    return buildTransaction(connection, wallet, built.instructions, built.signers, {
      operation: 'stake_sol',
      amount: formatRawAmount(input.amountLamports, 9),
      amountRaw: input.amountLamports.toString(),
    }, [SPL_STAKE_POOL_PROGRAM_ID.toBase58()]);
  }

  async buildDepositStakeAccountTransaction(
    connection: Connection,
    input: JitoBuildDepositStakeInput,
  ): Promise<JitoBuildTransactionResult> {
    const interceptor = await loadStakeDepositInterceptorSdk();
    const wallet = new PublicKey(input.walletAddress);
    const stake = await this.getStakeAccount(connection, input.stakeAccount, wallet.toBase58());
    requireJitoStakeDepositEligible(stake);
    if (!stake.voter) {
      throw new AdapterError(JITO_ADAPTER_ID, 'missing_vote_account', 'Stake account is missing a validator vote account.');
    }
    await assertVoteAccountInJitoPool(connection, stake.voter);
    const built = await interceptor.depositStake(
      connection,
      wallet,
      JITO_STAKE_POOL_ADDRESS,
      wallet,
      new PublicKey(stake.voter),
      new PublicKey(stake.stakeAccount),
    );
    const baseSigner = built.signers[0];
    if (!baseSigner) {
      throw new AdapterError(JITO_ADAPTER_ID, 'missing_deposit_receipt_base', 'Jito stake deposit did not return a receipt base signer.');
    }
    const depositReceipt = deriveDepositReceiptAddress(interceptor.PROGRAM_ID, JITO_STAKE_POOL_ADDRESS, baseSigner.publicKey);
    if (input.minJitoSolRaw !== undefined) {
      replaceDepositStakeWithSlippageInstruction(built.instructions, wallet, input.minJitoSolRaw, interceptor);
    }
    return buildTransaction(connection, wallet, built.instructions, built.signers, {
      operation: 'deposit_stake_account',
      stakeAccount: stake.stakeAccount,
      delegatedStakeLamports: stake.delegatedStakeLamports,
      depositReceipt: depositReceipt.toBase58(),
      receiptBase: baseSigner.publicKey.toBase58(),
      minJitoSolRaw: input.minJitoSolRaw?.toString(),
      expectedClaim: 'Deposit creates an interceptor receipt; JitoSOL is claimable after the cooldown or earlier with the interceptor fee.',
    }, [SPL_STAKE_POOL_PROGRAM_ID.toBase58(), interceptor.PROGRAM_ID.toBase58()]);
  }

  async buildUnstakeJitosolTransaction(
    connection: Connection,
    input: JitoBuildUnstakeInput,
  ): Promise<JitoBuildTransactionResult> {
    const sdk = await loadStakePoolSdk();
    const wallet = new PublicKey(input.walletAddress);
    const amount = rawPoolTokensToUiNumber(input.jitoSolAmountRaw, 'JitoSOL unstake amount');
    const built = input.withdrawMode === 'reserve_sol'
      ? await sdk.withdrawSol(connection, JITO_STAKE_POOL_ADDRESS, wallet, wallet, amount)
      : await sdk.withdrawStake(connection, JITO_STAKE_POOL_ADDRESS, wallet, amount);
    const stakeReceiver = (built as { stakeReceiver?: PublicKey }).stakeReceiver;
    const generatedStakeReceivers = input.withdrawMode === 'stake_account'
      ? built.signers.slice(1).map((signer) => signer.publicKey.toBase58())
      : [];
    return buildTransaction(connection, wallet, built.instructions, built.signers, {
      operation: 'unstake_jitosol',
      withdrawMode: input.withdrawMode,
      jitoSolAmount: formatRawAmount(input.jitoSolAmountRaw, JITOSOL_DECIMALS),
      jitoSolAmountRaw: input.jitoSolAmountRaw.toString(),
      stakeReceiver: stakeReceiver?.toBase58(),
      generatedStakeReceivers,
    }, [SPL_STAKE_POOL_PROGRAM_ID.toBase58()]);
  }

  async buildWithdrawSolTransaction(
    connection: Connection,
    input: JitoBuildWithdrawSolInput,
  ): Promise<JitoBuildTransactionResult> {
    const wallet = new PublicKey(input.walletAddress);
    const stake = await this.getStakeAccount(connection, input.stakeAccount, wallet.toBase58());
    const activation = await connection.getStakeActivation(new PublicKey(stake.stakeAccount), 'confirmed').catch(() => undefined);
    const activationState = activation?.state;
    const inactive = activationState === 'inactive' || (!activationState && stake.state !== 'delegated');
    if (!inactive) {
      throw new AdapterError(
        JITO_ADAPTER_ID,
        'stake_account_still_active',
        `Stake account ${stake.stakeAccount} is ${activationState ?? stake.state}; wait until it is inactive before withdrawing SOL.`,
      );
    }
    if (input.withdrawAll && input.amountLamports !== undefined) {
      throw new ProtocolError('invalid_request', 'Jito SOL withdrawal cannot set both withdrawAll and amountLamports.');
    }
    const lamports = input.withdrawAll || input.amountLamports === undefined
      ? safeBigInt(stake.lamports)
      : input.amountLamports;
    validateStakeWithdrawalAmount(stake, lamports, input.withdrawAll ?? input.amountLamports === undefined);
    const transaction = new Transaction().add(
      ...StakeProgram.withdraw({
        stakePubkey: new PublicKey(stake.stakeAccount),
        authorizedPubkey: wallet,
        toPubkey: wallet,
        lamports: safeNumber(lamports, 'Stake account SOL withdrawal amount'),
      }).instructions,
    );
    await prepareLegacyTransaction(connection, transaction, wallet, []);
    return {
      transactionBase64: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      programIds: [StakeProgram.programId.toBase58()],
      preview: {
        operation: 'withdraw_sol',
        stakeAccount: stake.stakeAccount,
        amount: formatRawAmount(lamports, 9),
        amountRaw: lamports.toString(),
        withdrawAll: input.withdrawAll ?? input.amountLamports === undefined,
      },
      signerCount: 0,
    };
  }

  async buildClaimDepositReceiptTransaction(
    connection: Connection,
    input: JitoBuildClaimDepositReceiptInput,
  ): Promise<JitoBuildTransactionResult> {
    const interceptor = await loadStakeDepositInterceptorSdk();
    const splToken = await loadSplTokenSdk();
    const wallet = new PublicKey(input.walletAddress);
    const receipt = await this.getDepositReceipt(connection, input.receiptAddress);
    requireReceiptOwner(receipt, wallet.toBase58());
    requireReceiptClaimable(receipt, input.allowEarlyClaim === true);
    const authority = await interceptor.StakePoolDepositStakeAuthority.fromAccountAddress(
      connection,
      new PublicKey(receipt.stakePoolDepositStakeAuthority),
      'confirmed',
    );
    if (!new PublicKey(receipt.stakePool).equals(JITO_STAKE_POOL_ADDRESS) || !authority.poolMint.equals(JITOSOL_MINT)) {
      throw new AdapterError(JITO_ADAPTER_ID, 'invalid_deposit_receipt', 'Deposit receipt does not belong to the configured JitoSOL stake pool.');
    }
    const destination = splToken.getAssociatedTokenAddressSync(authority.poolMint, wallet);
    const instructions: TransactionInstruction[] = [
      splToken.createAssociatedTokenAccountIdempotentInstruction(wallet, destination, wallet, authority.poolMint),
      interceptor.createClaimPoolTokensInstruction({
        depositReceipt: new PublicKey(receipt.depositReceipt),
        owner: wallet,
        vault: authority.vault,
        destination,
        feeWallet: authority.feeWallet,
        depositAuthority: new PublicKey(receipt.stakePoolDepositStakeAuthority),
        poolMint: authority.poolMint,
        tokenProgram: splToken.TOKEN_PROGRAM_ID,
      }),
    ];
    return buildTransaction(connection, wallet, instructions, [], {
      operation: 'claim_deposit_receipt',
      depositReceipt: receipt.depositReceipt,
      destinationTokenAccount: destination.toBase58(),
      lstAmount: receipt.lstAmount,
      lstAmountRaw: receipt.lstAmountRaw,
      cooldownComplete: receipt.cooldownComplete,
      allowEarlyClaim: input.allowEarlyClaim === true,
      initialFeeBps: receipt.initialFeeBps,
    }, [interceptor.PROGRAM_ID.toBase58()]);
  }
}

function canResolvePackage(packageName: string): boolean {
  try {
    requireFromHere.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

function isJitoConnectorFeatureDisabled(): boolean {
  return process.env.JITO_CONNECTOR_ENABLED?.trim().toLowerCase() === 'false';
}

const defaultFactory = (): JitoClient => canResolvePackage(STAKE_POOL_PACKAGE)
  ? new JitoSdkClient()
  : new JitoSdkUnavailable(STAKE_POOL_UNAVAILABLE_REASON);

let factory: () => JitoClient = defaultFactory;
let cached: JitoClient | undefined;

export function setJitoClientFactory(next: () => JitoClient): void {
  factory = next;
  cached = undefined;
}

export function resetJitoClientFactory(): void {
  factory = defaultFactory;
  cached = undefined;
}

export function getJitoClient(): JitoClient {
  if (isJitoConnectorFeatureDisabled()) return new JitoSdkUnavailable(FEATURE_DISABLED_REASON);
  if (!cached) cached = factory();
  return cached;
}

export function isJitoConfigured(): boolean {
  return !(getJitoClient() instanceof JitoSdkUnavailable);
}

export function describeJitoUnavailableReason(): string | undefined {
  if (isJitoConnectorFeatureDisabled()) return FEATURE_DISABLED_REASON;
  const client = getJitoClient();
  return client instanceof JitoSdkUnavailable ? client.reason : undefined;
}

export function describeJitoStakeDepositUnavailableReason(): string | undefined {
  if (isJitoConnectorFeatureDisabled()) return FEATURE_DISABLED_REASON;
  return canResolvePackage(STAKE_DEPOSIT_INTERCEPTOR_PACKAGE) ? undefined : INTERCEPTOR_UNAVAILABLE_REASON;
}

export function describeJitoReceiptClaimUnavailableReason(): string | undefined {
  if (isJitoConnectorFeatureDisabled()) return FEATURE_DISABLED_REASON;
  if (!canResolvePackage(STAKE_DEPOSIT_INTERCEPTOR_PACKAGE)) return INTERCEPTOR_UNAVAILABLE_REASON;
  return canResolvePackage(SPL_TOKEN_PACKAGE) ? undefined : SPL_TOKEN_UNAVAILABLE_REASON;
}

async function loadStakePoolSdk(): Promise<SplStakePoolModule> {
  return import(STAKE_POOL_PACKAGE) as Promise<SplStakePoolModule>;
}

async function loadStakeDepositInterceptorSdk(): Promise<JitoInterceptorModule> {
  if (!canResolvePackage(STAKE_DEPOSIT_INTERCEPTOR_PACKAGE)) {
    throw new AdapterError(JITO_ADAPTER_ID, 'stake_deposit_interceptor_unavailable', INTERCEPTOR_UNAVAILABLE_REASON);
  }
  return import(STAKE_DEPOSIT_INTERCEPTOR_PACKAGE) as Promise<JitoInterceptorModule>;
}

async function loadSplTokenSdk(): Promise<SplTokenModule> {
  if (!canResolvePackage(SPL_TOKEN_PACKAGE)) {
    throw new AdapterError(JITO_ADAPTER_ID, 'spl_token_unavailable', SPL_TOKEN_UNAVAILABLE_REASON);
  }
  return import(SPL_TOKEN_PACKAGE) as Promise<SplTokenModule>;
}

async function readValidators(
  connection: Connection,
  sdk: SplStakePoolModule,
  validatorListAddress: PublicKey,
): Promise<JitoValidatorStakeInfo[]> {
  const account = await connection.getAccountInfo(validatorListAddress, 'confirmed');
  if (!account) return [];
  const list = sdk.ValidatorListLayout.decode(account.data);
  return list.validators.map((validator: unknown) => {
    const row = validator as {
      voteAccountAddress: PublicKey;
      activeStakeLamports: unknown;
      transientStakeLamports: unknown;
      lastUpdateEpoch: unknown;
      status: number;
    };
    return {
      voteAccountAddress: row.voteAccountAddress.toBase58(),
      activeStakeLamports: bnToBigInt(row.activeStakeLamports).toString(),
      transientStakeLamports: bnToBigInt(row.transientStakeLamports).toString(),
      lastUpdateEpoch: bnToBigInt(row.lastUpdateEpoch).toString(),
      status: validatorStatus(row.status),
    };
  });
}

async function assertVoteAccountInJitoPool(connection: Connection, voteAccount: string): Promise<void> {
  const sdk = await loadStakePoolSdk();
  const stakePoolAccount = await sdk.getStakePoolAccount(connection, JITO_STAKE_POOL_ADDRESS);
  const validators = await readValidators(connection, sdk, stakePoolAccount.account.data.validatorList);
  if (!validators.some((validator) => validator.voteAccountAddress === voteAccount)) {
    throw new AdapterError(
      JITO_ADAPTER_ID,
      'validator_not_in_jito_pool',
      `Stake account validator vote account ${voteAccount} is not in the Jito validator list.`,
    );
  }
}

function withConfirmedDepositEligibility(account: JitoStakeAccount, activationState: string | undefined): JitoStakeAccount {
  const next: JitoStakeAccount = activationState ? { ...account, activationState } : { ...account };
  if (next.eligibleForJitoDeposit && next.state === 'delegated') {
    if (!activationState) {
      return {
        ...next,
        eligibleForJitoDeposit: false,
        ineligibleReason: 'Stake activation state could not be confirmed.',
      };
    }
    if (activationState !== 'active') {
      return {
        ...next,
        eligibleForJitoDeposit: false,
        ineligibleReason: `Stake account activation state is ${activationState}; Jito deposit requires active delegated stake.`,
      };
    }
  }
  return next;
}

function normalizeDepositReceipt(
  pubkey: PublicKey,
  receipt: {
    base: PublicKey;
    owner: PublicKey;
    stakePool: PublicKey;
    stakePoolDepositStakeAuthority: PublicKey;
    depositTime: unknown;
    lstAmount: unknown;
    coolDownSeconds: unknown;
    initialFeeBps: number;
  },
  nowSeconds: number,
  programId: PublicKey,
): JitoDepositReceipt {
  const depositTime = safeBigInt(receipt.depositTime);
  const coolDownSeconds = safeBigInt(receipt.coolDownSeconds);
  const claimableAtSeconds = depositTime + coolDownSeconds;
  const secondsUntilClaimable = Number(claimableAtSeconds > BigInt(nowSeconds) ? claimableAtSeconds - BigInt(nowSeconds) : 0n);
  const lstAmountRaw = safeBigInt(receipt.lstAmount);
  const warnings: string[] = [];
  if (!receipt.stakePool.equals(JITO_STAKE_POOL_ADDRESS)) {
    warnings.push(`Receipt stake pool ${receipt.stakePool.toBase58()} does not match Jito ${JITO_STAKE_POOL_ADDRESS.toBase58()}.`);
  }
  return {
    depositReceipt: pubkey.toBase58(),
    base: receipt.base.toBase58(),
    owner: receipt.owner.toBase58(),
    stakePool: receipt.stakePool.toBase58(),
    stakePoolDepositStakeAuthority: receipt.stakePoolDepositStakeAuthority.toBase58(),
    lstAmount: formatRawAmount(lstAmountRaw, JITOSOL_DECIMALS),
    lstAmountRaw: lstAmountRaw.toString(),
    depositTime: depositTime.toString(),
    depositedAt: unixSecondsToIso(depositTime),
    coolDownSeconds: coolDownSeconds.toString(),
    claimableAt: unixSecondsToIso(claimableAtSeconds),
    cooldownComplete: secondsUntilClaimable === 0,
    secondsUntilClaimable,
    initialFeeBps: receipt.initialFeeBps,
    programIds: [programId.toBase58()],
    warnings,
  };
}

function normalizeStakeAccount(
  pubkey: PublicKey,
  account: AccountInfo<Buffer | ParsedAccountData>,
  walletAddress: string | undefined,
  currentEpoch: number | undefined,
  nowSeconds: number,
): JitoStakeAccount | null {
  const data = account.data;
  if (!data || Buffer.isBuffer(data) || !('parsed' in data)) return null;
  if (data.program !== 'stake') return null;
  const parsed = data.parsed as Record<string, unknown>;
  const state = typeof parsed.type === 'string' ? parsed.type : 'unknown';
  const info = parsed.info && typeof parsed.info === 'object' ? parsed.info as Record<string, unknown> : {};
  const meta = objectPath(info, ['meta']);
  const stake = objectPath(info, ['stake']);
  const delegation = objectPath(stake, ['delegation']);
  const authorized = objectPath(meta, ['authorized']);
  const lockup = objectPath(meta, ['lockup']);
  const withdrawer = stringPath(authorized, ['withdrawer']);
  const staker = stringPath(authorized, ['staker']);
  const voter = stringPath(delegation, ['voter']);
  const delegatedStakeLamports = stringPath(delegation, ['stake']);
  const activationEpoch = stringPath(delegation, ['activationEpoch']);
  const deactivationEpoch = stringPath(delegation, ['deactivationEpoch']);
  const lockupUnixTimestamp = numberOrStringPath(lockup, ['unixTimestamp']);
  const lockupEpoch = numberOrStringPath(lockup, ['epoch']);
  const lockedByTime = typeof lockupUnixTimestamp === 'number' && lockupUnixTimestamp > nowSeconds;
  const lockedByEpoch = currentEpoch !== undefined && typeof lockupEpoch === 'number' && lockupEpoch > currentEpoch;
  const locked = lockedByTime || lockedByEpoch;
  const delegatedStake = safeBigInt(delegatedStakeLamports ?? '0');
  const deactivating = deactivationEpoch !== undefined && deactivationEpoch !== U64_MAX_EPOCH;
  const warnings: string[] = [];

  let ineligibleReason: string | undefined;
  if (walletAddress && withdrawer && withdrawer !== walletAddress) {
    ineligibleReason = `Withdraw authority ${withdrawer} does not match wallet ${walletAddress}.`;
  } else if (walletAddress && staker && staker !== walletAddress) {
    ineligibleReason = `Stake authority ${staker} does not match wallet ${walletAddress}.`;
  } else if (state !== 'delegated') {
    ineligibleReason = `Stake account is ${state}; Jito deposit requires delegated stake.`;
  } else if (!voter) {
    ineligibleReason = 'Stake account is missing a validator vote account.';
  } else if (delegatedStake <= 0n) {
    ineligibleReason = 'Stake account has no delegated stake.';
  } else if (deactivating) {
    ineligibleReason = 'Stake account is deactivating or already deactivated.';
  } else if (locked) {
    ineligibleReason = 'Stake account lockup is still active.';
  }
  if (locked) warnings.push('Stake account lockup is active.');
  if (deactivating) warnings.push('Stake account is deactivating or deactivated.');

  return {
    stakeAccount: pubkey.toBase58(),
    ...(walletAddress ? { walletAddress } : {}),
    ...(withdrawer ? { withdrawer } : {}),
    ...(staker ? { staker } : {}),
    ...(voter ? { voter } : {}),
    ...(delegatedStakeLamports ? { delegatedStakeLamports } : {}),
    lamports: BigInt(account.lamports).toString(),
    ...(stringPath(meta, ['rentExemptReserve']) ? { rentExemptReserve: stringPath(meta, ['rentExemptReserve']) } : {}),
    ...(activationEpoch ? { activationEpoch } : {}),
    ...(deactivationEpoch ? { deactivationEpoch } : {}),
    state,
    locked,
    deactivating,
    eligibleForJitoDeposit: !ineligibleReason,
    ...(ineligibleReason ? { ineligibleReason } : {}),
    warnings,
  };
}

async function buildTransaction(
  connection: Connection,
  feePayer: PublicKey,
  instructions: TransactionInstruction[],
  signers: Signer[],
  preview: Record<string, unknown>,
  programIds: string[],
): Promise<JitoBuildTransactionResult> {
  const transaction = new Transaction().add(...instructions);
  await prepareLegacyTransaction(connection, transaction, feePayer, signers);
  return {
    transactionBase64: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    programIds,
    preview,
    signerCount: signers.length,
  };
}

async function prepareLegacyTransaction(
  connection: Connection,
  transaction: Transaction,
  feePayer: PublicKey,
  signers: Signer[],
): Promise<void> {
  transaction.feePayer = feePayer;
  const blockhash = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash.blockhash;
  if (signers.length > 0) {
    transaction.partialSign(...signers);
  }
}

function deriveDepositReceiptAddress(programId: PublicKey, stakePoolAddress: PublicKey, base: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('deposit_receipt'), stakePoolAddress.toBuffer(), base.toBuffer()],
    programId,
  )[0];
}

function replaceDepositStakeWithSlippageInstruction(
  instructions: TransactionInstruction[],
  owner: PublicKey,
  minimumPoolTokensOut: bigint,
  interceptor: JitoInterceptorModule,
): void {
  let index = -1;
  for (let i = instructions.length - 1; i >= 0; i -= 1) {
    if (instructions[i]?.programId.equals(interceptor.PROGRAM_ID)) {
      index = i;
      break;
    }
  }
  const instruction = index >= 0 ? instructions[index] : undefined;
  if (!instruction) {
    throw new AdapterError(JITO_ADAPTER_ID, 'missing_deposit_instruction', 'Jito stake deposit instruction was not found.');
  }
  const key = (position: number, label: string): PublicKey => {
    const account = instruction.keys[position]?.pubkey;
    if (!account) {
      throw new AdapterError(JITO_ADAPTER_ID, 'invalid_deposit_instruction', `Jito stake deposit instruction is missing ${label}.`);
    }
    return account;
  };
  instructions[index] = interceptor.createDepositStakeWithSlippageInstruction({
    payer: key(0, 'payer'),
    stakePoolProgram: key(1, 'stake pool program'),
    depositReceipt: key(2, 'deposit receipt'),
    stakePool: key(3, 'stake pool'),
    validatorStakeList: key(4, 'validator stake list'),
    depositStakeAuthority: key(5, 'deposit stake authority'),
    base: key(6, 'base'),
    stakePoolWithdrawAuthority: key(7, 'stake pool withdraw authority'),
    stake: key(8, 'stake'),
    validatorStakeAccount: key(9, 'validator stake account'),
    reserveStakeAccount: key(10, 'reserve stake account'),
    vault: key(11, 'vault'),
    managerFeeAccount: key(12, 'manager fee account'),
    referrerPoolTokensAccount: key(13, 'referrer pool token account'),
    poolMint: key(14, 'pool mint'),
    clock: key(15, 'clock'),
    stakeHistory: key(16, 'stake history'),
    tokenProgram: key(17, 'token program'),
    stakeProgram: key(18, 'stake program'),
    systemProgram: key(19, 'system program'),
  }, {
    depositStakeWithSlippageArgs: {
      owner,
      minimumPoolTokensOut: safeNumber(minimumPoolTokensOut, 'Minimum JitoSOL output'),
    },
  });
}

function requireJitoStakeDepositEligible(stake: JitoStakeAccount): void {
  if (!stake.eligibleForJitoDeposit) {
    throw new AdapterError(
      JITO_ADAPTER_ID,
      'stake_account_not_eligible',
      stake.ineligibleReason ?? 'Stake account is not eligible for Jito stake-pool deposit.',
    );
  }
}

function requireReceiptOwner(receipt: JitoDepositReceipt, walletAddress: string): void {
  if (receipt.owner !== walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Jito deposit receipt belongs to ${receipt.owner}, but connected wallet is ${walletAddress}.`,
    );
  }
}

function requireReceiptClaimable(receipt: JitoDepositReceipt, allowEarlyClaim: boolean): void {
  if (!receipt.cooldownComplete && !allowEarlyClaim) {
    throw new AdapterError(
      JITO_ADAPTER_ID,
      'deposit_receipt_cooling_down',
      `Jito deposit receipt is claimable without early-claim fees at ${receipt.claimableAt}; pass allowEarlyClaim to claim during cooldown.`,
    );
  }
}

function validateStakeWithdrawalAmount(stake: JitoStakeAccount, amountLamports: bigint, withdrawAll: boolean): void {
  const total = safeBigInt(stake.lamports);
  if (amountLamports <= 0n) {
    throw new ProtocolError('invalid_request', 'Jito stake-account SOL withdrawal amount must be greater than zero.');
  }
  if (amountLamports > total) {
    throw new ProtocolError('invalid_request', 'Jito stake-account SOL withdrawal amount exceeds the stake account balance.');
  }
  const rentReserve = stake.rentExemptReserve ? safeBigInt(stake.rentExemptReserve) : undefined;
  if (!withdrawAll && rentReserve !== undefined && total - amountLamports < rentReserve) {
    throw new ProtocolError(
      'invalid_request',
      `Partial Jito stake-account SOL withdrawal must leave the rent-exempt reserve of ${formatRawAmount(rentReserve, 9)} SOL.`,
    );
  }
}

function unixSecondsToIso(seconds: bigint): string {
  const millis = seconds * 1000n;
  if (millis > BigInt(Number.MAX_SAFE_INTEGER)) return '9999-12-31T23:59:59.999Z';
  return new Date(Number(millis)).toISOString();
}

function poolMath(snapshot: JitoStakePoolSnapshot): { totalLamports: bigint; poolTokenSupply: bigint } {
  const totalLamports = safeBigInt(snapshot.totalLamports);
  const poolTokenSupply = safeBigInt(snapshot.poolTokenSupply);
  if (totalLamports <= 0n || poolTokenSupply <= 0n) {
    throw new AdapterError(JITO_ADAPTER_ID, 'invalid_pool_state', 'Jito stake pool has no total lamports or pool token supply.');
  }
  return { totalLamports, poolTokenSupply };
}

function exchangeSnapshot(snapshot: JitoStakePoolSnapshot): JitoQuote['exchangeRateSnapshot'] {
  return {
    stakePoolAddress: snapshot.stakePoolAddress,
    jitoSolMint: snapshot.jitoSolMint,
    totalLamports: snapshot.totalLamports,
    poolTokenSupply: snapshot.poolTokenSupply,
    exchangeRateSolPerJitoSol: snapshot.exchangeRateSolPerJitoSol,
    exchangeRateJitoSolPerSol: snapshot.exchangeRateJitoSolPerSol,
    lastUpdateEpoch: snapshot.lastUpdateEpoch,
  };
}

function poolTokensFromLamports(lamports: bigint, pool: { totalLamports: bigint; poolTokenSupply: bigint }): bigint {
  return lamports * pool.poolTokenSupply / pool.totalLamports;
}

function lamportsFromPoolTokens(tokens: bigint, pool: { totalLamports: bigint; poolTokenSupply: bigint }): bigint {
  return tokens * pool.totalLamports / pool.poolTokenSupply;
}

function applyFee(amount: bigint, fee: JitoFeeSnapshot): bigint {
  const numerator = safeBigInt(fee.numerator);
  const denominator = safeBigInt(fee.denominator);
  if (numerator <= 0n || denominator <= 0n) return amount;
  const feeAmount = amount * numerator / denominator;
  return feeAmount >= amount ? 0n : amount - feeAmount;
}

function feeSnapshot(value: unknown): JitoFeeSnapshot {
  const row = value as { numerator?: unknown; denominator?: unknown };
  const numerator = bnToBigInt(row?.numerator ?? 0).toString();
  const denominator = bnToBigInt(row?.denominator ?? 0).toString();
  const denom = Number(denominator);
  const numer = Number(numerator);
  return {
    numerator,
    denominator,
    bps: Number.isFinite(denom) && denom > 0 && Number.isFinite(numer) ? numer / denom * 10_000 : 0,
  };
}

function ratioString(numerator: bigint, denominator: bigint, decimals = 9): string {
  if (denominator === 0n) return '0';
  const scale = 10n ** BigInt(decimals);
  return formatRawAmount(numerator * scale / denominator, decimals);
}

function rawPoolTokensToUiNumber(raw: bigint, label: string): number {
  return Number(safeNumber(raw, `${label} raw amount`)) / 10 ** JITOSOL_DECIMALS;
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProtocolError('invalid_request', `${label} is too large for the current SDK helper.`);
  }
  return Number(value);
}

function safeBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) return BigInt(value.trim());
  if (value && typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    const text = (value as { toString(): string }).toString();
    if (text) return BigInt(text);
  }
  return 0n;
}

function bnToBigInt(value: unknown): bigint {
  return safeBigInt(value);
}

function validatorStatus(status: number): string {
  if (status === 0) return 'active';
  if (status === 1) return 'deactivating_transient';
  if (status === 2) return 'ready_for_removal';
  return `unknown_${status}`;
}

function parsedInfo(data: Buffer | ParsedAccountData): Record<string, unknown> {
  if (!data || Buffer.isBuffer(data) || !('parsed' in data)) return {};
  const parsed = data.parsed as Record<string, unknown>;
  const info = parsed.info;
  return info && typeof info === 'object' ? info as Record<string, unknown> : {};
}

function objectPath(base: unknown, keys: string[]): Record<string, unknown> {
  let current: unknown = base;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return {};
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === 'object' ? current as Record<string, unknown> : {};
}

function stringPath(base: unknown, keys: string[]): string | undefined {
  let current: unknown = base;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === 'string') return current;
  if (typeof current === 'number' || typeof current === 'bigint') return String(current);
  return undefined;
}

function numberPath(base: unknown, keys: string[]): number | undefined {
  let current: unknown = base;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}

function numberOrStringPath(base: unknown, keys: string[]): number | undefined {
  const direct = numberPath(base, keys);
  if (direct !== undefined) return direct;
  const text = stringPath(base, keys);
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseJitosolAmount(value: string, label = 'JitoSOL amount'): bigint {
  return parseDecimalAmount(value, JITOSOL_DECIMALS, label);
}

export function parseSolLamports(value: string, label = 'SOL amount'): bigint {
  return parseDecimalAmount(value, 9, label);
}

export { JitoSdkUnavailable };
