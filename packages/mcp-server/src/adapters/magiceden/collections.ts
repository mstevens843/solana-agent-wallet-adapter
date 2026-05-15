import type { DAppAdapterContext } from '../types.js';

import {
  resolveMagicedenClient,
  type MagicedenCollectionBids,
  type MagicedenCollectionListings,
  type MagicedenCollectionSummary,
  type MagicedenTopCollections,
  type MagicedenNftDetail,
  type MagicedenRecentActivity,
} from './client.js';

export interface CollectionSnapshotInput {
  collectionSymbol?: string;
  collectionId?: string;
  includeListings?: boolean;
  includeBids?: boolean;
  limit?: number;
}

export interface CollectionSnapshotResult {
  summary: MagicedenCollectionSummary;
  listings?: MagicedenCollectionListings;
  bids?: MagicedenCollectionBids;
}

export async function getTopCollections(
  input: { limit?: number; timeRange?: string },
  ctx: DAppAdapterContext,
): Promise<MagicedenTopCollections> {
  return resolveMagicedenClient(ctx).getTopCollections(input);
}

export async function getCollectionSnapshot(
  input: CollectionSnapshotInput,
  ctx: DAppAdapterContext,
): Promise<CollectionSnapshotResult> {
  const client = resolveMagicedenClient(ctx);
  const wantListings = input.includeListings !== false;
  const wantBids = input.includeBids !== false;
  const [summary, listings, bids] = await Promise.all([
    client.getCollectionSummary({
      ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    }),
    wantListings
      ? client.getCollectionListings({
          ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
          ...(input.collectionId ? { collectionId: input.collectionId } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
      : Promise.resolve(undefined),
    wantBids
      ? client.getCollectionBids({
          ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
          ...(input.collectionId ? { collectionId: input.collectionId } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
      : Promise.resolve(undefined),
  ]);
  return {
    summary,
    ...(listings ? { listings } : {}),
    ...(bids ? { bids } : {}),
  };
}

export async function getCollectionListings(
  input: { collectionSymbol?: string; collectionId?: string; limit?: number },
  ctx: DAppAdapterContext,
): Promise<MagicedenCollectionListings> {
  return resolveMagicedenClient(ctx).getCollectionListings({
    ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
    ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
}

export async function getCollectionBids(
  input: { collectionSymbol?: string; collectionId?: string; limit?: number },
  ctx: DAppAdapterContext,
): Promise<MagicedenCollectionBids> {
  return resolveMagicedenClient(ctx).getCollectionBids({
    ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
    ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
}

export async function getRecentActivity(
  input: { collectionSymbol?: string; collectionId?: string; limit?: number },
  ctx: DAppAdapterContext,
): Promise<MagicedenRecentActivity> {
  return resolveMagicedenClient(ctx).getRecentActivity({
    ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
    ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
}

export async function getNftDetail(
  input: { mintAddress: string; includeListing?: boolean; includeBids?: boolean },
  ctx: DAppAdapterContext,
): Promise<MagicedenNftDetail> {
  return resolveMagicedenClient(ctx).getNftDetail({
    mintAddress: input.mintAddress,
    ...(input.includeListing !== undefined ? { includeListing: input.includeListing } : {}),
    ...(input.includeBids !== undefined ? { includeBids: input.includeBids } : {}),
  });
}
