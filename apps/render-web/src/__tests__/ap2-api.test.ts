import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';

import type {
  Ap2Cluster,
  Ap2InboundApprovalParams,
  Ap2InboundReceipt,
  Ap2Mandate,
  Ap2VerifiedAgent,
} from '@solana-agent-wallet-adapter/ap2-adapter';
import type {
  ApprovalRequestRecord,
  TransactionFinalizationRecord,
  WorkflowSession,
} from '@solana-agent-wallet-adapter/workflow';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AP2_EVIDENCE_KIND,
  AP2_INBOUND_ACTION_SOURCE,
  createAp2ApiHandler,
  type Ap2RouteAdapter,
  type InboundMandate,
} from '../cloud/ap2Routes.js';
import {
  MemoryEvidenceStore,
  type EvidenceReceiptRecord,
} from '../cloud/evidenceService.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import type { Clock } from '../cloud/store.js';
import { WorkflowService } from '../cloud/workflowService.js';

const WALLET_A = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const WALLET_B = 'BvgrFr5Bcaa9NudH3DCxgMnHV1FT1nzD5JtMHsmpKnFB';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// 32 zero bytes when base58-decoded (system program id) — passes parser length check.
const FIXTURE_PUBLIC_KEY = '11111111111111111111111111111111';
// 88 chars; decodes to a valid 64-byte signature (88 zero bytes truncated by base58 length rules
// — see parser.ts BASE58 decode + 64-byte ED25519_SIGNATURE_BYTES check).
const FIXTURE_SIGNATURE = '1111111111111111111111111111111111111111111111111111111111111111';

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

interface VerifyCapture {
  opts: { clockNow: Date; expectedRecipient: string; expectedCluster?: Ap2Cluster } | null;
}

interface ServerHandle {
  port: number;
  workflowStore: MemoryWorkflowStore;
  evidenceStore: MemoryEvidenceStore;
  workflowService: WorkflowService;
  server: Server;
  adapter: Ap2RouteAdapter;
  verifyCapture: VerifyCapture;
}

const FROZEN_NOW = new Date('2026-05-14T12:00:00.000Z');

function fixedClock(): Clock {
  return { now: () => FROZEN_NOW };
}

function monotonicClock(start: Date = FROZEN_NOW): Clock {
  let tick = start.getTime();
  return {
    now: () => new Date(tick++),
  };
}

function makeMandate(
  overrides: Partial<{
    mandateId: string;
    agentId: string;
    recipient: string;
    amount: string;
    cluster: Ap2Cluster;
  }> = {},
): Ap2Mandate {
  const mandateId = overrides.mandateId ?? 'mandate-fixture-1';
  const mandateType = 'intent_mandate' as const;
  const protocolVersion = 'ap2/0.1';
  const issuedAt = '2026-05-14T11:00:00.000Z';
  const expiresAt = '2026-05-14T13:00:00.000Z';
  const intent = {
    description: 'Test inbound payment.',
    cap: {
      amount: overrides.amount ?? '12.345',
      tokenSymbol: 'SOL',
      tokenMint: 'So11111111111111111111111111111111111111112',
      recipient: overrides.recipient ?? WALLET_A,
      cluster: overrides.cluster ?? 'mainnet-beta',
    },
  };
  return {
    mandateId,
    mandateType,
    protocolVersion,
    issuedAt,
    expiresAt,
    agent: {
      agentId: overrides.agentId ?? 'agent-test-1',
      agentLabel: 'Test Operator',
      publicKey: FIXTURE_PUBLIC_KEY,
    },
    signature: FIXTURE_SIGNATURE,
    signedFields: { mandateId, mandateType, protocolVersion, issuedAt, expiresAt, intent },
    intent,
  } as Ap2Mandate;
}

interface FakeAdapterOpts {
  rejectVerify?: boolean;
  rejectValidate?: boolean;
  validatorCluster?: Ap2Cluster;
  enforceRecipient?: boolean;
  capture?: VerifyCapture;
}

function makeFakeAdapter(opts: FakeAdapterOpts = {}): Ap2RouteAdapter {
  return {
    validateInboundRequest(body) {
      if (opts.rejectValidate) {
        throw new Error('forced_invalid_schema');
      }
      if (!body || typeof body !== 'object') {
        throw new Error('not_object');
      }
      const mandate = (body as { mandate?: Ap2Mandate }).mandate;
      if (!mandate) throw new Error('missing_mandate');
      const result: { mandate: Ap2Mandate; cluster?: Ap2Cluster; receivedAt: string } = {
        mandate,
        receivedAt: '2026-05-14T12:00:00.000Z',
      };
      if (opts.validatorCluster) result.cluster = opts.validatorCluster;
      return result;
    },
    verifyMandate(mandate, verifyOpts) {
      if (opts.capture) opts.capture.opts = verifyOpts;
      if (opts.rejectVerify) {
        throw new Error('forced_invalid_signature');
      }
      if (opts.enforceRecipient) {
        const payment = mandate.mandateType === 'intent_mandate' ? mandate.intent.cap : mandate.payment;
        if (verifyOpts.expectedRecipient !== payment.recipient) {
          throw new Error('forced_recipient_mismatch');
        }
      }
      return {
        verified: true,
        agent: {
          agentId: mandate.agent.agentId,
          agentLabel: mandate.agent.agentLabel,
          publicKey: mandate.agent.publicKey,
        },
      };
    },
    mandateToApprovalParams(mandate, agent, walletAddress): Ap2InboundApprovalParams {
      const cap = (mandate as { intent: { cap: { amount: string; cluster: Ap2Cluster } } }).intent.cap;
      return {
        kind: 'transfer_sol',
        summary: `AP2 inbound: ${agent.agentLabel} requests ${cap.amount} SOL to ${walletAddress}`,
        cluster: cap.cluster,
        amount: cap.amount,
        token: 'SOL',
        recipient: walletAddress,
        params: {
          fromAddress: walletAddress,
          toAddress: walletAddress,
          amount: cap.amount,
          tokenMint: 'So11111111111111111111111111111111111111112',
          tokenSymbol: 'SOL',
        },
        metadata: {
          connectorId: 'ap2',
          actionSource: AP2_INBOUND_ACTION_SOURCE,
          ap2VerifiedAgent: {
            agentId: agent.agentId,
            agentLabel: agent.agentLabel,
            publicKey: agent.publicKey,
            verified: true,
          },
          ap2MandateId: mandate.mandateId,
          ap2MandateType: mandate.mandateType,
          ap2ProtocolVersion: mandate.protocolVersion,
          actionProposal: mandate as unknown as Ap2InboundApprovalParams['metadata'][string],
        },
      };
    },
    buildAp2InboundReceipt({ mandate, agent, approval, txid, walletAddress, cluster, finalizedAt, issuedAt }): Ap2InboundReceipt {
      return {
        schema: 'ap2/inbound/0.1',
        mandateId: mandate.mandateId,
        mandateType: mandate.mandateType,
        protocolVersion: mandate.protocolVersion,
        issuedAt: issuedAt ?? FROZEN_NOW.toISOString(),
        agent,
        payment: {
          amount: '12.345',
          tokenSymbol: 'SOL',
          tokenMint: 'So11111111111111111111111111111111111111112',
          recipient: walletAddress,
          cluster,
        },
        approval,
        execution: {
          txid,
          walletAddress,
          cluster,
          finalizedAt: finalizedAt ?? issuedAt ?? FROZEN_NOW.toISOString(),
        },
        artifactHash: `fixture-hash-${approval.id}-${txid}`,
      };
    },
  };
}

async function startServer(adapter: Ap2RouteAdapter, capture: VerifyCapture): Promise<ServerHandle> {
  const workflowStore = new MemoryWorkflowStore();
  const evidenceStore = new MemoryEvidenceStore();
  const workflowService = new WorkflowService(workflowStore, { clock: monotonicClock().now });
  const handler = createAp2ApiHandler({
    workflowService,
    workflowStore,
    evidenceStore,
    clock: fixedClock(),
    getSession(req): WorkflowSession | null {
      const wallet = req.headers['x-test-wallet'];
      return typeof wallet === 'string' && wallet ? { walletAddress: wallet } : null;
    },
    adapter,
  });
  const server = createServer((req, res) => {
    void handler(req, res).then(
      (handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end('not found');
        }
      },
      (err) => {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : 'error');
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
  return {
    port: address.port,
    workflowStore,
    evidenceStore,
    workflowService,
    server,
    adapter,
    verifyCapture: capture,
  };
}

async function closeServer(handle: ServerHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    handle.server.close((err) => (err ? reject(err) : resolve()));
  });
}

let handle: ServerHandle | undefined;

afterEach(async () => {
  if (handle) {
    await closeServer(handle);
    handle = undefined;
  }
});

async function withServer(
  adapterOrOpts: Ap2RouteAdapter | FakeAdapterOpts | undefined,
  run: (h: ServerHandle) => Promise<void>,
): Promise<void> {
  const capture: VerifyCapture = { opts: null };
  let adapter: Ap2RouteAdapter;
  if (!adapterOrOpts) {
    adapter = makeFakeAdapter({ capture });
  } else if (typeof (adapterOrOpts as Ap2RouteAdapter).validateInboundRequest === 'function') {
    adapter = adapterOrOpts as Ap2RouteAdapter;
  } else {
    adapter = makeFakeAdapter({ ...(adapterOrOpts as FakeAdapterOpts), capture });
  }
  handle = await startServer(adapter, capture);
  await run(handle);
}

function postJson(port: number, path: string, body: unknown, wallet: string | null = WALLET_A): Promise<TestResponse> {
  return request(port, 'POST', path, body, wallet);
}

function getJson(port: number, path: string, wallet: string | null = WALLET_A): Promise<TestResponse> {
  return request(port, 'GET', path, undefined, wallet);
}

function putRequest(port: number, path: string, wallet: string | null = WALLET_A): Promise<TestResponse> {
  return request(port, 'PUT', path, {}, wallet);
}

function rawPost(
  port: number,
  path: string,
  rawBody: string,
  wallet: string | null = WALLET_A,
  contentType = 'application/json',
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'content-type': contentType,
      'content-length': Buffer.byteLength(rawBody),
    };
    if (wallet) headers['x-test-wallet'] = wallet;
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: Record<string, unknown> = {};
        if (raw) {
          try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = { _raw: raw }; }
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(rawBody);
  });
}

function request(
  port: number,
  method: string,
  path: string,
  body: unknown,
  wallet: string | null,
): Promise<TestResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (wallet) headers['x-test-wallet'] = wallet;
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: Record<string, unknown> = {};
        if (raw) {
          try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = { _raw: raw }; }
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function injectConfirmedFinalization(
  workflowStore: MemoryWorkflowStore,
  approval: ApprovalRequestRecord,
  txid: string,
): TransactionFinalizationRecord {
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
  void workflowStore.saveFinalization(approval.walletAddress, finalization);
  return finalization;
}

describe('AP2 inbound API (/api/ap2/inbound)', () => {
  describe('POST /api/ap2/inbound', () => {
    it('rejects requests without a wallet session with 401', async () => {
      await withServer(undefined, async ({ port }) => {
        const response = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, null);
        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: 'unauthorized' });
      });
    });

    it('creates an AP2 inbound approval, preserves verified flag, and writes a complete audit event', async () => {
      await withServer(undefined, async ({ port, workflowStore, verifyCapture }) => {
        const response = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        expect(response.status).toBe(201);
        const inboundId = response.body.inboundId as string;
        const approvalId = response.body.approvalId as string;
        expect(inboundId).toEqual(approvalId);
        expect((response.body.agent as { agentId: string }).agentId).toBe('agent-test-1');

        // A3 verifier opts captured — must carry expectedRecipient
        expect(verifyCapture.opts?.expectedRecipient).toBe(WALLET_A);

        const approvals = await workflowStore.listApprovals(WALLET_A);
        expect(approvals).toHaveLength(1);
        const approval = approvals[0]!;
        expect(approval.id).toBe(inboundId);
        expect(approval.kind).toBe('transfer_sol');
        expect(approval.metadata?.actionSource).toBe(AP2_INBOUND_ACTION_SOURCE);
        expect(approval.metadata?.ap2MandateId).toBe('mandate-fixture-1');
        // verified:true must be preserved for the UI badge contract.
        const agentMeta = approval.metadata?.ap2VerifiedAgent as {
          agentId: string;
          publicKey: string;
          verified: boolean;
        };
        expect(agentMeta.agentId).toBe('agent-test-1');
        expect(agentMeta.publicKey).toBe(FIXTURE_PUBLIC_KEY);
        expect(agentMeta.verified).toBe(true);

        const audits = await workflowStore.forWallet(WALLET_A).listAuditEvents();
        const ap2Audits = audits.filter((event) => event.type === 'ap2.inbound.created');
        expect(ap2Audits).toHaveLength(1);
        const auditMetadata = ap2Audits[0]!.metadata as {
          recordId: string;
          sourceAgentId: string;
          mandateId: string;
          mandateType: string;
          receivedAt: string;
        };
        expect(auditMetadata.recordId).toBe(approval.id);
        expect(auditMetadata.sourceAgentId).toBe('agent-test-1');
        expect(auditMetadata.mandateId).toBe('mandate-fixture-1');
        expect(auditMetadata.mandateType).toBe('intent_mandate');
        expect(auditMetadata.receivedAt).toBe('2026-05-14T12:00:00.000Z');
      });
    });

    it('passes validator-provided cluster to the verifier and the approval', async () => {
      await withServer({ validatorCluster: 'testnet' }, async ({ port, workflowStore, verifyCapture }) => {
        const response = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        expect(response.status).toBe(201);
        expect(verifyCapture.opts?.expectedCluster).toBe('testnet');
        const approvals = await workflowStore.listApprovals(WALLET_A);
        expect(approvals[0]!.cluster).toBe('testnet');
      });
    });

    it('returns 400 invalid_mandate_signature when the verifier rejects the mandate', async () => {
      await withServer({ rejectVerify: true }, async ({ port, workflowStore }) => {
        const response = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        expect(response.status).toBe(400);
        expect(String(response.body.error)).toContain('invalid_mandate_signature');
        const approvals = await workflowStore.listApprovals(WALLET_A);
        expect(approvals).toHaveLength(0);
      });
    });

    it('returns 400 when the verifier rejects a mandate-recipient mismatch (replay defense)', async () => {
      await withServer({ enforceRecipient: true }, async ({ port }) => {
        // Mandate recipient is WALLET_A; we POST as WALLET_B which should fail recipient binding.
        const response = await postJson(
          port,
          '/api/ap2/inbound',
          { mandate: makeMandate({ recipient: WALLET_A }) },
          WALLET_B,
        );
        expect(response.status).toBe(400);
        expect(String(response.body.error)).toContain('invalid_mandate_signature');
      });
    });

    it('returns 400 when the request body fails workflow validation', async () => {
      await withServer({ rejectValidate: true }, async ({ port, workflowStore }) => {
        const response = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        expect(response.status).toBe(400);
        expect(String(response.body.error)).toMatch(/invalid_mandate|forced_invalid_schema/);
        const approvals = await workflowStore.listApprovals(WALLET_A);
        expect(approvals).toHaveLength(0);
      });
    });

    it('returns 400 invalid_json for malformed JSON bodies', async () => {
      await withServer(undefined, async ({ port }) => {
        const response = await rawPost(port, '/api/ap2/inbound', '{not-json', WALLET_A);
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_json');
      });
    });

    it('returns 413 body_too_large when the payload exceeds the byte limit', async () => {
      await withServer(undefined, async ({ port }) => {
        const oversize = `{"pad":"${'A'.repeat(70 * 1024)}"}`;
        const response = await rawPost(port, '/api/ap2/inbound', oversize, WALLET_A);
        expect(response.status).toBe(413);
        expect(response.body.error).toBe('body_too_large');
      });
    });

    it('returns 405 method_not_allowed on PUT /api/ap2/inbound', async () => {
      await withServer(undefined, async ({ port }) => {
        const response = await putRequest(port, '/api/ap2/inbound', WALLET_A);
        expect(response.status).toBe(405);
        expect(response.body.error).toBe('method_not_allowed');
      });
    });
  });

  describe('GET /api/ap2/inbound', () => {
    it('returns {items: InboundMandate[]} scoped to session wallet, newest first', async () => {
      await withServer(undefined, async ({ port, workflowService }) => {
        const first = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate({ mandateId: 'm1' }) }, WALLET_A);
        const second = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate({ mandateId: 'm2' }) }, WALLET_A);
        await postJson(port, '/api/ap2/inbound', { mandate: makeMandate({ mandateId: 'm-other' }) }, WALLET_B);

        // Unrelated non-AP2 approval should be filtered out.
        await workflowService.createApproval(
          { walletAddress: WALLET_A },
          {
            kind: 'transfer_sol',
            summary: 'unrelated approval',
            amount: '1',
            recipient: WALLET_A,
            params: { amount: '1', recipient: WALLET_A },
            dueAt: '2026-05-15T00:00:00.000Z',
          },
        );

        const listed = await getJson(port, '/api/ap2/inbound', WALLET_A);
        expect(listed.status).toBe(200);
        const items = listed.body.items as InboundMandate[];
        expect(items).toHaveLength(2);
        expect(items.map((entry) => entry.inboundId)).toEqual([
          second.body.approvalId,
          first.body.approvalId,
        ]);
        for (const item of items) {
          expect(item.inboundId).toEqual(item.approvalId);
          expect(item.mandateSource.agentId).toBe('agent-test-1');
          expect(item.mandateSource.agentLabel).toBe('Test Operator');
          expect(item.tokenMint).toBe('So11111111111111111111111111111111111111112');
          expect(item.approvalStatus).toBe('ready');
          expect(item.createdAt).toBeTruthy();
        }

        const otherList = await getJson(port, '/api/ap2/inbound', WALLET_B);
        expect((otherList.body.items as unknown[])).toHaveLength(1);
      });
    });
  });

  describe('GET /api/ap2/inbound/:id', () => {
    it('returns {item, approval} for the owner', async () => {
      await withServer(undefined, async ({ port }) => {
        const created = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        const fetched = await getJson(port, `/api/ap2/inbound/${created.body.approvalId}`, WALLET_A);
        expect(fetched.status).toBe(200);
        const item = fetched.body.item as InboundMandate;
        expect(item.inboundId).toBe(created.body.approvalId);
        expect(item.mandateSource.agentLabel).toBe('Test Operator');
        const approval = fetched.body.approval as { id: string };
        expect(approval.id).toBe(created.body.approvalId);
      });
    });

    it('returns 404 when the approval is owned by another wallet', async () => {
      await withServer(undefined, async ({ port }) => {
        const created = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        const fetched = await getJson(port, `/api/ap2/inbound/${created.body.approvalId}`, WALLET_B);
        expect(fetched.status).toBe(404);
      });
    });

    it('returns 404 when the id points at a non-AP2 approval', async () => {
      await withServer(undefined, async ({ port, workflowService }) => {
        const unrelated = await workflowService.createApproval(
          { walletAddress: WALLET_A },
          {
            kind: 'transfer_sol',
            summary: 'unrelated',
            amount: '1',
            recipient: WALLET_A,
            params: { amount: '1', recipient: WALLET_A },
            dueAt: '2026-05-15T00:00:00.000Z',
          },
        );
        const fetched = await getJson(port, `/api/ap2/inbound/${unrelated.id}`, WALLET_A);
        expect(fetched.status).toBe(404);
      });
    });
  });

  describe('POST /api/ap2/inbound/:id/receipt', () => {
    it('returns 409 not_finalized when no confirmed finalization exists', async () => {
      await withServer(undefined, async ({ port, workflowStore, evidenceStore }) => {
        const created = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        const response = await postJson(port, `/api/ap2/inbound/${created.body.approvalId}/receipt`, {}, WALLET_A);
        expect(response.status).toBe(409);
        expect(response.body.error).toBe('not_finalized');
        const approval = await workflowStore.getApproval(WALLET_A, created.body.approvalId as string);
        expect(approval?.metadata?.ap2InboundReceiptId).toBeUndefined();
        const evidence = await evidenceStore.listEvidence(WALLET_A);
        expect(evidence).toHaveLength(0);
      });
    });

    it('builds and persists the AP2 receipt to evidence store after finalization', async () => {
      await withServer(undefined, async ({ port, workflowStore, evidenceStore }) => {
        const created = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        const approvalId = created.body.approvalId as string;
        const approval = (await workflowStore.getApproval(WALLET_A, approvalId))!;
        injectConfirmedFinalization(workflowStore, approval, 'TXSIGFIXTURE0001');

        const response = await postJson(port, `/api/ap2/inbound/${approvalId}/receipt`, {}, WALLET_A);
        expect(response.status).toBe(201);
        const receipt = response.body.receipt as Ap2InboundReceipt;
        expect(receipt.schema).toBe('ap2/inbound/0.1');
        expect(receipt.execution.txid).toBe('TXSIGFIXTURE0001');
        expect(receipt.approval.id).toBe(approvalId);
        expect(receipt.artifactHash).toBeTruthy();
        const evidenceId = response.body.evidenceId as string;
        expect(evidenceId).toMatch(/^evidence_ap2_/);

        // Evidence store has the canonical receipt
        const stored = await evidenceStore.getEvidence(WALLET_A, evidenceId);
        expect(stored).toBeDefined();
        expect(stored!.kind).toBe(AP2_EVIDENCE_KIND);
        expect(stored!.walletAddress).toBe(WALLET_A);
        expect(stored!.signature).toBe('TXSIGFIXTURE0001');
        expect(stored!.signingMessage).toContain('ap2-inbound:');
        expect(stored!.artifactHash).toBe(receipt.artifactHash);
        const storedMeta = stored!.metadata as { approvalId: string; mandateId: string };
        expect(storedMeta.approvalId).toBe(approvalId);
        expect(storedMeta.mandateId).toBe('mandate-fixture-1');

        // Approval carries back-pointer
        const refreshed = await workflowStore.getApproval(WALLET_A, approvalId);
        expect(refreshed?.metadata?.ap2InboundReceiptId).toBe(evidenceId);
        expect(refreshed?.metadata?.ap2InboundReceiptIssuedAt).toBeTruthy();

        // Evidence audit logged with txid and artifactHash (lives on evidenceStore)
        const auditEvents = evidenceStore.snapshotAuditEvents();
        const receiptAudits = auditEvents.filter((event) => event.type === 'ap2.inbound.receipt.created');
        expect(receiptAudits).toHaveLength(1);
        expect(receiptAudits[0]!.recordType).toBe('evidence');
        expect(receiptAudits[0]!.recordId).toBe(evidenceId);
        const receiptMeta = receiptAudits[0]!.metadata as { txid: string; approvalId: string; artifactHash: string };
        expect(receiptMeta.txid).toBe('TXSIGFIXTURE0001');
        expect(receiptMeta.approvalId).toBe(approvalId);
        expect(receiptMeta.artifactHash).toBe(receipt.artifactHash);
      });
    });

    it('is idempotent: second POST returns the same evidence record without writing a new audit event', async () => {
      await withServer(undefined, async ({ port, workflowStore, evidenceStore }) => {
        const created = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        const approvalId = created.body.approvalId as string;
        const approval = (await workflowStore.getApproval(WALLET_A, approvalId))!;
        injectConfirmedFinalization(workflowStore, approval, 'TXSIGFIXTURE0001');

        const first = await postJson(port, `/api/ap2/inbound/${approvalId}/receipt`, {}, WALLET_A);
        expect(first.status).toBe(201);
        const firstEvidenceId = first.body.evidenceId as string;
        const firstReceipt = first.body.receipt as Ap2InboundReceipt;

        const second = await postJson(port, `/api/ap2/inbound/${approvalId}/receipt`, {}, WALLET_A);
        expect(second.status).toBe(200);
        expect(second.body.idempotent).toBe(true);
        expect(second.body.evidenceId).toBe(firstEvidenceId);
        const secondReceipt = second.body.receipt as Ap2InboundReceipt;
        expect(secondReceipt.artifactHash).toBe(firstReceipt.artifactHash);

        const evidence = await evidenceStore.listEvidence(WALLET_A);
        expect(evidence).toHaveLength(1);
        const auditEvents = evidenceStore.snapshotAuditEvents();
        const receiptAudits = auditEvents.filter((event) => event.type === 'ap2.inbound.receipt.created');
        expect(receiptAudits).toHaveLength(1);
      });
    });

    it('returns 404 when the approval id is owned by another wallet', async () => {
      await withServer(undefined, async ({ port, workflowStore }) => {
        const created = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        const approvalId = created.body.approvalId as string;
        const approval = (await workflowStore.getApproval(WALLET_A, approvalId))!;
        injectConfirmedFinalization(workflowStore, approval, 'TXSIGFIXTURE0002');
        const response = await postJson(port, `/api/ap2/inbound/${approvalId}/receipt`, {}, WALLET_B);
        expect(response.status).toBe(404);
      });
    });
  });

  describe('GET /api/ap2/inbound/:id/receipt', () => {
    it('returns 404 receipt_not_built before any POST receipt call', async () => {
      await withServer(undefined, async ({ port }) => {
        const created = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        const response = await getJson(port, `/api/ap2/inbound/${created.body.approvalId}/receipt`, WALLET_A);
        expect(response.status).toBe(404);
        expect(response.body.error).toBe('receipt_not_built');
      });
    });

    it('returns the persisted receipt once it has been built', async () => {
      await withServer(undefined, async ({ port, workflowStore }) => {
        const created = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        const approvalId = created.body.approvalId as string;
        const approval = (await workflowStore.getApproval(WALLET_A, approvalId))!;
        injectConfirmedFinalization(workflowStore, approval, 'TXSIGFIXTURE0003');
        await postJson(port, `/api/ap2/inbound/${approvalId}/receipt`, {}, WALLET_A);

        const response = await getJson(port, `/api/ap2/inbound/${approvalId}/receipt`, WALLET_A);
        expect(response.status).toBe(200);
        const receipt = response.body.receipt as Ap2InboundReceipt;
        expect(receipt.execution.txid).toBe('TXSIGFIXTURE0003');
        expect(receipt.approval.id).toBe(approvalId);
        expect(response.body.evidenceId).toMatch(/^evidence_ap2_/);
      });
    });

    it('returns 404 when the approval id is owned by another wallet', async () => {
      await withServer(undefined, async ({ port, workflowStore }) => {
        const created = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        const approvalId = created.body.approvalId as string;
        const approval = (await workflowStore.getApproval(WALLET_A, approvalId))!;
        injectConfirmedFinalization(workflowStore, approval, 'TXSIGFIXTURE0004');
        await postJson(port, `/api/ap2/inbound/${approvalId}/receipt`, {}, WALLET_A);

        const response = await getJson(port, `/api/ap2/inbound/${approvalId}/receipt`, WALLET_B);
        expect(response.status).toBe(404);
      });
    });
  });

  // Reference EvidenceReceiptRecord for type assertion below (keeps the unused-import warning silent).
  it('EvidenceReceiptRecord is the persisted shape', () => {
    const sample: Pick<EvidenceReceiptRecord, 'kind'> = { kind: AP2_EVIDENCE_KIND };
    expect(sample.kind).toBe('ap2_inbound');
  });
});
