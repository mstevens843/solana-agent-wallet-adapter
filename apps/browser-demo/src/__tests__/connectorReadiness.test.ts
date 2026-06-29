import { describe, expect, it } from 'vitest';

import { getAdapterMeta, type ConnectedDappId } from '../connectedDapps.js';
import { connectorNeedsCredential, connectorReadiness } from '../connectorReadiness.js';

function connector(id: ConnectedDappId) {
  const found = getAdapterMeta(id);
  expect(found).toBeDefined();
  return found!;
}

describe('connectorReadiness', () => {
  it('keeps credential requirements in the browser readiness model', () => {
    expect(['magiceden', 'tensor', 'sanctum', 'lulo', 'phoenix'].filter(connectorNeedsCredential)).toEqual([
      'magiceden',
      'tensor',
      'sanctum',
      'lulo',
      'phoenix',
    ]);
    expect(connectorNeedsCredential('kamino')).toBe(false);
  });

  it('allows Preferences enablement without a wallet while deferring wallet-scoped checks', () => {
    const result = connectorReadiness({
      connector: connector('kamino'),
      clusterSupported: true,
      actionCategory: null,
    });

    expect(result.kind).toBe('read_only_ok');
    expect(result.canEnable).toBe(true);
    expect(result.blocksAction).toBe(false);
    expect(result.notes).toContain('No wallet signature or protocol approval is requested here.');
  });

  it('blocks action-scoped readiness when no wallet is connected', () => {
    const result = connectorReadiness({
      connector: connector('kamino'),
      clusterSupported: true,
      actionCategory: 'lend',
    });

    expect(result.kind).toBe('needs_wallet');
    expect(result.canEnable).toBe(true);
    expect(result.blocksAction).toBe(true);
  });

  it('requires connector credentials for BYO-key protocols', () => {
    const result = connectorReadiness({
      connector: connector('lulo'),
      clusterSupported: true,
      walletAddress: 'wallet',
      actionCategory: 'lend',
    });

    expect(result.kind).toBe('needs_credential');
    expect(result.requiresCredential).toBe(true);
    expect(result.blocksAction).toBe(true);
  });

  it('surfaces supported and unsupported protocol setup distinctions', () => {
    expect(connectorReadiness({
      connector: connector('project0'),
      clusterSupported: true,
      walletAddress: 'wallet',
      actionCategory: 'lend',
    })).toMatchObject({
      kind: 'setup_available',
      canEnable: true,
      blocksAction: false,
    });

    expect(connectorReadiness({
      connector: connector('marginfi'),
      clusterSupported: true,
      walletAddress: 'wallet',
      actionCategory: 'lend',
    })).toMatchObject({
      kind: 'missing_account',
      canEnable: true,
      blocksAction: false,
    });
  });

  it('marks planned connectors unavailable instead of enableable', () => {
    const result = connectorReadiness({
      connector: connector('mayan'),
      clusterSupported: true,
      walletAddress: 'wallet',
      actionCategory: 'bridge',
    });

    expect(result.kind).toBe('planned_unavailable');
    expect(result.canEnable).toBe(false);
    expect(result.blocksAction).toBe(true);
  });
});
