import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createHeliusWebhookHandler } from '../cloud/heliusWebhookHandler.js';
import { JUPITER_TRIGGER_PROGRAM_ID } from '../cloud/heliusEventClassifier.js';
import type { PushNotificationService } from '../cloud/pushNotificationService.js';
import type { PushStore } from '../cloud/pushTypes.js';

const WALLET = 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEEPER = 'Keeper11111111111111111111111111111111111111';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SECRET = 'super-secret-auth-header';

const FILL = {
  signature: 'sigFillWebhook',
  type: 'SWAP',
  source: 'JUPITER',
  feePayer: KEEPER,
  tokenTransfers: [
    { fromUserAccount: WALLET, toUserAccount: KEEPER, mint: SOL, tokenAmount: 0.5 },
    { fromUserAccount: KEEPER, toUserAccount: WALLET, mint: USDC, tokenAmount: 92.4 },
  ],
  instructions: [{ programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', innerInstructions: [{ programId: JUPITER_TRIGGER_PROGRAM_ID }] }],
};

interface Harness {
  server: Server;
  url: string;
  enqueued: Array<{ walletAddress: string; type: string; dedupeKey: string; title: string }>;
}

let harness: Harness | undefined;

function start(opts: { wallets?: string[]; authHeader?: string; failStore?: boolean } = {}): Harness {
  const enqueued: Harness['enqueued'] = [];
  const store = {
    async listPushWallets() {
      if (opts.failStore) throw new Error('db is down');
      return opts.wallets ?? [WALLET];
    },
  } as unknown as PushStore;
  const pushService = {
    async enqueue(input: { walletAddress: string; type: string; dedupeKey: string; title: string }) {
      enqueued.push(input);
      return { id: 'rec' } as never;
    },
  } as unknown as PushNotificationService;

  const handler = createHeliusWebhookHandler({
    store,
    pushService,
    ...(opts.authHeader === undefined ? { authHeader: SECRET } : opts.authHeader === '' ? {} : { authHeader: opts.authHeader }),
  });
  const server = createServer((req, res) => void handler(req, res));
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  const h: Harness = { server, url: `http://127.0.0.1:${port}/api/webhooks/helius`, enqueued };
  harness = h;
  return h;
}

afterEach(() => {
  harness?.server.close();
  harness = undefined;
});

async function post(url: string, body: unknown, auth?: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('helius webhook receiver: auth', () => {
  it('rejects a request with no Authorization header', async () => {
    const h = start();
    const res = await post(h.url, [FILL]);
    expect(res.status).toBe(401);
    expect(h.enqueued).toHaveLength(0);
  });

  it('rejects a wrong secret — and does NOT 5xx, so Helius never retries an auth failure', async () => {
    const h = start();
    const res = await post(h.url, [FILL], 'not-the-secret');
    expect(res.status).toBe(401);
    expect(h.enqueued).toHaveLength(0);
  });

  it('rejects a secret that is merely a PREFIX of the real one', async () => {
    const h = start();
    const res = await post(h.url, [FILL], SECRET.slice(0, 10));
    expect(res.status).toBe(401);
  });

  it('is disabled (503) when no secret is configured, rather than open', async () => {
    const h = start({ authHeader: '' });
    const res = await post(h.url, [FILL], 'anything');
    expect(res.status).toBe(503);
    expect(h.enqueued).toHaveLength(0);
  });

  it('accepts the correct secret and enqueues the classified event', async () => {
    const h = start();
    const res = await post(h.url, [FILL], SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, enqueued: 1, transactions: 1 });
    expect(h.enqueued).toEqual([
      expect.objectContaining({ walletAddress: WALLET, type: 'jupiter.trigger.filled', dedupeKey: 'sigFillWebhook' }),
    ]);
  });
});

describe('helius webhook receiver: fan-out is DB-driven, not payload-driven', () => {
  it('notifies ONLY wallets that registered a device — a payload cannot name a stranger in', async () => {
    // The tx credits WALLET, but only STRANGER has opted in. Nothing should be enqueued: otherwise
    // anyone could aim our push at an address that never asked for it.
    const h = start({ wallets: ['STRANGERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'] });
    const res = await post(h.url, [FILL], SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enqueued: 0 });
    expect(h.enqueued).toHaveLength(0);
  });

  it('enqueues nothing when no wallet has a device at all', async () => {
    const h = start({ wallets: [] });
    const res = await post(h.url, [FILL], SECRET);
    expect((await res.json()) as unknown).toMatchObject({ enqueued: 0 });
  });
});

describe('helius webhook receiver: payload shapes + retry semantics', () => {
  it('accepts a bare array, a {transactions:[…]} wrapper, and a single object', async () => {
    for (const body of [[FILL], { transactions: [FILL] }, FILL]) {
      const h = start();
      const res = await post(h.url, body, SECRET);
      expect(await res.json()).toMatchObject({ enqueued: 1 });
      h.server.close();
    }
  });

  it('400s malformed JSON — a permanent error Helius must not retry', async () => {
    const h = start();
    const res = await post(h.url, '{not json', SECRET);
    expect(res.status).toBe(400);
  });

  it('200s an empty batch without enqueuing', async () => {
    const h = start();
    const res = await post(h.url, [], SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enqueued: 0, transactions: 0 });
  });

  it('500s a TRANSIENT store failure so Helius redelivers (dedupe makes the replay safe)', async () => {
    const h = start({ failStore: true });
    const res = await post(h.url, [FILL], SECRET);
    expect(res.status).toBe(500);
  });

  it('405s a GET', async () => {
    const h = start();
    const res = await fetch(h.url, { method: 'GET', headers: { authorization: SECRET } });
    expect(res.status).toBe(405);
  });
});
