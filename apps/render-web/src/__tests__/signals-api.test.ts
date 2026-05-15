import { createServer, request as httpRequest, type IncomingMessage, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DevApiHandler, DevApiHandlerContext } from '../cloud/devApiRegistry.js';
import { MemoryEvidenceStore } from '../cloud/evidenceService.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import type {
  Clock,
  SignalFeedStoreRecord,
} from '../cloud/store.js';
import { WorkflowService } from '../cloud/workflowService.js';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const OTHER_DEV_WALLET = '6h9Q2X7nZ3LbY4VkPmRaJsdxhQ2X7nZ3LbY4VkPmRaJs';
const NON_DEV_WALLET = 'So11111111111111111111111111111111111111112';

const ENV_KEYS = [
  'AGENTIC_DEV_AP2_ACP',
  'AGENTIC_DEV_WALLET_ALLOWLIST',
] as const;

type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

interface TestResponse {
  status: number;
  body: Record<string, unknown> | null;
  rawBody: string;
  headers: IncomingHttpHeaders;
}

interface DevGateModule {
  isAllowedDevWallet: (walletAddress: string | undefined | null) => boolean;
  devLayer1Enabled: () => boolean;
}

interface RegistryModule {
  listDevApiHandlers: () => readonly DevApiHandler[];
  clearDevApiHandlersForTesting: () => void;
}

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const key of ENV_KEYS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snap[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setEnv(env: EnvSnapshot): void {
  for (const [key, value] of Object.entries(env) as Array<[(typeof ENV_KEYS)[number], string | undefined]>) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

interface SignalsTestServer {
  port: number;
  workflowStore: MemoryWorkflowStore;
  evidenceStore: MemoryEvidenceStore;
  workflowService: WorkflowService;
  clock: Clock;
}

async function loadFreshSignalsRoutes(): Promise<{
  handlers: readonly DevApiHandler[];
  gate: DevGateModule;
}> {
  vi.resetModules();
  const registry = (await import('../cloud/devApiRegistry.js')) as RegistryModule;
  registry.clearDevApiHandlersForTesting();
  await import('../cloud/signalsRoutes.js');
  const gate = (await import('../cloud/devGate.js')) as DevGateModule;
  return { handlers: registry.listDevApiHandlers(), gate };
}

async function withSignalsServer(
  env: EnvSnapshot,
  callback: (server: SignalsTestServer) => Promise<void>,
): Promise<void> {
  setEnv(env);
  const { handlers, gate } = await loadFreshSignalsRoutes();
  const workflowStore = new MemoryWorkflowStore();
  const evidenceStore = new MemoryEvidenceStore();
  const fixedNow = new Date('2026-05-14T12:00:00.000Z');
  const clock: Clock = { now: () => fixedNow };
  const workflowService = new WorkflowService(workflowStore, { clock: () => fixedNow });

  const server = createServer((req, res) => {
    void dispatch(req, res, {
      handlers,
      gate,
      workflowStore,
      evidenceStore,
      workflowService,
      clock,
    });
  });
  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback({
      port: address.port,
      workflowStore,
      evidenceStore,
      workflowService,
      clock,
    });
  } finally {
    await close(server);
  }
}

interface DispatchDeps {
  handlers: readonly DevApiHandler[];
  gate: DevGateModule;
  workflowStore: MemoryWorkflowStore;
  evidenceStore: MemoryEvidenceStore;
  workflowService: WorkflowService;
  clock: Clock;
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DispatchDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';
  const handler = deps.handlers.find(
    (h) => url.pathname.startsWith(h.prefix) && h.methods.includes(method),
  );
  if (!handler) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  let walletAddress: string | undefined;
  if (!handler.publicRoute) {
    if (!deps.gate.devLayer1Enabled()) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'dev_layer1_disabled' }));
      return;
    }
    const headerWallet = req.headers['x-test-wallet'];
    walletAddress = typeof headerWallet === 'string' ? headerWallet : undefined;
    if (!deps.gate.isAllowedDevWallet(walletAddress)) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'dev_layer1_disabled' }));
      return;
    }
  }
  const context: DevApiHandlerContext = {
    walletAddress,
    workflowService: deps.workflowService,
    workflowStore: deps.workflowStore,
    evidenceStore: deps.evidenceStore,
    clock: deps.clock,
  };
  try {
    await handler.handle(req, res, url, context);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'internal_error', message: err instanceof Error ? err.message : 'unknown' }));
    }
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  walletHeader?: string,
): Promise<TestResponse> {
  return rawRequest(port, 'POST', path, body, walletHeader);
}

function getJson(
  port: number,
  path: string,
  walletHeader?: string,
): Promise<TestResponse> {
  return rawRequest(port, 'GET', path, undefined, walletHeader);
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  body: unknown,
  walletHeader?: string,
  rawBodyOverride?: string,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const raw = rawBodyOverride !== undefined
      ? rawBodyOverride
      : body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(raw).toString(),
    };
    if (walletHeader !== undefined) {
      headers['x-test-wallet'] = walletHeader;
    }
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('error', reject);
        res.on('end', () => {
          const rawResponse = Buffer.concat(chunks).toString('utf8');
          let parsedBody: Record<string, unknown> | null = null;
          if (rawResponse.length > 0) {
            try {
              parsedBody = JSON.parse(rawResponse) as Record<string, unknown>;
            } catch {
              parsedBody = null;
            }
          }
          resolve({
            status: res.statusCode ?? 0,
            body: parsedBody,
            rawBody: rawResponse,
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (raw.length > 0) req.write(raw);
    req.end();
  });
}

function postRaw(
  port: number,
  path: string,
  rawBody: string,
  walletHeader?: string,
): Promise<TestResponse> {
  return rawRequest(port, 'POST', path, undefined, walletHeader, rawBody);
}

function sampleCaps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    perRunMaxAmount: '50',
    lifetimeMaxAmount: '1000',
    allowlistedTokens: ['USDC'],
    ...overrides,
  };
}

async function seedFeed(
  workflowStore: MemoryWorkflowStore,
  publisherWallet: string,
  overrides: Partial<SignalFeedStoreRecord> = {},
): Promise<SignalFeedStoreRecord> {
  const id = overrides.id ?? `feed_seeded_${Math.random().toString(36).slice(2, 10)}`;
  const nowIso = '2026-05-14T11:00:00.000Z';
  const record: SignalFeedStoreRecord = {
    id,
    publisherWallet,
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? nowIso,
    updatedAt: overrides.updatedAt ?? nowIso,
    feed: {
      id,
      publisherWallet,
      name: 'Seeded',
      description: 'For testing',
      createdAt: nowIso,
      updatedAt: nowIso,
      status: overrides.status ?? 'active',
    },
  };
  await workflowStore.saveSignalFeed(record);
  return record;
}

const DEFAULT_ENV: EnvSnapshot = {
  AGENTIC_DEV_AP2_ACP: '1',
  AGENTIC_DEV_WALLET_ALLOWLIST: `${DEV_WALLET},${OTHER_DEV_WALLET}`,
};

const VALID_TXID = '5'.repeat(64);

describe('cloud Signals API', () => {
  let original: EnvSnapshot;

  beforeEach(() => {
    original = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(original);
  });

  describe('dev gate', () => {
    it('returns 403 without a wallet header', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(port, '/api/signals/feeds', { name: 'x', description: 'y' });
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'dev_layer1_disabled' });
      });
    });

    it('returns 403 when wallet is not in the allowlist', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/signals/feeds',
          { name: 'x', description: 'y' },
          NON_DEV_WALLET,
        );
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'dev_layer1_disabled' });
      });
    });

    it('returns 403 when AGENTIC_DEV_AP2_ACP is not set', async () => {
      await withSignalsServer(
        { ...DEFAULT_ENV, AGENTIC_DEV_AP2_ACP: undefined },
        async ({ port }) => {
          const response = await postJson(
            port,
            '/api/signals/feeds',
            { name: 'x', description: 'y' },
            DEV_WALLET,
          );
          expect(response.status).toBe(403);
          expect(response.body).toEqual({ error: 'dev_layer1_disabled' });
        },
      );
    });
  });

  describe('POST /api/signals/feeds', () => {
    it('creates a feed owned by the connected wallet', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const response = await postJson(
          port,
          '/api/signals/feeds',
          { name: 'My Calls', description: 'Daily long ideas' },
          DEV_WALLET,
        );
        expect(response.status).toBe(201);
        const feed = response.body?.feed as Record<string, unknown>;
        expect(feed.publisherWallet).toBe(DEV_WALLET);
        expect(feed.name).toBe('My Calls');
        expect(feed.description).toBe('Daily long ideas');
        expect(feed.status).toBe('active');
        expect(String(feed.id)).toMatch(/^feed_/);

        const stored = await workflowStore.getSignalFeed(String(feed.id));
        expect(stored?.publisherWallet).toBe(DEV_WALLET);
      });
    });

    it('writes a signals.feed.created audit event with actor=user', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const response = await postJson(
          port,
          '/api/signals/feeds',
          { name: 'My Calls', description: 'desc' },
          DEV_WALLET,
        );
        expect(response.status).toBe(201);
        const events = await workflowStore.forWallet(DEV_WALLET).listAuditEvents();
        const createdEvents = events.filter((e) => e.type === 'signals.feed.created');
        expect(createdEvents.length).toBe(1);
        expect(createdEvents[0]?.metadata).toMatchObject({
          publisherWallet: DEV_WALLET,
          name: 'My Calls',
          actor: 'user',
        });
      });
    });

    it('rejects forbidden secret-shaped fields anywhere in the body', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/signals/feeds',
          { name: 'x', description: 'y', metadata: { delegatedSigner: 'evil' } },
          DEV_WALLET,
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('forbidden_authority_field');
      });
    });

    it('rejects an empty name', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/signals/feeds',
          { name: '', description: 'y' },
          DEV_WALLET,
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_feed_name');
      });
    });

    it('rejects a non-string description', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/signals/feeds',
          { name: 'x', description: 42 },
          DEV_WALLET,
        );
        expect(response.status).toBe(400);
      });
    });
  });

  describe('GET /api/signals/feeds', () => {
    it('returns feeds owned by the connected wallet by default', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedFeed(workflowStore, DEV_WALLET, { id: 'feed_mine_1' });
        await seedFeed(workflowStore, DEV_WALLET, { id: 'feed_mine_2' });
        await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: 'feed_theirs' });

        const response = await getJson(port, '/api/signals/feeds', DEV_WALLET);
        expect(response.status).toBe(200);
        const feeds = response.body?.feeds as Array<Record<string, unknown>>;
        expect(feeds.map((f) => f.id).sort()).toEqual(['feed_mine_1', 'feed_mine_2']);
      });
    });

    it('returns another publisher\'s feeds when ?publisher= is provided', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: 'feed_other_1' });
        const response = await getJson(
          port,
          `/api/signals/feeds?publisher=${OTHER_DEV_WALLET}`,
          DEV_WALLET,
        );
        expect(response.status).toBe(200);
        const feeds = response.body?.feeds as Array<Record<string, unknown>>;
        expect(feeds.map((f) => f.id)).toEqual(['feed_other_1']);
      });
    });
  });

  describe('GET /api/signals/feeds/:id', () => {
    it('returns 200 + feed body when found', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const seeded = await seedFeed(workflowStore, DEV_WALLET, { id: 'feed_get_1' });
        const response = await getJson(port, `/api/signals/feeds/${seeded.id}`, DEV_WALLET);
        expect(response.status).toBe(200);
        const feed = response.body?.feed as Record<string, unknown>;
        expect(feed.id).toBe('feed_get_1');
        expect(feed.publisherWallet).toBe(DEV_WALLET);
      });
    });

    it('returns 404 feed_not_found when missing', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port }) => {
        const response = await getJson(port, '/api/signals/feeds/feed_nope', DEV_WALLET);
        expect(response.status).toBe(404);
        expect(response.body?.error).toBe('feed_not_found');
      });
    });
  });

  describe('POST /api/signals/feeds/:id/emissions', () => {
    it('queues an emission with delivered=0 when called by the feed owner', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const feed = await seedFeed(workflowStore, DEV_WALLET, { id: 'feed_emit_1' });
        const response = await postJson(
          port,
          `/api/signals/feeds/${feed.id}/emissions`,
          { sourceTxid: VALID_TXID, actionTemplate: { kind: 'swap', amount: '10' } },
          DEV_WALLET,
        );
        expect(response.status).toBe(201);
        const emission = response.body?.emission as Record<string, unknown>;
        expect(emission.feedId).toBe('feed_emit_1');
        expect(emission.publisherWallet).toBe(DEV_WALLET);
        expect(emission.sourceTxid).toBe(VALID_TXID);
        expect(emission.delivered).toBe(0);
        expect(emission.actionTemplate).toMatchObject({ kind: 'swap', amount: '10' });

        const undelivered = await workflowStore.listUndeliveredSignalEmissions();
        expect(undelivered.length).toBe(1);
        expect(undelivered[0]?.delivered).toBe(0);
      });
    });

    it('returns 403 not_feed_owner when caller is not the publisher', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const feed = await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: 'feed_emit_403' });
        const response = await postJson(
          port,
          `/api/signals/feeds/${feed.id}/emissions`,
          { sourceTxid: VALID_TXID, actionTemplate: {} },
          DEV_WALLET,
        );
        expect(response.status).toBe(403);
        expect(response.body?.error).toBe('not_feed_owner');
      });
    });

    it('returns 404 when the feed does not exist', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/signals/feeds/feed_missing/emissions',
          { sourceTxid: VALID_TXID, actionTemplate: {} },
          DEV_WALLET,
        );
        expect(response.status).toBe(404);
        expect(response.body?.error).toBe('feed_not_found');
      });
    });

    it('returns 409 feed_not_active for non-active feeds', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const feed = await seedFeed(workflowStore, DEV_WALLET, {
          id: 'feed_paused',
          status: 'paused',
        });
        const response = await postJson(
          port,
          `/api/signals/feeds/${feed.id}/emissions`,
          { sourceTxid: VALID_TXID, actionTemplate: {} },
          DEV_WALLET,
        );
        expect(response.status).toBe(409);
        expect(response.body?.error).toBe('feed_not_active');
      });
    });

    it('returns 400 when sourceTxid is too short', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const feed = await seedFeed(workflowStore, DEV_WALLET, { id: 'feed_bad_txid' });
        const response = await postJson(
          port,
          `/api/signals/feeds/${feed.id}/emissions`,
          { sourceTxid: 'too-short', actionTemplate: {} },
          DEV_WALLET,
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_source_txid');
      });
    });

    it('returns 400 when actionTemplate is not a JSON object', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const feed = await seedFeed(workflowStore, DEV_WALLET, { id: 'feed_bad_action' });
        const response = await postJson(
          port,
          `/api/signals/feeds/${feed.id}/emissions`,
          { sourceTxid: VALID_TXID, actionTemplate: null },
          DEV_WALLET,
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_object');
      });
    });

    it('writes a signals.emission.created audit event', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const feed = await seedFeed(workflowStore, DEV_WALLET, { id: 'feed_emit_audit' });
        const response = await postJson(
          port,
          `/api/signals/feeds/${feed.id}/emissions`,
          { sourceTxid: VALID_TXID, actionTemplate: {} },
          DEV_WALLET,
        );
        expect(response.status).toBe(201);
        const emission = response.body?.emission as Record<string, unknown>;
        const events = await workflowStore.forWallet(DEV_WALLET).listAuditEvents();
        const created = events.filter((e) => e.type === 'signals.emission.created');
        expect(created.length).toBe(1);
        expect(created[0]?.metadata).toMatchObject({
          emissionId: emission.id,
          feedId: 'feed_emit_audit',
          sourceTxid: VALID_TXID,
        });
      });
    });
  });

  describe('POST /api/signals/subscriptions', () => {
    it('creates a subscription owned by the follower', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: 'feed_sub_1' });
        const response = await postJson(
          port,
          '/api/signals/subscriptions',
          { feedId: 'feed_sub_1', caps: sampleCaps() },
          DEV_WALLET,
        );
        expect(response.status).toBe(201);
        const sub = response.body?.subscription as Record<string, unknown>;
        expect(sub.feedId).toBe('feed_sub_1');
        expect(sub.followerWallet).toBe(DEV_WALLET);
        expect(sub.status).toBe('active');
        const subs = await workflowStore.listSignalSubscriptionsForFollower(DEV_WALLET);
        expect(subs.length).toBe(1);
      });
    });

    it('returns 404 when the feed does not exist', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/signals/subscriptions',
          { feedId: 'feed_nope', caps: sampleCaps() },
          DEV_WALLET,
        );
        expect(response.status).toBe(404);
        expect(response.body?.error).toBe('feed_not_found');
      });
    });

    it('returns 400 invalid_caps when allowlistedTokens is empty', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: 'feed_bad_caps' });
        const response = await postJson(
          port,
          '/api/signals/subscriptions',
          { feedId: 'feed_bad_caps', caps: sampleCaps({ allowlistedTokens: [] }) },
          DEV_WALLET,
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_caps');
      });
    });

    it('returns 400 invalid_caps when perRunMaxAmount is not a decimal string', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: 'feed_bad_caps_2' });
        const response = await postJson(
          port,
          '/api/signals/subscriptions',
          { feedId: 'feed_bad_caps_2', caps: sampleCaps({ perRunMaxAmount: 'not-a-number' }) },
          DEV_WALLET,
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_caps');
      });
    });

    it('returns 409 subscription_exists on a duplicate non-revoked subscription', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: 'feed_dup' });
        const first = await postJson(
          port,
          '/api/signals/subscriptions',
          { feedId: 'feed_dup', caps: sampleCaps() },
          DEV_WALLET,
        );
        expect(first.status).toBe(201);
        const firstSub = first.body?.subscription as Record<string, unknown>;
        const second = await postJson(
          port,
          '/api/signals/subscriptions',
          { feedId: 'feed_dup', caps: sampleCaps() },
          DEV_WALLET,
        );
        expect(second.status).toBe(409);
        expect(second.body?.error).toBe('subscription_exists');
        expect(second.body?.existingId).toBe(firstSub.id);
      });
    });

    it('allows a fresh subscription after the prior one is revoked', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: 'feed_resubscribe' });
        const first = await postJson(
          port,
          '/api/signals/subscriptions',
          { feedId: 'feed_resubscribe', caps: sampleCaps({ perRunMaxAmount: '10' }) },
          DEV_WALLET,
        );
        expect(first.status).toBe(201);
        const firstSub = first.body?.subscription as Record<string, unknown>;

        const revoked = await postJson(
          port,
          `/api/signals/subscriptions/${String(firstSub.id)}/revoke`,
          {},
          DEV_WALLET,
        );
        expect(revoked.status).toBe(200);

        const second = await postJson(
          port,
          '/api/signals/subscriptions',
          { feedId: 'feed_resubscribe', caps: sampleCaps({ perRunMaxAmount: '25' }) },
          DEV_WALLET,
        );
        expect(second.status).toBe(201);
        const secondSub = second.body?.subscription as Record<string, unknown>;
        expect(secondSub.id).not.toBe(firstSub.id);
        expect(secondSub.caps).toMatchObject({ perRunMaxAmount: '25' });
      });
    });

    it('rejects forbidden secret-shaped fields in the caps', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: 'feed_caps_secret' });
        const response = await postJson(
          port,
          '/api/signals/subscriptions',
          {
            feedId: 'feed_caps_secret',
            caps: { ...sampleCaps(), delegatedSigner: 'evil' },
          },
          DEV_WALLET,
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('forbidden_authority_field');
      });
    });
  });

  describe('GET /api/signals/subscriptions', () => {
    it('returns only the connected wallet\'s subscriptions', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: 'feed_list_a' });
        await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: 'feed_list_b' });
        await postJson(
          port,
          '/api/signals/subscriptions',
          { feedId: 'feed_list_a', caps: sampleCaps() },
          DEV_WALLET,
        );
        await postJson(
          port,
          '/api/signals/subscriptions',
          { feedId: 'feed_list_b', caps: sampleCaps() },
          OTHER_DEV_WALLET,
        );

        const response = await getJson(port, '/api/signals/subscriptions', DEV_WALLET);
        expect(response.status).toBe(200);
        const subs = response.body?.subscriptions as Array<Record<string, unknown>>;
        expect(subs.length).toBe(1);
        expect(subs[0]?.feedId).toBe('feed_list_a');
      });
    });
  });

  describe('POST /api/signals/subscriptions/:id/{pause,resume,revoke}', () => {
    async function createSubscription(
      port: number,
      workflowStore: MemoryWorkflowStore,
      follower: string,
      feedId = 'feed_tx',
    ): Promise<string> {
      await seedFeed(workflowStore, OTHER_DEV_WALLET, { id: feedId });
      const created = await postJson(
        port,
        '/api/signals/subscriptions',
        { feedId, caps: sampleCaps() },
        follower,
      );
      expect(created.status).toBe(201);
      const sub = created.body?.subscription as Record<string, unknown>;
      return String(sub.id);
    }

    it('pause transitions active → paused', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const id = await createSubscription(port, workflowStore, DEV_WALLET);
        const response = await postJson(port, `/api/signals/subscriptions/${id}/pause`, {}, DEV_WALLET);
        expect(response.status).toBe(200);
        const sub = response.body?.subscription as Record<string, unknown>;
        expect(sub.status).toBe('paused');

        const events = await workflowStore.forWallet(DEV_WALLET).listAuditEvents();
        const paused = events.filter((e) => e.type === 'signals.subscription.paused');
        expect(paused.length).toBe(1);
        expect(paused[0]?.metadata).toMatchObject({
          subscriptionId: id,
          previousStatus: 'active',
          nextStatus: 'paused',
        });
      });
    });

    it('resume transitions paused → active', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const id = await createSubscription(port, workflowStore, DEV_WALLET);
        await postJson(port, `/api/signals/subscriptions/${id}/pause`, {}, DEV_WALLET);
        const response = await postJson(port, `/api/signals/subscriptions/${id}/resume`, {}, DEV_WALLET);
        expect(response.status).toBe(200);
        const sub = response.body?.subscription as Record<string, unknown>;
        expect(sub.status).toBe('active');
      });
    });

    it('resume on an active subscription returns 409 invalid_state_transition', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const id = await createSubscription(port, workflowStore, DEV_WALLET);
        const response = await postJson(port, `/api/signals/subscriptions/${id}/resume`, {}, DEV_WALLET);
        expect(response.status).toBe(409);
        expect(response.body?.error).toBe('invalid_state_transition');
      });
    });

    it('revoke is terminal — subsequent pause returns 409', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const id = await createSubscription(port, workflowStore, DEV_WALLET);
        const revoked = await postJson(port, `/api/signals/subscriptions/${id}/revoke`, {}, DEV_WALLET);
        expect(revoked.status).toBe(200);
        expect((revoked.body?.subscription as Record<string, unknown>).status).toBe('revoked');
        const pauseAttempt = await postJson(port, `/api/signals/subscriptions/${id}/pause`, {}, DEV_WALLET);
        expect(pauseAttempt.status).toBe(409);
      });
    });

    it('revoke is idempotent', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const id = await createSubscription(port, workflowStore, DEV_WALLET);
        await postJson(port, `/api/signals/subscriptions/${id}/revoke`, {}, DEV_WALLET);
        const events1 = (await workflowStore.forWallet(DEV_WALLET).listAuditEvents())
          .filter((e) => e.type === 'signals.subscription.revoked');
        expect(events1.length).toBe(1);

        const second = await postJson(port, `/api/signals/subscriptions/${id}/revoke`, {}, DEV_WALLET);
        expect(second.status).toBe(200);
        const events2 = (await workflowStore.forWallet(DEV_WALLET).listAuditEvents())
          .filter((e) => e.type === 'signals.subscription.revoked');
        expect(events2.length).toBe(1);
      });
    });

    it('returns 404 for an unknown subscription id', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(port, '/api/signals/subscriptions/sub_nope/pause', {}, DEV_WALLET);
        expect(response.status).toBe(404);
        expect(response.body?.error).toBe('subscription_not_found');
      });
    });

    it('returns 404 when another wallet tries to transition someone else\'s subscription', async () => {
      // Leak-free behavior: the caller can't prove a peer's subscription exists.
      await withSignalsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const id = await createSubscription(port, workflowStore, DEV_WALLET, 'feed_peer');
        const response = await postJson(
          port,
          `/api/signals/subscriptions/${id}/pause`,
          {},
          OTHER_DEV_WALLET,
        );
        expect(response.status).toBe(404);
        expect(response.body?.error).toBe('subscription_not_found');
      });
    });
  });

  describe('body parsing', () => {
    it('returns 400 invalid_json for malformed bodies', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postRaw(port, '/api/signals/feeds', '{ broken', DEV_WALLET);
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_json');
      });
    });

    it('returns 413 body_too_large for oversized payloads', async () => {
      await withSignalsServer(DEFAULT_ENV, async ({ port }) => {
        const big = '{"name":"' + 'a'.repeat(70_000) + '","description":"y"}';
        const response = await postRaw(port, '/api/signals/feeds', big, DEV_WALLET);
        expect(response.status).toBe(413);
        expect(response.body?.error).toBe('body_too_large');
      });
    });
  });
});
