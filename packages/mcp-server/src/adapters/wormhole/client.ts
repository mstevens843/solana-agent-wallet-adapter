import type { Connection } from '@solana/web3.js';

import { AdapterError } from '../types.js';
import {
  WORMHOLE_ADAPTER_ID,
  WORMHOLE_FEATURE_FLAG_ENV,
  WORMHOLE_RPC_BASE_URL_ENV,
  type WormholeNetwork,
  type WormholeRouteMode,
  type WormholeRouteType,
  type WormholeTransferState,
} from './constants.js';

export interface WormholeRouteSnapshot {
  sourceChain: string;
  destinationChain: string;
  routeType: WormholeRouteType;
  mode: WormholeRouteMode;
  supported: boolean;
  prepareSupported: boolean;
  manualRedemptionRequired: boolean;
  relayerSupported: boolean;
  sourceMint?: string;
  destinationToken?: string;
  bridgeFee?: string;
  finality?: string;
  etaSeconds?: number;
  programIds?: string[];
  warnings?: string[];
}

export interface WormholeSupportedRoutesSnapshot {
  sourceChain: string;
  wormholeNetwork: WormholeNetwork;
  destinationChain?: string;
  mintAddress?: string;
  routeType?: WormholeRouteType;
  routes: WormholeRouteSnapshot[];
  asOfIso: string;
}

export interface WormholeWrappedAsset {
  chain: string;
  address: string;
  tokenBridgeWrapped?: boolean;
}

export interface WormholeTokenSnapshot {
  mintAddress: string;
  sourceChain: string;
  wormholeNetwork: WormholeNetwork;
  decimals?: number;
  symbol?: string;
  name?: string;
  nativeAddress?: string;
  wrappedAssets?: WormholeWrappedAsset[];
  supportedRoutes: WormholeRouteSnapshot[];
  warnings?: string[];
  asOfIso: string;
}

export interface WormholeQuoteInput {
  walletAddress?: string;
  sourceChain: string;
  sourceMint: string;
  amount: string;
  amountRaw: string;
  sourceDecimals?: number;
  destinationChain: string;
  destinationAddress: string;
  routeType: WormholeRouteType;
  nativeGasDropoff?: string;
}

export interface WormholeQuoteSnapshot {
  quoteId?: string;
  sourceChain: string;
  destinationChain: string;
  sourceMint: string;
  destinationToken?: string;
  destinationAddress: string;
  amount: string;
  amountRaw: string;
  routeType: WormholeRouteType;
  mode: WormholeRouteMode;
  estimatedDestinationAmount?: string;
  minDestinationAmount?: string;
  bridgeFee?: string;
  bridgeFeeToken?: string;
  nativeGasDropoff?: string;
  manualRedemptionRequired: boolean;
  relayerSupported: boolean;
  finality?: string;
  etaSeconds?: number;
  programIds?: string[];
  routeSnapshot?: WormholeRouteSnapshot;
  warnings?: string[];
  asOfIso: string;
  expiresAtIso?: string;
}

export interface WormholeStatusInput {
  sourceChain?: string;
  destinationChain?: string;
  txid?: string;
  vaa?: string;
  sequence?: string;
  transferId?: string;
}

export interface WormholeTransferStatus {
  transferId?: string;
  sourceChain: string;
  destinationChain?: string;
  sourceTxid?: string;
  destinationTxid?: string;
  sequence?: string;
  vaa?: string;
  vaaAvailable: boolean;
  redeemed: boolean;
  state: WormholeTransferState;
  destinationToken?: string;
  nextAction?: 'wait_for_vaa' | 'redeem_on_solana' | 'redeem_on_destination' | 'none';
  solanaExecutable: boolean;
  error?: string;
  warnings?: string[];
  updatedAtIso: string;
}

export interface WormholeWalletBridgeExposure {
  walletAddress: string;
  sourceChain: string;
  pendingTransfers: WormholeTransferStatus[];
  recentTransfers?: WormholeTransferStatus[];
  warnings?: string[];
  asOfIso: string;
}

export interface WormholeBuildTransferInput extends WormholeQuoteInput {
  quote: WormholeQuoteSnapshot;
  minDestinationAmount?: string;
  maxBridgeFee?: string;
  recipientMemo?: string;
}

export interface WormholeBuildRedeemInput {
  walletAddress: string;
  destinationChain: string;
  vaa?: string;
  transferId?: string;
  expectedMint?: string;
  status?: WormholeTransferStatus;
}

export interface WormholeRecoverOrResumeInput {
  walletAddress: string;
  sourceTxid?: string;
  transferId?: string;
  destinationChain?: string;
  status?: WormholeTransferStatus;
}

export interface WormholeBuiltTransaction {
  transactionBase64: string;
  programIds: string[];
  reusable: boolean;
  quoteSnapshot?: WormholeQuoteSnapshot;
  routeSnapshot?: WormholeRouteSnapshot;
  statusSnapshot?: WormholeTransferStatus;
  sequence?: string;
  vaa?: string;
  transferId?: string;
  warnings?: string[];
}

export interface WormholeClient {
  getSupportedRoutes(
    connection: Connection,
    input: {
      sourceChain?: string;
      destinationChain?: string;
      mintAddress?: string;
      routeType?: WormholeRouteType;
      wormholeNetwork: WormholeNetwork;
    },
  ): Promise<WormholeSupportedRoutesSnapshot>;
  getTokenSnapshot(
    connection: Connection,
    input: {
      mintAddress: string;
      destinationChain?: string;
      includeWrappedAssets?: boolean;
      wormholeNetwork: WormholeNetwork;
    },
  ): Promise<WormholeTokenSnapshot>;
  quoteTransfer(connection: Connection, input: WormholeQuoteInput & { wormholeNetwork: WormholeNetwork }): Promise<WormholeQuoteSnapshot>;
  getTransferStatus(
    connection: Connection,
    input: WormholeStatusInput & { wormholeNetwork: WormholeNetwork },
  ): Promise<WormholeTransferStatus>;
  getWalletBridgeExposure(
    connection: Connection,
    input: { walletAddress: string; includePendingTransfers?: boolean; wormholeNetwork: WormholeNetwork },
  ): Promise<WormholeWalletBridgeExposure>;
  buildTransferTransaction(connection: Connection, input: WormholeBuildTransferInput & { wormholeNetwork: WormholeNetwork }): Promise<WormholeBuiltTransaction>;
  buildRedeemTransaction(connection: Connection, input: WormholeBuildRedeemInput & { wormholeNetwork: WormholeNetwork }): Promise<WormholeBuiltTransaction>;
  buildRecoverOrResumeTransaction(
    connection: Connection,
    input: WormholeRecoverOrResumeInput & { wormholeNetwork: WormholeNetwork },
  ): Promise<WormholeBuiltTransaction>;
}

const UNAVAILABLE_REASON =
  '@wormhole-foundation/sdk is not wired. Install @wormhole-foundation/sdk and the platform packages needed by your routes, then call setWormholeClientFactory(buildWormholeClient) at boot, or inject a mock for tests.';

class WormholeSdkUnavailable implements WormholeClient {
  readonly reason: string;

  constructor(reason = UNAVAILABLE_REASON) {
    this.reason = reason;
  }

  private fail(method: string): never {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'sdk_unavailable',
      `Wormhole adapter is not configured (${method}): ${this.reason}`,
    );
  }

  async getSupportedRoutes(): Promise<WormholeSupportedRoutesSnapshot> {
    this.fail('getSupportedRoutes');
  }
  async getTokenSnapshot(): Promise<WormholeTokenSnapshot> {
    this.fail('getTokenSnapshot');
  }
  async quoteTransfer(): Promise<WormholeQuoteSnapshot> {
    this.fail('quoteTransfer');
  }
  async getTransferStatus(): Promise<WormholeTransferStatus> {
    this.fail('getTransferStatus');
  }
  async getWalletBridgeExposure(): Promise<WormholeWalletBridgeExposure> {
    this.fail('getWalletBridgeExposure');
  }
  async buildTransferTransaction(): Promise<WormholeBuiltTransaction> {
    this.fail('buildTransferTransaction');
  }
  async buildRedeemTransaction(): Promise<WormholeBuiltTransaction> {
    this.fail('buildRedeemTransaction');
  }
  async buildRecoverOrResumeTransaction(): Promise<WormholeBuiltTransaction> {
    this.fail('buildRecoverOrResumeTransaction');
  }
}

let factory: () => WormholeClient = () => unavailableFromEnv();
let cached: WormholeClient | undefined;

export function setWormholeClientFactory(next: () => WormholeClient): void {
  factory = next;
  cached = undefined;
}

export function resetWormholeClientFactory(): void {
  factory = () => unavailableFromEnv();
  cached = undefined;
}

export function getWormholeClient(): WormholeClient {
  if (!cached) cached = factory();
  return cached;
}

export function isWormholeConfigured(): boolean {
  return !(getWormholeClient() instanceof WormholeSdkUnavailable);
}

export function describeWormholeUnavailableReason(): string | undefined {
  const client = getWormholeClient();
  return client instanceof WormholeSdkUnavailable ? client.reason : undefined;
}

export function staticWormholeRoute(input: {
  sourceChain: string;
  destinationChain: string;
  routeType: WormholeRouteType;
  sourceMint?: string;
}): WormholeRouteSnapshot {
  const routeType = input.routeType === 'auto' ? 'token_bridge' : input.routeType;
  const automatic = input.routeType === 'auto';
  return {
    sourceChain: input.sourceChain,
    destinationChain: input.destinationChain,
    routeType,
    mode: automatic ? 'automatic' : 'manual',
    supported: true,
    prepareSupported: false,
    manualRedemptionRequired: !automatic,
    relayerSupported: automatic,
    ...(input.sourceMint !== undefined && { sourceMint: input.sourceMint }),
    warnings: [
      'Wormhole SDK client is not configured; this static route fact is read-only and cannot be prepared.',
      ...(automatic
        ? ['Automatic route support and relayer fees must be refreshed by a configured Wormhole client before approval.']
        : ['Manual redemption requirements must be refreshed by a configured Wormhole client before approval.']),
    ],
  };
}

function unavailableFromEnv(): WormholeClient {
  const enabled = process.env[WORMHOLE_FEATURE_FLAG_ENV]?.trim().toLowerCase();
  if (enabled === 'false' || enabled === '0' || enabled === 'off') {
    return new WormholeSdkUnavailable(`${WORMHOLE_FEATURE_FLAG_ENV}=false disables the Wormhole connector.`);
  }
  const rpcOverride = process.env[WORMHOLE_RPC_BASE_URL_ENV]?.trim();
  return new WormholeSdkUnavailable(
    rpcOverride ? `${UNAVAILABLE_REASON} ${WORMHOLE_RPC_BASE_URL_ENV} is set but no SDK client factory is wired.` : UNAVAILABLE_REASON,
  );
}
