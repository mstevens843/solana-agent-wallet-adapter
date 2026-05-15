import { describe, expect, it } from 'vitest';

import {
  type AgentEvidenceFact,
  type AgentEvidenceGateResult,
  type AgentEvidenceRequirement,
  computeConfidence,
  bandForScore,
  evaluateAgentEvidenceGate,
  normalizeAgentEvidenceFact,
} from '../index.js';

const WALLET = 'Wallet1111111111111111111111111111111111111';

function req(partial: Partial<AgentEvidenceRequirement>): AgentEvidenceRequirement {
  return {
    id: partial.id ?? `req.${partial.routeId ?? 'route'}`,
    routeId: partial.routeId ?? 'route',
    need: partial.need ?? 'protocol_position',
    provider: partial.provider ?? 'protocol_connector',
    endpoint: partial.endpoint ?? 'endpoint',
    status: partial.status ?? 'required',
    ttlMs: partial.ttlMs ?? 60_000,
    blocking: partial.blocking ?? true,
    reason: partial.reason ?? 'required',
  };
}

function fact(partial: { id: string; label: string; routeId?: string; tone?: AgentEvidenceFact['tone']; severity?: AgentEvidenceFact['severity']; checkedAt?: string }): AgentEvidenceFact {
  return normalizeAgentEvidenceFact({
    id: partial.id,
    label: partial.label,
    value: 'ok',
    tone: partial.tone ?? 'good',
    source: 'deterministic',
    severity: partial.severity,
    routeId: partial.routeId,
    checkedAt: partial.checkedAt ?? new Date().toISOString(),
    ttlMs: 60_000,
  });
}

function passingGate(reqs: AgentEvidenceRequirement[], facts: AgentEvidenceFact[]): AgentEvidenceGateResult {
  return evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
}

describe('computeConfidence', () => {
  it('returns high band when gate passes cleanly with good facts and AI states high', () => {
    const reqs = [req({ routeId: 'jupiter.swap_order_preview', need: 'swap_quote', provider: 'jupiter' })];
    const facts = [fact({ id: 'fact.q', routeId: 'jupiter.swap_order_preview', label: 'Quote' })];
    const gate = passingGate(reqs, facts);
    const result = computeConfidence({
      gate,
      facts,
      requirements: reqs,
      aiBand: 'high',
      decision: 'approve',
      citedFactIdCount: 1,
    });
    expect(result.band).toBe('high');
    expect(result.score).toBeGreaterThanOrEqual(0.8);
    expect(result.factors).toEqual([]);
  });

  it('drops to medium when AI states medium', () => {
    const reqs = [req({ routeId: 'jupiter.swap_order_preview', need: 'swap_quote', provider: 'jupiter' })];
    const facts = [fact({ id: 'fact.q', routeId: 'jupiter.swap_order_preview', label: 'Quote' })];
    const gate = passingGate(reqs, facts);
    const result = computeConfidence({
      gate,
      facts,
      requirements: reqs,
      aiBand: 'medium',
      decision: 'approve',
      citedFactIdCount: 1,
    });
    expect(result.factors.some((f) => f.id === 'ai.confidence.medium')).toBe(true);
  });

  it('drops to low when gate blocks', () => {
    const reqs = [req({ routeId: 'birdeye.token_security', need: 'token_security', provider: 'birdeye' })];
    const facts = [fact({ id: 'fact.sec', routeId: 'birdeye.token_security', label: 'Mint authority active', tone: 'fail', severity: 'block' })];
    const gate = passingGate(reqs, facts);
    const result = computeConfidence({
      gate,
      facts,
      requirements: reqs,
      decision: 'deny',
      citedFactIdCount: 1,
    });
    expect(result.band).toBe('low');
    expect(result.score).toBeLessThan(0.5);
    expect(result.factors.some((f) => f.id === 'gate.blocked')).toBe(true);
    expect(result.factors.some((f) => f.id === 'facts.blocking')).toBe(true);
  });

  it('penalizes approve with zero cited evidence + no research', () => {
    const reqs = [req({ routeId: 'jupiter.swap_order_preview', need: 'swap_quote', provider: 'jupiter' })];
    const facts = [fact({ id: 'fact.q', routeId: 'jupiter.swap_order_preview', label: 'Quote' })];
    const gate = passingGate(reqs, facts);
    const result = computeConfidence({
      gate,
      facts,
      requirements: reqs,
      aiBand: 'high',
      decision: 'approve',
      citedFactIdCount: 0,
      externalResearchUsed: false,
    });
    expect(result.factors.some((f) => f.id === 'approval.unsupported')).toBe(true);
  });

  it('does NOT penalize approve with zero ids when external research was used (T-Mobile case)', () => {
    const reqs = [req({ routeId: 'wallet.connected_public_key', need: 'wallet_identity', provider: 'wallet', ttlMs: Number.POSITIVE_INFINITY })];
    const facts = [fact({ id: 'fact.wallet', routeId: 'wallet.connected_public_key', label: 'Wallet' })];
    const gate = passingGate(reqs, facts);
    const result = computeConfidence({
      gate,
      facts,
      requirements: reqs,
      aiBand: 'high',
      decision: 'approve',
      citedFactIdCount: 0,
      externalResearchUsed: true,
    });
    expect(result.factors.some((f) => f.id === 'approval.unsupported')).toBe(false);
    expect(result.band).toBe('high');
  });

  it('caps deltas so a single missing requirement does not drive the score below zero', () => {
    const reqs = [req({ routeId: 'a' }), req({ routeId: 'b' }), req({ routeId: 'c' })];
    const gate = evaluateAgentEvidenceGate(reqs, [], { walletAddress: WALLET, isWalletScoped: true });
    const result = computeConfidence({
      gate,
      facts: [],
      requirements: reqs,
      decision: 'deny',
      citedFactIdCount: 0,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThan(0.3);
  });

  it('bandForScore boundaries', () => {
    expect(bandForScore(0.81)).toBe('high');
    expect(bandForScore(0.8)).toBe('high');
    expect(bandForScore(0.79)).toBe('medium');
    expect(bandForScore(0.5)).toBe('medium');
    expect(bandForScore(0.499)).toBe('low');
    expect(bandForScore(0)).toBe('low');
  });
});
