import { describe, expect, it } from 'vitest';

import {
  type AgentDecisionContract,
  type AgentEvidenceFact,
  type AgentEvidenceGateResult,
  type AgentEvidenceRequirement,
  type AgentFactRoute,
  createDecisionAuditReceipt,
  evaluateAgentEvidenceGate,
  normalizeAgentEvidenceFact,
} from '../index.js';

const WALLET = 'Wallet1111111111111111111111111111111111111';
const PLAN_FP = 'plan-fp-abc';

function route(id: string): AgentFactRoute {
  return {
    id,
    need: 'swap_quote',
    provider: 'jupiter',
    endpoint: id,
    status: 'required',
    reason: id,
  };
}

function requirement(routeId: string): AgentEvidenceRequirement {
  return {
    id: `req.${routeId}`,
    routeId,
    need: 'swap_quote',
    provider: 'jupiter',
    endpoint: routeId,
    status: 'required',
    ttlMs: 60_000,
    blocking: true,
    reason: 'required',
  };
}

function fact(id: string, routeId: string): AgentEvidenceFact {
  return normalizeAgentEvidenceFact({
    id,
    label: id,
    value: 'ok',
    tone: 'good',
    source: 'jupiter',
    routeId,
    checkedAt: new Date().toISOString(),
    ttlMs: 60_000,
  });
}

function gateOf(reqs: AgentEvidenceRequirement[], facts: AgentEvidenceFact[]): AgentEvidenceGateResult {
  return evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
}

const contract: AgentDecisionContract = {
  decision: 'approve',
  reason: 'looks safe',
  summary: 'safe',
  evidenceFactIds: ['fact.a', 'fact.b'],
  blockingFactIds: [],
  missingFactIds: [],
};

describe('createDecisionAuditReceipt', () => {
  it('produces a receipt with all required hashes and ids', async () => {
    const reqs = [requirement('jupiter.swap_order_preview')];
    const facts = [fact('fact.a', 'jupiter.swap_order_preview'), fact('fact.b', 'jupiter.swap_order_preview')];
    const gate = gateOf(reqs, facts);
    const receipt = await createDecisionAuditReceipt({
      finalDecision: 'approve',
      decisionContract: contract,
      gate,
      facts,
      requirements: reqs,
      routes: [route('jupiter.swap_order_preview')],
      walletAddress: WALLET,
      cluster: 'mainnet-beta',
      planFingerprint: PLAN_FP,
      connectorId: 'jupiter',
      connectorProfile: 'swap_dex',
    });
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.walletAddress).toBe(WALLET);
    expect(receipt.cluster).toBe('mainnet-beta');
    expect(receipt.connectorId).toBe('jupiter');
    expect(receipt.connectorProfile).toBe('swap_dex');
    expect(receipt.routePlanHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.aiDecisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.providerRoutes).toEqual(['jupiter.swap_order_preview']);
    expect(receipt.evidenceFactIds).toEqual(['fact.a', 'fact.b']);
    expect(receipt.gateDecision).toBe('pass');
    expect(receipt.finalDecision).toBe('approve');
    expect(receipt.receiptId).toMatch(/^rcpt_/);
  });

  it('is hash-stable for the same inputs', async () => {
    const reqs = [requirement('jupiter.swap_order_preview')];
    const fixedFacts = [fact('fact.a', 'jupiter.swap_order_preview')];
    // Force identical checkedAt so the evidenceHash matches across runs.
    fixedFacts[0]!.checkedAt = '2026-05-14T00:00:00.000Z';
    const gate = gateOf(reqs, fixedFacts);
    const args = {
      finalDecision: 'approve' as const,
      decisionContract: contract,
      gate,
      facts: fixedFacts,
      requirements: reqs,
      routes: [route('jupiter.swap_order_preview')],
      walletAddress: WALLET,
      cluster: 'mainnet-beta',
      planFingerprint: PLAN_FP,
    };
    const receiptA = await createDecisionAuditReceipt(args);
    const receiptB = await createDecisionAuditReceipt(args);
    expect(receiptA.routePlanHash).toBe(receiptB.routePlanHash);
    expect(receiptA.evidenceHash).toBe(receiptB.evidenceHash);
    expect(receiptA.aiDecisionHash).toBe(receiptB.aiDecisionHash);
    // receiptId is non-stable by design (timestamp + random), but the content hashes must match.
  });
});
