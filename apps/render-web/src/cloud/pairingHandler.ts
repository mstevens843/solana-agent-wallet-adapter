// Cloud pairing relay for the desktop Discover → "Scan QR with phone" flow
// when the user picks Phantom or Solflare. Those wallets don't speak
// WalletConnect v2 the way Backpack/Jupiter do — their universal-link
// deeplinks land the user on `/qr-connect`, which decrypts the wallet
// response and registers the phone. The desktop (which can't reach the
// phone directly) polls this relay to learn the connected address and then
// routes signing requests through the relay back to the phone.
//
// Architecture: in-memory `Map<uuid, PairingRecord>` keyed by a v4 UUID
// the desktop generates client-side and embeds in the deeplink. Anyone
// with the UUID can read or write the record — UUIDs ARE the secret, so
// they're generated from `crypto.randomUUID()` (122 random bits) and
// never logged. TTL: 30 minutes since last activity (sweeper runs every
// 60s).
//
// Routes:
//   POST /api/pair/:uuid/deeplink        desktop stores deeplink crypto metadata
//   GET  /api/pair/:uuid/deeplink        wallet-host reads deeplink crypto metadata
//   POST /api/pair/:uuid/host            wallet-host registers address
//   GET  /api/pair/:uuid/host            desktop polls for the address
//   POST /api/pair/:uuid/submit          desktop submits signing request
//   GET  /api/pair/:uuid/inbox           wallet-host long-polls for requests
//   POST /api/pair/:uuid/inbox/:reqId    wallet-host posts the signed result
//   GET  /api/pair/:uuid/submit/:reqId   desktop polls for the result
//
// Tests live in `__tests__/pairingHandler.test.ts`; the handler is
// driven through its public `handle(req, res, url)` entry point.

import type { IncomingMessage, ServerResponse } from 'node:http';

const PAIRING_PATH_PREFIX = '/api/pair/';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_INBOX_PER_PAIRING = 32;
const REQUESTS_PER_MINUTE = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_IN_FLIGHT_LEASE_MS = 90_000;

export interface PairingClock {
  now(): number;
}

interface RateBucket {
  windowStart: number;
  count: number;
}

type RateGroup = 'deeplink' | 'host' | 'submit' | 'submit-result' | 'inbox' | 'inbox-result' | 'other';

interface InboxEntry {
  requestId: string;
  request: unknown;
  status: 'pending' | 'in_flight' | 'resolved';
  result: unknown | undefined;
  inFlightUntil: number | undefined;
}

interface DeeplinkMetadata {
  wallet: 'phantom' | 'solflare';
  cluster: 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';
  appUrl: string;
  dappPublicKey: string;
  dappSecretKey: string;
  createdAt: number;
}

interface PairingRecord {
  uuid: string;
  deeplink: DeeplinkMetadata | null;
  host:
    | {
        address: string;
        capabilities: unknown;
        walletName: string;
      }
    | null;
  inbox: InboxEntry[];
  createdAt: number;
  lastSeenAt: number;
  rate: Partial<Record<RateGroup, RateBucket>>;
}

export interface PairingHandlerOptions {
  clock?: PairingClock;
  ttlMs?: number;
  inFlightLeaseMs?: number;
  /** Test hook — when set, replaces `crypto.randomUUID()` for request IDs. */
  generateRequestId?: () => string;
}

export interface PairingHandler {
  /** Dispatches the request if its path matches `/api/pair/...`. Returns
   *  `true` when the route was handled (a response has been written),
   *  `false` when the URL didn't match (caller continues dispatching). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Stops the TTL sweeper. Tests call this in afterAll. */
  shutdown(): void;
}

export function createPairingHandler(options: PairingHandlerOptions = {}): PairingHandler {
  const clock = options.clock ?? { now: () => Date.now() };
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const inFlightLeaseMs = options.inFlightLeaseMs ?? DEFAULT_IN_FLIGHT_LEASE_MS;
  const generateRequestId =
    options.generateRequestId ??
    (typeof globalThis.crypto?.randomUUID === 'function'
      ? () => globalThis.crypto.randomUUID()
      : () => `req-${Math.random().toString(36).slice(2)}-${Date.now()}`);
  const store = new Map<string, PairingRecord>();

  const sweeper = setInterval(() => {
    const cutoff = clock.now() - ttlMs;
    for (const [uuid, record] of store) {
      if (record.lastSeenAt < cutoff) {
        store.delete(uuid);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the Node event loop alive just for the sweeper — if the
  // host process has nothing else to do, it should exit cleanly.
  if (typeof sweeper.unref === 'function') sweeper.unref();

  function getOrCreate(uuid: string): PairingRecord {
    let record = store.get(uuid);
    if (!record) {
      const now = clock.now();
      record = {
        uuid,
        host: null,
        deeplink: null,
        inbox: [],
        createdAt: now,
        lastSeenAt: now,
        rate: {},
      };
      store.set(uuid, record);
    }
    return record;
  }

  function touch(record: PairingRecord): void {
    record.lastSeenAt = clock.now();
  }

  function checkRate(record: PairingRecord, group: RateGroup): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = clock.now();
    const bucket = record.rate[group] ?? { windowStart: now, count: 0 };
    if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
      bucket.windowStart = now;
      bucket.count = 0;
    }
    record.rate[group] = bucket;
    if (bucket.count >= REQUESTS_PER_MINUTE) {
      const retryAfterMs = Math.max(1000, RATE_LIMIT_WINDOW_MS - (now - bucket.windowStart));
      return { ok: false, retryAfterMs };
    }
    bucket.count += 1;
    return { ok: true };
  }

  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith(PAIRING_PATH_PREFIX)) return false;

      // CORS — the desktop's Tauri webview lives on a non-agentic-signer.com
      // origin (`tauri://localhost` in prod, `http://localhost:5174` in dev),
      // so cross-origin is the rule for desktop callers. Wallet-host POSTs
      // are first-party but the same wildcard is safe since pairing UUIDs
      // are the secret, not the origin.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-max-age', '600');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
      }

      const rest = url.pathname.slice(PAIRING_PATH_PREFIX.length);
      const segments = rest.split('/').filter((s) => s.length > 0);
      if (segments.length < 2) {
        writeJson(res, 404, { error: 'not_found' });
        return true;
      }
      const uuid = segments[0]!;
      if (!UUID_V4_PATTERN.test(uuid)) {
        writeJson(res, 400, { error: 'invalid_pairing_id' });
        return true;
      }

      const record = getOrCreate(uuid);
      const action = segments[1];
      const trailing = segments[2];
      const rate = checkRate(record, rateGroupForRequest(action, segments.length, req.method ?? '', Boolean(trailing)));
      if (!rate.ok) {
        writeRateLimited(res, rate.retryAfterMs);
        return true;
      }
      touch(record);

      try {
        if (action === 'deeplink' && segments.length === 2) {
          if (req.method === 'POST') return await postDeeplink(req, res, record, clock.now());
          if (req.method === 'GET') return getDeeplink(res, record);
        }
        if (action === 'host' && segments.length === 2) {
          if (req.method === 'POST') return await postHost(req, res, record);
          if (req.method === 'GET') return getHost(res, record);
        }
        if (action === 'submit' && segments.length === 2 && req.method === 'POST') {
          return await postSubmit(req, res, record, generateRequestId);
        }
        if (action === 'submit' && segments.length === 3 && req.method === 'GET' && trailing) {
          return getSubmitResult(res, record, trailing);
        }
        if (action === 'inbox' && segments.length === 2 && req.method === 'GET') {
          return getInbox(res, record, clock.now(), inFlightLeaseMs);
        }
        if (action === 'inbox' && segments.length === 3 && req.method === 'POST' && trailing) {
          return await postInboxResult(req, res, record, trailing);
        }
        writeJson(res, 405, { error: 'method_not_allowed' });
        return true;
      } catch (err) {
        if (err instanceof PairingError) {
          writeJson(res, err.status, { error: err.code });
          return true;
        }
        writeJson(res, 500, { error: 'internal_error' });
        return true;
      }
    },
    shutdown(): void {
      clearInterval(sweeper);
    },
  };
}

async function postHost(
  req: IncomingMessage,
  res: ServerResponse,
  record: PairingRecord,
): Promise<boolean> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  const walletName = typeof body.walletName === 'string' ? body.walletName.trim() : '';
  if (!address || !walletName || !body.capabilities || typeof body.capabilities !== 'object') {
    writeJson(res, 400, { error: 'invalid_host_payload' });
    return true;
  }
  record.host = {
    address,
    walletName,
    capabilities: body.capabilities,
  };
  writeJson(res, 200, { ok: true });
  return true;
}

async function postDeeplink(
  req: IncomingMessage,
  res: ServerResponse,
  record: PairingRecord,
  now: number,
): Promise<boolean> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const wallet = typeof body.wallet === 'string' ? body.wallet.trim() : '';
  const cluster = typeof body.cluster === 'string' ? body.cluster.trim() : '';
  const appUrl = typeof body.appUrl === 'string' ? body.appUrl.trim() : '';
  const dappPublicKey = typeof body.dappPublicKey === 'string' ? body.dappPublicKey.trim() : '';
  const dappSecretKey = typeof body.dappSecretKey === 'string' ? body.dappSecretKey.trim() : '';
  if (
    !isDeeplinkWallet(wallet) ||
    !isDeeplinkCluster(cluster) ||
    !isHttpsUrl(appUrl) ||
    !dappPublicKey ||
    !dappSecretKey
  ) {
    writeJson(res, 400, { error: 'invalid_deeplink_payload' });
    return true;
  }
  record.deeplink = {
    wallet,
    cluster,
    appUrl,
    dappPublicKey,
    dappSecretKey,
    createdAt: now,
  };
  writeJson(res, 200, { ok: true });
  return true;
}

function getDeeplink(res: ServerResponse, record: PairingRecord): boolean {
  if (!record.deeplink) {
    writeJson(res, 404, { error: 'deeplink_not_registered' });
    return true;
  }
  writeJson(res, 200, record.deeplink);
  return true;
}

function getHost(res: ServerResponse, record: PairingRecord): boolean {
  if (!record.host) {
    writeJson(res, 404, { error: 'pairing_not_registered' });
    return true;
  }
  writeJson(res, 200, record.host);
  return true;
}

function isDeeplinkWallet(value: string): value is DeeplinkMetadata['wallet'] {
  return value === 'phantom' || value === 'solflare';
}

function isDeeplinkCluster(value: string): value is DeeplinkMetadata['cluster'] {
  return value === 'mainnet-beta' || value === 'testnet' || value === 'devnet' || value === 'localnet';
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function rateGroupForRequest(
  action: string | undefined,
  segmentCount: number,
  method: string,
  hasTrailing: boolean,
): RateGroup {
  if (action === 'deeplink' && segmentCount === 2) return 'deeplink';
  if (action === 'host' && segmentCount === 2) return 'host';
  if (action === 'submit' && segmentCount === 2 && method === 'POST') return 'submit';
  if (action === 'submit' && segmentCount === 3 && method === 'GET' && hasTrailing) return 'submit-result';
  if (action === 'inbox' && segmentCount === 2 && method === 'GET') return 'inbox';
  if (action === 'inbox' && segmentCount === 3 && method === 'POST' && hasTrailing) return 'inbox-result';
  return 'other';
}

async function postSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  record: PairingRecord,
  generateRequestId: () => string,
): Promise<boolean> {
  if (!record.host) {
    writeJson(res, 409, { error: 'host_not_registered' });
    return true;
  }
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  if (!body.request || typeof body.request !== 'object') {
    writeJson(res, 400, { error: 'invalid_submit_payload' });
    return true;
  }
  if (record.inbox.length >= MAX_INBOX_PER_PAIRING) {
    // Drop the oldest resolved entry to make room. If nothing is resolved
    // yet, reject — caller is firing too fast.
    const resolvedIdx = record.inbox.findIndex((e) => e.status === 'resolved');
    if (resolvedIdx === -1) {
      writeJson(res, 429, { error: 'inbox_full' });
      return true;
    }
    record.inbox.splice(resolvedIdx, 1);
  }
  const requestId = generateRequestId();
  record.inbox.push({
    requestId,
    request: body.request,
    status: 'pending',
    result: undefined,
    inFlightUntil: undefined,
  });
  writeJson(res, 200, { requestId, status: 'pending' });
  return true;
}

function getInbox(
  res: ServerResponse,
  record: PairingRecord,
  now: number,
  inFlightLeaseMs: number,
): boolean {
  // Return pending requests, plus stale in-flight requests whose phone page
  // likely closed or reloaded before posting a result. Fresh in-flight
  // entries stay hidden so the wallet-host doesn't double-sign on retry.
  const pending = record.inbox.filter((e) =>
    e.status === 'pending' ||
    (e.status === 'in_flight' && (e.inFlightUntil ?? 0) <= now)
  );
  for (const entry of pending) {
    entry.status = 'in_flight';
    entry.inFlightUntil = now + inFlightLeaseMs;
  }
  writeJson(res, 200, {
    requests: pending.map((entry) => ({ requestId: entry.requestId, request: entry.request })),
  });
  return true;
}

async function postInboxResult(
  req: IncomingMessage,
  res: ServerResponse,
  record: PairingRecord,
  requestId: string,
): Promise<boolean> {
  const entry = record.inbox.find((e) => e.requestId === requestId);
  if (!entry) {
    writeJson(res, 404, { error: 'request_not_found' });
    return true;
  }
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  if (!body || typeof body !== 'object') {
    writeJson(res, 400, { error: 'invalid_result_payload' });
    return true;
  }
  entry.status = 'resolved';
  entry.result = body;
  entry.inFlightUntil = undefined;
  writeJson(res, 200, { ok: true });
  return true;
}

function getSubmitResult(res: ServerResponse, record: PairingRecord, requestId: string): boolean {
  const entry = record.inbox.find((e) => e.requestId === requestId);
  if (!entry) {
    writeJson(res, 404, { error: 'request_not_found' });
    return true;
  }
  if (entry.status === 'resolved') {
    // The wallet-host POSTed an `ApprovalResource`-shaped payload (status:
    // approved/rejected/error + result/error/approvalUri). Return it
    // directly — the desktop's RemoteRelayBackend treats the response as
    // the ApprovalResource straight off the wire.
    writeJson(res, 200, entry.result ?? { requestId, status: 'pending' });
    return true;
  }
  writeJson(res, 200, { requestId, status: 'pending' });
  return true;
}

class PairingError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'PairingError';
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new PairingError(413, 'request_too_large');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new PairingError(400, 'invalid_json');
  }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function writeRateLimited(res: ServerResponse, retryAfterMs: number): void {
  res.setHeader('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  writeJson(res, 429, {
    error: 'rate_limited',
    retryAfterMs,
  });
}
