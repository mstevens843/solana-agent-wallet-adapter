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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AP2_INBOUND_ACTION_SOURCE, createAp2ApiHandler, type Ap2RouteAdapter } from '../cloud/ap2Routes.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import type { Clock } from '../cloud/store.js';
import { WorkflowService } from '../cloud/workflowService.js';

const WALLET_A = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const WALLET_B = 'BvgrFr5Bcaa9NudH3DCxgMnHV1FT1nzD5JtMHsmpKnFB';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

interface ServerHandle {
  port: number;
  workflowStore: MemoryWorkflowStore;
  workflowService: WorkflowService;
  server: Server;
  adapter: Ap2RouteAdapter;
}

const FROZEN_NOW = new Date('2026-05-14T12:00:00.000Z');

function fixedClock(): Clock {
  return { now: () => FROZEN_NOW };
}

function makeMandate(overrides: Partial<{ mandateId: string; agentId: string; recipient: string; amount: string }> = {}): Ap2Mandate {
  return {
    mandateId: overrides.mandateId ?? 'mandate-fixture-1',
    mandateType: 'intent_mandate',
    protocolVersion: 'ap2/0.1',
    issuedAt: '2026-05-14T11:00:00.000Z',
    expiresAt: '2026-05-14T13:00:00.000Z',
    agent: {
      agentId: overrides.agentId ?? 'agent-test-1',
      agentLabel: 'Test Operator',
      publicKey: '11111111111111111111111111111111',
    },
    signature: 'signature-fixture',
    signedFields: {},
    intent: {
      description: 'Test inbound payment.',
      cap: {
        amount: overrides.amount ?? '12.345',
        tokenSymbol: 'USDC',
        tokenMint: USDC_MINT,
        recipient: overrides.recipient ?? WALLET_A,
        cluster: 'mainnet-beta',
      },
    },
  } as Ap2Mandate;
}

function makeFakeAdapter(opts: {
  rejectVerify?: boolean;
  rejectValidate?: boolean;
} = {}): Ap2RouteAdapter {
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
      return { mandate, receivedAt: '2026-05-14T12:00:00.000Z' };
    },
    verifyMandate(mandate) {
      if (opts.rejectVerify) {
        throw new Error('forced_invalid_signature');
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
      const cap = (mandate as { intent: { cap: Ap2InboundApprovalParams } }).intent.cap;
      return {
        kind: 'transfer_spl',
        summary: `AP2 inbound: ${agent.agentLabel} requests ${(cap as unknown as { amount: string }).amount} USDC to ${walletAddress}`,
        cluster: 'mainnet-beta' as Ap2Cluster,
        amount: (cap as unknown as { amount: string }).amount,
        token: 'USDC',
        recipient: walletAddress,
        params: {
          fromAddress: walletAddress,
          toAddress: walletAddress,
          amount: (cap as unknown as { amount: string }).amount,
          tokenMint: USDC_MINT,
          tokenSymbol: 'USDC',
        },
        metadata: {
          connectorId: 'ap2',
          actionSource: AP2_INBOUND_ACTION_SOURCE,
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
          tokenSymbol: 'USDC',
          tokenMint: USDC_MINT,
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

async function startServer(adapter: Ap2RouteAdapter): Promise<ServerHandle> {
  const workflowStore = new MemoryWorkflowStore();
  const workflowService = new WorkflowService(workflowStore);
  const handler = createAp2ApiHandler({
    workflowService,
    workflowStore,
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
  return { port: address.port, workflowStore, workflowService, server, adapter };
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

async function withServer(adapter: Ap2RouteAdapter | undefined, run: (h: ServerHandle) => Promise<void>): Promise<void> {
  handle = await startServer(adapter ?? makeFakeAdapter());
  await run(handle);
}

function postJson(port: number, path: string, body: unknown, wallet: string | null = WALLET_A): Promise<TestResponse> {
  return request(port, 'POST', path, body, wallet);
}

function getJson(port: number, path: string, wallet: string | null = WALLET_A): Promise<TestResponse> {
  return request(port, 'GET', path, undefined, wallet);
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

    it('creates an AP2 inbound approval, persists metadata, and writes an audit event', async () => {
      await withServer(undefined, async ({ port, workflowStore }) => {
        const response = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        expect(response.status).toBe(201);
        const inboundId = response.body.inboundId as string;
        const approvalId = response.body.approvalId as string;
        expect(inboundId).toEqual(approvalId);
        expect((response.body.agent as { agentId: string }).agentId).toBe('agent-test-1');

        const approvals = await workflowStore.listApprovals(WALLET_A);
        expect(approvals).toHaveLength(1);
        const approval = approvals[0]!;
        expect(approval.id).toBe(inboundId);
        expect(approval.kind).toBe('transfer_spl');
        expect(approval.metadata?.actionSource).toBe(AP2_INBOUND_ACTION_SOURCE);
        expect(approval.metadata?.ap2MandateId).toBe('mandate-fixture-1');
        const agentMeta = approval.metadata?.ap2VerifiedAgent as { agentId: string; publicKey: string };
        expect(agentMeta.agentId).toBe('agent-test-1');
        expect(agentMeta.publicKey).toBe('11111111111111111111111111111111');

        const audits = await workflowStore.forWallet(WALLET_A).listAuditEvents();
        const ap2Audits = audits.filter((event) => event.type === 'ap2.inbound.created');
        expect(ap2Audits).toHaveLength(1);
        expect(ap2Audits[0]!.recordId).toBe(approval.id);
        expect((ap2Audits[0]!.metadata as { sourceAgentId: string }).sourceAgentId).toBe('agent-test-1');
      });
    });

    it('returns 400 invalid_mandate_signature when the verifier rejects the mandate', async () => {
      const adapter = makeFakeAdapter({ rejectVerify: true });
      await withServer(adapter, async ({ port, workflowStore }) => {
        const response = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        expect(response.status).toBe(400);
        expect(String(response.body.error)).toContain('invalid_mandate_signature');
        const approvals = await workflowStore.listApprovals(WALLET_A);
        expect(approvals).toHaveLength(0);
      });
    });

    it('returns 400 when the request body fails workflow validation', async () => {
      const adapter = makeFakeAdapter({ rejectValidate: true });
      await withServer(adapter, async ({ port, workflowStore }) => {
        const response = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        expect(response.status).toBe(400);
        expect(String(response.body.error)).toMatch(/invalid_mandate|forced_invalid_schema/);
        const approvals = await workflowStore.listApprovals(WALLET_A);
        expect(approvals).toHaveLength(0);
      });
    });
  });

  describe('GET /api/ap2/inbound', () => {
    it('returns only AP2 inbound approvals for the session wallet, sorted newest first', async () => {
      await withServer(undefined, async ({ port, workflowService }) => {
        const first = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate({ mandateId: 'm1' }) }, WALLET_A);
        const second = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate({ mandateId: 'm2' }) }, WALLET_A);
        await postJson(port, '/api/ap2/inbound', { mandate: makeMandate({ mandateId: 'm-other' }) }, WALLET_B);

        await workflowService.createApproval(
          { walletAddress: WALLET_A },
          {
            kind: 'transfer_sol',
            summary: 'unrelated approval',
            params: { amount: '1' },
            dueAt: '2026-05-15T00:00:00.000Z',
          },
        );

        const listed = await getJson(port, '/api/ap2/inbound', WALLET_A);
        expect(listed.status).toBe(200);
        const inbound = listed.body.inbound as Array<{ id: string; metadata: Record<string, unknown> }>;
        expect(inbound).toHaveLength(2);
        expect(inbound.map((entry) => entry.id)).toEqual([second.body.approvalId, first.body.approvalId]);
        for (const entry of inbound) {
          expect(entry.metadata.actionSource).toBe(AP2_INBOUND_ACTION_SOURCE);
        }

        const otherList = await getJson(port, '/api/ap2/inbound', WALLET_B);
        expect((otherList.body.inbound as unknown[])).toHaveLength(1);
      });
    });
  });

  describe('GET /api/ap2/inbound/:id', () => {
    it('returns the single AP2 inbound approval for the owner', async () => {
      await withServer(undefined, async ({ port }) => {
        const created = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        const fetched = await getJson(port, `/api/ap2/inbound/${created.body.approvalId}`, WALLET_A);
        expect(fetched.status).toBe(200);
        expect((fetched.body.inbound as { id: string }).id).toBe(created.body.approvalId);
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
            params: {},
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
      await withServer(undefined, async ({ port, workflowStore }) => {
        const created = await postJson(port, '/api/ap2/inbound', { mandate: makeMandate() }, WALLET_A);
        const response = await postJson(port, `/api/ap2/inbound/${created.body.approvalId}/receipt`, {}, WALLET_A);
        expect(response.status).toBe(409);
        expect(response.body.error).toBe('not_finalized');
        const approval = await workflowStore.getApproval(WALLET_A, created.body.approvalId as string);
        expect(approval?.metadata?.ap2InboundReceipt).toBeUndefined();
      });
    });

    it('builds and persists the AP2 receipt once a confirmed finalization exists', async () => {
      await withServer(undefined, async ({ port, workflowStore }) => {
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

        const refreshed = await workflowStore.getApproval(WALLET_A, approvalId);
        expect(refreshed?.metadata?.ap2InboundReceipt).toBeDefined();
        expect((refreshed?.metadata?.ap2InboundReceipt as Ap2InboundReceipt).execution.txid).toBe('TXSIGFIXTURE0001');

        const audits = await workflowStore.forWallet(WALLET_A).listAuditEvents();
        const receiptAudits = audits.filter((event) => event.type === 'ap2.inbound.receipt.created');
        expect(receiptAudits).toHaveLength(1);
        expect((receiptAudits[0]!.metadata as { txid: string }).txid).toBe('TXSIGFIXTURE0001');
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
});
