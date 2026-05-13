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

  it('registers first-class Kamino, MarginFi, and Jupiter capabilities', () => {
    const connectors = listConnectorCapabilities(DEFAULT_CONFIG);
    const kamino = connectors.find((connector) => connector.id === 'kamino');
    const marginfi = connectors.find((connector) => connector.id === 'marginfi');
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
    expect(marginfi).toMatchObject({
      name: 'MarginFi',
      readCapabilities: ['positions', 'markets', 'borrow', 'withdraw', 'repay'],
      writeCapabilities: ['earn', 'withdraw', 'borrow', 'repay'],
      executionMode: 'first_class_prepare',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    });
    expect(marginfi?.readTools).toContain('solana_marginfi_health_preview');
    expect(marginfi?.actionTools).toContain('solana_prepare_marginfi_borrow');
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
    expect(jupiter?.productReadiness?.swap).toMatchObject({
      ready: false,
      reason: expect.stringContaining('Missing Jupiter API key'),
    });
    expect(jupiter?.productReadiness?.lendEarn).toMatchObject({ ready: false });
    expect(jupiter?.limitations.join(' ')).toContain('quote preview, direct execution, and approval-time quote refresh require a Jupiter API key');
  });

  it('registers Raydium as a first-class connector', () => {
    const raydium = listConnectorCapabilities(DEFAULT_CONFIG).find((connector) => connector.id === 'raydium');

    expect(raydium).toMatchObject({
      name: 'Raydium',
      readCapabilities: ['positions', 'rewards', 'markets'],
      writeCapabilities: ['add_liquidity', 'withdraw', 'rewards', 'earn'],
      actionTools: expect.arrayContaining(['solana_prepare_raydium_add_liquidity']),
      executionMode: 'first_class_prepare',
    });
    expect(raydium?.readTools).toContain('solana_raydium_pool_snapshot');
    expect(raydium?.actionTools).toContain('solana_prepare_raydium_harvest');
    expect(raydium?.limitations.join(' ')).toContain('remain approval inbox items until the wallet signs');
  });

  it('registers Jito as a first-class liquid staking connector', () => {
    const jito = listConnectorCapabilities(DEFAULT_CONFIG).find((connector) => connector.id === 'jito');

    expect(jito).toMatchObject({
      name: 'Jito',
      readCapabilities: ['positions', 'markets', 'earn', 'withdraw'],
      writeCapabilities: ['earn', 'withdraw'],
      executionMode: 'first_class_prepare',
      requiresClientKey: false,
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    });
    expect(jito?.readTools).toEqual(
      expect.arrayContaining([
        'solana_jito_stake_pool_snapshot',
        'solana_jito_wallet_positions',
        'solana_jito_wallet_stake_accounts',
        'solana_jito_quote',
      ]),
    );
    expect(jito?.actionTools).toEqual(
      expect.arrayContaining([
        'solana_prepare_jito_stake_sol',
        'solana_prepare_jito_deposit_stake_account',
        'solana_prepare_jito_unstake_jitosol',
        'solana_prepare_jito_withdraw_sol',
      ]),
    );
    expect(jito?.limitations.join(' ')).toContain('Restaking');
  });

  it('force-disables Jito readiness when JITO_CONNECTOR_ENABLED is false', () => {
    vi.stubEnv('JITO_CONNECTOR_ENABLED', 'false');
    const jito = listConnectorCapabilities(DEFAULT_CONFIG).find((connector) => connector.id === 'jito');

    expect(jito?.readiness.reads).toMatchObject({
      ready: false,
      reason: expect.stringContaining('JITO_CONNECTOR_ENABLED=false'),
    });
    expect(jito?.readiness.actions).toMatchObject({
      ready: false,
      reason: expect.stringContaining('JITO_CONNECTOR_ENABLED=false'),
    });
  });

  it('registers Orca as first-class Whirlpools with explicit client readiness', () => {
    const orca = listConnectorCapabilities(DEFAULT_CONFIG).find((connector) => connector.id === 'orca');

    expect(orca).toMatchObject({
      name: 'Orca',
      readCapabilities: ['positions', 'rewards', 'markets'],
      writeCapabilities: ['add_liquidity', 'withdraw', 'rewards'],
      executionMode: 'first_class_prepare',
      readiness: {
        reads: { ready: false },
        actions: { ready: false },
      },
    });
    expect(orca?.readTools).toContain('solana_orca_whirlpool_snapshot');
    expect(orca?.actionTools).toContain('solana_prepare_orca_increase_liquidity');
    expect(orca?.readiness.reads.reason).toContain('Orca client is not configured');
  });

  it('resolves common aliases without reading browser code', () => {
    expect(getConnector('jup')?.id).toBe('jupiter');
    expect(getConnector('jupiter lend')?.id).toBe('jupiter');
    expect(getConnector('kamino lend')?.id).toBe('kamino');
    expect(getConnector('orca whirlpools')?.id).toBe('orca');
    expect(getConnector('meteora dlmm')?.id).toBe('meteora');
    expect(getConnector('ray')?.id).toBe('raydium');
    expect(getConnector('magic eden')?.id).toBe('magiceden');
    expect(getConnector('me')?.id).toBe('magiceden');
    expect(getConnector('pyth network')?.id).toBe('pyth');
    expect(getConnector('pyth oracle')?.id).toBe('pyth');
    expect(getConnector('jitosol')?.id).toBe('jito');
  });

  it('registers Pyth as a first-class oracle connector with read readiness and gated post-update writes', () => {
    const pyth = listConnectorCapabilities(DEFAULT_CONFIG).find((connector) => connector.id === 'pyth');

    expect(pyth).toMatchObject({
      name: 'Pyth',
      readCapabilities: expect.arrayContaining(['oracle', 'markets']),
      writeCapabilities: [],
      executionMode: 'first_class_prepare',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    });
    expect(pyth?.readTools).toContain('solana_pyth_oracle_evidence');
    expect(pyth?.readTools).toContain('solana_pyth_price_feed');
    expect(pyth?.actionTools).toContain('solana_prepare_pyth_post_price_update');
    expect(pyth?.limitations.join(' ')).toContain('@pythnetwork/pyth-solana-receiver');
    expect(pyth?.readiness.reads.ready).toBe(true);
  });

  it('registers Magic Eden as a feature-flagged first-class marketplace connector', () => {
    vi.stubEnv('MAGICEDEN_API_KEY', '');
    vi.stubEnv('MAGICEDEN_CONNECTOR_ENABLED', '');
    const magiceden = listConnectorCapabilities(DEFAULT_CONFIG).find((connector) => connector.id === 'magiceden');

    expect(magiceden).toMatchObject({
      name: 'Magic Eden',
      readCapabilities: ['markets', 'positions', 'marketplace'],
      writeCapabilities: ['marketplace'],
      executionMode: 'first_class_prepare',
      requiresClientKey: true,
    });
    expect(magiceden?.readTools).toEqual(
      expect.arrayContaining([
        'solana_magiceden_api_health',
        'solana_magiceden_collection_snapshot',
        'solana_magiceden_collection_listings',
        'solana_magiceden_collection_bids',
        'solana_magiceden_recent_activity',
        'solana_magiceden_wallet_nfts',
        'solana_magiceden_nft_detail',
      ]),
    );
    expect(magiceden?.actionTools).toEqual(
      expect.arrayContaining([
        'solana_prepare_magiceden_buy',
        'solana_prepare_magiceden_list',
        'solana_prepare_magiceden_cancel_listing',
        'solana_prepare_magiceden_bid',
        'solana_prepare_magiceden_cancel_bid',
        'solana_execute_prepared_action',
      ]),
    );
    expect(magiceden?.requiredConfig.join(' ')).toContain('MAGICEDEN_API_KEY');
    expect(magiceden?.requiredConfig.join(' ')).toContain('MAGICEDEN_CONNECTOR_ENABLED');
    expect(magiceden?.readiness.reads.reason).toContain('Magic Eden API client is not configured');
    expect(magiceden?.limitations.join(' ')).toContain('2026-02-27');
  });
});
