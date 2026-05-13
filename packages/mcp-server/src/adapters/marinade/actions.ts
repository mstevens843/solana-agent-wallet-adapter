import { PublicKey } from '@solana/web3.js';
import { ProtocolError, type Cluster } from '@solana-agent-wallet-adapter/core';

import { formatRawAmount, parseDecimalAmount } from '../../amounts.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import { WSOL_MINT } from '../../config.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
  DAppAdapterContext,
} from '../types.js';
import { AdapterError } from '../types.js';
import {
  getMarinadeClient,
  type MarinadeOperation,
  type MarinadeQuote,
  type MarinadeUnstakeTicket,
} from './client.js';
import {
  MARINADE_ADAPTER_ID,
  MARINADE_APPROVAL_BOUNDARY,
  MARINADE_DEFAULT_SLIPPAGE_BPS,
  MARINADE_MIN_MSOL_LAMPORTS,
  MARINADE_MIN_SOL_LAMPORTS,
  MARINADE_PROGRAM_ID,
  MSOL_DECIMALS,
  MSOL_MINT,
  SOL_DECIMALS,
  shortAddress,
} from './constants.js';
import {
  assertJupiterMinOutput,
  executeMarinadeJupiterOrder,
  fetchMarinadeInstantUnstakeOrder,
  quoteFromJupiterOrder,
  txidFromJupiterExecution,
} from './jupiter.js';

export interface MarinadeLiquidStakeInput {
  solAmount: string;
  minMsolAmount?: string;
  dueAt?: string;
  note?: string;
}

export interface MarinadeLiquidUnstakeInput {
  msolAmount: string;
  minSolAmount?: string;
  slippageBps?: number;
  dueAt?: string;
  note?: string;
}

export interface MarinadeDelayedUnstakeInput {
  msolAmount: string;
  minSolAmount?: string;
  dueAt?: string;
  note?: string;
}

export interface MarinadeClaimDelayedUnstakeInput {
  ticketAccount: string;
  expectedClaimableAt?: string;
  dueAt?: string;
  note?: string;
}

export const marinadeLiquidStakeAction: AdapterAction<MarinadeLiquidStakeInput> = {
  id: 'liquid_stake',
  kind: 'marinade_liquid_stake',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const amountRaw = parseSolLamports(input.solAmount, 'Marinade SOL stake amount');
    if (amountRaw < MARINADE_MIN_SOL_LAMPORTS) {
      throw new ProtocolError('invalid_request', 'Marinade liquid stake amount must be at least 0.001 SOL.');
    }
    const walletAddress = await ctx.backend.getAddress();
    const minRaw = input.minMsolAmount
      ? parseMsolLamports(input.minMsolAmount, 'Minimum mSOL output')
      : undefined;
    const quote = await getMarinadeClient().getQuote(ctx.connection, {
      operation: 'liquid_stake',
      walletAddress,
      inputAmountRaw: amountRaw,
      minOutputAmountRaw: minRaw,
      config: ctx.config,
    });
    enforceQuoteMinOutput('liquid_stake', quote, minRaw);
    const summary = `Stake ${input.solAmount} SOL for mSOL on Marinade`;
    const params = marinadeParams({
      action: 'liquid_stake',
      operation: 'liquid_stake',
      walletAddress,
      inputMint: WSOL_MINT,
      outputMint: MSOL_MINT,
      inputSymbol: 'SOL',
      outputSymbol: 'mSOL',
      inputDecimals: SOL_DECIMALS,
      outputDecimals: MSOL_DECIMALS,
      solAmount: input.solAmount,
      solAmountRaw: amountRaw.toString(),
      minMsolAmount: input.minMsolAmount,
      ...(minRaw !== undefined && { minMsolAmountRaw: minRaw.toString() }),
      quoteSnapshot: quoteForStorage(quote),
      programIds: [MARINADE_PROGRAM_ID],
    });
    return prepareResult('marinade_liquid_stake', walletAddress, ctx.config.cluster, summary, params, input);
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    await requireWallet(action, ctx);
    const amountRaw = BigInt(requireStringParam(action, 'solAmountRaw'));
    const minRaw = optionalBigintParam(action, 'minMsolAmountRaw');
    const quote = await getMarinadeClient().getQuote(ctx.connection, {
      operation: 'liquid_stake',
      walletAddress: action.walletAddress,
      inputAmountRaw: amountRaw,
      minOutputAmountRaw: minRaw,
      config: ctx.config,
    });
    enforceQuoteMinOutput('liquid_stake', quote, minRaw);
    const built = await getMarinadeClient().buildLiquidStakeTransaction(ctx.connection, {
      walletAddress: action.walletAddress,
      amountRaw,
      minOutputAmountRaw: minRaw,
      config: ctx.config,
    });
    const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: stripUndefined({
        operation: 'liquid_stake',
        quote,
        programIds: built.programIds,
        ...built.preview,
      }),
    };
  },
};

export const marinadeLiquidUnstakeAction: AdapterAction<MarinadeLiquidUnstakeInput> = {
  id: 'liquid_unstake',
  kind: 'marinade_liquid_unstake',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const amountRaw = parseMsolLamports(input.msolAmount, 'Marinade mSOL instant unstake amount');
    if (amountRaw < MARINADE_MIN_MSOL_LAMPORTS) {
      throw new ProtocolError('invalid_request', 'Marinade instant unstake amount must be at least 0.001 mSOL.');
    }
    const walletAddress = await ctx.backend.getAddress();
    const minRaw = input.minSolAmount
      ? parseSolLamports(input.minSolAmount, 'Minimum SOL output')
      : undefined;
    const slippageBps = resolveSlippageBps(input.slippageBps, ctx.config.mainnet.maxSlippageBps);
    const order = await fetchMarinadeInstantUnstakeOrder({
      config: ctx.config,
      taker: walletAddress,
      msolAmountRaw: amountRaw,
      slippageBps,
    });
    assertJupiterMinOutput(order, minRaw);
    const quote = quoteFromJupiterOrder(order);
    const summary = `Instant unstake ${input.msolAmount} mSOL to SOL through Jupiter`;
    const params = marinadeParams({
      action: 'liquid_unstake',
      operation: 'liquid_unstake',
      connectorActionSource: 'jupiter',
      route: 'jupiter',
      walletAddress,
      inputMint: MSOL_MINT,
      outputMint: WSOL_MINT,
      inputSymbol: 'mSOL',
      outputSymbol: 'SOL',
      inputDecimals: MSOL_DECIMALS,
      outputDecimals: SOL_DECIMALS,
      msolAmount: input.msolAmount,
      msolAmountRaw: amountRaw.toString(),
      minSolAmount: input.minSolAmount,
      ...(minRaw !== undefined && { minSolAmountRaw: minRaw.toString() }),
      slippageBps,
      jupiterRequestId: order.requestId,
      ...(order.lastValidBlockHeight !== undefined && { jupiterLastValidBlockHeight: order.lastValidBlockHeight }),
      quoteSnapshot: quoteForStorage(quote),
      programIds: ['Jupiter Ultra API'],
    });
    return prepareResult('marinade_liquid_unstake', walletAddress, ctx.config.cluster, summary, params, input);
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    await requireWallet(action, ctx);
    const amountRaw = BigInt(requireStringParam(action, 'msolAmountRaw'));
    const minRaw = optionalBigintParam(action, 'minSolAmountRaw');
    const slippageBps = optionalNumberParam(action, 'slippageBps') ?? MARINADE_DEFAULT_SLIPPAGE_BPS;
    const order = await fetchMarinadeInstantUnstakeOrder({
      config: ctx.config,
      taker: action.walletAddress,
      msolAmountRaw: amountRaw,
      slippageBps,
    });
    assertJupiterMinOutput(order, minRaw);
    const signedTransaction = await ctx.signTransaction(order.transactionBase64, action.summary);
    const executed = await executeMarinadeJupiterOrder({
      config: ctx.config,
      signedTransaction,
      requestId: order.requestId,
      lastValidBlockHeight: order.lastValidBlockHeight,
    });
    const txid = txidFromJupiterExecution(executed);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: stripUndefined({
        operation: 'liquid_unstake',
        route: 'jupiter',
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        inputAmountRaw: order.inputAmountRaw,
        outputAmountRaw: order.outputAmountRaw,
        outputAmount: order.outputAmountRaw
          ? formatRawAmount(BigInt(order.outputAmountRaw), SOL_DECIMALS)
          : undefined,
        minOutputAmountRaw: order.minOutputAmountRaw,
        jupiterLastValidBlockHeight: order.lastValidBlockHeight,
        jupiterStatus: executed.status,
      }),
    };
  },
};

export const marinadeDelayedUnstakeAction: AdapterAction<MarinadeDelayedUnstakeInput> = {
  id: 'delayed_unstake',
  kind: 'marinade_delayed_unstake',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const amountRaw = parseMsolLamports(input.msolAmount, 'Marinade delayed unstake amount');
    if (amountRaw < MARINADE_MIN_MSOL_LAMPORTS) {
      throw new ProtocolError('invalid_request', 'Marinade delayed unstake amount must be at least 0.001 mSOL.');
    }
    const walletAddress = await ctx.backend.getAddress();
    const minRaw = input.minSolAmount
      ? parseSolLamports(input.minSolAmount, 'Minimum delayed unstake SOL output')
      : undefined;
    const quote = await getMarinadeClient().getQuote(ctx.connection, {
      operation: 'delayed_unstake',
      walletAddress,
      inputAmountRaw: amountRaw,
      minOutputAmountRaw: minRaw,
      config: ctx.config,
    });
    enforceQuoteMinOutput('delayed_unstake', quote, minRaw);
    const summary = `Request delayed unstake for ${input.msolAmount} mSOL on Marinade`;
    const params = marinadeParams({
      action: 'delayed_unstake',
      operation: 'delayed_unstake',
      walletAddress,
      inputMint: MSOL_MINT,
      outputMint: WSOL_MINT,
      inputSymbol: 'mSOL',
      outputSymbol: 'SOL',
      inputDecimals: MSOL_DECIMALS,
      outputDecimals: SOL_DECIMALS,
      msolAmount: input.msolAmount,
      msolAmountRaw: amountRaw.toString(),
      minSolAmount: input.minSolAmount,
      ...(minRaw !== undefined && { minSolAmountRaw: minRaw.toString() }),
      quoteSnapshot: quoteForStorage(quote),
      programIds: [MARINADE_PROGRAM_ID],
    });
    return prepareResult('marinade_delayed_unstake', walletAddress, ctx.config.cluster, summary, params, input);
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    await requireWallet(action, ctx);
    const amountRaw = BigInt(requireStringParam(action, 'msolAmountRaw'));
    const minRaw = optionalBigintParam(action, 'minSolAmountRaw');
    const quote = await getMarinadeClient().getQuote(ctx.connection, {
      operation: 'delayed_unstake',
      walletAddress: action.walletAddress,
      inputAmountRaw: amountRaw,
      minOutputAmountRaw: minRaw,
      config: ctx.config,
    });
    enforceQuoteMinOutput('delayed_unstake', quote, minRaw);
    const built = await getMarinadeClient().buildDelayedUnstakeTransaction(ctx.connection, {
      walletAddress: action.walletAddress,
      amountRaw,
      minOutputAmountRaw: minRaw,
      config: ctx.config,
    });
    const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: stripUndefined({
        operation: 'delayed_unstake',
        quote,
        programIds: built.programIds,
        ...built.preview,
      }),
    };
  },
};

export const marinadeClaimDelayedUnstakeAction: AdapterAction<MarinadeClaimDelayedUnstakeInput> = {
  id: 'claim_delayed_unstake',
  kind: 'marinade_claim_delayed_unstake',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const ticketAccount = normalizePublicKey(input.ticketAccount, 'ticketAccount');
    const walletAddress = await ctx.backend.getAddress();
    const ticket = await findClaimableTicket(ctx, walletAddress, ticketAccount, input.expectedClaimableAt);
    const summary = `Claim Marinade delayed unstake ticket ${shortAddress(ticketAccount)}`;
    const params = marinadeParams({
      action: 'claim_delayed_unstake',
      operation: 'claim_delayed_unstake',
      walletAddress,
      ticketAccount,
      expectedClaimableAt: input.expectedClaimableAt ?? ticket.claimableAt,
      ticketSnapshot: ticketForStorage(ticket),
      programIds: [MARINADE_PROGRAM_ID],
    });
    return prepareResult('marinade_claim_delayed_unstake', walletAddress, ctx.config.cluster, summary, params, input);
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    await requireWallet(action, ctx);
    const ticketAccount = requireStringParam(action, 'ticketAccount');
    const ticket = await findClaimableTicket(
      ctx,
      action.walletAddress,
      ticketAccount,
      optionalStringParam(action, 'expectedClaimableAt'),
    );
    const built = await getMarinadeClient().buildClaimDelayedUnstakeTransaction(ctx.connection, {
      walletAddress: action.walletAddress,
      ticketAccount,
      config: ctx.config,
    });
    const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: stripUndefined({
        operation: 'claim_delayed_unstake',
        ticket: ticketForStorage(ticket),
        programIds: built.programIds,
        ...built.preview,
      }),
    };
  },
};

function prepareResult(
  kind: AdapterAction['kind'],
  walletAddress: string,
  cluster: Cluster,
  summary: string,
  params: Record<string, unknown>,
  input: { dueAt?: string; note?: string },
): AdapterPrepareResult {
  return {
    addInput: {
      kind,
      walletAddress,
      cluster,
      summary,
      params,
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    },
    preview: params,
  };
}

function marinadeParams(value: Record<string, unknown>): Record<string, unknown> {
  return stripUndefined({
    adapter: MARINADE_ADAPTER_ID,
    connectorId: MARINADE_ADAPTER_ID,
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    connectorApprovalBoundary: MARINADE_APPROVAL_BOUNDARY,
    refreshAtExecution: true,
    preparedSnapshotAt: new Date().toISOString(),
    ...value,
  });
}

async function requireWallet(action: PreparedAction, ctx: DAppAdapterContext): Promise<void> {
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Marinade action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
}

async function findClaimableTicket(
  ctx: DAppAdapterContext,
  walletAddress: string,
  ticketAccount: string,
  expectedClaimableAt?: string,
): Promise<MarinadeUnstakeTicket> {
  const tickets = await getMarinadeClient().getUnstakeTickets(ctx.connection, walletAddress);
  const ticket = tickets.find((entry) => safeNormalizePublicKey(entry.ticketAccount) === ticketAccount);
  if (!ticket) {
    throw new AdapterError(MARINADE_ADAPTER_ID, 'ticket_not_found', `Marinade unstake ticket ${ticketAccount} was not found.`);
  }
  if (ticket.status !== 'claimable') {
    throw new AdapterError(
      MARINADE_ADAPTER_ID,
      'ticket_not_claimable',
      ticket.reason ?? `Marinade unstake ticket ${ticketAccount} is not claimable yet.`,
    );
  }
  if (expectedClaimableAt && ticket.claimableAt && ticket.claimableAt !== expectedClaimableAt) {
    throw new AdapterError(
      MARINADE_ADAPTER_ID,
      'ticket_claimable_time_changed',
      `Marinade unstake ticket ${ticketAccount} claimable time changed from ${expectedClaimableAt} to ${ticket.claimableAt}.`,
    );
  }
  return ticket;
}

function enforceQuoteMinOutput(
  operation: MarinadeOperation,
  quote: MarinadeQuote,
  minOutputAmountRaw: bigint | undefined,
): void {
  if (minOutputAmountRaw === undefined) {
    return;
  }
  const raw = quote.outputAmountRaw ?? quote.minOutputAmountRaw;
  if (!raw) {
    throw new AdapterError(
      MARINADE_ADAPTER_ID,
      'quote_missing_output',
      `Marinade ${operation} quote did not include output amount data to validate.`,
    );
  }
  if (BigInt(raw) < minOutputAmountRaw) {
    throw new AdapterError(
      MARINADE_ADAPTER_ID,
      'output_below_minimum',
      `Marinade ${operation} quote output ${raw} is below requested minimum ${minOutputAmountRaw.toString()}.`,
    );
  }
}

function parseSolLamports(amount: string, label: string): bigint {
  return parseDecimalAmount(amount, SOL_DECIMALS, label);
}

function parseMsolLamports(amount: string, label: string): bigint {
  return parseDecimalAmount(amount, MSOL_DECIMALS, label);
}

function resolveSlippageBps(value: number | undefined, configMax: number): number {
  const selected = value ?? Math.min(configMax, MARINADE_DEFAULT_SLIPPAGE_BPS);
  if (!Number.isInteger(selected) || selected < 0) {
    throw new AdapterError(MARINADE_ADAPTER_ID, 'invalid_request', 'Marinade slippageBps must be a non-negative integer.');
  }
  if (selected > configMax) {
    throw new AdapterError(
      MARINADE_ADAPTER_ID,
      'slippage_above_cap',
      `Marinade slippageBps ${selected} exceeds configured maxSlippageBps ${configMax}.`,
    );
  }
  return selected;
}

function normalizePublicKey(value: string, label: string): string {
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    throw new AdapterError(MARINADE_ADAPTER_ID, 'invalid_request', `${label} must be a valid Solana public key.`);
  }
}

function safeNormalizePublicKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    return undefined;
  }
}

function requireStringParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `Marinade action ${action.id} is missing ${key}.`);
  }
  return value;
}

function optionalBigintParam(action: PreparedAction, key: string): bigint | undefined {
  const value = action.params[key];
  if (typeof value === 'string' && value.length > 0) {
    return BigInt(value);
  }
  return undefined;
}

function optionalNumberParam(action: PreparedAction, key: string): number | undefined {
  const value = action.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalStringParam(action: PreparedAction, key: string): string | undefined {
  const value = action.params[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function quoteForStorage(quote: MarinadeQuote): Record<string, unknown> {
  return stripUndefined({
    operation: quote.operation,
    inputAmount: quote.inputAmount,
    inputAmountRaw: quote.inputAmountRaw,
    outputAmount: quote.outputAmount,
    outputAmountRaw: quote.outputAmountRaw,
    minOutputAmount: quote.minOutputAmount,
    minOutputAmountRaw: quote.minOutputAmountRaw,
    feeBps: quote.feeBps,
    price: quote.price,
    route: quote.route,
    warnings: quote.warnings,
    raw: quote.raw,
  });
}

function ticketForStorage(ticket: MarinadeUnstakeTicket): Record<string, unknown> {
  return stripUndefined({
    ticketAccount: ticket.ticketAccount,
    beneficiary: ticket.beneficiary,
    lamports: ticket.lamports,
    solAmount: ticket.solAmount,
    msolAmount: ticket.msolAmount,
    createdEpoch: ticket.createdEpoch,
    claimableAt: ticket.claimableAt,
    claimableSlot: ticket.claimableSlot,
    status: ticket.status,
    reason: ticket.reason,
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
