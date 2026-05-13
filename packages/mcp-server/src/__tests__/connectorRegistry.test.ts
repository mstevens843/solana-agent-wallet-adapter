import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTOR_APPROVAL_BOUNDARY,
  getConnector,
  listConnectorCapabilities,
} from '../connectorRegistry.js';
import { DEFAULT_CONFIG } from '../config.js';

describe('MCP connector registry', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers first-class Kamino and Jupiter capabilities', () => {
    const connectors = listConnectorCapabilities(DEFAULT_CONFIG);
    const kamino = connectors.find((connector) => connector.id === 'kamino');
    const jupiter = connectors.find((connector) => connector.id === 'jupiter');

    expect(kamino).toMatchObject({
      name: 'Kamino Finance',
      readCapabilities: ['positions', 'rewards', 'markets'],
      writeCapabilities: ['earn', 'withdraw'],
      executionMode: 'first_class_prepare',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    });
    expect(kamino?.readTools).toContain('solana_connector_read_facts');
    expect(kamino?.actionTools).toContain('solana_prepare_kamino_deposit');
    expect(jupiter).toMatchObject({
      name: 'Jupiter',
      readCapabilities: ['swap'],
      writeCapabilities: ['swap'],
      executionMode: 'wallet_approval',
    });
    expect(jupiter?.readTools).toContain('solana_jupiter_order_preview');
  });

  it('keeps Jupiter swap preparation discoverable when preview credentials are missing', () => {
    vi.stubEnv('JUPITER_API_KEY', '');
    vi.stubEnv('JUP_API_KEY', '');

    const jupiter = listConnectorCapabilities(DEFAULT_CONFIG).find((connector) => connector.id === 'jupiter');

    expect(jupiter?.readiness.reads).toMatchObject({
      ready: false,
      reason: expect.stringContaining('Missing Jupiter API key'),
    });
    expect(jupiter?.readiness.actions).toMatchObject({ ready: true });
    expect(jupiter?.limitations.join(' ')).toContain('quote preview, direct execution, and approval-time quote refresh require a Jupiter API key');
  });

  it('registers planned connectors as explicit unavailable runtime capabilities', () => {
    const meteora = listConnectorCapabilities(DEFAULT_CONFIG).find((connector) => connector.id === 'meteora');

    expect(meteora).toMatchObject({
      name: 'Meteora',
      readCapabilities: [],
      writeCapabilities: [],
      executionMode: 'unavailable',
      readiness: {
        reads: { ready: false },
        actions: { ready: false },
      },
    });
    expect(meteora?.limitations.join(' ')).toContain('does not expose first-class reads');
  });

  it('resolves common aliases without reading browser code', () => {
    expect(getConnector('jup')?.id).toBe('jupiter');
    expect(getConnector('jupiter lend')?.id).toBe('jupiter');
    expect(getConnector('kamino lend')?.id).toBe('kamino');
    expect(getConnector('meteora dlmm')?.id).toBe('meteora');
  });
});
