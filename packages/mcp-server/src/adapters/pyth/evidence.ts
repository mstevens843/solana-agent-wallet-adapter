import type { DAppAdapterContext } from '../types.js';
import { AdapterError } from '../types.js';

import {
  PYTH_ADAPTER_ID,
  PYTH_DEFAULT_MAX_AGE_SECONDS,
  PYTH_DEFAULT_MAX_CONFIDENCE_BPS,
  type PythEvidenceStatus,
  withFeedIdPrefix,
} from './constants.js';
import { getPriceFeedSnapshot, type PythPriceSnapshot } from './prices.js';
import { resolveFeedId, clientHost } from './feeds.js';
import { getPythClient } from './client.js';

export interface PythOracleEvidence {
  status: PythEvidenceStatus;
  priceFeedId: string;
  priceFeedIdHex: string;
  symbol?: string;
  displayName?: string;
  priceUi?: string;
  confidenceUi?: string;
  confidenceBps?: number | null;
  exponent?: number;
  publishTime?: number;
  ageSeconds?: number;
  maxAgeSeconds: number;
  maxConfidenceBps: number;
  hermesUrlHost: string;
  consumerProtocol?: string;
  reason?: string;
  asOfIso: string;
}

export interface GetPythOracleEvidenceInput {
  priceFeedId?: string;
  symbol?: string;
  consumerProtocol?: string;
  maxAgeSeconds?: number;
  maxConfidenceBps?: number;
}

export async function getOracleEvidence(
  input: GetPythOracleEvidenceInput,
  ctx: DAppAdapterContext,
): Promise<PythOracleEvidence> {
  if (!input.priceFeedId?.trim() && !input.symbol?.trim()) {
    throw new AdapterError(
      PYTH_ADAPTER_ID,
      'invalid_request',
      'Provide priceFeedId or symbol to compute Pyth oracle evidence.',
    );
  }
  const maxAgeSeconds = input.maxAgeSeconds ?? PYTH_DEFAULT_MAX_AGE_SECONDS;
  const maxConfidenceBps = input.maxConfidenceBps ?? PYTH_DEFAULT_MAX_CONFIDENCE_BPS;
  const hermesUrlHost = clientHost(getPythClient().hermesUrl);
  const asOfIso = new Date().toISOString();
  let metadata;
  try {
    metadata = await resolveFeedId(
      {
        ...(input.priceFeedId !== undefined ? { priceFeedId: input.priceFeedId } : {}),
        ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
      },
      ctx,
    );
  } catch (err) {
    if (err instanceof AdapterError && err.code === 'unknown_symbol') {
      return {
        status: 'missing',
        priceFeedId: input.priceFeedId ?? '',
        priceFeedIdHex: withFeedIdPrefix(input.priceFeedId ?? ''),
        maxAgeSeconds,
        maxConfidenceBps,
        hermesUrlHost,
        ...(input.consumerProtocol ? { consumerProtocol: input.consumerProtocol } : {}),
        reason: err.message,
        asOfIso,
      };
    }
    throw err;
  }
  let snapshot: PythPriceSnapshot;
  try {
    const result = await getPriceFeedSnapshot(
      { priceFeedId: metadata.priceFeedId, maxAgeSeconds, includeEma: false },
      ctx,
    );
    snapshot = result.snapshot;
  } catch (err) {
    if (err instanceof AdapterError && err.code === 'feed_missing') {
      return {
        status: 'missing',
        priceFeedId: metadata.priceFeedId,
        priceFeedIdHex: metadata.priceFeedIdHex,
        ...(metadata.symbol ? { symbol: metadata.symbol } : {}),
        ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
        maxAgeSeconds,
        maxConfidenceBps,
        hermesUrlHost,
        ...(input.consumerProtocol ? { consumerProtocol: input.consumerProtocol } : {}),
        reason: err.message,
        asOfIso,
      };
    }
    return {
      status: 'api_unavailable',
      priceFeedId: metadata.priceFeedId,
      priceFeedIdHex: metadata.priceFeedIdHex,
      ...(metadata.symbol ? { symbol: metadata.symbol } : {}),
      ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
      maxAgeSeconds,
      maxConfidenceBps,
      hermesUrlHost,
      ...(input.consumerProtocol ? { consumerProtocol: input.consumerProtocol } : {}),
      reason: err instanceof Error ? err.message : 'Hermes request failed.',
      asOfIso,
    };
  }
  const status = deriveStatus(snapshot, maxAgeSeconds, maxConfidenceBps);
  const evidence: PythOracleEvidence = {
    status,
    priceFeedId: snapshot.priceFeedId,
    priceFeedIdHex: snapshot.priceFeedIdHex,
    priceUi: snapshot.priceUi,
    confidenceUi: snapshot.confidenceUi,
    confidenceBps: snapshot.confidenceBps,
    exponent: snapshot.exponent,
    publishTime: snapshot.publishTime,
    ageSeconds: snapshot.ageSeconds,
    maxAgeSeconds,
    maxConfidenceBps,
    hermesUrlHost,
    asOfIso,
  };
  if (snapshot.symbol) evidence.symbol = snapshot.symbol;
  const displayName = snapshot.displayName ?? metadata.displayName;
  if (displayName) evidence.displayName = displayName;
  if (input.consumerProtocol) evidence.consumerProtocol = input.consumerProtocol;
  if (status === 'stale') {
    evidence.reason = `Price is ${snapshot.ageSeconds}s old; older than max ${maxAgeSeconds}s.`;
  } else if (status === 'wide_confidence' && typeof snapshot.confidenceBps === 'number') {
    evidence.reason = `Confidence is ${snapshot.confidenceBps.toFixed(2)} bps; wider than max ${maxConfidenceBps} bps.`;
  }
  return evidence;
}

function deriveStatus(
  snapshot: PythPriceSnapshot,
  maxAgeSeconds: number,
  maxConfidenceBps: number,
): PythEvidenceStatus {
  if (snapshot.ageSeconds > maxAgeSeconds) return 'stale';
  if (typeof snapshot.confidenceBps === 'number' && snapshot.confidenceBps > maxConfidenceBps) {
    return 'wide_confidence';
  }
  return 'fresh';
}
