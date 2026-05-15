import { createServer, request as httpRequest, type IncomingMessage, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ApprovalRequestRecord,
  EvidenceReceiptRecord,
  TransactionFinalizationRecord,
} from '@solana-agent-wallet-adapter/workflow';

import type { DevApiHandler, DevApiHandlerContext } from '../cloud/devApiRegistry.js';
import { MemoryEvidenceStore } from '../cloud/evidenceService.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import type { Clock } from '../cloud/store.js';
import { WorkflowService } from '../cloud/workflowService.js';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const OTHER_WALLET = 'So11111111111111111111111111111111111111112';
const MERCHANT_RECIPIENT = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

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

interface AcpTestServer {
  port: number;
  workflowStore: MemoryWorkflowStore;
  evidenceStore: MemoryEvidenceStore;
  workflowService: WorkflowService;
  clock: Clock;
}

async function loadFreshAcpRoutes(): Promise<{
  handlers: readonly DevApiHandler[];
  gate: DevGateModule;
}> {
  vi.resetModules();
  const registry = (await import('../cloud/devApiRegistry.js')) as RegistryModule;
  registry.clearDevApiHandlersForTesting();
  await import('../cloud/acpRoutes.js');
  const gate = (await import('../cloud/devGate.js')) as DevGateModule;
  return { handlers: registry.listDevApiHandlers(), gate };
}

async function withAcpServer(
  env: EnvSnapshot,
  callback: (server: AcpTestServer) => Promise<void>,
): Promise<void> {
  setEnv(env);
  const { handlers, gate } = await loadFreshAcpRoutes();
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

function rawRequest(
  port: number,
  method: string,
  path: string,
  body: unknown,
  walletHeader?: string,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
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
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let parsedBody: Record<string, unknown> | null = null;
          if (rawBody.length > 0) {
            try {
              parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
            } catch {
              parsedBody = null;
            }
          }
          resolve({
            status: res.statusCode ?? 0,
            body: parsedBody,
            rawBody,
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

function sampleCart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cart_test_001',
    cartVersion: '1',
    merchant: {
      id: 'merchant_acme',
      name: 'Acme Inc.',
      recipient: MERCHANT_RECIPIENT,
    },
    lineItems: [
      { id: 'li_1', name: 'Pro Plan', quantity: 1, unitAmount: '19.99', currency: 'USD' },
    ],
    totalAmount: '19.99',
    currency: 'USD',
    paymentToken: 'USDC',
    cluster: 'mainnet-beta',
    expiresAt: '2099-01-01T00:00:00.000Z',
    memo: 'Order #ACP-1',
    ...overrides,
  };
}

async function injectConfirmedFinalization(
  workflowStore: MemoryWorkflowStore,
  approval: ApprovalRequestRecord,
  txid: string,
): Promise<TransactionFinalizationRecord> {
  const finalization: TransactionFinalizationRecord = {
    id: `finalization_${approval.id}`,
    walletAddress: approval.walletAddress,
    approvalRequestId: approval.id,
    kind: approval.kind,
    status: 'confirmed',
    cluster: 'mainnet-beta',
    walletAction: {
      kind: approval.kind,
      walletAddress: approval.walletAddress,
      cluster: 'mainnet-beta',
      summary: approval.summary,
      instructionSummary: [],
      touchedPrograms: [],
    },
    transactionHash: `tx-hash-${approval.id}`,
    txid,
    txStatus: 'confirmed',
    createdAt: '2026-05-14T11:30:00.000Z',
    updatedAt: '2026-05-14T11:35:00.000Z',
    expiresAt: '2026-05-14T14:00:00.000Z',
    confirmedAt: '2026-05-14T11:35:00.000Z',
  };
  await workflowStore.saveFinalization(approval.walletAddress, finalization);
  return finalization;
}

const DEFAULT_ENV: EnvSnapshot = {
  AGENTIC_DEV_AP2_ACP: '1',
  AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
};

describe('cloud ACP cart API', () => {
  let original: EnvSnapshot;

  beforeEach(() => {
    original = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(original);
  });

  describe('dev gate', () => {
    it('returns 403 without a wallet header', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(port, '/api/acp/cart/preview', { cart: sampleCart() });
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'dev_layer1_disabled' });
      });
    });

    it('returns 403 when wallet is not in the allowlist', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(port, '/api/acp/cart/preview', { cart: sampleCart() }, OTHER_WALLET);
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'dev_layer1_disabled' });
      });
    });

    it('returns 403 when AGENTIC_DEV_AP2_ACP is not set', async () => {
      await withAcpServer(
        { ...DEFAULT_ENV, AGENTIC_DEV_AP2_ACP: undefined },
        async ({ port }) => {
          const response = await postJson(port, '/api/acp/cart/preview', { cart: sampleCart() }, DEV_WALLET);
          expect(response.status).toBe(403);
          expect(response.body).toEqual({ error: 'dev_layer1_disabled' });
        },
      );
    });
  });

  describe('POST /api/acp/cart/preview', () => {
    it('parses an object-form cart and returns a preview', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(port, '/api/acp/cart/preview', { cart: sampleCart() }, DEV_WALLET);
        expect(response.status).toBe(200);
        const preview = response.body?.preview as Record<string, unknown>;
        expect(preview).toBeTruthy();
        expect((preview.cart as Record<string, unknown>).id).toBe('cart_test_001');
        expect(preview.transfer).toMatchObject({
          token: 'USDC',
          recipient: MERCHANT_RECIPIENT,
          amount: '19.99',
        });
        expect(preview.totalFiat).toBe(19.99);
        expect(preview.resolvedTokenMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      });
    });

    it('returns native SOL amount in previews for SOL carts', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(port, '/api/acp/cart/preview', {
          cart: sampleCart({
            paymentToken: 'SOL',
            paymentAmount: '0.10',
            totalAmount: '20.00',
            lineItems: [{ id: 'li_1', name: 'SOL checkout', quantity: 1, unitAmount: '20.00', currency: 'USD' }],
          }),
        }, DEV_WALLET);
        expect(response.status).toBe(200);
        const preview = response.body?.preview as Record<string, unknown>;
        expect(preview.transfer).toMatchObject({
          token: 'SOL',
          recipient: MERCHANT_RECIPIENT,
          amount: '0.10',
        });
        expect(preview.totalFiat).toBe(20);
        expect(preview.resolvedTokenMint).toBe('SOL');
      });
    });

    it('accepts a JSON-string-form cart', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/acp/cart/preview',
          { cart: JSON.stringify(sampleCart()) },
          DEV_WALLET,
        );
        expect(response.status).toBe(200);
        const preview = response.body?.preview as Record<string, unknown>;
        expect((preview.cart as Record<string, unknown>).id).toBe('cart_test_001');
      });
    });

    it("normalizes the legacy 'mainnet' cluster alias to 'mainnet-beta'", async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/acp/cart/preview',
          { cart: sampleCart({ cluster: 'mainnet' }) },
          DEV_WALLET,
        );
        expect(response.status).toBe(200);
        const preview = response.body?.preview as Record<string, unknown>;
        expect((preview.cart as Record<string, unknown>).cluster).toBe('mainnet-beta');
      });
    });

    it('returns 400 with invalid_acp_cart:invalid_json for malformed cart strings', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/acp/cart/preview',
          { cart: '{not json' },
          DEV_WALLET,
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_acp_cart:invalid_json');
        expect(response.body?.message).toBeTruthy();
      });
    });

    it('returns 400 when the cart fails sanity validation (off-curve recipient)', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const badCart = sampleCart({
          merchant: { id: 'm', name: 'X', recipient: 'definitely-not-base58' },
        });
        const response = await postJson(port, '/api/acp/cart/preview', { cart: badCart }, DEV_WALLET);
        expect(response.status).toBe(400);
        expect(String(response.body?.error)).toContain('validation_error');
      });
    });

    it('rejects forbidden secret-shaped fields in the cart', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const sneaky = sampleCart({ privateKey: 'leaked' });
        const response = await postJson(port, '/api/acp/cart/preview', { cart: sneaky }, DEV_WALLET);
        expect(response.status).toBe(400);
      });
    });

    it('writes an acp.cart.previewed audit event with actor=user', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const response = await postJson(port, '/api/acp/cart/preview', { cart: sampleCart() }, DEV_WALLET);
        expect(response.status).toBe(200);
        const events = await workflowStore.forWallet(DEV_WALLET).listAuditEvents();
        const previewEvents = events.filter((event) => event.type === 'acp.cart.previewed');
        expect(previewEvents.length).toBe(1);
        expect(previewEvents[0]?.metadata).toMatchObject({
          cartId: 'cart_test_001',
          paymentToken: 'USDC',
          cluster: 'mainnet-beta',
          actor: 'user',
        });
      });
    });
  });

  describe('POST /api/acp/cart/approve', () => {
    it('materializes a transfer_spl approval with ACP metadata', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const response = await postJson(
          port,
          '/api/acp/cart/approve',
          { cart: sampleCart(), note: 'pay now' },
          DEV_WALLET,
        );
        expect(response.status).toBe(201);
        const approval = response.body?.approval as ApprovalRequestRecord;
        expect(approval).toBeTruthy();
        expect(approval.kind).toBe('transfer_spl');
        expect(approval.amount).toBe('19.99');
        expect(approval.token).toBe('USDC');
        expect(approval.recipient).toBe(MERCHANT_RECIPIENT);
        expect(approval.cluster).toBe('mainnet-beta');
        expect(approval.metadata?.source).toBe('acp_outbound');
        expect(approval.metadata?.actionSource).toBe('acp_outbound');
        expect(approval.metadata?.acpCartId).toBe('cart_test_001');
        expect(approval.metadata?.acpCartHash).toEqual(expect.any(String));
        expect(approval.metadata?.acpCart).toMatchObject({ id: 'cart_test_001' });

        // Guardrail-friendly params: top-level recipient/token/amount.
        const params = approval.params as Record<string, unknown>;
        expect(params.recipient).toBe(MERCHANT_RECIPIENT);
        expect(params.token).toBe('USDC');
        expect(params.amount).toBe('19.99');
        expect(params.tokenMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        expect(params.action).toBeUndefined();

        const stored = await workflowStore.getApproval(DEV_WALLET, approval.id);
        expect(stored?.kind).toBe('transfer_spl');
        expect(response.body?.cartId).toBe('cart_test_001');
        expect(response.body?.approvalId).toBe(approval.id);
        expect(response.body?.cartHash).toEqual(expect.any(String));
      });
    });

    it('materializes a transfer_sol approval for SOL ACP payments', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const response = await postJson(
          port,
          '/api/acp/cart/approve',
          {
            cart: sampleCart({
              paymentToken: 'SOL',
              paymentAmount: '0.10',
              totalAmount: '20.00',
              lineItems: [{ id: 'li_1', name: 'SOL checkout', quantity: 1, unitAmount: '20.00', currency: 'USD' }],
            }),
          },
          DEV_WALLET,
        );
        expect(response.status).toBe(201);
        const approval = response.body?.approval as ApprovalRequestRecord;
        expect(approval.kind).toBe('transfer_sol');
        expect(approval.amount).toBe('0.10');
        expect(approval.token).toBe('SOL');
        expect(approval.metadata?.paymentAmount).toBe('0.10');
        expect(approval.metadata?.totalAmount).toBe('20.00');
        expect(approval.metadata?.resolvedTokenMint).toBe('SOL');
        const params = approval.params as Record<string, unknown>;
        expect(params.recipient).toBe(MERCHANT_RECIPIENT);
        expect(params.amountSol).toBe('0.10');
        expect(params.token).toBeUndefined();
        expect(params.tokenMint).toBeUndefined();

        const stored = await workflowStore.getApproval(DEV_WALLET, approval.id);
        expect(stored?.kind).toBe('transfer_sol');
      });
    });

    it('writes an acp.cart.approved audit event with actor=user referencing the approval', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const response = await postJson(port, '/api/acp/cart/approve', { cart: sampleCart() }, DEV_WALLET);
        expect(response.status).toBe(201);
        const approval = response.body?.approval as ApprovalRequestRecord;
        const events = await workflowStore.forWallet(DEV_WALLET).listAuditEvents();
        const approvedEvents = events.filter((event) => event.type === 'acp.cart.approved');
        expect(approvedEvents.length).toBe(1);
        expect(approvedEvents[0]?.metadata).toMatchObject({
          approvalId: approval.id,
          cartId: 'cart_test_001',
          actor: 'user',
        });
      });
    });

    it('rejects approval requests when the cart fails validation', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const badCart = sampleCart({
          totalAmount: '999.99',
          lineItems: [{ id: 'li_1', name: 'X', quantity: 1, unitAmount: '5.00', currency: 'USD' }],
        });
        const response = await postJson(port, '/api/acp/cart/approve', { cart: badCart }, DEV_WALLET);
        expect(response.status).toBe(400);
        expect(String(response.body?.error)).toContain('validation_error');
      });
    });
  });

  describe('POST /api/acp/cart/:id/receipt', () => {
    it('returns 409 not_finalized when no confirmed finalization exists', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const approveResponse = await postJson(port, '/api/acp/cart/approve', { cart: sampleCart() }, DEV_WALLET);
        const approval = approveResponse.body?.approval as ApprovalRequestRecord;
        const response = await postJson(
          port,
          `/api/acp/cart/${approval.id}/receipt`,
          {},
          DEV_WALLET,
        );
        expect(response.status).toBe(409);
        expect(response.body?.error).toBe('not_finalized');
        expect(response.body?.message).toBeTruthy();
      });
    });

    it('persists an evidence receipt after a confirmed finalization is recorded', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, evidenceStore, workflowStore }) => {
        const approveResponse = await postJson(port, '/api/acp/cart/approve', { cart: sampleCart() }, DEV_WALLET);
        expect(approveResponse.status).toBe(201);
        const approval = approveResponse.body?.approval as ApprovalRequestRecord;

        const txid = 'tx_signature_demo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        await injectConfirmedFinalization(workflowStore, approval, txid);

        const receiptResponse = await postJson(
          port,
          `/api/acp/cart/${approval.id}/receipt`,
          {},
          DEV_WALLET,
        );
        expect(receiptResponse.status).toBe(201);

        const record = receiptResponse.body?.receipt as EvidenceReceiptRecord;
        expect(record.kind).toBe('acp_outbound');
        expect(record.status).toBe('approved');
        expect(record.walletAddress).toBe(DEV_WALLET);
        expect(record.signature).toBe(txid);
        expect(record.verified).toBe(true);
        expect((record.payload as Record<string, unknown>).receiptVersion).toBe('1');
        expect((record.payload as Record<string, unknown>).schema).toBe('acp/outbound/0.1');
        expect(record.metadata?.approvalId).toBe(approval.id);
        expect(record.metadata?.cartId).toBe('cart_test_001');

        const stored = await evidenceStore.getEvidence(DEV_WALLET, record.id);
        expect(stored?.kind).toBe('acp_outbound');
        expect(receiptResponse.body?.approvalId).toBe(approval.id);
      });
    });

    it("extracts txid from the finalization, ignoring any client-supplied txid", async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const approveResponse = await postJson(port, '/api/acp/cart/approve', { cart: sampleCart() }, DEV_WALLET);
        const approval = approveResponse.body?.approval as ApprovalRequestRecord;
        await injectConfirmedFinalization(workflowStore, approval, 'TXFROMFINALIZATION');

        const receiptResponse = await postJson(
          port,
          `/api/acp/cart/${approval.id}/receipt`,
          { txid: 'TXFROMCLIENT' },
          DEV_WALLET,
        );
        expect(receiptResponse.status).toBe(201);
        const record = receiptResponse.body?.receipt as EvidenceReceiptRecord;
        expect(record.signature).toBe('TXFROMFINALIZATION');
        const acp = receiptResponse.body?.acp as Record<string, unknown>;
        expect(acp.txid).toBe('TXFROMFINALIZATION');
      });
    });

    it('persists the receipt onto approval.metadata.acpOutboundReceipt', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const approveResponse = await postJson(port, '/api/acp/cart/approve', { cart: sampleCart() }, DEV_WALLET);
        const approval = approveResponse.body?.approval as ApprovalRequestRecord;
        await injectConfirmedFinalization(workflowStore, approval, 'TXAPPMETA');

        const receiptResponse = await postJson(
          port,
          `/api/acp/cart/${approval.id}/receipt`,
          {},
          DEV_WALLET,
        );
        expect(receiptResponse.status).toBe(201);

        const refreshed = await workflowStore.getApproval(DEV_WALLET, approval.id);
        const receiptOnApproval = refreshed?.metadata?.acpOutboundReceipt as Record<string, unknown> | undefined;
        expect(receiptOnApproval).toBeTruthy();
        expect(receiptOnApproval?.cartId).toBe('cart_test_001');
        expect(receiptOnApproval?.txid).toBe('TXAPPMETA');
        expect(refreshed?.metadata?.acpOutboundReceiptIssuedAt).toEqual(expect.any(String));
        expect(refreshed?.metadata?.acpEvidenceReceiptId).toEqual(expect.stringMatching(/^evidence_acp_/));
      });
    });

    it('returns 409 cart_hash_mismatch when the stored hash does not match the cart payload', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const approveResponse = await postJson(port, '/api/acp/cart/approve', { cart: sampleCart() }, DEV_WALLET);
        const approval = approveResponse.body?.approval as ApprovalRequestRecord;
        await injectConfirmedFinalization(workflowStore, approval, 'TXHASHCHECK');

        const tampered: ApprovalRequestRecord = {
          ...approval,
          metadata: {
            ...(approval.metadata ?? {}),
            acpCartHash: 'definitely-wrong-hash',
          },
        };
        await workflowStore.saveApproval(DEV_WALLET, tampered);

        const response = await postJson(
          port,
          `/api/acp/cart/${approval.id}/receipt`,
          {},
          DEV_WALLET,
        );
        expect(response.status).toBe(409);
        expect(response.body?.error).toBe('cart_hash_mismatch');
        expect(response.body?.message).toBeTruthy();
      });
    });

    it('returns 404 when the approvalId does not exist', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/acp/cart/approval_does_not_exist/receipt',
          {},
          DEV_WALLET,
        );
        expect(response.status).toBe(404);
        expect(response.body?.error).toBe('approval_not_found');
        expect(response.body?.message).toBeTruthy();
      });
    });

    it('returns 409 when the approval is not an ACP outbound approval', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, workflowService }) => {
        const session = { walletAddress: DEV_WALLET };
        const approval = await workflowService.createApproval(session, {
          kind: 'transfer_sol',
          summary: 'Plain SOL transfer',
          params: { recipient: MERCHANT_RECIPIENT, amountSol: '0.1' },
          cluster: 'mainnet-beta',
          amount: '0.1',
          token: 'SOL',
          recipient: MERCHANT_RECIPIENT,
        });
        const response = await postJson(
          port,
          `/api/acp/cart/${approval.id}/receipt`,
          {},
          DEV_WALLET,
        );
        expect(response.status).toBe(409);
        expect(response.body?.error).toBe('not_an_acp_approval');
        expect(response.body?.message).toBeTruthy();
      });
    });

    it('returns 400 when settledAt is provided in an invalid format', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const approveResponse = await postJson(port, '/api/acp/cart/approve', { cart: sampleCart() }, DEV_WALLET);
        const approval = approveResponse.body?.approval as ApprovalRequestRecord;
        await injectConfirmedFinalization(workflowStore, approval, 'TXBADTS');
        const response = await postJson(
          port,
          `/api/acp/cart/${approval.id}/receipt`,
          { settledAt: 'not-a-timestamp' },
          DEV_WALLET,
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_timestamp');
      });
    });

    it('writes an acp.receipt.created audit event in the evidence store', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, evidenceStore, workflowStore }) => {
        const approveResponse = await postJson(port, '/api/acp/cart/approve', { cart: sampleCart() }, DEV_WALLET);
        const approval = approveResponse.body?.approval as ApprovalRequestRecord;
        await injectConfirmedFinalization(workflowStore, approval, 'tx_audit_demo');

        const receiptResponse = await postJson(
          port,
          `/api/acp/cart/${approval.id}/receipt`,
          {},
          DEV_WALLET,
        );
        expect(receiptResponse.status).toBe(201);
        const events = evidenceStore.snapshotAuditEvents();
        const created = events.filter((event) => event.type === 'acp.receipt.created');
        expect(created.length).toBe(1);
        expect(created[0]?.metadata).toMatchObject({
          approvalId: approval.id,
          cartId: 'cart_test_001',
          txid: 'tx_audit_demo',
        });
      });
    });

    it('writes an acp.receipt.created audit event with actor=server on the workflow store', async () => {
      await withAcpServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        const approveResponse = await postJson(port, '/api/acp/cart/approve', { cart: sampleCart() }, DEV_WALLET);
        const approval = approveResponse.body?.approval as ApprovalRequestRecord;
        await injectConfirmedFinalization(workflowStore, approval, 'tx_server_actor');

        const receiptResponse = await postJson(
          port,
          `/api/acp/cart/${approval.id}/receipt`,
          {},
          DEV_WALLET,
        );
        expect(receiptResponse.status).toBe(201);
        const events = await workflowStore.forWallet(DEV_WALLET).listAuditEvents();
        const created = events.filter((event) => event.type === 'acp.receipt.created');
        expect(created.length).toBe(1);
        expect(created[0]?.metadata).toMatchObject({
          actor: 'server',
          approvalId: approval.id,
          cartId: 'cart_test_001',
          txid: 'tx_server_actor',
        });
      });
    });
  });
});
