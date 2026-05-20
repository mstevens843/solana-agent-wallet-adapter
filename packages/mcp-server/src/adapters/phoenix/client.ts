import { AdapterError, type DAppAdapterContext } from '../types.js';
import { buildPhoenixApiClient } from './apiClient.js';
import { PHOENIX_ACCESS_CODE_ENV, PHOENIX_ADAPTER_ID } from './constants.js';
import { buildRisePhoenixClient } from './riseClient.js';

/** Per-symbol perp market snapshot returned by the Phoenix API. */
export interface PhoenixMarketSnapshot {
  symbol: string;
  marketIndex?: number;
  oracleSource?: string;
  markPriceUsd?: string;
  indexPriceUsd?: string;
  fundingRateHourly?: string;
  openInterestUsd?: string;
  maxLeverage?: number;
  takerFeeBps?: number;
  makerFeeBps?: number;
  asOf?: string;
  warnings?: string[];
}

export interface PhoenixPosition {
  symbol: string;
  side: 'long' | 'short';
  baseSize: string;
  entryPriceUsd?: string;
  markPriceUsd?: string;
  leverage?: string;
  liquidationPriceUsd?: string;
  fundingPaidUsd?: string;
  unrealizedPnlUsd?: string;
  marginRatio?: number;
  healthPercent?: number;
}

export interface PhoenixOpenOrder {
  orderId: string;
  symbol: string;
  side: 'long' | 'short';
  type: 'limit' | 'market' | 'stop_loss';
  baseSize: string;
  triggerTickPrice?: string;
  triggerDirection?: 'less_than' | 'greater_than';
  placedAt?: string;
}

export interface PhoenixTraderStateSnapshot {
  authority: string;
  traderPdaIndex: number;
  freeCollateralUsd?: string;
  totalCollateralUsd?: string;
  positions: PhoenixPosition[];
  openOrders: PhoenixOpenOrder[];
  triggers: PhoenixOpenOrder[];
  asOf?: string;
  warnings?: string[];
}

export interface PhoenixFundingHistoryEntry {
  symbol: string;
  rateHourly: string;
  paidUsd?: string;
  observedAt: string;
}

export interface PhoenixHealthPreview {
  symbol: string;
  projectedMarkPriceUsd?: string;
  projectedLiquidationPriceUsd?: string;
  projectedMarginRatio?: number;
  projectedFreeCollateralUsd?: string;
  liquidationBufferPct?: number;
  warnings?: string[];
}

export interface PhoenixClient {
  /** One-time invite activation. Idempotent: returns activatedAt on already-activated codes. */
  activate(input: { accessCode: string; authority: string }): Promise<{ activatedAt: string }>;
  /**
   * Ensure the trader is activated before an authority-scoped fetch. No-op if already activated for this process.
   * Read functions that touch trader state (positions, health preview) must call this first; market-level reads
   * (catalog, snapshot, funding) skip activation.
   */
  activateIfNeeded(authority: string): Promise<void>;
  fetchMarketSnapshot(input: { symbol: string }): Promise<PhoenixMarketSnapshot>;
  fetchMarketCatalog(): Promise<PhoenixMarketSnapshot[]>;
  fetchTraderState(input: { authority: string; traderPdaIndex?: number }): Promise<PhoenixTraderStateSnapshot>;
  fetchFundingHistory(input: { symbol: string; limit?: number }): Promise<PhoenixFundingHistoryEntry[]>;
  /**
   * Rise SDK clients carry additional write-path methods (`buildOpenIxs`, `buildCloseIxs`, …). They live on the
   * `RisePhoenixClient` extension in `riseClient.ts`; `actions.ts` uses `hasRiseExtensions(client)` to narrow.
   * Not declared here to avoid contravariant intersection issues with the strongly-typed Rise input shapes.
   */
}

const UNAVAILABLE_REASON =
  'Phoenix client is not wired. Paste a Phoenix access code in Preferences → Agents & Connectors, or set PHOENIX_ACCESS_CODE in the host environment, or inject a mock via setPhoenixClientFactory for tests.';

export class PhoenixClientUnavailable implements PhoenixClient {
  readonly reason = UNAVAILABLE_REASON;

  private fail(method: string): never {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'sdk_unavailable',
      `Phoenix adapter is not configured (${method}): ${this.reason}`,
    );
  }

  async activate(): Promise<{ activatedAt: string }> { this.fail('activate'); }
  async activateIfNeeded(): Promise<void> { this.fail('activateIfNeeded'); }
  async fetchMarketSnapshot(): Promise<PhoenixMarketSnapshot> { this.fail('fetchMarketSnapshot'); }
  async fetchMarketCatalog(): Promise<PhoenixMarketSnapshot[]> { this.fail('fetchMarketCatalog'); }
  async fetchTraderState(): Promise<PhoenixTraderStateSnapshot> { this.fail('fetchTraderState'); }
  async fetchFundingHistory(): Promise<PhoenixFundingHistoryEntry[]> { this.fail('fetchFundingHistory'); }
}

let factory: () => PhoenixClient = () => new PhoenixClientUnavailable();
let cached: PhoenixClient | undefined;

export function setPhoenixClientFactory(next: () => PhoenixClient): void {
  factory = next;
  cached = undefined;
}

export function resetPhoenixClientFactory(): void {
  factory = () => new PhoenixClientUnavailable();
  cached = undefined;
}

export function getPhoenixClient(): PhoenixClient {
  if (!cached) cached = factory();
  return cached;
}

export function isPhoenixConfigured(): boolean {
  return !(getPhoenixClient() instanceof PhoenixClientUnavailable);
}

export function describePhoenixUnavailableReason(): string | undefined {
  const client = getPhoenixClient();
  return client instanceof PhoenixClientUnavailable ? client.reason : undefined;
}

export interface PhoenixClientOverride {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Resolve a per-request client.
 *
 * For Phoenix the BYO key is an *invite/activation code*, not a per-request API key header. The HTTP layer treats it
 * uniformly as a bearer-style credential when calling `/v1/invite/activate`; subsequent reads use the wallet pubkey
 * directly. Connector-secret-override piping reuses `apiKey` so it ports cleanly through `ConnectorSecretMaterial`.
 *
 * Defaults to a Rise SDK–backed client (typed reads + native instruction builders). Set
 * `PHOENIX_USE_LEGACY_HTTP=true` in the host env to fall back to the hand-rolled HTTP client (no write support).
 */
export function resolvePhoenixClient(ctx?: DAppAdapterContext): PhoenixClient {
  const override = ctx?.connectorSecrets?.phoenix;
  if (override?.apiKey) {
    return buildPhoenixClientFromOverride(override);
  }
  return getPhoenixClient();
}

function buildPhoenixClientFromOverride(override: PhoenixClientOverride): PhoenixClient {
  if (process.env.PHOENIX_USE_LEGACY_HTTP === 'true') {
    return buildPhoenixApiClient({
      accessCode: override.apiKey,
      ...(override.baseUrl ? { baseUrl: override.baseUrl } : {}),
    });
  }
  return buildRisePhoenixClient({
    accessCode: override.apiKey,
    ...(override.baseUrl ? { apiUrl: override.baseUrl } : {}),
  });
}

/**
 * Scrub access codes from a free-form error message. By default redacts:
 *  - The `PHOENIX_ACCESS_CODE` env value (length ≥ 4).
 *  - `Authorization: Bearer …` header value.
 *  - `x-phoenix-access-code: …` header value.
 *
 * Pass `extraCodes` to also redact per-request BYO access codes (from `ctx.connectorSecrets.phoenix.apiKey`).
 * Each extra code is scrubbed verbatim — be sure to dedupe whitespace before passing.
 */
export function redactAccessCode(message: string, extraCodes: readonly string[] = []): string {
  let out = message;
  const envCode = process.env[PHOENIX_ACCESS_CODE_ENV]?.trim();
  const candidates = [envCode, ...extraCodes].filter(
    (c): c is string => typeof c === 'string' && c.length >= 4,
  );
  for (const code of candidates) {
    out = out.split(code).join('[redacted]');
  }
  out = out.replace(
    /(authorization\s*:\s*bearer\s+)[A-Za-z0-9._-]+/gi,
    '$1[redacted]',
  );
  out = out.replace(
    /(x-phoenix-access-code\s*[:=]\s*)["']?[^"'\s,;]+["']?/gi,
    '$1[redacted]',
  );
  return out;
}

/**
 * Wrap a Phoenix API call so any thrown error is normalized to `AdapterError` and scrubbed of access codes.
 * `extraCodes` should include per-request BYO codes when the caller has access to them (e.g. `riseClient.ts`'s
 * `accessCode` closure variable).
 */
export async function withPhoenixErrors<T>(
  method: string,
  fn: () => Promise<T>,
  extraCodes: readonly string[] = [],
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AdapterError) {
      throw new AdapterError(err.adapterId, err.code, redactAccessCode(err.message, extraCodes));
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'api_error',
      `Phoenix ${method} failed: ${redactAccessCode(message, extraCodes)}`,
    );
  }
}
