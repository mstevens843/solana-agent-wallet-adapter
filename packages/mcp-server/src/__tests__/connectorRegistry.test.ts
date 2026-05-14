import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTOR_APPROVAL_BOUNDARY,
  getConnector,
  listConnectorCapabilities,
} from '../connectorRegistry.js';
import { DEFAULT_CONFIG } from '../config.js';
import {
  describeOrcaUnavailableReason,
  resetOrcaClientFactory,
} from '../adapters/orca/client.js';
import {
  describeMarinadeUnavailableReason,
  resetMarinadeClientFactory,
} from '../adapters/marinade/client.js';

describe('MCP connector registry', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetOrcaClientFactory();
    resetMarinadeClientFactory();
  });

  it('registers first-class Kamino, MarginFi, Project 0, and Jupiter capabilities', () => {
    const connectors = listConnectorCapabilities(DEFAULT_CONFIG);
    const kamino = connectors.find((connector) => connector.id === 'kamino');
    const marginfi = connectors.find((connector) => connector.id === 'marginfi');
    const project0 = connectors.find((connector) => connector.id === 'project0');
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
    expect(marginfi?.readTools).toEqual([
      'solana_connector_read_facts',
      'solana_marginfi_bank_snapshot',
      'solana_marginfi_wallet_accounts',
      'solana_marginfi_account_detail',
      'solana_marginfi_health_preview',
    ]);
    expect(marginfi?.actionTools).toEqual([
      'solana_prepare_marginfi_deposit',
      'solana_prepare_marginfi_withdraw',
      'solana_prepare_marginfi_borrow',
      'solana_prepare_marginfi_repay',
      'solana_execute_prepared_action',
    ]);
    expect(project0).toMatchObject({
      name: 'Project 0',
      readCapabilities: ['positions', 'markets', 'strategies', 'borrow', 'withdraw', 'repay'],
      writeCapabilities: ['earn', 'withdraw', 'borrow', 'repay'],
      executionMode: 'first_class_prepare',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    });
    expect(project0?.readTools).toEqual([
      'solana_connector_read_facts',
      'solana_project0_banks',
      'solana_project0_strategies',
      'solana_project0_wallet',
      'solana_project0_account_detail',
      'solana_project0_health_preview',
    ]);
    expect(project0?.actionTools).toEqual([
      'solana_prepare_project0_create_account',
      'solana_prepare_project0_deposit',
      'solana_prepare_project0_withdraw',
      'solana_prepare_project0_borrow',
      'solana_prepare_project0_repay',
      'solana_execute_prepared_action',
    ]);
    expect(jupiter).toMatchObject({
      name: 'Jupiter',
      readCapabilities: expect.arrayContaining(['swap', 'tokens', 'price']),
      writeCapabilities: expect.arrayContaining(['swap']),
      executionMode: 'first_class_prepare',
    });
    expect(jupiter?.readTools).toContain('solana_jupiter_order_preview');
    expect(jupiter?.readTools).toContain('solana_jupiter_token_risk_evidence');
    expect(jupiter?.readTools).toContain('solana_jupiter_price_batch');
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
    expect(jupiter?.productReadiness?.tokens).toMatchObject({
      ready: false,
      reason: expect.stringContaining('Missing Jupiter API key'),
    });
    expect(jupiter?.productReadiness?.price).toMatchObject({
      ready: false,
      reason: expect.stringContaining('Missing Jupiter API key'),
    });
    expect(jupiter?.limitations.join(' ')).toContain('quote preview, direct execution, and approval-time quote refresh require a Jupiter API key');
  });

  it('reports Jupiter prediction as disabled by default and ready once opted in', () => {
    vi.stubEnv('JUPITER_API_KEY', 'test-key');
    vi.stubEnv('JUP_API_KEY', '');

    const defaultJupiter = listConnectorCapabilities(DEFAULT_CONFIG).find((c) => c.id === 'jupiter');
    expect(defaultJupiter?.readCapabilities).toContain('prediction');
    expect(defaultJupiter?.readTools).toEqual(expect.arrayContaining([
      'solana_jupiter_prediction_events',
      'solana_jupiter_prediction_search_events',
      'solana_jupiter_prediction_event_detail',
      'solana_jupiter_prediction_event_markets',
      'solana_jupiter_prediction_market_detail',
      'solana_jupiter_prediction_orderbook',
      'solana_jupiter_prediction_orders',
      'solana_jupiter_prediction_order_status',
      'solana_jupiter_prediction_positions',
      'solana_jupiter_prediction_history',
      'solana_jupiter_prediction_vault_info',
    ]));
    expect(defaultJupiter?.productReadiness?.prediction).toMatchObject({
      ready: false,
      reason: expect.stringContaining('disabled by default'),
    });

    const optedIn = listConnectorCapabilities({
      ...DEFAULT_CONFIG,
      connectors: {
        ...DEFAULT_CONFIG.connectors,
        jupiter: {
          ...DEFAULT_CONFIG.connectors?.jupiter,
          prediction: { enabled: true, readOnly: true },
        },
      },
    }).find((c) => c.id === 'jupiter');
    expect(optedIn?.productReadiness?.prediction).toMatchObject({ ready: true });
    expect(optedIn?.productReadiness?.prediction?.reason).toContain('(beta)');

    vi.stubEnv('JUPITER_API_KEY', '');
    const noKey = listConnectorCapabilities({
      ...DEFAULT_CONFIG,
      connectors: {
        ...DEFAULT_CONFIG.connectors,
        jupiter: {
          ...DEFAULT_CONFIG.connectors?.jupiter,
          prediction: { enabled: true, readOnly: true },
        },
      },
    }).find((c) => c.id === 'jupiter');
    expect(noKey?.productReadiness?.prediction).toMatchObject({
      ready: false,
      reason: expect.stringContaining('Missing Jupiter API key'),
    });
  });

  it('exposes Jupiter Perps as a read-only research surface with writes denied', () => {
    const jupiter = listConnectorCapabilities(DEFAULT_CONFIG).find((c) => c.id === 'jupiter');
    expect(jupiter?.readCapabilities).toContain('perps');
    expect(jupiter?.readTools).toEqual(expect.arrayContaining([
      'solana_jupiter_perps_status',
      'solana_jupiter_perps_pool_snapshot',
      'solana_jupiter_perps_custody_snapshot',
      'solana_jupiter_perps_position_snapshot',
    ]));
    expect(jupiter?.actionTools).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/solana_prepare_jupiter_perps_/),
    ]));
    expect(jupiter?.productReadiness?.perpsReadonly).toMatchObject({
      ready: true,
      reason: expect.stringContaining('read-only research'),
    });
    expect(jupiter?.limitations.join(' ')).toContain('Perps is exposed as a read-only research surface');
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
        'solana_jito_deposit_receipts',
      ]),
    );
    expect(jito?.actionTools).toEqual(
      expect.arrayContaining([
        'solana_prepare_jito_stake_sol',
        'solana_prepare_jito_deposit_stake_account',
        'solana_prepare_jito_unstake_jitosol',
        'solana_prepare_jito_withdraw_sol',
        'solana_prepare_jito_claim_deposit_receipt',
      ]),
    );
    expect(jito?.limitations.join(' ')).toContain('Restaking');
  });

  it('registers Marinade as a first-class liquid staking connector', () => {
    const marinade = listConnectorCapabilities(DEFAULT_CONFIG).find((connector) => connector.id === 'marinade');
    const unavailableReason = describeMarinadeUnavailableReason();

    expect(marinade).toMatchObject({
      name: 'Marinade',
      readCapabilities: ['positions', 'markets', 'earn', 'withdraw'],
      writeCapabilities: ['earn', 'withdraw', 'swap'],
      executionMode: 'first_class_prepare',
      requiresClientKey: false,
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    });
    expect(marinade?.readTools).toEqual(
      expect.arrayContaining([
        'solana_marinade_state_snapshot',
        'solana_marinade_wallet_positions',
        'solana_marinade_wallet_stake_accounts',
        'solana_marinade_unstake_tickets',
        'solana_marinade_quote',
      ]),
    );
    expect(marinade?.actionTools).toEqual(
      expect.arrayContaining([
        'solana_prepare_marinade_liquid_stake',
        'solana_prepare_marinade_liquid_unstake',
        'solana_prepare_marinade_delayed_unstake',
        'solana_prepare_marinade_claim_delayed_unstake',
      ]),
    );
    expect(marinade?.limitations.join(' ')).toContain('Jupiter');
    expect(marinade?.readiness.reads).toMatchObject({ ready: unavailableReason === undefined });
    expect(marinade?.readiness.actions).toMatchObject({ ready: unavailableReason === undefined });
    if (unavailableReason) {
      expect(marinade?.readiness.reads.reason).toContain('Marinade SDK client is not configured');
    } else {
      expect(marinade?.readiness.reads.reason).toBeUndefined();
    }
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
    const unavailableReason = describeOrcaUnavailableReason();

    expect(orca).toMatchObject({
      name: 'Orca',
      readCapabilities: ['positions', 'rewards', 'markets'],
      writeCapabilities: ['add_liquidity', 'withdraw', 'rewards'],
      executionMode: 'first_class_prepare',
      readiness: {
        reads: { ready: unavailableReason === undefined },
        actions: { ready: unavailableReason === undefined },
      },
    });
    expect(orca?.readTools).toContain('solana_orca_whirlpool_snapshot');
    expect(orca?.actionTools).toContain('solana_prepare_orca_increase_liquidity');
    if (unavailableReason) {
      expect(orca?.readiness.reads.reason).toContain('Orca client is not configured');
    } else {
      expect(orca?.readiness.reads.reason).toBeUndefined();
    }
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
    expect(getConnector('msol')?.id).toBe('marinade');
    expect(getConnector('portal bridge')?.id).toBe('wormhole');
    expect(getConnector('wormhole token bridge')?.id).toBe('wormhole');
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

  it('registers Wormhole as a first-class bridge connector with SDK readiness', () => {
    const wormhole = listConnectorCapabilities(DEFAULT_CONFIG).find((connector) => connector.id === 'wormhole');

    expect(wormhole).toMatchObject({
      name: 'Wormhole',
      supportedClusters: ['mainnet-beta', 'devnet'],
      readCapabilities: expect.arrayContaining(['bridge', 'markets', 'positions']),
      writeCapabilities: ['bridge'],
      executionMode: 'first_class_prepare',
      requiresClientKey: false,
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    });
    expect(wormhole?.readTools).toEqual(
      expect.arrayContaining([
        'solana_wormhole_supported_routes',
        'solana_wormhole_token_snapshot',
        'solana_wormhole_quote',
        'solana_wormhole_transfer_status',
        'solana_wormhole_wallet_bridge_exposure',
      ]),
    );
    expect(wormhole?.actionTools).toEqual(
      expect.arrayContaining([
        'solana_prepare_wormhole_transfer',
        'solana_prepare_wormhole_redeem',
        'solana_prepare_wormhole_recover_or_resume',
        'solana_execute_prepared_action',
      ]),
    );
    expect(wormhole?.requiredConfig.join(' ')).toContain('@wormhole-foundation/sdk');
    expect(wormhole?.readiness.reads).toMatchObject({
      ready: false,
      reason: expect.stringContaining('Wormhole SDK client is not configured'),
    });
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
