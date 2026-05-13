import { PublicKey, type Connection } from '@solana/web3.js';
import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { assertMaxAmount, formatRawAmount, parseDecimalAmount } from '../../amounts.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import {
  DEFAULT_TOKEN_REGISTRY,
  WSOL_MINT,
  getJupiterRecurringPolicy,
  type AgentWalletConfig,
} from '../../config.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
  DAppAdapterContext,
} from '../types.js';
import { AdapterError } from '../types.js';

import { jupiterFetchJson } from './client.js';
import { JUPITER_ADAPTER_ID } from './constants.js';
import {
  getRecurringOrder,
  requireRecurringEnabled,
} from './recurringOrders.js';
import {
  recurringCancelWarnings,
  recurringCreateWarnings,
  recurringPriceOrderWarnings,
} from './recurringSafety.js';

export interface JupiterRecurringCreateTimeOrderInput {
  inputMint: string;
  outputMint: string;
  totalAmount: string;
  numberOfOrders: number;
  intervalSeconds: number;
  startAt?: string;
  minPrice?: string;
  maxPrice?: string;
  maxFeeBps?: number;
  automationWarningAccepted: boolean;
  dueAt?: string;
  note?: string;
}

export interface JupiterRecurringCancelOrderInput {
  orderId: string;
  reason?: string;
  dueAt?: string;
  note?: string;
}

export interface JupiterRecurringPriceOrderManagementInput {
  orderId: string;
  amount: string;
  mint?: string;
  inputOrOutput?: 'In' | 'Out';
  priceOrderDeprecationAccepted: boolean;
  reason?: string;
  dueAt?: string;
  note?: string;
}

interface BuiltRecurringTransaction {
  transactionBase64: string;
  requestId: string;
  orderId?: string;
  raw: Record<string, unknown>;
}

export const recurringCreateTimeOrderAction: AdapterAction<JupiterRecurringCreateTimeOrderInput> = {
  id: 'recurring_create_time_order',
  kind: 'jupiter_recurring_create_time_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    requireRecurringEnabled(ctx.config);
    const walletAddress = await ctx.backend.getAddress();
    const prepared = await prepareCreateTimeOrder(input, ctx, walletAddress);
    const summary = `Create Jupiter Recurring DCA ${input.totalAmount} ${shortMint(input.inputMint)} -> ${shortMint(input.outputMint)} over ${input.numberOfOrders} orders`;
    const params = baseRecurringParams({
      operation: 'create_time_order',
      walletAddress,
      cluster: ctx.config.cluster,
    });
    Object.assign(params, {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      totalAmount: input.totalAmount,
      totalAmountRaw: prepared.totalAmountRaw,
      amountPerCycle: prepared.amountPerCycle,
      amountPerCycleRaw: prepared.amountPerCycleRaw,
      numberOfOrders: input.numberOfOrders,
      intervalSeconds: input.intervalSeconds,
      ...(input.startAt !== undefined && { startAt: input.startAt }),
      ...(prepared.startAtUnix !== null && { startAtUnix: prepared.startAtUnix }),
      ...(input.minPrice !== undefined && { minPrice: input.minPrice }),
      ...(input.maxPrice !== undefined && { maxPrice: input.maxPrice }),
      ...(input.maxFeeBps !== undefined && { maxFeeBps: input.maxFeeBps }),
      feePreview: { jupiterFeeBps: 10, integratorFeesSupported: false },
      requestId: prepared.built.requestId,
      transactionBase64: prepared.built.transactionBase64,
      automationWarningAccepted: true,
      warnings: recurringCreateWarnings({
        hasPriceRange: input.minPrice !== undefined || input.maxPrice !== undefined,
        hasRoundingRemainder: prepared.hasRoundingRemainder,
      }),
      refreshAtExecution: false,
    });
    return preparedActionResult('jupiter_recurring_create_time_order', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    return executeStoredRecurringTransaction(action, ctx);
  },
};

export const recurringCancelOrderAction: AdapterAction<JupiterRecurringCancelOrderInput> = {
  id: 'recurring_cancel_order',
  kind: 'jupiter_recurring_cancel_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    requireRecurringEnabled(ctx.config);
    const walletAddress = await ctx.backend.getAddress();
    if (!input.orderId?.trim()) {
      throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Jupiter Recurring cancel requires orderId.');
    }
    const orderSnapshot = await getRecurringOrder(ctx.config, { walletAddress, orderId: input.orderId });
    const built = await buildRecurringTransaction(ctx.config, '/cancelOrder', {
      order: input.orderId,
      user: walletAddress,
      recurringType: orderSnapshot.recurringType ?? 'time',
    });
    const summary = `Cancel Jupiter Recurring order ${input.orderId}`;
    const params = baseRecurringParams({
      operation: 'cancel_order',
      walletAddress,
      cluster: ctx.config.cluster,
    });
    Object.assign(params, {
      orderId: input.orderId,
      orderSnapshot,
      requestId: built.requestId,
      transactionBase64: built.transactionBase64,
      ...(input.reason !== undefined && { reason: input.reason }),
      warnings: recurringCancelWarnings(),
      refreshAtExecution: false,
    });
    return preparedActionResult('jupiter_recurring_cancel_order', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    return executeStoredRecurringTransaction(action, ctx);
  },
};

export const recurringDepositPriceOrderAction: AdapterAction<JupiterRecurringPriceOrderManagementInput> = {
  id: 'recurring_deposit_price_order',
  kind: 'jupiter_recurring_deposit_price_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const built = await preparePriceManagement(input, ctx, 'deposit_price_order');
    return built;
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    return executeStoredRecurringTransaction(action, ctx);
  },
};

export const recurringWithdrawPriceOrderAction: AdapterAction<JupiterRecurringPriceOrderManagementInput> = {
  id: 'recurring_withdraw_price_order',
  kind: 'jupiter_recurring_withdraw_price_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return preparePriceManagement(input, ctx, 'withdraw_price_order');
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    return executeStoredRecurringTransaction(action, ctx);
  },
};

async function prepareCreateTimeOrder(
  input: JupiterRecurringCreateTimeOrderInput,
  ctx: DAppAdapterContext,
  walletAddress: string,
): Promise<{
  totalAmountRaw: string;
  amountPerCycle: string;
  amountPerCycleRaw: string;
  startAtUnix: number | null;
  hasRoundingRemainder: boolean;
  built: BuiltRecurringTransaction;
}> {
  if (input.automationWarningAccepted !== true) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'Set automationWarningAccepted=true after acknowledging future Jupiter Recurring fills execute outside the Agentic approval inbox.',
    );
  }
  validateMintPair(input.inputMint, input.outputMint);
  const policy = getJupiterRecurringPolicy(ctx.config);
  if (!Number.isInteger(input.numberOfOrders) || input.numberOfOrders <= 0) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'numberOfOrders must be a positive integer.');
  }
  if (input.numberOfOrders > policy.maxOrderCount) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      `numberOfOrders ${input.numberOfOrders} exceeds configured maxOrderCount ${policy.maxOrderCount}.`,
    );
  }
  if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < policy.minIntervalSeconds) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      `intervalSeconds must be at least ${policy.minIntervalSeconds}.`,
    );
  }
  if (policy.maxLifetimeDays !== undefined) {
    const lifetimeDays = (input.numberOfOrders * input.intervalSeconds) / 86_400;
    if (lifetimeDays > policy.maxLifetimeDays) {
      throw new AdapterError(
        JUPITER_ADAPTER_ID,
        'invalid_request',
        `Recurring order lifetime ${lifetimeDays.toFixed(2)} days exceeds configured maxLifetimeDays ${policy.maxLifetimeDays}.`,
      );
    }
  }
  if (input.maxFeeBps !== undefined && input.maxFeeBps < 10) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Jupiter Recurring fee is 10 bps; maxFeeBps must be at least 10.');
  }
  const decimals = await resolveMintDecimals(ctx.config, ctx.connection, input.inputMint);
  const totalRaw = parseDecimalAmount(input.totalAmount, decimals, 'Jupiter Recurring totalAmount');
  const cap = policy.maxDepositAmount?.[input.inputMint] ?? policy.maxDepositAmount?.[shortMint(input.inputMint)];
  if (cap) assertMaxAmount(totalRaw, cap, decimals, 'Jupiter Recurring totalAmount');
  const perCycleRaw = totalRaw / BigInt(input.numberOfOrders);
  if (perCycleRaw <= 0n) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'totalAmount is too small for numberOfOrders; per-cycle raw amount would be zero.',
    );
  }
  const startAtUnix = input.startAt === undefined ? null : parseStartAt(input.startAt);
  const built = await buildRecurringTransaction(ctx.config, '/createOrder', {
    user: walletAddress,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    params: {
      time: {
        inAmount: rawJsonAmount(totalRaw),
        numberOfOrders: input.numberOfOrders,
        interval: input.intervalSeconds,
        minPrice: input.minPrice ?? null,
        maxPrice: input.maxPrice ?? null,
        startAt: startAtUnix,
      },
    },
  });
  return {
    totalAmountRaw: totalRaw.toString(),
    amountPerCycle: formatRawAmount(perCycleRaw, decimals),
    amountPerCycleRaw: perCycleRaw.toString(),
    startAtUnix,
    hasRoundingRemainder: totalRaw % BigInt(input.numberOfOrders) !== 0n,
    built,
  };
}

async function preparePriceManagement(
  input: JupiterRecurringPriceOrderManagementInput,
  ctx: DAppAdapterContext,
  operation: 'deposit_price_order' | 'withdraw_price_order',
): Promise<AdapterPrepareResult> {
  requireRecurringEnabled(ctx.config);
  const walletAddress = await ctx.backend.getAddress();
  if (input.priceOrderDeprecationAccepted !== true) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'Set priceOrderDeprecationAccepted=true to manage a deprecated price-based Jupiter Recurring order.',
    );
  }
  if (!input.orderId?.trim()) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Price-order management requires orderId.');
  }
  const amountRaw = await priceManagementAmountRaw(input, ctx);
  const endpoint = operation === 'deposit_price_order' ? '/priceDeposit' : '/priceWithdraw';
  const body: Record<string, unknown> = {
    order: input.orderId,
    user: walletAddress,
    amount: rawJsonAmount(amountRaw),
  };
  if (operation === 'withdraw_price_order') {
    body.inputOrOutput = input.inputOrOutput ?? 'In';
  }
  const built = await buildRecurringTransaction(ctx.config, endpoint, body);
  const summary = `${operation === 'deposit_price_order' ? 'Deposit into' : 'Withdraw from'} deprecated Jupiter Recurring price order ${input.orderId}`;
  const params = baseRecurringParams({
    operation,
    walletAddress,
    cluster: ctx.config.cluster,
  });
  Object.assign(params, {
    orderId: input.orderId,
    amount: input.amount,
    amountRaw: amountRaw.toString(),
    ...(input.mint !== undefined && { mint: input.mint }),
    ...(input.inputOrOutput !== undefined && { inputOrOutput: input.inputOrOutput }),
    requestId: built.requestId,
    transactionBase64: built.transactionBase64,
    priceOrderDeprecationAccepted: true,
    ...(input.reason !== undefined && { reason: input.reason }),
    warnings: recurringPriceOrderWarnings(),
    refreshAtExecution: false,
  });
  const kind = operation === 'deposit_price_order'
    ? 'jupiter_recurring_deposit_price_order'
    : 'jupiter_recurring_withdraw_price_order';
  return preparedActionResult(kind, walletAddress, ctx, summary, params, input);
}

async function buildRecurringTransaction(
  config: AgentWalletConfig,
  path: '/createOrder' | '/cancelOrder' | '/priceDeposit' | '/priceWithdraw',
  body: Record<string, unknown>,
): Promise<BuiltRecurringTransaction> {
  const response = await jupiterFetchJson(config, 'recurring', path, {
    method: 'POST',
    body,
  });
  const transactionBase64 = optionalString(response, 'transaction') ?? optionalString(response, 'transactionBase64');
  const requestId = optionalString(response, 'requestId');
  if (!transactionBase64 || !requestId) {
    throw new ProtocolError(
      'wallet_unreachable',
      `Jupiter Recurring ${path} response is missing transaction or requestId.`,
    );
  }
  const orderId = optionalString(response, 'order');
  return {
    transactionBase64,
    requestId,
    ...(orderId !== undefined && { orderId }),
    raw: response,
  };
}

async function executeStoredRecurringTransaction(
  action: PreparedAction,
  ctx: DAppAdapterContext,
): Promise<AdapterExecuteResult> {
  requireRecurringEnabled(ctx.config);
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Jupiter Recurring action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
  const transactionBase64 = requireStringParam(action, 'transactionBase64');
  const requestId = requireStringParam(action, 'requestId');
  const signedTransaction = await ctx.signTransaction(transactionBase64, action.summary);
  const body = await jupiterFetchJson(ctx.config, 'recurring', '/execute', {
    method: 'POST',
    body: {
      signedTransaction,
      requestId,
    },
  });
  const status = optionalString(body, 'status')?.toLowerCase();
  if (status === 'failed') {
    throw new ProtocolError(
      'wallet_unreachable',
      `Jupiter Recurring execute failed${typeof body.error === 'string' ? `: ${body.error}` : '.'}`,
    );
  }
  const txid = optionalString(body, 'signature') ?? optionalString(body, 'txid');
  if (!txid) {
    throw new ProtocolError('wallet_unreachable', 'Jupiter Recurring execute response is missing signature.');
  }
  return {
    txid,
    signedAt: new Date().toISOString(),
    preview: {
      walletAddress,
      requestId,
      orderId: optionalString(body, 'order') ?? action.params.orderId,
      status: body.status,
      raw: body,
    },
  };
}

function baseRecurringParams(input: {
  operation: string;
  walletAddress: string;
  cluster: string;
}): Record<string, unknown> {
  return {
    adapter: JUPITER_ADAPTER_ID,
    connectorId: JUPITER_ADAPTER_ID,
    product: 'recurring',
    operation: input.operation,
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    walletAddress: input.walletAddress,
    cluster: input.cluster,
    preparedSnapshotAt: new Date().toISOString(),
  };
}

function preparedActionResult(
  kind: PreparedAction['kind'],
  walletAddress: string,
  ctx: DAppAdapterContext,
  summary: string,
  params: Record<string, unknown>,
  input: { dueAt?: string; note?: string },
): AdapterPrepareResult {
  return {
    addInput: {
      kind,
      walletAddress,
      cluster: ctx.config.cluster,
      summary,
      params,
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    },
    preview: params,
  };
}

async function priceManagementAmountRaw(
  input: JupiterRecurringPriceOrderManagementInput,
  ctx: DAppAdapterContext,
): Promise<bigint> {
  if (input.mint) {
    const decimals = await resolveMintDecimals(ctx.config, ctx.connection, input.mint);
    return parseDecimalAmount(input.amount, decimals, 'Jupiter Recurring price-order amount');
  }
  if (!/^\d+$/.test(input.amount.trim())) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'Deprecated price-order management requires an integer raw amount unless mint is supplied for decimal conversion.',
    );
  }
  const amount = BigInt(input.amount);
  if (amount <= 0n) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Jupiter Recurring price-order amount must be greater than zero.');
  }
  return amount;
}

async function resolveMintDecimals(
  config: AgentWalletConfig,
  connection: Connection,
  mintText: string,
): Promise<number> {
  if (mintText === WSOL_MINT) return 9;
  const known = [...config.tokens, ...DEFAULT_TOKEN_REGISTRY].find(
    (entry) => entry.mint === mintText || entry.symbol.toLowerCase() === mintText.toLowerCase(),
  );
  if (known) return known.decimals;
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintText);
  } catch {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `Invalid token mint ${mintText}.`);
  }
  const account = await connection.getParsedAccountInfo(mint, 'confirmed').catch(() => null);
  const parsedData = account?.value?.data;
  const parsed = parsedData && typeof parsedData === 'object' && 'parsed' in parsedData
    ? parsedData.parsed as { info?: { decimals?: unknown } }
    : undefined;
  if (typeof parsed?.info?.decimals === 'number' && Number.isInteger(parsed.info.decimals) && parsed.info.decimals >= 0) {
    return parsed.info.decimals;
  }
  throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `Could not read decimals for token mint ${mintText}.`);
}

function validateMintPair(inputMint: string, outputMint: string): void {
  try {
    new PublicKey(inputMint);
    new PublicKey(outputMint);
  } catch {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'inputMint and outputMint must be valid mint addresses.');
  }
  if (inputMint === outputMint) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'inputMint and outputMint must be different.');
  }
}

function parseStartAt(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'startAt must be a valid ISO timestamp.');
  }
  if (parsed < Date.now()) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'startAt must be in the future.');
  }
  return Math.floor(parsed / 1000);
}

function rawJsonAmount(value: bigint): string | number {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function requireStringParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `Jupiter Recurring action is missing ${key}.`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function shortMint(mint: string): string {
  return mint.length <= 8 ? mint : `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}
