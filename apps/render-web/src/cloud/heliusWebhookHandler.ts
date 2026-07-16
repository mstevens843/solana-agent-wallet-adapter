import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { classifyHeliusTransaction, type HeliusEnhancedTransaction } from './heliusEventClassifier.js';
import type { PushNotificationService } from './pushNotificationService.js';
import type { PushStore } from './pushTypes.js';

/**
 * Inbound Helius webhook receiver: POST /api/webhooks/helius
 *
 * Sessionless by necessity — Helius has no wallet session. Auth is the `authHeader` we set when
 * creating the webhook, which Helius echoes on every delivery; it is compared in constant time.
 *
 * The fan-out is deliberately DB-driven rather than payload-driven: for each delivered tx we ask our
 * own push_devices which wallets opted in, and classify per wallet. A payload can therefore never
 * name a wallet into receiving a notification — the only wallets that can be notified are ones that
 * registered a device with us.
 *
 * Non-2xx makes Helius retry, so we only 5xx on genuinely transient failures; a malformed body is a
 * permanent 400 that should never be retried.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024; // enhanced payloads batch up to 100 txs

export interface HeliusWebhookHandlerOptions {
  store: PushStore;
  pushService: PushNotificationService;
  /** Expected value of the Authorization header. When unset the route is disabled (503). */
  authHeader?: string;
  onError?: (message: string, err: unknown) => void;
}

export function createHeliusWebhookHandler(options: HeliusWebhookHandlerOptions) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    if (!options.authHeader) {
      json(res, 503, { error: 'webhook_not_configured' });
      return true;
    }
    const provided = headerValue(req, 'authorization');
    if (!provided || !safeEqual(provided, options.authHeader)) {
      // 401, not 500: Helius must not retry an auth failure.
      json(res, 401, { error: 'unauthorized' });
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      json(res, 400, { error: 'invalid_json', detail: err instanceof Error ? err.message : 'unreadable body' });
      return true;
    }

    const transactions = normalizeTransactions(payload);
    if (!transactions.length) {
      json(res, 200, { ok: true, enqueued: 0, transactions: 0 });
      return true;
    }

    try {
      const wallets = await options.store.listPushWallets();
      const enqueued = await enqueueForWallets(transactions, wallets, options.pushService);
      json(res, 200, { ok: true, enqueued, transactions: transactions.length });
    } catch (err) {
      // Transient (DB down mid-batch). 500 asks Helius to redeliver; the dedupe index makes the
      // replay safe, so anything already enqueued won't double-buzz.
      options.onError?.('helius_webhook_enqueue_failed', err);
      json(res, 500, { error: 'enqueue_failed' });
    }
    return true;
  };
}

async function enqueueForWallets(
  transactions: HeliusEnhancedTransaction[],
  wallets: string[],
  pushService: PushNotificationService,
): Promise<number> {
  if (!wallets.length) return 0;
  let enqueued = 0;
  for (const tx of transactions) {
    for (const wallet of wallets) {
      const event = classifyHeliusTransaction(tx, wallet);
      if (!event) continue;
      const record = await pushService.enqueue({
        walletAddress: wallet,
        type: event.type,
        dedupeKey: event.dedupeKey,
        title: event.title,
        body: event.body,
        data: event.data,
      });
      if (record) enqueued += 1;
    }
  }
  return enqueued;
}

/** Helius posts an array of enhanced txs; tolerate a single object or a {transactions:[…]} wrapper. */
export function normalizeTransactions(payload: unknown): HeliusEnhancedTransaction[] {
  if (Array.isArray(payload)) return payload as HeliusEnhancedTransaction[];
  if (payload && typeof payload === 'object') {
    const wrapped = (payload as { transactions?: unknown }).transactions;
    if (Array.isArray(wrapped)) return wrapped as HeliusEnhancedTransaction[];
    if ((payload as { signature?: unknown }).signature) return [payload as HeliusEnhancedTransaction];
  }
  return [];
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak length — compare lengths
  // first and always run the constant-time compare on equal-length buffers.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('Webhook payload too large.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}
