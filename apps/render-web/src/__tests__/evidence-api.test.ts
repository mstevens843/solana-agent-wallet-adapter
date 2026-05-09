import { generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Server } from 'node:http';

import { describe, expect, it } from 'vitest';

import { createEvidenceApiHandler } from '../cloud/evidenceRoutes.js';
import {
  EvidenceService,
  MemoryEvidenceStore,
  type EvidenceReceiptRecord,
} from '../cloud/evidenceService.js';
import { encodeBase58 } from '../cloud/auth.js';
import type { WorkflowSession } from '../cloud/workflowValidation.js';

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

interface TestWallet {
  walletAddress: string;
  privateKey: KeyObject;
}

const testWalletA = createTestWallet();
const testWalletB = createTestWallet();
const walletA = testWalletA.walletAddress;
const walletB = testWalletB.walletAddress;

describe('cloud evidence receipt API', () => {
  it('rejects evidence requests without a wallet session', async () => {
    await withEvidenceServer(async ({ port }) => {
      const response = await postJson(port, '/api/evidence', sampleReceiptBody(), null);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'unauthorized' });
    });
  });

  it('creates, lists, and deletes signed-in evidence receipts', async () => {
    await withEvidenceServer(async ({ port }) => {
      const created = await postJson(port, '/api/evidence', sampleReceiptBody(), walletA);
      expect(created.status).toBe(201);
      const receipt = created.body.receipt as EvidenceReceiptRecord;

      expect(receipt.id).toMatch(/^evidence_/);
      expect(receipt.walletAddress).toBe(walletA);
      expect(receipt.kind).toBe('intent_receipt');
      expect(receipt.status).toBe('approved');
      expect(receipt.signature).toEqual(expect.any(String));
      expect(receipt.verified).toBe(true);
      expect(receipt.signingMessage).toContain('Evidence receipt: Intent Receipt');

      const listed = await getJson(port, '/api/evidence', walletA);
      expect(listed.status).toBe(200);
      const ids = (listed.body.receipts as EvidenceReceiptRecord[]).map((entry) => entry.id);
      expect(ids).toEqual([receipt.id]);

      const deleted = await deleteJson(port, `/api/evidence/${receipt.id}`, walletA);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ ok: true });

      const afterDelete = await getJson(port, '/api/evidence', walletA);
      expect(afterDelete.body.receipts).toEqual([]);
    });
  });

  it('scopes evidence receipts to the signed-in wallet', async () => {
    await withEvidenceServer(async ({ port }) => {
      const created = await postJson(port, '/api/evidence', sampleReceiptBody(), walletA);
      const receipt = created.body.receipt as EvidenceReceiptRecord;

      const otherList = await getJson(port, '/api/evidence', walletB);
      expect(otherList.body.receipts).toEqual([]);

      const otherDelete = await deleteJson(port, `/api/evidence/${receipt.id}`, walletB);
      expect(otherDelete.status).toBe(404);

      const ownerList = await getJson(port, '/api/evidence', walletA);
      expect((ownerList.body.receipts as EvidenceReceiptRecord[]).length).toBe(1);
    });
  });

  it('rejects malformed evidence ids as validation errors', async () => {
    await withEvidenceServer(async ({ port }) => {
      const response = await deleteJson(port, '/api/evidence/%E0%A4%A', walletA);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_id');
    });
  });

  it('archives all five public receipt kinds', async () => {
    const kinds = [
      'intent_receipt',
      'policy_receipt',
      'risk_review_receipt',
      'rejection_receipt',
      'tool_trace_receipt',
    ] as const;

    await withEvidenceServer(async ({ port }) => {
      for (const kind of kinds) {
        const response = await postJson(port, '/api/evidence', sampleReceiptBody({ kind }), walletA);
        expect(response.status).toBe(201);
        expect((response.body.receipt as EvidenceReceiptRecord).kind).toBe(kind);
      }
      const listed = await getJson(port, '/api/evidence', walletA);
      const stored = (listed.body.receipts as EvidenceReceiptRecord[]).map((entry) => entry.kind).sort();
      expect(stored).toEqual([...kinds].sort());
    });
  });

  it('rejects unknown receipt kinds and statuses', async () => {
    await withEvidenceServer(async ({ port }) => {
      const badKind = await postJson(port, '/api/evidence', sampleReceiptBody({ kind: 'totally_made_up' }), walletA);
      expect(badKind.status).toBe(400);
      expect(badKind.body.error).toBe('invalid_kind');

      const badStatus = await postJson(port, '/api/evidence', sampleReceiptBody({ status: 'unknown' }), walletA);
      expect(badStatus.status).toBe(400);
      expect(badStatus.body.error).toBe('invalid_status');
    });
  });

  it('rejects private keys, delegated signers, and unlimited approval authority', async () => {
    await withEvidenceServer(async ({ port }) => {
      const privateKey = await postJson(port, '/api/evidence', { ...sampleReceiptBody(), privateKey: 'not-allowed' }, walletA);
      const delegated = await postJson(port, '/api/evidence', {
        ...sampleReceiptBody(),
        payload: { ...samplePayload(), delegatedSigner: 'server-wallet' },
      }, walletA);
      const unlimited = await postJson(port, '/api/evidence', {
        ...sampleReceiptBody(),
        metadata: { approvalAuthority: 'unlimited' },
      }, walletA);

      expect(privateKey.status).toBe(400);
      expect(delegated.status).toBe(400);
      expect(unlimited.status).toBe(400);
    });
  });

  it('rejects requests missing required signing fields', async () => {
    await withEvidenceServer(async ({ port }) => {
      const noSignature = await postJson(port, '/api/evidence', { ...sampleReceiptBody(), signature: '' }, walletA);
      expect(noSignature.status).toBe(400);
      expect(noSignature.body.error).toBe('missing_field');

      const noTitle = await postJson(port, '/api/evidence', { ...sampleReceiptBody(), title: '   ' }, walletA);
      expect(noTitle.status).toBe(400);
      expect(noTitle.body.error).toBe('missing_field');
    });
  });

  it('rejects evidence receipts signed by a different wallet', async () => {
    await withEvidenceServer(async ({ port }) => {
      const body = sampleReceiptBody();
      body.signature = signMessage(String(body.signingMessage), testWalletB.privateKey);

      const response = await postJson(port, '/api/evidence', body, walletA);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_signature');
    });
  });

  it('records audit events with evidence record type and matching record id', async () => {
    await withEvidenceServer(async ({ port, store }) => {
      const created = await postJson(port, '/api/evidence', sampleReceiptBody(), walletA);
      const receipt = created.body.receipt as EvidenceReceiptRecord;
      await deleteJson(port, `/api/evidence/${receipt.id}`, walletA);
      const events = store.snapshotAuditEvents();
      expect(events.map((event) => event.type)).toEqual(['evidence.created', 'evidence.deleted']);
      for (const event of events) {
        expect(event.recordType).toBe('evidence');
        expect(event.recordId).toBe(receipt.id);
        expect(event.walletAddress).toBe(walletA);
      }
      expect(events[0]?.metadata).toEqual({ kind: receipt.kind, status: receipt.status });
      expect(events[1]?.metadata).toEqual({ kind: receipt.kind });
    });
  });

  it('rejects unknown clusters', async () => {
    await withEvidenceServer(async ({ port }) => {
      const response = await postJson(
        port,
        '/api/evidence',
        sampleReceiptBody({ cluster: 'mainnet-fake' }),
        walletA,
      );
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_cluster');
    });
  });

  it('rejects requests missing the cluster', async () => {
    await withEvidenceServer(async ({ port }) => {
      const body = sampleReceiptBody();
      delete body.cluster;
      const response = await postJson(port, '/api/evidence', body, walletA);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('missing_field');
    });
  });

  it('rejects malformed JSON request bodies', async () => {
    await withEvidenceServer(async ({ port }) => {
      const response = await rawRequest(port, 'POST', '/api/evidence', 'not-json', walletA);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_json');
    });
  });

  it('rejects request bodies that exceed the size limit', async () => {
    await withEvidenceServer(async ({ port }) => {
      const huge = 'x'.repeat(300_000);
      const body = sampleReceiptBody({ payload: { ...samplePayload(), bulky: huge } });
      const response = await postJson(port, '/api/evidence', body, walletA);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('body_too_large');
    });
  });

  it('preserves metadata across create and list', async () => {
    await withEvidenceServer(async ({ port }) => {
      const metadata = { labId: 'intent-receipt', browserArtifactId: 'browser_abc' };
      const created = await postJson(port, '/api/evidence', sampleReceiptBody({ metadata }), walletA);
      expect(created.status).toBe(201);
      expect((created.body.receipt as EvidenceReceiptRecord).metadata).toEqual(metadata);

      const listed = await getJson(port, '/api/evidence', walletA);
      const [first] = listed.body.receipts as EvidenceReceiptRecord[];
      expect(first?.metadata).toEqual(metadata);
    });
  });

  it('lists receipts newest updatedAt first', async () => {
    await withOrderedEvidenceServer(async ({ port }) => {
      await postJson(port, '/api/evidence', sampleReceiptBody({ title: 'First' }), walletA);
      await postJson(port, '/api/evidence', sampleReceiptBody({ title: 'Second' }), walletA);
      await postJson(port, '/api/evidence', sampleReceiptBody({ title: 'Third' }), walletA);

      const listed = await getJson(port, '/api/evidence', walletA);
      const titles = (listed.body.receipts as EvidenceReceiptRecord[]).map((entry) => entry.title);
      expect(titles).toEqual(['Third', 'Second', 'First']);
    });
  });
});

function sampleReceiptBody(overrides: Record<string, unknown> = {}, wallet: TestWallet = testWalletA): Record<string, unknown> {
  const preSignatureHash = typeof overrides.preSignatureHash === 'string'
    ? overrides.preSignatureHash
    : '0x' + 'a'.repeat(64);
  const title = typeof overrides.title === 'string' ? overrides.title : 'Intent Receipt';
  const cluster = typeof overrides.cluster === 'string' ? overrides.cluster : 'mainnet-beta';
  const signingMessage = typeof overrides.signingMessage === 'string'
    ? overrides.signingMessage
    : [
      'Solana Agent Wallet Adapter',
      `Evidence receipt: ${title}`,
      'Receipt: int_demo',
      'Wallet: ' + wallet.walletAddress,
      `Cluster: ${cluster}`,
      `Hash: ${preSignatureHash}`,
    ].join('\n');
  const body: Record<string, unknown> = {
    title: 'Intent Receipt',
    kind: 'intent_receipt',
    status: 'approved',
    cluster: 'mainnet-beta',
    payload: samplePayload(),
    preSignatureHash,
    signingMessage,
    signature: signMessage(signingMessage, wallet.privateKey),
    artifactHash: '0x' + 'b'.repeat(64),
    receiptType: 'intent_receipt_v1',
    summary: 'Intent receipt summary.',
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'signature')) {
    body.signature = signMessage(String(body.signingMessage), wallet.privateKey);
  }
  return body;
}

function samplePayload(): Record<string, unknown> {
  return {
    status: 'approved',
    thesis: 'Send 0.05 SOL with caps before any wallet signature.',
    nextSignatureGate: 'Wallet must approve the swap.',
    metrics: [{ label: 'Slippage', value: '50 bps', tone: 'good' }],
    evidence: [{ title: 'Constraints', detail: 'Max 0.05 SOL', tone: 'good', hash: 'h1' }],
    receiptType: 'intent_receipt_v1',
  };
}

function createTestWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBytes = Buffer.from(publicKeyDer).subarray(-32);
  return {
    walletAddress: encodeBase58(publicKeyBytes),
    privateKey,
  };
}

function signMessage(message: string, privateKey: KeyObject): string {
  return encodeBase58(signDetached(null, Buffer.from(message, 'utf8'), privateKey));
}

async function withEvidenceServer(
  callback: (server: { port: number; store: MemoryEvidenceStore }) => Promise<void>,
): Promise<void> {
  await runEvidenceServer({ store: new MemoryEvidenceStore() }, callback);
}

async function withOrderedEvidenceServer(
  callback: (server: { port: number; store: MemoryEvidenceStore }) => Promise<void>,
): Promise<void> {
  const store = new MemoryEvidenceStore();
  let tick = 0;
  const service = new EvidenceService(store, {
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)),
  });
  await runEvidenceServer({ store, service }, callback);
}

interface RunEvidenceServerOptions {
  store: MemoryEvidenceStore;
  service?: EvidenceService;
}

async function runEvidenceServer(
  options: RunEvidenceServerOptions,
  callback: (server: { port: number; store: MemoryEvidenceStore }) => Promise<void>,
): Promise<void> {
  const handler = createEvidenceApiHandler({
    store: options.service ? undefined : options.store,
    service: options.service,
    getSession(req): WorkflowSession | null {
      const wallet = req.headers['x-test-wallet'];
      return typeof wallet === 'string' && wallet ? { walletAddress: wallet } : null;
    },
  });
  const server = createServer((req, res) => {
    void handler(req, res).then(
      (handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end('not found');
        }
      },
      (err: unknown) => {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : 'error');
      },
    );
  });

  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback({ port: address.port, store: options.store });
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

function postJson(port: number, path: string, body: unknown, walletAddress: string | null = walletA): Promise<TestResponse> {
  return jsonRequest(port, 'POST', path, body, walletAddress);
}

function getJson(port: number, path: string, walletAddress: string | null = walletA): Promise<TestResponse> {
  return jsonRequest(port, 'GET', path, undefined, walletAddress);
}

function deleteJson(port: number, path: string, walletAddress: string | null = walletA): Promise<TestResponse> {
  return jsonRequest(port, 'DELETE', path, undefined, walletAddress);
}

function jsonRequest(
  port: number,
  method: string,
  path: string,
  body: unknown,
  walletAddress: string | null,
): Promise<TestResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return rawRequestWithPayload(port, method, path, payload, walletAddress, true);
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  payload: string,
  walletAddress: string | null = walletA,
): Promise<TestResponse> {
  return rawRequestWithPayload(port, method, path, payload, walletAddress, true);
}

function rawRequestWithPayload(
  port: number,
  method: string,
  path: string,
  payload: string | undefined,
  walletAddress: string | null,
  jsonContentType: boolean,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (payload !== undefined) {
      if (jsonContentType) headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (walletAddress) headers['x-test-wallet'] = walletAddress;

    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
