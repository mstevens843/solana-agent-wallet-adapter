import type { DAppAdapterContext } from '../types.js';

import {
  SANCTUM_API_BASE_URL_ENV,
  SANCTUM_API_KEY_ENV,
  SANCTUM_DEFAULT_API_BASE_URL,
  SANCTUM_FEATURE_FLAG_ENV,
  SANCTUM_INF_MINT,
  SANCTUM_RESPONSE_BYTE_LIMIT,
  type SanctumSwapSource,
} from './constants.js';

export interface SanctumLstMetadata {
  mint: string;
  symbol: string;
  name?: string;
  decimals?: number;
  logoUri?: string;
  poolAddress?: string;
  stakePoolProgramId?: string;
  reserveAddress?: string;
  validatorListAddress?: string;
  enabled: boolean;
  solValue?: string;
  liquidity?: string;
  apy?: number;
  raw?: Record<string, unknown>;
}

export interface SanctumLstListSnapshot {
  rows: SanctumLstMetadata[];
  includeDisabled: boolean;
  asOfIso: string;
  apiBaseHost: string;
  source: 'sanctum-api';
}

export interface SanctumApyRow {
  epoch?: number;
  epochEndTs?: number;
  apy: number;
}

export interface SanctumLstSnapshot extends SanctumLstMetadata {
  apys?: SanctumApyRow[];
}

export interface SanctumTokenOrderInput {
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  mode?: 'ExactIn' | 'ExactOut';
  signer?: string;
  inputAccount?: string;
  outputAccount?: string;
  slippageBps?: number;
  swapSources?: SanctumSwapSource[];
}

export interface SanctumTokenOrder {
  inputMint: string;
  outputMint: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  mode: 'ExactIn' | 'ExactOut';
  routeSources: string[];
  requestedSources: SanctumSwapSource[];
  slippageBps?: number;
  maxObservedFeeBps?: number;
  transactionBase64?: string;
  hasTransaction: boolean;
  warnings: string[];
  asOfIso: string;
  apiBaseHost: string;
  orderResponse: Record<string, unknown>;
}

export interface SanctumExecuteTokenOrderInput {
  signedTx: string;
  orderResponse: Record<string, unknown>;
}

export interface SanctumExecuteTokenOrderResult {
  signature: string;
  raw?: Record<string, unknown>;
}

export interface SanctumClient {
  getLsts(input: { includeDisabled?: boolean }): Promise<SanctumLstListSnapshot>;
  getLst(input: {
    mintOrSymbol: string;
    includeApy?: boolean;
    apyLimit?: number;
  }): Promise<SanctumLstSnapshot>;
  getTokenOrder(input: SanctumTokenOrderInput): Promise<SanctumTokenOrder>;
  executeTokenOrder(input: SanctumExecuteTokenOrderInput): Promise<SanctumExecuteTokenOrderResult>;
}

const DISABLED_REASON = `${SANCTUM_FEATURE_FLAG_ENV} is false. Set ${SANCTUM_FEATURE_FLAG_ENV}=true or leave it unset to enable Sanctum first-class reads and prepared actions.`;
const MISSING_KEY_REASON = `${SANCTUM_API_KEY_ENV} is not set. Configure ${SANCTUM_API_KEY_ENV} (and optionally ${SANCTUM_API_BASE_URL_ENV}) in the host environment to enable Sanctum first-class reads and prepared actions, or inject a mock via setSanctumClientFactory for tests.`;

class SanctumApiUnavailable implements SanctumClient {
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  private fail(method: string): never {
    throw new Error(`Sanctum adapter is not configured (${method}): ${this.reason}`);
  }

  async getLsts(): Promise<SanctumLstListSnapshot> {
    this.fail('getLsts');
  }

  async getLst(): Promise<SanctumLstSnapshot> {
    this.fail('getLst');
  }

  async getTokenOrder(): Promise<SanctumTokenOrder> {
    this.fail('getTokenOrder');
  }

  async executeTokenOrder(): Promise<SanctumExecuteTokenOrderResult> {
    this.fail('executeTokenOrder');
  }
}

let factory: () => SanctumClient = () => buildDefaultSanctumClient();
let cached: SanctumClient | undefined;

export function setSanctumClientFactory(next: () => SanctumClient): void {
  factory = next;
  cached = undefined;
}

export function resetSanctumClientFactory(): void {
  factory = () => buildDefaultSanctumClient();
  cached = undefined;
}

export function getSanctumClient(): SanctumClient {
  if (!cached) cached = factory();
  return cached;
}

export function isSanctumConfigured(): boolean {
  return !(getSanctumClient() instanceof SanctumApiUnavailable);
}

export function describeSanctumUnavailableReason(): string | undefined {
  const client = getSanctumClient();
  return client instanceof SanctumApiUnavailable ? client.reason : undefined;
}

export interface SanctumClientOverride {
  apiKey: string;
  baseUrl?: string;
}

export function buildSanctumClientFromOverride(override: SanctumClientOverride): SanctumClient {
  const apiKey = override.apiKey.trim();
  if (!apiKey) return new SanctumApiUnavailable(MISSING_KEY_REASON);
  const baseUrl = normalizeBaseUrl(override.baseUrl?.trim() || SANCTUM_DEFAULT_API_BASE_URL);
  return new SanctumApiClient({ apiKey, baseUrl });
}

export function resolveSanctumClient(ctx?: DAppAdapterContext): SanctumClient {
  const override = ctx?.connectorSecrets?.sanctum;
  if (override?.apiKey) {
    return buildSanctumClientFromOverride(override);
  }
  return getSanctumClient();
}

function buildDefaultSanctumClient(): SanctumClient {
  const flag = (process.env[SANCTUM_FEATURE_FLAG_ENV] ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') {
    return new SanctumApiUnavailable(DISABLED_REASON);
  }
  const apiKey = (process.env[SANCTUM_API_KEY_ENV] ?? '').trim();
  if (!apiKey) return new SanctumApiUnavailable(MISSING_KEY_REASON);
  const rawBase = (process.env[SANCTUM_API_BASE_URL_ENV] ?? '').trim();
  return new SanctumApiClient({
    apiKey,
    baseUrl: normalizeBaseUrl(rawBase || SANCTUM_DEFAULT_API_BASE_URL),
  });
}

interface SanctumApiClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

class SanctumApiClient implements SanctumClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SanctumApiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getLsts(input: { includeDisabled?: boolean }): Promise<SanctumLstListSnapshot> {
    const payload = await this.getJson('/lsts');
    const rows = rowsFromPayload(payload)
      .map(normalizeLstRow)
      .filter((row): row is SanctumLstMetadata => row !== undefined)
      .filter((row) => input.includeDisabled === true || row.enabled);
    return {
      rows,
      includeDisabled: input.includeDisabled === true,
      asOfIso: new Date().toISOString(),
      apiBaseHost: apiHost(this.baseUrl),
      source: 'sanctum-api',
    };
  }

  async getLst(input: {
    mintOrSymbol: string;
    includeApy?: boolean;
    apyLimit?: number;
  }): Promise<SanctumLstSnapshot> {
    const payload = await this.getJson(`/lsts/${encodeURIComponent(input.mintOrSymbol)}`);
    const row = normalizeLstRow(firstDataObject(payload));
    if (!row) {
      throw new Error(`Sanctum API did not return LST metadata for ${input.mintOrSymbol}.`);
    }
    if (input.includeApy === true) {
      const apyPayload = await this.getJson(
        `/lsts/${encodeURIComponent(input.mintOrSymbol)}/apys`,
        input.apyLimit ? { limit: String(input.apyLimit) } : undefined,
      );
      const apys = rowsFromPayload(apyPayload)
        .map(normalizeApyRow)
        .filter((entry): entry is SanctumApyRow => entry !== undefined);
      return { ...row, apys };
    }
    return row;
  }

  async getTokenOrder(input: SanctumTokenOrderInput): Promise<SanctumTokenOrder> {
    const requestedSources = input.swapSources ?? ['Inf', 'SanctumRouter'];
    const payload = await this.getJson('/swap/token/order', {
      inp: input.inputMint,
      out: input.outputMint,
      amt: input.amountRaw,
      mode: input.mode ?? 'ExactIn',
      ...(input.signer ? { signer: input.signer } : {}),
      ...(input.inputAccount ? { inpAcc: input.inputAccount } : {}),
      ...(input.outputAccount ? { outAcc: input.outputAccount } : {}),
      ...(input.slippageBps !== undefined ? { slippageBps: String(input.slippageBps) } : {}),
      swapSrc: requestedSources,
    });
    const orderResponse = firstDataObject(payload);
    const inputAmountRaw = requireUnsignedIntegerString(
      firstString(orderResponse.inpAmt, orderResponse.inputAmount) ?? input.amountRaw,
      'input amount',
    );
    const outputAmountRaw = requireUnsignedIntegerString(
      firstString(orderResponse.outAmt, orderResponse.outAmount, orderResponse.amountOut),
      'output amount',
    );
    const transactionBase64 = firstString(orderResponse.tx, orderResponse.transaction, orderResponse.transactionBase64);
    const routeSources = extractRouteSources(orderResponse, requestedSources);
    const maxObservedFeeBps = extractMaxFeeBps(orderResponse);
    return {
      inputMint: firstString(orderResponse.inp) ?? input.inputMint,
      outputMint: firstString(orderResponse.out) ?? input.outputMint,
      inputAmountRaw,
      outputAmountRaw,
      mode: (firstString(orderResponse.mode) === 'ExactOut' ? 'ExactOut' : 'ExactIn'),
      routeSources,
      requestedSources,
      ...(input.slippageBps !== undefined && { slippageBps: input.slippageBps }),
      ...(maxObservedFeeBps !== undefined && { maxObservedFeeBps }),
      ...(transactionBase64 !== undefined && { transactionBase64 }),
      hasTransaction: transactionBase64 !== undefined,
      warnings: extractWarnings(orderResponse),
      asOfIso: new Date().toISOString(),
      apiBaseHost: apiHost(this.baseUrl),
      orderResponse,
    };
  }

  async executeTokenOrder(
    input: SanctumExecuteTokenOrderInput,
  ): Promise<SanctumExecuteTokenOrderResult> {
    const payload = await this.postJson('/swap/token/execute', {
      signedTx: input.signedTx,
      orderResponse: input.orderResponse,
    });
    const response = firstDataObject(payload);
    const signature = firstString(response.signature, response.txid, response.transactionSignature);
    if (!signature) {
      throw new Error('Sanctum API did not return a transaction signature.');
    }
    return {
      signature,
      raw: response,
    };
  }

  private async getJson(path: string, params: Record<string, string | string[]> = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('apiKey', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, value);
      }
    }
    return this.fetchJson(url, { method: 'GET' });
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('apiKey', this.apiKey);
    return this.fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async fetchJson(url: URL, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(url, init);
    const text = await response.text();
    if (text.length > SANCTUM_RESPONSE_BYTE_LIMIT) {
      throw new Error(`Sanctum API response exceeded ${SANCTUM_RESPONSE_BYTE_LIMIT} bytes.`);
    }
    if (!response.ok) {
      throw new Error(`Sanctum API ${response.status}: ${trimForError(text)}`);
    }
    return text ? JSON.parse(text) as unknown : {};
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function apiHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function firstDataObject(payload: unknown): Record<string, unknown> {
  if (isRecord(payload)) {
    const data = payload.data;
    if (isRecord(data)) return data;
    return payload;
  }
  return {};
}

function rowsFromPayload(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  const data = payload.data;
  if (Array.isArray(data)) return data.filter(isRecord);
  if (isRecord(data)) {
    const nested = firstArray(data.lsts, data.rows, data.items, data.tokens);
    if (nested) return nested.filter(isRecord);
    return Object.entries(data)
      .filter(([, value]) => isRecord(value))
      .map(([key, value]) => ({ ...(value as Record<string, unknown>), mint: (value as Record<string, unknown>).mint ?? key }));
  }
  const nested = firstArray(payload.lsts, payload.rows, payload.items, payload.tokens);
  return nested ? nested.filter(isRecord) : [];
}

function normalizeLstRow(row: unknown): SanctumLstMetadata | undefined {
  if (!isRecord(row)) return undefined;
  const mint = firstString(row.mint, row.mintAddress, row.address, row.tokenMint, row.pubkey);
  if (!mint) return undefined;
  const symbol = firstString(row.symbol, row.ticker, row.tokenSymbol) ?? (mint === SANCTUM_INF_MINT ? 'INF' : mint);
  const disabled = firstBoolean(row.disabled, row.inputDisabled, row.isDisabled, row.blacklisted) ?? false;
  const enabled = firstBoolean(row.enabled, row.isEnabled, row.whitelisted) ?? !disabled;
  return stripUndefined({
    mint,
    symbol,
    name: firstString(row.name, row.tokenName),
    decimals: firstNumber(row.decimals),
    logoUri: firstString(row.logoUri, row.logoURI, row.icon, row.image),
    poolAddress: firstString(row.poolAddress, row.stakePoolAddress, row.stakePool, row.pool),
    stakePoolProgramId: firstString(row.stakePoolProgramId, row.programId, row.poolProgramId),
    reserveAddress: firstString(row.reserveAddress, row.reserveStakeAddress),
    validatorListAddress: firstString(row.validatorListAddress),
    enabled,
    solValue: firstString(row.solValue, row.solVal, row.priceInSol, row.value),
    liquidity: firstString(row.liquidity, row.liquidityAvailable, row.tvlSol),
    apy: firstNumber(row.apy, row.avgApy),
    raw: row,
  });
}

function normalizeApyRow(row: unknown): SanctumApyRow | undefined {
  if (!isRecord(row)) return undefined;
  const apy = firstNumber(row.apy, row.avgApy);
  if (apy === undefined) return undefined;
  return stripUndefined({
    epoch: firstNumber(row.epoch),
    epochEndTs: firstNumber(row.epochEndTs, row.epochEndTimestamp),
    apy,
  });
}

function extractRouteSources(order: Record<string, unknown>, fallback: SanctumSwapSource[]): string[] {
  const sources = new Set<string>();
  const swapSrcData = order.swapSrcData;
  if (isRecord(swapSrcData)) {
    for (const key of Object.keys(swapSrcData)) {
      if (looksLikeRouteSourceKey(key)) sources.add(key);
    }
  }
  for (const key of ['swapSrc', 'swapSrcs', 'source', 'sources', 'route', 'routeSources', 'router']) {
    collectRouteSourceValue(order[key], sources);
  }
  if (sources.size === 0) {
    for (const source of fallback) sources.add(source);
  }
  return [...sources];
}

function extractMaxFeeBps(value: unknown): number | undefined {
  const found: number[] = [];
  visit(value, (key, item) => {
    const normalized = key.toLowerCase();
    if (!isFeeBpsKey(normalized)) return;
    const parsed = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) found.push(parsed);
  });
  return found.length > 0 ? Math.max(...found) : undefined;
}

function collectRouteSourceValue(value: unknown, sources: Set<string>): void {
  if (typeof value === 'string' && value.trim()) {
    for (const source of value.split(/[>,|/]+/)) {
      if (source.trim()) sources.add(source.trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectRouteSourceValue(entry, sources);
    return;
  }
  if (isRecord(value)) {
    collectRouteSourceValue(value.swapSrc, sources);
    collectRouteSourceValue(value.source, sources);
    collectRouteSourceValue(value.router, sources);
    collectRouteSourceValue(value.name, sources);
  }
}

function looksLikeRouteSourceKey(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'inf' ||
    normalized === 'infinity' ||
    normalized === 'sanctuminf' ||
    normalized === 'sanctuminfinity' ||
    normalized === 'router' ||
    normalized === 'sanctumrouter' ||
    normalized === 'jup' ||
    normalized === 'jupiter';
}

function isFeeBpsKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/g, '');
  return normalized.includes('bps') &&
    normalized.includes('fee') &&
    !normalized.includes('slippage') &&
    !normalized.includes('referral') &&
    !normalized.includes('threshold');
}

function requireUnsignedIntegerString(value: string | undefined, label: string): string {
  if (value && /^\d+$/.test(value)) return value;
  throw new Error(`Sanctum API did not return a valid unsigned integer ${label}.`);
}

function extractWarnings(value: unknown): string[] {
  const warnings: string[] = [];
  visit(value, (key, item) => {
    const normalized = key.toLowerCase();
    if (!normalized.includes('warning') && !normalized.includes('warn')) return;
    if (typeof item === 'string' && item.trim()) warnings.push(item.trim());
    if (Array.isArray(item)) {
      for (const entry of item) {
        if (typeof entry === 'string' && entry.trim()) warnings.push(entry.trim());
      }
    }
  });
  return [...new Set(warnings)];
}

function visit(value: unknown, fn: (key: string, item: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, fn);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    fn(key, item);
    if (isRecord(item) || Array.isArray(item)) visit(item, fn);
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'bigint') return value.toString();
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
  }
  return undefined;
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function trimForError(value: string): string {
  return value.replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]').slice(0, 500);
}
