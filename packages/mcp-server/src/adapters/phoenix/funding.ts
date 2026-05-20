import { AdapterError, type DAppAdapterContext } from '../types.js';
import { PHOENIX_ADAPTER_ID } from './constants.js';
import {
  resolvePhoenixClient,
  withPhoenixErrors,
  type PhoenixFundingHistoryEntry,
} from './client.js';

export interface GetPhoenixFundingHistoryInput {
  symbol?: string;
  limit?: number;
}

export interface PhoenixFundingHistoryResult {
  symbol: string;
  entries: PhoenixFundingHistoryEntry[];
  asOf: string;
}

export async function getFundingHistory(
  ctx: DAppAdapterContext,
  input: GetPhoenixFundingHistoryInput,
): Promise<PhoenixFundingHistoryResult> {
  const symbol = (input.symbol ?? '').trim();
  if (!symbol) {
    throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', 'symbol is required to read Phoenix funding history.');
  }
  const limit = input.limit;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0 || limit > 500)) {
    throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', 'limit must be a positive integer ≤ 500.');
  }
  const client = resolvePhoenixClient(ctx);
  const entries = await withPhoenixErrors('fetchFundingHistory', () =>
    client.fetchFundingHistory({
      symbol,
      ...(limit !== undefined ? { limit } : {}),
    }),
  );
  return { symbol, entries, asOf: new Date().toISOString() };
}
