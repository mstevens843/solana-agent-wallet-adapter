import type { AdapterRead, DAppAdapter } from '../types.js';
import {
  WORMHOLE_ADAPTER_ID,
  WORMHOLE_CORE_BRIDGE_PROGRAM_ID,
  WORMHOLE_DESCRIPTION,
  WORMHOLE_NAME,
  WORMHOLE_SUPPORTED_CLUSTERS,
  WORMHOLE_TOKEN_BRIDGE_PROGRAM_ID,
  WORMHOLE_WEBSITE,
} from './constants.js';
import {
  wormholeRecoverOrResumeAction,
  wormholeRedeemAction,
  wormholeTransferAction,
  type WormholeRecoverOrResumeInput,
  type WormholeRedeemInput,
  type WormholeTransferInput,
} from './actions.js';
import {
  getWormholeQuote,
  getWormholeTokenSnapshot,
  type WormholeQuoteReadInput,
  type WormholeTokenSnapshotInput,
} from './quotes.js';
import {
  getWormholeSupportedRoutes,
  type WormholeSupportedRoutesInput,
} from './routes.js';
import {
  getWormholeTransferStatus,
  getWormholeWalletBridgeExposure,
  type WormholeTransferStatusInput,
  type WormholeWalletBridgeExposureInput,
} from './status.js';

const supportedRoutesRead: AdapterRead<WormholeSupportedRoutesInput, unknown> = {
  id: 'supported_routes',
  async read(input, ctx) {
    return getWormholeSupportedRoutes(ctx, input);
  },
};

const tokenSnapshotRead: AdapterRead<WormholeTokenSnapshotInput, unknown> = {
  id: 'token_snapshot',
  async read(input, ctx) {
    return getWormholeTokenSnapshot(ctx, input);
  },
};

const quoteRead: AdapterRead<WormholeQuoteReadInput, unknown> = {
  id: 'quote',
  async read(input, ctx) {
    return getWormholeQuote(ctx, input);
  },
};

const transferStatusRead: AdapterRead<WormholeTransferStatusInput, unknown> = {
  id: 'transfer_status',
  async read(input, ctx) {
    return getWormholeTransferStatus(ctx, input);
  },
};

const walletBridgeExposureRead: AdapterRead<WormholeWalletBridgeExposureInput, unknown> = {
  id: 'wallet_bridge_exposure',
  async read(input, ctx) {
    return getWormholeWalletBridgeExposure(ctx, input);
  },
};

export const wormholeAdapter: DAppAdapter = {
  id: WORMHOLE_ADAPTER_ID,
  name: WORMHOLE_NAME,
  website: WORMHOLE_WEBSITE,
  description: WORMHOLE_DESCRIPTION,
  supportedClusters: WORMHOLE_SUPPORTED_CLUSTERS,
  programIds: [
    WORMHOLE_CORE_BRIDGE_PROGRAM_ID,
    WORMHOLE_TOKEN_BRIDGE_PROGRAM_ID,
  ],
  actions: {
    transfer: wormholeTransferAction,
    redeem: wormholeRedeemAction,
    recover_or_resume: wormholeRecoverOrResumeAction,
  },
  reads: {
    supported_routes: supportedRoutesRead,
    token_snapshot: tokenSnapshotRead,
    quote: quoteRead,
    transfer_status: transferStatusRead,
    wallet_bridge_exposure: walletBridgeExposureRead,
  },
};

export type {
  WormholeQuoteReadInput,
  WormholeRecoverOrResumeInput,
  WormholeRedeemInput,
  WormholeSupportedRoutesInput,
  WormholeTokenSnapshotInput,
  WormholeTransferInput,
  WormholeTransferStatusInput,
  WormholeWalletBridgeExposureInput,
};
export {
  WORMHOLE_ADAPTER_ID,
  WORMHOLE_DESCRIPTION,
  WORMHOLE_NAME,
  WORMHOLE_SUPPORTED_CLUSTERS,
  WORMHOLE_WEBSITE,
};
