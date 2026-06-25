import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import { getJupiterPredictionPolicy, type AgentWalletConfig } from '../../config.js';
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
  JUPITER_PREDICTION_BETA_WARNING,
  JUPITER_PREDICTION_EXTERNAL_PROVIDER_WARNING,
  assertPredictionEnabled,
} from './predictionClient.js';

const JUPITER_PREDICTION_PRODUCT = 'prediction';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUPUSD_MINT = 'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD';
const ALLOWED_DEPOSIT_MINTS = new Set([USDC_MINT, JUPUSD_MINT]);
const PREDICTION_WRITE_WARNINGS = [
  JUPITER_PREDICTION_BETA_WARNING,
  JUPITER_PREDICTION_EXTERNAL_PROVIDER_WARNING,
  'Fees are charged on executed trades. Outcomes and resolution are controlled by external providers.',
];

export interface JupiterPredictionCreateOrderInput {
  marketId: string;
  /** YES outcome (true) or NO outcome (false). */
  isYes: boolean | string;
  /** Buy (true) or sell (false) contracts. */
  isBuy: boolean | string;
  /** Human deposit in USD (e.g. "25"). Converted to micro-USD. */
  depositAmount?: string;
  /** Raw micro-USD deposit (1_000_000 = $1). Preferred. */
  depositAmountRaw?: string;
  /** USDC (default) or JupUSD mint. */
  depositMint?: string;
  dueAt?: string;
  note?: string;
}

export interface JupiterPredictionClosePositionInput {
  positionPubkey: string;
  minSellPriceSlippageBps?: number;
  dueAt?: string;
  note?: string;
}

export interface JupiterPredictionClaimPositionInput {
  positionPubkey: string;
  dueAt?: string;
  note?: string;
}

// ── Write gate ───────────────────────────────────────────────────────────────
// Prediction writes require (a) the connector opted in, (b) readOnly disabled, and
// (c) a non-US egress confirmed via env — the Prediction API geoblocks US + South
// Korea IPs, so calls from a US-hosted backend fail until egress is in place.
function assertPredictionWritable(config: AgentWalletConfig, operation: string): void {
  assertPredictionEnabled(config);
  const policy = getJupiterPredictionPolicy(config);
  if (policy.readOnly) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'unsupported_method',
      `Jupiter Prediction is read-only; ${operation} is disabled. Set connectors.jupiter.prediction.readOnly=false to enable writes.`,
    );
  }
  if (process.env.JUPITER_PREDICTION_EGRESS_READY !== 'true') {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'unsupported_method',
      `Jupiter Prediction ${operation} is unavailable: the Prediction API geoblocks US/SK IPs. ` +
        `Configure a non-US egress and set JUPITER_PREDICTION_EGRESS_READY=true to enable.`,
    );
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────
export const createOrderAction: AdapterAction<JupiterPredictionCreateOrderInput> = {
  id: 'prediction_create_order',
  kind: 'jupiter_prediction_create_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    assertPredictionWritable(ctx.config, 'create order');
    const walletAddress = await ctx.backend.getAddress();
    const orderBody = buildCreateOrderBody(input, walletAddress);
    const response = await jupiterFetchJson(ctx.config, JUPITER_PREDICTION_PRODUCT, '/orders', {
      method: 'POST',
      body: orderBody,
    });
    const transactionBase64 = requireResponseString(response, 'transaction');
    const order = isRecord(response.order) ? response.order : undefined;
    const params = baseParams('create_order', walletAddress, ctx.config.cluster);
    Object.assign(params, {
      marketId: orderBody.marketId,
      isYes: orderBody.isYes,
      isBuy: orderBody.isBuy,
      depositAmountRaw: String(orderBody.depositAmount),
      depositMint: orderBody.depositMint,
      orderBody,
      transactionBase64,
      ...(order ? { order } : {}),
      ...(order ? { orderPubkey: optionalString(order, 'orderPubkey') } : {}),
      ...(order ? { positionPubkey: optionalString(order, 'positionPubkey') } : {}),
      warnings: PREDICTION_WRITE_WARNINGS,
      rawOrderResponse: response,
    });
    const summary = `Jupiter Prediction ${orderBody.isBuy ? 'buy' : 'sell'} ${orderBody.isYes ? 'YES' : 'NO'} on market ${orderBody.marketId}`;
    return preparedActionResult('jupiter_prediction_create_order', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    assertPredictionWritable(ctx.config, 'create order');
    const walletAddress = await assertOwnership(action, ctx);
    const orderBody = { ...requireRecordParam(action, 'orderBody'), ownerPubkey: walletAddress };
    const response = await jupiterFetchJson(ctx.config, JUPITER_PREDICTION_PRODUCT, '/orders', {
      method: 'POST',
      body: orderBody,
    });
    return signAndExecute(ctx, action, response, { operation: 'create_order', walletAddress });
  },
};

export const closePositionAction: AdapterAction<JupiterPredictionClosePositionInput> = {
  id: 'prediction_close_position',
  kind: 'jupiter_prediction_close_position',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    assertPredictionWritable(ctx.config, 'close position');
    const walletAddress = await ctx.backend.getAddress();
    const positionPubkey = requireField(input.positionPubkey, 'positionPubkey');
    const body = closeBody(input, walletAddress);
    const response = await jupiterFetchJson(
      ctx.config,
      JUPITER_PREDICTION_PRODUCT,
      `/positions/${encodeURIComponent(positionPubkey)}`,
      { method: 'DELETE', body },
    );
    const transactionBase64 = requireResponseString(response, 'transaction');
    const params = baseParams('close_position', walletAddress, ctx.config.cluster);
    Object.assign(params, {
      positionPubkey,
      ...(input.minSellPriceSlippageBps !== undefined ? { minSellPriceSlippageBps: input.minSellPriceSlippageBps } : {}),
      closeBody: body,
      transactionBase64,
      warnings: PREDICTION_WRITE_WARNINGS,
      rawCloseResponse: response,
    });
    const summary = `Jupiter Prediction close position ${positionPubkey}`;
    return preparedActionResult('jupiter_prediction_close_position', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    assertPredictionWritable(ctx.config, 'close position');
    const walletAddress = await assertOwnership(action, ctx);
    const positionPubkey = requireStringParam(action, 'positionPubkey');
    const body = { ...requireRecordParam(action, 'closeBody'), ownerPubkey: walletAddress };
    const response = await jupiterFetchJson(
      ctx.config,
      JUPITER_PREDICTION_PRODUCT,
      `/positions/${encodeURIComponent(positionPubkey)}`,
      { method: 'DELETE', body },
    );
    return signAndExecute(ctx, action, response, { operation: 'close_position', walletAddress });
  },
};

export const claimPositionAction: AdapterAction<JupiterPredictionClaimPositionInput> = {
  id: 'prediction_claim_position',
  kind: 'jupiter_prediction_claim_position',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    assertPredictionWritable(ctx.config, 'claim position');
    const walletAddress = await ctx.backend.getAddress();
    const positionPubkey = requireField(input.positionPubkey, 'positionPubkey');
    const response = await jupiterFetchJson(
      ctx.config,
      JUPITER_PREDICTION_PRODUCT,
      `/positions/${encodeURIComponent(positionPubkey)}/claim`,
      { method: 'POST', body: { ownerPubkey: walletAddress } },
    );
    const transactionBase64 = requireResponseString(response, 'transaction');
    const params = baseParams('claim_position', walletAddress, ctx.config.cluster);
    Object.assign(params, {
      positionPubkey,
      transactionBase64,
      warnings: [...PREDICTION_WRITE_WARNINGS, 'Claiming a settled winning position has no fee (network fee only).'],
      rawClaimResponse: response,
    });
    const summary = `Jupiter Prediction claim payout for position ${positionPubkey}`;
    return preparedActionResult('jupiter_prediction_claim_position', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    assertPredictionWritable(ctx.config, 'claim position');
    const walletAddress = await assertOwnership(action, ctx);
    const positionPubkey = requireStringParam(action, 'positionPubkey');
    const response = await jupiterFetchJson(
      ctx.config,
      JUPITER_PREDICTION_PRODUCT,
      `/positions/${encodeURIComponent(positionPubkey)}/claim`,
      { method: 'POST', body: { ownerPubkey: walletAddress } },
    );
    return signAndExecute(ctx, action, response, { operation: 'claim_position', walletAddress });
  },
};

// ── Body builders ────────────────────────────────────────────────────────────
function buildCreateOrderBody(
  input: JupiterPredictionCreateOrderInput,
  walletAddress: string,
): {
  ownerPubkey: string;
  marketId: string;
  isYes: boolean;
  isBuy: boolean;
  depositAmount: string;
  depositMint: string;
} {
  const marketId = requireField(input.marketId, 'marketId');
  const depositMint = (input.depositMint?.trim() || USDC_MINT);
  if (!ALLOWED_DEPOSIT_MINTS.has(depositMint)) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'Jupiter Prediction deposit must be USDC or JupUSD.',
    );
  }
  const depositAmount = resolveDepositMicro(input);
  return {
    ownerPubkey: walletAddress,
    marketId,
    isYes: coerceBool(input.isYes, 'isYes'),
    isBuy: coerceBool(input.isBuy, 'isBuy'),
    depositAmount,
    depositMint,
  };
}

function resolveDepositMicro(input: JupiterPredictionCreateOrderInput): string {
  const raw = input.depositAmountRaw?.trim();
  if (raw) return validateRawAmount(raw, 'Jupiter Prediction depositAmountRaw');
  const human = input.depositAmount?.trim();
  if (!human) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Jupiter Prediction requires depositAmount or depositAmountRaw.');
  }
  const dollars = Number(human);
  if (!Number.isFinite(dollars) || dollars <= 0) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Jupiter Prediction depositAmount must be a positive USD value.');
  }
  return BigInt(Math.round(dollars * 1_000_000)).toString();
}

function closeBody(
  input: JupiterPredictionClosePositionInput,
  walletAddress: string,
): Record<string, unknown> {
  return {
    ownerPubkey: walletAddress,
    ...(input.minSellPriceSlippageBps !== undefined ? { minSellPriceSlippageBps: input.minSellPriceSlippageBps } : {}),
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────
function baseParams(operation: string, walletAddress: string, cluster: string): Record<string, unknown> {
  return {
    adapter: JUPITER_ADAPTER_ID,
    connectorId: JUPITER_ADAPTER_ID,
    product: JUPITER_PREDICTION_PRODUCT,
    operation,
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    walletAddress,
    cluster,
    preparedSnapshotAt: new Date().toISOString(),
  };
}

async function assertOwnership(action: PreparedAction, ctx: DAppAdapterContext): Promise<string> {
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Jupiter Prediction action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
  return walletAddress;
}

async function signAndExecute(
  ctx: DAppAdapterContext,
  action: PreparedAction,
  response: Record<string, unknown>,
  preview: Record<string, unknown>,
): Promise<AdapterExecuteResult> {
  const transactionBase64 = requireResponseString(response, 'transaction');
  const txid = await ctx.signAndBroadcast(transactionBase64, action.summary);
  return {
    txid,
    signedAt: new Date().toISOString(),
    preview: { ...preview, raw: response },
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

function coerceBool(value: boolean | string, label: string): boolean {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (v === true || v === 'true' || v === 'yes' || v === 'buy') return true;
  if (v === false || v === 'false' || v === 'no' || v === 'sell') return false;
  throw new AdapterError(
    JUPITER_ADAPTER_ID,
    'invalid_request',
    `Jupiter Prediction ${label} must be true/false (yes/no, buy/sell accepted).`,
  );
}

function requireField(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `Jupiter Prediction ${label} is required.`);
  }
  return trimmed;
}

function validateRawAmount(amountRaw: string, label: string): string {
  const trimmed = amountRaw.trim();
  if (!/^\d+$/.test(trimmed) || BigInt(trimmed) <= 0n) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `${label} must be a positive integer (micro-USD) amount.`);
  }
  return trimmed;
}

function requireResponseString(response: Record<string, unknown>, key: string): string {
  const value = response[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('wallet_unreachable', `Jupiter Prediction response is missing ${key}.`);
  }
  return value;
}

function requireStringParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `Jupiter Prediction action is missing ${key}.`);
  }
  return value;
}

function requireRecordParam(action: PreparedAction, key: string): Record<string, unknown> {
  const value = action.params[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_request', `Jupiter Prediction action is missing ${key} record.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
