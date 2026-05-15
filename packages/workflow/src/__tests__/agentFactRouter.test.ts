import { describe, expect, it } from 'vitest';

import { planAgentReviewFactRoutes, type AgentFactNeed } from '../agentFactRouter.js';

function routeIdsFor(input: Parameters<typeof planAgentReviewFactRoutes>[0]): string[] {
  return planAgentReviewFactRoutes(input).routes.map((route) => route.id);
}

function routeFor(input: Parameters<typeof planAgentReviewFactRoutes>[0], need: AgentFactNeed) {
  return planAgentReviewFactRoutes(input).routes.find((route) => route.need === need);
}

describe('agent review fact router', () => {
  it('attaches wallet identity and transfer history for duplicate-payment questions', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'transfer_spl',
      question: 'Did I already pay this recipient recently, or would this be a duplicate payment?',
      hasWallet: true,
      hasTokenMints: true,
    });

    expect(plan.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'wallet.connected_public_key', status: 'required' }),
      expect.objectContaining({ id: 'helius.getTransfersByAddress', status: 'required' }),
    ]));
    expect(plan.routeText).toContain('required');
  });

  it('uses BirdEye wallet holdings when affordability depends on balances', () => {
    const route = routeFor({
      actionType: 'swap',
      question: 'Do I have enough funds and USDC holdings for this swap?',
      hasWallet: true,
      hasTokenMints: true,
    }, 'wallet_holdings');

    expect(route).toEqual(expect.objectContaining({
      provider: 'birdeye',
      endpoint: 'wallet-token-list',
      status: 'required',
    }));
  });

  it('requires BirdEye token security for explicit token safety checks', () => {
    const route = routeFor({
      actionType: 'transfer_spl',
      question: 'Is this unknown token safe, and are mint/freeze authorities disabled?',
      hasWallet: true,
      hasTokenMints: true,
    }, 'token_security');

    expect(route).toEqual(expect.objectContaining({
      provider: 'birdeye',
      endpoint: 'token-security',
      status: 'required',
    }));
  });

  it('routes token-market questions through BirdEye with CoinGecko support and DEX fallback', () => {
    const ids = routeIdsFor({
      actionType: 'manual_review',
      question: 'Approve only if the token market cap is above $10M and 24h volume is healthy.',
      hasWallet: true,
      hasTokenMints: true,
    });

    expect(ids).toEqual(expect.arrayContaining([
      'birdeye.price_multi',
      'coingecko.token_evidence',
      'dexscreener.token_pairs',
    ]));
  });

  it('selects Jupiter quote and route evidence for swap questions', () => {
    const ids = routeIdsFor({
      actionType: 'swap',
      intent: 'Swap SOL to USDC',
      question: 'Is the slippage and output amount okay?',
      hasWallet: true,
      hasTokenMints: true,
    });

    expect(ids).toEqual(expect.arrayContaining([
      'jupiter.swap_order_preview',
      'jupiter.swap_route',
    ]));
  });

  it('selects CoinGecko global and Fear & Greed routes for market-condition questions', () => {
    const ids = routeIdsFor({
      actionType: 'manual_review',
      question: 'Should we approve only if BTC dominance and Fear & Greed sentiment are acceptable today?',
      hasWallet: true,
    });

    expect(ids).toEqual(expect.arrayContaining([
      'coingecko.global',
      'alternative_me.fear_greed',
      'external_research.current_web',
    ]));
  });

  it('records skipped wallet-scoped routes when no wallet is available', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'transfer_sol',
      question: 'Did I already send this transfer?',
      hasWallet: false,
    });

    expect(plan.routes.some((route) => route.provider === 'helius')).toBe(false);
    expect(plan.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ need: 'wallet_identity' }),
      expect.objectContaining({ need: 'wallet_transfers' }),
    ]));
  });

  it('requires connector read facts with lending profile metadata for borrow actions', () => {
    const route = planAgentReviewFactRoutes({
      actionType: 'marginfi_borrow',
      question: 'Should I approve this borrow if my health factor stays safe?',
      hasWallet: true,
      connector: {
        id: 'marginfi',
        name: 'MarginFi',
        enabled: true,
        readReady: true,
        actionKind: 'marginfi_borrow',
        operation: 'Borrow',
      },
    }).routes.find((entry) => entry.id === 'protocol_connector.read_facts');

    expect(route).toEqual(expect.objectContaining({
      status: 'required',
      provider: 'protocol_connector',
      params: expect.objectContaining({
        connectorId: 'marginfi',
        profile: 'lending_borrow',
        capability: 'borrow',
      }),
    }));
  });

  it('records skipped connector reads when the selected connector is not ready', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'raydium_remove_liquidity',
      question: 'Can the agent approve removing this LP position?',
      hasWallet: true,
      connector: {
        id: 'raydium',
        name: 'Raydium',
        enabled: false,
        readReady: false,
        actionKind: 'raydium_remove_liquidity',
      },
    });

    expect(plan.routes.some((entry) => entry.id === 'protocol_connector.read_facts')).toBe(false);
    expect(plan.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ need: 'protocol_position', reason: expect.stringContaining('disabled') }),
    ]));
  });

  it('uses oracle capability for Pyth read-only checks', () => {
    const route = planAgentReviewFactRoutes({
      actionType: 'read_only',
      question: 'Check price freshness and confidence before approving the read proof.',
      hasWallet: true,
      connector: {
        id: 'pyth',
        name: 'Pyth',
        enabled: true,
        readReady: true,
        actionKind: 'read_only',
      },
    }).routes.find((entry) => entry.id === 'protocol_connector.read_facts');

    expect(route?.params).toEqual(expect.objectContaining({
      connectorId: 'pyth',
      profile: 'oracle',
      capability: 'oracle',
    }));
  });

  it('routes Jupiter swap actions through the swap_dex profile', () => {
    const route = planAgentReviewFactRoutes({
      actionType: 'swap',
      question: 'Approve this swap if the route is healthy.',
      hasWallet: true,
      hasTokenMints: true,
      connector: {
        id: 'jupiter',
        name: 'Jupiter',
        enabled: true,
        readReady: true,
        actionKind: 'jupiter_swap',
      },
    }).routes.find((entry) => entry.id === 'protocol_connector.read_facts');

    expect(route?.params).toEqual(expect.objectContaining({
      connectorId: 'jupiter',
      profile: 'swap_dex',
      capability: 'swap',
    }));
  });

  it('routes Squads actions through the multisig profile', () => {
    const route = planAgentReviewFactRoutes({
      actionType: 'squads_create_transfer_proposal',
      question: 'Approve this multisig proposal if my wallet is an authorized signer.',
      hasWallet: true,
      connector: {
        id: 'squads',
        name: 'Squads',
        enabled: true,
        readReady: true,
        actionKind: 'squads_create_transfer_proposal',
      },
    }).routes.find((entry) => entry.id === 'protocol_connector.read_facts');

    expect(route?.params).toEqual(expect.objectContaining({
      connectorId: 'squads',
      profile: 'multisig',
      capability: 'treasury',
    }));
  });

  it('routes Drift vault actions through vault_yield and perps actions through perps_margin', () => {
    const vaultRoute = planAgentReviewFactRoutes({
      actionType: 'drift_vault_deposit',
      hasWallet: true,
      connector: {
        id: 'drift',
        name: 'Drift',
        enabled: true,
        readReady: true,
        actionKind: 'drift_vault_deposit',
      },
    }).routes.find((entry) => entry.id === 'protocol_connector.read_facts');
    const perpsRoute = planAgentReviewFactRoutes({
      actionType: 'drift_perps_open',
      hasWallet: true,
      connector: {
        id: 'drift',
        name: 'Drift',
        enabled: true,
        readReady: true,
        actionKind: 'drift_perps_open',
      },
    }).routes.find((entry) => entry.id === 'protocol_connector.read_facts');

    expect(vaultRoute?.params).toEqual(expect.objectContaining({ profile: 'vault_yield' }));
    expect(perpsRoute?.params).toEqual(expect.objectContaining({ profile: 'perps_margin', capability: 'perps' }));
  });

  it('routes Lulo through yield_earn profile', () => {
    const route = planAgentReviewFactRoutes({
      actionType: 'lulo_deposit',
      hasWallet: true,
      connector: {
        id: 'lulo',
        name: 'Lulo',
        enabled: true,
        readReady: true,
        actionKind: 'lulo_deposit',
      },
    }).routes.find((entry) => entry.id === 'protocol_connector.read_facts');

    expect(route?.params).toEqual(expect.objectContaining({
      connectorId: 'lulo',
      profile: 'yield_earn',
      capability: 'earn',
    }));
  });

  it('uses marketplace and bridge capabilities for NFT and cross-chain connectors', () => {
    const nftRoute = planAgentReviewFactRoutes({
      actionType: 'magiceden_bid',
      hasWallet: true,
      connector: {
        id: 'magiceden',
        name: 'Magic Eden',
        enabled: true,
        readReady: true,
        actionKind: 'magiceden_bid',
      },
    }).routes.find((entry) => entry.id === 'protocol_connector.read_facts');
    const bridgeRoute = planAgentReviewFactRoutes({
      actionType: 'wormhole_transfer',
      hasWallet: true,
      connector: {
        id: 'wormhole',
        name: 'Wormhole',
        enabled: true,
        readReady: true,
        actionKind: 'wormhole_transfer',
      },
    }).routes.find((entry) => entry.id === 'protocol_connector.read_facts');

    expect(nftRoute?.params).toEqual(expect.objectContaining({ profile: 'nft_marketplace', capability: 'marketplace' }));
    expect(bridgeRoute?.params).toEqual(expect.objectContaining({ profile: 'bridge', capability: 'bridge' }));
  });
});
