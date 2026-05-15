import { generateKeyPairSync, sign as signDetached } from 'node:crypto';

import {
  workflowDecisionProofMessage,
  type ApprovalRequestRecord,
} from '@solana-agent-wallet-adapter/workflow';
import { describe, expect, it } from 'vitest';

import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { recordSkillExecutionOutcomeForApproval } from '../cloud/skillExecutionLifecycle.js';
import type { SkillExecutionStoreRecord } from '../cloud/store.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const NOW = '2026-05-15T14:00:00.000Z';

describe('recordSkillExecutionOutcomeForApproval', () => {
  it('marks approved skill executions successful and writes a verified evidence receipt', async () => {
    const wallet = createTestWallet();
    const store = new MemoryWorkflowStore();
    const approval = approvedSkillApproval(wallet);
    await store.saveSkillExecution(pendingSkillExecution(wallet.walletAddress, approval.id));

    await recordSkillExecutionOutcomeForApproval({
      store,
      evidenceStore: store,
      clock: { now: () => new Date(NOW) },
      session: { walletAddress: wallet.walletAddress },
      approval,
    });

    const execution = await store.getSkillExecutionByApprovalRequestId(wallet.walletAddress, approval.id);
    expect(execution?.result).toBe('success');
    expect(execution?.evidenceReceiptId).toBeTruthy();
    expect(execution?.execution).toMatchObject({
      result: 'success',
      evidenceReceiptId: execution?.evidenceReceiptId,
      metadata: { executedAmount: '50' },
    });

    const receipts = await store.listEvidence(wallet.walletAddress);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      id: execution?.evidenceReceiptId,
      kind: 'tool_trace_receipt',
      status: 'approved',
      verified: true,
      metadata: {
        skillId: 'friday-dca',
        approvalRequestId: approval.id,
        result: 'success',
      },
    });
  });

  it('is idempotent for repeated terminal approval callbacks', async () => {
    const wallet = createTestWallet();
    const store = new MemoryWorkflowStore();
    const approval = approvedSkillApproval(wallet);
    await store.saveSkillExecution(pendingSkillExecution(wallet.walletAddress, approval.id));

    const input = {
      store,
      evidenceStore: store,
      clock: { now: () => new Date(NOW) },
      session: { walletAddress: wallet.walletAddress },
      approval,
    };
    await recordSkillExecutionOutcomeForApproval(input);
    await recordSkillExecutionOutcomeForApproval(input);

    expect(await store.listEvidence(wallet.walletAddress)).toHaveLength(1);
    const audits = await store.forWallet(wallet.walletAddress).listAuditEvents();
    expect(audits.filter((event) => event.type === 'skill.execution.receipted')).toHaveLength(1);
  });
});

function pendingSkillExecution(walletAddress: string, approvalRequestId: string): SkillExecutionStoreRecord {
  return {
    id: 'skill-exec-test',
    installId: 'skill-install-test',
    walletAddress,
    skillId: 'friday-dca',
    proposedAt: NOW,
    result: 'pending',
    approvalRequestId,
    execution: {
      id: 'skill-exec-test',
      installId: 'skill-install-test',
      walletAddress,
      skillId: 'friday-dca',
      proposedAt: NOW,
      approvalRequestId,
      result: 'pending',
    },
  };
}

function approvedSkillApproval(wallet: TestWallet): ApprovalRequestRecord {
  const approval: ApprovalRequestRecord = {
    id: 'approval-skill-test',
    walletAddress: wallet.walletAddress,
    kind: 'prepare_swap',
    status: 'approved',
    summary: 'Friday DCA',
    params: { amount: '50', inputMint: 'USDC', outputMint: 'SOL' },
    cluster: 'devnet',
    dueAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    decidedAt: NOW,
    amount: '50',
    metadata: {
      skillId: 'friday-dca',
      skillInstallId: 'skill-install-test',
      skillVersion: '1.0.0',
    },
  };
  const message = workflowDecisionProofMessage({ approval, decision: 'approved' });
  return {
    ...approval,
    decisionProofMessage: message,
    decisionProofSignature: encodeBase58(signDetached(null, Buffer.from(message, 'utf8'), wallet.privateKey)),
    decisionProofVerified: true,
  };
}

interface TestWallet {
  walletAddress: string;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
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

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let value = 0n;
  for (const byte of bytes) value = (value * 256n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leadingZeroes = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeroes += '1';
  }
  return leadingZeroes + (encoded || '');
}
