import { generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';

import type { ApprovalRequestRecord, TransactionFinalizationRecord } from '@solana-agent-wallet-adapter/workflow';
import { describe, expect, it } from 'vitest';

import { encodeBase58 } from '../cloud/auth.js';
import '../cloud/mppRoutes.js';
import { listDevApiHandlers } from '../cloud/devApiRegistry.js';
import { MemoryEvidenceStore } from '../cloud/evidenceService.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import type { Clock } from '../cloud/store.js';
import { WorkflowService } from '../cloud/workflowService.js';

const RECIPIENT = 'BvgrFr5Bcaa9NudH3DCxgMnHV1FT1nzD5JtMHsmpKnFB';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = new Date('2026-05-16T12:00:00.000Z');

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

interface TestWallet {
  walletAddress: string;
  privateKey: KeyObject;
}

describe('MPP API', () => {
  it('creates MPP approvals and rejects rails excluded by wallet config', async () => {
    await withMppServer(async ({ port, workflowStore, wallet }) => {
      await workflowStore.savePreference(wallet.walletAddress, {
        namespace: 'mpp-config' as never,
        version: 1,
        updatedAt: NOW.toISOString(),
        payload: { acceptedRails: ['usdc'], maxChallengeAmount: '10' },
      });

      const sol = await postJson(port, '/api/mpp/challenge', { challenge: solChallenge() });
      expect(sol.status).toBe(400);
      expect(sol.body.error).toBe('mpp_error:unsupported_rail');

      const usdc = await postJson(port, '/api/mpp/challenge', { challenge: splChallenge() });
      expect(usdc.status).toBe(201);
      expect(usdc.body.approvalId).toEqual(expect.any(String));
      expect(usdc.body.challengeHash).toMatch(/^[a-f0-9]{64}$/);

      const approval = await workflowStore.getApproval(wallet.walletAddress, String(usdc.body.approvalId));
      expect(approval?.metadata?.connectorId).toBe('mpp');
      expect(approval?.summary).toContain('via MPP');
    });
  });

  it('settles with txid evidence first and adds wallet-signed evidence idempotently', async () => {
    await withMppServer(async ({ port, workflowStore, evidenceStore, wallet }) => {
      const created = await postJson(port, '/api/mpp/challenge', { challenge: splChallenge() });
      expect(created.status).toBe(201);
      const approvalId = String(created.body.approvalId);
      const approval = await workflowStore.getApproval(wallet.walletAddress, approvalId);
      expect(approval).toBeTruthy();
      await saveConfirmedFinalization(workflowStore, wallet.walletAddress, approval!, 'tx_mpp_fixture');

      const txOnly = await postJson(port, '/api/mpp/settle', { approvalId, txid: 'tx_mpp_fixture' });
      expect(txOnly.status).toBe(201);
      expect(txOnly.body.receiptHash).toMatch(/^[a-f0-9]{64}$/);
      expect(txOnly.body.signedEvidence).toMatchObject({
        status: 'available',
        preSignatureHash: txOnly.body.receiptHash,
      });

      const signedOffer = txOnly.body.signedEvidence as Record<string, unknown>;
      const signingMessage = String(signedOffer.signingMessage);
      const signed = await postJson(port, '/api/mpp/settle', {
        approvalId,
        txid: 'tx_mpp_fixture',
        signedEvidence: {
          signingMessage,
          signature: signMessage(signingMessage, wallet.privateKey),
          signatureEncoding: 'base58',
        },
      });
      expect(signed.status).toBe(200);
      expect(signed.body.idempotent).toBe(true);
      expect(signed.body.signedEvidence).toMatchObject({
        status: 'created',
        preSignatureHash: txOnly.body.receiptHash,
      });

      const evidence = await evidenceStore.listEvidence(wallet.walletAddress);
      expect(evidence.map((record) => record.kind)).toEqual(['mpp_session', 'mpp_session']);
      expect(evidence.some((record) => record.receiptType === 'mpp/payment/0.1' && record.verified)).toBe(true);
      const updated = await workflowStore.getApproval(wallet.walletAddress, approvalId);
      expect(updated?.metadata?.mppSignedEvidenceReceiptId).toEqual(expect.any(String));
    });
  });
});

async function withMppServer(callback: (ctx: {
  port: number;
  workflowStore: MemoryWorkflowStore;
  evidenceStore: MemoryEvidenceStore;
  wallet: TestWallet;
}) => Promise<void>): Promise<void> {
  const wallet = createTestWallet();
  const workflowStore = new MemoryWorkflowStore();
  const evidenceStore = new MemoryEvidenceStore();
  const workflowService = new WorkflowService(workflowStore);
  const clock: Clock = { now: () => NOW };
  const handler = listDevApiHandlers().find((candidate) => candidate.prefix === '/api/mpp/');
  if (!handler) throw new Error('MPP handler was not registered.');
  const server = createServer((req, res) => {
    void (async () => {
      const handled = await handler.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), {
        walletAddress: wallet.walletAddress,
        workflowService,
        workflowStore,
        evidenceStore,
        clock,
      });
      if (!handled) {
        res.statusCode = 404;
        res.end('{}');
      }
    })().catch((err) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });
  const port = await listen(server);
  try {
    await callback({ port, workflowStore, evidenceStore, wallet });
  } finally {
    await close(server);
  }
}

function splChallenge(): Record<string, unknown> {
  return {
    protocolVersion: 'mpp/0.1',
    nonce: 'mpp_nonce_spl',
    amount: '2.50',
    currency: 'USDC',
    resourceUrl: 'https://merchant.example/resource/123',
    expiresAt: '2026-05-16T13:00:00.000Z',
    paymentMethods: [
      { kind: 'solana-spl', mint: USDC_MINT, recipient: RECIPIENT, network: 'devnet' },
    ],
    merchant: { id: 'merchant_1', name: 'Acme' },
  };
}

function solChallenge(): Record<string, unknown> {
  return {
    ...splChallenge(),
    nonce: 'mpp_nonce_sol',
    amount: '0.01',
    currency: 'SOL',
    paymentMethods: [
      { kind: 'solana-sol', recipient: RECIPIENT, network: 'devnet' },
    ],
  };
}

async function saveConfirmedFinalization(
  workflowStore: MemoryWorkflowStore,
  walletAddress: string,
  approval: ApprovalRequestRecord,
  txid: string,
): Promise<void> {
  const now = NOW.toISOString();
  const finalization: TransactionFinalizationRecord = {
    id: 'finalization_mpp_fixture',
    walletAddress,
    approvalRequestId: approval.id,
    kind: approval.kind,
    status: 'confirmed',
    cluster: approval.cluster ?? 'devnet',
    walletAction: {
      kind: approval.kind,
      walletAddress,
      cluster: approval.cluster ?? 'devnet',
      summary: approval.summary,
      recipient: approval.recipient,
      amount: approval.amount,
      token: approval.token,
      instructionSummary: [],
      touchedPrograms: [],
    },
    transactionHash: 'hash_mpp_fixture',
    txid,
    txStatus: 'confirmed',
    createdAt: now,
    updatedAt: now,
    expiresAt: '2026-05-16T14:00:00.000Z',
    confirmedAt: now,
  };
  await workflowStore.saveFinalization(walletAddress, finalization);
}

function createTestWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBytes = Buffer.from(publicKeyDer).subarray(-32);
  return { walletAddress: encodeBase58(publicKeyBytes), privateKey };
}

function signMessage(message: string, privateKey: KeyObject): string {
  return encodeBase58(signDetached(null, Buffer.from(message, 'utf8'), privateKey));
}

async function postJson(port: number, path: string, body: unknown): Promise<TestResponse> {
  return requestJson(port, 'POST', path, body);
}

async function requestJson(port: number, method: string, path: string, body?: unknown): Promise<TestResponse> {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : undefined,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          body: text ? JSON.parse(text) as Record<string, unknown> : {},
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address.');
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}
