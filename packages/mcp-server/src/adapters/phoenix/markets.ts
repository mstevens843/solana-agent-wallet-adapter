import { AdapterError, type DAppAdapterContext } from '../types.js';
import { PHOENIX_ADAPTER_ID, PHOENIX_DEFAULT_SYMBOL } from './constants.js';
import {
  resolvePhoenixClient,
  withPhoenixErrors,
  type PhoenixMarketSnapshot,
} from './client.js';

export interface GetPhoenixMarketSnapshotInput {
  symbol?: string;
}

export interface PhoenixMarketCatalogResult {
  markets: PhoenixMarketSnapshot[];
  asOf: string;
}

export async function getMarketSnapshot(
  ctx: DAppAdapterContext,
  input: GetPhoenixMarketSnapshotInput,
): Promise<PhoenixMarketSnapshot> {
  const symbol = (input.symbol ?? PHOENIX_DEFAULT_SYMBOL).trim();
  if (!symbol) {
    throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', 'symbol is required to read a Phoenix market snapshot.');
  }
  const client = resolvePhoenixClient(ctx);
  return withPhoenixErrors('fetchMarketSnapshot', () => client.fetchMarketSnapshot({ symbol }));
}

export async function getMarketCatalog(ctx: DAppAdapterContext): Promise<PhoenixMarketCatalogResult> {
  const client = resolvePhoenixClient(ctx);
  const markets = await withPhoenixErrors('fetchMarketCatalog', () => client.fetchMarketCatalog());
  return { markets, asOf: new Date().toISOString() };
}
