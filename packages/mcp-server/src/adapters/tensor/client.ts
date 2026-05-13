import type { Connection } from '@solana/web3.js';

import { AdapterError } from '../types.js';
import { TENSOR_ADAPTER_ID, TENSOR_PROGRAM_IDS } from './constants.js';

export interface TensorCollectionSnapshot {
  collectionId: string;
  name?: string;
  verified?: boolean;
  floorPriceLamports?: string;
  floorPriceSol?: string;
  listedCount?: number;
  totalSupply?: number;
  volume24hLamports?: string;
  volume24hSol?: string;
  numBids?: number;
  topBidPriceLamports?: string;
  topBidPriceSol?: string;
  asOf?: string;
  warnings?: string[];
}

export interface TensorListing {
  listingId?: string;
  mintAddress?: string;
  assetId?: string;
  collectionId?: string;
  seller: string;
  priceLamports: string;
  priceSol: string;
  marketplace: string;
  compressed: boolean;
  expiresAt?: string;
  royaltyBps?: number;
  asOf?: string;
}

export interface TensorBid {
  bidId: string;
  collectionId?: string;
  mintAddress?: string;
  assetId?: string;
  bidder: string;
  bidPriceLamports: string;
  bidPriceSol: string;
  quantity?: number;
  escrowLamports?: string;
  compressed?: boolean;
  expiresAt?: string;
  asOf?: string;
}

export interface TensorSale {
  signature?: string;
  mintAddress?: string;
  assetId?: string;
  priceLamports?: string;
  priceSol?: string;
  buyer?: string;
  seller?: string;
  marketplace?: string;
  compressed?: boolean;
  blockTime?: number;
  slot?: number;
}

export interface TensorWalletNft {
  mintAddress?: string;
  assetId?: string;
  collectionId?: string;
  collectionName?: string;
  owner: string;
  compressed: boolean;
  listed?: boolean;
  listingPriceLamports?: string;
  listingPriceSol?: string;
  marketplace?: string;
}

export interface TensorWalletNftsResult {
  walletAddress: string;
  collectionId?: string;
  nfts: TensorWalletNft[];
  totals?: {
    nfts: number;
    compressed: number;
    listed?: number;
  };
  asOf?: string;
}

export interface TensorNftDetail extends TensorWalletNft {
  name?: string;
  imageUri?: string;
  royaltyBps?: number;
  frozen?: boolean;
  creators?: Array<{ address: string; verified?: boolean; share?: number }>;
  warnings?: string[];
  topListing?: TensorListing | null;
  topBids?: TensorBid[];
  /**
   * Total number of active listings the wallet has for this NFT, including
   * `topListing`. When > 1 the adapter requires the caller to disambiguate
   * with a `listingId` for cancel-listing prepares.
   */
  walletOpenListings?: number;
}

export interface TensorWalletExposure {
  walletAddress: string;
  ownedCollections: Array<{
    collectionId: string;
    name?: string;
    count: number;
    floorPriceLamports?: string;
    floorPriceSol?: string;
  }>;
  openListings: TensorListing[];
  openBids: TensorBid[];
  marginBalanceLamports?: string;
  marginBalanceSol?: string;
  asOf?: string;
}

export interface TensorRefreshListingInput {
  mintAddress?: string;
  assetId?: string;
  listingId?: string;
}

export interface TensorRefreshBidInput {
  bidId: string;
}

export interface TensorBuyInput {
  walletAddress: string;
  mintAddress?: string;
  assetId?: string;
  collectionId?: string;
  maxPriceLamports: string;
  expectedSeller?: string;
  expectedMarketplace?: string;
  compressed: boolean;
}

export interface TensorListInput {
  walletAddress: string;
  mintAddress?: string;
  assetId?: string;
  priceLamports: string;
  expiresAt?: string;
  compressed: boolean;
}

export interface TensorCancelListingInput {
  walletAddress: string;
  mintAddress?: string;
  assetId?: string;
  listingId?: string;
  compressed: boolean;
}

export interface TensorBidInput {
  walletAddress: string;
  collectionId: string;
  mintAddress?: string;
  assetId?: string;
  bidPriceLamports: string;
  quantity: number;
  expiresAt?: string;
  maxEscrowLamports: string;
  compressed: boolean;
}

export interface TensorCancelBidInput {
  walletAddress: string;
  bidId: string;
  collectionId?: string;
}

export interface TensorSweepItem {
  mintAddress?: string;
  assetId?: string;
  listingId?: string;
  expectedPriceLamports: string;
  compressed: boolean;
}

export interface TensorSweepInput {
  walletAddress: string;
  collectionId: string;
  exactItems: TensorSweepItem[];
  maxTotalLamports: string;
  maxPricePerItemLamports: string;
  compressed: boolean;
}

export interface TensorBuiltTx {
  transactionBase64: string;
  preview: {
    feeLamports?: string;
    royaltyLamports?: string;
    programIds: typeof TENSOR_PROGRAM_IDS;
    compressed: boolean;
    notes?: string[];
  };
}

export interface TensorClient {
  fetchCollectionStats(connection: Connection, collectionId: string): Promise<TensorCollectionSnapshot>;
  fetchCollectionListings(connection: Connection, collectionId: string, limit?: number): Promise<TensorListing[]>;
  fetchCollectionBids(connection: Connection, collectionId: string, limit?: number): Promise<TensorBid[]>;
  fetchRecentSales(connection: Connection, collectionId: string, limit?: number): Promise<TensorSale[]>;
  fetchWalletNfts(
    connection: Connection,
    input: { walletAddress: string; collectionId?: string; includeCompressed?: boolean },
  ): Promise<TensorWalletNftsResult>;
  fetchNftDetail(connection: Connection, input: { mintAddress?: string; assetId?: string }): Promise<TensorNftDetail>;
  fetchWalletExposure(connection: Connection, walletAddress: string): Promise<TensorWalletExposure>;
  refreshListing(connection: Connection, input: TensorRefreshListingInput): Promise<TensorListing | null>;
  refreshBid(connection: Connection, input: TensorRefreshBidInput): Promise<TensorBid | null>;
  buildBuyTx(connection: Connection, input: TensorBuyInput): Promise<TensorBuiltTx>;
  buildListTx(connection: Connection, input: TensorListInput): Promise<TensorBuiltTx>;
  buildCancelListingTx(connection: Connection, input: TensorCancelListingInput): Promise<TensorBuiltTx>;
  buildBidTx(connection: Connection, input: TensorBidInput): Promise<TensorBuiltTx>;
  buildCancelBidTx(connection: Connection, input: TensorCancelBidInput): Promise<TensorBuiltTx>;
  buildSweepTx(connection: Connection, input: TensorSweepInput): Promise<TensorBuiltTx>;
}

const UNAVAILABLE_REASON =
  '@tensor-oss/tensorswap-sdk and @tensor-oss/tcomp-sdk are not wired. Install both packages, then call setTensorClientFactory(buildTensorClient) at boot with TENSOR_API_KEY, or inject a mock for tests.';

export class TensorSdkUnavailable implements TensorClient {
  readonly reason = UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'sdk_unavailable',
      `Tensor adapter is not configured (${method}): ${this.reason}`,
    );
  }

  async fetchCollectionStats(): Promise<TensorCollectionSnapshot> { this.fail('fetchCollectionStats'); }
  async fetchCollectionListings(): Promise<TensorListing[]> { this.fail('fetchCollectionListings'); }
  async fetchCollectionBids(): Promise<TensorBid[]> { this.fail('fetchCollectionBids'); }
  async fetchRecentSales(): Promise<TensorSale[]> { this.fail('fetchRecentSales'); }
  async fetchWalletNfts(): Promise<TensorWalletNftsResult> { this.fail('fetchWalletNfts'); }
  async fetchNftDetail(): Promise<TensorNftDetail> { this.fail('fetchNftDetail'); }
  async fetchWalletExposure(): Promise<TensorWalletExposure> { this.fail('fetchWalletExposure'); }
  async refreshListing(): Promise<TensorListing | null> { this.fail('refreshListing'); }
  async refreshBid(): Promise<TensorBid | null> { this.fail('refreshBid'); }
  async buildBuyTx(): Promise<TensorBuiltTx> { this.fail('buildBuyTx'); }
  async buildListTx(): Promise<TensorBuiltTx> { this.fail('buildListTx'); }
  async buildCancelListingTx(): Promise<TensorBuiltTx> { this.fail('buildCancelListingTx'); }
  async buildBidTx(): Promise<TensorBuiltTx> { this.fail('buildBidTx'); }
  async buildCancelBidTx(): Promise<TensorBuiltTx> { this.fail('buildCancelBidTx'); }
  async buildSweepTx(): Promise<TensorBuiltTx> { this.fail('buildSweepTx'); }
}

let factory: () => TensorClient = () => new TensorSdkUnavailable();
let cached: TensorClient | undefined;

export function setTensorClientFactory(next: () => TensorClient): void {
  factory = next;
  cached = undefined;
}

export function resetTensorClientFactory(): void {
  factory = () => new TensorSdkUnavailable();
  cached = undefined;
}

export function getTensorClient(): TensorClient {
  if (!cached) cached = factory();
  return cached;
}

export function isTensorConfigured(): boolean {
  return !(getTensorClient() instanceof TensorSdkUnavailable);
}

export function describeTensorUnavailableReason(): string | undefined {
  const client = getTensorClient();
  return client instanceof TensorSdkUnavailable ? client.reason : undefined;
}

export function redactApiKey(message: string): string {
  let out = message;
  const apiKey = process.env.TENSOR_API_KEY?.trim();
  if (apiKey && apiKey.length >= 4) {
    out = out.split(apiKey).join('[redacted]');
  }
  out = out.replace(
    /(x-tensor-api-key\s*[:=]\s*)["']?[^"'\s,;]+["']?/gi,
    '$1[redacted]',
  );
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]');
  return out;
}

export async function withTensorErrors<T>(method: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AdapterError) {
      throw new AdapterError(err.adapterId, err.code, redactApiKey(err.message));
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'api_error',
      `Tensor ${method} failed: ${redactApiKey(message)}`,
    );
  }
}
