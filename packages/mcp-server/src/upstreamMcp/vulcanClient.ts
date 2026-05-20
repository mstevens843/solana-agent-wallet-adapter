import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Wraps a Vulcan CLI subprocess as an MCP client connection.
 *
 * Vulcan is Ellipsis Labs' official Phoenix Perpetuals CLI ("Phoenix CLI for humans and agents"). It ships its own
 * MCP server via `vulcan mcp` (read-only) or `vulcan mcp --allow-dangerous` (live trading enabled with wallet creds).
 * Agentic spawns it as a subprocess and re-exposes its tools as `solana_vulcan_*` MCP tools in the Agentic tool
 * surface, wrapping dangerous calls in the existing prepared-action inbox.
 *
 * Lifecycle:
 *  - `start()` spawns the subprocess via StdioClientTransport, connects via MCP handshake. Idempotent.
 *  - Transport `onclose` / `onerror` flip `running` to false and capture `lastError`; the next call throws a clear
 *    actionable message ("subprocess exited; restart the bridge").
 *  - `stop()` closes the client + transport. Safe to call when not running.
 *  - `listTools()` results are cached; pass `force` to re-fetch (e.g., after a restart).
 *
 * Wallet model gotcha: Vulcan uses its OWN wallet stored in `~/.vulcan/wallets`, separate from Agentic's
 * Privy/MWA/Phantom. The env vars below configure Vulcan's wallet selection; they don't propagate the Agentic
 * user's wallet to Vulcan. See `upstreamMcp/README.md`.
 */

export interface VulcanUpstreamClientOptions {
  /** Absolute path to the vulcan binary; defaults to "vulcan" (PATH lookup). */
  binaryPath?: string;
  /** Pass `--allow-dangerous` so the upstream exposes signing tools. */
  allowDangerous?: boolean;
  /** Name of the stored Vulcan wallet to use; forwarded as VULCAN_WALLET_NAME. */
  walletName?: string;
  /** Password for the stored wallet; forwarded as VULCAN_WALLET_PASSWORD. Only meaningful when allowDangerous. */
  walletPassword?: string;
  /** Hard cap on individual tool call duration in ms; defaults to 60_000. */
  toolCallTimeoutMs?: number;
  /** Optional override of the spawn environment (mostly for tests). */
  envOverride?: Record<string, string>;
  /**
   * Optional Transport factory override. The returned object must implement the full MCP `Transport` interface
   * (`start`, `close`, `send`, plus the optional `onmessage` / `onclose` / `onerror` callback fields). Production
   * code leaves this undefined to spawn via `StdioClientTransport`; tests inject a synthetic Transport.
   */
  transportFactory?: VulcanTransportFactory;
  /**
   * When true, transport crashes (onclose/onerror) trigger automatic restart with backoff. Default false (fail-loud).
   * Pair with `restartBackoffMs` to control the schedule.
   */
  autoRestart?: boolean;
  /**
   * Backoff schedule in milliseconds between restart attempts. Length implicitly caps total attempts.
   * Default: `[1_000, 2_000, 5_000, 10_000, 30_000]` — 5 attempts over ~48 seconds.
   * Set to `[]` to disable restarts even when `autoRestart` is true (useful in tests).
   */
  restartBackoffMs?: readonly number[];
  /**
   * If set, start() rejects when the upstream MCP `serverInfo.name` doesn't match this string. Default: no check.
   * Useful as a runtime sanity check that we're talking to actual Vulcan and not some other MCP server.
   */
  requiredServerName?: string;
  /**
   * If set, start() rejects when the upstream MCP `serverInfo.version` doesn't equal this string. Default: no check.
   * Exact match; for fuzzier matching call `getServerVersion()` after start() and check semver yourself.
   */
  requiredServerVersion?: string;
  /**
   * Optional setTimeout/clearTimeout pair, for fake-timer tests. Defaults to globals.
   */
  timers?: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export type VulcanTransportFactory = (params: {
  command: string;
  args: string[];
  env: Record<string, string>;
}) => Transport;

export interface VulcanToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface VulcanCallToolResult {
  content: unknown;
  isError?: boolean;
  structuredContent?: unknown;
}

const VULCAN_CLIENT_INFO = { name: 'agentic-vulcan-upstream', version: '0.1.0' } as const;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_RESTART_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Hooks the client exposes for observability (status holder, metrics, etc.) without coupling to specific consumers. */
export interface VulcanUpstreamClientEvents {
  onStarted?: (serverInfo: { name: string; version: string } | undefined) => void;
  onCrash?: (err: Error) => void;
  onRestartScheduled?: (attempt: number, delayMs: number) => void;
  onRestartGaveUp?: (err: Error, attempts: number) => void;
}

export class VulcanUpstreamClient {
  private readonly opts: Required<Pick<VulcanUpstreamClientOptions, 'binaryPath' | 'allowDangerous' | 'toolCallTimeoutMs'>> &
    VulcanUpstreamClientOptions;
  private client?: Client;
  private transport?: Transport;
  private toolsCache?: VulcanToolDescriptor[];
  private running = false;
  private lastError?: Error;
  private serverInfo?: { name: string; version: string };
  private restartAttempt = 0;
  private restartTimer?: unknown;
  private events: VulcanUpstreamClientEvents = {};
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: VulcanUpstreamClientOptions = {}) {
    this.opts = {
      binaryPath: options.binaryPath ?? 'vulcan',
      allowDangerous: options.allowDangerous ?? false,
      toolCallTimeoutMs: options.toolCallTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      ...options,
    };
    if (options.timers) {
      this.setTimer = options.timers.setTimeout;
      this.clearTimer = options.timers.clearTimeout;
    } else {
      this.setTimer = (cb, ms) => setTimeout(cb, ms);
      this.clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  }

  /** Attach lifecycle event hooks. Idempotent: replaces any prior set. */
  setEventHooks(events: VulcanUpstreamClientEvents): void {
    this.events = events;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Last captured error from start() / unexpected onclose / onerror. Cleared on successful start(). */
  getLastError(): Error | undefined {
    return this.lastError;
  }

  /** Effective binary path (for status/debug surfaces). */
  getBinaryPath(): string {
    return this.opts.binaryPath;
  }

  /** Whether the client will request signing tools from upstream. */
  getAllowDangerous(): boolean {
    return this.opts.allowDangerous;
  }

  /** Upstream MCP serverInfo captured during the most recent successful start(). Undefined before first start. */
  getServerInfo(): { name: string; version: string } | undefined {
    return this.serverInfo;
  }

  /** Stored Vulcan wallet name being targeted. Useful for the multi-wallet registry status surface. */
  getWalletName(): string | undefined {
    return this.opts.walletName;
  }

  /**
   * Spawn the Vulcan subprocess and complete the MCP handshake. Idempotent: a second call is a no-op while running.
   * Wraps ENOENT / spawn errors with operator-actionable messages.
   *
   * Post-connect:
   *  - Captures `serverInfo` for status reporting + version-pinning checks.
   *  - Validates against `requiredServerName` / `requiredServerVersion` if configured.
   *  - Resets restart-attempt counter on success.
   */
  async start(): Promise<void> {
    if (this.running) return;
    // Cancel any pending auto-restart — we're starting manually now.
    this.cancelRestartTimer();
    const args = ['mcp'];
    if (this.opts.allowDangerous) args.push('--allow-dangerous');
    const env = this.buildEnv();
    const transport: Transport = this.opts.transportFactory
      ? this.opts.transportFactory({ command: this.opts.binaryPath, args, env })
      : new StdioClientTransport({ command: this.opts.binaryPath, args, env, stderr: 'inherit' });
    const client = new Client(VULCAN_CLIENT_INFO, { capabilities: {} });

    // Wire crash detection BEFORE connect so we capture handshake-time failures too.
    // T1.5: capture the transport reference in the closure so a stale callback from a prior transport (post-restart)
    // doesn't clobber the new running state.
    transport.onclose = () => {
      if (this.transport !== transport) return;
      this.markCrashed(new Error('Vulcan subprocess exited unexpectedly; restart the bridge.'));
    };
    transport.onerror = (err) => {
      if (this.transport !== transport) return;
      this.markCrashed(err);
    };

    try {
      // Protocol.connect(transport) calls transport.start() internally — never call it explicitly.
      await client.connect(transport);
    } catch (err) {
      this.lastError = wrapStartError(err, this.opts.binaryPath);
      // Best-effort transport cleanup; transport may already be closed if spawn ENOENT'd.
      try {
        await transport.close();
      } catch {
        // Ignore.
      }
      throw this.lastError;
    }

    // Capture upstream identity for status surfaces + run optional pinning checks.
    const serverInfo = readServerInfo(client);
    if (this.opts.requiredServerName && serverInfo?.name !== this.opts.requiredServerName) {
      const msg = `Upstream MCP server name "${serverInfo?.name ?? 'unknown'}" does not match required "${this.opts.requiredServerName}".`;
      this.lastError = new Error(msg);
      try {
        await client.close();
        await transport.close();
      } catch {
        // Ignore cleanup errors.
      }
      throw this.lastError;
    }
    if (this.opts.requiredServerVersion && serverInfo?.version !== this.opts.requiredServerVersion) {
      const msg = `Upstream Vulcan version "${serverInfo?.version ?? 'unknown'}" does not match required "${this.opts.requiredServerVersion}". Update the binary or relax requiredServerVersion in config.`;
      this.lastError = new Error(msg);
      try {
        await client.close();
        await transport.close();
      } catch {
        // Ignore.
      }
      throw this.lastError;
    }

    this.client = client;
    this.transport = transport;
    this.running = true;
    this.lastError = undefined;
    this.serverInfo = serverInfo;
    this.restartAttempt = 0;
    this.events.onStarted?.(serverInfo);
  }

  /**
   * List all upstream tools. Cached after the first call; pass `force` to re-fetch (e.g., after a restart).
   * Empty result is returned as-is; callers that care about emptiness should warn ("vulcan setup not run").
   */
  async listTools(force = false): Promise<VulcanToolDescriptor[]> {
    if (!force && this.toolsCache) return this.toolsCache;
    this.assertRunning();
    const result = await this.client!.listTools();
    const tools: VulcanToolDescriptor[] = (result.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined && { description: tool.description }),
      ...(tool.inputSchema !== undefined && { inputSchema: tool.inputSchema as Record<string, unknown> }),
    }));
    this.toolsCache = tools;
    return tools;
  }

  /**
   * Invoke an upstream tool. Returns the raw MCP result (content array + optional structuredContent + isError flag).
   * Caller is responsible for shaping the response into Agentic's `jsonReply` envelope.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<VulcanCallToolResult> {
    this.assertRunning();
    const result = await this.client!.callTool(
      { name, arguments: args },
      undefined,
      { timeout: this.opts.toolCallTimeoutMs },
    );
    return {
      content: result.content,
      ...(typeof result.isError === 'boolean' && { isError: result.isError }),
      ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent }),
    };
  }

  /**
   * Gracefully tear down the subprocess. Safe to call when not running. After stop() the client must be restarted
   * before further use. Cancels any pending auto-restart.
   */
  async stop(): Promise<void> {
    this.cancelRestartTimer();
    this.restartAttempt = 0;
    if (!this.running) return;
    this.running = false;
    this.toolsCache = undefined;
    try {
      await this.client?.close();
    } finally {
      try {
        await this.transport?.close();
      } finally {
        this.client = undefined;
        this.transport = undefined;
      }
    }
  }

  private assertRunning(): void {
    if (!this.running || !this.client) {
      const detail = this.lastError ? ` Last error: ${this.lastError.message}` : '';
      throw new Error(`Vulcan upstream client is not started.${detail} Call start() first.`);
    }
  }

  /**
   * Mark the client as crashed: clear running state and capture the cause for the next assertRunning() to surface.
   * Triggered by transport `onclose` (process exit) or `onerror` (protocol error). Idempotent.
   *
   * When `autoRestart` is enabled, schedules a backoff restart unless attempts are exhausted.
   */
  private markCrashed(err: Error): void {
    if (!this.running && !this.client) return;
    this.running = false;
    this.lastError = err;
    this.toolsCache = undefined;
    // Don't await close() here: onclose/onerror callbacks fire from the transport itself and the SDK will
    // serialize cleanup on its own. We just flip our state so subsequent calls fail loudly.
    this.client = undefined;
    this.transport = undefined;
    this.events.onCrash?.(err);
    if (this.opts.autoRestart) this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== undefined) return; // already scheduled
    const schedule = this.opts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    if (schedule.length === 0 || this.restartAttempt >= schedule.length) {
      const giveUp = new Error(
        `Vulcan auto-restart gave up after ${this.restartAttempt} attempt(s); last error: ${this.lastError?.message ?? 'unknown'}.`,
      );
      this.lastError = giveUp;
      this.events.onRestartGaveUp?.(giveUp, this.restartAttempt);
      return;
    }
    const delayMs = schedule[this.restartAttempt]!;
    this.events.onRestartScheduled?.(this.restartAttempt + 1, delayMs);
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = undefined;
      // T1.6: skip the auto-restart if the user manually called start() while the timer was pending.
      if (this.running) return;
      this.restartAttempt += 1;
      this.start().catch((restartErr) => {
        // start() already captured lastError; schedule next attempt if budget remains.
        if (restartErr instanceof Error) this.lastError = restartErr;
        if (this.opts.autoRestart) this.scheduleRestart();
      });
    }, delayMs);
  }

  private cancelRestartTimer(): void {
    if (this.restartTimer !== undefined) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env, ...(this.opts.envOverride ?? {}) } as Record<string, string>;
    if (this.opts.walletName) env.VULCAN_WALLET_NAME = this.opts.walletName;
    if (this.opts.allowDangerous && this.opts.walletPassword) {
      env.VULCAN_WALLET_PASSWORD = this.opts.walletPassword;
    }
    return env;
  }
}

function readServerInfo(client: Client): { name: string; version: string } | undefined {
  // SDK 1.29 exposes `Client.getServerVersion(): Implementation | undefined` populated from the initialize
  // handshake. Returns undefined before connect or if the server didn't advertise serverInfo.
  const info = client.getServerVersion();
  if (!info) return undefined;
  if (typeof info.name !== 'string' || typeof info.version !== 'string') return undefined;
  return { name: info.name, version: info.version };
}

function wrapStartError(err: unknown, binaryPath: string): Error {
  const cause = err instanceof Error ? err : new Error(String(err));
  const code = (cause as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new Error(
      `Vulcan binary not found at "${binaryPath}". Install via 'cargo install --git https://github.com/Ellipsis-Labs/vulcan-cli' or set PHOENIX_VULCAN_BINARY to an absolute path.`,
    );
  }
  if (code === 'EACCES') {
    return new Error(
      `Vulcan binary at "${binaryPath}" is not executable. Check permissions or set PHOENIX_VULCAN_BINARY to an executable copy.`,
    );
  }
  return new Error(`Failed to start Vulcan upstream: ${cause.message}`);
}

/**
 * Returned alongside `listTools()` results when the upstream reports zero tools — usually a sign that `vulcan setup`
 * has not been run on the host. Surfaced via traces and the `solana_vulcan_status` MCP tool.
 */
export const VULCAN_EMPTY_TOOLS_HINT =
  'Vulcan connected but reported no tools. Run `vulcan setup` to register a wallet and activate Phoenix before enabling the bridge.';

/** Keys Vulcan is known to use for the Solana signature/transaction ID across its `{ ok, data, meta }` envelope. */
const VULCAN_TXID_KEYS = ['signature', 'txid', 'tx', 'transactionId', 'transaction_id', 'hash'] as const;

/**
 * Extract a Solana transaction signature from a Vulcan tool response. Vulcan's documented envelope is
 * `{ ok, data, meta }`; the signature can live at:
 *   1. `structuredContent.data.{signature|txid|tx|...}`
 *   2. `structuredContent.{signature|...}` (when the tool elides `data`)
 *   3. `content[0].text` parsed as JSON, same key search at root or at `.data`
 *
 * Returns the first non-empty string found, or `undefined`. Defensive: never throws on malformed input.
 */
export function extractVulcanTxid(result: VulcanCallToolResult): string | undefined {
  if (result.structuredContent !== undefined) {
    const sc = result.structuredContent;
    const fromData = findStringByKeys(asRecord(asRecord(sc)?.data), VULCAN_TXID_KEYS);
    if (fromData) return fromData;
    const fromRoot = findStringByKeys(asRecord(sc), VULCAN_TXID_KEYS);
    if (fromRoot) return fromRoot;
  }
  const textPayload = extractFirstText(result.content);
  if (textPayload) {
    const parsed = safeParseJson(textPayload);
    if (parsed !== undefined) {
      const fromData = findStringByKeys(asRecord(asRecord(parsed)?.data), VULCAN_TXID_KEYS);
      if (fromData) return fromData;
      const fromRoot = findStringByKeys(asRecord(parsed), VULCAN_TXID_KEYS);
      if (fromRoot) return fromRoot;
    }
  }
  return undefined;
}

/**
 * Extract a human-readable error message from a Vulcan tool response (used when `isError: true`).
 *
 * Preference order:
 *   1. `structuredContent.error.message` (Vulcan's documented error envelope).
 *   2. `content[0].text` if content is a text-shaped array.
 *   3. JSON-stringified `content` as a last resort (matches the legacy behavior).
 */
export function extractVulcanErrorMessage(result: VulcanCallToolResult): string {
  if (result.structuredContent !== undefined) {
    const errorField = asRecord(asRecord(result.structuredContent)?.error);
    const msg = findStringByKeys(errorField, ['message', 'detail', 'reason']);
    if (msg) return msg;
  }
  const text = extractFirstText(result.content);
  if (text && text.trim()) return text.trim();
  try {
    return JSON.stringify(result.content);
  } catch {
    return String(result.content);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function findStringByKeys(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function extractFirstText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (!first || typeof first !== 'object') return undefined;
  const text = (first as Record<string, unknown>).text;
  return typeof text === 'string' ? text : undefined;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
