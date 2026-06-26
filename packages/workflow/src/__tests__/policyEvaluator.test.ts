import { describe, expect, it } from 'vitest';

import { extractAtoms, type AgentAtom } from '../agentAtoms.js';
import {
  compareNumeric,
  evaluateAtom,
  evaluateAtoms,
  formatDuration,
  formatUsdCompact,
  parseAgeThresholdSeconds,
  parseDominanceThreshold,
  parseFearGreedThreshold,
  type ResolvedFactValue,
} from '../policyEvaluator.js';

describe('compareNumeric', () => {
  it('handles every operator', () => {
    expect(compareNumeric('gt', 5, 3)).toBe(true);
    expect(compareNumeric('gte', 3, 3)).toBe(true);
    expect(compareNumeric('lt', 1, 3)).toBe(true);
    expect(compareNumeric('lte', 3, 3)).toBe(true);
    expect(compareNumeric('eq', 3, 3)).toBe(true);
    expect(compareNumeric('eq', 4, 3)).toBe(false);
  });
});

describe('format helpers', () => {
  it('formats USD with sensible compaction', () => {
    expect(formatUsdCompact(2_500_000_000_000)).toBe('$2.50T');
    expect(formatUsdCompact(5_000_000_000)).toBe('$5.00B');
    expect(formatUsdCompact(2_300_000)).toBe('$2.30M');
    expect(formatUsdCompact(1_500)).toBe('$1.50K');
    expect(formatUsdCompact(42)).toBe('$42.00');
    expect(formatUsdCompact(0.5)).toBe('$0.5000');
  });

  it('formats durations from seconds', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(120)).toBe('2m');
    expect(formatDuration(3_600)).toBe('1.0h');
    expect(formatDuration(86_400)).toBe('1.0d');
    expect(formatDuration(60 * 86_400)).toBe('2.0 months');
  });
});

describe('evaluateAtom — price', () => {
  const atom: AgentAtom = { id: 'atom.price.sol.gt.80', type: 'price', rawText: 'SOL > $80', subject: 'SOL', op: 'gt', value: 80, unit: 'USD' };

  it('passes when fact is above threshold', () => {
    const fact: ResolvedFactValue = { numeric: 146, source: 'jupiter' };
    const out = evaluateAtom(atom, fact);
    expect(out.pass).toBe(true);
    expect(out.finding.tone).toBe('good');
    expect(out.finding.value).toContain('jupiter');
  });

  it('fails when fact is below threshold', () => {
    const fact: ResolvedFactValue = { numeric: 70, source: 'jupiter' };
    const out = evaluateAtom(atom, fact);
    expect(out.pass).toBe(false);
    expect(out.finding.tone).toBe('fail');
  });

  it('reports unresolved (tone warn) when no fact', () => {
    const out = evaluateAtom(atom, undefined);
    expect(out.pass).toBeUndefined();
    expect(out.unresolved).toBe(true);
    expect(out.finding.tone).toBe('warn');
  });
});

describe('evaluateAtom — token_metric', () => {
  it('passes a liquidity gate and formats USD compact + source', () => {
    const atom: AgentAtom = { id: 'atom.token_metric.liquidity.gt.100000', type: 'token_metric', rawText: 'liquidity > $100k', field: 'liquidity', op: 'gt', value: 100_000 };
    const out = evaluateAtom(atom, { numeric: 250_000, source: 'jupiter' });
    expect(out.pass).toBe(true);
    expect(out.finding.tone).toBe('good');
    expect(out.finding.label).toBe('Token liquidity');
    expect(out.finding.value).toContain('jupiter');
  });

  it('fails a top-holder gate and formats a percentage', () => {
    const atom: AgentAtom = { id: 'atom.token_metric.top_holder_pct.lt.20', type: 'token_metric', rawText: 'top holder < 20%', field: 'top_holder_pct', op: 'lt', value: 20 };
    const out = evaluateAtom(atom, { numeric: 41.5, source: 'jupiter' });
    expect(out.pass).toBe(false);
    expect(out.finding.tone).toBe('fail');
    expect(out.finding.value).toContain('41.50%');
  });

  it('surfaces the organic score label and uses the named subject in the label', () => {
    const atom: AgentAtom = { id: 'atom.token_metric.organic_score.gte.70', type: 'token_metric', rawText: 'organic score high', field: 'organic_score', op: 'gte', value: 70, subject: 'bonk' };
    const out = evaluateAtom(atom, { numeric: 82, text: 'high', source: 'jupiter' });
    expect(out.pass).toBe(true);
    expect(out.finding.label).toBe('BONK organic score');
    expect(out.finding.value).toContain('82/100');
    expect(out.finding.value).toContain('high');
  });

  it('reports unresolved when no fact', () => {
    const atom: AgentAtom = { id: 'atom.token_metric.volume_24h.gt.50000', type: 'token_metric', rawText: '24h volume > $50k', field: 'volume_24h', op: 'gt', value: 50_000 };
    const out = evaluateAtom(atom, undefined);
    expect(out.unresolved).toBe(true);
    expect(out.finding.tone).toBe('warn');
  });
});

describe('evaluateAtom — market_regime', () => {
  it('passes Fear & Greed above threshold with classification surfaced', () => {
    const atom: AgentAtom = { id: 'atom.market_regime.fear_and_greed.gt.20', type: 'market_regime', rawText: 'F&G > 20', subject: 'fear_and_greed', op: 'gt', value: 20 };
    const out = evaluateAtom(atom, { numeric: 42, text: 'Fear', source: 'alternative_me' });
    expect(out.pass).toBe(true);
    expect(out.finding.label).toBe('BTC Fear & Greed');
    expect(out.finding.value).toContain('42');
    expect(out.finding.value).toContain('Fear');
  });

  it('fails BTC dominance below threshold', () => {
    const atom: AgentAtom = { id: 'atom.market_regime.btc_dominance.gt.50', type: 'market_regime', rawText: 'BTC dom > 50', subject: 'btc_dominance', op: 'gt', value: 50 };
    const out = evaluateAtom(atom, { numeric: 42.5, source: 'coingecko' });
    expect(out.pass).toBe(false);
    expect(out.finding.value).toContain('42.50%');
  });

  it('formats total_market_cap as USD compact', () => {
    const atom: AgentAtom = { id: 'atom.market_regime.total_market_cap.gt.2000000000000', type: 'market_regime', rawText: 'TMC > $2T', subject: 'total_market_cap', op: 'gt', value: 2_000_000_000_000 };
    const out = evaluateAtom(atom, { numeric: 3.2e12, source: 'coingecko' });
    expect(out.finding.value).toContain('$3.20T');
  });
});

describe('evaluateAtom — token_audit', () => {
  const atom: AgentAtom = { id: 'atom.token_audit.mint_authority_disabled.true', type: 'token_audit', rawText: 'mint authority disabled', field: 'mint_authority_disabled', expected: true };

  it('passes when boolean fact matches expected', () => {
    const out = evaluateAtom(atom, { boolean: true, source: 'jupiter' });
    expect(out.pass).toBe(true);
  });

  it('fails when boolean fact does not match', () => {
    const out = evaluateAtom(atom, { boolean: false, source: 'jupiter' });
    expect(out.pass).toBe(false);
  });
});

describe('evaluateAtom — token_age', () => {
  const atom: AgentAtom = { id: 'atom.token_age.gt.86400', type: 'token_age', rawText: 'age > 24h', op: 'gt', value: 86_400 };

  it('passes when age exceeds threshold', () => {
    const out = evaluateAtom(atom, { numeric: 30 * 86_400, source: 'helius' });
    expect(out.pass).toBe(true);
    expect(out.finding.value).toContain('1.0 months');
  });

  it('fails when age below threshold', () => {
    const out = evaluateAtom(atom, { numeric: 3_600, source: 'helius' });
    expect(out.pass).toBe(false);
  });
});

describe('evaluateAtom — external_price', () => {
  it('passes Helium plan under threshold', () => {
    const atom: AgentAtom = { id: 'atom.external_price.helium.lt.20', type: 'external_price', rawText: 'helium plan < $20', subject: 'helium phone plan', op: 'lt', value: 20, unit: 'USD' };
    const out = evaluateAtom(atom, { numeric: 15, source: 'web' });
    expect(out.pass).toBe(true);
    expect(out.finding.value).toContain('$15.00');
    expect(out.finding.value).toContain('web');
  });
});

describe('evaluateAtoms (batch)', () => {
  it('evaluates a full mixed NOTE end-to-end', () => {
    const { atoms } = extractAtoms({
      text: 'BTC Fear & Greed above 20. SOL above $80. mint authority disabled. helium phone plan less than $20.',
      knownTokenSymbols: ['SOL', 'USDC'],
    });
    const facts: Record<string, ResolvedFactValue> = {};
    for (const atom of atoms) {
      if (atom.type === 'market_regime' && atom.subject === 'fear_and_greed') facts[atom.id] = { numeric: 42, text: 'Fear', source: 'alternative_me' };
      if (atom.type === 'price' && atom.subject === 'SOL') facts[atom.id] = { numeric: 146, source: 'jupiter' };
      if (atom.type === 'token_audit') facts[atom.id] = { boolean: true, source: 'jupiter' };
      if (atom.type === 'external_price') facts[atom.id] = { numeric: 15, source: 'web' };
    }
    const results = evaluateAtoms(atoms, facts);
    expect(results.every((r) => r.pass === true || r.pass === undefined)).toBe(true);
    expect(results.filter((r) => r.pass === true).length).toBeGreaterThanOrEqual(4);
  });

  it('reports unresolved for atoms with no fact', () => {
    const { atoms } = extractAtoms({ text: 'SOL above $80' });
    const results = evaluateAtoms(atoms, {});
    expect(results[0]!.unresolved).toBe(true);
    expect(results[0]!.pass).toBeUndefined();
  });
});

describe('legacy threshold parsers', () => {
  it('parseFearGreedThreshold matches `above N`', () => {
    expect(parseFearGreedThreshold('Fear & Greed above 20')).toBe(20);
    expect(parseFearGreedThreshold('approve when fear and greed > 25')).toBe(25);
    expect(parseFearGreedThreshold('not a threshold')).toBeUndefined();
  });

  it('parseDominanceThreshold matches BTC dominance', () => {
    expect(parseDominanceThreshold('btc dominance above 50')).toBe(50);
    expect(parseDominanceThreshold('Bitcoin dominance > 42.5')).toBe(42.5);
    expect(parseDominanceThreshold('unrelated')).toBeUndefined();
  });

  it('parseAgeThresholdSeconds handles every unit', () => {
    expect(parseAgeThresholdSeconds('24', 'h')).toBe(24 * 3600);
    expect(parseAgeThresholdSeconds('7', 'days')).toBe(7 * 86_400);
    expect(parseAgeThresholdSeconds('2', 'weeks')).toBe(14 * 86_400);
    expect(parseAgeThresholdSeconds('1', 'month')).toBe(30 * 86_400);
    expect(parseAgeThresholdSeconds('30', 'min')).toBe(30 * 60);
  });
});
