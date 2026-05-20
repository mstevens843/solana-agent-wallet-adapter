/**
 * Per-tool counters + a coarse latency histogram for Vulcan upstream calls.
 *
 * Why histograms instead of just total + count: production debugging frequently asks "what's the p95 latency for
 * trade.place_market" rather than "what's the mean." Five fixed buckets (under 100ms / 500ms / 1s / 5s / over 5s)
 * are enough to triage without storing every sample. Stays at O(1) memory per tool.
 *
 * Surfaces via the `solana_vulcan_status` MCP tool's snapshot — operators / agents can inspect without a separate
 * Prometheus scrape.
 */

export interface VulcanLatencyBuckets {
  /** Calls that completed in <100ms. */
  lt100ms: number;
  /** [100, 500) ms. */
  lt500ms: number;
  /** [500, 1000) ms. */
  lt1000ms: number;
  /** [1000, 5000) ms. */
  lt5000ms: number;
  /** ≥5000ms. */
  gte5000ms: number;
}

export interface VulcanToolMetricsSnapshot {
  toolName: string;
  /** T2.1: present when this entry was recorded under a wallet (multi-wallet keying). */
  walletName?: string;
  totalCalls: number;
  errorCount: number;
  /** Cumulative latency across all completed calls, in ms. Divide by `totalCalls` for the mean. */
  totalLatencyMs: number;
  /** Maximum observed latency in ms. */
  maxLatencyMs: number;
  latencyBuckets: VulcanLatencyBuckets;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  /** Truncated last error message (max 240 chars). */
  lastErrorMessage?: string;
}

interface MutableToolMetrics {
  toolName: string;
  walletName?: string;
  totalCalls: number;
  errorCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  latencyBuckets: VulcanLatencyBuckets;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
}

export class VulcanMetricsRegistry {
  private readonly metrics = new Map<string, MutableToolMetrics>();

  /**
   * Record a single tool invocation outcome.
   *
   * @param toolName Upstream Vulcan tool name (e.g., `market.snapshot`). Not the sanitized Agentic name — we want
   *                 metrics keyed by the source-of-truth identifier for cross-deploy comparison.
   * @param latencyMs Wall-clock time for the call. Pass 0 if not measured.
   * @param outcome Either `'ok'` for success or an Error for failure.
   * @param walletName T2.1: optional wallet identifier. When supplied (multi-wallet deployments), the metric key
   *                   becomes `${walletName}::${toolName}` so per-tenant breakdowns work. Single-wallet deploys
   *                   pass undefined and key by tool name only.
   */
  record(toolName: string, latencyMs: number, outcome: 'ok' | Error, walletName?: string): void {
    const key = walletName ? `${walletName}::${toolName}` : toolName;
    const entry = this.metrics.get(key) ?? freshEntry(toolName, walletName);
    entry.totalCalls += 1;
    entry.totalLatencyMs += latencyMs;
    if (latencyMs > entry.maxLatencyMs) entry.maxLatencyMs = latencyMs;
    bumpLatencyBucket(entry.latencyBuckets, latencyMs);
    const now = new Date().toISOString();
    if (outcome === 'ok') {
      entry.lastSuccessAt = now;
    } else {
      entry.errorCount += 1;
      entry.lastErrorAt = now;
      entry.lastErrorMessage = truncate(outcome.message, 240);
    }
    this.metrics.set(key, entry);
  }

  /**
   * Stable snapshot suitable for jsonReply. Returns a plain object keyed by `${walletName}::${toolName}` (multi-wallet)
   * or just `${toolName}` (single-wallet) — matching whatever was passed to `record()`.
   */
  snapshot(): Record<string, VulcanToolMetricsSnapshot> {
    const out: Record<string, VulcanToolMetricsSnapshot> = {};
    for (const [key, entry] of this.metrics) {
      const snap: VulcanToolMetricsSnapshot = {
        toolName: entry.toolName,
        totalCalls: entry.totalCalls,
        errorCount: entry.errorCount,
        totalLatencyMs: entry.totalLatencyMs,
        maxLatencyMs: entry.maxLatencyMs,
        latencyBuckets: { ...entry.latencyBuckets },
      };
      if (entry.walletName) snap.walletName = entry.walletName;
      if (entry.lastSuccessAt) snap.lastSuccessAt = entry.lastSuccessAt;
      if (entry.lastErrorAt) snap.lastErrorAt = entry.lastErrorAt;
      if (entry.lastErrorMessage) snap.lastErrorMessage = entry.lastErrorMessage;
      out[key] = snap;
    }
    return out;
  }

  reset(): void {
    this.metrics.clear();
  }
}

/**
 * Async wrapper that records a `VulcanMetricsRegistry` entry around a call. Centralizes the timing + try/catch.
 * Re-throws the original error after recording so callers can keep their existing error-handling code.
 *
 * @param walletName T2.1: optional, passed through to `registry.record()` for per-wallet keying.
 */
export async function recordVulcanCall<T>(
  registry: VulcanMetricsRegistry,
  toolName: string,
  fn: () => Promise<T>,
  walletName?: string,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    registry.record(toolName, Date.now() - startedAt, 'ok', walletName);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    registry.record(toolName, Date.now() - startedAt, error, walletName);
    throw err;
  }
}

function freshEntry(toolName: string, walletName?: string): MutableToolMetrics {
  const entry: MutableToolMetrics = {
    toolName,
    totalCalls: 0,
    errorCount: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    latencyBuckets: { lt100ms: 0, lt500ms: 0, lt1000ms: 0, lt5000ms: 0, gte5000ms: 0 },
  };
  if (walletName) entry.walletName = walletName;
  return entry;
}

function bumpLatencyBucket(buckets: VulcanLatencyBuckets, latencyMs: number): void {
  if (latencyMs < 100) buckets.lt100ms += 1;
  else if (latencyMs < 500) buckets.lt500ms += 1;
  else if (latencyMs < 1000) buckets.lt1000ms += 1;
  else if (latencyMs < 5000) buckets.lt5000ms += 1;
  else buckets.gte5000ms += 1;
}

function truncate(message: string, max: number): string {
  return message.length <= max ? message : `${message.slice(0, max - 1)}…`;
}
