// Cloud pairing relay for the desktop Discover → "Scan QR with phone" flow
// when the user picks Phantom or Solflare. Those wallets don't speak
// WalletConnect v2 the way Backpack/Jupiter do — their universal-link
// deeplinks land the user in the wallet's in-app browser at
// `agentic-signer.com/app?wallet=<brand>&pairing=<uuid>`. The wallet
// connects via wallet-standard inside that in-app browser; the desktop
// (which can't reach the phone directly) polls this relay to learn the
// connected address and then routes signing requests through the relay
// back to the phone.
//
// Architecture: in-memory `Map<uuid, PairingRecord>` keyed by a v4 UUID
// the desktop generates client-side and embeds in the deeplink. Anyone
// with the UUID can read or write the record — UUIDs ARE the secret, so
// they're generated from `crypto.randomUUID()` (122 random bits) and
// never logged. TTL: 30 minutes since last activity (sweeper runs every
// 60s).
//
// Six routes:
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

export interface PairingClock {
  now(): number;
}

interface RateBucket {
  windowStart: number;
  count: number;
}

interface InboxEntry {
  requestId: string;
  request: unknown;
  status: 'pending' | 'in_flight' | 'resolved';
  result: unknown | undefined;
}

interface PairingRecord {
  uuid: string;
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
  rate: RateBucket;
}

export interface PairingHandlerOptions {
  clock?: PairingClock;
  ttlMs?: number;
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
        inbox: [],
        createdAt: now,
        lastSeenAt: now,
        rate: { windowStart: now, count: 0 },
      };
      store.set(uuid, record);
    }
    return record;
  }

  function touch(record: PairingRecord): void {
    record.lastSeenAt = clock.now();
  }

  function checkRate(record: PairingRecord): boolean {
    const now = clock.now();
    if (now - record.rate.windowStart >= 60_000) {
      record.rate = { windowStart: now, count: 0 };
    }
    if (record.rate.count >= REQUESTS_PER_MINUTE) return false;
    record.rate.count += 1;
    return true;
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
      if (!checkRate(record)) {
        writeJson(res, 429, { error: 'rate_limited' });
        return true;
      }
      touch(record);

      const action = segments[1];
      const trailing = segments[2];

      try {
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
          return getInbox(res, record);
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

function getHost(res: ServerResponse, record: PairingRecord): boolean {
  if (!record.host) {
    writeJson(res, 404, { error: 'pairing_not_registered' });
    return true;
  }
  writeJson(res, 200, record.host);
  return true;
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
  });
  writeJson(res, 200, { requestId, status: 'pending' });
  return true;
}

function getInbox(res: ServerResponse, record: PairingRecord): boolean {
  // Return all pending requests; mark them in-flight so the wallet-host
  // doesn't double-sign on a retry. Resolved entries are kept around so
  // the desktop's submit-result poll can find them, but excluded here.
  const pending = record.inbox.filter((e) => e.status === 'pending');
  for (const entry of pending) {
    entry.status = 'in_flight';
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
