import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DevApiHandler, DevApiHandlerContext } from '../cloud/devApiRegistry.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import type { AggregatorSnapshotStoreRecord } from '../cloud/store.js';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const NON_DEV_WALLET = '7VdH9KZsd4n4cZcUMthxq5J3PoF7nqLwT9C3W6PYTKfA';

const ENV_KEYS = ['AGENTIC_DEV_WALLET_ALLOWLIST'] as const;

type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

interface TestResponse {
  status: number;
  body: Record<string, unknown> | null;
  rawBody: string;
  headers: IncomingHttpHeaders;
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

interface RegistryModule {
  listDevApiHandlers: () => readonly DevApiHandler[];
  clearDevApiHandlersForTesting: () => void;
}

async function loadFreshRoutes(): Promise<readonly DevApiHandler[]> {
  vi.resetModules();
  const registry = (await import('../cloud/devApiRegistry.js')) as RegistryModule;
  registry.clearDevApiHandlersForTesting();
  await import('../cloud/aggregatorRoutes.js');
  return registry.listDevApiHandlers();
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: readonly DevApiHandler[],
  workflowStore: unknown,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';
  const handler = handlers.find(
    (h) => url.pathname.startsWith(h.prefix) && h.methods.includes(method),
  );
  if (!handler) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  const context: DevApiHandlerContext = {
    walletAddress: undefined,
    workflowService: {} as DevApiHandlerContext['workflowService'],
    workflowStore: workflowStore as DevApiHandlerContext['workflowStore'],
    evidenceStore: {} as DevApiHandlerContext['evidenceStore'],
    clock: { now: () => new Date() },
  };
  try {
    await handler.handle(req, res, url, context);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'internal_error',
          message: err instanceof Error ? err.message : 'unknown',
        }),
      );
    }
  }
}

async function withRoutes(
  env: EnvSnapshot,
  workflowStore: unknown,
  callback: (port: number) => Promise<void>,
): Promise<void> {
  setEnv(env);
  const handlers = await loadFreshRoutes();
  const server = createServer((req, res) => {
    void dispatch(req, res, handlers, workflowStore);
  });
  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback(address.port);
  } finally {
    await close(server);
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

function request(port: number, path: string, method = 'GET'): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> | null = null;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            body = null;
          }
        }
        resolve({ status: res.statusCode ?? 0, body, rawBody: raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function buildSkillSnapshot(): AggregatorSnapshotStoreRecord {
  return {
    key: 'skill:friday-dca',
    kind: 'skill',
    computedAt: '2026-05-14T12:00:00.000Z',
    snapshot: {
      skillId: 'friday-dca',
      installs: 3,
      totalExecutions: 11,
      successRate: 10 / 11,
      lastExecutionAt: '2026-05-13T00:00:00.000Z',
      medianGasUsd: '0.0021',
      computedAt: '2026-05-14T12:00:00.000Z',
    },
  };
}

function buildWalletSnapshot(walletAddress: string): AggregatorSnapshotStoreRecord {
  return {
    key: `wallet:${walletAddress}`,
    kind: 'wallet',
    computedAt: '2026-05-14T12:00:00.000Z',
    snapshot: {
      walletAddress,
      totalSkillsInstalled: 2,
      totalExecutions: 5,
      successRate: 1,
      installedSkillIds: ['friday-dca', 'yield-rotate'],
      totalGasUsd: '0.012',
      totalProfitUsd: '52.5',
      computedAt: '2026-05-14T12:00:00.000Z',
    },
  };
}

describe('aggregator API (GET /api/aggregator/*)', () => {
  let original: EnvSnapshot;

  beforeEach(() => {
    original = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(original);
  });

  describe('GET /api/aggregator/skills/:id', () => {
    it('returns 200 with the snapshot envelope when a snapshot exists', async () => {
      const store = new MemoryWorkflowStore();
      await store.saveAggregatorSnapshot(buildSkillSnapshot());

      await withRoutes({ AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET }, store, async (port) => {
        const response = await request(port, '/api/aggregator/skills/friday-dca');
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('public, max-age=60');
        expect(response.body).toMatchObject({
          kind: 'skill',
          key: 'skill:friday-dca',
          computedAt: '2026-05-14T12:00:00.000Z',
        });
        const snapshot = (response.body as { snapshot: Record<string, unknown> }).snapshot;
        expect(snapshot.skillId).toBe('friday-dca');
        expect(snapshot.installs).toBe(3);
        expect(snapshot.medianGasUsd).toBe('0.0021');
      });
    });

    it('returns 404 snapshot_not_found when no snapshot exists for the id', async () => {
      const store = new MemoryWorkflowStore();
      await withRoutes({ AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET }, store, async (port) => {
        const response = await request(port, '/api/aggregator/skills/missing-skill');
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'snapshot_not_found' });
        expect(response.headers['cache-control']).toBe('no-store');
      });
    });

    it('returns 404 not_found when the path does not match the slug regex', async () => {
      const store = new MemoryWorkflowStore();
      await withRoutes({ AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET }, store, async (port) => {
        const response = await request(port, '/api/aggregator/skills/Bad%20ID');
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'not_found' });
      });
    });

    it('skill stats are publicly readable (no auth required, no x-test-wallet header)', async () => {
      const store = new MemoryWorkflowStore();
      await store.saveAggregatorSnapshot(buildSkillSnapshot());

      await withRoutes({ AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET }, store, async (port) => {
        const response = await request(port, '/api/aggregator/skills/friday-dca');
        expect(response.status).toBe(200);
      });
    });

    it('returns 503 aggregator_unavailable when the store does not implement AggregatorStore', async () => {
      await withRoutes({ AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET }, {}, async (port) => {
        const response = await request(port, '/api/aggregator/skills/friday-dca');
        expect(response.status).toBe(503);
        expect(response.body).toEqual({ error: 'aggregator_unavailable' });
      });
    });
  });

  describe('GET /api/aggregator/wallets/:addr', () => {
    it('returns 200 with the snapshot envelope when the wallet is allowlisted and has a snapshot', async () => {
      const store = new MemoryWorkflowStore();
      await store.saveAggregatorSnapshot(buildWalletSnapshot(DEV_WALLET));

      await withRoutes({ AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET }, store, async (port) => {
        const response = await request(port, `/api/aggregator/wallets/${DEV_WALLET}`);
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('public, max-age=60');
        expect(response.body).toMatchObject({
          kind: 'wallet',
          key: `wallet:${DEV_WALLET}`,
        });
        const snapshot = (response.body as { snapshot: Record<string, unknown> }).snapshot;
        expect(snapshot.walletAddress).toBe(DEV_WALLET);
        expect(snapshot.totalGasUsd).toBe('0.012');
      });
    });

    it('returns wallet stats for any wallet with a snapshot', async () => {
      const store = new MemoryWorkflowStore();
      await store.saveAggregatorSnapshot(buildWalletSnapshot(NON_DEV_WALLET));

      await withRoutes({ AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET }, store, async (port) => {
        const response = await request(port, `/api/aggregator/wallets/${NON_DEV_WALLET}`);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          kind: 'wallet',
          key: `wallet:${NON_DEV_WALLET}`,
        });
      });
    });

    it('returns 404 snapshot_not_found when the wallet is allowlisted but no snapshot exists', async () => {
      const store = new MemoryWorkflowStore();
      await withRoutes({ AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET }, store, async (port) => {
        const response = await request(port, `/api/aggregator/wallets/${DEV_WALLET}`);
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'snapshot_not_found' });
      });
    });
  });

  describe('method gating', () => {
    it('returns 404 for POST requests (handler only accepts GET)', async () => {
      const store = new MemoryWorkflowStore();
      await store.saveAggregatorSnapshot(buildSkillSnapshot());
      await withRoutes({ AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET }, store, async (port) => {
        const response = await request(port, '/api/aggregator/skills/friday-dca', 'POST');
        expect(response.status).toBe(404);
      });
    });
  });
});
