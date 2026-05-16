import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { listDevApiHandlers, type DevApiHandlerContext } from '../cloud/devApiRegistry.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { recurringStoreAdapterForCloudStore } from '../cloud/recurringRoutes.js';
import { StreamingService, streamingStoreFor } from '../cloud/streamingService.js';
import type { ApprovalRequestRecord, RecurringScheduleRecord } from '../cloud/workflowValidation.js';
import '../cloud/spendRoutes.js';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('GET /api/spend/envelopes', () => {
  it('aggregates approvals, recurring schedules, and streaming sessions', async () => {
    const store = new MemoryWorkflowStore();
    await store.saveApproval(DEV_WALLET, approvalRecord());
    await recurringStoreAdapterForCloudStore(store).saveSchedule(DEV_WALLET, recurringSchedule());
    await new StreamingService(streamingStoreFor(store), {
      clock: { now: () => new Date('2026-05-16T18:00:00.000Z') },
      latestBlockhash: async () => '11111111111111111111111111111111',
    }).createSession({
      walletAddress: DEV_WALLET,
      tokenMint: USDC_MINT,
      capAmount: '10',
      expiresAt: '2026-05-16T19:00:00.000Z',
    });

    const response = await withSpendServer(store, (port) => getJson(port, '/api/spend/envelopes?limit=10'));

    expect(response.status).toBe(200);
    const envelopes = response.body.envelopes as Array<{ kind: string }>;
    expect(envelopes.map((envelope) => envelope.kind).sort()).toEqual(['one-time', 'recurring', 'streaming']);
    expect(response.body.counts).toMatchObject({
      all: 3,
      needs_approval: 2,
      active_schedules: 1,
      live_streams: 1,
      settled: 0,
    });
    expect(response.body.pagination).toMatchObject({ limit: 10, total: 3 });
  });

  it('filters needs-approval envelopes and paginates', async () => {
    const store = new MemoryWorkflowStore();
    await store.saveApproval(DEV_WALLET, approvalRecord({ id: 'approval_ready', status: 'ready' }));
    await store.saveApproval(DEV_WALLET, approvalRecord({ id: 'approval_pending', status: 'pending' }));
    await store.saveApproval(DEV_WALLET, approvalRecord({ id: 'approval_done', status: 'approved' }));

    const response = await withSpendServer(store, (port) =>
      getJson(port, '/api/spend/envelopes?filter=needs_approval&limit=1'),
    );

    expect(response.status).toBe(200);
    expect((response.body.envelopes as unknown[])).toHaveLength(1);
    expect(response.body.nextCursor).toBe('1');
    expect(response.body.counts).toMatchObject({
      all: 3,
      needs_approval: 2,
      settled: 1,
    });
    expect(response.body.pagination).toMatchObject({ limit: 1, total: 2, nextCursor: '1' });
  });

  it('rejects invalid query values as client errors', async () => {
    const store = new MemoryWorkflowStore();

    const response = await withSpendServer(store, (port) =>
      getJson(port, '/api/spend/envelopes?filter=unknown'),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'invalid_spend_query' });
  });

  it('reports aggregation failures as server errors', async () => {
    const store = new MemoryWorkflowStore();
    vi.spyOn(store, 'listApprovals').mockRejectedValueOnce(new Error('store down'));

    const response = await withSpendServer(store, (port) => getJson(port, '/api/spend/envelopes'));

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: 'spend_envelopes_unavailable',
      message: 'store down',
    });
  });
});

async function withSpendServer<T>(store: MemoryWorkflowStore, callback: (port: number) => Promise<T>): Promise<T> {
  const handler = listDevApiHandlers().find((candidate) => candidate.prefix === '/api/spend/');
  if (!handler) throw new Error('Spend handler was not registered.');
  const context = {
    walletAddress: DEV_WALLET,
    workflowStore: store,
    clock: { now: () => new Date('2026-05-16T18:00:00.000Z') },
    workflowService: {},
    evidenceStore: {},
  } as unknown as DevApiHandlerContext;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    void handler.handle(req, res, url, context).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    return await callback(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function getJson(port: number, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function approvalRecord(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return {
    id: 'approval_1',
    walletAddress: DEV_WALLET,
    kind: 'transfer_spl',
    status: 'ready',
    summary: 'MPP payment request',
    params: {},
    cluster: 'devnet',
    dueAt: '2026-05-16T19:00:00.000Z',
    createdAt: '2026-05-16T17:00:00.000Z',
    updatedAt: '2026-05-16T17:00:00.000Z',
    amount: '2',
    token: 'USDC',
    metadata: { connectorId: 'mpp' },
    ...overrides,
  };
}

function recurringSchedule(): RecurringScheduleRecord {
  return {
    id: 'recurring_1',
    status: 'active',
    walletAddress: DEV_WALLET,
    cluster: 'devnet',
    token: 'SOL',
    recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
    amount: '0.1',
    cadence: 'interval_days',
    createdAt: '2026-05-16T16:00:00.000Z',
    updatedAt: '2026-05-16T16:00:00.000Z',
    nextDueAt: '2026-05-17T16:00:00.000Z',
  };
}
