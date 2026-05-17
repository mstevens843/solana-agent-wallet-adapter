import { generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';

import type { ApprovalRequestRecord, TransactionFinalizationRecord } from '@solana-agent-wallet-adapter/workflow';
import { describe, expect, it } from 'vitest';

import { encodeBase58 } from '../cloud/auth.js';
import '../cloud/mppRoutes.js';
import { listDevApiHandlers } from '../cloud/devApiRegistry.js';
import { MemoryEvidenceStore } from '../cloud/evidenceService.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { settleStreamingSession } from '../cloud/settlementService.js';
import { StreamingService, streamingStoreFor } from '../cloud/streamingService.js';
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

  it('pays eligible MPP challenges with an active streaming session voucher', async () => {
    await withMppServer(async ({ port, workflowStore, evidenceStore, wallet }) => {
      const streaming = new StreamingService(streamingStoreFor(workflowStore), {
        clock: { now: () => NOW },
        latestBlockhash: async () => '11111111111111111111111111111111',
      });
      const grant = await streaming.createSession({
        walletAddress: wallet.walletAddress,
        tokenMint: USDC_MINT,
        capAmount: '5',
        expiresAt: '2026-05-16T14:00:00.000Z',
        recipientAllowlist: [RECIPIENT],
        cluster: 'devnet',
      });
      await streaming.recordGrantSigned({
        walletAddress: wallet.walletAddress,
        sessionId: grant.session.sessionId,
        approveTxid: 'tx_streaming_grant_fixture',
      });

      const created = await postJson(port, '/api/mpp/challenge', { challenge: splChallenge() });
      expect(created.status).toBe(201);
      const approvalId = String(created.body.approvalId);

      const inbound = await requestJson(port, 'GET', '/api/mpp/inbound');
      const first = ((inbound.body.inbound as Record<string, unknown>[]) ?? [])[0] as Record<string, unknown>;
      expect((first.metadata as Record<string, unknown>).mppSessionEligibility).toMatchObject({
        eligible: true,
        finality: 'voucher_accepted',
        sessions: [{ sessionId: grant.session.sessionId }],
      });

      const paid = await postJson(port, '/api/mpp/session-pay', { approvalId });
      expect(paid.status).toBe(200);
      expect(paid.body).toMatchObject({
        accepted: true,
        finality: 'voucher_accepted',
        status: 'voucher_accepted',
      });
      expect(paid.body.receiptHash).toMatch(/^[a-f0-9]{64}$/);

      const approval = await workflowStore.getApproval(wallet.walletAddress, approvalId);
      expect(approval?.status).toBe('approved');
      expect(approval?.metadata?.mppSessionPayment).toMatchObject({
        approvalId,
        sessionId: grant.session.sessionId,
        status: 'voucher_accepted',
      });
      const sessionDetail = await streaming.getSession({
        walletAddress: wallet.walletAddress,
        sessionId: grant.session.sessionId,
      });
      expect(sessionDetail.vouchers).toHaveLength(1);
      expect(sessionDetail.vouchers[0]?.metadata?.mppSessionPayment).toMatchObject({
        approvalId,
        finality: 'voucher_accepted',
      });
      const evidence = await evidenceStore.listEvidence(wallet.walletAddress);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.metadata).toMatchObject({
        approvalId,
        sessionId: grant.session.sessionId,
        voucherHash: sessionDetail.vouchers[0]?.voucherHash,
        mppSessionPayment: true,
        linkType: 'mpp_session_payment',
        finality: 'voucher_accepted',
        status: 'voucher_accepted',
      });
    });
  });

  it('rejects session-pay after the original MPP challenge expires', async () => {
    let current = new Date('2026-05-16T12:00:00.000Z');
    await withMppServer(async ({ port, workflowStore, wallet }) => {
      const streaming = new StreamingService(streamingStoreFor(workflowStore), {
        clock: { now: () => current },
        latestBlockhash: async () => '11111111111111111111111111111111',
      });
      const grant = await streaming.createSession({
        walletAddress: wallet.walletAddress,
        tokenMint: USDC_MINT,
        capAmount: '5',
        expiresAt: '2026-05-16T15:00:00.000Z',
        recipientAllowlist: [RECIPIENT],
        cluster: 'devnet',
      });
      await streaming.recordGrantSigned({
        walletAddress: wallet.walletAddress,
        sessionId: grant.session.sessionId,
        approveTxid: 'tx_streaming_grant_fixture',
      });

      const created = await postJson(port, '/api/mpp/challenge', { challenge: splChallenge() });
      expect(created.status).toBe(201);
      const approvalId = String(created.body.approvalId);
      current = new Date('2026-05-16T13:00:01.000Z');

      const inbound = await requestJson(port, 'GET', '/api/mpp/inbound');
      const row = ((inbound.body.inbound as Record<string, unknown>[]) ?? [])[0] as Record<string, unknown>;
      expect((row.metadata as Record<string, unknown>).mppSessionEligibility).toMatchObject({
        eligible: false,
        reasonCode: 'expired_challenge',
      });

      const paid = await postJson(port, '/api/mpp/session-pay', { approvalId });
      expect(paid.status).toBe(409);
      expect(paid.body.error).toBe('expired_challenge');
    }, { clock: { now: () => current } });
  });

  it('does not create a session payment for terminal approvals without an existing link', async () => {
    await withMppServer(async ({ port, workflowStore, wallet }) => {
      const created = await postJson(port, '/api/mpp/challenge', { challenge: splChallenge() });
      expect(created.status).toBe(201);
      const approvalId = String(created.body.approvalId);
      const approval = await workflowStore.getApproval(wallet.walletAddress, approvalId);
      expect(approval).toBeTruthy();
      await workflowStore.saveApproval(wallet.walletAddress, {
        ...approval!,
        status: 'approved',
        updatedAt: NOW.toISOString(),
        decidedAt: NOW.toISOString(),
      });

      const paid = await postJson(port, '/api/mpp/session-pay', { approvalId });
      expect(paid.status).toBe(409);
      expect(paid.body.error).toBe('approval_terminal');
    });
  });

  it('marks Android-native streaming sessions ineligible for web session-pay', async () => {
    await withMppServer(async ({ port, workflowStore, wallet }) => {
      const streaming = new StreamingService(streamingStoreFor(workflowStore), {
        clock: { now: () => NOW },
        latestBlockhash: async () => '11111111111111111111111111111111',
      });
      const grant = await streaming.createSession({
        walletAddress: wallet.walletAddress,
        tokenMint: USDC_MINT,
        capAmount: '5',
        expiresAt: '2026-05-16T14:00:00.000Z',
        recipientAllowlist: [RECIPIENT],
        cluster: 'devnet',
        signerRuntime: 'android-native',
        ephemeralSignerPubkey: RECIPIENT,
      });
      await streaming.recordGrantSigned({
        walletAddress: wallet.walletAddress,
        sessionId: grant.session.sessionId,
        approveTxid: 'tx_streaming_grant_native',
      });

      const created = await postJson(port, '/api/mpp/challenge', { challenge: splChallenge() });
      expect(created.status).toBe(201);
      const approvalId = String(created.body.approvalId);

      const inbound = await requestJson(port, 'GET', '/api/mpp/inbound');
      const row = ((inbound.body.inbound as Record<string, unknown>[]) ?? [])[0] as Record<string, unknown>;
      expect((row.metadata as Record<string, unknown>).mppSessionEligibility).toMatchObject({
        eligible: false,
        reasonCode: 'native_signer_required',
        sessions: [{ sessionId: grant.session.sessionId, serverSignable: false, signerRuntime: 'android-native' }],
      });

      const paid = await postJson(port, '/api/mpp/session-pay', { approvalId, sessionId: grant.session.sessionId });
      expect(paid.status).toBe(409);
      expect(paid.body.error).toBe('native_signer_required');
    });
  });

  it('lists multiple eligible streaming sessions and pays with the selected one', async () => {
    await withMppServer(async ({ port, workflowStore, wallet }) => {
      const streaming = new StreamingService(streamingStoreFor(workflowStore), {
        clock: { now: () => NOW },
        latestBlockhash: async () => '11111111111111111111111111111111',
      });
      const first = await streaming.createSession({
        walletAddress: wallet.walletAddress,
        tokenMint: USDC_MINT,
        capAmount: '5',
        expiresAt: '2026-05-16T14:00:00.000Z',
        recipientAllowlist: [RECIPIENT],
        cluster: 'devnet',
      });
      const second = await streaming.createSession({
        walletAddress: wallet.walletAddress,
        tokenMint: USDC_MINT,
        capAmount: '9',
        expiresAt: '2026-05-16T15:00:00.000Z',
        recipientAllowlist: [RECIPIENT],
        cluster: 'devnet',
      });
      await streaming.recordGrantSigned({
        walletAddress: wallet.walletAddress,
        sessionId: first.session.sessionId,
        approveTxid: 'tx_streaming_grant_first',
      });
      await streaming.recordGrantSigned({
        walletAddress: wallet.walletAddress,
        sessionId: second.session.sessionId,
        approveTxid: 'tx_streaming_grant_second',
      });

      const created = await postJson(port, '/api/mpp/challenge', { challenge: splChallenge() });
      expect(created.status).toBe(201);
      const approvalId = String(created.body.approvalId);

      const inbound = await requestJson(port, 'GET', '/api/mpp/inbound');
      const row = ((inbound.body.inbound as Record<string, unknown>[]) ?? [])[0] as Record<string, unknown>;
      const eligibility = (row.metadata as Record<string, unknown>).mppSessionEligibility as Record<string, unknown>;
      expect(eligibility).toMatchObject({
        eligible: true,
        sessions: [
          { sessionId: first.session.sessionId, capConsumptionBps: 5000 },
          { sessionId: second.session.sessionId },
        ],
      });

      const paid = await postJson(port, '/api/mpp/session-pay', {
        approvalId,
        sessionId: second.session.sessionId,
      });
      expect(paid.status).toBe(200);
      expect((paid.body.sessionPayment as Record<string, unknown>).sessionId).toBe(second.session.sessionId);

      expect((await streaming.getSession({
        walletAddress: wallet.walletAddress,
        sessionId: first.session.sessionId,
      })).vouchers).toHaveLength(0);
      expect((await streaming.getSession({
        walletAddress: wallet.walletAddress,
        sessionId: second.session.sessionId,
      })).vouchers).toHaveLength(1);
    });
  });

  it('blocks session payments that violate wallet MPP session policy', async () => {
    await withMppServer(async ({ port, workflowStore, wallet }) => {
      await workflowStore.savePreference(wallet.walletAddress, {
        namespace: 'mpp-config' as never,
        version: 1,
        updatedAt: NOW.toISOString(),
        payload: {
          acceptedRails: ['usdc'],
          maxChallengeAmount: '10',
          sessionPolicy: {
            allowedMerchantIds: ['merchant_allowed'],
            maxAmount: '2.00',
          },
        },
      });
      const streaming = new StreamingService(streamingStoreFor(workflowStore), {
        clock: { now: () => NOW },
        latestBlockhash: async () => '11111111111111111111111111111111',
      });
      const grant = await streaming.createSession({
        walletAddress: wallet.walletAddress,
        tokenMint: USDC_MINT,
        capAmount: '5',
        expiresAt: '2026-05-16T14:00:00.000Z',
        recipientAllowlist: [RECIPIENT],
        cluster: 'devnet',
      });
      await streaming.recordGrantSigned({
        walletAddress: wallet.walletAddress,
        sessionId: grant.session.sessionId,
        approveTxid: 'tx_streaming_grant_fixture',
      });

      const created = await postJson(port, '/api/mpp/challenge', { challenge: splChallenge() });
      expect(created.status).toBe(201);
      const approvalId = String(created.body.approvalId);

      const inbound = await requestJson(port, 'GET', '/api/mpp/inbound');
      const row = ((inbound.body.inbound as Record<string, unknown>[]) ?? [])[0] as Record<string, unknown>;
      expect((row.metadata as Record<string, unknown>).mppSessionEligibility).toMatchObject({
        eligible: false,
        reasonCode: 'policy_merchant_not_allowed',
        policy: {
          allowed: false,
          maxAmount: '2.00',
        },
      });

      const paid = await postJson(port, '/api/mpp/session-pay', { approvalId });
      expect(paid.status).toBe(409);
      expect(paid.body.error).toBe('policy_merchant_not_allowed');
    });
  });

  it('lets session policy require settlement-confirmed MPP finality', async () => {
    await withMppServer(async ({ port, workflowStore, wallet }) => {
      await workflowStore.savePreference(wallet.walletAddress, {
        namespace: 'mpp-config' as never,
        version: 1,
        updatedAt: NOW.toISOString(),
        payload: {
          acceptedRails: ['usdc'],
          maxChallengeAmount: '10',
          sessionPolicy: {
            allowedOrigins: ['https://merchant.example'],
            requireSettlementConfirmed: true,
          },
        },
      });
      const streaming = new StreamingService(streamingStoreFor(workflowStore), {
        clock: { now: () => NOW },
        latestBlockhash: async () => '11111111111111111111111111111111',
      });
      const grant = await streaming.createSession({
        walletAddress: wallet.walletAddress,
        tokenMint: USDC_MINT,
        capAmount: '5',
        expiresAt: '2026-05-16T14:00:00.000Z',
        recipientAllowlist: [RECIPIENT],
        cluster: 'devnet',
      });
      await streaming.recordGrantSigned({
        walletAddress: wallet.walletAddress,
        sessionId: grant.session.sessionId,
        approveTxid: 'tx_streaming_grant_fixture',
      });

      const created = await postJson(port, '/api/mpp/challenge', { challenge: splChallenge() });
      expect(created.status).toBe(201);
      const approvalId = String(created.body.approvalId);

      const paid = await postJson(port, '/api/mpp/session-pay', { approvalId });
      expect(paid.status).toBe(200);
      expect(paid.body).toMatchObject({
        accepted: true,
        finality: 'settlement_confirmed',
        status: 'settlement_pending',
      });
      expect((paid.body.sessionPayment as Record<string, unknown>).policy).toMatchObject({
        allowed: true,
        requireSettlementConfirmed: true,
      });
    });
  });

  it('keeps strict MPP session payments pending until streaming settlement confirms', async () => {
    await withMppServer(async ({ port, workflowStore, evidenceStore, wallet }) => {
      const streaming = new StreamingService(streamingStoreFor(workflowStore), {
        clock: { now: () => NOW },
        latestBlockhash: async () => '11111111111111111111111111111111',
      });
      const grant = await streaming.createSession({
        walletAddress: wallet.walletAddress,
        tokenMint: USDC_MINT,
        capAmount: '5',
        expiresAt: '2026-05-16T14:00:00.000Z',
        recipientAllowlist: [RECIPIENT],
        cluster: 'devnet',
      });
      await streaming.recordGrantSigned({
        walletAddress: wallet.walletAddress,
        sessionId: grant.session.sessionId,
        approveTxid: 'tx_streaming_grant_fixture',
      });

      const created = await postJson(port, '/api/mpp/challenge', {
        challenge: splChallenge({ metadata: { requiredFinality: 'settlement_confirmed' } }),
      });
      expect(created.status).toBe(201);
      const approvalId = String(created.body.approvalId);

      const paid = await postJson(port, '/api/mpp/session-pay', { approvalId });
      expect(paid.status).toBe(200);
      expect(paid.body).toMatchObject({
        accepted: true,
        finality: 'settlement_confirmed',
        status: 'settlement_pending',
      });
      expect((await workflowStore.getApproval(wallet.walletAddress, approvalId))?.status).toBe('approval_pending');

      const settled = await settleStreamingSession({
        store: workflowStore,
        evidenceStore,
        clock: { now: () => NOW },
        walletAddress: wallet.walletAddress,
        sessionId: grant.session.sessionId,
        latestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
        submitSignedTransaction: async () => ({
          txid: 'tx_streaming_settlement_fixture',
          confirmedAt: '2026-05-16T12:01:00.000Z',
        }),
      });
      expect(settled.settled).toBe(1);

      const approval = await workflowStore.getApproval(wallet.walletAddress, approvalId);
      expect(approval?.status).toBe('approved');
      expect(approval?.metadata?.mppSessionPayment).toMatchObject({
        status: 'settlement_confirmed',
        settlementTxid: 'tx_streaming_settlement_fixture',
      });
      const evidence = await evidenceStore.listEvidence(wallet.walletAddress);
      expect(evidence.some((record) => record.kind === 'streaming_settlement')).toBe(true);
      expect(evidence.some((record) => record.kind === 'mpp_session' && record.metadata?.finality === 'settlement_confirmed')).toBe(true);

      const replay = await settleStreamingSession({
        store: workflowStore,
        evidenceStore,
        clock: { now: () => NOW },
        walletAddress: wallet.walletAddress,
        sessionId: grant.session.sessionId,
        latestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
        submitSignedTransaction: async () => ({
          txid: 'tx_streaming_settlement_fixture',
          confirmedAt: '2026-05-16T12:01:00.000Z',
        }),
      });
      expect(replay.settled).toBe(0);
      const afterReplay = await evidenceStore.listEvidence(wallet.walletAddress);
      expect(afterReplay.filter((record) => record.kind === 'mpp_session')).toHaveLength(1);
    });
  });
});

async function withMppServer(callback: (ctx: {
  port: number;
  workflowStore: MemoryWorkflowStore;
  evidenceStore: MemoryEvidenceStore;
  wallet: TestWallet;
}) => Promise<void>, options: {
  clock?: Clock;
} = {}): Promise<void> {
  const wallet = createTestWallet();
  const workflowStore = new MemoryWorkflowStore();
  const evidenceStore = new MemoryEvidenceStore();
  const workflowService = new WorkflowService(workflowStore);
  const clock: Clock = options.clock ?? { now: () => NOW };
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

function splChallenge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
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
