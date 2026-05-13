import { generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { workflowFinalizationProofMessage } from '@solana-agent-wallet-adapter/workflow';

import { SESSION_COOKIE_NAME } from '../cloud/cookies.js';
import { encodeBase58 } from '../cloud/auth.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { createWalletSession } from '../cloud/session.js';
import type { Clock } from '../cloud/store.js';
import { createWorkflowApiHandler } from '../cloud/workflowRoutes.js';
import { WorkflowService, workflowDecisionProofMessage, type TransactionVerifier, type WorkflowStore } from '../cloud/workflowService.js';
import type {
  ApprovalRequestRecord,
  AuditEventRecord,
  CompletedRecord,
  JsonObject,
  PlanDraftRecord,
  TransactionFinalizationRecord,
  WorkflowSession,
} from '../cloud/workflowValidation.js';
import { createRenderWebServer } from '../server.js';

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

  it('returns precise validation errors for malformed ids and oversized JSON bodies', async () => {
    await withWorkflowServer(async ({ port }) => {
      const malformedId = await patchJson(port, '/api/plans/%E0%A4%A', {}, walletA);
      expect(malformedId.status).toBe(400);
      expect(malformedId.body.error).toBe('invalid_id');

      const oversized = await postJson(port, '/api/plans', { value: 'x'.repeat(70 * 1024) }, walletA);
      expect(oversized.status).toBe(413);
      expect(oversized.body.error).toBe('body_too_large');
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

  it('attaches guardrail metadata and rejects unsafe or underspecified workflow records', async () => {
    await withWorkflowServer(async ({ port, store }) => {
      const created = await postJson(port, '/api/plans', createPlanBody(), walletA);
      const plan = created.body.plan as PlanDraftRecord;
      expect(plan.riskMetadata).toMatchObject({
        guardrailVerdict: 'pass',
        finalizationRequirement: 'transaction_preview',
        constraintFingerprint: expect.any(String),
        constraintHash: expect.any(String),
        aiGuardrails: {
          verdict: 'pass',
          actionType: 'transfer_sol',
          constraintHash: expect.any(String),
        },
      });
      const originalConstraintHash = plan.riskMetadata?.constraintHash;
      expect(store.auditEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'plan.guardrail.checked',
          metadata: expect.objectContaining({
            guardrailVerdict: 'pass',
            finalizationRequirement: 'transaction_preview',
            constraintHash: expect.any(String),
          }),
        }),
        expect.objectContaining({
          type: 'plan.created',
          metadata: expect.objectContaining({
            guardrailVerdict: 'pass',
            finalizationRequirement: 'transaction_preview',
            constraintHash: expect.any(String),
          }),
        }),
      ]));

      const updated = await patchJson(port, `/api/plans/${plan.id}`, {
        parameters: { ...plan.parameters, amount: '0.5' },
      }, walletA);
      expect(updated.status).toBe(200);
      const updatedPlan = updated.body.plan as PlanDraftRecord;
      expect(updatedPlan.riskMetadata?.constraintHash).toEqual(expect.any(String));
      expect(updatedPlan.riskMetadata?.constraintHash).not.toBe(originalConstraintHash);
      expect(store.auditEvents.filter((event) => event.type === 'plan.guardrail.checked').length).toBeGreaterThanOrEqual(2);

      const queued = await postJson(port, '/api/approvals', { planDraftId: plan.id }, walletA);
      expect(queued.status).toBe(201);
      expect(store.auditEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'approval.created',
          metadata: expect.objectContaining({
            guardrailVerdict: 'pass',
            finalizationRequirement: 'transaction_preview',
            constraintHash: expect.any(String),
          }),
        }),
      ]));

      const unsafeAiPlan = await postJson(port, '/api/plans', {
        ...createPlanBody(),
        source: 'ai',
        plan: {
          ...samplePlan(),
          source: 'ai',
          route: 'No wallet approval required.',
          risk: 'Risk-free.',
          approval: 'Already signed.',
        },
      }, walletA);
      expect(unsafeAiPlan.status).toBe(400);
      expect(unsafeAiPlan.body.error).toBe('ai_guardrail_blocked');

      const missingRecipient = await postJson(port, '/api/approvals', {
        summary: 'Missing transfer recipient',
        kind: 'transfer_sol',
        params: { amountSol: '0.25' },
      }, walletA);
      expect(missingRecipient.status).toBe(400);
      expect(missingRecipient.body.error).toBe('ai_guardrail_blocked');
      expect(String(missingRecipient.body.message)).toContain('Recipient');
    });
  });

  it('rejects unsupported executable cloud approvals before they enter the inbox', async () => {
    await withWorkflowServer(async ({ port }) => {
      const splApproval = await postJson(port, '/api/approvals', {
        summary: 'Unsupported token transfer',
        kind: 'transfer_spl',
        params: { token: 'USDC', recipient: 'Recipient111', amount: '5' },
      }, walletA);
      expect(splApproval.status).toBe(409);
      expect(splApproval.body.error).toBe('unsupported_cloud_finalization_kind');

      const customApproval = await postJson(port, '/api/approvals', {
        summary: 'Unsupported custom transaction',
        kind: 'custom_transaction',
        params: { transactionBase64: 'AAAA' },
      }, walletA);
      expect(customApproval.status).toBe(409);
      expect(customApproval.body.error).toBe('unsupported_cloud_finalization_kind');
    });
  });

  it('stores and queues Blink draft approvals for browser-local wallet execution', async () => {
    await withWorkflowServer(async ({ port }) => {
      const createdPlan = await postJson(port, '/api/plans', createBlinkPlanBody(), walletA);
      expect(createdPlan.status).toBe(201);
      const plan = createdPlan.body.plan as PlanDraftRecord;
      expect(plan).toMatchObject({
        actionType: 'blink_action',
        metadata: {
          connectorId: 'jupiter',
          protocol: 'Jupiter',
          operation: 'swap',
        },
      });

      const queuedFromPlan = await postJson(port, '/api/approvals', { planDraftId: plan.id }, walletA);
      expect(queuedFromPlan.status).toBe(201);
      const approval = queuedFromPlan.body.approval as ApprovalRequestRecord;
      expect(approval).toMatchObject({
        kind: 'blink_action',
        planDraftId: plan.id,
        finalizationRequirement: 'transaction_preview',
        executionMode: 'wallet_execute',
        params: {
          blinkUrl: 'https://actions.example.com/swap?input=SOL&output=USDC',
          actionUrl: 'https://actions.example.com/swap?input=SOL&output=USDC',
          connectorActionSource: 'blink',
        },
        finalizationSupport: {
          required: true,
          supported: false,
          reason: 'Blink transaction bytes are resolved in the browser before wallet approval.',
        },
        metadata: {
          connectorId: 'jupiter',
          protocol: 'Jupiter',
          operation: 'swap',
          amount: '0.1',
          expectedToken: 'USDC',
          expectedRecipient: walletB,
          connectorActionSource: 'blink',
          finalizationSupport: {
            mode: 'browser_local',
            reason: 'Blink transaction bytes are resolved in the browser before wallet approval.',
          },
        },
      });

      const serverPrepare = await postJson(port, `/api/approvals/${approval.id}/finalization/prepare`, {}, walletA);
      expect(serverPrepare.status).toBe(409);
      expect(serverPrepare.body.error).toBe('unsupported_cloud_finalization_kind');
      expect(serverPrepare.body.message).toBe('Blink transaction bytes are resolved in the browser before wallet approval.');

      const directApproval = await postJson(port, '/api/approvals', {
        summary: 'Prepare Kamino Blink',
        kind: 'blink_action',
        params: {
          actionUrl: 'solana-action:https%3A%2F%2Factions.example.com%2Fkamino%2Fdeposit',
          protocol: 'Kamino',
          operation: 'deposit',
          amount: '5',
          expectedToken: 'USDC',
        },
        metadata: {
          connectorId: 'kamino',
        },
      }, walletA);
      expect(directApproval.status).toBe(201);
      expect(directApproval.body.approval).toMatchObject({
        kind: 'blink_action',
        params: {
          blinkUrl: 'https://actions.example.com/kamino/deposit',
          actionUrl: 'https://actions.example.com/kamino/deposit',
        },
        metadata: {
          connectorId: 'kamino',
          protocol: 'Kamino',
          operation: 'deposit',
          connectorActionSource: 'blink',
        },
      });

      const submitted = await postJson(port, `/api/approvals/${approval.id}/wallet-execution`, {
        ...decisionProofBody(approval, 'approved'),
        txid: 'blink_tx_pending',
        txStatus: 'pending',
        explorerUrl: 'https://solscan.io/tx/blink_tx_pending',
      }, walletA);
      expect(submitted.status).toBe(200);
      expect(submitted.body.completed).toBeUndefined();
      expect(submitted.body.approval).toMatchObject({
        id: approval.id,
        status: 'approval_pending',
        txid: 'blink_tx_pending',
        txStatus: 'pending',
        decisionProofVerified: true,
        metadata: expect.objectContaining({
          walletExecutionSource: 'browser_wallet_adapter',
          executionMode: 'wallet_execute',
        }),
      });

      const confirmed = await postJson(port, `/api/approvals/${approval.id}/wallet-execution`, {
        txid: 'blink_tx_pending',
        txStatus: 'confirmed',
        explorerUrl: 'https://solscan.io/tx/blink_tx_pending',
      }, walletA);
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.approval).toMatchObject({
        id: approval.id,
        status: 'approved',
        txid: 'blink_tx_pending',
        txStatus: 'confirmed',
      });
      expect(confirmed.body.completed).toMatchObject({
        approvalRequestId: approval.id,
        status: 'approved',
        txid: 'blink_tx_pending',
        txStatus: 'confirmed',
      });
    });
  });

  it('rejects executable Blink approvals without a valid Blink URL', async () => {
    await withWorkflowServer(async ({ port }) => {
      const missing = await postJson(port, '/api/approvals', {
        summary: 'Missing Blink URL',
        kind: 'blink_action',
        params: { protocol: 'Jupiter', operation: 'swap' },
      }, walletA);
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe('missing_blink_url');

      const invalid = await postJson(port, '/api/approvals', {
        summary: 'Invalid Blink URL',
        kind: 'blink_action',
        params: { blinkUrl: 'http://actions.example.com/swap' },
      }, walletA);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe('invalid_blink_url');
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

  it('returns the existing active approval for duplicate recurring occurrences', async () => {
    await withWorkflowServer(async ({ port }) => {
      const body = {
        summary: 'Recurring payout',
        kind: 'transfer_sol',
        params: {
          recurringScheduleId: 'recurring_1',
          recurringOccurrenceId: 'occurrence_1',
          occurrenceKey: '2026-05-08T20:10:00.000Z',
          recipient: 'Recipient111111111111111111111111111111111',
          amountSol: '0.25',
        },
        recurringScheduleId: 'recurring_1',
        recurringOccurrenceId: 'occurrence_1',
        occurrenceKey: '2026-05-08T20:10:00.000Z',
      };

      const first = await postJson(port, '/api/approvals', body, walletA);
      const second = await postJson(port, '/api/approvals', body, walletA);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect((second.body.approval as ApprovalRequestRecord).id)
        .toBe((first.body.approval as ApprovalRequestRecord).id);

      const inbox = await getJson(port, '/api/approvals', walletA);
      expect(inbox.body.approvals).toHaveLength(1);
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
          kind: 'manual_review',
          params: { reason: `Decision ${status}` },
        }, walletA);
        const approval = created.body.approval as ApprovalRequestRecord;

        const decided = await postJson(port, `/api/approvals/${approval.id}${route}`, {
          ...(status === 'cancelled' ? {} : decisionProofBody(approval, status)),
          note: `${status} in wallet`,
        }, walletA);

        expect(decided.status).toBe(200);
        const terminalApproval = decided.body.approval as ApprovalRequestRecord;
        expect(terminalApproval.status).toBe(status);
        expect(terminalApproval.decidedAt).toBeDefined();
        expect(terminalApproval.confirmedAt).toBeUndefined();
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

  it('rejects transaction fields on proof-only approval decisions', async () => {
    await withWorkflowServer(async ({ port }) => {
      const created = await postJson(port, '/api/approvals', {
        summary: 'Explorer URL decision',
        kind: 'manual_review',
        params: { recipient: 'Recipient111', amount: '0.25' },
      }, walletA);
      const approval = created.body.approval as ApprovalRequestRecord;

      const decided = await postJson(port, `/api/approvals/${approval.id}/approve`, {
        ...decisionProofBody(approval, 'approved'),
        txid: 'tx_explorer_url',
        explorerUrl: 'https://explorer.solana.com/tx/tx_explorer_url?cluster=devnet',
      }, walletA);

      expect(decided.status).toBe(400);
      expect(decided.body.error).toBe('proof_only_tx_fields_not_allowed');
    });
  });

  it('requires finalization for direct money-moving approvals', async () => {
    await withWorkflowServer(async ({ port }) => {
      const created = await postJson(port, '/api/approvals', {
        summary: 'Direct transfer approve',
        kind: 'transfer_sol',
        params: { recipient: 'Recipient111', amountSol: '0.25' },
      }, walletA);
      const approval = created.body.approval as ApprovalRequestRecord;

      const decided = await postJson(port, `/api/approvals/${approval.id}/approve`, {
        ...decisionProofBody(approval, 'approved'),
      }, walletA);

      expect(decided.status).toBe(409);
      expect(decided.body.error).toBe('transaction_finalization_required');
    });
  });

  it('records browser-wallet Cloud swap execution without a bridge signer', async () => {
    await withWorkflowServer(async ({ port }) => {
      const created = await postJson(port, '/api/approvals', {
        summary: 'Swap SOL to USDC',
        kind: 'swap',
        params: {
          inputToken: 'SOL',
          outputToken: 'USDC',
          amount: '0.1',
          slippageBps: '50',
        },
        cluster: 'mainnet-beta',
      }, walletA);
      const approval = created.body.approval as ApprovalRequestRecord;

      const directApprove = await postJson(port, `/api/approvals/${approval.id}/approve`, {
        ...decisionProofBody(approval, 'approved'),
      }, walletA);
      expect(directApprove.status).toBe(409);
      expect(directApprove.body.error).toBe('transaction_finalization_required');

      const pending = await postJson(port, `/api/approvals/${approval.id}/wallet-execution`, {
        ...decisionProofBody(approval, 'approved'),
        txid: 'swap_tx_pending',
        txStatus: 'pending',
        explorerUrl: 'https://solscan.io/tx/swap_tx_pending',
        metadata: { transactionBoundary: 'browser_wallet_adapter_v1' },
      }, walletA);

      expect(pending.status).toBe(200);
      expect(pending.body.completed).toBeUndefined();
      expect(pending.body.approval).toMatchObject({
        id: approval.id,
        status: 'approval_pending',
        txid: 'swap_tx_pending',
        txStatus: 'pending',
        decisionProofVerified: true,
        metadata: expect.objectContaining({
          executionMode: 'wallet_execute',
          walletExecutionSource: 'browser_wallet_adapter',
        }),
      });

      const inbox = await getJson(port, '/api/approvals', walletA);
      expect((inbox.body.approvals as ApprovalRequestRecord[]).map((entry) => entry.id)).toEqual([approval.id]);

      const confirmed = await postJson(port, `/api/approvals/${approval.id}/wallet-execution`, {
        txid: 'swap_tx_pending',
        txStatus: 'confirmed',
        explorerUrl: 'https://solscan.io/tx/swap_tx_pending',
      }, walletA);

      expect(confirmed.status).toBe(200);
      expect(confirmed.body.approval).toMatchObject({
        id: approval.id,
        status: 'approved',
        txid: 'swap_tx_pending',
        txStatus: 'confirmed',
      });
      expect(confirmed.body.completed).toMatchObject({
        approvalRequestId: approval.id,
        status: 'approved',
        txid: 'swap_tx_pending',
        txStatus: 'confirmed',
      });

      const failedCreated = await postJson(port, '/api/approvals', {
        summary: 'Retryable swap failure',
        kind: 'swap',
        params: {
          inputToken: 'SOL',
          outputToken: 'USDC',
          amount: '0.1',
          slippageBps: '50',
        },
      }, walletA);
      const failedApproval = failedCreated.body.approval as ApprovalRequestRecord;
      const failed = await postJson(port, `/api/approvals/${failedApproval.id}/wallet-execution`, {
        ...decisionProofBody(failedApproval, 'approved'),
        txid: 'swap_tx_failed',
        txStatus: 'failed',
        error: 'Transaction failed on-chain.',
      }, walletA);

      expect(failed.status).toBe(200);
      expect(failed.body.completed).toBeUndefined();
      expect(failed.body.approval).toMatchObject({
        id: failedApproval.id,
        status: 'ready',
        txid: 'swap_tx_failed',
        txStatus: 'failed',
        error: 'Transaction failed on-chain.',
      });
    });
  });

  it('records transaction finalization preview and confirmed wallet receipt', async () => {
    await withMockServerFinalization(async () => {
      await withWorkflowServer(async ({ port }) => {
        const created = await postJson(port, '/api/approvals', {
          summary: 'Finalize SOL transfer',
          kind: 'transfer_sol',
          params: { recipient: walletB, amountSol: '0.000001' },
        }, walletA);
        const approval = created.body.approval as ApprovalRequestRecord;

        const preview = await postJson(port, `/api/approvals/${approval.id}/finalization/prepare`, {}, walletA);
        expect(preview.status).toBe(201);
        const finalization = preview.body.finalization as TransactionFinalizationRecord;
        expect(finalization.id).toMatch(/^finalization_/);
        expect(finalization.approvalRequestId).toBe(approval.id);
        expect(finalization.status).toBe('simulation_passed');

        const listed = await getJson(port, `/api/approvals/${approval.id}/finalization`, walletA);
        expect((listed.body.finalizations as TransactionFinalizationRecord[]).map((entry) => entry.id)).toEqual([finalization.id]);

        const result = await postJson(port, `/api/approvals/${approval.id}/finalization/${finalization.id}/submit`, {
          ...finalizationProofBody(approval, finalization),
          finalizationId: finalization.id,
          finalizationStatus: 'confirmed',
          txStatus: 'confirmed',
          txid: 'tx_finalized',
          transactionHash: finalization.transactionHash,
          messageHash: finalization.messageHash,
          quoteHash: finalization.quote?.quoteHash,
          simulationHash: finalization.simulation?.simulationHash,
          explorerUrl: 'https://explorer.solana.com/tx/tx_finalized?cluster=devnet',
        }, walletA);

        expect(result.status).toBe(200);
        const terminalApproval = result.body.approval as ApprovalRequestRecord;
        const completed = result.body.completed as CompletedRecord;
        expect(terminalApproval.status).toBe('approved');
        expect(terminalApproval.decisionProofVerified).toBe(true);
        expect(terminalApproval.metadata).toMatchObject({
          finalization: {
            id: finalization.id,
            status: 'confirmed',
            txid: 'tx_finalized',
            metadata: {
              verification: {
                status: 'confirmed',
                source: 'server_rpc',
              },
            },
          },
        });
        expect(completed.status).toBe('approved');
        expect(completed.finalizationId).toBe(finalization.id);
        expect(completed.txStatus).toBe('confirmed');
        expect(completed.quoteHash).toBe(finalization.quote?.quoteHash);
        expect(completed.simulationHash).toBe(finalization.simulation?.simulationHash);
        expect(completed.metadata).toMatchObject({
          constraintHash: expect.any(String),
          finalizationRequirement: 'transaction_preview',
        });
        expect(completed.payload).toMatchObject({
          type: 'one_time_transaction',
          finalization: {
            id: finalization.id,
            status: 'confirmed',
          },
          constraintHash: expect.any(String),
        });
      });
    });
  });

  it('rejects client-spoofed server-prepared previews for money-moving approvals', async () => {
    await withWorkflowServer(async ({ port }) => {
      const created = await postJson(port, '/api/approvals', {
        summary: 'Spoof server preparation',
        kind: 'transfer_sol',
        params: { recipient: 'Recipient111', amountSol: '0.25' },
      }, walletA);
      const approval = created.body.approval as ApprovalRequestRecord;

      const preview = await postJson(port, `/api/approvals/${approval.id}/finalization/preview`, {
        ...finalizationPreviewBody(approval),
        metadata: {
          serverPrepared: true,
          preparedBy: 'client',
        },
      }, walletA);

      expect(preview.status).toBe(409);
      expect(preview.body.error).toBe('server_prepared_finalization_required');
    });
  });

  it('rejects finalization previews that alter approved transfer constraints', async () => {
    await withWorkflowServer(async ({ port }) => {
      const created = await postJson(port, '/api/approvals', {
        summary: 'Finalize bounded SOL transfer',
        kind: 'transfer_sol',
        params: { recipient: 'Recipient111', amountSol: '0.25' },
      }, walletA);
      const approval = created.body.approval as ApprovalRequestRecord;
      const cases: Array<{
        patch: (body: Record<string, unknown>) => Record<string, unknown>;
        error: string;
      }> = [
        {
          patch: (body) => ({ ...body, walletAction: { ...(body.walletAction as Record<string, unknown>), sender: walletB } }),
          error: 'finalization_sender_mismatch',
        },
        {
          patch: (body) => ({ ...body, walletAction: { ...(body.walletAction as Record<string, unknown>), recipient: 'Recipient222' } }),
          error: 'finalization_recipient_mismatch',
        },
        {
          patch: (body) => ({ ...body, walletAction: { ...(body.walletAction as Record<string, unknown>), amount: '0.26' } }),
          error: 'finalization_amount_mismatch',
        },
        {
          patch: (body) => ({ ...body, walletAction: { ...(body.walletAction as Record<string, unknown>), token: 'USDC' } }),
          error: 'finalization_token_mismatch',
        },
        {
          patch: (body) => ({ ...body, quote: { ...(body.quote as Record<string, unknown>), inputToken: 'USDC' } }),
          error: 'finalization_token_mismatch',
        },
        {
          patch: (body) => ({ ...body, quote: { ...(body.quote as Record<string, unknown>), inputAmount: '0.26' } }),
          error: 'finalization_amount_mismatch',
        },
      ];

      for (const entry of cases) {
        const untrustedServerPreparedBody = {
          ...finalizationPreviewBody(approval),
          metadata: { serverPrepared: true },
        };
        const preview = await postJson(
          port,
          `/api/approvals/${approval.id}/finalization/preview`,
          entry.patch(untrustedServerPreparedBody),
          walletA,
        );
        expect(preview.status).toBe(409);
        expect(preview.body.error).toBe(entry.error);
      }
    });
  });

  it('rejects finalization previews when legacy approvals are missing locked constraints', async () => {
    await withWorkflowServer(async ({ port, store }) => {
      const created = await postJson(port, '/api/approvals', {
        summary: 'Legacy missing constraints',
        kind: 'transfer_sol',
        params: { recipient: 'Recipient111', amountSol: '0.25' },
      }, walletA);
      const approval = created.body.approval as ApprovalRequestRecord;
      const legacy = { ...approval, params: {} } as ApprovalRequestRecord;
      delete (legacy as { recipient?: string }).recipient;
      delete (legacy as { amount?: string }).amount;
      await store.saveApproval(walletA, legacy);

      const preview = await postJson(
        port,
        `/api/approvals/${approval.id}/finalization/preview`,
        {
          ...finalizationPreviewBody(approval),
          metadata: { serverPrepared: true },
        },
        walletA,
      );
      expect(preview.status).toBe(409);
      expect(preview.body.error).toBe('finalization_constraint_missing');
    });
  });

  it('prepares server-owned transaction finalization and accepts submit route receipts', async () => {
    await withMockServerFinalization(async () => {
      await withWorkflowServer(async ({ port }) => {
        const created = await postJson(port, '/api/approvals', {
          summary: 'Prepare SOL transfer on server',
          kind: 'transfer_sol',
          params: { recipient: walletB, amountSol: '0.000001' },
        }, walletA);
        const approval = created.body.approval as ApprovalRequestRecord;

        const prepared = await postJson(port, `/api/approvals/${approval.id}/finalization/prepare`, {}, walletA);
        expect(prepared.status).toBe(201);
        expect(typeof prepared.body.transactionBase64).toBe('string');
        const finalization = prepared.body.finalization as TransactionFinalizationRecord;
        expect(finalization.status).toBe('simulation_passed');
        expect(finalization.walletAction).toMatchObject({
          sender: walletA,
          recipient: walletB,
          amount: '0.000001',
          token: 'SOL',
        });
        expect(finalization.metadata).toMatchObject({
          serverPrepared: true,
          transactionBoundary: 'server_wallet_finalization_v1',
          transactionBoundaryHash: expect.any(String),
        });

        const submitted = await postJson(port, `/api/approvals/${approval.id}/finalization/${finalization.id}/submit`, {
          ...finalizationProofBody(approval, finalization),
          finalizationStatus: 'confirmed',
          txStatus: 'confirmed',
          txid: 'tx_server_prepared',
          transactionHash: finalization.transactionHash,
          messageHash: finalization.messageHash,
          quoteHash: finalization.quote?.quoteHash,
          simulationHash: finalization.simulation?.simulationHash,
        }, walletA);

        expect(submitted.status).toBe(200);
        expect((submitted.body.approval as ApprovalRequestRecord).status).toBe('approved');
        expect((submitted.body.completed as CompletedRecord).finalizationId).toBe(finalization.id);
      });
    });
  });

  it('keeps submitted finalizations pending until server confirmation succeeds', async () => {
    await withMockServerFinalization(async () => {
      let verifierCalls = 0;
      const statefulVerifier: TransactionVerifier = async (request) => {
        verifierCalls += 1;
        return verifierCalls === 1 ? pendingVerifier(request) : confirmedVerifier(request);
      };

      await withWorkflowServer(async ({ port }) => {
        const created = await postJson(port, '/api/approvals', {
          summary: 'Pending server confirmation',
          kind: 'transfer_sol',
          params: { recipient: walletB, amountSol: '0.000001' },
        }, walletA);
        const approval = created.body.approval as ApprovalRequestRecord;
        const prepared = await postJson(port, `/api/approvals/${approval.id}/finalization/prepare`, {}, walletA);
        const finalization = prepared.body.finalization as TransactionFinalizationRecord;

        const submitted = await postJson(port, `/api/approvals/${approval.id}/finalization/${finalization.id}/submit`, {
          ...finalizationProofBody(approval, finalization),
          finalizationId: finalization.id,
          finalizationStatus: 'confirmed',
          txStatus: 'confirmed',
          txid: 'tx_pending_then_confirmed',
          transactionHash: finalization.transactionHash,
          messageHash: finalization.messageHash,
          quoteHash: finalization.quote?.quoteHash,
          simulationHash: finalization.simulation?.simulationHash,
        }, walletA);

        expect(submitted.status).toBe(200);
        expect((submitted.body.approval as ApprovalRequestRecord).status).toBe('approval_pending');
        expect((submitted.body.approval as ApprovalRequestRecord).decisionProofVerified).toBe(true);
        expect(submitted.body.completed).toBeUndefined();
        expect(submitted.body.finalization).toMatchObject({
          status: 'submitted',
          txStatus: 'pending',
          txid: 'tx_pending_then_confirmed',
          metadata: {
            verification: {
              status: 'pending',
              confirmationStatus: 'processed',
            },
          },
        });

        const confirmed = await postJson(
          port,
          `/api/approvals/${approval.id}/finalization/${finalization.id}/confirm`,
          {},
          walletA,
        );

        expect(confirmed.status).toBe(200);
        expect((confirmed.body.approval as ApprovalRequestRecord).status).toBe('approved');
        expect((confirmed.body.completed as CompletedRecord).finalizationId).toBe(finalization.id);
        expect(confirmed.body.finalization).toMatchObject({
          status: 'confirmed',
          txStatus: 'confirmed',
          txid: 'tx_pending_then_confirmed',
          metadata: {
            verification: {
              status: 'confirmed',
            },
          },
        });
      }, { transactionVerifier: statefulVerifier });
    });
  });

  it('fails submitted finalizations whose on-chain message does not match the prepared review', async () => {
    await withMockServerFinalization(async () => {
      await withWorkflowServer(async ({ port }) => {
        const created = await postJson(port, '/api/approvals', {
          summary: 'Server message mismatch',
          kind: 'transfer_sol',
          params: { recipient: walletB, amountSol: '0.000001' },
        }, walletA);
        const approval = created.body.approval as ApprovalRequestRecord;
        const prepared = await postJson(port, `/api/approvals/${approval.id}/finalization/prepare`, {}, walletA);
        const finalization = prepared.body.finalization as TransactionFinalizationRecord;

        const submitted = await postJson(port, `/api/approvals/${approval.id}/finalization/${finalization.id}/submit`, {
          ...finalizationProofBody(approval, finalization),
          finalizationId: finalization.id,
          finalizationStatus: 'confirmed',
          txStatus: 'confirmed',
          txid: 'tx_message_mismatch',
          transactionHash: finalization.transactionHash,
          messageHash: finalization.messageHash,
          quoteHash: finalization.quote?.quoteHash,
          simulationHash: finalization.simulation?.simulationHash,
        }, walletA);

        expect(submitted.status).toBe(200);
        expect((submitted.body.approval as ApprovalRequestRecord).status).toBe('ready');
        expect(submitted.body.completed).toBeUndefined();
        expect(submitted.body.finalization).toMatchObject({
          status: 'failed',
          txStatus: 'failed',
          txid: 'tx_message_mismatch',
          error: 'Submitted transaction message did not match the prepared finalization.',
          metadata: {
            verification: {
              status: 'message_mismatch',
              messageHash: 'wrong_message_hash_from_chain',
            },
          },
        });
      }, { transactionVerifier: mismatchVerifier });
    });
  });

  it('rejects transaction finalization results that do not match the prepared review', async () => {
    await withMockServerFinalization(async () => {
      await withWorkflowServer(async ({ port }) => {
        const created = await postJson(port, '/api/approvals', {
          summary: 'Finalize SOL transfer mismatch',
          kind: 'transfer_sol',
          params: { recipient: walletB, amountSol: '0.000001' },
        }, walletA);
        const approval = created.body.approval as ApprovalRequestRecord;
        const preview = await postJson(port, `/api/approvals/${approval.id}/finalization/prepare`, {}, walletA);
        const finalization = preview.body.finalization as TransactionFinalizationRecord;

        const result = await postJson(port, `/api/approvals/${approval.id}/finalization/${finalization.id}/submit`, {
          ...finalizationProofBody(approval, finalization),
          finalizationId: finalization.id,
          finalizationStatus: 'confirmed',
          txStatus: 'confirmed',
          txid: 'tx_wrong_hash',
          transactionHash: 'wrong_tx_hash',
          messageHash: finalization.messageHash,
          quoteHash: finalization.quote?.quoteHash,
          simulationHash: finalization.simulation?.simulationHash,
        }, walletA);

        expect(result.status).toBe(409);
        expect(result.body.error).toBe('transaction_hash_mismatch');
      });
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

  it('archives the linked queued plan when its current approval becomes terminal', async () => {
    await withMockServerFinalization(async () => {
      await withWorkflowServer(async ({ port }) => {
        const createdPlan = await postJson(port, '/api/plans', createPlanBody(), walletA);
        const plan = createdPlan.body.plan as PlanDraftRecord;
        const createdApproval = await postJson(port, '/api/approvals', { planDraftId: plan.id }, walletA);
        const approval = createdApproval.body.approval as ApprovalRequestRecord;

        const preview = await postJson(port, `/api/approvals/${approval.id}/finalization/prepare`, {}, walletA);
        const finalization = preview.body.finalization as TransactionFinalizationRecord;
        const decided = await postJson(port, `/api/approvals/${approval.id}/finalization/${finalization.id}/submit`, {
          ...finalizationProofBody(approval, finalization),
          finalizationId: finalization.id,
          finalizationStatus: 'confirmed',
          txStatus: 'confirmed',
          txid: 'tx_archived_plan',
          transactionHash: finalization.transactionHash,
          messageHash: finalization.messageHash,
          quoteHash: finalization.quote?.quoteHash,
          simulationHash: finalization.simulation?.simulationHash,
        }, walletA);
        expect(decided.status).toBe(200);
        const completed = decided.body.completed as CompletedRecord;

        const plans = await getJson(port, '/api/plans', walletA);
        const archived = (plans.body.plans as PlanDraftRecord[]).find((entry) => entry.id === plan.id);
        expect(archived?.status).toBe('archived');
        expect(archived?.approvalRequestId).toBe(approval.id);
        expect(archived?.metadata).toMatchObject({
          terminalApprovalStatus: 'approved',
          terminalApprovalAt: (decided.body.approval as ApprovalRequestRecord).decidedAt,
          completedRecordId: completed.id,
        });
      });
    });
  });

  it('does not archive a queued plan if the terminal approval is no longer linked', async () => {
    await withWorkflowServer(async ({ port, store }) => {
      const createdPlan = await postJson(port, '/api/plans', createPlanBody(), walletA);
      const plan = createdPlan.body.plan as PlanDraftRecord;
      const createdApproval = await postJson(port, '/api/approvals', { planDraftId: plan.id }, walletA);
      const approval = createdApproval.body.approval as ApprovalRequestRecord;
      const queuedPlan = await store.getPlan(walletA, plan.id);
      if (!queuedPlan) throw new Error('Expected queued plan.');
      await store.savePlan(walletA, {
        ...queuedPlan,
        status: 'queued',
        approvalRequestId: 'approval_newer',
      });

      const decided = await postJson(port, `/api/approvals/${approval.id}/cancel`, {}, walletA);
      expect(decided.status).toBe(200);

      const current = await store.getPlan(walletA, plan.id);
      expect(current?.status).toBe('queued');
      expect(current?.approvalRequestId).toBe('approval_newer');
      expect(current?.metadata).toBeUndefined();
    });
  });

  it('requires wallet proof for approve and deny decisions but permits proofless cancel', async () => {
    await withWorkflowServer(async ({ port }) => {
      for (const route of ['/approve', '/deny'] as const) {
        const created = await postJson(port, '/api/approvals', {
          summary: `Proof required ${route}`,
          kind: 'manual_review',
          params: { reason: `Proof required ${route}` },
        }, walletA);
        const approval = created.body.approval as ApprovalRequestRecord;

        const missingProof = await postJson(port, `/api/approvals/${approval.id}${route}`, {}, walletA);
        expect(missingProof.status).toBe(400);
        expect(missingProof.body.error).toBe('missing_decision_proof');
      }

      const invalidCreated = await postJson(port, '/api/approvals', {
        summary: 'Invalid proof',
        kind: 'manual_review',
        params: { reason: 'Invalid proof' },
      }, walletA);
      const invalidApproval = invalidCreated.body.approval as ApprovalRequestRecord;
      const invalidProof = await postJson(port, `/api/approvals/${invalidApproval.id}/approve`, {
        ...decisionProofBody(invalidApproval, 'approved', testWalletB),
      }, walletA);
      expect(invalidProof.status).toBe(400);
      expect(invalidProof.body.error).toBe('invalid_decision_proof');

      const cancellable = await postJson(port, '/api/approvals', {
        summary: 'Proofless cancel',
        kind: 'manual_review',
        params: { reason: 'Proofless cancel' },
      }, walletA);
      const approval = cancellable.body.approval as ApprovalRequestRecord;
      const cancelled = await postJson(port, `/api/approvals/${approval.id}/cancel`, {}, walletA);
      expect(cancelled.status).toBe(200);
      expect((cancelled.body.approval as ApprovalRequestRecord).status).toBe('cancelled');
    });
  });

  it('scopes all workflow records to the signed-in wallet', async () => {
    await withWorkflowServer(async ({ port }) => {
      const createdPlan = await postJson(port, '/api/plans', createManualPlanBody(), walletA);
      const plan = createdPlan.body.plan as PlanDraftRecord;
      const createdApproval = await postJson(port, '/api/approvals', { planId: plan.id }, walletA);
      const approval = createdApproval.body.approval as ApprovalRequestRecord;
      const decided = await postJson(port, `/api/approvals/${approval.id}/approve`, {
        ...decisionProofBody(approval, 'approved'),
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

function createManualPlanBody(): Record<string, unknown> {
  return {
    ...createPlanBody(),
    plan: {
      ...samplePlan(),
      actionType: 'manual_review',
    },
  };
}

function createBlinkPlanBody(): Record<string, unknown> {
  return {
    plan: sampleBlinkPlan(),
    source: 'template',
    templateId: 'protocol-blink-action',
    templateTitle: 'Protocol connector action',
    prompt: 'Prepare Jupiter Blink swap',
    cluster: 'mainnet-beta',
    metadata: {
      connectorId: 'jupiter',
      protocol: 'Jupiter',
      operation: 'swap',
    },
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
      recipient: walletB,
      amount: '0.25',
      memo: 'Test payment',
    },
    fields: [
      { label: 'Recipient address', value: walletB },
      { label: 'Amount SOL', value: '0.25' },
    ],
    safeguards: ['Wallet approval is required.'],
  };
}

function sampleBlinkPlan(): JsonObject {
  return {
    intent: 'Prepare a Jupiter Blink swap for wallet review',
    route: 'Browser resolves the Blink action before wallet approval.',
    risk: 'High risk. Review the final wallet transaction and protocol route before signing.',
    approval: 'Wallet approval is required before any transaction is signed or submitted.',
    source: 'template',
    category: 'defi',
    actionType: 'blink_action',
    templateTitle: 'Protocol connector action',
    parameters: {
      blinkUrl: 'blink:https%3A%2F%2Factions.example.com%2Fswap%3Finput%3DSOL%26output%3DUSDC',
      protocol: 'Jupiter',
      operation: 'swap',
      amount: '0.1',
      expectedToken: 'USDC',
      expectedRecipient: walletB,
    },
    fields: [
      { label: 'Protocol', value: 'Jupiter' },
      { label: 'Amount', value: '0.1 SOL' },
    ],
    safeguards: ['Wallet approval is required.'],
  };
}

function decisionProofBody(
  approval: ApprovalRequestRecord,
  decision: 'approved' | 'rejected',
  wallet: TestWallet = testWalletA,
): Record<string, unknown> {
  const message = workflowDecisionProofMessage({ approval, decision });
  return {
    proofSignature: signMessage(message, wallet.privateKey),
    decisionProofMessage: message,
    signatureEncoding: 'base58',
  };
}

function finalizationProofBody(
  approval: ApprovalRequestRecord,
  finalization: TransactionFinalizationRecord,
  wallet: TestWallet = testWalletA,
): Record<string, unknown> {
  const message = workflowFinalizationProofMessage({ approval, finalization });
  return {
    proofSignature: signMessage(message, wallet.privateKey),
    decisionProofMessage: message,
    signatureEncoding: 'base58',
  };
}

function finalizationPreviewBody(approval: ApprovalRequestRecord): Record<string, unknown> {
  const recipient = typeof approval.params.recipient === 'string'
    ? approval.params.recipient
    : typeof approval.recipient === 'string'
      ? approval.recipient
      : 'Recipient111';
  const amount = typeof approval.params.amountSol === 'string'
    ? approval.params.amountSol
    : typeof approval.params.amount === 'string'
      ? approval.params.amount
      : typeof approval.amount === 'string'
        ? approval.amount
        : '0.25';
  return {
    status: 'simulation_passed',
    walletAction: {
      kind: approval.kind,
      walletAddress: approval.walletAddress,
      cluster: approval.cluster ?? 'devnet',
      summary: approval.summary,
      sender: approval.walletAddress,
      recipient,
      amount,
      token: 'SOL',
      feePayer: approval.walletAddress,
      instructionSummary: [`Transfer ${amount} SOL`],
      touchedPrograms: ['11111111111111111111111111111111'],
    },
    transactionHash: 'tx_hash_123',
    messageHash: 'message_hash_123',
    quote: {
      provider: 'test-fixed-transfer',
      fetchedAt: '2026-05-08T20:00:00.000Z',
      inputToken: 'SOL',
      inputAmount: amount,
      routeLabel: 'SystemProgram.transfer',
      quoteHash: 'quote_hash_123',
    },
    simulation: {
      status: 'ok',
      simulatedAt: '2026-05-08T20:00:01.000Z',
      logs: [],
      unitsConsumed: 500,
      simulationHash: 'simulation_hash_123',
    },
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
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

const confirmedVerifier: TransactionVerifier = async ({ finalization }) => ({
  status: 'confirmed',
  txStatus: 'confirmed',
  confirmationStatus: 'confirmed',
  ...(finalization.messageHash ? { messageHash: finalization.messageHash } : {}),
  slot: 1,
});

const pendingVerifier: TransactionVerifier = async ({ finalization }) => ({
  status: 'pending',
  txStatus: 'pending',
  confirmationStatus: 'processed',
  ...(finalization.messageHash ? { messageHash: finalization.messageHash } : {}),
});

const mismatchVerifier: TransactionVerifier = async () => ({
  status: 'message_mismatch',
  txStatus: 'failed',
  confirmationStatus: 'message_mismatch',
  messageHash: 'wrong_message_hash_from_chain',
  error: 'Submitted transaction message did not match the prepared finalization.',
});

async function withMockServerFinalization(callback: () => Promise<void>): Promise<void> {
  const previous = process.env.AGENTIC_MOCK_FINALIZATION;
  process.env.AGENTIC_MOCK_FINALIZATION = '1';
  try {
    await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTIC_MOCK_FINALIZATION;
    } else {
      process.env.AGENTIC_MOCK_FINALIZATION = previous;
    }
  }
}

async function withWorkflowServer(
  callback: (server: { port: number; store: TestWorkflowStore }) => Promise<void>,
  options: { transactionVerifier?: TransactionVerifier } = {},
): Promise<void> {
  const store = new TestWorkflowStore();
  const handler = createWorkflowApiHandler({
    service: new WorkflowService(store, {
      ...(options.transactionVerifier ? { transactionVerifier: options.transactionVerifier } : {}),
    }),
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
  private readonly finalizations = new Map<string, TransactionFinalizationRecord>();
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

  async listFinalizations(walletAddress: string, approvalRequestId?: string): Promise<TransactionFinalizationRecord[]> {
    return [...this.finalizations.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .filter((record) => approvalRequestId === undefined || record.approvalRequestId === approvalRequestId)
      .map(clone);
  }

  async getFinalization(walletAddress: string, id: string): Promise<TransactionFinalizationRecord | undefined> {
    return ownerClone(this.finalizations.get(id), walletAddress);
  }

  async saveFinalization(_walletAddress: string, record: TransactionFinalizationRecord): Promise<void> {
    this.finalizations.set(record.id, clone(record));
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
