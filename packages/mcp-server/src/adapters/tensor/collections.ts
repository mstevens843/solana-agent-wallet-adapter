import type { DAppAdapterContext } from '../types.js';
import { AdapterError } from '../types.js';
import {
  resolveTensorClient,
  redactApiKey,
  type TensorBid,
  type TensorCollectionSnapshot,
  type TensorListing,
  type TensorSale,
  type TensorSupportedCollectionsResult,
} from './client.js';
import { MAX_BIDS, MAX_LISTINGS, TENSOR_ADAPTER_ID } from './constants.js';

export interface GetCollectionSnapshotInput {
  collectionId: string;
  includeListings?: boolean;
  includeBids?: boolean;
  maxListings?: number;
  maxBids?: number;
}

export interface TensorCollectionSnapshotResult {
  collection: TensorCollectionSnapshot;
  listings?: TensorListing[];
  bids?: TensorBid[];
}

export async function getSupportedCollections(
  ctx: DAppAdapterContext,
  input: { limit?: number } = {},
): Promise<TensorSupportedCollectionsResult> {
  try {
    return await resolveTensorClient(ctx).fetchSupportedCollections(ctx.connection, input);
  } catch (err) {
    throw wrapAsAdapterError(err, 'fetchSupportedCollections');
  }
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function requireCollectionId(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(TENSOR_ADAPTER_ID, 'missing_input', 'collectionId is required.');
  }
  return trimmed;
}

export async function getCollectionSnapshot(
  ctx: DAppAdapterContext,
  input: GetCollectionSnapshotInput,
): Promise<TensorCollectionSnapshotResult> {
  const collectionId = requireCollectionId(input.collectionId);
  try {
    const client = resolveTensorClient(ctx);
    const collection = await client.fetchCollectionStats(ctx.connection, collectionId);
    const wantListings = input.includeListings !== false;
    const wantBids = input.includeBids !== false;
    const maxListings = clampLimit(input.maxListings, 10, MAX_LISTINGS);
    const maxBids = clampLimit(input.maxBids, 10, MAX_BIDS);
    const [listings, bids] = await Promise.all([
      wantListings ? client.fetchCollectionListings(ctx.connection, collectionId, maxListings) : Promise.resolve(undefined),
      wantBids ? client.fetchCollectionBids(ctx.connection, collectionId, maxBids) : Promise.resolve(undefined),
    ]);
    return {
      collection,
      ...(listings !== undefined && { listings }),
      ...(bids !== undefined && { bids }),
    };
  } catch (err) {
    throw wrapAsAdapterError(err, 'fetchCollectionSnapshot');
  }
}

export async function getCollectionListings(
  ctx: DAppAdapterContext,
  input: { collectionId: string; limit?: number },
): Promise<{ collectionId: string; listings: TensorListing[] }> {
  const collectionId = requireCollectionId(input.collectionId);
  try {
    const limit = clampLimit(input.limit, 10, MAX_LISTINGS);
    const listings = await resolveTensorClient(ctx).fetchCollectionListings(ctx.connection, collectionId, limit);
    return { collectionId, listings };
  } catch (err) {
    throw wrapAsAdapterError(err, 'fetchCollectionListings');
  }
}

export async function getCollectionBids(
  ctx: DAppAdapterContext,
  input: { collectionId: string; limit?: number },
): Promise<{ collectionId: string; bids: TensorBid[] }> {
  const collectionId = requireCollectionId(input.collectionId);
  try {
    const limit = clampLimit(input.limit, 10, MAX_BIDS);
    const bids = await resolveTensorClient(ctx).fetchCollectionBids(ctx.connection, collectionId, limit);
    return { collectionId, bids };
  } catch (err) {
    throw wrapAsAdapterError(err, 'fetchCollectionBids');
  }
}

export async function getRecentSales(
  ctx: DAppAdapterContext,
  input: { collectionId: string; limit?: number },
): Promise<{ collectionId: string; sales: TensorSale[] }> {
  const collectionId = requireCollectionId(input.collectionId);
  try {
    const limit = clampLimit(input.limit, 25, 100);
    const sales = await resolveTensorClient(ctx).fetchRecentSales(ctx.connection, collectionId, limit);
    return { collectionId, sales };
  } catch (err) {
    throw wrapAsAdapterError(err, 'fetchRecentSales');
  }
}

function wrapAsAdapterError(err: unknown, method: string): Error {
  if (err instanceof AdapterError) {
    return new AdapterError(TENSOR_ADAPTER_ID, err.code, redactApiKey(err.message));
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AdapterError(
    TENSOR_ADAPTER_ID,
    'api_error',
    `Tensor ${method} failed: ${redactApiKey(message)}`,
  );
}
