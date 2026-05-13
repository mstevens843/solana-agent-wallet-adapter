import { Decimal } from 'decimal.js';

import type { DAppAdapterContext } from '../types.js';
import { AdapterError } from '../types.js';

import { getPythClient, type PythHermesPriceUpdateRow } from './client.js';
import {
  PYTH_ADAPTER_ID,
  PYTH_DEFAULT_MAX_AGE_SECONDS,
  PYTH_MAX_BATCH_READ,
  normalizePriceFeedId,
  withFeedIdPrefix,
} from './constants.js';
import { clientHost, resolveFeedId, type PythFeedMetadata } from './feeds.js';

export type PythPriceStatus = 'fresh' | 'stale' | 'missing';

export interface PythEmaSnapshot {
  priceRaw: string;
  priceUi: string;
  confidenceRaw: string;
  confidenceUi: string;
  publishTime: number;
}

export interface PythPriceSnapshot {
  priceFeedId: string;
  priceFeedIdHex: string;
  symbol?: string;
  displayName?: string;
  priceRaw: string;
  priceUi: string;
  confidenceRaw: string;
  confidenceUi: string;
  confidenceBps: number | null;
  exponent: number;
  publishTime: number;
  ageSeconds: number;
  status: PythPriceStatus;
  maxAgeSeconds: number;
  ema?: PythEmaSnapshot;
  hermesUrlHost: string;
  asOfIso: string;
}

export interface PythPriceFeedSnapshotResult {
  snapshot: PythPriceSnapshot;
}

export interface PythPriceFeedsBatchResult {
  results: Array<
    | { status: 'fresh' | 'stale'; snapshot: PythPriceSnapshot }
    | { status: 'missing'; priceFeedId: string; priceFeedIdHex: string; reason: string }
  >;
  asOfIso: string;
  hermesUrlHost: string;
  totals: { requested: number; fresh: number; stale: number; missing: number };
}

export interface GetPythPriceFeedInput {
  priceFeedId?: string;
  symbol?: string;
  maxAgeSeconds?: number;
  includeEma?: boolean;
}

export interface GetPythPriceFeedsBatchInput {
  priceFeedIds: string[];
  maxAgeSeconds?: number;
  includeEma?: boolean;
}

export async function getPriceFeedSnapshot(
  input: GetPythPriceFeedInput,
  ctx: DAppAdapterContext,
): Promise<PythPriceFeedSnapshotResult> {
  const metadata = await resolveFeedId(
    {
      ...(input.priceFeedId !== undefined ? { priceFeedId: input.priceFeedId } : {}),
      ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
    },
    ctx,
  );
  const maxAgeSeconds = input.maxAgeSeconds ?? PYTH_DEFAULT_MAX_AGE_SECONDS;
  const includeEma = input.includeEma ?? true;
  const client = getPythClient();
  const update = await client.getLatestPriceUpdates({
    priceFeedIds: [metadata.priceFeedId],
    encoding: 'hex',
    parsed: true,
  });
  const row = update.rows.find((entry) => entry.priceFeedId === metadata.priceFeedId);
  if (!row) {
    throw new AdapterError(
      PYTH_ADAPTER_ID,
      'feed_missing',
      `Hermes did not return a price for feed ${metadata.priceFeedIdHex}.`,
    );
  }
  const snapshot = buildSnapshot(row, metadata, {
    maxAgeSeconds,
    includeEma,
    hermesUrlHost: clientHost(client.hermesUrl),
  });
  return { snapshot };
}

export async function getPriceFeedsBatchSnapshot(
  input: GetPythPriceFeedsBatchInput,
  _ctx: DAppAdapterContext,
): Promise<PythPriceFeedsBatchResult> {
  const ids = (input.priceFeedIds ?? [])
    .map(normalizePriceFeedId)
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new AdapterError(PYTH_ADAPTER_ID, 'invalid_request', 'priceFeedIds must contain at least one feed id.');
  }
  if (ids.length > PYTH_MAX_BATCH_READ) {
    throw new AdapterError(
      PYTH_ADAPTER_ID,
      'batch_too_large',
      `Batch read accepts at most ${PYTH_MAX_BATCH_READ} feeds per call; received ${ids.length}.`,
    );
  }
  void _ctx;
  const maxAgeSeconds = input.maxAgeSeconds ?? PYTH_DEFAULT_MAX_AGE_SECONDS;
  const includeEma = input.includeEma ?? true;
  const client = getPythClient();
  const update = await client.getLatestPriceUpdates({
    priceFeedIds: ids,
    encoding: 'hex',
    parsed: true,
    ignoreInvalidPriceIds: true,
  });
  const hermesUrlHost = clientHost(client.hermesUrl);
  const asOfIso = new Date().toISOString();
  const rowsById = new Map<string, PythHermesPriceUpdateRow>();
  for (const row of update.rows) rowsById.set(row.priceFeedId, row);
  const results: PythPriceFeedsBatchResult['results'] = [];
  let fresh = 0;
  let stale = 0;
  let missing = 0;
  for (const id of ids) {
    const row = rowsById.get(id);
    const priceFeedIdHex = withFeedIdPrefix(id);
    if (!row) {
      missing += 1;
      results.push({
        status: 'missing',
        priceFeedId: id,
        priceFeedIdHex,
        reason: 'Hermes did not return a price for this feed id.',
      });
      continue;
    }
    const snapshot = buildSnapshot(row, undefinedMetadata(id), {
      maxAgeSeconds,
      includeEma,
      hermesUrlHost,
    });
    if (snapshot.status === 'fresh') fresh += 1;
    else if (snapshot.status === 'stale') stale += 1;
    results.push({ status: snapshot.status === 'stale' ? 'stale' : 'fresh', snapshot });
  }
  return {
    results,
    asOfIso,
    hermesUrlHost,
    totals: { requested: ids.length, fresh, stale, missing },
  };
}

function undefinedMetadata(priceFeedId: string): PythFeedMetadata {
  return {
    priceFeedId,
    priceFeedIdHex: withFeedIdPrefix(priceFeedId),
    source: 'hermes',
  };
}

function buildSnapshot(
  row: PythHermesPriceUpdateRow,
  metadata: PythFeedMetadata,
  ctx: { maxAgeSeconds: number; includeEma: boolean; hermesUrlHost: string },
): PythPriceSnapshot {
  const asOfIso = new Date().toISOString();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, nowSeconds - row.publishTime);
  const priceUi = formatScaled(row.priceRaw, row.exponent);
  const confidenceUi = formatScaled(row.confidenceRaw, row.exponent);
  const confidenceBps = computeConfidenceBps(row.priceRaw, row.confidenceRaw);
  const status: PythPriceStatus = ageSeconds > ctx.maxAgeSeconds ? 'stale' : 'fresh';
  const snapshot: PythPriceSnapshot = {
    priceFeedId: row.priceFeedId,
    priceFeedIdHex: withFeedIdPrefix(row.priceFeedId),
    priceRaw: row.priceRaw,
    priceUi,
    confidenceRaw: row.confidenceRaw,
    confidenceUi,
    confidenceBps,
    exponent: row.exponent,
    publishTime: row.publishTime,
    ageSeconds,
    status,
    maxAgeSeconds: ctx.maxAgeSeconds,
    hermesUrlHost: ctx.hermesUrlHost,
    asOfIso,
  };
  if (metadata.symbol) snapshot.symbol = metadata.symbol;
  if (metadata.displayName) snapshot.displayName = metadata.displayName;
  if (ctx.includeEma && row.emaPriceRaw !== undefined && row.emaConfidenceRaw !== undefined) {
    snapshot.ema = {
      priceRaw: row.emaPriceRaw,
      priceUi: formatScaled(row.emaPriceRaw, row.exponent),
      confidenceRaw: row.emaConfidenceRaw,
      confidenceUi: formatScaled(row.emaConfidenceRaw, row.exponent),
      publishTime: row.emaPublishTime ?? row.publishTime,
    };
  }
  return snapshot;
}

export function formatScaled(raw: string, exponent: number): string {
  if (!raw) return '0';
  let value: ReturnType<typeof Decimal>;
  try {
    value = Decimal(raw);
  } catch {
    return raw;
  }
  if (!value.isFinite()) return '0';
  const scaled = value.times(Decimal(10).pow(exponent));
  if (scaled.isZero()) return '0';
  const absExpo = Math.abs(exponent);
  const precision = exponent < 0 ? Math.min(absExpo, 12) : 0;
  const formatted = scaled.toFixed(precision);
  if (formatted.includes('.')) {
    return formatted.replace(/0+$/, '').replace(/\.$/, '');
  }
  return formatted;
}

export function computeConfidenceBps(priceRaw: string, confidenceRaw: string): number | null {
  let price: ReturnType<typeof Decimal>;
  let conf: ReturnType<typeof Decimal>;
  try {
    price = Decimal(priceRaw);
    conf = Decimal(confidenceRaw);
  } catch {
    return null;
  }
  if (!price.isFinite() || !conf.isFinite()) return null;
  if (price.isZero()) return null;
  const bps = conf.div(price.abs()).times(10_000);
  if (!bps.isFinite()) return null;
  const rounded = bps.toDecimalPlaces(2).toNumber();
  return Number.isFinite(rounded) ? rounded : null;
}
