import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE_NAME } from '../cloud/cookies.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { createWalletSession } from '../cloud/session.js';
import type { Clock } from '../cloud/store.js';
import { createWorkflowApiHandler } from '../cloud/workflowRoutes.js';
import type { WorkflowStore } from '../cloud/workflowService.js';
import type {
  ApprovalRequestRecord,
  AuditEventRecord,
  CompletedRecord,
  JsonObject,
  PlanDraftRecord,
  WorkflowSession,
} from '../cloud/workflowValidation.js';
import { createRenderWebServer } from '../server.js';

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

const walletA = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const walletB = 'WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('cloud one-time workflow API', () => {
  it('is registered on the render server behind the wallet session cookie', async () => {
    const store = new MemoryWorkflowStore();
    const session = await createWalletSession({
      store,
      walletAddress: walletA,
      clock: fixedClock('2026-05-08T20:00:00.000Z'),
    });

    await withRenderWorkflowServer(store, async (port) => {
      const response = await requestJsonWithHeaders(port, 'POST', '/api/plans', createPlanBody(), {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      });

      expect(response.status).toBe(201);
      expect((response.body.plan as PlanDraftRecord).walletAddress).toBe(walletA);
    });
  });

  it('rejects workflow requests without a wallet session', async () => {
    await withWorkflowServer(async ({ port }) => {
      const response = await postJson(port, '/api/plans', createPlanBody(), null);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'unauthorized' });
    });
  });

  it('creates, lists, updates, and deletes signed-in plan drafts', async () => {
    await withWorkflowServer(async ({ port }) => {
      const created = await postJson(port, '/api/plans', createPlanBody(), walletA);
      expect(created.status).toBe(201);
      const plan = created.body.plan as PlanDraftRecord;

      expect(plan.id).toMatch(/^plan_/);
      expect(plan.walletAddress).toBe(walletA);
      expect(plan.status).toBe('draft');

      const listed = await getJson(port, '/api/plans', walletA);
      expect(listed.status).toBe(200);
      expect((listed.body.plans as PlanDraftRecord[]).map((entry) => entry.id)).toEqual([plan.id]);

      const contentUpdated = await patchJson(port, `/api/plans/${plan.id}`, {
        intent: 'Send 0.5 SOL to recipient',
        parameters: { recipient: 'Recipient111111111111111111111111111111111', amount: '0.5' },
        fields: [{ label: 'Amount SOL', value: '0.5' }],
      }, walletA);
      expect(contentUpdated.status).toBe(200);
      expect((contentUpdated.body.plan as PlanDraftRecord).intent).toBe('Send 0.5 SOL to recipient');
      expect((contentUpdated.body.plan as PlanDraftRecord).parameters.amount).toBe('0.5');

      const updated = await patchJson(port, `/api/plans/${plan.id}`, {
        status: 'signed',
        signature: 'sig_plan_review',
      }, walletA);
      expect(updated.status).toBe(200);
      expect((updated.body.plan as PlanDraftRecord).status).toBe('signed');
      expect((updated.body.plan as PlanDraftRecord).signature).toBe('sig_plan_review');

      const deleted = await deleteJson(port, `/api/plans/${plan.id}`, walletA);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ ok: true });

      const afterDelete = await getJson(port, '/api/plans', walletA);
      expect(afterDelete.body.plans).toEqual([]);
    });
  });

  it('creates approval requests and keeps only active items in the inbox', async () => {
    await withWorkflowServer(async ({ port }) => {
      const createdPlan = await postJson(port, '/api/plans', createPlanBody(), walletA);
      const plan = createdPlan.body.plan as PlanDraftRecord;

      const createdApproval = await postJson(port, '/api/approvals', { planDraftId: plan.id }, walletA);
      expect(createdApproval.status).toBe(201);
      const approval = createdApproval.body.approval as ApprovalRequestRecord;

      expect(approval.id).toMatch(/^approval_/);
      expect(approval.walletAddress).toBe(walletA);
      expect(approval.planDraftId).toBe(plan.id);
      expect(approval).not.toHaveProperty('planId');
      expect(approval.status).toBe('ready');
      expect(approval.summary).toBe('Send 0.25 SOL to recipient');

      const inbox = await getJson(port, '/api/approvals', walletA);
      expect((inbox.body.approvals as ApprovalRequestRecord[]).map((entry) => entry.id)).toEqual([approval.id]);

      const plans = await getJson(port, '/api/plans', walletA);
      const queuedPlan = (plans.body.plans as PlanDraftRecord[]).find((entry) => entry.id === plan.id);
      expect(queuedPlan?.status).toBe('queued');
      expect(queuedPlan?.approvalRequestId).toBe(approval.id);
    });
  });

  it('records approve, deny, and cancel decisions as completed history', async () => {
    await withWorkflowServer(async ({ port }) => {
      const decisionRoutes = [
        ['/approve', 'approved'],
        ['/deny', 'rejected'],
        ['/cancel', 'cancelled'],
      ] as const;

      for (const [route, status] of decisionRoutes) {
        const created = await postJson(port, '/api/approvals', {
          summary: `Decision ${status}`,
          kind: 'transfer_sol',
          params: { recipient: 'Recipient111', amount: '0.25' },
        }, walletA);
        const approval = created.body.approval as ApprovalRequestRecord;

        const decided = await postJson(port, `/api/approvals/${approval.id}${route}`, {
          proofSignature: `sig_${status}`,
          note: `${status} in wallet`,
        }, walletA);

        expect(decided.status).toBe(200);
        expect((decided.body.approval as ApprovalRequestRecord).status).toBe(status);
        const completed = decided.body.completed as CompletedRecord;
        expect(completed.status).toBe(status);
        expect(completed.kind).toBe('one_time');
        expect(completed.approvalRequestId).toBe(approval.id);
        expect(completed).not.toHaveProperty('approvalId');
        expect(completed.payload).toMatchObject({ type: 'one_time', approvalRequestId: approval.id });

        const repeat = await postJson(port, `/api/approvals/${approval.id}${route}`, {}, walletA);
        expect(repeat.status).toBe(409);
      }

      const inbox = await getJson(port, '/api/approvals', walletA);
      expect(inbox.body.approvals).toEqual([]);

      const completed = await getJson(port, '/api/completed', walletA);
      expect((completed.body.completed as CompletedRecord[]).map((entry) => entry.status).sort()).toEqual([
        'approved',
        'cancelled',
        'rejected',
      ]);
    });
  });

  it('rejects duplicate active approvals and protects queued plans from edits or deletion', async () => {
    await withWorkflowServer(async ({ port }) => {
      const createdPlan = await postJson(port, '/api/plans', createPlanBody(), walletA);
      const plan = createdPlan.body.plan as PlanDraftRecord;
      const firstApproval = await postJson(port, '/api/approvals', { planId: plan.id }, walletA);
      expect(firstApproval.status).toBe(201);

      const duplicateApproval = await postJson(port, '/api/approvals', { planDraftId: plan.id }, walletA);
      expect(duplicateApproval.status).toBe(409);
      expect(duplicateApproval.body.error).toBe('approval_exists');

      const contentEdit = await patchJson(port, `/api/plans/${plan.id}`, {
        prompt: 'Edit after queue',
      }, walletA);
      expect(contentEdit.status).toBe(409);
      expect(contentEdit.body.error).toBe('plan_not_editable');

      const deleted = await deleteJson(port, `/api/plans/${plan.id}`, walletA);
      expect(deleted.status).toBe(409);
      expect(deleted.body.error).toBe('plan_has_active_approval');
    });
  });

  it('requires wallet proof for approve and deny decisions but permits proofless cancel', async () => {
    await withWorkflowServer(async ({ port }) => {
      for (const route of ['/approve', '/deny'] as const) {
        const created = await postJson(port, '/api/approvals', {
          summary: `Proof required ${route}`,
          kind: 'transfer_sol',
          params: {},
        }, walletA);
        const approval = created.body.approval as ApprovalRequestRecord;

        const missingProof = await postJson(port, `/api/approvals/${approval.id}${route}`, {}, walletA);
        expect(missingProof.status).toBe(400);
        expect(missingProof.body.error).toBe('missing_decision_proof');
      }

      const cancellable = await postJson(port, '/api/approvals', {
        summary: 'Proofless cancel',
        kind: 'transfer_sol',
        params: {},
      }, walletA);
      const approval = cancellable.body.approval as ApprovalRequestRecord;
      const cancelled = await postJson(port, `/api/approvals/${approval.id}/cancel`, {}, walletA);
      expect(cancelled.status).toBe(200);
      expect((cancelled.body.approval as ApprovalRequestRecord).status).toBe('cancelled');
    });
  });

  it('scopes all workflow records to the signed-in wallet', async () => {
    await withWorkflowServer(async ({ port }) => {
      const createdPlan = await postJson(port, '/api/plans', createPlanBody(), walletA);
      const plan = createdPlan.body.plan as PlanDraftRecord;
      const createdApproval = await postJson(port, '/api/approvals', { planId: plan.id }, walletA);
      const approval = createdApproval.body.approval as ApprovalRequestRecord;
      const decided = await postJson(port, `/api/approvals/${approval.id}/approve`, {
        proofSignature: 'sig_wallet_a',
      }, walletA);
      const completed = decided.body.completed as CompletedRecord;

      expect((await getJson(port, '/api/plans', walletB)).body.plans).toEqual([]);
      expect((await getJson(port, '/api/approvals', walletB)).body.approvals).toEqual([]);
      expect((await getJson(port, '/api/completed', walletB)).body.completed).toEqual([]);

      expect((await patchJson(port, `/api/plans/${plan.id}`, { status: 'archived' }, walletB)).status).toBe(404);
      expect((await postJson(port, `/api/approvals/${approval.id}/deny`, {}, walletB)).status).toBe(404);
      expect((await deleteJson(port, `/api/completed/${completed.id}`, walletB)).status).toBe(404);
    });
  });

  it('rejects private keys, delegated signers, and unlimited approval authority', async () => {
    await withWorkflowServer(async ({ port }) => {
      const privateKey = await postJson(port, '/api/plans', {
        ...createPlanBody(),
        privateKey: 'not-allowed',
      }, walletA);
      const delegatedSigner = await postJson(port, '/api/approvals', {
        summary: 'Bad delegated signer',
        delegatedSigner: 'server-wallet',
      }, walletA);
      const unlimitedAuthority = await postJson(port, '/api/approvals', {
        summary: 'Bad unlimited approval',
        approvalAuthority: 'unlimited',
      }, walletA);

      expect(privateKey.status).toBe(400);
      expect(delegatedSigner.status).toBe(400);
      expect(unlimitedAuthority.status).toBe(400);
    });
  });

  it('deletes completed history records for the signed-in wallet', async () => {
    await withWorkflowServer(async ({ port }) => {
      const approvalResponse = await postJson(port, '/api/approvals', {
        summary: 'Delete completed record',
        params: {},
      }, walletA);
      const approval = approvalResponse.body.approval as ApprovalRequestRecord;
      const decided = await postJson(port, `/api/approvals/${approval.id}/cancel`, {}, walletA);
      const completed = decided.body.completed as CompletedRecord;

      const deleted = await deleteJson(port, `/api/completed/${completed.id}`, walletA);
      expect(deleted.status).toBe(200);

      const listed = await getJson(port, '/api/completed', walletA);
      expect(listed.body.completed).toEqual([]);
    });
  });
});

function createPlanBody(): Record<string, unknown> {
  return {
    plan: samplePlan(),
    source: 'template',
    templateId: 'transfer-sol',
    templateTitle: 'Send SOL',
    prompt: 'Send 0.25 SOL',
    cluster: 'devnet',
  };
}

function samplePlan(): JsonObject {
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
      recipient: 'Recipient111111111111111111111111111111111',
      amount: '0.25',
      memo: 'Test payment',
    },
    fields: [
      { label: 'Recipient address', value: 'Recipient111111111111111111111111111111111' },
      { label: 'Amount SOL', value: '0.25' },
    ],
    safeguards: ['Wallet approval is required.'],
  };
}

async function withWorkflowServer(
  callback: (server: { port: number; store: TestWorkflowStore }) => Promise<void>,
): Promise<void> {
  const store = new TestWorkflowStore();
  const handler = createWorkflowApiHandler({
    store,
    getSession(req): WorkflowSession | null {
      const wallet = req.headers['x-test-wallet'];
      return typeof wallet === 'string' && wallet ? { walletAddress: wallet } : null;
    },
  });
  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    }, (err: unknown) => {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : 'error');
    });
  });

  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback({ port: address.port, store });
  } finally {
    await close(server);
  }
}

async function withRenderWorkflowServer(
  store: MemoryWorkflowStore,
  callback: (port: number) => Promise<void>,
): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-render-web-workflow-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(staticDir, 'app'));
  await writeFile(join(staticDir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');
  const server = createRenderWebServer({
    staticDir,
    store,
    clock: fixedClock('2026-05-08T20:00:00.000Z'),
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

function postJson(port: number, path: string, body: unknown, walletAddress: string | null = walletA): Promise<TestResponse> {
  return jsonRequest(port, 'POST', path, body, walletAddress);
}

function patchJson(port: number, path: string, body: unknown, walletAddress: string | null = walletA): Promise<TestResponse> {
  return jsonRequest(port, 'PATCH', path, body, walletAddress);
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
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
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

function requestJsonWithHeaders(
  port: number,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestHeaders: Record<string, string | number> = { ...headers };
    if (payload !== undefined) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = Buffer.byteLength(payload);
    }

    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: requestHeaders,
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

function fixedClock(value: string): Clock {
  return {
    now: () => new Date(value),
  };
}

class TestWorkflowStore implements WorkflowStore {
  private readonly plans = new Map<string, PlanDraftRecord>();
  private readonly approvals = new Map<string, ApprovalRequestRecord>();
  private readonly completed = new Map<string, CompletedRecord>();
  readonly auditEvents: AuditEventRecord[] = [];

  async listPlans(walletAddress: string): Promise<PlanDraftRecord[]> {
    return [...this.plans.values()].filter((record) => record.walletAddress === walletAddress).map(clone);
  }

  async getPlan(walletAddress: string, id: string): Promise<PlanDraftRecord | undefined> {
    return ownerClone(this.plans.get(id), walletAddress);
  }

  async savePlan(_walletAddress: string, record: PlanDraftRecord): Promise<void> {
    this.plans.set(record.id, clone(record));
  }

  async deletePlan(walletAddress: string, id: string): Promise<boolean> {
    const record = this.plans.get(id);
    if (!record || record.walletAddress !== walletAddress) return false;
    return this.plans.delete(id);
  }

  async listApprovals(walletAddress: string): Promise<ApprovalRequestRecord[]> {
    return [...this.approvals.values()].filter((record) => record.walletAddress === walletAddress).map(clone);
  }

  async getApproval(walletAddress: string, id: string): Promise<ApprovalRequestRecord | undefined> {
    return ownerClone(this.approvals.get(id), walletAddress);
  }

  async saveApproval(_walletAddress: string, record: ApprovalRequestRecord): Promise<void> {
    this.approvals.set(record.id, clone(record));
  }

  async listCompleted(walletAddress: string): Promise<CompletedRecord[]> {
    return [...this.completed.values()].filter((record) => record.walletAddress === walletAddress).map(clone);
  }

  async getCompleted(walletAddress: string, id: string): Promise<CompletedRecord | undefined> {
    return ownerClone(this.completed.get(id), walletAddress);
  }

  async saveCompleted(_walletAddress: string, record: CompletedRecord): Promise<void> {
    this.completed.set(record.id, clone(record));
  }

  async deleteCompleted(walletAddress: string, id: string): Promise<boolean> {
    const record = this.completed.get(id);
    if (!record || record.walletAddress !== walletAddress) return false;
    return this.completed.delete(id);
  }

  async appendAuditEvent(_walletAddress: string, record: AuditEventRecord): Promise<void> {
    this.auditEvents.push(clone(record));
  }
}

function ownerClone<T extends { walletAddress: string }>(record: T | undefined, walletAddress: string): T | undefined {
  if (!record || record.walletAddress !== walletAddress) return undefined;
  return clone(record);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
