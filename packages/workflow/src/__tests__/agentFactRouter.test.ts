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

  it('marks Jupiter quote/route as REQUIRED when the prompt asks about quote details', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'swap',
      instruction: 'Approve only if price impact stays under 0.5%.',
      parameters: { amount: '0.01', slippageBps: '50' },
      hasWallet: true,
      hasTokenMints: true,
    });
    const quote = plan.routes.find((r) => r.id === 'jupiter.swap_order_preview');
    const route = plan.routes.find((r) => r.id === 'jupiter.swap_route');
    expect(quote?.status).toBe('required');
    expect(route?.status).toBe('required');
  });

  it('marks Jupiter quote/route as OPTIONAL for a generic swap draft with amount+slippage already supplied', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'swap',
      instruction: 'Prepare a DeFi swap review with explicit input, output, amount, protocol route, and slippage cap.',
      parameters: { amount: '0.01', slippageBps: '50' },
      hasWallet: true,
      hasTokenMints: true,
    });
    const quote = plan.routes.find((r) => r.id === 'jupiter.swap_order_preview');
    const route = plan.routes.find((r) => r.id === 'jupiter.swap_route');
    expect(quote?.status).toBe('optional');
    expect(route?.status).toBe('optional');
  });

  it('marks Jupiter quote as REQUIRED when amount or slippage is missing from the draft', () => {
    const planNoAmount = planAgentReviewFactRoutes({
      actionType: 'swap',
      instruction: 'Generic swap.',
      parameters: { slippageBps: '50' },
      hasWallet: true,
      hasTokenMints: true,
    });
    expect(planNoAmount.routes.find((r) => r.id === 'jupiter.swap_order_preview')?.status).toBe('required');

    const planNoSlippage = planAgentReviewFactRoutes({
      actionType: 'swap',
      instruction: 'Generic swap.',
      parameters: { amount: '0.01' },
      hasWallet: true,
      hasTokenMints: true,
    });
    expect(planNoSlippage.routes.find((r) => r.id === 'jupiter.swap_order_preview')?.status).toBe('required');
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

  it('tags rpc.simulate_transaction (required) when an outcome question is asked AND a prepared tx exists', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'blink_action',
      question: 'Will this drain my wallet?',
      hasWallet: true,
      hasPreparedTx: true,
    });
    const sim = plan.routes.find((route) => route.id === 'rpc.simulate_transaction');
    expect(sim).toBeDefined();
    expect(sim?.status).toBe('required');
    expect(sim?.provider).toBe('rpc');
    expect(sim?.need).toBe('tx_simulation');
  });

  it('tags rpc.simulate_transaction (required) for blink_action even without an outcome question', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'blink_action',
      userNotes: 'fetched from xyz.com blink endpoint',
      hasWallet: true,
      hasPreparedTx: true,
    });
    const sim = plan.routes.find((route) => route.id === 'rpc.simulate_transaction');
    expect(sim).toBeDefined();
    expect(sim?.status).toBe('required');
    expect(sim?.reason.toLowerCase()).toContain('untrusted');
  });

  it('tags rpc.simulate_transaction (required) for custom_transaction with prepared tx', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'custom_transaction',
      hasWallet: true,
      hasPreparedTx: true,
    });
    expect(plan.routes.find((route) => route.id === 'rpc.simulate_transaction')?.status).toBe('required');
  });

  it('tags rpc.simulate_transaction (optional) for high-risk profile with prepared tx', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'drift_perps_open',
      hasWallet: true,
      hasPreparedTx: true,
      riskProfile: 'perps_margin',
    });
    expect(plan.routes.find((route) => route.id === 'rpc.simulate_transaction')?.status).toBe('optional');
  });

  it('does NOT tag rpc.simulate_transaction when no prepared tx is available (even with outcome question)', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'blink_action',
      question: 'will this drain my wallet?',
      hasWallet: true,
      hasPreparedTx: false,
    });
    expect(plan.routes.some((route) => route.id === 'rpc.simulate_transaction')).toBe(false);
    // Should be reported as a skipped need so the gate surfaces it as needs_input.
    expect(plan.skipped.some((entry) => entry.need === 'tx_simulation')).toBe(true);
  });

  it('does NOT tag rpc.simulate_transaction for a routine first-class adapter without outcome question', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'marginfi_deposit',
      userNotes: 'deposit 100 USDC',
      hasWallet: true,
      hasPreparedTx: false,
    });
    expect(plan.routes.some((route) => route.id === 'rpc.simulate_transaction')).toBe(false);
    expect(plan.skipped.some((entry) => entry.need === 'tx_simulation')).toBe(false);
  });

  it('does NOT tag rpc.simulate_transaction for the phone-plan threshold case', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'recurring_payment',
      userNotes: 'check this phone plan if its less than 20 dollar approve this plan. for tmobile. send to uscc.',
      hasWallet: true,
      hasPreparedTx: false,
    });
    expect(plan.routes.some((route) => route.id === 'rpc.simulate_transaction')).toBe(false);
    expect(plan.skipped.some((entry) => entry.need === 'tx_simulation')).toBe(false);
  });

  it('does NOT auto-tag Helius or BirdEye for an external-pricing recurring_payment (e.g., phone plan)', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'recurring_payment',
      userNotes: 'check this phone plan if its less than 20 dollar approve this plan. for tmobile. send to uscc.',
      hasWallet: true,
      hasTokenMints: false,
    });
    const providers = new Set(plan.routes.map((route) => route.provider));
    expect(providers.has('helius')).toBe(false);
    expect(providers.has('birdeye')).toBe(false);
    // The only deterministic requirement should be wallet identity.
    expect(plan.routes.some((route) => route.id === 'wallet.connected_public_key' && route.status === 'required')).toBe(true);
  });

  it('does NOT tag Helius for an imperative "send to X" without history wording', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'transfer_sol',
      userNotes: 'send 0.5 SOL to alice.sol',
      hasWallet: true,
    });
    expect(plan.routes.some((route) => route.id === 'helius.getTransfersByAddress')).toBe(false);
  });

  it('still tags Helius when the question explicitly references history (already paid)', () => {
    const plan = planAgentReviewFactRoutes({
      actionType: 'transfer_spl',
      question: 'Did I already pay this recipient recently?',
      hasWallet: true,
    });
    expect(plan.routes.some((route) => route.id === 'helius.getTransfersByAddress' && route.status === 'required')).toBe(true);
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
