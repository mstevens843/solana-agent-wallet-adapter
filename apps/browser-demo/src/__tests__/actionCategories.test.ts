import { describe, expect, it } from 'vitest';

import { PROTOCOL_CONNECTORS } from '../connectedDapps.js';
import {
  ACTION_TYPE_CATEGORY,
  CONNECTOR_PRIORITY,
  connectorsForCategory,
  connectorActionFormsForConnector,
  formCategories,
} from '../connectorDrafting.js';

const ENV = { connectedDapps: { schemaVersion: 2 as const, entries: {} as Record<string, never> }, cluster: 'mainnet-beta' };

describe('action-first categorization', () => {
  it('maps every connector actionKind (except swap) to a category', () => {
    const missing: string[] = [];
    for (const connector of PROTOCOL_CONNECTORS) {
      for (const kind of connector.actionKinds) {
        if (kind === 'swap') continue;
        if (!ACTION_TYPE_CATEGORY[kind]) missing.push(`${connector.id}:${kind}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('gives every connector form ≥1 category', () => {
    const empty: string[] = [];
    for (const connector of PROTOCOL_CONNECTORS) {
      for (const form of connectorActionFormsForConnector(connector)) {
        if (formCategories(form).size === 0) empty.push(form.id);
      }
    }
    expect(empty).toEqual([]);
  });

  it('every connector has a priority', () => {
    const missing = PROTOCOL_CONNECTORS.filter((c) => CONNECTOR_PRIORITY[c.id] === undefined).map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it('orders each action group by significance', () => {
    const ids = (cat: Parameters<typeof connectorsForCategory>[0]) =>
      connectorsForCategory(cat, ENV).map((c) => c.id);
    expect(ids('lend')[0]).toBe('jupiter');
    expect(ids('lp')[0]).toBe('raydium');
    expect(ids('stake')[0]).toBe('jito');
    expect(ids('limit')[0]).toBe('jupiter');
    expect(ids('nft')[0]).toBe('tensor');
    // lend offers many protocols; borrow a focused set
    expect(ids('lend')).toEqual(expect.arrayContaining(['jupiter', 'kamino', 'marginfi', 'save', 'drift', 'lulo', 'project0']));
    expect(ids('borrow')).toEqual(expect.arrayContaining(['jupiter', 'marginfi', 'save', 'project0']));
    expect(ids('lp')).toEqual(expect.arrayContaining(['raydium', 'orca', 'meteora']));
  });

  it('excludes Sanctum from every action list (hidden in Preferences for now)', () => {
    for (const cat of ['swap', 'stake', 'lp', 'lend', 'limit', 'dca', 'borrow', 'perps', 'nft', 'governance', 'bridge', 'oracle', 'read'] as const) {
      expect(connectorsForCategory(cat, ENV).map((c) => c.id)).not.toContain('sanctum');
    }
  });
});
