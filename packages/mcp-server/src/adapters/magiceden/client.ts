import {
  MAGICEDEN_API_BASE_URL_ENV,
  MAGICEDEN_API_KEY_ENV,
  MAGICEDEN_DEFAULT_API_BASE_URL,
  MAGICEDEN_FEATURE_FLAG_ENV,
  MAGICEDEN_RESPONSE_BYTE_LIMIT,
} from './constants.js';

export interface MagicedenRateLimitInfo {
  limited: boolean;
  retryAfterSeconds?: number;
  remaining?: number;
  resetAtIso?: string;
}

export interface MagicedenApiHealthSnapshot {
  apiOperational: boolean;
  tradingOperational: boolean;
  readOnlyFallback: boolean;
  checkedAtIso: string;
  baseHost: string;
  warnings: string[];
  degradedReasons: string[];
  rateLimit?: MagicedenRateLimitInfo;
}

export interface MagicedenCollectionSummary {
  collectionSymbol?: string;
  collectionId?: string;
  name?: string;
  image?: string;
  description?: string;
  verified?: boolean;
  floorPriceLamports?: string;
  listedCount?: number;
  totalSupply?: number;
  royaltyBps?: number;
  asOfIso: string;
  apiBaseHost: string;
}

export interface MagicedenCollectionRow {
  collectionSymbol?: string;
  collectionId?: string;
  name?: string;
  image?: string;
  description?: string;
  verified?: boolean;
  floorPriceLamports?: string;
  floorPriceSol?: string;
  listedCount?: number;
  totalSupply?: number;
  volume24hSol?: string;
  rank?: number;
}

export interface MagicedenTopCollections {
  rows: MagicedenCollectionRow[];
  source: 'popular_collections' | 'collections';
  asOfIso: string;
  apiBaseHost: string;
}

export interface MagicedenListingRow {
  listingId?: string;
  mintAddress: string;
  seller?: string;
  priceLamports: string;
  priceSol: string;
  tokenName?: string;
  tokenImage?: string;
  auctionHouse?: string;
  expiry?: string;
}

export interface MagicedenCollectionListings {
  collectionSymbol?: string;
  collectionId?: string;
  rows: MagicedenListingRow[];
  asOfIso: string;
  apiBaseHost: string;
}

export interface MagicedenBidRow {
  bidId?: string;
  buyer?: string;
  bidPriceLamports: string;
  bidPriceSol: string;
  mintAddress?: string;
  expiry?: string;
}

export interface MagicedenCollectionBids {
  collectionSymbol?: string;
  collectionId?: string;
  rows: MagicedenBidRow[];
  asOfIso: string;
  apiBaseHost: string;
}

export type MagicedenActivityType =
  | 'list'
  | 'delist'
  | 'buy_now'
  | 'bid'
  | 'cancel_bid'
  | 'accept_bid'
  | 'mint'
  | 'transfer'
  | 'unknown';

export interface MagicedenActivityRow {
  activityType: MagicedenActivityType;
  signature?: string;
  blockTime?: number;
  mintAddress?: string;
  buyer?: string;
  seller?: string;
  priceLamports?: string;
  priceSol?: string;
}

export interface MagicedenRecentActivity {
  rows: MagicedenActivityRow[];
  asOfIso: string;
  apiBaseHost: string;
}

export interface MagicedenWalletNftRow {
  mintAddress: string;
  tokenName?: string;
  tokenImage?: string;
  collectionSymbol?: string;
  collectionName?: string;
  listed: boolean;
  listingPriceLamports?: string;
  listingPriceSol?: string;
  listingId?: string;
}

export interface MagicedenWalletNftsSnapshot {
  walletAddress: string;
  rows: MagicedenWalletNftRow[];
  listedOnly: boolean;
  asOfIso: string;
  apiBaseHost: string;
}

export interface MagicedenNftDetail {
  mintAddress: string;
  tokenName?: string;
  tokenImage?: string;
  owner?: string;
  collectionSymbol?: string;
  collectionName?: string;
  verifiedCollection?: boolean;
  listing?: MagicedenListingRow;
  topBid?: MagicedenBidRow;
  lastSaleLamports?: string;
  lastSaleSol?: string;
  royaltyBps?: number;
  asOfIso: string;
  apiBaseHost: string;
}

export interface MagicedenGenerateTransactionResult {
  transactionBase64: string;
  programIds: string[];
  reusable: boolean;
  feeLamports?: string;
  royaltyLamports?: string;
  warnings?: string[];
}

export interface MagicedenBuyParams {
  buyerAddress: string;
  sellerAddress: string;
  mintAddress: string;
  priceLamports: string;
  auctionHouse?: string;
  collectionSymbol?: string;
  expectedListingId?: string;
}

export interface MagicedenListParams {
  sellerAddress: string;
  mintAddress: string;
  priceLamports: string;
  expiresAt?: string;
}

export interface MagicedenCancelListingParams {
  sellerAddress: string;
  mintAddress: string;
  priceLamports: string;
  listingId?: string;
}

export interface MagicedenBidParams {
  buyerAddress: string;
  bidPriceLamports: string;
  quantity?: number;
  mintAddress?: string;
  collectionSymbol?: string;
  collectionId?: string;
  expiresAt?: string;
}

export interface MagicedenCancelBidParams {
  buyerAddress: string;
  bidId?: string;
  collectionSymbol?: string;
  collectionId?: string;
  mintAddress?: string;
  bidPriceLamports?: string;
}

export interface MagicedenClient {
  getApiHealth(input: { includeTradingEndpoints?: boolean }): Promise<MagicedenApiHealthSnapshot>;
  getTopCollections(input?: {
    limit?: number;
    timeRange?: string;
  }): Promise<MagicedenTopCollections>;
  getCollectionSummary(input: {
    collectionSymbol?: string;
    collectionId?: string;
  }): Promise<MagicedenCollectionSummary>;
  getCollectionListings(input: {
    collectionSymbol?: string;
    collectionId?: string;
    limit?: number;
  }): Promise<MagicedenCollectionListings>;
  getCollectionBids(input: {
    collectionSymbol?: string;
    collectionId?: string;
    limit?: number;
  }): Promise<MagicedenCollectionBids>;
  getRecentActivity(input: {
    collectionSymbol?: string;
    collectionId?: string;
    limit?: number;
  }): Promise<MagicedenRecentActivity>;
  getWalletNfts(input: {
    walletAddress: string;
    collectionSymbol?: string;
    collectionId?: string;
    listedOnly?: boolean;
  }): Promise<MagicedenWalletNftsSnapshot>;
  getNftDetail(input: {
    mintAddress: string;
    includeListing?: boolean;
    includeBids?: boolean;
  }): Promise<MagicedenNftDetail>;
  generateBuyTransaction(input: MagicedenBuyParams): Promise<MagicedenGenerateTransactionResult>;
  generateListTransaction(input: MagicedenListParams): Promise<MagicedenGenerateTransactionResult>;
  generateCancelListingTransaction(
    input: MagicedenCancelListingParams,
  ): Promise<MagicedenGenerateTransactionResult>;
  generateBidTransaction(input: MagicedenBidParams): Promise<MagicedenGenerateTransactionResult>;
  generateCancelBidTransaction(
    input: MagicedenCancelBidParams,
  ): Promise<MagicedenGenerateTransactionResult>;
}

const MISSING_KEY_REASON = `${MAGICEDEN_API_KEY_ENV} is not set. Configure ${MAGICEDEN_API_KEY_ENV} (and optionally ${MAGICEDEN_API_BASE_URL_ENV}) in the host environment, then set ${MAGICEDEN_FEATURE_FLAG_ENV}=true to enable Magic Eden first-class reads and prepared actions, or inject a mock via setMagicedenClientFactory for tests.`;

const FLAG_OFF_REASON = `${MAGICEDEN_FEATURE_FLAG_ENV} is not enabled. Magic Eden remains disabled because its API support is in transition; set ${MAGICEDEN_FEATURE_FLAG_ENV}=true after confirming health to enable first-class reads and prepared actions.`;

class MagicedenApiUnavailable implements MagicedenClient {
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  private fail(method: string): never {
    throw new Error(`Magic Eden adapter is not configured (${method}): ${this.reason}`);
  }

  async getApiHealth(): Promise<MagicedenApiHealthSnapshot> {
    this.fail('getApiHealth');
  }
  async getTopCollections(): Promise<MagicedenTopCollections> {
    this.fail('getTopCollections');
  }
  async getCollectionSummary(): Promise<MagicedenCollectionSummary> {
    this.fail('getCollectionSummary');
  }
  async getCollectionListings(): Promise<MagicedenCollectionListings> {
    this.fail('getCollectionListings');
  }
  async getCollectionBids(): Promise<MagicedenCollectionBids> {
    this.fail('getCollectionBids');
  }
  async getRecentActivity(): Promise<MagicedenRecentActivity> {
    this.fail('getRecentActivity');
  }
  async getWalletNfts(): Promise<MagicedenWalletNftsSnapshot> {
    this.fail('getWalletNfts');
  }
  async getNftDetail(): Promise<MagicedenNftDetail> {
    this.fail('getNftDetail');
  }
  async generateBuyTransaction(): Promise<MagicedenGenerateTransactionResult> {
    this.fail('generateBuyTransaction');
  }
  async generateListTransaction(): Promise<MagicedenGenerateTransactionResult> {
    this.fail('generateListTransaction');
  }
  async generateCancelListingTransaction(): Promise<MagicedenGenerateTransactionResult> {
    this.fail('generateCancelListingTransaction');
  }
  async generateBidTransaction(): Promise<MagicedenGenerateTransactionResult> {
    this.fail('generateBidTransaction');
  }
  async generateCancelBidTransaction(): Promise<MagicedenGenerateTransactionResult> {
    this.fail('generateCancelBidTransaction');
  }
}

let factory: () => MagicedenClient = () => buildDefaultMagicedenClient();
let cached: MagicedenClient | undefined;

export function setMagicedenClientFactory(next: () => MagicedenClient): void {
  factory = next;
  cached = undefined;
}

export function resetMagicedenClientFactory(): void {
  factory = () => buildDefaultMagicedenClient();
  cached = undefined;
}

export function getMagicedenClient(): MagicedenClient {
  if (!cached) cached = factory();
  return cached;
}

export function isMagicedenConfigured(): boolean {
  return !(getMagicedenClient() instanceof MagicedenApiUnavailable);
}

export function describeMagicedenUnavailableReason(): string | undefined {
  const client = getMagicedenClient();
  return client instanceof MagicedenApiUnavailable ? client.reason : undefined;
}

function buildDefaultMagicedenClient(): MagicedenClient {
  const apiKey = (process.env[MAGICEDEN_API_KEY_ENV] ?? '').trim();
  if (!apiKey) return new MagicedenApiUnavailable(MISSING_KEY_REASON);
  const flag = (process.env[MAGICEDEN_FEATURE_FLAG_ENV] ?? '').trim().toLowerCase();
  if (flag !== 'true' && flag !== '1' && flag !== 'yes') {
    return new MagicedenApiUnavailable(FLAG_OFF_REASON);
  }
  const rawBase = (process.env[MAGICEDEN_API_BASE_URL_ENV] ?? '').trim();
  const baseUrl = normalizeBaseUrl(rawBase || MAGICEDEN_DEFAULT_API_BASE_URL);
  return new MagicedenApiClient({ apiKey, baseUrl });
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export interface MagicedenApiClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class MagicedenApiClient implements MagicedenClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseHost: string;

  constructor(options: MagicedenApiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseHost = safeHost(this.baseUrl);
  }

  async getApiHealth(input: { includeTradingEndpoints?: boolean }): Promise<MagicedenApiHealthSnapshot> {
    const checkedAtIso = new Date().toISOString();
    const warnings: string[] = [];
    const degradedReasons: string[] = [];
    let apiOperational = true;
    let tradingOperational = true;
    let rateLimit: MagicedenRateLimitInfo | undefined;

    try {
      const probe = await this.request('/collections?limit=1', 'GET');
      rateLimit = probe.rateLimit;
      if (probe.rateLimit?.limited) {
        warnings.push('Magic Eden read endpoints are currently rate-limited.');
      }
    } catch (err) {
      apiOperational = false;
      tradingOperational = false;
      degradedReasons.push(describeError(err, this.apiKey));
    }

    if (apiOperational && input.includeTradingEndpoints !== false) {
      try {
        await this.request(
          '/instructions/buy_now?buyer=11111111111111111111111111111111&seller=11111111111111111111111111111111&auctionHouseAddress=&tokenMint=11111111111111111111111111111111&tokenATA=&price=0',
          'GET',
        );
      } catch (err) {
        if (err instanceof MagicedenHttpError) {
          const status = err.status;
          if (status === 400 || status === 404 || status === 422) {
            // Endpoint is alive; it rejected our intentionally-invalid probe payload.
            // Trading remains operational.
          } else if (status === 401 || status === 403) {
            tradingOperational = false;
            degradedReasons.push('Magic Eden trading endpoint rejected the API key (auth failure).');
          } else if (status === 429) {
            tradingOperational = false;
            degradedReasons.push('Magic Eden trading endpoint is rate-limited.');
          } else if (status >= 500) {
            tradingOperational = false;
            degradedReasons.push(`Magic Eden trading endpoint returned ${status}.`);
          } else {
            tradingOperational = false;
            degradedReasons.push(`Magic Eden trading endpoint returned unexpected status ${status}.`);
          }
        } else {
          tradingOperational = false;
          degradedReasons.push(describeError(err, this.apiKey));
        }
      }
    }

    return {
      apiOperational,
      tradingOperational,
      readOnlyFallback: apiOperational && !tradingOperational,
      checkedAtIso,
      baseHost: this.baseHost,
      warnings,
      degradedReasons,
      ...(rateLimit ? { rateLimit } : {}),
    };
  }

  async getTopCollections(input: {
    limit?: number;
    timeRange?: string;
  } = {}): Promise<MagicedenTopCollections> {
    const limit = boundedLimit(input.limit);
    const popularParams = new URLSearchParams();
    popularParams.set('limit', limit.toString());
    popularParams.set('timeRange', input.timeRange?.trim() || '1d');
    try {
      const probe = await this.request(
        `/marketplace/popular_collections?${popularParams.toString()}`,
        'GET',
      );
      const rows = asArray(probe.body)
        .map((row, index) => normalizeCollectionRow(row, index))
        .filter((row): row is MagicedenCollectionRow => row !== null)
        .slice(0, limit);
      if (rows.length > 0) {
        return {
          rows,
          source: 'popular_collections',
          asOfIso: new Date().toISOString(),
          apiBaseHost: this.baseHost,
        };
      }
    } catch {
      // Fall through to the older collection catalog endpoint. Popular
      // collections is newer and may not be enabled for every API key/base URL.
    }

    const params = new URLSearchParams();
    params.set('limit', limit.toString());
    const probe = await this.request(`/collections?${params.toString()}`, 'GET');
    const rows = asArray(probe.body)
      .map((row, index) => normalizeCollectionRow(row, index))
      .filter((row): row is MagicedenCollectionRow => row !== null)
      .slice(0, limit);
    return {
      rows,
      source: 'collections',
      asOfIso: new Date().toISOString(),
      apiBaseHost: this.baseHost,
    };
  }

  async getCollectionSummary(input: {
    collectionSymbol?: string;
    collectionId?: string;
  }): Promise<MagicedenCollectionSummary> {
    const symbol = requireCollection(input);
    const [stats, info] = await Promise.all([
      this.request(`/collections/${encodeURIComponent(symbol)}/stats`, 'GET').catch(() => undefined),
      this.request(`/collections/${encodeURIComponent(symbol)}`, 'GET').catch(() => undefined),
    ]);
    const statsBody = (stats?.body ?? {}) as Record<string, unknown>;
    const infoBody = (info?.body ?? {}) as Record<string, unknown>;
    return {
      ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      ...(stringField(infoBody, 'name') ? { name: stringField(infoBody, 'name') } : {}),
      ...(stringField(infoBody, 'image') ? { image: stringField(infoBody, 'image') } : {}),
      ...(stringField(infoBody, 'description')
        ? { description: stringField(infoBody, 'description') }
        : {}),
      ...(typeof infoBody.isBadged === 'boolean' || typeof infoBody.verified === 'boolean'
        ? { verified: Boolean(infoBody.verified ?? infoBody.isBadged) }
        : {}),
      ...(numberAsString(statsBody.floorPrice) ? { floorPriceLamports: numberAsString(statsBody.floorPrice) } : {}),
      ...(typeof statsBody.listedCount === 'number' ? { listedCount: statsBody.listedCount } : {}),
      ...(typeof statsBody.totalSupply === 'number' ? { totalSupply: statsBody.totalSupply } : {}),
      ...(typeof infoBody.sellerFeeBasisPoints === 'number'
        ? { royaltyBps: infoBody.sellerFeeBasisPoints }
        : {}),
      asOfIso: new Date().toISOString(),
      apiBaseHost: this.baseHost,
    };
  }

  async getCollectionListings(input: {
    collectionSymbol?: string;
    collectionId?: string;
    limit?: number;
  }): Promise<MagicedenCollectionListings> {
    const symbol = requireCollection(input);
    const params = new URLSearchParams();
    params.set('limit', boundedLimit(input.limit).toString());
    const probe = await this.request(
      `/collections/${encodeURIComponent(symbol)}/listings?${params.toString()}`,
      'GET',
    );
    const rows = asArray(probe.body).map(normalizeListingRow).filter((row): row is MagicedenListingRow => row !== null);
    return {
      ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      rows,
      asOfIso: new Date().toISOString(),
      apiBaseHost: this.baseHost,
    };
  }

  async getCollectionBids(input: {
    collectionSymbol?: string;
    collectionId?: string;
    limit?: number;
  }): Promise<MagicedenCollectionBids> {
    const symbol = requireCollection(input);
    const params = new URLSearchParams();
    params.set('limit', boundedLimit(input.limit).toString());
    const probe = await this.request(
      `/collections/${encodeURIComponent(symbol)}/bids?${params.toString()}`,
      'GET',
    );
    const rows = asArray(probe.body).map(normalizeBidRow).filter((row): row is MagicedenBidRow => row !== null);
    return {
      ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      rows,
      asOfIso: new Date().toISOString(),
      apiBaseHost: this.baseHost,
    };
  }

  async getRecentActivity(input: {
    collectionSymbol?: string;
    collectionId?: string;
    limit?: number;
  }): Promise<MagicedenRecentActivity> {
    const symbol = requireCollection(input);
    const params = new URLSearchParams();
    params.set('limit', boundedLimit(input.limit).toString());
    const probe = await this.request(
      `/collections/${encodeURIComponent(symbol)}/activities?${params.toString()}`,
      'GET',
    );
    const rows = asArray(probe.body).map(normalizeActivityRow).filter((row): row is MagicedenActivityRow => row !== null);
    return {
      rows,
      asOfIso: new Date().toISOString(),
      apiBaseHost: this.baseHost,
    };
  }

  async getWalletNfts(input: {
    walletAddress: string;
    collectionSymbol?: string;
    collectionId?: string;
    listedOnly?: boolean;
  }): Promise<MagicedenWalletNftsSnapshot> {
    const params = new URLSearchParams();
    if (input.collectionSymbol) params.set('collection_symbol', input.collectionSymbol);
    if (input.listedOnly) params.set('listStatus', 'listed');
    const path = `/wallets/${encodeURIComponent(input.walletAddress)}/tokens${params.toString() ? `?${params.toString()}` : ''}`;
    const probe = await this.request(path, 'GET');
    const rows = asArray(probe.body)
      .map(normalizeWalletNftRow)
      .filter((row): row is MagicedenWalletNftRow => row !== null);
    return {
      walletAddress: input.walletAddress,
      rows,
      listedOnly: input.listedOnly === true,
      asOfIso: new Date().toISOString(),
      apiBaseHost: this.baseHost,
    };
  }

  async getNftDetail(input: {
    mintAddress: string;
    includeListing?: boolean;
    includeBids?: boolean;
  }): Promise<MagicedenNftDetail> {
    const tokenPromise = this.request(`/tokens/${encodeURIComponent(input.mintAddress)}`, 'GET');
    const listingPromise = input.includeListing === false
      ? Promise.resolve<MagicedenListingRow | undefined>(undefined)
      : this.request(`/tokens/${encodeURIComponent(input.mintAddress)}/listings`, 'GET')
          .then((response) => asArray(response.body).map(normalizeListingRow).find((r) => r !== null) ?? undefined)
          .catch(() => undefined);
    const topBidPromise = input.includeBids === false
      ? Promise.resolve<MagicedenBidRow | undefined>(undefined)
      : this.request(`/tokens/${encodeURIComponent(input.mintAddress)}/offer_received?limit=1`, 'GET')
          .then((response) => asArray(response.body).map(normalizeBidRow).find((r) => r !== null) ?? undefined)
          .catch(() => undefined);
    const [probe, listing, topBid] = await Promise.all([tokenPromise, listingPromise, topBidPromise]);
    const body = isObject(probe.body) ? probe.body : {};
    return {
      mintAddress: input.mintAddress,
      ...(stringField(body, 'name') ? { tokenName: stringField(body, 'name') } : {}),
      ...(stringField(body, 'image') ? { tokenImage: stringField(body, 'image') } : {}),
      ...(stringField(body, 'owner') ? { owner: stringField(body, 'owner') } : {}),
      ...(stringField(body, 'collection') ? { collectionSymbol: stringField(body, 'collection') } : {}),
      ...(stringField(body, 'collectionName') ? { collectionName: stringField(body, 'collectionName') } : {}),
      ...(typeof body.verifiedCollection === 'boolean'
        ? { verifiedCollection: body.verifiedCollection }
        : {}),
      ...(listing ? { listing } : {}),
      ...(topBid ? { topBid } : {}),
      ...(numberAsString(body.lastSalePrice)
        ? { lastSaleLamports: numberAsString(body.lastSalePrice) }
        : {}),
      ...(numberAsString(body.lastSalePrice)
        ? { lastSaleSol: lamportsToSolString(numberAsString(body.lastSalePrice)!) }
        : {}),
      ...(typeof body.sellerFeeBasisPoints === 'number'
        ? { royaltyBps: body.sellerFeeBasisPoints }
        : {}),
      asOfIso: new Date().toISOString(),
      apiBaseHost: this.baseHost,
    };
  }

  async generateBuyTransaction(input: MagicedenBuyParams): Promise<MagicedenGenerateTransactionResult> {
    const params = new URLSearchParams({
      buyer: input.buyerAddress,
      seller: input.sellerAddress,
      tokenMint: input.mintAddress,
      price: input.priceLamports,
    });
    if (input.auctionHouse) params.set('auctionHouseAddress', input.auctionHouse);
    const probe = await this.request(`/instructions/buy_now?${params.toString()}`, 'GET');
    return this.normalizeTransactionResponse(probe.body, 'buy_now');
  }

  async generateListTransaction(input: MagicedenListParams): Promise<MagicedenGenerateTransactionResult> {
    const params = new URLSearchParams({
      seller: input.sellerAddress,
      tokenMint: input.mintAddress,
      price: input.priceLamports,
    });
    if (input.expiresAt) params.set('expiry', String(Math.floor(new Date(input.expiresAt).getTime() / 1000)));
    const probe = await this.request(`/instructions/sell?${params.toString()}`, 'GET');
    return this.normalizeTransactionResponse(probe.body, 'sell');
  }

  async generateCancelListingTransaction(
    input: MagicedenCancelListingParams,
  ): Promise<MagicedenGenerateTransactionResult> {
    const params = new URLSearchParams({
      seller: input.sellerAddress,
      tokenMint: input.mintAddress,
      price: input.priceLamports,
    });
    if (input.listingId) params.set('listingId', input.listingId);
    const probe = await this.request(`/instructions/sell_cancel?${params.toString()}`, 'GET');
    return this.normalizeTransactionResponse(probe.body, 'sell_cancel');
  }

  async generateBidTransaction(input: MagicedenBidParams): Promise<MagicedenGenerateTransactionResult> {
    const params = new URLSearchParams({
      buyer: input.buyerAddress,
      price: input.bidPriceLamports,
    });
    if (input.mintAddress) params.set('tokenMint', input.mintAddress);
    if (input.collectionSymbol) params.set('collectionSymbol', input.collectionSymbol);
    if (input.quantity !== undefined) params.set('quantity', String(input.quantity));
    if (input.expiresAt) params.set('expiry', String(Math.floor(new Date(input.expiresAt).getTime() / 1000)));
    const probe = await this.request(`/instructions/buy?${params.toString()}`, 'GET');
    return this.normalizeTransactionResponse(probe.body, 'buy');
  }

  async generateCancelBidTransaction(
    input: MagicedenCancelBidParams,
  ): Promise<MagicedenGenerateTransactionResult> {
    const params = new URLSearchParams({ buyer: input.buyerAddress });
    if (input.bidId) params.set('bidId', input.bidId);
    if (input.mintAddress) params.set('tokenMint', input.mintAddress);
    if (input.collectionSymbol) params.set('collectionSymbol', input.collectionSymbol);
    if (input.bidPriceLamports) params.set('price', input.bidPriceLamports);
    const probe = await this.request(`/instructions/buy_cancel?${params.toString()}`, 'GET');
    return this.normalizeTransactionResponse(probe.body, 'buy_cancel');
  }

  private normalizeTransactionResponse(
    body: unknown,
    label: string,
  ): MagicedenGenerateTransactionResult {
    const obj = isObject(body) ? body : {};
    const tx =
      stringField(obj, 'txSigned', 'tx', 'transaction', 'transactionBase64') ||
      (() => {
        const dataField = obj.txSigned ?? obj.tx ?? obj.transaction;
        if (isObject(dataField) && Array.isArray(dataField.data)) {
          try {
            return Buffer.from(dataField.data as number[]).toString('base64');
          } catch {
            return '';
          }
        }
        return '';
      })();
    if (!tx) {
      throw new Error(`Magic Eden API ${label} response is missing an unsigned transaction.`);
    }
    return {
      transactionBase64: tx,
      programIds: arrayOfStrings(obj.programIds),
      reusable: obj.reusable !== false,
      ...(numberAsString(obj.feeLamports) ? { feeLamports: numberAsString(obj.feeLamports) } : {}),
      ...(numberAsString(obj.royaltyLamports)
        ? { royaltyLamports: numberAsString(obj.royaltyLamports) }
        : {}),
      ...(Array.isArray(obj.warnings)
        ? { warnings: obj.warnings.filter((w): w is string => typeof w === 'string') }
        : {}),
    };
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown; rateLimit?: MagicedenRateLimitInfo }> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw redactMagicedenError(err, this.apiKey);
    }
    const rateLimit = readRateLimit(response);
    if (response.status === 429) {
      throw redactMagicedenError(
        new MagicedenHttpError(429, 'Magic Eden API rate limit reached.'),
        this.apiKey,
      );
    }
    const text = await readBoundedText(response).catch((err) => {
      throw redactMagicedenError(err, this.apiKey);
    });
    if (!response.ok) {
      const message = redactString(text, this.apiKey).slice(0, 500) || `HTTP ${response.status}`;
      throw redactMagicedenError(new MagicedenHttpError(response.status, message), this.apiKey);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (text && !contentType.toLowerCase().includes('json')) {
      throw redactMagicedenError(
        new Error(`Magic Eden API returned non-JSON response (content-type: ${contentType || 'unknown'}).`),
        this.apiKey,
      );
    }
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw redactMagicedenError(err, this.apiKey);
      }
    }
    return { status: response.status, body: parsed, ...(rateLimit ? { rateLimit } : {}) };
  }
}

export class MagicedenHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'MagicedenHttpError';
    this.status = status;
  }
}

export function redactMagicedenError(err: unknown, apiKey: string): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const cleaned = redactString(original.message, apiKey);
  if (original instanceof MagicedenHttpError) {
    return new MagicedenHttpError(original.status, cleaned);
  }
  const wrapped = new Error(cleaned);
  wrapped.name = original.name || 'Error';
  return wrapped;
}

function redactString(value: string, apiKey: string): string {
  if (!value) return value;
  let out = value;
  if (apiKey) {
    out = out.split(apiKey).join('***');
  }
  out = out.replace(/(authorization\s*[:=]\s*)["']?bearer\s+[A-Za-z0-9._-]+["']?/gi, '$1Bearer ***');
  out = out.replace(/(authorization\s*[:=]\s*)["']?[A-Za-z0-9._-]+["']?/gi, '$1***');
  return out;
}

function describeError(err: unknown, apiKey: string): string {
  const e = err instanceof Error ? err : new Error(String(err));
  return redactString(e.message || e.name || 'unknown error', apiKey);
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > MAGICEDEN_RESPONSE_BYTE_LIMIT) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        throw new Error(
          `Magic Eden API response exceeded ${MAGICEDEN_RESPONSE_BYTE_LIMIT} bytes; refusing to read further.`,
        );
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

function readRateLimit(response: Response): MagicedenRateLimitInfo | undefined {
  const retryAfter = response.headers.get('retry-after');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  if (!retryAfter && !remaining && !reset) return undefined;
  const limited = response.status === 429 || (remaining ? Number(remaining) <= 0 : false);
  return {
    limited,
    ...(retryAfter ? { retryAfterSeconds: Number(retryAfter) } : {}),
    ...(remaining ? { remaining: Number(remaining) } : {}),
    ...(reset ? { resetAtIso: new Date(Number(reset) * 1000).toISOString() } : {}),
  };
}

function requireCollection(input: { collectionSymbol?: string; collectionId?: string }): string {
  const value = (input.collectionSymbol ?? input.collectionId ?? '').trim();
  if (!value) {
    throw new Error('Magic Eden read requires collectionSymbol or collectionId.');
  }
  return value;
}

function boundedLimit(limit?: number): number {
  if (limit === undefined) return 20;
  if (!Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(Math.trunc(limit), 100);
}

function normalizeCollectionRow(row: unknown, index: number): MagicedenCollectionRow | null {
  if (!isObject(row)) return null;
  const collectionSymbol = stringField(row, 'symbol', 'collectionSymbol', 'slug', 'collection');
  const collectionId = stringField(row, 'collectionId', 'id', 'address');
  if (!collectionSymbol && !collectionId) return null;
  const floor = collectionFloor(row);
  return {
    ...(collectionSymbol ? { collectionSymbol } : {}),
    ...(collectionId ? { collectionId } : {}),
    ...(stringField(row, 'name', 'displayName', 'collectionName') ? { name: stringField(row, 'name', 'displayName', 'collectionName') } : {}),
    ...(stringField(row, 'image', 'imageUrl') ? { image: stringField(row, 'image', 'imageUrl') } : {}),
    ...(stringField(row, 'description') ? { description: stringField(row, 'description') } : {}),
    ...(typeof row.verified === 'boolean' || typeof row.isBadged === 'boolean'
      ? { verified: Boolean(row.verified ?? row.isBadged) }
      : {}),
    ...(floor.floorPriceLamports ? { floorPriceLamports: floor.floorPriceLamports } : {}),
    ...(floor.floorPriceSol ? { floorPriceSol: floor.floorPriceSol } : {}),
    ...(integerField(row, 'listedCount', 'listed', 'numListed') !== undefined
      ? { listedCount: integerField(row, 'listedCount', 'listed', 'numListed') }
      : {}),
    ...(integerField(row, 'totalSupply', 'supply') !== undefined
      ? { totalSupply: integerField(row, 'totalSupply', 'supply') }
      : {}),
    ...(solValue(row, 'volume24hSol', 'volume24h', 'volume') ? { volume24hSol: solValue(row, 'volume24hSol', 'volume24h', 'volume') } : {}),
    rank: integerField(row, 'rank') ?? index + 1,
  };
}

function collectionFloor(row: Record<string, unknown>): {
  floorPriceLamports?: string;
  floorPriceSol?: string;
} {
  const explicitSol = solValue(row, 'floorPriceSol', 'floorSol');
  if (explicitSol) return { floorPriceSol: explicitSol };
  const raw = numberAsString(row.floorPriceLamports ?? row.floorPrice ?? row.floor);
  if (!raw) return {};
  if (raw.includes('.') || Number(raw) < 1_000_000) {
    return { floorPriceSol: raw };
  }
  return { floorPriceLamports: raw, floorPriceSol: lamportsToSolString(raw) };
}

function normalizeListingRow(row: unknown): MagicedenListingRow | null {
  if (!isObject(row)) return null;
  const mintAddress = stringField(row, 'tokenMint', 'mintAddress', 'mint');
  if (!mintAddress) return null;
  const priceLamports = listingPriceLamports(row);
  return {
    mintAddress,
    priceLamports,
    priceSol: lamportsToSolString(priceLamports),
    ...(stringField(row, 'pdaAddress', 'listingId') ? { listingId: stringField(row, 'pdaAddress', 'listingId') } : {}),
    ...(stringField(row, 'seller') ? { seller: stringField(row, 'seller') } : {}),
    ...(stringField(row, 'tokenName', 'name') ? { tokenName: stringField(row, 'tokenName', 'name') } : {}),
    ...(stringField(row, 'image') ? { tokenImage: stringField(row, 'image') } : {}),
    ...(stringField(row, 'auctionHouse') ? { auctionHouse: stringField(row, 'auctionHouse') } : {}),
    ...(stringField(row, 'expiry') ? { expiry: stringField(row, 'expiry') } : {}),
  };
}

function normalizeBidRow(row: unknown): MagicedenBidRow | null {
  if (!isObject(row)) return null;
  const lamports = bidPriceLamports(row);
  if (!lamports) return null;
  return {
    bidPriceLamports: lamports,
    bidPriceSol: lamportsToSolString(lamports),
    ...(stringField(row, 'pdaAddress', 'bidId') ? { bidId: stringField(row, 'pdaAddress', 'bidId') } : {}),
    ...(stringField(row, 'buyer', 'bidder') ? { buyer: stringField(row, 'buyer', 'bidder') } : {}),
    ...(stringField(row, 'tokenMint', 'mintAddress') ? { mintAddress: stringField(row, 'tokenMint', 'mintAddress') } : {}),
    ...(stringField(row, 'expiry') ? { expiry: stringField(row, 'expiry') } : {}),
  };
}

function normalizeActivityRow(row: unknown): MagicedenActivityRow | null {
  if (!isObject(row)) return null;
  const type = parseActivityType(row.type);
  const lamports = numberAsString(row.price);
  return {
    activityType: type,
    ...(stringField(row, 'signature', 'tx') ? { signature: stringField(row, 'signature', 'tx') } : {}),
    ...(typeof row.blockTime === 'number' ? { blockTime: row.blockTime } : {}),
    ...(stringField(row, 'tokenMint', 'mintAddress') ? { mintAddress: stringField(row, 'tokenMint', 'mintAddress') } : {}),
    ...(stringField(row, 'buyer') ? { buyer: stringField(row, 'buyer') } : {}),
    ...(stringField(row, 'seller') ? { seller: stringField(row, 'seller') } : {}),
    ...(lamports ? { priceLamports: lamports, priceSol: lamportsToSolString(lamports) } : {}),
  };
}

function normalizeWalletNftRow(row: unknown): MagicedenWalletNftRow | null {
  if (!isObject(row)) return null;
  const mintAddress = stringField(row, 'mintAddress', 'tokenMint', 'mint');
  if (!mintAddress) return null;
  const listingLamports = listingPriceLamports(row);
  const listed = Boolean(listingLamports && listingLamports !== '0');
  return {
    mintAddress,
    listed,
    ...(stringField(row, 'name', 'tokenName') ? { tokenName: stringField(row, 'name', 'tokenName') } : {}),
    ...(stringField(row, 'image') ? { tokenImage: stringField(row, 'image') } : {}),
    ...(stringField(row, 'collection') ? { collectionSymbol: stringField(row, 'collection') } : {}),
    ...(stringField(row, 'collectionName') ? { collectionName: stringField(row, 'collectionName') } : {}),
    ...(listed
      ? {
          listingPriceLamports: listingLamports,
          listingPriceSol: lamportsToSolString(listingLamports),
        }
      : {}),
    ...(stringField(row, 'pdaAddress', 'listingId')
      ? { listingId: stringField(row, 'pdaAddress', 'listingId') }
      : {}),
  };
}

function listingPriceLamports(row: Record<string, unknown>): string {
  const direct = numberAsString(row.priceLamports);
  if (direct) return direct;
  const priceSol = row.price;
  if (typeof priceSol === 'number' && Number.isFinite(priceSol)) {
    return BigInt(Math.round(priceSol * 1_000_000_000)).toString();
  }
  if (typeof priceSol === 'string' && /^\d+(\.\d+)?$/.test(priceSol)) {
    const [whole, fraction = ''] = priceSol.split('.');
    const paddedFraction = fraction.padEnd(9, '0').slice(0, 9);
    return (BigInt(whole ?? '0') * 1_000_000_000n + BigInt(paddedFraction || '0')).toString();
  }
  return '0';
}

function bidPriceLamports(row: Record<string, unknown>): string {
  return listingPriceLamports(row);
}

function lamportsToSolString(lamports: string): string {
  if (!/^\d+$/.test(lamports)) return '0';
  const value = BigInt(lamports);
  const whole = value / 1_000_000_000n;
  const fraction = value % 1_000_000_000n;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}.${fractionText}`;
}

function parseActivityType(value: unknown): MagicedenActivityType {
  if (typeof value !== 'string') return 'unknown';
  const v = value.toLowerCase();
  if (v === 'list' || v === 'listing') return 'list';
  if (v === 'delist' || v === 'cancel_list' || v === 'cancelList') return 'delist';
  if (v === 'buynow' || v === 'buy_now' || v === 'sale') return 'buy_now';
  if (v === 'bid' || v === 'offer') return 'bid';
  if (v === 'cancel_bid' || v === 'cancelBid' || v === 'cancel_offer') return 'cancel_bid';
  if (v === 'accept_bid' || v === 'acceptBid' || v === 'accept_offer') return 'accept_bid';
  if (v === 'mint') return 'mint';
  if (v === 'transfer') return 'transfer';
  return 'unknown';
}

function integerField(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return undefined;
}

function solValue(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = numberAsString(obj[key]);
    if (value) return value;
  }
  return undefined;
}

function stringField(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function numberAsString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  return undefined;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObject(value)) {
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.results)) return value.results;
    if (Array.isArray(value.rows)) return value.rows;
    if (Array.isArray(value.collections)) return value.collections;
    if (Array.isArray(value.listings)) return value.listings;
    if (Array.isArray(value.bids)) return value.bids;
    if (Array.isArray(value.activities)) return value.activities;
  }
  return [];
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
