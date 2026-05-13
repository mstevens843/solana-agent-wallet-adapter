import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import type { AgentWalletConfig } from '../../config.js';

import { jupiterFetchJson } from './client.js';
import { requireTriggerEnabled, requireValidJwt } from './triggerAuth.js';
import type { JupiterTriggerOrderState } from './triggerConstants.js';

export interface TriggerOrderSnapshot {
  orderId: string;
  walletAddress: string;
  orderType?: string;
  state?: string;
  inputMint?: string;
  outputMint?: string;
  triggerMint?: string;
  triggerCondition?: string;
  triggerPriceUsd?: number;
  takeProfitPriceUsd?: number;
  stopLossPriceUsd?: number;
  slippageBps?: number;
  expiresAt?: string;
  remainingInputAmount?: string;
  txSignature?: string;
  cancellable: boolean;
  withdrawable: boolean;
  raw: Record<string, unknown>;
}

export interface ListOrdersInput {
  walletAddress: string;
  state?: JupiterTriggerOrderState;
  limit?: number;
  offset?: number;
}

export async function listOrders(
  config: AgentWalletConfig,
  input: ListOrdersInput,
): Promise<{ orders: TriggerOrderSnapshot[]; raw: Record<string, unknown> }> {
  requireTriggerEnabled(config);
  const jwt = requireValidJwt(input.walletAddress, config);
  const body = await jupiterFetchJson(config, 'trigger', '/orders/history', {
    method: 'GET',
    searchParams: {
      state: triggerStateGroup(input.state ?? 'open'),
      limit: input.limit,
      offset: input.offset,
    },
    bearerToken: jwt.jwt,
  });
  return { orders: normalizeOrderList(input.walletAddress, body), raw: body };
}

export interface GetOrderInput {
  walletAddress: string;
  orderId: string;
}

export async function getOrder(
  config: AgentWalletConfig,
  input: GetOrderInput,
): Promise<TriggerOrderSnapshot> {
  requireTriggerEnabled(config);
  const active = await listOrders(config, {
    walletAddress: input.walletAddress,
    state: 'open',
    limit: 100,
  });
  const activeMatch = active.orders.find((order) => order.orderId === input.orderId);
  if (activeMatch) return activeMatch;
  const history = await listOrders(config, {
    walletAddress: input.walletAddress,
    state: 'all',
    limit: 100,
  });
  const historyMatch = history.orders.find((order) => order.orderId === input.orderId);
  if (historyMatch) return historyMatch;
  throw new ProtocolError('invalid_request', `Jupiter Trigger order ${input.orderId} was not found on the first active/history pages.`);
}

export interface OrderHistoryInput {
  walletAddress: string;
  state?: JupiterTriggerOrderState;
  limit?: number;
  offset?: number;
}

export async function orderHistory(
  config: AgentWalletConfig,
  input: OrderHistoryInput,
): Promise<{ orders: TriggerOrderSnapshot[]; raw: Record<string, unknown> }> {
  requireTriggerEnabled(config);
  const jwt = requireValidJwt(input.walletAddress, config);
  const body = await jupiterFetchJson(config, 'trigger', '/orders/history', {
    method: 'GET',
    searchParams: {
      state: triggerStateGroup(input.state ?? 'all'),
      limit: input.limit,
      offset: input.offset,
    },
    bearerToken: jwt.jwt,
  });
  return { orders: normalizeOrderList(input.walletAddress, body), raw: body };
}

export function assertOrderCancellable(snapshot: TriggerOrderSnapshot): void {
  if (!snapshot.cancellable) {
    throw new ProtocolError(
      'invalid_request',
      `Jupiter Trigger order ${snapshot.orderId} is not in a cancellable state (state=${snapshot.state ?? 'unknown'}).`,
    );
  }
}

export function assertOrderWithdrawable(snapshot: TriggerOrderSnapshot): void {
  if (!snapshot.withdrawable) {
    throw new ProtocolError(
      'invalid_request',
      `Jupiter Trigger order ${snapshot.orderId} has no withdrawable funds (state=${snapshot.state ?? 'unknown'}).`,
    );
  }
}

function normalizeOrderList(walletAddress: string, body: Record<string, unknown>): TriggerOrderSnapshot[] {
  const data = body.orders ?? body.data ?? body.results ?? [];
  if (!Array.isArray(data)) return [];
  return data
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => normalizeOrder(walletAddress, item));
}

function normalizeOrder(walletAddress: string, body: Record<string, unknown>): TriggerOrderSnapshot {
  const orderId = optionalString(body, 'orderId') ?? optionalString(body, 'id') ?? optionalString(body, 'order') ?? '';
  if (!orderId) {
    throw new ProtocolError('wallet_unreachable', 'Jupiter Trigger order missing orderId.');
  }
  const state = optionalString(body, 'orderState') ?? optionalString(body, 'state') ?? optionalString(body, 'status');
  const lowerState = state?.toLowerCase() ?? '';
  const cancellable = lowerState === 'open' || lowerState === 'pending' || lowerState === 'active';
  const withdrawable =
    lowerState === 'cancelled' ||
    lowerState === 'expired' ||
    lowerState === 'ready_to_cancel' ||
    positiveRawAmount(body.remainingInputAmount) ||
    body.withdrawable === true;
  const snapshot: TriggerOrderSnapshot = {
    orderId,
    walletAddress,
    cancellable,
    withdrawable,
    raw: body,
  };
  const orderType = optionalString(body, 'orderType') ?? optionalString(body, 'type');
  if (orderType) snapshot.orderType = orderType;
  if (state) snapshot.state = state;
  const inputMint = optionalString(body, 'inputMint');
  if (inputMint) snapshot.inputMint = inputMint;
  const outputMint = optionalString(body, 'outputMint');
  if (outputMint) snapshot.outputMint = outputMint;
  const triggerMint = optionalString(body, 'triggerMint');
  if (triggerMint) snapshot.triggerMint = triggerMint;
  const triggerCondition = optionalString(body, 'triggerCondition');
  if (triggerCondition) snapshot.triggerCondition = triggerCondition;
  const triggerPriceUsd = optionalNumber(body, 'triggerPriceUsd');
  if (triggerPriceUsd !== undefined) snapshot.triggerPriceUsd = triggerPriceUsd;
  const takeProfitPriceUsd = optionalNumber(body, 'takeProfitPriceUsd') ?? optionalNumber(body, 'tpPriceUsd');
  if (takeProfitPriceUsd !== undefined) snapshot.takeProfitPriceUsd = takeProfitPriceUsd;
  const stopLossPriceUsd = optionalNumber(body, 'stopLossPriceUsd') ?? optionalNumber(body, 'slPriceUsd');
  if (stopLossPriceUsd !== undefined) snapshot.stopLossPriceUsd = stopLossPriceUsd;
  const slippageBps = optionalNumber(body, 'slippageBps');
  if (slippageBps !== undefined) snapshot.slippageBps = slippageBps;
  const expiresAt = optionalString(body, 'expiresAt');
  if (expiresAt) snapshot.expiresAt = normalizeTimestamp(expiresAt);
  const remainingInputAmount = optionalString(body, 'remainingInputAmount');
  if (remainingInputAmount) snapshot.remainingInputAmount = remainingInputAmount;
  const txSignature = optionalString(body, 'txSignature');
  if (txSignature) snapshot.txSignature = txSignature;
  return snapshot;
}

function triggerStateGroup(state: JupiterTriggerOrderState): 'active' | 'past' {
  return state === 'open' || state === 'pending' ? 'active' : 'past';
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
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

function normalizeTimestamp(value: string): string {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return new Date(numeric < 1e12 ? numeric * 1000 : numeric).toISOString();
  }
  return value;
}

function positiveRawAmount(value: unknown): boolean {
  return typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n;
}
