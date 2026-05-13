import type { AdapterRead, DAppAdapter } from '../types.js';

import {
  PYTH_ADAPTER_ID,
  PYTH_DESCRIPTION,
  PYTH_NAME,
  PYTH_PROGRAM_IDS,
  PYTH_SUPPORTED_CLUSTERS,
  PYTH_WEBSITE,
} from './constants.js';
import {
  pythPostPriceUpdateAction,
  type PythPostPriceUpdateInput,
} from './actions.js';
import { searchFeeds, type PythFeedSearchInput, type PythFeedSearchResult } from './feeds.js';
import {
  getPriceFeedSnapshot,
  getPriceFeedsBatchSnapshot,
  type GetPythPriceFeedInput,
  type GetPythPriceFeedsBatchInput,
  type PythPriceFeedSnapshotResult,
  type PythPriceFeedsBatchResult,
} from './prices.js';
import {
  getOnchainPriceAccountSnapshot,
  type GetPythOnchainAccountInput,
  type PythOnchainSnapshot,
} from './onchain.js';
import {
  getOracleEvidence,
  type GetPythOracleEvidenceInput,
  type PythOracleEvidence,
} from './evidence.js';

const priceFeedRead: AdapterRead<GetPythPriceFeedInput, PythPriceFeedSnapshotResult> = {
  id: 'price_feed',
  async read(input, ctx) {
    return getPriceFeedSnapshot(input, ctx);
  },
};

const priceFeedsBatchRead: AdapterRead<GetPythPriceFeedsBatchInput, PythPriceFeedsBatchResult> = {
  id: 'price_feeds_batch',
  async read(input, ctx) {
    return getPriceFeedsBatchSnapshot(input, ctx);
  },
};

const feedSearchRead: AdapterRead<PythFeedSearchInput, PythFeedSearchResult> = {
  id: 'feed_search',
  async read(input, ctx) {
    return searchFeeds(input, ctx);
  },
};

const onchainPriceAccountRead: AdapterRead<GetPythOnchainAccountInput, PythOnchainSnapshot> = {
  id: 'onchain_price_account',
  async read(input, ctx) {
    return getOnchainPriceAccountSnapshot(input, ctx);
  },
};

const oracleEvidenceRead: AdapterRead<GetPythOracleEvidenceInput, PythOracleEvidence> = {
  id: 'oracle_evidence',
  async read(input, ctx) {
    return getOracleEvidence(input, ctx);
  },
};

export const pythAdapter: DAppAdapter = {
  id: PYTH_ADAPTER_ID,
  name: PYTH_NAME,
  website: PYTH_WEBSITE,
  description: PYTH_DESCRIPTION,
  supportedClusters: PYTH_SUPPORTED_CLUSTERS,
  programIds: PYTH_PROGRAM_IDS,
  actions: {
    post_price_update: pythPostPriceUpdateAction,
  },
  reads: {
    price_feed: priceFeedRead,
    price_feeds_batch: priceFeedsBatchRead,
    feed_search: feedSearchRead,
    onchain_price_account: onchainPriceAccountRead,
    oracle_evidence: oracleEvidenceRead,
  },
};

export type { PythPostPriceUpdateInput };
export type {
  GetPythPriceFeedInput,
  GetPythPriceFeedsBatchInput,
  PythFeedSearchInput,
  PythFeedSearchResult,
  PythPriceFeedSnapshotResult,
  PythPriceFeedsBatchResult,
};
export type { GetPythOnchainAccountInput, PythOnchainSnapshot };
export type { GetPythOracleEvidenceInput, PythOracleEvidence };
export {
  PYTH_ADAPTER_ID,
  PYTH_DESCRIPTION,
  PYTH_NAME,
  PYTH_SUPPORTED_CLUSTERS,
  PYTH_WEBSITE,
};
