import { generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseAuthNonceResponse,
  parseSessionResponse,
} from '@solana-agent-wallet-adapter/workflow';
import { afterEach, describe, expect, it } from 'vitest';

import { encodeBase58 } from '../cloud/auth.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import type { AuthRateLimiter } from '../cloud/router.js';
import { createWalletSession, sessionFromRequest } from '../cloud/session.js';
import type { Clock } from '../cloud/store.js';
import type {
  ApprovalRequestRecord,
  CompletedRecord,
  JsonObject,
  PlanDraftRecord,
  TransactionFinalizationRecord,
} from '../cloud/workflowValidation.js';
import { createRenderWebServer } from '../server.js';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

interface TestWallet {
  walletAddress: string;
  privateKey: KeyObject;
}

describe('render web cloud wallet auth', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('creates a sign-in nonce for a valid wallet address', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      });

      expect(response.status).toBe(200);
      expect(response.body.walletAddress).toBe(wallet.walletAddress);
      expect(response.body.nonce).toEqual(expect.any(String));
      expect(response.body.domain).toBe(`127.0.0.1:${port}`);
      expect(String(response.body.message)).toContain(`Wallet: ${wallet.walletAddress}`);
      expect(String(response.body.message)).toContain('does not grant spending authority');
      expect(parseAuthNonceResponse(response.body)).toMatchObject({
        walletAddress: wallet.walletAddress,
        domain: `127.0.0.1:${port}`,
      });
    });
  });

  it('creates an HTTP-only session from a valid wallet signature', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(200);
      expect(verify.body).toMatchObject({
        signedIn: true,
        user: {
          walletAddress: wallet.walletAddress,
        },
        capabilities: {
          mode: 'agentic_cloud',
          requiresWalletSession: true,
          requiresLocalhost: false,
        },
        session: {
          walletAddress: wallet.walletAddress,
        },
        expiresAt: expect.any(String),
      });
      expect(parseSessionResponse(verify.body)).toMatchObject({
        signedIn: true,
        session: {
          walletAddress: wallet.walletAddress,
        },
      });
      expect(firstSetCookie(verify)).toContain('agentic_session=');
      expect(firstSetCookie(verify)).toContain('HttpOnly');
      expect(firstSetCookie(verify)).toContain('SameSite=Lax');

      const session = await getJson(port, '/api/session', {
        cookie: sessionCookie(verify),
      });
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({
        signedIn: true,
        user: {
          walletAddress: wallet.walletAddress,
        },
      });
      expect(parseSessionResponse(session.body).signedIn).toBe(true);
    });
  });

  it('keeps legacy minimal verify payloads working for the current browser client', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const body = signedVerifyBody(wallet, nonce.body);
      delete body.domain;
      delete body.issuedAt;
      delete body.expiresAt;
      delete body.signatureEncoding;

      const verify = await postJson(port, '/api/auth/verify-wallet', body);

      expect(verify.status).toBe(200);
      expect(parseSessionResponse(verify.body).signedIn).toBe(true);
    });
  });

  it('rejects invalid wallet signatures', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const otherWallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const body = signedVerifyBody(wallet, nonce.body);
      body.signature = signMessage(String(nonce.body.message), otherWallet.privateKey);

      const verify = await postJson(port, '/api/auth/verify-wallet', body);

      expect(verify.status).toBe(401);
      expect(String(verify.body.error)).toContain('signature');
    });
  });

  it('rejects expired nonces', async () => {
    const clock = mutableClock('2026-05-08T18:00:00.000Z');
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      clock.set('2026-05-08T18:06:00.000Z');

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(String(verify.body.error)).toContain('expired');
    }, { clock });
  });

  it('rejects a nonce that expires before the atomic consume step', async () => {
    // Auth endpoints also read the clock for rate limiting before route handlers run.
    const clock = queuedClock([
      '2026-05-08T17:59:58.000Z',
      '2026-05-08T17:59:59.000Z',
      '2026-05-08T18:00:00.000Z',
      '2026-05-08T18:04:59.998Z',
      '2026-05-08T18:04:59.999Z',
      '2026-05-08T18:05:00.000Z',
    ]);
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(firstSetCookie(verify)).toBe('');
    }, { clock });
  });

  it('rejects replayed nonces', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const body = signedVerifyBody(wallet, nonce.body);

      const first = await postJson(port, '/api/auth/verify-wallet', body);
      const replay = await postJson(port, '/api/auth/verify-wallet', body);

      expect(first.status).toBe(200);
      expect(replay.status).toBe(401);
      expect(String(replay.body.error)).toContain('used');
    });
  });

  it('does not create a session if nonce consumption loses a replay race', async () => {
    const store = new ReplayRaceStore();
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(firstSetCookie(verify)).toBe('');
    }, { store });
  });

  it('binds auth messages to AGENTIC_PUBLIC_ORIGIN when configured', async () => {
    await withEnv({ AGENTIC_PUBLIC_ORIGIN: 'https://agentic.example' }, async () => {
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const nonce = await createNonce(port, wallet);

        expect(nonce.body.domain).toBe('agentic.example');
        const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

        expect(verify.status).toBe(200);
      });
    });
  });

  it('rejects a signed nonce on a different domain', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      }, {
        host: 'agentic.example',
      });

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(String(verify.body.error)).toContain('domain');
    });
  });

  it('rejects cross-origin state-changing API requests', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      }, {
        origin: 'https://evil.example',
      });

      expect(response.status).toBe(403);
      expect(String(response.body.error)).toContain('Cross-origin');
    });
  });

  it('sets browser hardening headers on app responses', async () => {
    await withServer(async (port) => {
      const response = await requestRaw(port, '/app/', 'GET');

      expect(response.status).toBe(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(String(response.headers['permissions-policy'])).toContain('camera=()');
      expect(String(response.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    });
  });

  it('rejects state-changing JSON APIs without a JSON content type', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await requestRaw(port, '/api/auth/nonce', 'POST', JSON.stringify({
        walletAddress: wallet.walletAddress,
      }), {
        'content-type': 'text/plain',
      });

      expect(response.status).toBe(415);
      expect(String(response.body.error)).toContain('application/json');
    });
  });

  it('requires same-origin referer for production state-changing requests without Origin', async () => {
    await withEnv({ RENDER: 'true' }, async () => {
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const missingReferer = await postJson(port, '/api/auth/nonce', {
          walletAddress: wallet.walletAddress,
        });
        expect(missingReferer.status).toBe(403);
        expect(String(missingReferer.body.error)).toContain('same-origin');

        const withReferer = await postJson(port, '/api/auth/nonce', {
          walletAddress: wallet.walletAddress,
        }, {
          referer: `http://127.0.0.1:${port}/app/`,
        });
        expect(withReferer.status).toBe(200);
      });
    });
  });

  it('rate limits wallet auth endpoints', async () => {
    const authRateLimiter: AuthRateLimiter = {
      allow: () => false,
    };
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      });

      expect(response.status).toBe(429);
      expect(String(response.body.error)).toContain('Too many');
    }, { authRateLimiter });
  });

  it('passes the injected clock to the wallet auth rate limiter', async () => {
    const clock = fixedClock('2026-05-08T19:00:00.000Z');
    const seen: string[] = [];
    const authRateLimiter: AuthRateLimiter = {
      allow: (input) => {
        seen.push(input.now.toISOString());
        return true;
      },
    };

    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      });

      expect(response.status).toBe(200);
    }, { authRateLimiter, clock });

    expect(seen).toEqual(['2026-05-08T19:00:00.000Z']);
  });

  it('clears the session on logout', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));
      const cookie = sessionCookie(verify);

      const logout = await postJson(port, '/api/auth/logout', {}, { cookie });
      const session = await getJson(port, '/api/session', { cookie });

      expect(logout.status).toBe(200);
      expect(parseSessionResponse(logout.body)).toMatchObject({
        signedIn: false,
        capabilities: {
          mode: 'agentic_cloud',
        },
      });
      expect(firstSetCookie(logout)).toContain('Max-Age=0');
      expect(session.status).toBe(200);
      expect(parseSessionResponse(session.body)).toMatchObject({
        signedIn: false,
        capabilities: {
          mode: 'agentic_cloud',
        },
      });
    });
  });

  it('deletes signed-in cloud workspace data after a wallet-signed deletion intent', async () => {
    const store = new MemoryWorkflowStore();
    const wallet = createTestWallet();
    const recipient = createTestWallet();
    await withServer(async (port) => {
      const nonce = await createNonce(port, wallet);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));
      const cookie = sessionCookie(verify);
      await seedCloudWorkspace(store, wallet.walletAddress, recipient.walletAddress);

      const recurring = await postJson(port, '/api/recurring', validRecurringBody(recipient.walletAddress), { cookie });
      expect(recurring.status).toBe(201);

      const evidenceMessage = [
        'Evidence receipt: Cloud delete test',
        `Wallet: ${wallet.walletAddress}`,
        'Approval: approval_delete',
      ].join('\n');
      const evidence = await postJson(port, '/api/evidence', {
        title: 'Cloud delete test',
        kind: 'intent_receipt',
        status: 'approved',
        cluster: 'devnet',
        payload: { summary: 'Delete this cloud receipt' },
        preSignatureHash: '0x' + 'a'.repeat(64),
        signingMessage: evidenceMessage,
        signature: signMessage(evidenceMessage, wallet.privateKey),
      }, { cookie });
      expect(evidence.status).toBe(201);

      const intent = await postJson(port, '/api/cloud-workspace/delete-intent', {}, { cookie });
      expect(intent.status).toBe(200);
      expect(String(intent.body.message)).toContain('permanently deletes Agentic Cloud workspace data');

      const deleted = await postJson(
        port,
        '/api/cloud-workspace/delete',
        signedDeleteBody(wallet, intent.body),
        { cookie },
      );
      expect(deleted.status).toBe(200);
      expect(deleted.body).toMatchObject({
        ok: true,
        signedOut: true,
        deleted: {
          plans: 1,
          approvals: 1,
          transactionFinalizations: 1,
          completedRecords: 1,
          recurringSchedules: 1,
          evidenceReceipts: 1,
        },
      });
      expect(firstSetCookie(deleted)).toContain('Max-Age=0');

      const oldSession = await getJson(port, '/api/session', { cookie });
      expect(parseSessionResponse(oldSession.body).signedIn).toBe(false);

      const nextSession = await createWalletSession({
        store,
        walletAddress: wallet.walletAddress,
        clock: fixedClock('2026-05-08T18:10:00.000Z'),
      });
      const nextCookie = `agentic_session=${nextSession.token}`;
      expect((await getJson(port, '/api/plans', { cookie: nextCookie })).body.plans).toEqual([]);
      expect((await getJson(port, '/api/approvals', { cookie: nextCookie })).body.approvals).toEqual([]);
      expect((await getJson(port, '/api/completed', { cookie: nextCookie })).body.completed).toEqual([]);
      expect((await getJson(port, '/api/evidence', { cookie: nextCookie })).body.receipts).toEqual([]);
      expect((await getJson(port, '/api/recurring', { cookie: nextCookie })).body.schedules).toEqual([]);
      expect((await getJson(port, '/api/audit', { cookie: nextCookie })).body.events).toEqual([]);
    }, { store });
  });

  it('marks session cookies secure in Render production', async () => {
    await withEnv({ RENDER: 'true' }, async () => {
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const headers = { referer: `http://127.0.0.1:${port}/app/` };
        const nonce = await postJson(port, '/api/auth/nonce', {
          walletAddress: wallet.walletAddress,
        }, headers);
        expect(nonce.status).toBe(200);
        const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body), headers);

        expect(verify.status).toBe(200);
        expect(firstSetCookie(verify)).toContain('Secure');
      });
    });
  });

  it('uses SESSION_SECRET when hashing session cookies', async () => {
    const store = new MemoryWorkflowStore();
    const clock = fixedClock('2026-05-08T18:00:00.000Z');
    const wallet = createTestWallet();

    await withEnv({ SESSION_SECRET: 'alpha-secret' }, async () => {
      const created = await createWalletSession({ store, walletAddress: wallet.walletAddress, clock });
      const req = requestWithCookie(`agentic_session=${created.token}`);

      expect(await sessionFromRequest({ req, store, clock })).toMatchObject({
        walletAddress: wallet.walletAddress,
      });

      await withEnv({ SESSION_SECRET: 'beta-secret' }, async () => {
        expect(await sessionFromRequest({ req, store, clock })).toBeUndefined();
      });
    });
  });

  it('keeps audit events scoped by wallet address', async () => {
    const store = new MemoryWorkflowStore();
    const walletA = createTestWallet().walletAddress;
    const walletB = createTestWallet().walletAddress;

    await store.forWallet(walletA).insertAuditEvent({
      id: 'audit_1',
      type: 'test.audit',
      createdAt: '2026-05-08T18:00:00.000Z',
    });

    expect(await store.forWallet(walletA).listAuditEvents()).toHaveLength(1);
    expect(await store.forWallet(walletB).listAuditEvents()).toEqual([]);
  });

  it('lists audit events by related source record metadata', async () => {
    const store = new MemoryWorkflowStore();
    const clock = fixedClock('2026-05-08T18:00:00.000Z');
    const wallet = createTestWallet();
    const session = await createWalletSession({ store, walletAddress: wallet.walletAddress, clock });
    await store.forWallet(wallet.walletAddress).insertAuditEvent({
      id: 'audit_evidence_1',
      type: 'evidence.created',
      createdAt: '2026-05-08T18:00:01.000Z',
      metadata: {
        recordType: 'evidence',
        recordId: 'evidence_1',
        sourceRecordType: 'approval',
        sourceRecordId: 'approval_1',
        approvalId: 'approval_1',
      },
    });
    await store.forWallet(wallet.walletAddress).insertAuditEvent({
      id: 'audit_evidence_2',
      type: 'evidence.created',
      createdAt: '2026-05-08T18:00:02.000Z',
      metadata: {
        recordType: 'evidence',
        recordId: 'evidence_2',
        sourceRecordType: 'approval',
        sourceRecordId: 'approval_2',
        approvalId: 'approval_2',
      },
    });

    await withServer(async (port) => {
      const response = await getJson(port, '/api/audit?recordType=approval&recordId=approval_1', {
        cookie: `agentic_session=${session.token}`,
      });

      expect(response.status).toBe(200);
      expect((response.body.events as Array<Record<string, unknown>>).map((event) => event.id)).toEqual(['audit_evidence_1']);
    }, { store, clock });
  });

  it('lists real evidence-created audit events by related approval metadata', async () => {
    const store = new MemoryWorkflowStore();
    const clock = fixedClock('2026-05-08T18:00:00.000Z');
    const wallet = createTestWallet();
    const session = await createWalletSession({ store, walletAddress: wallet.walletAddress, clock });
    const signingMessage = [
      'Evidence receipt: Proof of Intent',
      `Wallet: ${wallet.walletAddress}`,
      'Approval: approval_1',
    ].join('\n');

    await withServer(async (port) => {
      const cookie = `agentic_session=${session.token}`;
      const created = await postJson(port, '/api/evidence', {
        title: 'Proof of Intent',
        kind: 'intent_receipt',
        status: 'approved',
        cluster: 'devnet',
        payload: { status: 'approved', summary: 'Intent proof for approval_1' },
        preSignatureHash: '0x' + 'a'.repeat(64),
        signingMessage,
        signature: signMessage(signingMessage, wallet.privateKey),
        metadata: {
          recordType: 'approval',
          recordId: 'approval_1',
          sourceRecordType: 'approval',
          sourceRecordId: 'approval_1',
          approvalId: 'approval_1',
          proofUseCase: 'intent',
          labId: 'intent-receipt',
        },
      }, { cookie });
      expect(created.status).toBe(201);

      const response = await getJson(port, '/api/audit?recordType=approval&recordId=approval_1', { cookie });
      expect(response.status).toBe(200);
      const events = response.body.events as Array<Record<string, unknown>>;
      expect(events.map((event) => event.type)).toEqual(['evidence.created']);
      expect(events[0]?.metadata).toMatchObject({
        recordType: 'evidence',
        recordId: (created.body.receipt as Record<string, unknown>).id,
        sourceRecordType: 'approval',
        sourceRecordId: 'approval_1',
        approvalId: 'approval_1',
        proofUseCase: 'intent',
      });
    }, { store, clock });
  });
});

async function withServer(
  callback: (port: number) => Promise<void>,
  options: { authRateLimiter?: AuthRateLimiter | false; clock?: Clock; store?: MemoryWorkflowStore } = {},
): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-render-web-auth-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(staticDir, 'app'));
  await writeFile(join(staticDir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');
  const server = createRenderWebServer({
    staticDir,
    clock: options.clock,
    authRateLimiter: options.authRateLimiter,
    store: options.store,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function createNonce(port: number, wallet: TestWallet): Promise<JsonResponse> {
  const response = await postJson(port, '/api/auth/nonce', {
    walletAddress: wallet.walletAddress,
  });
  expect(response.status).toBe(200);
  return response;
}

function signedVerifyBody(wallet: TestWallet, nonce: Record<string, unknown>): Record<string, unknown> {
  return {
    walletAddress: wallet.walletAddress,
    nonce: nonce.nonce,
    message: nonce.message,
    signature: signMessage(String(nonce.message), wallet.privateKey),
    domain: nonce.domain,
    issuedAt: nonce.issuedAt,
    expiresAt: nonce.expiresAt,
    signatureEncoding: 'base58',
  };
}

function signedDeleteBody(wallet: TestWallet, intent: Record<string, unknown>): Record<string, unknown> {
  return {
    walletAddress: wallet.walletAddress,
    nonce: intent.nonce,
    message: intent.message,
    signature: signMessage(String(intent.message), wallet.privateKey),
    domain: intent.domain,
    issuedAt: intent.issuedAt,
    expiresAt: intent.expiresAt,
    signatureEncoding: 'base58',
  };
}

async function seedCloudWorkspace(
  store: MemoryWorkflowStore,
  walletAddress: string,
  recipient: string,
): Promise<void> {
  const now = '2026-05-08T18:00:00.000Z';
  const plan = samplePlan(walletAddress, recipient, now);
  const approval = sampleApproval(walletAddress, recipient, now, plan.id);
  await store.savePlan(walletAddress, plan);
  await store.saveApproval(walletAddress, approval);
  await store.saveFinalization(walletAddress, sampleFinalization(walletAddress, recipient, now, approval.id, plan.id));
  await store.saveCompleted(walletAddress, sampleCompleted(walletAddress, recipient, now, approval.id, plan.id));
  await store.forWallet(walletAddress).insertAuditEvent({
    id: 'audit_delete',
    type: 'test.delete_seeded',
    createdAt: now,
    metadata: {
      recordType: 'approval',
      recordId: approval.id,
    },
  });
}

function samplePlan(walletAddress: string, recipient: string, now: string): PlanDraftRecord {
  return {
    id: 'plan_delete',
    walletAddress,
    plan: samplePlanPayload(recipient),
    title: 'Delete test plan',
    intent: 'Send 0.25 SOL to recipient',
    route: 'Wallet approval required.',
    risk: 'Medium risk.',
    approval: 'Review in wallet before signing.',
    source: 'template',
    category: 'payments',
    actionType: 'transfer_sol',
    parameters: {
      recipient,
      amount: '0.25',
    },
    fields: [
      { label: 'Recipient address', value: recipient },
      { label: 'Amount SOL', value: '0.25' },
    ],
    safeguards: ['Wallet approval is required.'],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    templateId: 'transfer-sol',
    templateTitle: 'Send SOL',
    prompt: 'Send 0.25 SOL',
    cluster: 'devnet',
  };
}

function sampleApproval(
  walletAddress: string,
  recipient: string,
  now: string,
  planDraftId: string,
): ApprovalRequestRecord {
  return {
    id: 'approval_delete',
    walletAddress,
    planDraftId,
    kind: 'transfer_sol',
    status: 'ready',
    summary: 'Delete test approval',
    params: {
      recipient,
      amount: '0.25',
    },
    cluster: 'devnet',
    dueAt: now,
    createdAt: now,
    updatedAt: now,
    finalizationRequirement: 'transaction_preview',
  };
}

function sampleCompleted(
  walletAddress: string,
  recipient: string,
  now: string,
  approvalRequestId: string,
  planDraftId: string,
): CompletedRecord {
  return {
    id: 'completed_delete',
    kind: 'one_time',
    status: 'approved',
    title: 'Delete test completed',
    summary: 'Completed record slated for deletion',
    walletAddress,
    createdAt: now,
    completedAt: now,
    cluster: 'devnet',
    amount: '0.25',
    token: 'SOL',
    recipient,
    approvalRequestId,
    planDraftId,
    copyPayload: { approvalRequestId },
    detailRows: [['Status', 'approved']],
  };
}

function sampleFinalization(
  walletAddress: string,
  recipient: string,
  now: string,
  approvalRequestId: string,
  planDraftId: string,
): TransactionFinalizationRecord {
  return {
    id: 'finalization_delete',
    walletAddress,
    approvalRequestId,
    planDraftId,
    kind: 'transfer_sol',
    status: 'prepared',
    cluster: 'devnet',
    walletAction: {
      kind: 'transfer_sol',
      walletAddress,
      cluster: 'devnet',
      summary: 'Delete test finalization',
      sender: walletAddress,
      recipient,
      amount: '0.25',
      token: 'SOL',
      instructionSummary: ['Transfer 0.25 SOL'],
      touchedPrograms: ['11111111111111111111111111111111'],
    },
    transactionHash: '0x' + 'b'.repeat(64),
    createdAt: now,
    updatedAt: now,
    expiresAt: '2026-05-08T18:10:00.000Z',
  };
}

function samplePlanPayload(recipient: string): JsonObject {
  return {
    intent: 'Send 0.25 SOL to recipient',
    route: 'Wallet approval required.',
    risk: 'Medium risk.',
    approval: 'Review in wallet before signing.',
    source: 'template',
    category: 'payments',
    actionType: 'transfer_sol',
    templateTitle: 'Send SOL',
    parameters: {
      recipient,
      amount: '0.25',
    },
    fields: [
      { label: 'Recipient address', value: recipient },
      { label: 'Amount SOL', value: '0.25' },
    ],
    safeguards: ['Wallet approval is required.'],
  };
}

function validRecurringBody(recipient: string): Record<string, unknown> {
  return {
    cluster: 'devnet',
    token: 'SOL',
    recipient,
    amount: '0.10',
    cadence: 'interval_minutes',
    intervalMinutes: 10,
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

function sessionCookie(response: JsonResponse): string {
  const cookie = firstSetCookie(response);
  return cookie.split(';')[0] ?? '';
}

function firstSetCookie(response: JsonResponse): string {
  const header = response.headers['set-cookie'];
  if (Array.isArray(header)) return header[0] ?? '';
  return header ?? '';
}

function mutableClock(initial: string): Clock & { set(value: string): void } {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    set: (value: string) => {
      current = new Date(value);
    },
  };
}

function fixedClock(value: string): Clock {
  return {
    now: () => new Date(value),
  };
}

function queuedClock(values: string[]): Clock {
  if (values.length === 0) {
    throw new Error('queuedClock requires at least one timestamp.');
  }
  let index = 0;
  return {
    now: () => {
      const value = values[Math.min(index, values.length - 1)]!;
      index += 1;
      return new Date(value);
    },
  };
}

class ReplayRaceStore extends MemoryWorkflowStore {
  override async consumeAuthNonce(): Promise<undefined> {
    return undefined;
  }
}

function requestWithCookie(cookie: string): IncomingMessage {
  return {
    headers: {
      cookie,
    },
  } as IncomingMessage;
}

const envStack: Array<Map<string, string | undefined>> = [];

async function withEnv<T>(env: Record<string, string>, callback: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  envStack.push(previous);
  try {
    return await callback();
  } finally {
    restoreEnv();
  }
}

function restoreEnv(): void {
  const previous = envStack.pop();
  if (!previous) return;
  for (const [key, value] of previous) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  return requestJson(port, path, 'POST', body, headers);
}

function getJson(port: number, path: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  return requestJson(port, path, 'GET', undefined, headers);
}

function requestRaw(
  port: number,
  path: string,
  method: 'GET' | 'POST',
  body?: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(body === undefined
          ? {}
          : {
              'content-length': Buffer.byteLength(body),
            }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: Record<string, unknown> = {};
        try {
          parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        } catch {
          parsed = { raw };
        }
        resolve({
          status: res.statusCode ?? 0,
          body: parsed,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function requestJson(
  port: number,
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  headers: Record<string, string>,
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(payload === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }),
      },
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
