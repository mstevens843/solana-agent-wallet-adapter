import {
  PYTH_DEFAULT_HERMES_URL,
  PYTH_HERMES_AUTH_ENV,
  PYTH_HERMES_URL_ENV,
  PYTH_RESPONSE_BYTE_LIMIT,
  type PythAssetType,
  normalizePriceFeedId,
  withFeedIdPrefix,
} from './constants.js';

const PYTH_SOLANA_RECEIVER_PACKAGE: string = '@pythnetwork/pyth-solana-receiver';

export interface PythHermesPriceUpdateRow {
  priceFeedId: string;
  priceRaw: string;
  confidenceRaw: string;
  exponent: number;
  publishTime: number;
  emaPriceRaw?: string;
  emaConfidenceRaw?: string;
  emaPublishTime?: number;
  metadata?: Record<string, unknown>;
}

export interface PythHermesPriceUpdate {
  rows: PythHermesPriceUpdateRow[];
  binary?: {
    encoding: string;
    data: string[];
  };
}

export interface PythHermesFeedMetadata {
  priceFeedId: string;
  symbol?: string;
  description?: string;
  assetType?: PythAssetType;
  base?: string;
  quoteCurrency?: string;
  attributes?: Record<string, string>;
}

export interface PythHermesClient {
  hermesUrl: string;
  getLatestPriceUpdates(input: {
    priceFeedIds: string[];
    encoding?: 'hex' | 'base64';
    parsed?: boolean;
    ignoreInvalidPriceIds?: boolean;
  }): Promise<PythHermesPriceUpdate>;
  getPriceFeeds(input: { query?: string; assetType?: PythAssetType }): Promise<PythHermesFeedMetadata[]>;
  getPriceFeedById(priceFeedId: string): Promise<PythHermesFeedMetadata | null>;
}

export interface PythReceiverBuildInput {
  walletAddress: string;
  priceUpdateDataHex: string[];
  closeUpdateAccounts: boolean;
  computeUnitPriceMicroLamports?: number;
  recentBlockhash?: string;
}

export interface PythReceiverBuildResult {
  transactionsBase64: string[];
  programIds: string[];
  receiverProgramId: string;
  treasuryId?: string;
}

export interface PythReceiverClient {
  buildPostPriceUpdate(input: PythReceiverBuildInput): Promise<PythReceiverBuildResult>;
}

let hermesFactory: () => PythHermesClient = () => buildDefaultHermesClient();
let cachedHermes: PythHermesClient | undefined;

let receiverFactory: () => PythReceiverClient = () => buildDefaultReceiverClient();
let cachedReceiver: PythReceiverClient | undefined;

export function setPythClientFactory(next: () => PythHermesClient): void {
  hermesFactory = next;
  cachedHermes = undefined;
}

export function resetPythClientFactory(): void {
  hermesFactory = () => buildDefaultHermesClient();
  cachedHermes = undefined;
}

export function getPythClient(): PythHermesClient {
  if (!cachedHermes) cachedHermes = hermesFactory();
  return cachedHermes;
}

export function setPythReceiverFactory(next: () => PythReceiverClient): void {
  receiverFactory = next;
  cachedReceiver = undefined;
}

export function resetPythReceiverFactory(): void {
  receiverFactory = () => buildDefaultReceiverClient();
  cachedReceiver = undefined;
}

export function getPythReceiver(): PythReceiverClient {
  if (!cachedReceiver) cachedReceiver = receiverFactory();
  return cachedReceiver;
}

export function describePythUnavailableReason(): string | undefined {
  const client = getPythClient();
  return client instanceof HermesUnavailable ? client.reason : undefined;
}

export function describePythReceiverUnavailableReason(): string | undefined {
  const client = getPythReceiver();
  return client instanceof ReceiverUnavailable ? client.reason : undefined;
}

const RECEIVER_UNAVAILABLE_REASON =
  '@pythnetwork/pyth-solana-receiver is not installed. Add it to the host environment to enable Pyth on-chain price-update preparation.';

const HERMES_MISCONFIGURED_REASON_PREFIX = 'Pyth Hermes URL is invalid';

class HermesUnavailable implements PythHermesClient {
  readonly hermesUrl: string;
  readonly reason: string;

  constructor(hermesUrl: string, reason: string) {
    this.hermesUrl = hermesUrl;
    this.reason = reason;
  }

  private fail(method: string): never {
    throw new Error(`Pyth Hermes client is not configured (${method}): ${this.reason}`);
  }

  async getLatestPriceUpdates(): Promise<PythHermesPriceUpdate> {
    this.fail('getLatestPriceUpdates');
  }

  async getPriceFeeds(): Promise<PythHermesFeedMetadata[]> {
    this.fail('getPriceFeeds');
  }

  async getPriceFeedById(): Promise<PythHermesFeedMetadata | null> {
    this.fail('getPriceFeedById');
  }
}

class ReceiverUnavailable implements PythReceiverClient {
  readonly reason = RECEIVER_UNAVAILABLE_REASON;

  async buildPostPriceUpdate(): Promise<PythReceiverBuildResult> {
    throw new Error(`Pyth Solana Receiver is not available: ${this.reason}`);
  }
}

function buildDefaultHermesClient(): PythHermesClient {
  const rawUrl = (process.env[PYTH_HERMES_URL_ENV] ?? '').trim() || PYTH_DEFAULT_HERMES_URL;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return new HermesUnavailable(rawUrl, `${HERMES_MISCONFIGURED_REASON_PREFIX}: ${rawUrl}`);
  }
  const normalizedBase = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, '')}`;
  const authToken = (process.env[PYTH_HERMES_AUTH_ENV] ?? '').trim() || undefined;
  return new HermesFetchClient({ baseUrl: normalizedBase, authToken });
}

function buildDefaultReceiverClient(): PythReceiverClient {
  return new DynamicReceiverClient();
}

interface HermesFetchOptions {
  baseUrl: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

class HermesFetchClient implements PythHermesClient {
  readonly hermesUrl: string;
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HermesFetchOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.hermesUrl = this.baseUrl;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getLatestPriceUpdates(input: {
    priceFeedIds: string[];
    encoding?: 'hex' | 'base64';
    parsed?: boolean;
    ignoreInvalidPriceIds?: boolean;
  }): Promise<PythHermesPriceUpdate> {
    const normalized = input.priceFeedIds
      .map(normalizePriceFeedId)
      .filter((id) => id.length > 0);
    if (normalized.length === 0) {
      return { rows: [] };
    }
    const params = new URLSearchParams();
    for (const id of normalized) params.append('ids[]', withFeedIdPrefix(id));
    params.set('encoding', input.encoding ?? 'hex');
    params.set('parsed', String(input.parsed ?? true));
    if (input.ignoreInvalidPriceIds) {
      params.set('ignore_invalid_price_ids', 'true');
    }
    const body = await this.requestJson<HermesUpdatesResponse>(
      `/v2/updates/price/latest?${params.toString()}`,
    );
    return normalizeUpdates(body);
  }

  async getPriceFeeds(input: { query?: string; assetType?: PythAssetType }): Promise<PythHermesFeedMetadata[]> {
    const params = new URLSearchParams();
    if (input.query?.trim()) params.set('query', input.query.trim());
    if (input.assetType && input.assetType !== 'all') params.set('asset_type', input.assetType);
    const query = params.toString();
    const body = await this.requestJson<HermesFeedsResponse>(
      `/v2/price_feeds${query ? `?${query}` : ''}`,
    );
    return normalizeFeedList(body);
  }

  async getPriceFeedById(priceFeedId: string): Promise<PythHermesFeedMetadata | null> {
    const normalized = normalizePriceFeedId(priceFeedId);
    if (!normalized) return null;
    try {
      const body = await this.requestJson<HermesFeedResponse>(`/v2/price_feeds/${normalized}`);
      return normalizeFeedMetadata(body);
    } catch (err) {
      if (err instanceof HermesHttpError && err.status === 404) return null;
      throw err;
    }
  }

  private async requestJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.headers(),
      });
    } catch (err) {
      throw redactPythError(err, this.authToken);
    }
    return readJsonResponse<T>(response, this.authToken);
  }

  private headers(): Record<string, string> {
    const base: Record<string, string> = {
      accept: 'application/json',
    };
    if (this.authToken) base.authorization = `Bearer ${this.authToken}`;
    return base;
  }
}

class DynamicReceiverClient implements PythReceiverClient {
  private cached?: PythReceiverClient;

  async buildPostPriceUpdate(input: PythReceiverBuildInput): Promise<PythReceiverBuildResult> {
    const impl = await this.resolve();
    if (impl instanceof ReceiverUnavailable) {
      throw new Error(`Pyth Solana Receiver is not available: ${impl.reason}`);
    }
    return impl.buildPostPriceUpdate(input);
  }

  private async resolve(): Promise<PythReceiverClient> {
    if (this.cached) return this.cached;
    try {
      const [{ PythSolanaReceiver }, web3] = await Promise.all([
        import(PYTH_SOLANA_RECEIVER_PACKAGE),
        import('@solana/web3.js'),
      ]);
      this.cached = new SolanaReceiverWrapper({ PythSolanaReceiver, web3 });
    } catch {
      this.cached = new ReceiverUnavailable();
    }
    return this.cached;
  }
}

class SolanaReceiverWrapper implements PythReceiverClient {
  private readonly PythSolanaReceiver: any;
  private readonly web3: typeof import('@solana/web3.js');

  constructor(deps: {
    PythSolanaReceiver: any;
    web3: typeof import('@solana/web3.js');
  }) {
    this.PythSolanaReceiver = deps.PythSolanaReceiver;
    this.web3 = deps.web3;
  }

  async buildPostPriceUpdate(input: PythReceiverBuildInput): Promise<PythReceiverBuildResult> {
    const { Connection, PublicKey, VersionedTransaction } = this.web3;
    const wallet = wrapAsNodeWallet(this.web3, input.walletAddress);
    const placeholderConnection = new Connection('http://localhost:8899');
    const receiver = new this.PythSolanaReceiver({ connection: placeholderConnection, wallet });
    const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: input.closeUpdateAccounts });
    await builder.addPostPriceUpdates(input.priceUpdateDataHex);
    const versioned: Array<{ tx: InstanceType<typeof VersionedTransaction>; signers: Array<{ secretKey: Uint8Array; publicKey: InstanceType<typeof PublicKey> }> }> =
      await builder.buildVersionedTransactions({
        ...(input.computeUnitPriceMicroLamports !== undefined
          ? { computeUnitPriceMicroLamports: input.computeUnitPriceMicroLamports }
          : {}),
      });
    const transactionsBase64 = versioned.map(({ tx, signers }) => {
      if (signers.length > 0) {
        tx.sign(signers);
      }
      const wireBytes = tx.serialize();
      return Buffer.from(wireBytes).toString('base64');
    });
    const receiverProgramId = receiver.receiver.programId.toBase58();
    const wormholeProgramId = receiver.wormhole.programId.toBase58();
    return {
      transactionsBase64,
      programIds: [receiverProgramId, wormholeProgramId],
      receiverProgramId,
    };
  }
}

function wrapAsNodeWallet(
  web3: typeof import('@solana/web3.js'),
  walletAddress: string,
): { publicKey: InstanceType<typeof web3.PublicKey>; signTransaction: (tx: unknown) => Promise<unknown>; signAllTransactions: (txs: unknown[]) => Promise<unknown[]>; payer: InstanceType<typeof web3.Keypair> } {
  const publicKey = new web3.PublicKey(walletAddress);
  const payer = web3.Keypair.generate();
  return {
    publicKey,
    payer,
    async signTransaction(tx: unknown): Promise<unknown> {
      return tx;
    },
    async signAllTransactions(txs: unknown[]): Promise<unknown[]> {
      return txs;
    },
  };
}

interface HermesUpdatesResponse {
  binary?: { encoding?: string; data?: unknown };
  parsed?: unknown;
}

interface HermesParsedRow {
  id?: unknown;
  price?: { price?: unknown; conf?: unknown; expo?: unknown; publish_time?: unknown };
  ema_price?: { price?: unknown; conf?: unknown; expo?: unknown; publish_time?: unknown };
  metadata?: unknown;
}

interface HermesFeedsResponse {
  // /v2/price_feeds returns an array directly.
}

interface HermesFeedResponse {
  // /v2/price_feeds/<id> returns a single object.
}

function normalizeUpdates(body: HermesUpdatesResponse): PythHermesPriceUpdate {
  const parsedList = Array.isArray(body.parsed) ? (body.parsed as HermesParsedRow[]) : [];
  const rows: PythHermesPriceUpdateRow[] = [];
  for (const entry of parsedList) {
    const row = normalizeParsedRow(entry);
    if (row) rows.push(row);
  }
  const binary = body.binary;
  const result: PythHermesPriceUpdate = { rows };
  if (binary && typeof binary.encoding === 'string' && Array.isArray(binary.data)) {
    result.binary = {
      encoding: binary.encoding,
      data: binary.data.filter((entry): entry is string => typeof entry === 'string'),
    };
  }
  return result;
}

function normalizeParsedRow(entry: HermesParsedRow | undefined): PythHermesPriceUpdateRow | null {
  if (!entry) return null;
  const priceFeedId = normalizePriceFeedId(typeof entry.id === 'string' ? entry.id : '');
  if (!priceFeedId) return null;
  const price = entry.price;
  if (!price) return null;
  const exponent = numberOrNull(price.expo);
  const publishTime = numberOrNull(price.publish_time);
  const priceRaw = stringOrNull(price.price);
  const confidenceRaw = stringOrNull(price.conf);
  if (exponent === null || publishTime === null || priceRaw === null || confidenceRaw === null) {
    return null;
  }
  const row: PythHermesPriceUpdateRow = {
    priceFeedId,
    priceRaw,
    confidenceRaw,
    exponent,
    publishTime,
  };
  const ema = entry.ema_price;
  if (ema) {
    const emaPrice = stringOrNull(ema.price);
    const emaConf = stringOrNull(ema.conf);
    const emaTime = numberOrNull(ema.publish_time);
    if (emaPrice !== null) row.emaPriceRaw = emaPrice;
    if (emaConf !== null) row.emaConfidenceRaw = emaConf;
    if (emaTime !== null) row.emaPublishTime = emaTime;
  }
  if (entry.metadata && typeof entry.metadata === 'object') {
    row.metadata = entry.metadata as Record<string, unknown>;
  }
  return row;
}

function normalizeFeedList(body: unknown): PythHermesFeedMetadata[] {
  const rows = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? ((body as { data: unknown[] }).data) : [];
  const result: PythHermesFeedMetadata[] = [];
  for (const entry of rows) {
    const normalized = normalizeFeedMetadata(entry);
    if (normalized) result.push(normalized);
  }
  return result;
}

function normalizeFeedMetadata(value: unknown): PythHermesFeedMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const priceFeedId = normalizePriceFeedId(typeof obj.id === 'string' ? obj.id : '');
  if (!priceFeedId) return null;
  const attributes = (obj.attributes && typeof obj.attributes === 'object' ? obj.attributes : {}) as Record<string, string>;
  const symbol = typeof attributes.symbol === 'string' && attributes.symbol
    ? attributes.symbol
    : typeof attributes.generic_symbol === 'string'
      ? attributes.generic_symbol
      : undefined;
  const description = typeof attributes.description === 'string' ? attributes.description : undefined;
  const rawAssetType = typeof attributes.asset_type === 'string' ? attributes.asset_type.toLowerCase() : '';
  const assetType: PythAssetType | undefined =
    rawAssetType === 'crypto' || rawAssetType === 'equity' || rawAssetType === 'fx' || rawAssetType === 'commodity'
      ? (rawAssetType as PythAssetType)
      : undefined;
  const base = typeof attributes.base === 'string' ? attributes.base : undefined;
  const quoteCurrency = typeof attributes.quote_currency === 'string' ? attributes.quote_currency : undefined;
  const out: PythHermesFeedMetadata = { priceFeedId };
  if (symbol !== undefined) out.symbol = symbol;
  if (description !== undefined) out.description = description;
  if (assetType !== undefined) out.assetType = assetType;
  if (base !== undefined) out.base = base;
  if (quoteCurrency !== undefined) out.quoteCurrency = quoteCurrency;
  out.attributes = attributes;
  return out;
}

class HermesHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HermesHttpError';
    this.status = status;
  }
}

async function readJsonResponse<T>(response: Response, authToken: string | undefined): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (err) {
    throw redactPythError(err, authToken);
  }
  if (!response.ok) {
    const message = redactString(text, authToken).slice(0, 500) || `HTTP ${response.status}`;
    throw redactPythError(new HermesHttpError(response.status, message), authToken);
  }
  if (!contentType.toLowerCase().includes('json')) {
    throw redactPythError(
      new Error(`Hermes returned non-JSON response (content-type: ${contentType || 'unknown'}).`),
      authToken,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw redactPythError(err, authToken);
  }
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
      if (received > PYTH_RESPONSE_BYTE_LIMIT) {
        try {
          await reader.cancel();
        } catch {
          // ignore cancellation errors
        }
        throw new Error(`Pyth Hermes response exceeded ${PYTH_RESPONSE_BYTE_LIMIT} bytes; refusing to read further.`);
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

export function redactPythError(err: unknown, authToken: string | undefined): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const cleanedMessage = redactString(original.message, authToken);
  if (original instanceof HermesHttpError) {
    return new HermesHttpError(original.status, cleanedMessage);
  }
  const wrapped = new Error(cleanedMessage);
  wrapped.name = original.name || 'Error';
  return wrapped;
}

function redactString(value: string, authToken: string | undefined): string {
  if (!value) return value;
  let safe = value;
  if (authToken) safe = safe.split(authToken).join('***');
  safe = safe.replace(/(authorization\s*[:=]\s*)["']?(?:bearer\s+)?[A-Za-z0-9._-]+["']?/gi, '$1***');
  safe = safe.replace(/(x-api-key\s*[:=]\s*)["']?[A-Za-z0-9._-]+["']?/gi, '$1***');
  return safe;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export { HermesHttpError };
