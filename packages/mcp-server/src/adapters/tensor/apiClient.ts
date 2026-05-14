import type { Connection } from '@solana/web3.js';

import { parsePositiveSolDecimal } from '../solDecimal.js';
import { AdapterError } from '../types.js';
import {
  TENSOR_ADAPTER_ID,
  TENSOR_API_BASE_URL_ENV,
  TENSOR_API_KEY_ENV,
  TENSOR_DEFAULT_API_BASE_URL,
  TENSOR_PROGRAM_IDS,
  solFromLamports,
} from './constants.js';
import type {
  TensorBidInput,
  TensorBid,
  TensorBuiltTx,
  TensorClient,
  TensorCollectionSnapshot,
  TensorListing,
  TensorNftDetail,
  TensorRefreshBidInput,
  TensorSale,
  TensorSupportedCollectionsResult,
  TensorWalletExposure,
  TensorWalletNftsResult,
} from './client.js';

type TensorFetch = (
  input: string | URL,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}>;

export interface TensorApiClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: TensorFetch;
}

export function buildTensorApiClient(options: TensorApiClientOptions = {}): TensorClient {
  return new TensorApiClient(options);
}

class TensorApiClient implements TensorClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: TensorFetch;

  constructor(options: TensorApiClientOptions) {
    const apiKey = options.apiKey?.trim() || process.env[TENSOR_API_KEY_ENV]?.trim() || '';
    if (!apiKey) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'missing_api_key',
        `Tensor API client requires ${TENSOR_API_KEY_ENV}.`,
      );
    }
    const defaultFetch = (globalThis as { fetch?: TensorFetch }).fetch;
    const fetchImpl = options.fetchImpl ?? defaultFetch;
    if (!fetchImpl) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'fetch_unavailable',
        'Tensor API client requires global fetch or an injected fetch implementation.',
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl?.trim() ||
      process.env[TENSOR_API_BASE_URL_ENV]?.trim() ||
      TENSOR_DEFAULT_API_BASE_URL,
    );
    this.fetchImpl = fetchImpl;
  }

  async fetchSupportedCollections(): Promise<TensorSupportedCollectionsResult> {
    return { collections: [], asOf: new Date().toISOString(), source: 'tensor-api' };
  }

  async fetchCollectionStats(_connection: Connection, collectionId: string): Promise<TensorCollectionSnapshot> {
    return {
      collectionId,
      asOf: new Date().toISOString(),
      warnings: ['Tensor REST client is configured for transaction building; collection stats are not populated yet.'],
    };
  }

  async fetchCollectionListings(): Promise<TensorListing[]> {
    return this.unsupported('fetchCollectionListings');
  }

  async fetchCollectionBids(): Promise<TensorBid[]> {
    return this.unsupported('fetchCollectionBids');
  }

  async fetchRecentSales(): Promise<TensorSale[]> {
    return this.unsupported('fetchRecentSales');
  }

  async fetchWalletNfts(
    _connection: Connection,
    input: { walletAddress: string; collectionId?: string; includeCompressed?: boolean },
  ): Promise<TensorWalletNftsResult> {
    return {
      walletAddress: input.walletAddress,
      ...(input.collectionId !== undefined && { collectionId: input.collectionId }),
      nfts: [],
      totals: { nfts: 0, compressed: 0 },
      asOf: new Date().toISOString(),
    };
  }

  async fetchNftDetail(): Promise<TensorNftDetail> {
    return this.unsupported('fetchNftDetail');
  }

  async fetchWalletExposure(_connection: Connection, walletAddress: string): Promise<TensorWalletExposure> {
    const json = await this.getJson('/user/escrow_accounts', { owner: walletAddress });
    const rows = extractRows(json);
    const marginBalanceLamports = rows.reduce((sum, row) => sum + escrowLamportsFromRow(row), 0n);
    return {
      walletAddress,
      ownedCollections: [],
      openListings: [],
      openBids: [],
      marginBalanceLamports: marginBalanceLamports.toString(),
      marginBalanceSol: solFromLamports(marginBalanceLamports),
      asOf: new Date().toISOString(),
    };
  }

  async refreshListing(): Promise<TensorListing | null> {
    return this.unsupported('refreshListing');
  }

  async refreshBid(_connection: Connection, _input: TensorRefreshBidInput): Promise<null> {
    return null;
  }

  async buildBuyTx(): Promise<TensorBuiltTx> {
    return this.unsupported('buildBuyTx');
  }

  async buildListTx(): Promise<TensorBuiltTx> {
    return this.unsupported('buildListTx');
  }

  async buildCancelListingTx(): Promise<TensorBuiltTx> {
    return this.unsupported('buildCancelListingTx');
  }

  async buildBidTx(connection: Connection, input: TensorBidInput): Promise<TensorBuiltTx> {
    if (input.mintAddress || input.assetId) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'unsupported_method',
        'Tensor REST client currently builds collection bid transactions; single NFT bid transaction wiring is not enabled yet.',
      );
    }
    const latest = await connection.getLatestBlockhash();
    const bidPriceSol = solFromLamports(input.bidPriceLamports);
    const topUpLamports = BigInt(input.bidPriceLamports) * BigInt(input.quantity);
    const json = await this.getJson('/tx/collection_bid', {
      owner: input.walletAddress,
      price: bidPriceSol,
      quantity: String(input.quantity),
      collId: input.collectionId,
      blockhash: latest.blockhash,
      useSharedEscrow: 'true',
      topUp: solFromLamports(topUpLamports),
      ...(input.expiresAt ? { expireIn: String(expireInSeconds(input.expiresAt)) } : {}),
    });
    return {
      transactionBase64: extractTransactionBase64(json),
      preview: {
        programIds: TENSOR_PROGRAM_IDS,
        compressed: input.compressed,
        notes: ['Tensor REST collection bid transaction.'],
      },
    };
  }

  async buildCancelBidTx(): Promise<TensorBuiltTx> {
    return this.unsupported('buildCancelBidTx');
  }

  async buildSweepTx(): Promise<TensorBuiltTx> {
    return this.unsupported('buildSweepTx');
  }

  private async getJson(path: string, params: Record<string, string | undefined>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'x-tensor-api-key': this.apiKey,
      },
    });
    const text = await response.text();
    const json = parseJson(text);
    if (!response.ok) {
      const detail = responseErrorDetail(json) ?? (text.slice(0, 240) || response.statusText || 'request failed');
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'api_error',
        `Tensor API ${path} failed (${response.status}): ${detail}`,
      );
    }
    return json;
  }

  private unsupported(method: string): never {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'unsupported_method',
      `Tensor REST client does not implement ${method} yet.`,
    );
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseErrorDetail(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['message', 'error', 'detail']) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return undefined;
}

function extractRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ['escrowAccounts', 'escrows', 'accounts', 'results', 'data']) {
    const rows = value[key];
    if (Array.isArray(rows)) return rows.filter(isRecord);
  }
  return [value];
}

function escrowLamportsFromRow(row: Record<string, unknown>): bigint {
  for (const key of ['balanceLamports', 'lamports', 'amountLamports', 'escrowLamports', 'marginBalanceLamports']) {
    const lamports = bigintFromUnknown(row[key]);
    if (lamports !== undefined) return lamports;
  }
  for (const key of ['balance', 'amount', 'escrow', 'marginBalance', 'solBalance']) {
    const sol = solLamportsFromUnknown(row[key]);
    if (sol !== undefined) return sol;
  }
  return 0n;
}

function bigintFromUnknown(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return undefined;
}

function solLamportsFromUnknown(value: unknown): bigint | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  try {
    return parsePositiveSolDecimal(String(value), 'Tensor escrow balance').lamports;
  } catch {
    return undefined;
  }
}

function extractTransactionBase64(value: unknown): string {
  const candidate = firstTransactionCandidate(value);
  const encoded = transactionBase64FromCandidate(candidate);
  if (encoded) return encoded;
  throw new AdapterError(
    TENSOR_ADAPTER_ID,
    'api_error',
    'Tensor API response did not include a transaction payload.',
  );
}

function firstTransactionCandidate(value: unknown): unknown {
  if (!isRecord(value)) return value;
  for (const key of ['txs', 'transactions', 'data']) {
    const rows = value[key];
    if (Array.isArray(rows) && rows.length > 0) return rows[0];
  }
  return value;
}

function transactionBase64FromCandidate(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
    return Buffer.from(value).toString('base64');
  }
  if (!isRecord(value)) return undefined;
  for (const key of ['tx', 'txV0', 'transaction', 'transactionBase64', 'base64']) {
    const encoded = transactionBase64FromCandidate(value[key]);
    if (encoded) return encoded;
  }
  const data = value.data;
  if (Array.isArray(data) && data.every((item) => typeof item === 'number')) {
    return Buffer.from(data).toString('base64');
  }
  return undefined;
}

function expireInSeconds(expiresAt: string): number {
  return Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
}
