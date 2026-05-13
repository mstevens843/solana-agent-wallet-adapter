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
  const body = await jupiterFetchJson(config, 'trigger', '/orders', {
    method: 'GET',
    searchParams: {
      walletAddress: input.walletAddress,
      state: input.state ?? 'open',
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
  const jwt = requireValidJwt(input.walletAddress, config);
  const body = await jupiterFetchJson(config, 'trigger', `/orders/${encodeURIComponent(input.orderId)}`, {
    method: 'GET',
    bearerToken: jwt.jwt,
  });
  return normalizeOrder(input.walletAddress, body);
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
      walletAddress: input.walletAddress,
      state: input.state ?? 'all',
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
  const orderId = optionalString(body, 'orderId') ?? optionalString(body, 'id') ?? '';
  if (!orderId) {
    throw new ProtocolError('wallet_unreachable', 'Jupiter Trigger order missing orderId.');
  }
  const state = optionalString(body, 'state') ?? optionalString(body, 'status');
  const lowerState = state?.toLowerCase() ?? '';
  const cancellable = lowerState === 'open' || lowerState === 'pending' || lowerState === 'ready_to_cancel';
  const withdrawable =
    lowerState === 'cancelled' ||
    lowerState === 'expired' ||
    lowerState === 'ready_to_cancel' ||
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
  const takeProfitPriceUsd = optionalNumber(body, 'takeProfitPriceUsd');
  if (takeProfitPriceUsd !== undefined) snapshot.takeProfitPriceUsd = takeProfitPriceUsd;
  const stopLossPriceUsd = optionalNumber(body, 'stopLossPriceUsd');
  if (stopLossPriceUsd !== undefined) snapshot.stopLossPriceUsd = stopLossPriceUsd;
  const slippageBps = optionalNumber(body, 'slippageBps');
  if (slippageBps !== undefined) snapshot.slippageBps = slippageBps;
  const expiresAt = optionalString(body, 'expiresAt');
  if (expiresAt) snapshot.expiresAt = expiresAt;
  return snapshot;
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
