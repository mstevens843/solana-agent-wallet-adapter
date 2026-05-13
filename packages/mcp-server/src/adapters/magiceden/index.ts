import type { AdapterRead, DAppAdapter } from '../types.js';

import {
  magicedenBidAction,
  magicedenBuyAction,
  magicedenCancelBidAction,
  magicedenCancelListingAction,
  magicedenListAction,
  type MagicedenBidPrepareInput,
  type MagicedenBuyPrepareInput,
  type MagicedenCancelBidPrepareInput,
  type MagicedenCancelListingPrepareInput,
  type MagicedenListPrepareInput,
} from './actions.js';
import {
  MAGICEDEN_ADAPTER_ID,
  MAGICEDEN_DESCRIPTION,
  MAGICEDEN_NAME,
  MAGICEDEN_PROGRAM_IDS,
  MAGICEDEN_SUPPORTED_CLUSTERS,
  MAGICEDEN_WEBSITE,
} from './constants.js';
import {
  getCollectionBids,
  getCollectionListings,
  getCollectionSnapshot,
  getNftDetail,
  getRecentActivity,
} from './collections.js';
import { getApiHealthSnapshot } from './health.js';
import { getWalletNfts } from './wallet.js';

const apiHealthRead: AdapterRead<{ includeTradingEndpoints?: boolean }, unknown> = {
  id: 'api_health',
  async read(input) {
    return getApiHealthSnapshot(input);
  },
};

const collectionSnapshotRead: AdapterRead<Parameters<typeof getCollectionSnapshot>[0], unknown> = {
  id: 'collection_snapshot',
  async read(input, ctx) {
    return getCollectionSnapshot(input, ctx);
  },
};

const collectionListingsRead: AdapterRead<Parameters<typeof getCollectionListings>[0], unknown> = {
  id: 'collection_listings',
  async read(input, ctx) {
    return getCollectionListings(input, ctx);
  },
};

const collectionBidsRead: AdapterRead<Parameters<typeof getCollectionBids>[0], unknown> = {
  id: 'collection_bids',
  async read(input, ctx) {
    return getCollectionBids(input, ctx);
  },
};

const recentActivityRead: AdapterRead<Parameters<typeof getRecentActivity>[0], unknown> = {
  id: 'recent_activity',
  async read(input, ctx) {
    return getRecentActivity(input, ctx);
  },
};

const walletNftsRead: AdapterRead<Parameters<typeof getWalletNfts>[0], unknown> = {
  id: 'wallet_nfts',
  async read(input, ctx) {
    return getWalletNfts(input, ctx);
  },
};

const nftDetailRead: AdapterRead<Parameters<typeof getNftDetail>[0], unknown> = {
  id: 'nft_detail',
  async read(input, ctx) {
    return getNftDetail(input, ctx);
  },
};

export const magicedenAdapter: DAppAdapter = {
  id: MAGICEDEN_ADAPTER_ID,
  name: MAGICEDEN_NAME,
  website: MAGICEDEN_WEBSITE,
  description: MAGICEDEN_DESCRIPTION,
  supportedClusters: MAGICEDEN_SUPPORTED_CLUSTERS,
  programIds: MAGICEDEN_PROGRAM_IDS,
  actions: {
    buy: magicedenBuyAction,
    list: magicedenListAction,
    cancel_listing: magicedenCancelListingAction,
    bid: magicedenBidAction,
    cancel_bid: magicedenCancelBidAction,
  },
  reads: {
    api_health: apiHealthRead,
    collection_snapshot: collectionSnapshotRead,
    collection_listings: collectionListingsRead,
    collection_bids: collectionBidsRead,
    recent_activity: recentActivityRead,
    wallet_nfts: walletNftsRead,
    nft_detail: nftDetailRead,
  },
};

export type {
  MagicedenBidPrepareInput,
  MagicedenBuyPrepareInput,
  MagicedenCancelBidPrepareInput,
  MagicedenCancelListingPrepareInput,
  MagicedenListPrepareInput,
};

export {
  MAGICEDEN_ADAPTER_ID,
  MAGICEDEN_DESCRIPTION,
  MAGICEDEN_NAME,
  MAGICEDEN_SUPPORTED_CLUSTERS,
  MAGICEDEN_WEBSITE,
};
