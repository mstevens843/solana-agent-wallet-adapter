import type { VulcanRegistrationSummary } from './vulcanTools.js';
import type { VulcanUpstreamClient } from './vulcanClient.js';
import type { VulcanMetricsRegistry, VulcanToolMetricsSnapshot } from './vulcanMetrics.js';

/**
 * Snapshot returned by `solana_vulcan_status`. Stays a plain JSON-friendly shape so it can be jsonReply'd directly.
 */
export interface VulcanStatusSnapshot {
  enabled: boolean;
  running: boolean;
  binaryPath?: string;
  allowDangerous?: boolean;
  /** Upstream MCP serverInfo captured during the most recent successful start(). */
  serverInfo?: { name: string; version: string };
  registeredTools: {
    readonly: string[];
    dangerous: string[];
    skipped: { name: string; reason: string }[];
  };
  /** Per-tool counters + latency buckets. Empty object when no calls have been recorded. */
  metrics: Record<string, VulcanToolMetricsSnapshot>;
  /** Active Vulcan wallet names (multi-wallet registry surface). Empty array when not multi-wallet mode. */
  wallets?: string[];
  lastError?: string;
  /**
   * Optional operator hint surfaced when something is misconfigured (e.g., zero tools listed, password env missing).
   * Concatenation of zero or more diagnostic strings. Always present even when empty so the field shape is stable.
   */
  hints: string[];
}

/**
 * Mutable holder of the latest Vulcan registration summary + start errors. One instance is created at the
 * `registerActionTools` site and stashed on the action service tools layer so the `solana_vulcan_status` MCP tool
 * can read it. Decoupled from `VulcanUpstreamClient` itself so we can answer status queries even when the client
 * is undefined (policy disabled or never instantiated).
 */
export class VulcanStatusHolder {
  private enabled = false;
  private client?: VulcanUpstreamClient;
  private summary?: VulcanRegistrationSummary;
  private registrationError?: Error;
  private hints: string[] = [];
  private metrics?: VulcanMetricsRegistry;
  private walletNames?: () => string[];

  setClient(client: VulcanUpstreamClient | undefined): void {
    this.client = client;
    this.enabled = client !== undefined;
  }

  setMetricsRegistry(metrics: VulcanMetricsRegistry): void {
    this.metrics = metrics;
  }

  /**
   * Multi-wallet registries hand in a getter that returns the live list of wallet names. We store the getter
   * (not the array) so the snapshot reflects current state without manual refresh.
   */
  setWalletListProvider(provider: () => string[]): void {
    this.walletNames = provider;
  }

  setRegistrationSummary(summary: VulcanRegistrationSummary): void {
    this.summary = summary;
    this.registrationError = undefined;
  }

  setRegistrationError(err: Error): void {
    this.registrationError = err;
  }

  addHint(hint: string): void {
    if (!hint.trim()) return;
    if (!this.hints.includes(hint)) this.hints.push(hint);
  }

  clearHints(): void {
    this.hints = [];
  }

  snapshot(): VulcanStatusSnapshot {
    const lastError =
      this.registrationError?.message ?? this.client?.getLastError()?.message ?? undefined;
    const readonly = this.summary?.readonly ?? [];
    const dangerous = this.summary?.dangerous ?? [];
    const skipped = this.summary?.skipped ?? [];
    const snapshot: VulcanStatusSnapshot = {
      enabled: this.enabled,
      running: this.client?.isRunning() ?? false,
      registeredTools: { readonly, dangerous, skipped },
      metrics: this.metrics?.snapshot() ?? {},
      hints: [...this.hints],
    };
    if (this.client) {
      snapshot.binaryPath = this.client.getBinaryPath();
      snapshot.allowDangerous = this.client.getAllowDangerous();
      const info = this.client.getServerInfo();
      if (info) snapshot.serverInfo = info;
    }
    if (this.walletNames) snapshot.wallets = this.walletNames();
    if (lastError) snapshot.lastError = lastError;
    return snapshot;
  }
}
