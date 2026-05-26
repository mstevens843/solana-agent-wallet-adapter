import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listConnectors } from '../forms/connectorMeta.js';
import {
  countEnabledConnectors,
  enabledConnectorIds,
  extractInstalledConnectorKeyIds,
  normalizeProtocolConnectorState,
  setConnectorEnabled,
} from '../flows/connectorState.js';

test('connector preferences default missing entries to off', () => {
  const normalized = normalizeProtocolConnectorState(null);
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.entries.jupiter?.enabled, false);
  assert.equal(normalized.entries.marinade?.enabled, false);
  assert.equal(enabledConnectorIds(normalized).size, 0);
});

test('connector preferences normalize legacy flat payloads and canonical web payloads', () => {
  const flat = normalizeProtocolConnectorState({
    jupiter: true,
    marinade: { enabled: false },
    kamino: { enabled: 'truthy-string' },
  });
  assert.equal(flat.entries.jupiter?.enabled, true);
  assert.equal(flat.entries.marinade?.enabled, false);
  assert.equal(flat.entries.kamino?.enabled, true);
  assert.equal(countEnabledConnectors(flat), 2);

  const canonical = normalizeProtocolConnectorState({
    payload: {
      schemaVersion: 2,
      entries: {
        raydium: { enabled: true, enabledAt: '2026-05-26T00:00:00.000Z' },
      },
    },
  });
  assert.equal(canonical.entries.raydium?.enabled, true);
  assert.equal(canonical.entries.raydium?.enabledAt, '2026-05-26T00:00:00.000Z');
  assert.equal(canonical.entries.orca?.enabled, false);
});

test('setConnectorEnabled writes canonical timestamps', () => {
  const initial = normalizeProtocolConnectorState(null);
  const enabled = setConnectorEnabled(initial, 'meteora', true, new Date('2026-05-26T12:00:00Z'));
  assert.equal(enabled.entries.meteora?.enabled, true);
  assert.equal(enabled.entries.meteora?.enabledAt, '2026-05-26T12:00:00.000Z');

  const disabled = setConnectorEnabled(enabled, 'meteora', false, new Date('2026-05-26T13:00:00Z'));
  assert.equal(disabled.entries.meteora?.enabled, false);
  assert.equal(disabled.entries.meteora?.enabledAt, '2026-05-26T12:00:00.000Z');
  assert.equal(disabled.entries.meteora?.disabledAt, '2026-05-26T13:00:00.000Z');
});

test('connector secret summaries parse the web-shaped response', () => {
  const ids = extractInstalledConnectorKeyIds({
    secrets: {
      lulo: { hasKey: true, savedAt: '2026-05-26T00:00:00.000Z' },
      sanctum: { hasKey: false },
      phoenix: { hasKey: true },
    },
  });
  assert.deepEqual([...ids].sort(), ['lulo', 'phoenix']);
});

test('Jupiter is not a CLI BYO-key connector', () => {
  const jupiter = listConnectors().find((connector) => connector.id === 'jupiter');
  assert.equal(jupiter?.needsKey, false);
});
