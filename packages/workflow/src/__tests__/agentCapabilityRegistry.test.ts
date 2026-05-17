import { describe, expect, it } from 'vitest';

import { extractAtoms, type AgentAtom } from '../agentAtoms.js';
import {
  CAPABILITY_REGISTRY,
  chainForAtom,
  hasWebFallback,
  isWebOnly,
  planAtomResolution,
  resolveAtom,
  resolveAtoms,
  type CapabilityResolutionAttempt,
  type CapabilityTier,
} from '../agentCapabilityRegistry.js';

function priceAtom(subject: string, value: number): AgentAtom {
  return { id: `atom.price.${subject.toLowerCase()}.gt.${value}`, type: 'price', rawText: `${subject} > $${value}`, subject, op: 'gt', value, unit: 'USD' };
}

function fearGreedAtom(value: number): AgentAtom {
  return { id: `atom.market_regime.fear_and_greed.gt.${value}`, type: 'market_regime', rawText: `fear & greed > ${value}`, subject: 'fear_and_greed', op: 'gt', value };
}

function btcDominanceAtom(value: number): AgentAtom {
  return { id: `atom.market_regime.btc_dominance.gt.${value}`, type: 'market_regime', rawText: `btc dominance > ${value}`, subject: 'btc_dominance', op: 'gt', value };
}

function externalPriceAtom(subject: string, value: number): AgentAtom {
  return { id: `atom.external_price.${subject.replace(/\s+/g,'_')}.lt.${value}`, type: 'external_price', rawText: `${subject} < $${value}`, subject, op: 'lt', value, unit: 'USD' };
}

describe('CAPABILITY_REGISTRY', () => {
  it('covers every atom type with at least one tier', () => {
    const types: Array<keyof typeof CAPABILITY_REGISTRY> = [
      'price', 'market_regime', 'token_audit', 'token_age', 'tx_gate', 'external_price', 'protocol_health',
    ];
    for (const type of types) {
      expect(CAPABILITY_REGISTRY[type].length).toBeGreaterThan(0);
    }
  });

  it('always lists web as the LAST tier when present (never first or middle)', () => {
    for (const type of Object.keys(CAPABILITY_REGISTRY) as Array<keyof typeof CAPABILITY_REGISTRY>) {
      const chain = CAPABILITY_REGISTRY[type];
      const webIdx = chain.findIndex((tier) => tier.provider === 'web');
      if (webIdx === -1) continue;
      expect(webIdx).toBe(chain.length - 1);
    }
  });

  it('marks external_price as web-only (no crypto API can answer)', () => {
    expect(isWebOnly(externalPriceAtom('helium phone plan', 20))).toBe(true);
  });

  it('marks crypto price as having multiple providers and web fallback', () => {
    const atom = priceAtom('SOL', 80);
    expect(isWebOnly(atom)).toBe(false);
    expect(hasWebFallback(atom)).toBe(true);
    const chain = chainForAtom(atom);
    expect(chain.map((tier) => tier.provider)).toEqual(['jupiter', 'coingecko', 'birdeye', 'web']);
  });

  it('routes Fear & Greed through alternative_me before web', () => {
    const chain = chainForAtom(fearGreedAtom(20));
    expect(chain[0]!.provider).toBe('alternative_me');
    expect(chain[chain.length - 1]!.provider).toBe('web');
    // The coingecko global tier should be skipped for fear_and_greed (its `when` excludes it).
    expect(chain.some((tier) => tier.provider === 'coingecko')).toBe(false);
  });

  it('routes BTC dominance through coingecko (skipping alternative_me)', () => {
    const chain = chainForAtom(btcDominanceAtom(50));
    expect(chain[0]!.provider).toBe('coingecko');
    expect(chain.some((tier) => tier.provider === 'alternative_me')).toBe(false);
  });

  it('token_audit and tx_gate have NO web tier (deterministic-only)', () => {
    expect(chainForAtom({ id: 'atom.token_audit.mint_authority_disabled.true', type: 'token_audit', rawText: '', field: 'mint_authority_disabled', expected: true } as AgentAtom).some((tier) => tier.provider === 'web')).toBe(false);
    expect(chainForAtom({ id: 'atom.tx_gate.no_extra_transfers', type: 'tx_gate', rawText: '', rule: 'no_extra_transfers' } as AgentAtom).some((tier) => tier.provider === 'web')).toBe(false);
  });
});

describe('planAtomResolution', () => {
  it('returns one plan per atom in input order', () => {
    const { atoms } = extractAtoms({
      text: 'SOL above $80 and helium phone plan less than $20 and BTC Fear & Greed above 20',
    });
    const plans = planAtomResolution(atoms);
    expect(plans.length).toBe(atoms.length);
    expect(plans.map((plan) => plan.atom.id)).toEqual(atoms.map((atom) => atom.id));
  });
});

describe('resolveAtom', () => {
  it('returns the first tier that resolves with status=ok', async () => {
    const calls: Array<{ provider: string; endpoint?: string }> = [];
    const resolver = async (_atom: AgentAtom, tier: CapabilityTier) => {
      calls.push({ provider: tier.provider, endpoint: tier.endpoint });
      // First (jupiter) succeeds.
      return {
        status: tier.provider === 'jupiter' ? 'ok' : 'missing',
        value: tier.provider === 'jupiter' ? 146 : undefined,
        source: tier.provider,
        endpoint: tier.endpoint,
        checkedAt: new Date().toISOString(),
      } as CapabilityResolutionAttempt;
    };
    const result = await resolveAtom(priceAtom('SOL', 80), resolver);
    expect(result.resolved?.value).toBe(146);
    expect(result.exhausted).toBe(false);
    expect(calls).toEqual([{ provider: 'jupiter', endpoint: 'price' }]);
  });

  it('falls through to the next tier when an earlier one returns missing', async () => {
    const calls: string[] = [];
    const resolver = async (_atom: AgentAtom, tier: CapabilityTier) => {
      calls.push(tier.provider);
      // jupiter and coingecko return missing; birdeye succeeds.
      const ok = tier.provider === 'birdeye';
      return {
        status: ok ? 'ok' : 'missing',
        value: ok ? 142 : undefined,
        source: tier.provider,
        checkedAt: new Date().toISOString(),
      } as CapabilityResolutionAttempt;
    };
    const result = await resolveAtom(priceAtom('SOL', 80), resolver);
    expect(calls).toEqual(['jupiter', 'coingecko', 'birdeye']);
    expect(result.resolved?.value).toBe(142);
    expect(result.exhausted).toBe(false);
  });

  it('treats thrown errors as failed attempts and continues', async () => {
    const resolver = async (_atom: AgentAtom, tier: CapabilityTier) => {
      if (tier.provider === 'jupiter') throw new Error('upstream timeout');
      return { status: 'ok', value: 'x', source: tier.provider, checkedAt: new Date().toISOString() } as CapabilityResolutionAttempt;
    };
    const result = await resolveAtom(priceAtom('SOL', 80), resolver);
    expect(result.attempts[0]!.status).toBe('error');
    expect(result.attempts[0]!.detail).toContain('upstream timeout');
    expect(result.resolved).toBeDefined();
  });

  it('reports exhausted=true when every tier returns missing/error', async () => {
    const resolver = async (_atom: AgentAtom, tier: CapabilityTier) => ({
      status: 'missing' as const,
      source: tier.provider,
      checkedAt: new Date().toISOString(),
    } as CapabilityResolutionAttempt);
    const result = await resolveAtom(priceAtom('SOL', 80), resolver);
    expect(result.exhausted).toBe(true);
    expect(result.resolved).toBeUndefined();
    expect(result.attempts).toHaveLength(chainForAtom(priceAtom('SOL', 80)).length);
  });

  it('for external_price calls only the web tier', async () => {
    const calls: string[] = [];
    const resolver = async (_atom: AgentAtom, tier: CapabilityTier) => {
      calls.push(tier.provider);
      return { status: 'ok', value: 15, source: tier.provider, checkedAt: new Date().toISOString() } as CapabilityResolutionAttempt;
    };
    await resolveAtom(externalPriceAtom('helium phone plan', 20), resolver);
    expect(calls).toEqual(['web']);
  });
});

describe('resolveAtom — transient retry', () => {
  it('retries a transient error once and accepts the retry value', async () => {
    let calls = 0;
    const resolver = async (_atom: AgentAtom, tier: CapabilityTier) => {
      calls += 1;
      // First call: transient error. Second call (retry): success.
      if (calls === 1) throw new Error('fetch failed: ETIMEDOUT');
      return { status: 'ok', value: 146, source: tier.provider, checkedAt: new Date().toISOString() } as CapabilityResolutionAttempt;
    };
    const result = await resolveAtom(priceAtom('SOL', 80), resolver, { retryDelayMs: 0 });
    expect(calls).toBe(2);
    expect(result.resolved?.value).toBe(146);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.status).toBe('error');
    expect(result.attempts[1]!.status).toBe('ok');
  });

  it('does NOT retry a non-transient error and falls through to next tier', async () => {
    let calls = 0;
    const resolver = async (_atom: AgentAtom, tier: CapabilityTier) => {
      calls += 1;
      if (tier.provider === 'jupiter') throw new Error('400 Bad Request: invalid mint');
      return { status: 'ok', value: 1, source: tier.provider, checkedAt: new Date().toISOString() } as CapabilityResolutionAttempt;
    };
    const result = await resolveAtom(priceAtom('SOL', 80), resolver, { retryDelayMs: 0 });
    // 1 error on jupiter (no retry) + 1 ok on coingecko = 2 attempts
    expect(calls).toBe(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.resolved?.source).toBe('coingecko');
  });

  it('honors retryTransient=false to disable retries entirely', async () => {
    let calls = 0;
    const resolver = async (_atom: AgentAtom, tier: CapabilityTier) => {
      calls += 1;
      throw new Error('timeout');
    };
    await resolveAtom(priceAtom('SOL', 80), resolver, { retryTransient: false, retryDelayMs: 0 });
    // 1 attempt per tier in the chain, no retries
    expect(calls).toBe(chainForAtom(priceAtom('SOL', 80)).length);
  });
});

describe('resolveAtom — telemetry trace hook', () => {
  it('emits one trace event per attempt (including retry)', async () => {
    const events: Array<{ atomId: string; tierIndex: number; provider: string; attempt: string; outcome: string }> = [];
    let calls = 0;
    const resolver = async (_atom: AgentAtom, tier: CapabilityTier) => {
      calls += 1;
      if (tier.provider === 'jupiter' && calls === 1) throw new Error('timeout flap');
      return { status: 'ok' as const, value: 99, source: tier.provider, checkedAt: new Date().toISOString() } as CapabilityResolutionAttempt;
    };
    await resolveAtom(priceAtom('SOL', 80), resolver, {
      retryDelayMs: 0,
      trace: (e) => events.push({ atomId: e.atomId, tierIndex: e.tierIndex, provider: e.tier.provider, attempt: e.attempt, outcome: e.outcome }),
    });
    expect(events).toEqual([
      { atomId: 'atom.price.sol.gt.80', tierIndex: 0, provider: 'jupiter', attempt: 'first', outcome: 'error' },
      { atomId: 'atom.price.sol.gt.80', tierIndex: 0, provider: 'jupiter', attempt: 'retry', outcome: 'ok' },
    ]);
  });
});

describe('resolveAtoms', () => {
  it('resolves a batch in parallel preserving order', async () => {
    const atoms: AgentAtom[] = [priceAtom('SOL', 80), externalPriceAtom('helium phone plan', 20)];
    const resolver = async (atom: AgentAtom, tier: CapabilityTier) => {
      // Simulate variable latency: external resolves slower than crypto.
      await new Promise((resolve) => setTimeout(resolve, atom.type === 'external_price' ? 20 : 5));
      return { status: 'ok', value: atom.id, source: tier.provider, checkedAt: new Date().toISOString() } as CapabilityResolutionAttempt;
    };
    const results = await resolveAtoms(atoms, resolver);
    expect(results.map((r) => r.atom.id)).toEqual(atoms.map((a) => a.id));
    expect(results.every((r) => r.resolved?.status === 'ok')).toBe(true);
  });
});
