import type { AdapterRead, DAppAdapter } from '../types.js';
import { tensorBuyAction, type TensorBuyPrepareInput } from './buy.js';
import {
  TENSOR_ADAPTER_ID,
  TENSOR_AMM_PROGRAM_ID,
  TENSOR_DESCRIPTION,
  TENSOR_ESCROW_PROGRAM_ID,
  TENSOR_FEES_PROGRAM_ID,
  TENSOR_MARKETPLACE_PROGRAM_ID,
  TENSOR_NAME,
  TENSOR_SUPPORTED_CLUSTERS,
  TENSOR_WEBSITE,
  TENSOR_WHITELIST_PROGRAM_ID,
} from './constants.js';
import {
  getCollectionBids,
  getCollectionListings,
  getCollectionSnapshot,
  getRecentSales,
  type GetCollectionSnapshotInput,
  type TensorCollectionSnapshotResult,
} from './collections.js';
import {
  tensorBidAction,
  tensorCancelBidAction,
  type TensorBidPrepareInput,
  type TensorCancelBidPrepareInput,
} from './bids.js';
import {
  tensorCancelListingAction,
  tensorListAction,
  type TensorCancelListingPrepareInput,
  type TensorListPrepareInput,
} from './listings.js';
import { tensorSweepAction, type TensorSweepPrepareInput } from './sweep.js';
import {
  getNftDetail,
  getWalletMarketplaceExposure,
  getWalletNfts,
  type GetWalletNftsInput,
} from './wallet.js';

const collectionSnapshotRead: AdapterRead<GetCollectionSnapshotInput, TensorCollectionSnapshotResult> = {
  id: 'collection_snapshot',
  async read(input, ctx) {
    return getCollectionSnapshot(ctx, input);
  },
};

const collectionListingsRead: AdapterRead<{ collectionId: string; limit?: number }, unknown> = {
  id: 'collection_listings',
  async read(input, ctx) {
    return getCollectionListings(ctx, input);
  },
};

const collectionBidsRead: AdapterRead<{ collectionId: string; limit?: number }, unknown> = {
  id: 'collection_bids',
  async read(input, ctx) {
    return getCollectionBids(ctx, input);
  },
};

const recentSalesRead: AdapterRead<{ collectionId: string; limit?: number }, unknown> = {
  id: 'recent_sales',
  async read(input, ctx) {
    return getRecentSales(ctx, input);
  },
};

const walletNftsRead: AdapterRead<GetWalletNftsInput, unknown> = {
  id: 'wallet_nfts',
  async read(input, ctx) {
    return getWalletNfts(ctx, input);
  },
};

const nftDetailRead: AdapterRead<{ mintAddress?: string; assetId?: string }, unknown> = {
  id: 'nft_detail',
  async read(input, ctx) {
    return getNftDetail(ctx, input);
  },
};

const walletMarketplaceExposureRead: AdapterRead<{ walletAddress?: string }, unknown> = {
  id: 'wallet_marketplace_exposure',
  async read(input, ctx) {
    return getWalletMarketplaceExposure(ctx, input);
  },
};

export const tensorAdapter: DAppAdapter = {
  id: TENSOR_ADAPTER_ID,
  name: TENSOR_NAME,
  website: TENSOR_WEBSITE,
  description: TENSOR_DESCRIPTION,
  supportedClusters: TENSOR_SUPPORTED_CLUSTERS,
  programIds: [
    TENSOR_MARKETPLACE_PROGRAM_ID,
    TENSOR_AMM_PROGRAM_ID,
    TENSOR_ESCROW_PROGRAM_ID,
    TENSOR_WHITELIST_PROGRAM_ID,
    TENSOR_FEES_PROGRAM_ID,
  ],
  actions: {
    buy: tensorBuyAction,
    list: tensorListAction,
    cancel_listing: tensorCancelListingAction,
    bid: tensorBidAction,
    cancel_bid: tensorCancelBidAction,
    sweep: tensorSweepAction,
  },
  reads: {
    collection_snapshot: collectionSnapshotRead,
    collection_listings: collectionListingsRead,
    collection_bids: collectionBidsRead,
    recent_sales: recentSalesRead,
    wallet_nfts: walletNftsRead,
    nft_detail: nftDetailRead,
    wallet_marketplace_exposure: walletMarketplaceExposureRead,
  },
};

export type {
  GetCollectionSnapshotInput,
  GetWalletNftsInput,
  TensorBidPrepareInput,
  TensorBuyPrepareInput,
  TensorCancelBidPrepareInput,
  TensorCancelListingPrepareInput,
  TensorCollectionSnapshotResult,
  TensorListPrepareInput,
  TensorSweepPrepareInput,
};
export {
  TENSOR_ADAPTER_ID,
  TENSOR_NAME,
  TENSOR_WEBSITE,
  TENSOR_DESCRIPTION,
  TENSOR_SUPPORTED_CLUSTERS,
};
