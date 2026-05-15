import { describe, expect, it } from 'vitest';

import {
  type AgentEvidenceFact,
  type AgentEvidenceRequirement,
  computeCounterfactuals,
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

function fact(partial: { id: string; label: string; routeId?: string; tone?: AgentEvidenceFact['tone']; severity?: AgentEvidenceFact['severity'] }): AgentEvidenceFact {
  return normalizeAgentEvidenceFact({
    id: partial.id,
    label: partial.label,
    value: 'ok',
    tone: partial.tone ?? 'good',
    source: 'deterministic',
    severity: partial.severity,
    routeId: partial.routeId,
    checkedAt: new Date().toISOString(),
    ttlMs: 60_000,
  });
}

describe('computeCounterfactuals', () => {
  it('approve case: shows that a stale quote would have flipped to deny', () => {
    const reqs = [req({ routeId: 'jupiter.swap_order_preview', need: 'swap_quote', provider: 'jupiter' })];
    const facts = [fact({ id: 'fact.q', routeId: 'jupiter.swap_order_preview', label: 'Quote' })];
    const gate = evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
    const cfs = computeCounterfactuals({
      decision: 'approve',
      gate,
      facts,
      requirements: reqs,
      context: { walletAddress: WALLET, isWalletScoped: true },
    });
    expect(cfs.length).toBeGreaterThan(0);
    const flipsToDeny = cfs.some((cf) => cf.decisionBefore === 'approve' && cf.decisionAfter === 'deny');
    expect(flipsToDeny).toBe(true);
    // At least one CF should reference the quote fact going stale or becoming blocking.
    expect(cfs.some((cf) => cf.factId === 'fact.q' && (cf.change === 'fact_becomes_stale' || cf.change === 'fact_becomes_blocking'))).toBe(true);
  });

  it('deny case: shows that clearing the blocking security fact would have flipped to approve', () => {
    const reqs = [req({ routeId: 'birdeye.token_security', need: 'token_security', provider: 'birdeye' })];
    const facts = [fact({ id: 'fact.sec', routeId: 'birdeye.token_security', label: 'Mint authority active', tone: 'fail', severity: 'block' })];
    const gate = evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
    const cfs = computeCounterfactuals({
      decision: 'deny',
      gate,
      facts,
      requirements: reqs,
      context: { walletAddress: WALLET, isWalletScoped: true },
    });
    expect(cfs.some((cf) => cf.factId === 'fact.sec' && cf.change === 'fact_becomes_clean' && cf.decisionAfter === 'approve')).toBe(true);
  });

  it('deny case (missing required): shows that synthesizing the missing fact would have flipped to approve', () => {
    const reqs = [req({ routeId: 'jupiter.swap_order_preview', need: 'swap_quote', provider: 'jupiter' })];
    const gate = evaluateAgentEvidenceGate(reqs, [], { walletAddress: WALLET, isWalletScoped: true });
    expect(gate.decision).toBe('block');
    const cfs = computeCounterfactuals({
      decision: 'deny',
      gate,
      facts: [],
      requirements: reqs,
      context: { walletAddress: WALLET, isWalletScoped: true },
    });
    expect(cfs.some((cf) => cf.change === 'fact_becomes_present' && cf.decisionAfter === 'approve')).toBe(true);
  });

  it('returns at most 5 counterfactuals', () => {
    const reqs = Array.from({ length: 10 }, (_, i) => req({ id: `req.${i}`, routeId: `route.${i}` }));
    const facts = Array.from({ length: 10 }, (_, i) => fact({ id: `fact.${i}`, routeId: `route.${i}`, label: `f${i}` }));
    const gate = evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
    const cfs = computeCounterfactuals({
      decision: 'approve',
      gate,
      facts,
      requirements: reqs,
      context: { walletAddress: WALLET, isWalletScoped: true },
    });
    expect(cfs.length).toBeLessThanOrEqual(5);
  });

  it('wallet-disconnect counterfactual surfaces for approve outcomes', () => {
    const reqs = [
      req({ routeId: 'wallet.connected_public_key', need: 'wallet_identity', provider: 'wallet', ttlMs: Number.POSITIVE_INFINITY }),
    ];
    const facts = [fact({ id: 'fact.wallet', routeId: 'wallet.connected_public_key', label: 'Wallet' })];
    const gate = evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
    const cfs = computeCounterfactuals({
      decision: 'approve',
      gate,
      facts,
      requirements: reqs,
      context: { walletAddress: WALLET, isWalletScoped: true },
    });
    expect(cfs.some((cf) => cf.change === 'wallet_disconnect' && cf.decisionAfter !== 'approve')).toBe(true);
  });
});
