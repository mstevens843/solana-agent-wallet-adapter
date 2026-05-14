import type { Cluster } from '@solana-agent-wallet-adapter/core';

import { AdapterError, type DAppAdapterContext } from './adapters/types.js';
import { adapterForKind } from './adapters/registry.js';
import { parsePositiveSolDecimal } from './adapters/solDecimal.js';
import type { PreparedAction } from './preparedActions.js';

export interface PreparedTransactionPayload {
  transactionBase64: string;
  summary: string;
  preview?: Record<string, unknown>;
  cluster: Cluster;
}

const CAPTURE_SENTINEL = '__captured__';

interface CapturedRef {
  base64?: string;
  summary?: string;
}

export function createCaptureContext(ctx: DAppAdapterContext): {
  ctx: DAppAdapterContext;
  captured: CapturedRef;
} {
  const captured: CapturedRef = {};
  const captureCtx: DAppAdapterContext = {
    ...ctx,
    signAndBroadcast: async (transactionBase64: string, summary: string) => {
      if (captured.base64 !== undefined) {
        throw new AdapterError(
          'registry',
          'multi_tx_not_supported',
          'Adapter attempted to broadcast more than one transaction; capture supports a single transaction per approval.',
        );
      }
      captured.base64 = transactionBase64;
      captured.summary = summary;
      return CAPTURE_SENTINEL;
    },
    signAndBroadcastMany: async (transactionsBase64: string[], summary: string) => {
      if (transactionsBase64.length === 1) {
        const transactionBase64 = transactionsBase64[0];
        if (!transactionBase64) {
          throw new AdapterError(
            'registry',
            'transaction_missing',
            'Adapter attempted to broadcast an empty transaction; capture requires one transaction per approval.',
          );
        }
        if (captured.base64 !== undefined) {
          throw new AdapterError(
            'registry',
            'multi_tx_not_supported',
            'Adapter attempted to broadcast more than one transaction; capture supports a single transaction per approval.',
          );
        }
        captured.base64 = transactionBase64;
        captured.summary = summary;
        return [CAPTURE_SENTINEL];
      }
      throw new AdapterError(
        'registry',
        'multi_tx_not_supported',
        'Adapter requires multi-transaction broadcast; capture supports a single transaction per approval.',
      );
    },
  };
  return { ctx: captureCtx, captured };
}

/**
 * Sentinel that every adapter's `prepare()` stamps into its previewParams. If an action's
 * params don't carry this field, the params were produced by the form-driven template path
 * (or an AI plan) and have NOT yet been run through `adapter.prepare()` — so the adapter's
 * `execute()` would fail looking up enriched keys like `reserveMint` / `amountRaw`.
 */
const PREPARED_SNAPSHOT_KEY = 'preparedSnapshotAt';

function actionParamsAreEnriched(action: PreparedAction): boolean {
  return typeof action.params[PREPARED_SNAPSHOT_KEY] === 'string';
}

async function enrichActionParams(
  action: PreparedAction,
  adapterAction: ReturnType<typeof adapterForKind> & {},
  ctx: DAppAdapterContext,
): Promise<PreparedAction> {
  // The adapter's prepare() accepts an opaque input; the form-keyed action.params shape
  // is compatible with every adapter we have (e.g., Kamino reads `input.token`, MarginFi reads
  // `input.bank`, etc.). Adapters tolerate unknown fields.
  const prepareParams = normalizeLegacyConnectorPrepareParams(action.kind, action.params);
  let prepared;
  try {
    prepared = await adapterAction.prepare(prepareParams as never, ctx);
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterError(
      'registry',
      'prepare_failed',
      `Failed to prepare ${action.kind} for wallet approval: ${message}`,
    );
  }
  return {
    ...action,
    summary: prepared.addInput.summary || action.summary,
    params: {
      ...prepareParams,
      ...prepared.addInput.params,
    },
  };
}

function normalizeLegacyConnectorPrepareParams(
  kind: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (kind.startsWith('jupiter_trigger_')) {
    normalizeJupiterTriggerPrepareParams(next);
  }
  if (kind.startsWith('jupiter_recurring_')) {
    normalizeJupiterRecurringPrepareParams(kind, next);
  }
  if (kind !== 'magiceden_bid' && kind !== 'tensor_bid') return next;
  const rawBidPriceSol = stringParam(next, 'bidPriceSol') || stringParam(next, 'priceSol');
  const bidPriceSol = rawBidPriceSol ? normalizeSolParam(rawBidPriceSol) : '';
  if (bidPriceSol) {
    next.bidPriceSol = bidPriceSol;
  }
  const rawMaxEscrowSol = stringParam(next, 'maxEscrowSol') || bidPriceSol;
  const maxEscrowSol = rawMaxEscrowSol ? normalizeSolParam(rawMaxEscrowSol) : '';
  if (maxEscrowSol) {
    next.maxEscrowSol = maxEscrowSol;
  }
  return next;
}

function normalizeSolParam(value: string): string {
  try {
    return parsePositiveSolDecimal(value, 'SOL value').sol;
  } catch {
    return value.trim();
  }
}

function normalizeJupiterTriggerPrepareParams(params: Record<string, unknown>): void {
  if (!stringParam(params, 'amount') && stringParam(params, 'makingAmount')) {
    params.amount = stringParam(params, 'makingAmount');
  }
  for (const key of [
    'triggerPriceUsd',
    'slippageBps',
    'maxDepositUsd',
    'takeProfitPriceUsd',
    'stopLossPriceUsd',
    'takeProfitSlippageBps',
    'stopLossSlippageBps',
    'entryPriceUsd',
    'newTriggerPriceUsd',
    'newSlippageBps',
  ]) {
    coerceNumberParam(params, key);
  }
  coerceBooleanParam(params, 'acceptHighSlippage');
}

function normalizeJupiterRecurringPrepareParams(kind: string, params: Record<string, unknown>): void {
  if (kind === 'jupiter_recurring_create_time_order' && !stringParam(params, 'totalAmount') && stringParam(params, 'amount')) {
    params.totalAmount = stringParam(params, 'amount');
  }
  for (const key of ['numberOfOrders', 'intervalSeconds', 'maxFeeBps']) {
    coerceNumberParam(params, key);
  }
  coerceBooleanParam(params, 'automationWarningAccepted');
  coerceBooleanParam(params, 'priceOrderDeprecationAccepted');
}

function coerceNumberParam(params: Record<string, unknown>, key: string): void {
  const value = params[key];
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed) {
    delete params[key];
    return;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    params[key] = numeric;
  }
}

function coerceBooleanParam(params: Record<string, unknown>, key: string): void {
  const value = params[key];
  if (typeof value !== 'string') return;
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    delete params[key];
    return;
  }
  if (['true', 'yes', 'accepted', 'acknowledged'].includes(normalized)) {
    params[key] = true;
  } else if (['false', 'no'].includes(normalized)) {
    params[key] = false;
  }
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value.trim() : '';
}

export async function prepareTransactionForApproval(
  action: PreparedAction,
  ctx: DAppAdapterContext,
): Promise<PreparedTransactionPayload> {
  const adapterAction = adapterForKind(action.kind);
  if (!adapterAction) {
    throw new AdapterError(
      'registry',
      'unknown_kind',
      `No adapter registered for kind ${action.kind}`,
    );
  }

  const enrichedAction = actionParamsAreEnriched(action)
    ? action
    : await enrichActionParams(action, adapterAction, ctx);

  const { ctx: captureCtx, captured } = createCaptureContext(ctx);
  const result = await adapterAction.execute(enrichedAction, captureCtx);

  if (captured.base64 === undefined || captured.summary === undefined) {
    throw new AdapterError(
      'registry',
      'not_executable',
      `Adapter for ${action.kind} did not produce a transaction`,
    );
  }

  return {
    transactionBase64: captured.base64,
    summary: captured.summary,
    preview: result.preview,
    cluster: ctx.config.cluster,
  };
}
