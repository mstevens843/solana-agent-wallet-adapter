import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import type { AgentWalletConfig } from '../../config.js';
import { getJupiterRecurringPolicy } from '../../config.js';

import { jupiterFetchJson } from './client.js';

export type JupiterRecurringOrderState =
  | 'active'
  | 'history'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'all';

// A single executed cycle (keeper-run fill) of a recurring order. Surfaced so the client can render a
// receipt per fill in Done — the fills run through Jupiter automation and never touch the Agentic
// approval inbox, so this per-cycle history is the only record of them.
export interface RecurringOrderFill {
  txId: string;
  inputAmount?: string;
  outputAmount?: string;
  confirmedAt?: string;
}

export interface RecurringOrderSnapshot {
  orderId: string;
  walletAddress: string;
  recurringType?: string;
  status?: string;
  inputMint?: string;
  outputMint?: string;
  totalAmount?: string;
  totalAmountRaw?: string;
  amountPerCycle?: string;
  amountPerCycleRaw?: string;
  numberOfOrders?: number;
  executedOrders?: number;
  remainingOrders?: number;
  intervalSeconds?: number;
  nextExecutionAt?: string;
  startAt?: string;
  createdAt?: string;
  closedAt?: string;
  feeBps?: number;
  fills?: RecurringOrderFill[];
  raw: Record<string, unknown>;
}

export interface ListRecurringOrdersInput {
  walletAddress: string;
  state?: JupiterRecurringOrderState;
  limit?: number;
  page?: number;
  inputMint?: string;
  outputMint?: string;
  recurringType?: 'time' | 'price';
  includeFailedTx?: boolean;
}

export interface ListRecurringOrdersResult {
  walletAddress: string;
  state: JupiterRecurringOrderState;
  page: number;
  totalPages?: number;
  orders: RecurringOrderSnapshot[];
  raw: Record<string, unknown>;
}

export function requireRecurringEnabled(config: AgentWalletConfig): void {
  const policy = getJupiterRecurringPolicy(config);
  if (!policy.enabled) {
    throw new ProtocolError(
      'unsupported_method',
      'Jupiter Recurring is disabled. Set connectors.jupiter.recurring.enabled=true or CONNECTORS_JUPITER_RECURRING_ENABLED=true to opt in.',
    );
  }
}

export async function listRecurringOrders(
  config: AgentWalletConfig,
  input: ListRecurringOrdersInput,
): Promise<ListRecurringOrdersResult> {
  requireRecurringEnabled(config);
  const state = input.state ?? 'active';
  const page = input.page ?? 1;
  if (state === 'all') {
    const [active, history] = await Promise.all([
      listRecurringOrders(config, { ...input, state: 'active', page }),
      listRecurringOrders(config, { ...input, state: 'history', page, includeFailedTx: input.includeFailedTx ?? true }),
    ]);
    const orders = [...active.orders, ...history.orders];
    return {
      walletAddress: input.walletAddress,
      state,
      page,
      orders: input.limit === undefined ? orders : orders.slice(0, input.limit),
      raw: {
        active: active.raw,
        history: history.raw,
      },
    };
  }
  const orderStatus = apiOrderStatus(state);
  const body = await jupiterFetchJson(config, 'recurring', '/getRecurringOrders', {
    method: 'GET',
    searchParams: {
      user: input.walletAddress,
      orderStatus,
      recurringType: input.recurringType ?? 'time',
      page,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      includeFailedTx: input.includeFailedTx ?? false,
    },
  });
  const orders = filterRecurringOrdersByState(
    normalizeRecurringOrderList(input.walletAddress, body, orderStatus),
    state,
  );
  const limited = input.limit === undefined ? orders : orders.slice(0, input.limit);
  const totalPages = optionalNumber(body, 'totalPages');
  return {
    walletAddress: input.walletAddress,
    state,
    page,
    ...(totalPages !== undefined && { totalPages }),
    orders: limited,
    raw: body,
  };
}

export interface GetRecurringOrderInput {
  walletAddress: string;
  orderId: string;
  recurringType?: 'time' | 'price';
}

export async function getRecurringOrder(
  config: AgentWalletConfig,
  input: GetRecurringOrderInput,
): Promise<RecurringOrderSnapshot> {
  requireRecurringEnabled(config);
  const active = await listRecurringOrders(config, {
    walletAddress: input.walletAddress,
    state: 'active',
    recurringType: input.recurringType,
    limit: 100,
  });
  const activeMatch = active.orders.find((order) => order.orderId === input.orderId);
  if (activeMatch) return activeMatch;
  const history = await listRecurringOrders(config, {
    walletAddress: input.walletAddress,
    state: 'history',
    recurringType: input.recurringType,
    limit: 100,
    includeFailedTx: true,
  });
  const historyMatch = history.orders.find((order) => order.orderId === input.orderId);
  if (historyMatch) return historyMatch;
  throw new ProtocolError('invalid_request', `Jupiter Recurring order ${input.orderId} was not found on the first active/history pages.`);
}

export function normalizeRecurringOrderList(
  walletAddress: string,
  body: Record<string, unknown>,
  state: JupiterRecurringOrderState = 'active',
): RecurringOrderSnapshot[] {
  const candidateArrays = [
    body.time,
    body.price,
    body.orders,
    body.data,
    body.results,
  ];
  const entries = candidateArrays.find(Array.isArray) ?? [];
  return entries
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => normalizeRecurringOrder(walletAddress, entry, state));
}

export function normalizeRecurringOrder(
  walletAddress: string,
  body: Record<string, unknown>,
  fallbackState: JupiterRecurringOrderState = 'active',
): RecurringOrderSnapshot {
  const orderId =
    optionalString(body, 'orderKey') ??
    optionalString(body, 'order') ??
    optionalString(body, 'orderId') ??
    optionalString(body, 'id') ??
    optionalString(body, 'address') ??
    '';
  if (!orderId) {
    throw new ProtocolError('wallet_unreachable', 'Jupiter Recurring order response is missing orderKey.');
  }
  const snapshot: RecurringOrderSnapshot = {
    orderId,
    walletAddress: optionalString(body, 'user') ?? walletAddress,
    raw: body,
  };
  const status = optionalString(body, 'status') ?? optionalString(body, 'orderStatus') ?? fallbackState;
  if (status) snapshot.status = status;
  const recurringType = optionalString(body, 'recurringType') ?? (body.rawInAmountPerCycle !== undefined ? 'time' : undefined);
  if (recurringType) snapshot.recurringType = recurringType;
  const inputMint = optionalString(body, 'inputMint');
  if (inputMint) snapshot.inputMint = inputMint;
  const outputMint = optionalString(body, 'outputMint');
  if (outputMint) snapshot.outputMint = outputMint;
  const totalAmountRaw = optionalString(body, 'rawInDeposited') ?? optionalString(body, 'inAmount') ?? optionalString(body, 'depositAmount');
  if (totalAmountRaw) snapshot.totalAmountRaw = totalAmountRaw;
  const totalAmount = optionalString(body, 'inDeposited') ?? optionalString(body, 'totalAmount');
  if (totalAmount) snapshot.totalAmount = totalAmount;
  const amountPerCycleRaw = optionalString(body, 'rawInAmountPerCycle') ?? optionalString(body, 'inAmountPerCycle');
  if (amountPerCycleRaw) snapshot.amountPerCycleRaw = amountPerCycleRaw;
  const amountPerCycle = optionalString(body, 'inAmountPerCycleUi') ?? optionalString(body, 'amountPerCycle');
  if (amountPerCycle) snapshot.amountPerCycle = amountPerCycle;
  const numberOfOrders = optionalNumber(body, 'numberOfOrders') ?? optionalNumber(body, 'totalOrders');
  if (numberOfOrders !== undefined) snapshot.numberOfOrders = numberOfOrders;
  const executedOrders = optionalNumber(body, 'executedOrders') ?? optionalNumber(body, 'ordersExecuted') ?? optionalNumber(body, 'filledOrders');
  if (executedOrders !== undefined) snapshot.executedOrders = executedOrders;
  const remainingOrders = optionalNumber(body, 'remainingOrders') ??
    (numberOfOrders !== undefined && executedOrders !== undefined ? Math.max(numberOfOrders - executedOrders, 0) : undefined);
  if (remainingOrders !== undefined) snapshot.remainingOrders = remainingOrders;
  const intervalSeconds = optionalNumber(body, 'interval') ?? optionalNumber(body, 'cycleFrequency');
  if (intervalSeconds !== undefined) snapshot.intervalSeconds = intervalSeconds;
  const nextExecutionAt = optionalTimestamp(body, 'nextExecutionAt') ?? optionalTimestamp(body, 'nextRunAt');
  if (nextExecutionAt) snapshot.nextExecutionAt = nextExecutionAt;
  const startAt = optionalTimestamp(body, 'startAt');
  if (startAt) snapshot.startAt = startAt;
  const createdAt = optionalTimestamp(body, 'createdAt');
  if (createdAt) snapshot.createdAt = createdAt;
  const closedAt = optionalTimestamp(body, 'closedAt') ?? optionalTimestamp(body, 'updatedAt');
  if (closedAt) snapshot.closedAt = closedAt;
  const feeBps = optionalNumber(body, 'feeBps');
  if (feeBps !== undefined) snapshot.feeBps = feeBps;
  const fills = normalizeRecurringFills(body);
  if (fills.length) snapshot.fills = fills;
  return snapshot;
}

// Extract per-cycle fills from a recurring order body. Jupiter returns these under `trades` (each keeper
// run); we read defensively across likely aliases so a field rename upstream degrades gracefully to an
// empty list rather than throwing. A fill without a tx signature is dropped (it can't back a receipt).
export function normalizeRecurringFills(body: Record<string, unknown>): RecurringOrderFill[] {
  const source = [body.trades, body.fills, body.executions, body.history].find(Array.isArray) ?? [];
  const out: RecurringOrderFill[] = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const txId =
      optionalString(row, 'txId') ??
      optionalString(row, 'txSignature') ??
      optionalString(row, 'signature') ??
      optionalString(row, 'txHash') ??
      optionalString(row, 'transaction');
    if (!txId) continue;
    const fill: RecurringOrderFill = { txId };
    const inputAmount = optionalString(row, 'inputAmount') ?? optionalString(row, 'inAmount') ?? optionalString(row, 'rawInputAmount');
    if (inputAmount) fill.inputAmount = inputAmount;
    const outputAmount = optionalString(row, 'outputAmount') ?? optionalString(row, 'outAmount') ?? optionalString(row, 'rawOutputAmount');
    if (outputAmount) fill.outputAmount = outputAmount;
    const confirmedAt = optionalTimestamp(row, 'confirmedAt') ?? optionalTimestamp(row, 'timestamp') ?? optionalTimestamp(row, 'blockTime') ?? optionalTimestamp(row, 'date');
    if (confirmedAt) fill.confirmedAt = confirmedAt;
    out.push(fill);
  }
  return out;
}

function apiOrderStatus(state: JupiterRecurringOrderState): 'active' | 'history' {
  return state === 'active' ? 'active' : 'history';
}

function filterRecurringOrdersByState(
  orders: RecurringOrderSnapshot[],
  state: JupiterRecurringOrderState,
): RecurringOrderSnapshot[] {
  if (state === 'active' || state === 'history' || state === 'all') return orders;
  return orders.filter((order) => recurringStatusMatches(order.status, state));
}

function recurringStatusMatches(status: string | undefined, state: Exclude<JupiterRecurringOrderState, 'active' | 'history' | 'all'>): boolean {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return false;
  if (state === 'cancelled') return normalized.includes('cancel');
  if (state === 'completed') return normalized.includes('complete') || normalized.includes('filled');
  return normalized.includes('fail');
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function optionalTimestamp(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return undefined;
}
