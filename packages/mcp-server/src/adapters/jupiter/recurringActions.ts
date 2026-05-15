import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { assertMaxAmount, formatRawAmount, parseDecimalAmount } from '../../amounts.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import {
  WSOL_MINT,
  getJupiterRecurringPolicy,
  type AgentWalletConfig,
  type ResolvedJupiterRecurringPolicy,
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
import { getRecurringOrder, requireRecurringEnabled, type RecurringOrderSnapshot } from './recurringOrders.js';
import {
  recurringCancelWarnings,
  recurringCreateWarnings,
  recurringPriceOrderWarnings,
} from './recurringSafety.js';

const JUPITER_RECURRING_PRODUCT = 'recurring';
const JUPITER_RECURRING_FEE_BPS = 10;

export interface JupiterRecurringCreateTimeOrderInput {
  inputMint: string;
  outputMint: string;
  inputMintDecimals?: number;
  /** Human amount. Requires known input-mint decimals in config. */
  totalAmount?: string;
  /** Raw integer amount in input token base units. Preferred for arbitrary mints. */
  totalAmountRaw?: string;
  numberOfOrders: number;
  intervalSeconds: number;
  startAt?: string;
  minPrice?: string;
  maxPrice?: string;
  maxFeeBps?: number;
  automationWarningAccepted?: boolean;
  dueAt?: string;
  note?: string;
}

export interface JupiterRecurringCancelOrderInput {
  orderId: string;
  reason?: string;
  dueAt?: string;
  note?: string;
}

export interface JupiterRecurringPriceOrderInput {
  orderId: string;
  /** Deprecated raw amount alias kept for tool compatibility. */
  amount?: string;
  amountRaw?: string;
  inputOrOutput?: 'In' | 'Out';
  priceOrderDeprecationAccepted?: boolean;
  dueAt?: string;
  note?: string;
}

export interface JupiterRecurringQuoteInput {
  inputMint: string;
  outputMint: string;
  inputMintDecimals?: number;
  totalAmount?: string;
  totalAmountRaw?: string;
  numberOfOrders: number;
  intervalSeconds: number;
  startAt?: string;
  minPrice?: string;
  maxPrice?: string;
}

interface RecurringAmountResolution {
  amountRaw: string;
  amount?: string;
  decimals?: number;
}

interface RecurringTransactionBuild {
  requestId: string;
  transactionBase64: string;
  raw: Record<string, unknown>;
}

export async function quoteRecurringTimeOrder(
  config: AgentWalletConfig,
  input: JupiterRecurringQuoteInput,
): Promise<Record<string, unknown>> {
  requireRecurringEnabled(config);
  const policy = getJupiterRecurringPolicy(config);
  validateTimeOrderInput(input, policy, false);
  const amount = recurringAmount(config, input.inputMint, input.totalAmount, input.totalAmountRaw, 'Jupiter Recurring total amount', input.inputMintDecimals);
  enforceRecurringAmountPolicy(config, policy, input.inputMint, amount);
  const perCycle = perCycleAmounts(amount.amountRaw, input.numberOfOrders, amount.decimals);
  return {
    product: JUPITER_RECURRING_PRODUCT,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    totalAmountRaw: amount.amountRaw,
    ...(amount.amount !== undefined ? { totalAmount: amount.amount } : {}),
    numberOfOrders: input.numberOfOrders,
    intervalSeconds: input.intervalSeconds,
    startAt: normalizeStartAt(input.startAt),
    ...(input.minPrice !== undefined ? { minPrice: input.minPrice } : {}),
    ...(input.maxPrice !== undefined ? { maxPrice: input.maxPrice } : {}),
    feeBps: JUPITER_RECURRING_FEE_BPS,
    amountPerCycleRaw: perCycle.amountPerCycleRaw,
    ...(perCycle.amountPerCycle !== undefined ? { amountPerCycle: perCycle.amountPerCycle } : {}),
    ...(perCycle.remainderRaw !== undefined ? { remainderRaw: perCycle.remainderRaw } : {}),
    warnings: recurringCreateWarnings({
      hasPriceRange: input.minPrice !== undefined || input.maxPrice !== undefined,
      hasRoundingRemainder: perCycle.remainderRaw !== undefined,
    }),
  };
}

export const createTimeOrderAction: AdapterAction<JupiterRecurringCreateTimeOrderInput> = {
  id: 'recurring_create_time_order',
  kind: 'jupiter_recurring_create_time_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    requireRecurringEnabled(ctx.config);
    const walletAddress = await ctx.backend.getAddress();
    const policy = getJupiterRecurringPolicy(ctx.config);
    validateTimeOrderInput(input, policy, true);
    const amount = recurringAmount(ctx.config, input.inputMint, input.totalAmount, input.totalAmountRaw, 'Jupiter Recurring total amount', input.inputMintDecimals);
    enforceRecurringAmountPolicy(ctx.config, policy, input.inputMint, amount);
    enforceFeeCap(input.maxFeeBps);
    const createOrderParams = buildCreateTimeOrderParams(walletAddress, input, amount);
    const built = await buildRecurringTransaction(ctx.config, '/createOrder', createOrderParams);
    const perCycle = perCycleAmounts(amount.amountRaw, input.numberOfOrders, amount.decimals);
    const params: Record<string, unknown> = baseRecurringParams('create_time_order', walletAddress, ctx.config.cluster);
    Object.assign(params, {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      totalAmountRaw: amount.amountRaw,
      ...(amount.amount !== undefined ? { totalAmount: amount.amount } : {}),
      numberOfOrders: input.numberOfOrders,
      intervalSeconds: input.intervalSeconds,
      startAt: normalizeStartAt(input.startAt),
      startAtUnix: startAtUnixOrNull(input.startAt),
      ...(input.minPrice !== undefined ? { minPrice: input.minPrice } : {}),
      ...(input.maxPrice !== undefined ? { maxPrice: input.maxPrice } : {}),
      feeBps: JUPITER_RECURRING_FEE_BPS,
      amountPerCycleRaw: perCycle.amountPerCycleRaw,
      ...(perCycle.amountPerCycle !== undefined ? { amountPerCycle: perCycle.amountPerCycle } : {}),
      ...(perCycle.remainderRaw !== undefined ? { remainderRaw: perCycle.remainderRaw } : {}),
      requestId: built.requestId,
      transactionBase64: built.transactionBase64,
      createOrderParams,
      automationWarningAccepted: true,
      refreshAtExecution: true,
      warnings: recurringCreateWarnings({
        hasPriceRange: input.minPrice !== undefined || input.maxPrice !== undefined,
        hasRoundingRemainder: perCycle.remainderRaw !== undefined,
      }),
      rawCreateOrderResponse: built.raw,
    });
    return preparedActionResult(
      'jupiter_recurring_create_time_order',
      walletAddress,
      ctx,
      describeTimeOrder(input, amount),
      params,
      input,
    );
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireRecurringEnabled(ctx.config);
    const walletAddress = await assertOwnership(action, ctx);
    const createOrderParams = requireRecordParam(action, 'createOrderParams');
    const built = await buildRecurringTransaction(ctx.config, '/createOrder', {
      ...createOrderParams,
      user: walletAddress,
    });
    const signedTransaction = await ctx.signTransaction(built.transactionBase64, action.summary);
    const body = await executeRecurringTransaction(ctx.config, built.requestId, signedTransaction);
    return executeResult(body, {
      operation: 'create_time_order',
      walletAddress,
      requestId: built.requestId,
      orderId: optionalString(body, 'order'),
    });
  },
};

export const cancelRecurringOrderAction: AdapterAction<JupiterRecurringCancelOrderInput> = {
  id: 'recurring_cancel_order',
  kind: 'jupiter_recurring_cancel_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    requireRecurringEnabled(ctx.config);
    validateOrderId(input.orderId);
    const walletAddress = await ctx.backend.getAddress();
    const orderSnapshot = await tryReadRecurringOrder(ctx.config, walletAddress, input.orderId, 'time');
    const cancelParams = buildCancelOrderParams(walletAddress, input.orderId, 'time');
    const built = await buildRecurringTransaction(ctx.config, '/cancelOrder', cancelParams);
    const params: Record<string, unknown> = baseRecurringParams('cancel_order', walletAddress, ctx.config.cluster);
    Object.assign(params, {
      orderId: input.orderId,
      recurringType: 'time',
      requestId: built.requestId,
      transactionBase64: built.transactionBase64,
      cancelParams,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(orderSnapshot !== undefined ? { orderSnapshot } : {}),
      refreshAtExecution: true,
      warnings: recurringCancelWarnings(),
      rawCancelOrderResponse: built.raw,
    });
    return preparedActionResult(
      'jupiter_recurring_cancel_order',
      walletAddress,
      ctx,
      `Cancel Jupiter Recurring order ${input.orderId}`,
      params,
      input,
    );
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireRecurringEnabled(ctx.config);
    const walletAddress = await assertOwnership(action, ctx);
    const orderId = requireStringParam(action, 'orderId');
    const cancelParams = buildCancelOrderParams(walletAddress, orderId, 'time');
    const built = await buildRecurringTransaction(ctx.config, '/cancelOrder', cancelParams);
    const signedTransaction = await ctx.signTransaction(built.transactionBase64, action.summary);
    const body = await executeRecurringTransaction(ctx.config, built.requestId, signedTransaction);
    return executeResult(body, {
      operation: 'cancel_order',
      walletAddress,
      orderId,
      requestId: built.requestId,
    });
  },
};

export const depositPriceOrderAction: AdapterAction<JupiterRecurringPriceOrderInput> = {
  id: 'recurring_deposit_price_order',
  kind: 'jupiter_recurring_deposit_price_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return preparePriceOrderManagement(input, ctx, 'deposit');
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    return executePriceOrderManagement(action, ctx, 'deposit');
  },
};

export const withdrawPriceOrderAction: AdapterAction<JupiterRecurringPriceOrderInput> = {
  id: 'recurring_withdraw_price_order',
  kind: 'jupiter_recurring_withdraw_price_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return preparePriceOrderManagement(input, ctx, 'withdraw');
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    return executePriceOrderManagement(action, ctx, 'withdraw');
  },
};

async function preparePriceOrderManagement(
  input: JupiterRecurringPriceOrderInput,
  ctx: DAppAdapterContext,
  operation: 'deposit' | 'withdraw',
): Promise<AdapterPrepareResult> {
  requireRecurringEnabled(ctx.config);
  const policy = getJupiterRecurringPolicy(ctx.config);
  enforceDeprecatedPriceOrderAccepted(input, policy);
  validateOrderId(input.orderId);
  const amountRaw = priceOrderAmountRaw(input);
  const walletAddress = await ctx.backend.getAddress();
  const orderSnapshot = await tryReadRecurringOrder(ctx.config, walletAddress, input.orderId, 'price');
  const requestParams = buildPriceOrderParams(walletAddress, input.orderId, operation, amountRaw, input.inputOrOutput);
  const built = await buildRecurringTransaction(ctx.config, priceOrderPath(operation), requestParams);
  const params: Record<string, unknown> = baseRecurringParams(`${operation}_price_order`, walletAddress, ctx.config.cluster);
  Object.assign(params, {
    orderId: input.orderId,
    recurringType: 'price',
    amountRaw,
    ...(input.inputOrOutput !== undefined ? { inputOrOutput: input.inputOrOutput } : {}),
    priceOrderDeprecationAccepted: true,
    requestId: built.requestId,
    transactionBase64: built.transactionBase64,
    requestParams,
    ...(orderSnapshot !== undefined ? { orderSnapshot } : {}),
    refreshAtExecution: true,
    warnings: recurringPriceOrderWarnings(),
    rawPriceOrderResponse: built.raw,
  });
  return preparedActionResult(
    operation === 'deposit'
      ? 'jupiter_recurring_deposit_price_order'
      : 'jupiter_recurring_withdraw_price_order',
    walletAddress,
    ctx,
    `${operation === 'deposit' ? 'Deposit into' : 'Withdraw from'} deprecated Jupiter Recurring price order ${input.orderId}`,
    params,
    input,
  );
}

async function executePriceOrderManagement(
  action: PreparedAction,
  ctx: DAppAdapterContext,
  operation: 'deposit' | 'withdraw',
): Promise<AdapterExecuteResult> {
  requireRecurringEnabled(ctx.config);
  const policy = getJupiterRecurringPolicy(ctx.config);
  if (!policy.allowDeprecatedPriceOrders) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'unsupported_method',
      'Deprecated Jupiter Recurring price-order management is disabled by policy.',
    );
  }
  const walletAddress = await assertOwnership(action, ctx);
  const orderId = requireStringParam(action, 'orderId');
  const amountRaw = requireStringParam(action, 'amountRaw');
  const inputOrOutput = action.params.inputOrOutput === 'Out' ? 'Out' : 'In';
  const requestParams = buildPriceOrderParams(walletAddress, orderId, operation, amountRaw, inputOrOutput);
  const built = await buildRecurringTransaction(ctx.config, priceOrderPath(operation), requestParams);
  const signedTransaction = await ctx.signTransaction(built.transactionBase64, action.summary);
  const body = await executeRecurringTransaction(ctx.config, built.requestId, signedTransaction);
  return executeResult(body, {
    operation: `${operation}_price_order`,
    walletAddress,
    orderId,
    requestId: built.requestId,
  });
}

function validateTimeOrderInput(
  input: JupiterRecurringQuoteInput,
  policy: ResolvedJupiterRecurringPolicy,
  requireWarningAcceptance: boolean,
): void {
  if (!input.inputMint?.trim() || !input.outputMint?.trim()) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Jupiter Recurring time order requires inputMint and outputMint.');
  }
  if (input.inputMint === input.outputMint) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Jupiter Recurring inputMint and outputMint must differ.');
  }
  if (!input.totalAmount?.trim() && !input.totalAmountRaw?.trim()) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Jupiter Recurring time order requires totalAmountRaw or totalAmount.');
  }
  if (!Number.isInteger(input.numberOfOrders) || input.numberOfOrders <= 0) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'numberOfOrders must be a positive integer.');
  }
  if (input.numberOfOrders > policy.maxOrderCount) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      `numberOfOrders ${input.numberOfOrders} exceeds configured Jupiter Recurring maxOrderCount ${policy.maxOrderCount}.`,
    );
  }
  if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds <= 0) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'intervalSeconds must be a positive integer.');
  }
  if (input.intervalSeconds < policy.minIntervalSeconds) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      `intervalSeconds ${input.intervalSeconds} is below configured Jupiter Recurring minimum ${policy.minIntervalSeconds}.`,
    );
  }
  if (policy.maxLifetimeDays !== undefined) {
    const lifetimeDays = (input.numberOfOrders * input.intervalSeconds) / 86_400;
    if (lifetimeDays > policy.maxLifetimeDays) {
      throw new AdapterError(
        JUPITER_ADAPTER_ID,
        'invalid_request',
        `Jupiter Recurring lifetime ${lifetimeDays.toFixed(2)} days exceeds configured maxLifetimeDays ${policy.maxLifetimeDays}.`,
      );
    }
  }
  if (input.startAt !== undefined) normalizeStartAt(input.startAt);
  validatePriceBound(input.minPrice, 'minPrice');
  validatePriceBound(input.maxPrice, 'maxPrice');
  if (input.minPrice !== undefined && input.maxPrice !== undefined && Number(input.minPrice) > Number(input.maxPrice)) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'minPrice must be less than or equal to maxPrice.');
  }
  if (requireWarningAcceptance && (input as JupiterRecurringCreateTimeOrderInput).automationWarningAccepted !== true) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'Set automationWarningAccepted=true to acknowledge future Jupiter Recurring fills run through Jupiter automation without returning to the Agentic approval inbox.',
    );
  }
}

function recurringAmount(
  config: AgentWalletConfig,
  mint: string,
  amount: string | undefined,
  amountRaw: string | undefined,
  label: string,
  decimalsHint?: number,
): RecurringAmountResolution {
  const decimals = normalizeDecimalsHint(decimalsHint) ?? tokenDecimals(config, mint);
  const raw = amountRaw?.trim()
    ? validateRawAmount(amountRaw, label)
    : amount?.trim()
      ? decimalAmountToRaw(amount, decimals, label)
      : undefined;
  if (!raw) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `${label} requires amountRaw or a decimal amount with known decimals.`);
  }
  if (amount?.trim() && amountRaw?.trim() && decimals !== undefined) {
    const parsed = decimalAmountToRaw(amount, decimals, label);
    if (parsed !== raw) {
      throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `${label} and amountRaw do not match.`);
    }
  }
  const resolved: RecurringAmountResolution = { amountRaw: raw };
  if (amount?.trim()) {
    resolved.amount = amount;
  } else if (decimals !== undefined) {
    resolved.amount = formatRawAmount(BigInt(raw), decimals);
  }
  if (decimals !== undefined) resolved.decimals = decimals;
  return resolved;
}

function normalizeDecimalsHint(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 18) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'inputMintDecimals must be an integer from 0 to 18.');
  }
  return value;
}

function enforceRecurringAmountPolicy(
  config: AgentWalletConfig,
  policy: ResolvedJupiterRecurringPolicy,
  mint: string,
  amount: RecurringAmountResolution,
): void {
  const maxDeposit = policy.maxDepositAmount?.[mint]
    ?? policy.maxDepositAmount?.[mint.toLowerCase()]
    ?? policy.maxDepositAmount?.['*'];
  if (!maxDeposit) return;
  const decimals = amount.decimals ?? tokenDecimals(config, mint);
  if (decimals === undefined) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      `Jupiter Recurring deposit cap is configured for ${mint}, but token decimals are unknown; pass a configured token mint.`,
    );
  }
  assertMaxAmount(BigInt(amount.amountRaw), maxDeposit, decimals, 'Jupiter Recurring total deposit');
}

function buildCreateTimeOrderParams(
  walletAddress: string,
  input: JupiterRecurringCreateTimeOrderInput,
  amount: RecurringAmountResolution,
): Record<string, unknown> {
  return {
    user: walletAddress,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    params: {
      time: {
        inAmount: apiInteger(amount.amountRaw),
        numberOfOrders: input.numberOfOrders,
        interval: input.intervalSeconds,
        minPrice: apiPriceOrNull(input.minPrice),
        maxPrice: apiPriceOrNull(input.maxPrice),
        startAt: startAtUnixOrNull(input.startAt),
      },
    },
  };
}

function buildCancelOrderParams(walletAddress: string, orderId: string, recurringType: 'time' | 'price'): Record<string, unknown> {
  return {
    order: orderId,
    user: walletAddress,
    recurringType,
  };
}

function buildPriceOrderParams(
  walletAddress: string,
  orderId: string,
  operation: 'deposit' | 'withdraw',
  amountRaw: string,
  inputOrOutput?: 'In' | 'Out',
): Record<string, unknown> {
  return {
    order: orderId,
    user: walletAddress,
    amount: apiInteger(amountRaw),
    ...(operation === 'withdraw' ? { inputOrOutput: inputOrOutput ?? 'In' } : {}),
  };
}

async function buildRecurringTransaction(
  config: AgentWalletConfig,
  path: '/createOrder' | '/cancelOrder' | '/priceDeposit' | '/priceWithdraw',
  body: Record<string, unknown>,
): Promise<RecurringTransactionBuild> {
  const response = await jupiterFetchJson(config, 'recurring', path, {
    method: 'POST',
    body,
  });
  const transactionBase64 = optionalString(response, 'transaction') ?? optionalString(response, 'transactionBase64');
  if (!transactionBase64) {
    throw new ProtocolError('wallet_unreachable', `Jupiter Recurring ${path} response missing transaction.`);
  }
  const requestId = optionalString(response, 'requestId');
  if (!requestId) {
    throw new ProtocolError('wallet_unreachable', `Jupiter Recurring ${path} response missing requestId.`);
  }
  return {
    requestId,
    transactionBase64,
    raw: response,
  };
}

async function executeRecurringTransaction(
  config: AgentWalletConfig,
  requestId: string,
  signedTransaction: string,
): Promise<Record<string, unknown>> {
  return jupiterFetchJson(config, 'recurring', '/execute', {
    method: 'POST',
    body: {
      signedTransaction,
      requestId,
    },
  });
}

async function tryReadRecurringOrder(
  config: AgentWalletConfig,
  walletAddress: string,
  orderId: string,
  recurringType: 'time' | 'price',
): Promise<RecurringOrderSnapshot | undefined> {
  return getRecurringOrder(config, { walletAddress, orderId, recurringType }).catch(() => undefined);
}

function baseRecurringParams(operation: string, walletAddress: string, cluster: string): Record<string, unknown> {
  return {
    adapter: JUPITER_ADAPTER_ID,
    connectorId: JUPITER_ADAPTER_ID,
    product: JUPITER_RECURRING_PRODUCT,
    operation,
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    walletAddress,
    cluster,
    preparedSnapshotAt: new Date().toISOString(),
  };
}

function describeTimeOrder(
  input: JupiterRecurringCreateTimeOrderInput,
  amount: RecurringAmountResolution,
): string {
  return `Create Jupiter Recurring DCA ${amount.amount ?? `${amount.amountRaw} raw`} ${shortMint(input.inputMint)} -> ${shortMint(
    input.outputMint,
  )} over ${input.numberOfOrders} orders every ${input.intervalSeconds}s`;
}

function perCycleAmounts(
  amountRaw: string,
  numberOfOrders: number,
  decimals: number | undefined,
): { amountPerCycleRaw: string; amountPerCycle?: string; remainderRaw?: string } {
  const total = BigInt(amountRaw);
  const count = BigInt(numberOfOrders);
  const amountPerCycleRaw = total / count;
  const remainder = total % count;
  return {
    amountPerCycleRaw: amountPerCycleRaw.toString(),
    ...(decimals !== undefined ? { amountPerCycle: formatRawAmount(amountPerCycleRaw, decimals) } : {}),
    ...(remainder > 0n ? { remainderRaw: remainder.toString() } : {}),
  };
}

async function assertOwnership(action: PreparedAction, ctx: DAppAdapterContext): Promise<string> {
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Jupiter Recurring action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
  return walletAddress;
}

function executeResult(body: Record<string, unknown>, preview: Record<string, unknown>): AdapterExecuteResult {
  const txid = optionalString(body, 'signature') ?? optionalString(body, 'txid') ?? optionalString(body, 'txSignature');
  const status = optionalString(body, 'status');
  const error = optionalString(body, 'error');
  if (status?.toLowerCase() === 'failed' || error) {
    throw new ProtocolError(
      'wallet_unreachable',
      `Jupiter Recurring execute failed${error ? `: ${error}` : '.'}`,
    );
  }
  return {
    ...(txid !== undefined ? { txid } : {}),
    signedAt: new Date().toISOString(),
    preview: { ...preview, raw: body },
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
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
    preview: params,
  };
}

function enforceDeprecatedPriceOrderAccepted(
  input: JupiterRecurringPriceOrderInput,
  policy: ResolvedJupiterRecurringPolicy,
): void {
  if (!policy.allowDeprecatedPriceOrders) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'unsupported_method',
      'Deprecated Jupiter Recurring price-order management is disabled by policy.',
    );
  }
  if (input.priceOrderDeprecationAccepted !== true) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'Set priceOrderDeprecationAccepted=true to acknowledge Jupiter price-based Recurring orders are deprecated.',
    );
  }
}

function priceOrderAmountRaw(input: JupiterRecurringPriceOrderInput): string {
  const amount = input.amountRaw?.trim() || input.amount?.trim();
  if (!amount) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Deprecated Jupiter Recurring price-order management requires amountRaw.');
  }
  return validateRawAmount(amount, 'Jupiter Recurring price order amount');
}

function enforceFeeCap(maxFeeBps: number | undefined): void {
  if (maxFeeBps !== undefined && maxFeeBps < JUPITER_RECURRING_FEE_BPS) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      `maxFeeBps ${maxFeeBps} is below Jupiter Recurring fee ${JUPITER_RECURRING_FEE_BPS}.`,
    );
  }
}

function validateOrderId(orderId: string): void {
  if (!orderId?.trim()) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Jupiter Recurring orderId is required.');
  }
}

function validatePriceBound(value: string | undefined, label: string): void {
  if (value === undefined) return;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `${label} must be a non-negative number string.`);
  }
}

function normalizeStartAt(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'startAt must be a valid ISO timestamp.');
  }
  return new Date(parsed).toISOString();
}

function startAtUnixOrNull(value: string | undefined): number | null {
  const normalized = normalizeStartAt(value);
  if (normalized === null) return null;
  return Math.floor(Date.parse(normalized) / 1000);
}

function decimalAmountToRaw(amount: string, decimals: number | undefined, label: string): string {
  if (decimals === undefined) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      `${label} was provided as a decimal amount, but the input mint decimals are not configured. Pass amountRaw instead.`,
    );
  }
  return parseDecimalAmount(amount, decimals, label).toString();
}

function validateRawAmount(amountRaw: string, label: string): string {
  const trimmed = amountRaw.trim();
  if (!/^\d+$/.test(trimmed) || BigInt(trimmed) <= 0n) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `${label} must be a positive integer raw amount.`);
  }
  return trimmed;
}

function tokenDecimals(config: AgentWalletConfig, mint: string): number | undefined {
  if (mint === WSOL_MINT) return 9;
  return config.tokens.find((token) => token.mint === mint || token.symbol.toLowerCase() === mint.toLowerCase())?.decimals;
}

function apiInteger(raw: string): number | string {
  const value = BigInt(raw);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : raw;
}

function apiPriceOrNull(value: string | undefined): number | null {
  return value === undefined ? null : Number(value);
}

function priceOrderPath(operation: 'deposit' | 'withdraw'): '/priceDeposit' | '/priceWithdraw' {
  return operation === 'deposit' ? '/priceDeposit' : '/priceWithdraw';
}

function requireRecordParam(action: PreparedAction, key: string): Record<string, unknown> {
  const value = action.params[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_request', `Jupiter Recurring action is missing ${key} record.`);
  }
  return value as Record<string, unknown>;
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
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function shortMint(mint: string): string {
  if (mint.length <= 8) return mint;
  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}
