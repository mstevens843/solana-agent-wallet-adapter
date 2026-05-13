import {
  LULO_API_BASE_URL_ENV,
  LULO_API_KEY_ENV,
  LULO_DEFAULT_API_BASE_URL,
  LULO_RESPONSE_BYTE_LIMIT,
  type LuloDepositType,
  type LuloWithdrawType,
} from './constants.js';

export interface LuloRateRow {
  mintAddress: string;
  symbol?: string;
  depositType: LuloDepositType;
  apy: number;
  apyAsOfIso?: string;
  tvlUsd?: string;
  liquidityAvailable?: string;
}

export interface LuloRatesSnapshot {
  rows: LuloRateRow[];
  asOfIso: string;
  source: 'lulo-api';
}

export interface LuloPoolMetaRow {
  mintAddress: string;
  symbol?: string;
  decimals?: number;
  supportedDepositTypes: LuloDepositType[];
  programIds: string[];
  cooldownSeconds?: number;
  notes?: string[];
}

export interface LuloPoolMetaSnapshot {
  pools: LuloPoolMetaRow[];
  asOfIso: string;
  source: 'lulo-api';
}

export interface LuloPositionRow {
  mintAddress: string;
  symbol?: string;
  depositType: LuloDepositType;
  amountRaw?: string;
  amountUi?: string;
  earnedInterestUi?: string;
  apy?: number;
  withdrawableUi?: string;
  pendingWithdrawals?: Array<{
    withdrawalId: string;
    amountUi?: string;
    expectedReadyAtIso?: string;
    status?: string;
  }>;
}

export interface LuloWalletBalancesSnapshot {
  walletAddress: string;
  rows: LuloPositionRow[];
  asOfIso: string;
  source: 'lulo-api';
}

export interface LuloBalancesUnavailable {
  balances_unavailable: true;
  reason: string;
}

export interface LuloPrepareDepositInput {
  walletAddress: string;
  mintAddress: string;
  amountRaw: bigint;
  depositType: LuloDepositType;
  priorityFee?: number;
}

export interface LuloPrepareDepositResult {
  transactionBase64: string;
  programIds: string[];
  ratesSnapshot?: LuloRateRow;
  poolMetaSnapshot?: LuloPoolMetaRow;
  decimalsHint?: number;
}

export interface LuloPrepareWithdrawInput {
  walletAddress: string;
  mintAddress: string;
  withdrawType: LuloWithdrawType;
  amountRaw?: bigint;
  percentage?: number;
}

export interface LuloPrepareWithdrawResult {
  transactionBase64: string;
  programIds: string[];
  withdrawalId?: string;
  cooldownSeconds?: number;
  expectedReadyAtIso?: string;
  decimalsHint?: number;
  amountRawHint?: string;
}

export interface LuloPrepareCompleteWithdrawInput {
  walletAddress: string;
  mintAddress: string;
  withdrawalId: string;
}

export interface LuloPrepareCompleteWithdrawResult {
  transactionBase64: string;
  programIds: string[];
  decimalsHint?: number;
}

export interface LuloClient {
  getRates(input: { mintAddress?: string; depositType?: LuloDepositType }): Promise<LuloRatesSnapshot>;
  getPoolMeta(input: { mintAddress?: string }): Promise<LuloPoolMetaSnapshot>;
  getWalletBalances(input: {
    walletAddress: string;
  }): Promise<LuloWalletBalancesSnapshot | LuloBalancesUnavailable>;
  generateDepositTransaction(input: LuloPrepareDepositInput): Promise<LuloPrepareDepositResult>;
  generateWithdrawTransaction(input: LuloPrepareWithdrawInput): Promise<LuloPrepareWithdrawResult>;
  generateCompleteWithdrawTransaction(
    input: LuloPrepareCompleteWithdrawInput,
  ): Promise<LuloPrepareCompleteWithdrawResult>;
}

const UNAVAILABLE_REASON = `${LULO_API_KEY_ENV} is not set. Configure ${LULO_API_KEY_ENV} (and optionally ${LULO_API_BASE_URL_ENV}) in the host environment to enable Lulo first-class reads and prepared actions, or inject a mock via setLuloClientFactory for tests.`;

class LuloApiUnavailable implements LuloClient {
  readonly reason = UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new Error(`Lulo adapter is not configured (${method}): ${this.reason}`);
  }

  async getRates(): Promise<LuloRatesSnapshot> {
    this.fail('getRates');
  }

  async getPoolMeta(): Promise<LuloPoolMetaSnapshot> {
    this.fail('getPoolMeta');
  }

  async getWalletBalances(): Promise<LuloWalletBalancesSnapshot> {
    this.fail('getWalletBalances');
  }

  async generateDepositTransaction(): Promise<LuloPrepareDepositResult> {
    this.fail('generateDepositTransaction');
  }

  async generateWithdrawTransaction(): Promise<LuloPrepareWithdrawResult> {
    this.fail('generateWithdrawTransaction');
  }

  async generateCompleteWithdrawTransaction(): Promise<LuloPrepareCompleteWithdrawResult> {
    this.fail('generateCompleteWithdrawTransaction');
  }
}

let factory: () => LuloClient = () => buildDefaultLuloClient();
let cached: LuloClient | undefined;

export function setLuloClientFactory(next: () => LuloClient): void {
  factory = next;
  cached = undefined;
}

export function resetLuloClientFactory(): void {
  factory = () => buildDefaultLuloClient();
  cached = undefined;
}

export function getLuloClient(): LuloClient {
  if (!cached) cached = factory();
  return cached;
}

export function isLuloConfigured(): boolean {
  return !(getLuloClient() instanceof LuloApiUnavailable);
}

export function describeLuloUnavailableReason(): string | undefined {
  const client = getLuloClient();
  return client instanceof LuloApiUnavailable ? client.reason : undefined;
}

function buildDefaultLuloClient(): LuloClient {
  const apiKey = (process.env[LULO_API_KEY_ENV] ?? '').trim();
  if (!apiKey) return new LuloApiUnavailable();
  const rawBase = (process.env[LULO_API_BASE_URL_ENV] ?? '').trim();
  const baseUrl = normalizeBaseUrl(rawBase || LULO_DEFAULT_API_BASE_URL);
  return new LuloApiClient({ apiKey, baseUrl });
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

interface LuloApiClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

class LuloApiClient implements LuloClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LuloApiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getRates(input: { mintAddress?: string; depositType?: LuloDepositType }): Promise<LuloRatesSnapshot> {
    const params = new URLSearchParams();
    if (input.mintAddress) params.set('mint', input.mintAddress);
    if (input.depositType) params.set('type', input.depositType);
    const body = await this.requestJson<LuloRatesApiResponse>(`/rates${query(params)}`, 'GET');
    return {
      rows: normalizeRateRows(body),
      asOfIso: new Date().toISOString(),
      source: 'lulo-api',
    };
  }

  async getPoolMeta(input: { mintAddress?: string }): Promise<LuloPoolMetaSnapshot> {
    const params = new URLSearchParams();
    if (input.mintAddress) params.set('mint', input.mintAddress);
    const body = await this.requestJson<LuloPoolsApiResponse>(`/pools${query(params)}`, 'GET');
    return {
      pools: normalizePoolRows(body),
      asOfIso: new Date().toISOString(),
      source: 'lulo-api',
    };
  }

  async getWalletBalances(input: {
    walletAddress: string;
  }): Promise<LuloWalletBalancesSnapshot | LuloBalancesUnavailable> {
    const params = new URLSearchParams({ wallet: input.walletAddress });
    try {
      const body = await this.requestJson<LuloBalancesApiResponse>(`/balances${query(params)}`, 'GET');
      return {
        walletAddress: input.walletAddress,
        rows: normalizePositionRows(body),
        asOfIso: new Date().toISOString(),
        source: 'lulo-api',
      };
    } catch (err) {
      if (err instanceof LuloHttpError && (err.status === 404 || err.status === 501)) {
        return {
          balances_unavailable: true,
          reason: `Lulo API does not currently expose balances for this wallet (${err.status}).`,
        };
      }
      throw err;
    }
  }

  async generateDepositTransaction(input: LuloPrepareDepositInput): Promise<LuloPrepareDepositResult> {
    const body = await this.requestJson<LuloTransactionApiResponse>(`/transactions/deposit`, 'POST', {
      wallet: input.walletAddress,
      mint: input.mintAddress,
      amount: input.amountRaw.toString(),
      depositType: input.depositType,
      ...(input.priorityFee !== undefined ? { priorityFee: input.priorityFee } : {}),
    });
    return {
      transactionBase64: requireString(body, 'transaction'),
      programIds: normalizeProgramIds(body.programIds),
      ...(body.rate ? { ratesSnapshot: normalizeRateRow(body.rate) } : {}),
      ...(body.pool ? { poolMetaSnapshot: normalizePoolRow(body.pool) } : {}),
      ...(typeof body.decimals === 'number' ? { decimalsHint: body.decimals } : {}),
    };
  }

  async generateWithdrawTransaction(input: LuloPrepareWithdrawInput): Promise<LuloPrepareWithdrawResult> {
    const body = await this.requestJson<LuloTransactionApiResponse>(`/transactions/withdraw`, 'POST', {
      wallet: input.walletAddress,
      mint: input.mintAddress,
      withdrawType: input.withdrawType,
      ...(input.amountRaw !== undefined ? { amount: input.amountRaw.toString() } : {}),
      ...(input.percentage !== undefined ? { percentage: input.percentage } : {}),
    });
    return {
      transactionBase64: requireString(body, 'transaction'),
      programIds: normalizeProgramIds(body.programIds),
      ...(typeof body.withdrawalId === 'string' ? { withdrawalId: body.withdrawalId } : {}),
      ...(typeof body.cooldownSeconds === 'number' ? { cooldownSeconds: body.cooldownSeconds } : {}),
      ...(typeof body.expectedReadyAt === 'string' ? { expectedReadyAtIso: body.expectedReadyAt } : {}),
      ...(typeof body.decimals === 'number' ? { decimalsHint: body.decimals } : {}),
      ...(typeof body.amount === 'string' ? { amountRawHint: body.amount } : {}),
    };
  }

  async generateCompleteWithdrawTransaction(
    input: LuloPrepareCompleteWithdrawInput,
  ): Promise<LuloPrepareCompleteWithdrawResult> {
    const body = await this.requestJson<LuloTransactionApiResponse>(`/transactions/complete-withdraw`, 'POST', {
      wallet: input.walletAddress,
      mint: input.mintAddress,
      withdrawalId: input.withdrawalId,
    });
    return {
      transactionBase64: requireString(body, 'transaction'),
      programIds: normalizeProgramIds(body.programIds),
      ...(typeof body.decimals === 'number' ? { decimalsHint: body.decimals } : {}),
    };
  }

  private async requestJson<T>(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          'x-api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw redactLuloError(err, this.apiKey);
    }
    return readJsonResponse<T>(response, this.apiKey);
  }
}

interface LuloRatesApiResponse {
  rates?: unknown;
  data?: unknown;
}

interface LuloPoolsApiResponse {
  pools?: unknown;
  data?: unknown;
}

interface LuloBalancesApiResponse {
  positions?: unknown;
  balances?: unknown;
  data?: unknown;
}

interface LuloTransactionApiResponse {
  transaction?: unknown;
  programIds?: unknown;
  rate?: unknown;
  pool?: unknown;
  withdrawalId?: unknown;
  cooldownSeconds?: unknown;
  expectedReadyAt?: unknown;
  decimals?: unknown;
  amount?: unknown;
}

class LuloHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'LuloHttpError';
    this.status = status;
  }
}

async function readJsonResponse<T>(response: Response, apiKey: string): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (err) {
    throw redactLuloError(err, apiKey);
  }
  if (!response.ok) {
    const message = redactString(text, apiKey).slice(0, 500) || `HTTP ${response.status}`;
    throw redactLuloError(new LuloHttpError(response.status, message), apiKey);
  }
  if (!contentType.toLowerCase().includes('json')) {
    throw redactLuloError(
      new Error(`Lulo API returned non-JSON response (content-type: ${contentType || 'unknown'}).`),
      apiKey,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw redactLuloError(err, apiKey);
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
      if (received > LULO_RESPONSE_BYTE_LIMIT) {
        try {
          await reader.cancel();
        } catch {
          // ignore cancellation errors
        }
        throw new Error(`Lulo API response exceeded ${LULO_RESPONSE_BYTE_LIMIT} bytes; refusing to read further.`);
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

export function redactLuloError(err: unknown, apiKey: string): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const cleanedMessage = redactString(original.message, apiKey);
  if (original instanceof LuloHttpError) {
    return new LuloHttpError(original.status, cleanedMessage);
  }
  const wrapped = new Error(cleanedMessage);
  wrapped.name = original.name || 'Error';
  return wrapped;
}

function redactString(value: string, apiKey: string): string {
  if (!value) return value;
  if (!apiKey) return value;
  const safe = value.split(apiKey).join('***');
  return safe.replace(/(x-api-key\s*[:=]\s*)["']?[A-Za-z0-9._-]+["']?/gi, '$1***');
}

function normalizeRateRows(body: LuloRatesApiResponse): LuloRateRow[] {
  const rows = asArray(body.rates ?? body.data);
  return rows.map(normalizeRateRow).filter((row): row is LuloRateRow => row !== null);
}

function normalizeRateRow(row: unknown): LuloRateRow {
  const obj = isObject(row) ? row : {};
  const mintAddress = stringField(obj, 'mint', 'mintAddress');
  const depositType = parseDepositType(obj.depositType ?? obj.type);
  const apy = numberField(obj.apy ?? obj.rate, 0);
  return {
    mintAddress,
    depositType,
    apy,
    ...(typeof obj.symbol === 'string' && obj.symbol ? { symbol: obj.symbol } : {}),
    ...(typeof obj.tvl === 'string' && obj.tvl
      ? { tvlUsd: obj.tvl }
      : typeof obj.tvlUsd === 'string' && obj.tvlUsd
        ? { tvlUsd: obj.tvlUsd }
        : {}),
    ...(typeof obj.liquidity === 'string' && obj.liquidity
      ? { liquidityAvailable: obj.liquidity }
      : typeof obj.liquidityAvailable === 'string' && obj.liquidityAvailable
        ? { liquidityAvailable: obj.liquidityAvailable }
        : {}),
    ...(typeof obj.asOf === 'string' && obj.asOf
      ? { apyAsOfIso: obj.asOf }
      : typeof obj.apyAsOfIso === 'string' && obj.apyAsOfIso
        ? { apyAsOfIso: obj.apyAsOfIso }
        : {}),
  };
}

function normalizePoolRows(body: LuloPoolsApiResponse): LuloPoolMetaRow[] {
  const rows = asArray(body.pools ?? body.data);
  return rows.map(normalizePoolRow).filter((row): row is LuloPoolMetaRow => row !== null);
}

function normalizePoolRow(row: unknown): LuloPoolMetaRow {
  const obj = isObject(row) ? row : {};
  const mintAddress = stringField(obj, 'mint', 'mintAddress');
  const supportedDepositTypes = parseDepositTypeList(obj.supportedDepositTypes ?? obj.depositTypes);
  const programIds = normalizeProgramIds(obj.programIds);
  return {
    mintAddress,
    supportedDepositTypes: supportedDepositTypes.length > 0 ? supportedDepositTypes : ['protected', 'boost'],
    programIds,
    ...(typeof obj.symbol === 'string' && obj.symbol ? { symbol: obj.symbol } : {}),
    ...(typeof obj.decimals === 'number' && Number.isFinite(obj.decimals) ? { decimals: obj.decimals } : {}),
    ...(typeof obj.cooldownSeconds === 'number' && Number.isFinite(obj.cooldownSeconds)
      ? { cooldownSeconds: obj.cooldownSeconds }
      : {}),
    ...(Array.isArray(obj.notes)
      ? { notes: obj.notes.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  };
}

function normalizePositionRows(body: LuloBalancesApiResponse): LuloPositionRow[] {
  const rows = asArray(body.positions ?? body.balances ?? body.data);
  return rows
    .map((row): LuloPositionRow | null => {
      const obj = isObject(row) ? row : null;
      if (!obj) return null;
      const mintAddress = stringField(obj, 'mint', 'mintAddress');
      if (!mintAddress) return null;
      const depositType = parseDepositType(obj.depositType ?? obj.type);
      const pending = Array.isArray(obj.pendingWithdrawals)
        ? obj.pendingWithdrawals
            .map((entry): LuloPositionRow['pendingWithdrawals'] extends Array<infer T> | undefined ? T | null : never => {
              const inner = isObject(entry) ? entry : null;
              if (!inner) return null;
              const withdrawalId = typeof inner.withdrawalId === 'string' ? inner.withdrawalId : '';
              if (!withdrawalId) return null;
              return {
                withdrawalId,
                ...(typeof inner.amountUi === 'string' ? { amountUi: inner.amountUi } : {}),
                ...(typeof inner.expectedReadyAt === 'string'
                  ? { expectedReadyAtIso: inner.expectedReadyAt }
                  : {}),
                ...(typeof inner.status === 'string' ? { status: inner.status } : {}),
              };
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        : undefined;
      return {
        mintAddress,
        depositType,
        ...(typeof obj.symbol === 'string' ? { symbol: obj.symbol } : {}),
        ...(typeof obj.amount === 'string' ? { amountRaw: obj.amount } : {}),
        ...(typeof obj.amountUi === 'string' ? { amountUi: obj.amountUi } : {}),
        ...(typeof obj.earnedInterestUi === 'string'
          ? { earnedInterestUi: obj.earnedInterestUi }
          : {}),
        ...(typeof obj.apy === 'number' && Number.isFinite(obj.apy) ? { apy: obj.apy } : {}),
        ...(typeof obj.withdrawableUi === 'string'
          ? { withdrawableUi: obj.withdrawableUi }
          : {}),
        ...(pending && pending.length > 0 ? { pendingWithdrawals: pending } : {}),
      };
    })
    .filter((row): row is LuloPositionRow => row !== null);
}

function normalizeProgramIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function parseDepositType(value: unknown): LuloDepositType {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized === 'protected' || normalized === 'boost' || normalized === 'regular') {
      return normalized;
    }
  }
  return 'protected';
}

function parseDepositTypeList(value: unknown): LuloDepositType[] {
  if (!Array.isArray(value)) return [];
  const out: LuloDepositType[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.toLowerCase();
    if (normalized === 'protected' || normalized === 'boost' || normalized === 'regular') {
      if (!out.includes(normalized)) out.push(normalized);
    }
  }
  return out;
}

function stringField(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function numberField(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObject(value)) return Object.values(value);
  return [];
}

function query(params: URLSearchParams): string {
  const text = params.toString();
  return text ? `?${text}` : '';
}

function requireString(body: LuloTransactionApiResponse, key: keyof LuloTransactionApiResponse): string {
  const value = body[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Lulo API response is missing required string field "${String(key)}".`);
  }
  return value;
}
