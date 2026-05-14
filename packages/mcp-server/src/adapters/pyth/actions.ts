import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
} from '../types.js';
import { AdapterError } from '../types.js';

import {
  describePythReceiverUnavailableReason,
  getPythClient,
  getPythReceiver,
  type PythHermesPriceUpdate,
} from './client.js';
import {
  PYTH_ADAPTER_ID,
  PYTH_DEFAULT_MAX_AGE_SECONDS,
  PYTH_MAX_FEEDS_PER_POST,
  normalizePriceFeedId,
  resolveAlias,
  withFeedIdPrefix,
} from './constants.js';
import { clientHost } from './feeds.js';
import { getPriceFeedsBatchSnapshot } from './prices.js';

export interface PythPostPriceUpdateInput {
  priceFeedIds?: string[] | string;
  priceFeedId?: string;
  symbol?: string;
  maxAgeSeconds?: number | string;
  payerAddress?: string;
  closeUpdateAccounts?: boolean;
  computeUnitPriceMicroLamports?: number;
  consumerTransactionId?: string;
  dueAt?: string;
  note?: string;
}

interface PythPostParams {
  priceFeedIds: string[];
  closeUpdateAccounts: boolean;
  computeUnitPriceMicroLamports?: number;
  consumerTransactionId?: string;
}

function normalizePythPriceFeedInputs(input: PythPostPriceUpdateInput): string[] {
  const raw: string[] = [];
  const collect = (value: string | string[] | undefined): void => {
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    const trimmed = value?.trim();
    if (!trimmed) return;
    for (const entry of trimmed.split(/[,\n]/)) {
      const part = entry.trim();
      if (part) raw.push(part);
    }
  };
  collect(input.priceFeedIds);
  collect(input.priceFeedId);
  collect(input.symbol);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const alias = resolveAlias(entry);
    const normalized = normalizePriceFeedId(alias?.feedId ?? entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeOptionalPositiveInteger(
  value: number | string | undefined,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AdapterError(PYTH_ADAPTER_ID, 'invalid_request', `${field} must be a positive integer.`);
  }
  return parsed;
}

export const pythPostPriceUpdateAction: AdapterAction<PythPostPriceUpdateInput> = {
  id: 'post_price_update',
  kind: 'pyth_post_price_update',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const priceFeedIds = normalizePythPriceFeedInputs(input);
    if (priceFeedIds.length === 0) {
      throw new AdapterError(
        PYTH_ADAPTER_ID,
        'invalid_request',
        'priceFeedIds must contain at least one Pyth feed id.',
      );
    }
    if (priceFeedIds.length > PYTH_MAX_FEEDS_PER_POST) {
      throw new AdapterError(
        PYTH_ADAPTER_ID,
        'multi_tx_unsupported',
        `Pyth post price update v1 supports at most ${PYTH_MAX_FEEDS_PER_POST} feeds per transaction; received ${priceFeedIds.length}.`,
      );
    }
    const maxAgeSeconds = normalizeOptionalPositiveInteger(
      input.maxAgeSeconds,
      PYTH_DEFAULT_MAX_AGE_SECONDS,
      'maxAgeSeconds',
    );
    const closeUpdateAccounts = input.closeUpdateAccounts ?? true;
    const walletAddress = (input.payerAddress?.trim() || (await ctx.backend.getAddress())).trim();
    if (!walletAddress) {
      throw new AdapterError(
        PYTH_ADAPTER_ID,
        'unauthorized',
        'A wallet address is required to prepare a Pyth price update.',
      );
    }

    const batch = await getPriceFeedsBatchSnapshot(
      { priceFeedIds, maxAgeSeconds, includeEma: false },
      ctx,
    );
    const missing = batch.results.filter((entry) => entry.status === 'missing');
    if (missing.length > 0) {
      throw new AdapterError(
        PYTH_ADAPTER_ID,
        'feed_missing',
        `Hermes did not return prices for: ${missing.map((entry) => entry.priceFeedIdHex).join(', ')}.`,
      );
    }
    const staleFeeds = batch.results.filter(
      (entry): entry is { status: 'stale'; snapshot: import('./prices.js').PythPriceSnapshot } =>
        entry.status === 'stale',
    );
    if (staleFeeds.length > 0) {
      throw new AdapterError(
        PYTH_ADAPTER_ID,
        'stale_price',
        `Hermes prices for ${staleFeeds
          .map((entry) => entry.snapshot.priceFeedIdHex)
          .join(', ')} are older than ${maxAgeSeconds}s. Re-check before preparing.`,
      );
    }

    // programIds are resolved at execute time when the receiver SDK builds the
    // actual transaction. Prepare intentionally avoids invoking the SDK so the
    // approval inbox can be authored even when the SDK is missing — execute
    // surfaces sdk_missing with a structured error.
    const programIds: string[] = [];

    const summary = `Post Pyth price update for ${priceFeedIds
      .map(withFeedIdPrefix)
      .join(', ')}`;
    const snapshotRows = batch.results
      .filter(
        (entry): entry is { status: 'fresh' | 'stale'; snapshot: import('./prices.js').PythPriceSnapshot } =>
          entry.status === 'fresh' || entry.status === 'stale',
      )
      .map((entry) => entry.snapshot);
    const previewParams: Record<string, unknown> = {
      adapter: PYTH_ADAPTER_ID,
      connectorId: PYTH_ADAPTER_ID,
      action: 'post_price_update',
      operation: 'post_price_update',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      walletAddress,
      cluster: ctx.config.cluster,
      priceFeedIds,
      priceFeedIdHexes: priceFeedIds.map(withFeedIdPrefix),
      maxAgeSeconds,
      closeUpdateAccounts,
      priceSnapshot: snapshotRows.map((row) => ({
        priceFeedId: row.priceFeedId,
        priceFeedIdHex: row.priceFeedIdHex,
        priceUi: row.priceUi,
        priceRaw: row.priceRaw,
        exponent: row.exponent,
        publishTime: row.publishTime,
      })),
      confidenceSnapshot: snapshotRows.map((row) => ({
        priceFeedId: row.priceFeedId,
        confidenceUi: row.confidenceUi,
        confidenceRaw: row.confidenceRaw,
        confidenceBps: row.confidenceBps,
      })),
      publishTime: snapshotRows.reduce(
        (acc, row) => (row.publishTime > acc ? row.publishTime : acc),
        0,
      ),
      hermesUrlHost: clientHost(getPythClient().hermesUrl),
      programIds,
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
      ...(input.consumerTransactionId !== undefined && {
        consumerTransactionId: input.consumerTransactionId,
      }),
      ...(input.computeUnitPriceMicroLamports !== undefined && {
        computeUnitPriceMicroLamports: input.computeUnitPriceMicroLamports,
      }),
    };

    return {
      addInput: {
        kind: 'pyth_post_price_update',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params: previewParams,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: previewParams,
    };
  },

  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    const params = extractParams(action);
    const walletAddress = (await ctx.backend.getAddress()).trim();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Pyth post price update was prepared for ${action.walletAddress}, but the connected wallet is ${walletAddress}.`,
      );
    }
    const sdkReason = describePythReceiverUnavailableReason();
    if (sdkReason) {
      throw new AdapterError(PYTH_ADAPTER_ID, 'sdk_missing', sdkReason);
    }

    const update: PythHermesPriceUpdate = await getPythClient().getLatestPriceUpdates({
      priceFeedIds: params.priceFeedIds,
      encoding: 'hex',
      parsed: false,
    });
    const binaryData = update.binary?.data ?? [];
    if (binaryData.length === 0) {
      throw new AdapterError(
        PYTH_ADAPTER_ID,
        'hermes_unavailable',
        'Hermes returned no binary update data; refusing to build a post-price-update transaction.',
      );
    }

    const built = await getPythReceiver().buildPostPriceUpdate({
      walletAddress,
      priceUpdateDataHex: binaryData,
      closeUpdateAccounts: params.closeUpdateAccounts,
      ...(params.computeUnitPriceMicroLamports !== undefined
        ? { computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports }
        : {}),
    });
    if (built.transactionsBase64.length !== 1) {
      throw new AdapterError(
        PYTH_ADAPTER_ID,
        'multi_tx_unsupported',
        `Pyth post price update v1 expects exactly one transaction; receiver produced ${built.transactionsBase64.length}.`,
      );
    }
    const base64 = built.transactionsBase64[0];
    if (!base64) {
      throw new AdapterError(
        PYTH_ADAPTER_ID,
        'internal',
        'Pyth receiver returned an empty serialized transaction.',
      );
    }
    const summary = `Post Pyth price update for ${params.priceFeedIds
      .map(withFeedIdPrefix)
      .join(', ')}`;
    const txid = await ctx.signAndBroadcast(base64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        priceFeedIds: params.priceFeedIds,
        programIds: built.programIds,
        receiverProgramId: built.receiverProgramId,
      },
    };
  },
};

function extractParams(action: PreparedAction): PythPostParams {
  const raw = action.params;
  const priceFeedIdsRaw = Array.isArray(raw.priceFeedIds) ? raw.priceFeedIds : [];
  const priceFeedIds = priceFeedIdsRaw
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizePriceFeedId)
    .filter((id) => id.length > 0);
  if (priceFeedIds.length === 0) {
    throw new AdapterError(
      PYTH_ADAPTER_ID,
      'invalid_prepared_action',
      'Pyth prepared action is missing priceFeedIds.',
    );
  }
  const result: PythPostParams = {
    priceFeedIds,
    closeUpdateAccounts: raw.closeUpdateAccounts !== false,
  };
  if (typeof raw.computeUnitPriceMicroLamports === 'number') {
    result.computeUnitPriceMicroLamports = raw.computeUnitPriceMicroLamports;
  }
  if (typeof raw.consumerTransactionId === 'string') {
    result.consumerTransactionId = raw.consumerTransactionId;
  }
  return result;
}
