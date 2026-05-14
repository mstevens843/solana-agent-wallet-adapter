import type { DAppAdapterContext } from '../types.js';

import {
  getMagicedenClient,
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
  _ctx: DAppAdapterContext,
): Promise<MagicedenTopCollections> {
  return getMagicedenClient().getTopCollections(input);
}

export async function getCollectionSnapshot(
  input: CollectionSnapshotInput,
  _ctx: DAppAdapterContext,
): Promise<CollectionSnapshotResult> {
  const client = getMagicedenClient();
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
  _ctx: DAppAdapterContext,
): Promise<MagicedenCollectionListings> {
  return getMagicedenClient().getCollectionListings({
    ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
    ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
}

export async function getCollectionBids(
  input: { collectionSymbol?: string; collectionId?: string; limit?: number },
  _ctx: DAppAdapterContext,
): Promise<MagicedenCollectionBids> {
  return getMagicedenClient().getCollectionBids({
    ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
    ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
}

export async function getRecentActivity(
  input: { collectionSymbol?: string; collectionId?: string; limit?: number },
  _ctx: DAppAdapterContext,
): Promise<MagicedenRecentActivity> {
  return getMagicedenClient().getRecentActivity({
    ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
    ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
}

export async function getNftDetail(
  input: { mintAddress: string; includeListing?: boolean; includeBids?: boolean },
  _ctx: DAppAdapterContext,
): Promise<MagicedenNftDetail> {
  return getMagicedenClient().getNftDetail({
    mintAddress: input.mintAddress,
    ...(input.includeListing !== undefined ? { includeListing: input.includeListing } : {}),
    ...(input.includeBids !== undefined ? { includeBids: input.includeBids } : {}),
  });
}
