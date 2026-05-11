import { describe, expect, it } from 'vitest';

import {
  capabilitiesForWorkflowMode,
  assertPlanGuardrails,
  completedFromApproval,
  evaluatePlanGuardrails,
  finalizationRequirementForAction,
  isActiveApprovalStatus,
  isQueueableWorkflowAction,
  isTerminalApprovalStatus,
  parseApprovalListResponse,
  parseApprovalRequestRecord,
  parseAuditEventRecord,
  parseAuthNonceResponse,
  parseCompletedListResponse,
  parseCompletedRecord,
  parseCreateApprovalRequest,
  parseCreateEvidenceReceiptRequest,
  parseCreatePlanRequest,
  parseCreateRecurringRequest,
  parseEvidenceReceiptListResponse,
  parseEvidenceReceiptRecord,
  parseJsonObject,
  parsePlanDraftRecord,
  parsePlanListResponse,
  parseRecurringListResponse,
  parseRecurringOccurrenceRecord,
  parseRecurringScheduleRecord,
  parseSessionResponse,
  parseVerifyWalletRequest,
  parseWalletSession,
  parseWorkflowCapabilities,
  parseWorkflowUser,
  stableWorkflowFingerprint,
  stableWorkflowHash,
  validateApprovalDecisionRequest,
  validateCreateApprovalRequest,
  validateCreateEvidenceReceiptRequest,
  validateCreatePlanRequest,
  validateCreateRecurringRequest,
  validateRecordId,
  validateRecurringId,
  validateUpdatePlanRequest,
  validateUpdateRecurringRequest,
  WorkflowValidationError,
  type ApprovalRequestRecord,
  type ApprovalStatus,
} from '../index.js';

const NOW = '2026-05-08T12:00:00.000Z';
const WALLET = 'Wallet111111111111111111111111111111111111';

describe('workflow capabilities', () => {
  it('maps each workflow mode to stable storage and authority capabilities', () => {
    expect(capabilitiesForWorkflowMode('agentic_cloud')).toMatchObject({
      storage: 'cloud',
      requiresWalletSession: true,
      requiresLocalhost: false,
      supportsCloudSync: true,
    });
    expect(capabilitiesForWorkflowMode('browser_fallback')).toMatchObject({
      storage: 'browser',
      availableOffline: true,
      supportsAuditEvents: false,
    });
    expect(capabilitiesForWorkflowMode('local_bridge')).toMatchObject({
      storage: 'local_bridge',
      requiresLocalhost: true,
      supportsPrivateLocalMode: true,
    });
  });
});

describe('approval status helpers', () => {
  it('separates active and terminal approval statuses', () => {
    expect(['pending', 'scheduled', 'ready', 'overdue', 'approval_pending'].every((status) =>
      isActiveApprovalStatus(status as ApprovalStatus),
    )).toBe(true);
    expect(['approved', 'denied', 'rejected', 'blocked', 'failed', 'expired', 'cancelled'].every((status) =>
      isTerminalApprovalStatus(status as ApprovalStatus),
    )).toBe(true);
    expect(isActiveApprovalStatus('approved')).toBe(false);
    expect(isTerminalApprovalStatus('ready')).toBe(false);
  });
});

describe('AI product guardrails', () => {
  it('passes a constrained AI transfer while preserving a stable fingerprint', () => {
    const plan = {
      source: 'ai',
      category: 'payments',
      actionType: 'transfer_sol',
      templateId: 'transfer-sol',
      templateTitle: 'Send SOL',
      intent: 'Send 0.1 SOL to a recipient',
      route: 'Prepare a SOL transfer and show wallet approval before signing.',
      risk: 'Medium risk. Check recipient, amount, fees, and memo before approval.',
      approval: 'Wallet approval is required before signing or submitting.',
      parameters: {
        recipient: 'Recipient111111111111111111111111111111111',
        amount: '0.1',
        memo: 'Invoice payment',
      },
      fields: [{ label: 'Amount SOL', value: '0.1' }],
      safeguards: ['Wallet approval is required.'],
      cluster: 'devnet',
    };

    const report = evaluatePlanGuardrails({ plan });

    expect(report).toMatchObject({
      verdict: 'pass',
      source: 'ai',
      actionType: 'transfer_sol',
      finalizationRequirement: 'transaction_preview',
    });
    expect(report.constraintFingerprint).toBe(stableWorkflowFingerprint({
      source: 'ai',
      category: 'payments',
      actionType: 'transfer_sol',
      templateId: 'transfer-sol',
      templateTitle: 'Send SOL',
      cluster: 'devnet',
      parameters: plan.parameters,
      fields: plan.fields,
    }));
    expect(report.constraintHash).toBe(stableWorkflowHash({
      source: 'ai',
      category: 'payments',
      actionType: 'transfer_sol',
      templateId: 'transfer-sol',
      templateTitle: 'Send SOL',
      cluster: 'devnet',
      parameters: plan.parameters,
      fields: plan.fields,
    }));
    expect(assertPlanGuardrails({ plan })).toEqual(report);
  });

  it('blocks AI drafts that claim approval, signing, or safety has already happened', () => {
    const blocked = evaluatePlanGuardrails({
      plan: {
        source: 'ai',
        actionType: 'transfer_sol',
        intent: 'This transfer is already approved and safe to sign.',
        route: 'No wallet approval required.',
        risk: 'Risk-free.',
        approval: 'Already signed.',
        parameters: {
          recipient: 'Recipient111111111111111111111111111111111',
          amount: '0.1',
        },
      },
    });

    expect(blocked.verdict).toBe('block');
    expect(blocked.violations.map((violation) => violation.code)).toEqual(expect.arrayContaining([
      'ai_claims_approved',
      'ai_bypasses_wallet',
      'ai_claims_safe',
      'ai_claims_signed',
    ]));
    expect(() => assertPlanGuardrails({ plan: blockedPlan() })).toThrow(WorkflowValidationError);
  });

  it('allows protective wording that says AI cannot bypass wallet approval', () => {
    const plan = {
      source: 'ai',
      category: 'payments',
      actionType: 'transfer_sol',
      templateId: 'transfer-sol',
      templateTitle: 'Send SOL',
      intent: 'Prepare a SOL transfer review.',
      route: 'AI drafts cannot bypass wallet approval or signing. No transaction can be submitted without wallet approval.',
      risk: 'Medium risk. Check recipient and amount before approval.',
      approval: 'Wallet approval is required before signing or submitting.',
      parameters: {
        recipient: 'Recipient111111111111111111111111111111111',
        amount: '0.1',
        memo: 'Invoice payment',
      },
      fields: [{ label: 'Amount SOL', value: '0.1' }],
      safeguards: ['Cannot bypass wallet approval.'],
      cluster: 'devnet',
    };

    const report = evaluatePlanGuardrails({ plan });

    expect(report.verdict).toBe('pass');
    expect(report.violations.map((violation) => violation.code)).not.toContain('ai_bypasses_wallet');
  });

  it('allows pre-approval review wording when it does not claim approval already happened', () => {
    const report = evaluatePlanGuardrails({
      plan: {
        source: 'ai',
        category: 'trading',
        actionType: 'swap',
        templateId: 'swap-tokens',
        templateTitle: 'Swap tokens',
        intent: 'Prepare a pre-approval review for this swap before my wallet approves.',
        route: 'Check route, amount, protocol, and slippage before signing.',
        risk: 'Medium risk. User must approve in the wallet before funds move.',
        approval: 'Wallet approval is required; nothing has been approved yet.',
        parameters: {
          inputToken: 'SOL',
          outputToken: 'USDC',
          amount: '0.1',
          slippageBps: '50',
        },
        fields: [{ label: 'Amount', value: '0.1 SOL' }],
        safeguards: ['Wallet remains the only signer.'],
        cluster: 'mainnet-beta',
      },
    });

    expect(report.verdict).not.toBe('block');
    expect(report.violations.map((violation) => violation.code)).not.toContain('ai_claims_approved');
  });

  it('blocks secrets, delegated signers, and missing executable constraints', () => {
    expect(evaluatePlanGuardrails({
      plan: {
        source: 'ai',
        actionType: 'transfer_spl',
        intent: 'Send token after user enters private key',
        route: 'Ask user to paste private key.',
        risk: 'High.',
        approval: 'Wallet approval required.',
        parameters: {
          token: 'USDC',
          amount: '10',
        },
      },
    })).toMatchObject({
      verdict: 'block',
      violations: expect.arrayContaining([
        expect.objectContaining({ code: 'forbidden_secret_request' }),
        expect.objectContaining({ code: 'missing_executable_constraint' }),
      ]),
    });

    expect(evaluatePlanGuardrails({
      plan: {
        source: 'ai',
        actionType: 'manual_review',
        intent: 'Use delegated signer',
        route: 'Create delegated signer with unlimited approval.',
        risk: 'Medium.',
        approval: 'User reviews.',
        metadata: { approvalAuthority: 'unlimited' },
      },
    })).toMatchObject({
      verdict: 'block',
      violations: expect.arrayContaining([
        expect.objectContaining({ code: 'forbidden_authority' }),
      ]),
    });
  });

  it('classifies queueable actions and finalization requirements', () => {
    expect(isQueueableWorkflowAction('swap')).toBe(true);
    expect(isQueueableWorkflowAction('read_only')).toBe(false);
    expect(finalizationRequirementForAction('swap')).toBe('transaction_preview');
    expect(finalizationRequirementForAction('custom_transaction')).toBe('transaction_preview');
    expect(finalizationRequirementForAction('recurring_payment')).toBe('wallet_decision_proof');
    expect(finalizationRequirementForAction('read_only')).toBe('none');
  });
});

describe('completedFromApproval', () => {
  it('creates completed one-time history from terminal approvals', () => {
    const completed = completedFromApproval(approvalRecord('approved'));

    expect(completed).toMatchObject({
      id: 'completed:approval_1',
      kind: 'one_time',
      status: 'approved',
      amount: '0.1',
      token: 'SOL',
      recipient: 'Recipient111111111111111111111111111111111',
      approvalRequestId: 'approval_1',
      explorerUrl: 'https://solscan.io/tx/tx_1?cluster=devnet',
    });
  });

  it('marks approvals with schedule data as recurring occurrences', () => {
    const completed = completedFromApproval({
      ...approvalRecord('rejected'),
      recurringScheduleId: 'schedule_1',
      recurringOccurrenceId: 'occurrence_1',
      occurrenceKey: '2026-05-08',
      txid: undefined,
    });

    expect(completed).toMatchObject({
      kind: 'recurring_occurrence',
      recurringScheduleId: 'schedule_1',
      recurringOccurrenceId: 'occurrence_1',
      occurrenceKey: '2026-05-08',
    });
  });

  it('rejects active approvals', () => {
    expect(() => completedFromApproval(approvalRecord('ready'))).toThrow(WorkflowValidationError);
  });
});

describe('runtime validators', () => {
  it('accepts minimal valid records, requests, and responses', () => {
    const capabilities = capabilitiesForWorkflowMode('agentic_cloud');
    const session = {
      id: 'session_1',
      walletAddress: WALLET,
      createdAt: NOW,
      expiresAt: '2026-05-09T12:00:00.000Z',
    };
    const user = {
      id: 'user_1',
      walletAddress: WALLET,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const plan = planRecord();
    const approval = approvalRecord('approved');
    const recurring = recurringScheduleRecord();
    const occurrence = recurringOccurrenceRecord();
    const completed = completedFromApproval(approval);
    const evidence = evidenceReceiptRecord();

    expect(parseJsonObject({ ok: true, nested: { value: 1 }, items: ['a'] })).toEqual({
      ok: true,
      nested: { value: 1 },
      items: ['a'],
    });
    expect(parseWorkflowCapabilities(capabilities)).toEqual(capabilities);
    expect(parseWalletSession(session)).toEqual(session);
    expect(parseWorkflowUser(user)).toEqual(user);
    expect(parsePlanDraftRecord(plan)).toEqual(plan);
    expect(parseApprovalRequestRecord(approval)).toEqual(approval);
    expect(parseRecurringScheduleRecord(recurring)).toEqual(recurring);
    expect(parseRecurringOccurrenceRecord(occurrence)).toEqual(occurrence);
    expect(parseCompletedRecord(completed)).toMatchObject(completed);
    expect(parseEvidenceReceiptRecord(evidence)).toEqual(evidence);
    expect(parseAuditEventRecord({
      id: 'audit_1',
      walletAddress: WALLET,
      actor: 'server',
      eventType: 'approval.created',
      createdAt: NOW,
    })).toMatchObject({ eventType: 'approval.created' });
    expect(parseAuthNonceResponse({
      nonce: 'nonce_1',
      message: 'Sign in to Agentic',
      domain: 'agentic.example',
      issuedAt: NOW,
      expiresAt: '2026-05-08T12:05:00.000Z',
    })).toMatchObject({ nonce: 'nonce_1' });
    expect(parseVerifyWalletRequest({
      walletAddress: WALLET,
      message: 'Sign in to Agentic',
      signature: 'sig_1',
      nonce: 'nonce_1',
      domain: 'agentic.example',
      issuedAt: NOW,
      expiresAt: '2026-05-08T12:05:00.000Z',
      signatureEncoding: 'base58',
    })).toMatchObject({ signatureEncoding: 'base58' });
    expect(parseSessionResponse({ signedIn: true, capabilities, session, user })).toMatchObject({
      signedIn: true,
      session,
      user,
    });
    expect(parseCreatePlanRequest(createPlanRequest())).toMatchObject({ actionType: 'transfer_sol' });
    expect(parsePlanListResponse({ plans: [plan] }).plans).toHaveLength(1);
    expect(parseCreateApprovalRequest(createApprovalRequest())).toMatchObject({ kind: 'transfer_sol' });
    expect(parseApprovalListResponse({ approvals: [approval] }).approvals).toHaveLength(1);
    expect(parseCreateRecurringRequest(createRecurringRequest())).toMatchObject({ cadence: 'weekly' });
    expect(parseRecurringListResponse({ schedules: [recurring], occurrences: [occurrence] })).toMatchObject({
      schedules: [recurring],
      occurrences: [occurrence],
    });
    expect(parseCompletedListResponse({ completed: [completed] }).completed).toHaveLength(1);
    expect(parseCompletedRecord({ ...completed, kind: 'one-time' })).toMatchObject({ kind: 'one_time' });
    expect(parseCreateEvidenceReceiptRequest(createEvidenceReceiptRequest())).toMatchObject({ status: 'approved' });
    expect(parseEvidenceReceiptListResponse({ receipts: [evidence] }).receipts).toHaveLength(1);
  });

  it('rejects missing required fields, invalid enums, and non-JSON values', () => {
    const createPlan = createPlanRequest();
    const { title: _title, ...missingTitle } = createPlan;

    expect(workflowError(() => parseCreatePlanRequest(missingTitle))).toMatchObject({
      code: 'missing_field',
      path: '$.title',
    });
    expect(() => parseCreatePlanRequest({ ...createPlan, actionType: 'stake' })).toThrow(WorkflowValidationError);
    expect(() => parseCreateApprovalRequest({
      ...createApprovalRequest(),
      params: { recipient: WALLET, bad: undefined },
    })).toThrow(WorkflowValidationError);
    expect(() => parseCreateEvidenceReceiptRequest({
      ...createEvidenceReceiptRequest(),
      metadata: { score: Number.NaN },
    })).toThrow(WorkflowValidationError);
  });
});

describe('Agentic Cloud validators', () => {
  it('normalizes plan payloads from hosted planner records', () => {
    const plan = {
      title: 'AI transfer',
      intent: 'Send USDC to a vendor',
      route: 'Prepare a token transfer.',
      risk: 'Medium',
      approval: 'Wallet approval required.',
      source: 'ai',
      category: 'payments',
      actionType: 'transfer_spl',
      parameters: { token: 'USDC', amount: '5' },
      fields: [{ label: 'Amount', value: '5 USDC' }],
      safeguards: ['Require wallet confirmation'],
      templateId: 'ai',
      templateTitle: 'AI plan',
      prompt: 'Pay the vendor',
      cluster: 'devnet',
    };

    expect(validateCreatePlanRequest({ plan })).toMatchObject({
      plan,
      title: 'AI transfer',
      source: 'ai',
      actionType: 'transfer_spl',
      templateId: 'ai',
      templateTitle: 'AI plan',
      prompt: 'Pay the vendor',
      cluster: 'devnet',
    });
  });

  it('normalizes approval decisions and rejects missing approval sources', () => {
    expect(validateCreateApprovalRequest({
      planId: 'plan_1',
      kind: 'custom_action',
      params: { amount: '1' },
    })).toMatchObject({
      planDraftId: 'plan_1',
      kind: 'custom_action',
      params: { amount: '1' },
    });
    expect(validateApprovalDecisionRequest({
      decisionProofSignature: 'proof_1',
      decisionProofMessage: 'decision message',
      signatureEncoding: 'base64',
      txid: 'tx_1',
    })).toEqual({
      proofSignature: 'proof_1',
      decisionProofSignature: 'proof_1',
      decisionProofMessage: 'decision message',
      signatureEncoding: 'base64',
      txid: 'tx_1',
    });
    expect(() => validateCreateApprovalRequest({ kind: 'transfer_sol' })).toThrow(WorkflowValidationError);
  });

  it('guards mutable update requests, recurring cadence rules, ids, and forbidden secrets', () => {
    expect(validateUpdatePlanRequest({ status: 'queued', signature: 'sig_1' })).toMatchObject({
      status: 'queued',
      signature: 'sig_1',
    });
    expect(validateUpdateRecurringRequest({ status: 'paused', note: 'Hold until review' })).toMatchObject({
      status: 'paused',
      note: 'Hold until review',
    });
    expect(validateRecordId('recurring_1')).toBe('recurring_1');
    expect(validateRecurringId('recurring_1')).toBe('recurring_1');

    expect(() => validateUpdatePlanRequest({})).toThrow(WorkflowValidationError);
    expect(() => validateRecordId('bad/id')).toThrow(WorkflowValidationError);
    expect(() => validateRecordId('%E0%A4%A')).toThrow(WorkflowValidationError);
    expect(() => validateRecurringId('bad/id')).toThrow(WorkflowValidationError);
    expect(() => validateRecurringId('%E0%A4%A')).toThrow(WorkflowValidationError);
    expect(() => validateCreateRecurringRequest({
      ...createRecurringRequest(),
      cadence: 'weekly',
      localTime: undefined,
    })).toThrow(WorkflowValidationError);
    expect(() => validateCreatePlanRequest({
      ...createPlanRequest(),
      metadata: { privateKey: 'not accepted' },
    })).toThrow(WorkflowValidationError);
    expect(workflowError(() => parseJsonObject(new Date()))).toMatchObject({
      code: 'invalid_object',
      path: '$',
    });
  });

  it('validates evidence receipt requests with shared workflow rules', () => {
    expect(validateCreateEvidenceReceiptRequest({
      ...createEvidenceReceiptRequest(),
      cluster: ' devnet ',
      summary: '  Safe to archive  ',
    })).toMatchObject({
      cluster: 'devnet',
      kind: 'review_proof',
      status: 'approved',
      summary: 'Safe to archive',
    });

    const missingCluster = { ...createEvidenceReceiptRequest() } as Record<string, unknown>;
    delete missingCluster.cluster;
    expect(workflowError(() => validateCreateEvidenceReceiptRequest(missingCluster))).toMatchObject({
      code: 'missing_field',
    });
    expect(workflowError(() => validateCreateEvidenceReceiptRequest({
      ...createEvidenceReceiptRequest(),
      cluster: 'mainnet-fake',
    }))).toMatchObject({ code: 'invalid_cluster' });
    expect(workflowError(() => validateCreateEvidenceReceiptRequest({
      ...createEvidenceReceiptRequest(),
      title: '   ',
    }))).toMatchObject({ code: 'missing_field' });
    expect(workflowError(() => validateCreateEvidenceReceiptRequest({
      ...createEvidenceReceiptRequest(),
      artifactHash: 'x'.repeat(257),
    }))).toMatchObject({ code: 'field_too_long' });
    expect(workflowError(() => validateCreateEvidenceReceiptRequest({
      ...createEvidenceReceiptRequest(),
      payload: { delegatedSigner: 'server-wallet' },
    }))).toMatchObject({ code: 'forbidden_secret' });
    expect(workflowError(() => validateCreateEvidenceReceiptRequest({
      ...createEvidenceReceiptRequest(),
      metadata: { approvalAuthority: 'unlimited' },
    }))).toMatchObject({ code: 'forbidden_authority' });
  });
});

function workflowError(action: () => unknown): WorkflowValidationError {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowValidationError);
    return err as WorkflowValidationError;
  }
  throw new Error('Expected WorkflowValidationError.');
}

function planRecord() {
  return {
    id: 'plan_1',
    walletAddress: WALLET,
    plan: {},
    cluster: 'devnet',
    title: 'Send SOL',
    intent: 'Send 0.1 SOL',
    route: 'Prepare a SOL transfer.',
    risk: 'Medium risk transfer.',
    approval: 'Wallet approval required.',
    source: 'template',
    category: 'payments',
    actionType: 'transfer_sol',
    parameters: { recipient: 'Recipient111111111111111111111111111111111', amount: '0.1' },
    fields: [{ label: 'Amount', value: '0.1 SOL' }],
    safeguards: ['No private key sharing.'],
    status: 'draft',
    createdAt: NOW,
    updatedAt: NOW,
    templateId: '',
    templateTitle: '',
    prompt: '',
  } as const;
}

function blockedPlan() {
  return {
    source: 'ai',
    actionType: 'transfer_sol',
    intent: 'This transfer is already approved.',
    route: 'No wallet approval required.',
    risk: 'Risk-free.',
    approval: 'Already signed.',
    parameters: {
      recipient: 'Recipient111111111111111111111111111111111',
      amount: '0.1',
    },
  } as const;
}

function approvalRecord(status: ApprovalStatus): ApprovalRequestRecord {
  return {
    id: 'approval_1',
    walletAddress: WALLET,
    cluster: 'devnet',
    kind: 'transfer_sol',
    status,
    summary: 'Send 0.1 SOL',
    params: {
      recipient: 'Recipient111111111111111111111111111111111',
      amountSol: '0.1',
    },
    dueAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    planDraftId: 'plan_1',
    txid: status === 'approved' ? 'tx_1' : undefined,
    confirmedAt: status === 'approved' ? NOW : undefined,
    decisionProofSignature: status === 'rejected' ? 'proof_1' : undefined,
  };
}

function recurringScheduleRecord() {
  return {
    id: 'schedule_1',
    status: 'active',
    walletAddress: WALLET,
    cluster: 'devnet',
    token: 'USDC',
    recipient: 'Recipient111111111111111111111111111111111',
    amount: '5',
    cadence: 'weekly',
    createdAt: NOW,
    updatedAt: NOW,
    dayOfWeek: 5,
    localTime: '09:00',
  } as const;
}

function recurringOccurrenceRecord() {
  return {
    id: 'occurrence_1',
    recurringScheduleId: 'schedule_1',
    walletAddress: WALLET,
    cluster: 'devnet',
    status: 'scheduled',
    occurrenceKey: '2026-05-08',
    dueAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
}

function evidenceReceiptRecord() {
  return {
    id: 'receipt_1',
    walletAddress: WALLET,
    cluster: 'devnet',
    title: 'Receipt',
    kind: 'review_proof',
    status: 'approved',
    payload: { decision: 'approved' },
    preSignatureHash: 'hash_1',
    signingMessage: 'Sign this receipt',
    signature: 'sig_1',
    verified: true,
    artifactHash: 'artifact_hash_1',
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
}

function createPlanRequest() {
  return {
    cluster: 'devnet',
    title: 'Send SOL',
    intent: 'Send 0.1 SOL',
    route: 'Prepare a SOL transfer.',
    risk: 'Medium risk transfer.',
    approval: 'Wallet approval required.',
    source: 'template',
    category: 'payments',
    actionType: 'transfer_sol',
    parameters: { recipient: 'Recipient111111111111111111111111111111111', amount: '0.1' },
  } as const;
}

function createApprovalRequest() {
  return {
    cluster: 'devnet',
    kind: 'transfer_sol',
    summary: 'Send 0.1 SOL',
    params: {
      recipient: 'Recipient111111111111111111111111111111111',
      amountSol: '0.1',
    },
    planDraftId: 'plan_1',
  } as const;
}

function createRecurringRequest() {
  return {
    cluster: 'devnet',
    token: 'USDC',
    recipient: 'Recipient111111111111111111111111111111111',
    amount: '5',
    cadence: 'weekly',
    dayOfWeek: 5,
    localTime: '09:00',
  } as const;
}

function createEvidenceReceiptRequest() {
  return {
    cluster: 'devnet',
    title: 'Receipt',
    kind: 'review_proof',
    status: 'approved',
    payload: { decision: 'approved' },
    preSignatureHash: 'hash_1',
    signingMessage: 'Sign this receipt',
    signature: 'sig_1',
  } as const;
}
