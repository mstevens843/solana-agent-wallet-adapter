import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_ATOMS,
  buildConnectorContext,
  clampConnectorFacts,
  connectorActionCard,
  connectorCapabilityIndex,
  findConnectorAtomByIntent,
  getConnectorAtom,
} from '../connectorAtoms/index.js';

describe('getConnectorAtom', () => {
  it('resolves by action key and connectorId', () => {
    const atom = getConnectorAtom('jupiter', 'lend');
    expect(atom?.action).toBe('lend');
    expect(atom?.factSpec?.capability).toBe('earn');
  });

  it('resolves by alias and defaults connectorId to jupiter', () => {
    expect(getConnectorAtom(undefined, 'earn')?.action).toBe('lend');
    expect(getConnectorAtom('jupiter', 'take profit')?.action).toBe('limit');
    expect(getConnectorAtom('jupiter', 'recurring')?.action).toBe('dca');
  });

  it('returns undefined for unknown action / connector', () => {
    expect(getConnectorAtom('jupiter', 'nope')).toBeUndefined();
    expect(getConnectorAtom('jupiter', '')).toBeUndefined();
    expect(getConnectorAtom('kamino', 'lend')).toBeUndefined();
  });
});

describe('findConnectorAtomByIntent', () => {
  it('matches only when a connector token AND an action alias are present', () => {
    expect(findConnectorAtomByIntent('show my jupiter lend positions')?.action).toBe('lend');
    expect(findConnectorAtomByIntent('what are my jup dca orders')?.action).toBe('dca');
    expect(findConnectorAtomByIntent("what's my jupiter borrow health")?.action).toBe('borrow');
  });

  it('does NOT hijack generic questions (no connector token)', () => {
    expect(findConnectorAtomByIntent('what is the price of SOL')).toBeUndefined();
    expect(findConnectorAtomByIntent('show my lend positions')).toBeUndefined();
    expect(findConnectorAtomByIntent('how is the market today')).toBeUndefined();
  });

  it('only returns fact-bearing atoms (knowledge-only swap/portfolio excluded)', () => {
    // "jupiter swap" has a connector token + 'swap' alias but swap is knowledge-only.
    expect(findConnectorAtomByIntent('jupiter swap 1 sol to usdc')).toBeUndefined();
  });
});

describe('Jupiter format() projections', () => {
  it('lend → positions', () => {
    const raw = {
      connector: { id: 'jupiter', heavy: 'x'.repeat(500) },
      capability: 'earn',
      walletAddress: 'W',
      positions: [{ assetMint: 'So11111111111111111111111111111111111111112', tokenSymbol: 'SOL', underlyingAmount: '12.5', apy: 0.07, asOf: '2026-06-26T00:00:00Z' }],
    };
    const out = getConnectorAtom('jupiter', 'lend')!.factSpec!.format(raw);
    expect(out.kind).toBe('lend_positions');
    expect((out.positions as unknown[]).length).toBe(1);
    expect((out.positions as Array<Record<string, unknown>>)[0]).toMatchObject({ asset: 'SOL', supplied: '12.5', apy: 0.07 });
    // The verbose connector view must not leak into the compact projection.
    expect(JSON.stringify(out)).not.toContain('xxxxx');
  });

  it('lend → markets when no positions', () => {
    const raw = { connector: {}, capability: 'earn', tokens: [{ assetMint: 'm', tokenSymbol: 'USDC', apy: 0.05, utilization: 0.8 }] };
    const out = getConnectorAtom('jupiter', 'lend')!.factSpec!.format(raw);
    expect(out.kind).toBe('lend_markets');
    expect((out.markets as Array<Record<string, unknown>>)[0]).toMatchObject({ asset: 'USDC', apy: 0.05 });
  });

  it('borrow → positions with health + status', () => {
    const raw = {
      connector: {},
      capability: 'positions',
      positions: [{ vaultId: 3, collateralAmount: '100', debtAmount: '40', healthRatio: 1.8, liquidationStatus: 'safe' }],
    };
    const out = getConnectorAtom('jupiter', 'borrow')!.factSpec!.format(raw);
    expect(out.kind).toBe('borrow_positions');
    expect((out.positions as Array<Record<string, unknown>>)[0]).toMatchObject({ vault: 3, debt: '40', health: 1.8, status: 'safe' });
  });

  it('perps → read-only status', () => {
    const raw = { connector: {}, capability: 'perps', readOnly: true, apiStatus: 'beta', warnings: ['w1', 'w2', 'w3', 'w4'] };
    const out = getConnectorAtom('jupiter', 'perps')!.factSpec!.format(raw);
    expect(out).toMatchObject({ kind: 'perps_status', supported: true, readOnly: true, apiStatus: 'beta' });
    expect((out.warnings as unknown[]).length).toBe(3); // capped
  });

  it('gated products (limit/dca/prediction) strip the connector view defensively', () => {
    const raw = { connector: { heavy: 'y'.repeat(200) }, capability: 'trigger', orders: [{ id: 1 }] };
    const out = getConnectorAtom('jupiter', 'limit')!.factSpec!.format(raw);
    expect(JSON.stringify(out)).not.toContain('yyyyy');
  });
});

describe('clampConnectorFacts', () => {
  it('passes through small payloads and clamps oversized ones', () => {
    expect(clampConnectorFacts({ a: 1 }, 100)).toEqual({ a: 1 });
    const big = clampConnectorFacts({ blob: 'z'.repeat(5000) }, 200);
    expect(big.note).toMatch(/truncated/);
    expect(typeof big.preview).toBe('string');
  });
});

describe('capability index + cards', () => {
  it('index lists every atom with a tool route', () => {
    const index = connectorCapabilityIndex();
    expect(index).toContain('jupiter/lend');
    expect(index).toContain('get_connector_facts action=lend');
    // gated products are flagged
    expect(index).toMatch(/jupiter\/limit:.*\[enable flag\]/);
  });

  it('card includes the disabled note for gated products', () => {
    const card = connectorActionCard(getConnectorAtom('jupiter', 'limit'));
    expect(card).toContain('jupiter/limit');
    expect(card).toContain('disabled until');
    expect(connectorActionCard(undefined)).toBe('');
  });

  it('buildConnectorContext returns index always, card only on selection', () => {
    expect(buildConnectorContext()).toEqual({ index: connectorCapabilityIndex() });
    const withCard = buildConnectorContext({ connectorId: 'jupiter', action: 'lend' });
    expect(withCard.index).toBeTruthy();
    expect(withCard.card).toContain('Jupiter Lend');
  });
});

describe('atom registry invariants', () => {
  it('every fact-bearing atom has a buildInput + format and a non-empty card', () => {
    for (const atom of CONNECTOR_ATOMS) {
      expect(connectorActionCard(atom).length).toBeGreaterThan(0);
      if (atom.factSpec) {
        expect(typeof atom.factSpec.buildInput).toBe('function');
        expect(typeof atom.factSpec.format).toBe('function');
        // buildInput must never throw on an empty arg bag.
        expect(() => atom.factSpec!.buildInput({})).not.toThrow();
      }
    }
  });
});
