// Desktop side of the Android "use your plan from your phone" bridge. The phone
// can't reach this loopback-bound bridge directly, so instead of opening an
// inbound hole we dial OUT to the cloud relay (apps/render-web
// bridgeAiRelayHandler.ts), long-poll for AI requests the phone submitted, run
// them through the SAME local /bridge/ai handlers (subscription connector CLI
// under the user's own session), and post the result back. We never touch the
// bridge's loopback bind guard.
//
// `pairToken` is one-time and only ever leaves this process inside the QR shown
// on the desktop screen. `bridgeSecret` authenticates this desktop to the relay
// and never leaves the process. The relay stores only SHA-256 hashes.
//
// Pilot scope: the relay forwards a fixed allowlist of /bridge/ai/* paths only
// (FORWARDABLE list mirrored from the relay); dispatch() maps each to a local
// planner/connector call. Codex + Claude are the supported connectors for v1
// (Gemini/Antigravity have no headless `login`).

import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const DEFAULT_RELAY_BASE_URL =
  (process.env.AGENTIC_RELAY_BASE_URL ?? '').trim() || 'https://agentic-signer.com';

// Deterministic, secret-safe desktop-side logging. One stable JSON line per event prefixed
// `[bridge-pair]`. `tag` = first 8 hex of sha256(pairUuid) — the SAME correlation id the relay and
// the phone derive, so a single AI request lines up across all three hops without logging the uuid
// (a bearer-grade secret) or the bridgeSecret/pairToken (never logged). Silenced under vitest.
const PAIR_LOG_SILENCED = Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';

export function pairTag(uuid: string): string {
  return createHash('sha256').update(uuid, 'utf8').digest('hex').slice(0, 8);
}

function defaultPairingLogger(event: Record<string, unknown>): void {
  if (PAIR_LOG_SILENCED) return;
  try {
    console.error(`[bridge-pair] ${JSON.stringify(event)}`);
  } catch {
    // logging must never affect the pairing loop
  }
}

// Opt-in verbose dump of the dispatched model output (plan/review JSON — user data, not
// credentials). Off by default; turn on with AGENTIC_BRIDGE_PAIR_LOG_BODIES=1 when chasing a
// payload-shape bug.
const LOG_PAIR_BODIES = (process.env.AGENTIC_BRIDGE_PAIR_LOG_BODIES ?? '').trim() === '1';

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function sha8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

const PAIR_SECRET_KEY_PATTERN = /token|secret|bearer|api[_-]?key|authorization|private|seed|mnemonic|passphrase/i;

function redactBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBody);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = PAIR_SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactBody(val);
    }
    return out;
  }
  return value;
}

/** Maps a forwarded /bridge/ai/* path + body to the local AI result. Built in
 *  bridgeServer.ts where the planner and connector helpers are in scope. */
export type BridgeAiDispatch = (path: string, body: unknown) => Promise<unknown>;

interface FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export interface BridgePairingControllerOptions {
  dispatch: BridgeAiDispatch;
  relayBaseUrl?: string;
  fetchImpl?: FetchLike;
  /** Test hook for deterministic uuid/token/secret. */
  generateIds?: () => { pairUuid: string; pairToken: string; bridgeSecret: string };
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onLog?: (event: Record<string, unknown>) => void;
}

export interface BridgePairingState {
  active: boolean;
  paired: boolean;
  pairUuid: string | null;
  relayBaseUrl: string;
  /** The JSON string the desktop encodes into the QR. Null when not pairing. */
  qrPayload: string | null;
  startedAt: number | null;
}

interface PollResult {
  paired: boolean;
  justPaired: boolean;
  requests: Array<{ requestId: string; path: string; body: unknown }>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const MAX_PROCESSED_CACHE = 32;
const RESPOND_MAX_ATTEMPTS = 3;
const MAX_POLL_BACKOFF_MS = 30_000;
// If no phone claims within this window, stop the loop + revoke. Our own polls touch() the relay
// session, keeping it alive forever otherwise — so the modal-close handler isn't the only safety net.
const ABANDON_TIMEOUT_MS = 120_000;

export class BridgePairingController {
  private readonly dispatch: BridgeAiDispatch;
  private readonly relayBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly generateIds: () => { pairUuid: string; pairToken: string; bridgeSecret: string };
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onLog: (event: Record<string, unknown>) => void;

  // Stable for the controller's lifetime; bridgeSecret never leaves the process.
  private readonly bridgeSecret: string;
  private pairUuid: string | null = null;
  private pairToken: string | null = null;
  private paired = false;
  private running = false;
  private startedAt: number | null = null;
  private loopHandle: Promise<void> | null = null;
  // requestId -> serialized result, so a relay re-delivery (after a respond blip) re-posts the cached
  // result instead of re-running the metered connector. Bounded (MUST stay >= 2× the relay's
  // MAX_INBOX_PER_SESSION so an evicted entry can't be re-dispatched); cleared on teardown.
  private readonly processedResults = new Map<string, string>();
  // requestIds currently being dispatched — a re-delivery mid-run dedupes to "still working" instead
  // of starting a second metered connector (defense-in-depth; sequential dispatch makes it rare).
  private readonly inProgress = new Set<string>();

  constructor(options: BridgePairingControllerOptions) {
    this.dispatch = options.dispatch;
    this.relayBaseUrl = stripTrailingSlash(options.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.generateIds =
      options.generateIds ??
      (() => ({ pairUuid: randomUUID(), pairToken: randomToken(32), bridgeSecret: randomToken(32) }));
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
    this.now = options.now ?? (() => Date.now());
    this.onLog = options.onLog ?? defaultPairingLogger;
    // bridgeSecret is fixed for the controller's lifetime and taken from this one generateIds() call;
    // the pairUuid/pairToken from it are intentionally discarded (start() generates fresh ones each
    // pairing and discards THAT call's bridgeSecret). A stateful/counter-based test generateIds must
    // account for the two calls.
    this.bridgeSecret = this.generateIds().bridgeSecret;
  }

  state(): BridgePairingState {
    return {
      active: this.running,
      paired: this.paired,
      pairUuid: this.pairUuid,
      relayBaseUrl: this.relayBaseUrl,
      qrPayload: this.pairUuid && this.pairToken ? this.buildQrPayload(this.pairUuid, this.pairToken) : null,
      startedAt: this.startedAt,
    };
  }

  /** Start (or restart) pairing: mint a fresh uuid+token, register with the
   *  relay, and begin the poll loop. Returns the QR payload for the desktop UI.
   *  A prior pairing is torn down first (v1 supports one paired phone). */
  async start(): Promise<BridgePairingState> {
    await this.stop();
    const ids = this.generateIds();
    this.pairUuid = ids.pairUuid;
    this.pairToken = ids.pairToken;
    this.paired = false;
    this.startedAt = this.now();
    await this.relayFetch(`/api/bridge-pair/${this.pairUuid}/register`, {
      method: 'POST',
      body: JSON.stringify({ pairToken: this.pairToken, bridgeSecret: this.bridgeSecret }),
    });
    this.running = true;
    this.loopHandle = this.runLoop();
    this.onLog({ phase: 'pair_started', tag: pairTag(this.pairUuid), relayBaseUrl: this.relayBaseUrl });
    return this.state();
  }

  /** Stop the poll loop and best-effort revoke the relay session. */
  async stop(): Promise<void> {
    if (!this.running && !this.pairUuid) return;
    this.running = false;
    const handle = this.loopHandle;
    if (handle) await handle.catch(() => {});
    const uuid = this.pairUuid;
    if (uuid) {
      await this.relayFetch(`/api/bridge-pair/${uuid}/unpair`, {
        method: 'POST',
        headers: { 'x-bridge-secret': this.bridgeSecret },
      }).catch(() => {});
    }
    this.teardown('stopped');
  }

  /** Single teardown path for stop() AND the in-loop dead-session branches (404/401/403), so there's
   *  one place that nulls state + loopHandle + cache and logs once. Prevents the divergent "stopped"
   *  paths (B5) where a 404 self-reset orphaned loopHandle. */
  private teardown(reason: string): void {
    this.running = false;
    this.loopHandle = null;
    const uuid = this.pairUuid;
    this.pairUuid = null;
    this.pairToken = null;
    this.paired = false;
    this.startedAt = null;
    this.processedResults.clear();
    this.inProgress.clear();
    if (uuid) this.onLog({ phase: 'pair_stopped', tag: pairTag(uuid), reason });
  }

  /** One poll → dispatch → respond cycle. Public so it can be unit-tested
   *  without the live loop. Returns how many requests it handled. */
  async pollOnce(): Promise<{ paired: boolean; handled: number }> {
    if (!this.pairUuid) return { paired: this.paired, handled: 0 };
    const uuid = this.pairUuid;
    const res = await this.relayFetch(`/api/bridge-pair/${uuid}/poll`, {
      method: 'GET',
      headers: { 'x-bridge-secret': this.bridgeSecret },
    });
    if (res.status === 404) {
      // Session swept/revoked relay-side — tear down so state() stops reporting a phantom paired phone.
      this.teardown('relay_session_gone');
      return { paired: false, handled: 0 };
    }
    if (res.status === 401 || res.status === 403) {
      // The bridge secret is no longer accepted — the pairing is permanently broken; tear down rather
      // than spin (or back off) forever against a dead session.
      this.teardown('pair_auth_failed');
      return { paired: false, handled: 0 };
    }
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      // Relay 5xx/timeout/overload (deploy, cold start) — throw so runLoop backs off instead of
      // hammering every 2s. Benign transient 4xx falls through to a silent skip below.
      throw new Error(`poll_status_${res.status}`);
    }
    if (res.status !== 200) return { paired: this.paired, handled: 0 };
    const poll = (await res.json()) as PollResult;
    this.paired = Boolean(poll.paired);
    // Abandoned-pairing guard: no phone claimed within the window — revoke + stop so this loop (and the
    // relay session our polls keep alive) doesn't run forever. Robust even if the webview close handler
    // never fired (tab/app killed).
    if (!this.paired && this.startedAt !== null && this.now() - this.startedAt > ABANDON_TIMEOUT_MS) {
      void this.relayFetch(`/api/bridge-pair/${uuid}/unpair`, {
        method: 'POST',
        headers: { 'x-bridge-secret': this.bridgeSecret },
      }).catch(() => {});
      this.teardown('abandoned_unclaimed');
      return { paired: false, handled: 0 };
    }
    if (poll.justPaired) this.onLog({ phase: 'phone_paired', tag: pairTag(uuid) });
    const requests = Array.isArray(poll.requests) ? poll.requests : [];
    if (requests.length > 0) this.onLog({ phase: 'poll', tag: pairTag(uuid), count: requests.length });
    // Run sequentially: a desktop runs one connector CLI at a time, and the
    // relay leases each in-flight request so order/concurrency stays simple.
    for (const request of requests) {
      await this.handleRequest(uuid, request);
    }
    return { paired: this.paired, handled: requests.length };
  }

  private async handleRequest(
    uuid: string,
    request: { requestId: string; path: string; body: unknown },
  ): Promise<void> {
    const tag = pairTag(uuid);
    // Dedupe a re-delivery still being dispatched (lease lapse while running): the original will post
    // when done — don't start a second metered connector.
    if (this.inProgress.has(request.requestId)) {
      this.onLog({ phase: 'dispatch_inflight_dedup', tag, requestId: request.requestId, path: request.path });
      return;
    }
    // Dedupe a re-delivery whose result we already computed (respond blip): re-post the cached result.
    const cached = this.processedResults.get(request.requestId);
    if (cached !== undefined) {
      this.onLog({ phase: 'dispatch_dedup', tag, requestId: request.requestId, path: request.path });
      await this.postResult(uuid, request.requestId, cached, tag);
      return;
    }
    const startedAt = this.now();
    this.onLog({ phase: 'dispatch_start', tag, requestId: request.requestId, path: request.path });
    let result: unknown;
    let ok = true;
    this.inProgress.add(request.requestId);
    try {
      result = await this.dispatch(request.path, request.body);
    } catch (err) {
      // Mirror the bridge's streamed `{ error }` envelope so the phone client
      // classifies a connector failure the same way the desktop webview does.
      ok = false;
      result = { error: redact(err instanceof Error ? err.message : String(err)) };
    } finally {
      this.inProgress.delete(request.requestId);
    }
    // Cache the result (including error envelopes) so a re-delivery re-posts instead of re-running the
    // metered connector — a transient error becoming sticky on the rare re-delivery is the deliberate
    // cost-safety trade.
    const serialized = safeStringify(result);
    this.cacheResult(request.requestId, serialized);
    this.onLog({
      phase: ok ? 'dispatch_ok' : 'dispatch_failed',
      tag,
      requestId: request.requestId,
      path: request.path,
      elapsedMs: this.now() - startedAt,
      bytes: serialized.length,
      sha8: sha8(serialized),
      ...(ok ? {} : { message: (result as { error?: string }).error }),
      // The model output (plan/review) — user data, not credentials — only under an explicit flag.
      ...(LOG_PAIR_BODIES ? { result: redactBody(result) } : {}),
    });
    await this.postResult(uuid, request.requestId, serialized, tag);
  }

  private cacheResult(requestId: string, serialized: string): void {
    this.processedResults.set(requestId, serialized);
    while (this.processedResults.size > MAX_PROCESSED_CACHE) {
      const oldest = this.processedResults.keys().next().value;
      if (oldest === undefined) break;
      this.processedResults.delete(oldest);
    }
  }

  /** POST the result with bounded retry. A respond blip otherwise leaves the relay entry in_flight,
   *  the lease lapses, and the connector re-runs on re-delivery — wasted metered cost. */
  private async postResult(uuid: string, requestId: string, serialized: string, tag: string): Promise<void> {
    for (let attempt = 0; attempt < RESPOND_MAX_ATTEMPTS; attempt += 1) {
      let retryAfterMs: number | null = null;
      try {
        const res = await this.relayFetch(`/api/bridge-pair/${uuid}/respond/${requestId}`, {
          method: 'POST',
          headers: { 'x-bridge-secret': this.bridgeSecret },
          body: serialized,
        });
        if (res.status >= 200 && res.status < 300) return;
        if (res.status === 404) return; // session gone — nothing to deliver to
        // Deterministic 4xx (bad secret, malformed body) won't change on retry — stop wasting attempts.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          this.onLog({ phase: 'respond_rejected', tag, requestId, status: res.status });
          return;
        }
        // 429: honor the relay's retryAfterMs so a fleet doesn't re-spike a rate-limited relay.
        if (res.status === 429) {
          try {
            const body = (await res.json()) as { retryAfterMs?: number };
            if (typeof body.retryAfterMs === 'number') retryAfterMs = body.retryAfterMs;
          } catch {
            // ignore — fall back to the jittered interval
          }
        }
        // else 5xx / 408 / 429 — fall through to retry.
      } catch (err) {
        this.onLog({ phase: 'respond_retry', tag, requestId, attempt, message: err instanceof Error ? err.message : String(err) });
      }
      if (attempt < RESPOND_MAX_ATTEMPTS - 1) {
        // Jitter (matching the poll backoff) so respond retries don't re-spike in lockstep.
        const base = retryAfterMs ?? this.pollIntervalMs;
        await this.sleep(Math.round(base * (0.8 + Math.random() * 0.4)));
      }
    }
    this.onLog({ phase: 'respond_failed', tag, requestId });
  }

  private async runLoop(): Promise<void> {
    let errorStreak = 0;
    while (this.running) {
      let delayMs = this.pollIntervalMs;
      try {
        await this.pollOnce();
        errorStreak = 0;
      } catch (err) {
        // Exponential backoff with ±20% jitter so a fleet of desktops doesn't re-spike a recovering
        // relay in lockstep after a deploy/restart.
        errorStreak += 1;
        const base = Math.min(this.pollIntervalMs * 2 ** errorStreak, MAX_POLL_BACKOFF_MS);
        delayMs = Math.round(base * (0.8 + Math.random() * 0.4));
        this.onLog({
          phase: 'poll_error',
          tag: this.pairUuid ? pairTag(this.pairUuid) : undefined,
          errorStreak,
          backoffMs: delayMs,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (this.running) await this.sleep(delayMs);
    }
  }

  private buildQrPayload(pairUuid: string, pairToken: string): string {
    // Short keys keep the QR dense. v=schema, relay=base URL, uuid, token.
    return JSON.stringify({ v: 1, relay: this.relayBaseUrl, uuid: pairUuid, token: pairToken });
  }

  private async relayFetch(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
    return this.fetchImpl(`${this.relayBaseUrl}${path}`, { ...init, headers });
  }
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function redact(message: string): string {
  return message
    .replace(/\b(sk|pk|sr|rk)-[A-Za-z0-9_-]{8,}\b/g, '$1-[redacted]')
    .replace(/((?:api[_-]?key|authorization|bearer|token)["'\s:=]+)\S+/gi, '$1[redacted]');
}
