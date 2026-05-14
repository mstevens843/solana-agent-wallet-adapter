import { ProtocolError } from '@solana-agent-wallet-adapter/core';
import type { Connection } from '@solana/web3.js';

import { formatRawAmount } from '../../amounts.js';
import type { PreparedAction } from '../../preparedActions.js';
import type { AdapterAction, AdapterExecuteResult, AdapterPrepareResult } from '../types.js';
import { AdapterError } from '../types.js';
import {
  describeJitoStakeDepositUnavailableReason,
  describeJitoReceiptClaimUnavailableReason,
  getJitoClient,
  parseJitosolAmount,
  parseSolLamports,
  type JitoDepositReceipt,
  type JitoQuote,
  type JitoStakeAccount,
  type JitoWithdrawMode,
} from './client.js';
import {
  JITO_ADAPTER_ID,
  JITO_MIN_STAKE_SOL_LAMPORTS,
  JITO_OFFCHAIN_MIN_OUTPUT_WARNING,
  JITO_STAKE_DEPOSIT_INTERCEPTOR_PROGRAM_ID,
  JITO_STAKE_POOL_ADDRESS,
  JITOSOL_DECIMALS,
  JITOSOL_MINT,
  SPL_STAKE_POOL_PROGRAM_ID,
} from './constants.js';

const JITO_APPROVAL_BOUNDARY =
  'This prepares a wallet approval request; it does not sign, submit, or grant delegated authority.';

export interface JitoStakeSolInput {
  solAmount?: string;
  /** @deprecated Old template field id; accepted for backward compatibility with pre-rename drafts. */
  amount?: string;
  minJitoSolAmount?: string;
  dueAt?: string;
  note?: string;
}

export interface JitoDepositStakeAccountInput {
  stakeAccount: string;
  minJitoSolAmount?: string;
  dueAt?: string;
  note?: string;
}

export interface JitoUnstakeJitosolInput {
  jitoSolAmount?: string;
  /** @deprecated Old template field id; accepted for backward compatibility with pre-rename drafts. */
  amount?: string;
  minSolAmount?: string;
  withdrawMode?: JitoWithdrawMode;
  dueAt?: string;
  note?: string;
}

export interface JitoWithdrawSolInput {
  stakeAccount: string;
  amountSol?: string;
  withdrawAll?: boolean;
  dueAt?: string;
  note?: string;
}

export interface JitoClaimDepositReceiptInput {
  receiptAddress: string;
  allowEarlyClaim?: boolean;
  dueAt?: string;
  note?: string;
}

export const jitoStakeSolAction: AdapterAction<JitoStakeSolInput> = {
  id: 'stake_sol',
  kind: 'jito_stake_sol',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const solAmount = input.solAmount ?? input.amount;
    if (typeof solAmount !== 'string' || !solAmount.trim()) {
      throw new ProtocolError('invalid_request', 'SOL stake amount is required.');
    }
    const amountRaw = parseSolLamports(solAmount, 'SOL stake amount');
    if (amountRaw < JITO_MIN_STAKE_SOL_LAMPORTS) {
      throw new ProtocolError('invalid_request', 'Jito stake amount must be at least 0.001 SOL.');
    }
    const walletAddress = await ctx.backend.getAddress();
    const quote = await getJitoClient().quote(ctx.connection, {
      operation: 'stake_sol',
      solAmount,
    });
    const minRaw = input.minJitoSolAmount
      ? parseJitosolAmount(input.minJitoSolAmount, 'Minimum JitoSOL output')
      : undefined;
    enforceMinJitoSolOutput(quote, minRaw);
    const summary = `Stake ${solAmount} SOL for JitoSOL`;
    const preview = jitoPreview('stake_sol', {
      amount: solAmount,
      solAmount,
      amountRaw: amountRaw.toString(),
      ...(input.minJitoSolAmount !== undefined ? { minJitoSolAmount: input.minJitoSolAmount, minJitoSolRaw: minRaw?.toString() } : {}),
      quote,
    });
    return {
      addInput: {
        kind: 'jito_stake_sol',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params: preview,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview,
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireWallet(action, await ctx.backend.getAddress());
    const amount = requireStringParam(action, 'amount');
    const amountRaw = BigInt(requireStringParam(action, 'amountRaw'));
    const minRaw = optionalStringParam(action, 'minJitoSolRaw');
    const quote = await getJitoClient().quote(ctx.connection, {
      operation: 'stake_sol',
      solAmount: amount,
    });
    enforceMinJitoSolOutput(quote, minRaw ? BigInt(minRaw) : undefined);
    const built = await getJitoClient().buildStakeSolTransaction(ctx.connection, {
      walletAddress: action.walletAddress,
      amountLamports: amountRaw,
    });
    const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        ...built.preview,
        quote,
        programIds: built.programIds,
      },
    };
  },
};

export const jitoDepositStakeAccountAction: AdapterAction<JitoDepositStakeAccountInput> = {
  id: 'deposit_stake_account',
  kind: 'jito_deposit_stake_account',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const missingInterceptor = describeJitoStakeDepositUnavailableReason();
    if (missingInterceptor) {
      throw new AdapterError(JITO_ADAPTER_ID, 'stake_deposit_interceptor_unavailable', missingInterceptor);
    }
    const walletAddress = await ctx.backend.getAddress();
    const stake = await getJitoClient().getStakeAccount(ctx.connection, input.stakeAccount, walletAddress);
    if (!stake.eligibleForJitoDeposit) {
      throw new AdapterError(
        JITO_ADAPTER_ID,
        'stake_account_not_eligible',
        stake.ineligibleReason ?? 'Stake account is not eligible for Jito stake-pool deposit.',
      );
    }
    await requireStakeVoteInJitoPool(ctx.connection, stake.voter);
    const quote = await getJitoClient().quote(ctx.connection, {
      operation: 'deposit_stake_account',
      stakeAccount: stake.stakeAccount,
    });
    const minRaw = input.minJitoSolAmount
      ? parseJitosolAmount(input.minJitoSolAmount, 'Minimum JitoSOL output')
      : undefined;
    enforceMinJitoSolOutput(quote, minRaw);
    const summary = `Deposit stake account ${stake.stakeAccount} into Jito`;
    const preview = jitoPreview('deposit_stake_account', {
      stakeAccount: stake.stakeAccount,
      validatorVote: stake.voter,
      delegatedStakeLamports: stake.delegatedStakeLamports,
      ...(input.minJitoSolAmount !== undefined ? { minJitoSolAmount: input.minJitoSolAmount, minJitoSolRaw: minRaw?.toString() } : {}),
      quote,
    });
    return {
      addInput: {
        kind: 'jito_deposit_stake_account',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params: preview,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview,
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireWallet(action, await ctx.backend.getAddress());
    const stakeAccount = requireStringParam(action, 'stakeAccount');
    const minRaw = optionalStringParam(action, 'minJitoSolRaw');
    const quote = await getJitoClient().quote(ctx.connection, {
      operation: 'deposit_stake_account',
      stakeAccount,
    });
    enforceMinJitoSolOutput(quote, minRaw ? BigInt(minRaw) : undefined);
    const built = await getJitoClient().buildDepositStakeAccountTransaction(ctx.connection, {
      walletAddress: action.walletAddress,
      stakeAccount,
      ...(minRaw !== undefined ? { minJitoSolRaw: BigInt(minRaw) } : {}),
    });
    const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        ...built.preview,
        quote,
        programIds: built.programIds,
      },
    };
  },
};

export const jitoUnstakeJitosolAction: AdapterAction<JitoUnstakeJitosolInput> = {
  id: 'unstake_jitosol',
  kind: 'jito_unstake_jitosol',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const jitoSolAmount = input.jitoSolAmount ?? input.amount;
    if (typeof jitoSolAmount !== 'string' || !jitoSolAmount.trim()) {
      throw new ProtocolError('invalid_request', 'JitoSOL unstake amount is required.');
    }
    const amountRaw = parseJitosolAmount(jitoSolAmount, 'JitoSOL unstake amount');
    const walletAddress = await ctx.backend.getAddress();
    const withdrawMode = input.withdrawMode ?? 'stake_account';
    const quote = await getJitoClient().quote(ctx.connection, {
      operation: 'unstake_jitosol',
      jitoSolAmount,
      withdrawMode,
    });
    const minRaw = input.minSolAmount
      ? parseSolLamports(input.minSolAmount, 'Minimum SOL output')
      : undefined;
    enforceMinSolOutput(quote, minRaw);
    const summary = withdrawMode === 'reserve_sol'
      ? `Unstake ${jitoSolAmount} JitoSOL to SOL`
      : `Unstake ${jitoSolAmount} JitoSOL to a stake account`;
    const preview = jitoPreview('unstake_jitosol', {
      jitoSolAmount,
      jitoSolAmountRaw: amountRaw.toString(),
      withdrawMode,
      ...(input.minSolAmount !== undefined ? { minSolAmount: input.minSolAmount, minSolRaw: minRaw?.toString() } : {}),
      quote,
    });
    return {
      addInput: {
        kind: 'jito_unstake_jitosol',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params: preview,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview,
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireWallet(action, await ctx.backend.getAddress());
    const jitoSolAmount = requireStringParam(action, 'jitoSolAmount');
    const raw = BigInt(requireStringParam(action, 'jitoSolAmountRaw'));
    const withdrawMode = readWithdrawMode(action);
    const minRaw = optionalStringParam(action, 'minSolRaw');
    const quote = await getJitoClient().quote(ctx.connection, {
      operation: 'unstake_jitosol',
      jitoSolAmount,
      withdrawMode,
    });
    enforceMinSolOutput(quote, minRaw ? BigInt(minRaw) : undefined);
    const built = await getJitoClient().buildUnstakeJitosolTransaction(ctx.connection, {
      walletAddress: action.walletAddress,
      jitoSolAmountRaw: raw,
      withdrawMode,
    });
    const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        ...built.preview,
        quote,
        programIds: built.programIds,
      },
    };
  },
};

export const jitoWithdrawSolAction: AdapterAction<JitoWithdrawSolInput> = {
  id: 'withdraw_sol',
  kind: 'jito_withdraw_sol',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const missingClaimDependency = describeJitoReceiptClaimUnavailableReason();
    if (missingClaimDependency) {
      throw new AdapterError(JITO_ADAPTER_ID, 'receipt_claim_unavailable', missingClaimDependency);
    }
    const walletAddress = await ctx.backend.getAddress();
    const stake = await getJitoClient().getStakeAccount(ctx.connection, input.stakeAccount, walletAddress);
    if (stake.activationState !== 'inactive') {
      throw new AdapterError(
        JITO_ADAPTER_ID,
        'stake_account_still_active',
        `Stake account ${stake.stakeAccount} is ${stake.activationState ?? stake.state}; wait until it is inactive before withdrawing SOL.`,
      );
    }
    if (input.withdrawAll === true && input.amountSol !== undefined) {
      throw new ProtocolError('invalid_request', 'Jito SOL withdrawal cannot set both withdrawAll and amountSol.');
    }
    const amountRaw = input.amountSol
      ? parseSolLamports(input.amountSol, 'Stake account SOL withdrawal amount')
      : BigInt(stake.lamports);
    const withdrawAll = input.withdrawAll ?? input.amountSol === undefined;
    validateStakeWithdrawalAmount(stake, amountRaw, withdrawAll);
    const summary = withdrawAll
      ? `Withdraw all SOL from deactivated stake account ${stake.stakeAccount}`
      : `Withdraw ${formatRawAmount(amountRaw, 9)} SOL from deactivated stake account ${stake.stakeAccount}`;
    const preview = jitoPreview('withdraw_sol', {
      stakeAccount: stake.stakeAccount,
      amount: formatRawAmount(amountRaw, 9),
      amountRaw: amountRaw.toString(),
      withdrawAll,
      stakeAccountState: stake.state,
      activationState: stake.activationState,
    });
    return {
      addInput: {
        kind: 'jito_withdraw_sol',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params: preview,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview,
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireWallet(action, await ctx.backend.getAddress());
    const stakeAccount = requireStringParam(action, 'stakeAccount');
    const withdrawAll = action.params.withdrawAll !== false;
    const amountRaw = withdrawAll ? undefined : BigInt(requireStringParam(action, 'amountRaw'));
    const built = await getJitoClient().buildWithdrawSolTransaction(ctx.connection, {
      walletAddress: action.walletAddress,
      stakeAccount,
      ...(amountRaw !== undefined ? { amountLamports: amountRaw } : {}),
      withdrawAll,
    });
    const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        ...built.preview,
        programIds: built.programIds,
      },
    };
  },
};

export const jitoClaimDepositReceiptAction: AdapterAction<JitoClaimDepositReceiptInput> = {
  id: 'claim_deposit_receipt',
  kind: 'jito_claim_deposit_receipt',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const receipt = await getJitoClient().getDepositReceipt(ctx.connection, input.receiptAddress);
    requireReceiptOwner(receipt, walletAddress);
    requireReceiptClaimable(receipt, input.allowEarlyClaim === true);
    const summary = `Claim ${receipt.lstAmount} JitoSOL from Jito deposit receipt ${receipt.depositReceipt}`;
    const preview = jitoPreview('claim_deposit_receipt', {
      receiptAddress: receipt.depositReceipt,
      allowEarlyClaim: input.allowEarlyClaim === true,
      receipt,
    });
    return {
      addInput: {
        kind: 'jito_claim_deposit_receipt',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params: preview,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview,
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireWallet(action, await ctx.backend.getAddress());
    const receiptAddress = requireStringParam(action, 'receiptAddress');
    const allowEarlyClaim = action.params.allowEarlyClaim === true;
    const receipt = await getJitoClient().getDepositReceipt(ctx.connection, receiptAddress);
    requireReceiptOwner(receipt, action.walletAddress);
    requireReceiptClaimable(receipt, allowEarlyClaim);
    const built = await getJitoClient().buildClaimDepositReceiptTransaction(ctx.connection, {
      walletAddress: action.walletAddress,
      receiptAddress,
      allowEarlyClaim,
    });
    const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        ...built.preview,
        receipt,
        programIds: built.programIds,
      },
    };
  },
};

function jitoPreview(operation: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    adapter: JITO_ADAPTER_ID,
    connectorId: JITO_ADAPTER_ID,
    action: operation,
    operation,
    approvalBoundary: JITO_APPROVAL_BOUNDARY,
    stakePoolAddress: JITO_STAKE_POOL_ADDRESS.toBase58(),
    jitoSolMint: JITOSOL_MINT.toBase58(),
    decimals: JITOSOL_DECIMALS,
    programIds: [
      SPL_STAKE_POOL_PROGRAM_ID.toBase58(),
      ...(operation === 'deposit_stake_account' || operation === 'claim_deposit_receipt'
        ? [JITO_STAKE_DEPOSIT_INTERCEPTOR_PROGRAM_ID.toBase58()]
        : []),
    ],
    offchainMinOutputGuard: JITO_OFFCHAIN_MIN_OUTPUT_WARNING,
    preparedSnapshotAt: new Date().toISOString(),
    refreshAtExecution: true,
    ...extra,
  };
}

function enforceMinJitoSolOutput(quote: JitoQuote, minRaw: bigint | undefined): void {
  if (minRaw === undefined) return;
  const expected = BigInt(quote.expectedJitoSolRaw ?? '0');
  if (expected < minRaw) {
    throw new ProtocolError(
      'unauthorized',
      `Jito expected output ${formatRawAmount(expected, JITOSOL_DECIMALS)} JitoSOL is below the requested minimum ${formatRawAmount(minRaw, JITOSOL_DECIMALS)} JitoSOL.`,
    );
  }
}

function enforceMinSolOutput(quote: JitoQuote, minRaw: bigint | undefined): void {
  if (minRaw === undefined) return;
  const expected = BigInt(quote.expectedSolRaw ?? '0');
  if (expected < minRaw) {
    throw new ProtocolError(
      'unauthorized',
      `Jito expected output ${formatRawAmount(expected, 9)} SOL is below the requested minimum ${formatRawAmount(minRaw, 9)} SOL.`,
    );
  }
}

async function requireStakeVoteInJitoPool(connection: Connection, voteAccount: string | undefined): Promise<void> {
  if (!voteAccount) {
    throw new AdapterError(JITO_ADAPTER_ID, 'missing_vote_account', 'Stake account is missing a validator vote account.');
  }
  const snapshot = await getJitoClient().getStakePoolSnapshot(connection, { includeValidators: true });
  if (snapshot.validators && !snapshot.validators.some((validator) => validator.voteAccountAddress === voteAccount)) {
    throw new AdapterError(
      JITO_ADAPTER_ID,
      'validator_not_in_jito_pool',
      `Stake account validator vote account ${voteAccount} is not in the Jito validator list.`,
    );
  }
}

function validateStakeWithdrawalAmount(stake: JitoStakeAccount, amountLamports: bigint, withdrawAll: boolean): void {
  const total = BigInt(stake.lamports);
  if (amountLamports <= 0n) {
    throw new ProtocolError('invalid_request', 'Jito stake-account SOL withdrawal amount must be greater than zero.');
  }
  if (amountLamports > total) {
    throw new ProtocolError('invalid_request', 'Jito stake-account SOL withdrawal amount exceeds the stake account balance.');
  }
  const rentReserve = stake.rentExemptReserve ? BigInt(stake.rentExemptReserve) : undefined;
  if (!withdrawAll && rentReserve !== undefined && total - amountLamports < rentReserve) {
    throw new ProtocolError(
      'invalid_request',
      `Partial Jito stake-account SOL withdrawal must leave the rent-exempt reserve of ${formatRawAmount(rentReserve, 9)} SOL.`,
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

function requireWallet(action: PreparedAction, currentWallet: string): void {
  if (currentWallet !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Jito action belongs to ${action.walletAddress}, but connected wallet is ${currentWallet}.`,
    );
  }
}

function requireStringParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `Jito action ${action.id} is missing ${key}.`);
  }
  return value;
}

function optionalStringParam(action: PreparedAction, key: string): string | undefined {
  const value = action.params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ProtocolError('invalid_request', `Jito action ${action.id} has non-string ${key}.`);
  }
  return value;
}

function readWithdrawMode(action: PreparedAction): JitoWithdrawMode {
  const value = action.params.withdrawMode;
  if (value === undefined) return 'stake_account';
  if (value === 'stake_account' || value === 'reserve_sol') return value;
  throw new ProtocolError('invalid_request', `Jito action ${action.id} has invalid withdrawMode.`);
}
