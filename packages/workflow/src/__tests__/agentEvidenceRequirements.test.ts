import { describe, expect, it } from 'vitest';

import { planAgentReviewFactRoutes } from '../agentFactRouter.js';
import {
  AGENT_CONNECTOR_RISK_PROFILES,
  buildEvidenceRequirements,
} from '../agentEvidenceRequirements.js';
import { AGENT_EVIDENCE_TTL_MS_BY_ROUTE } from '../agentEvidence.js';

describe('agent evidence requirements', () => {
  it('builds requirements from a swap route plan with Jupiter TTLs', () => {
    const routePlan = planAgentReviewFactRoutes({
      actionType: 'swap',
      question: 'Swap SOL for USDC. Is the slippage acceptable?',
      hasWallet: true,
      hasTokenMints: true,
    });
    const requirements = buildEvidenceRequirements(routePlan, {
      walletAddress: 'Wallet1111111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      isWalletScoped: true,
    });
    const ids = requirements.map((req) => req.routeId);
    expect(ids).toEqual(expect.arrayContaining([
      'wallet.connected_public_key',
      'jupiter.swap_order_preview',
      'jupiter.swap_route',
    ]));
    const quote = requirements.find((req) => req.routeId === 'jupiter.swap_order_preview');
    expect(quote?.ttlMs).toBe(AGENT_EVIDENCE_TTL_MS_BY_ROUTE['jupiter.swap_order_preview']);
    expect(quote?.blocking).toBe(true);
  });

  it('attaches connector profile metadata to protocol_connector requirements', () => {
    const routePlan = planAgentReviewFactRoutes({
      actionType: 'marginfi_borrow',
      question: 'Approve this borrow if my health factor stays safe?',
      hasWallet: true,
      connector: {
        id: 'marginfi',
        name: 'MarginFi',
        enabled: true,
        readReady: true,
        actionKind: 'marginfi_borrow',
      },
    });
    const requirements = buildEvidenceRequirements(routePlan, {
      walletAddress: 'Wallet1111111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      connectorId: 'marginfi',
      connectorProfile: 'lending_borrow',
      connectorEnabled: true,
      connectorReadReady: true,
      isWalletScoped: true,
    });
    const connectorReq = requirements.find((req) => req.routeId === 'protocol_connector.read_facts');
    expect(connectorReq).toBeDefined();
    expect(connectorReq?.connectorProfile).toBe('lending_borrow');
    expect(connectorReq?.connectorId).toBe('marginfi');
    expect(connectorReq?.blocking).toBe(true);
  });

  it('applies oracle profile TTL to connector reads (30s)', () => {
    const routePlan = planAgentReviewFactRoutes({
      actionType: 'read_only',
      question: 'Check price freshness and confidence.',
      hasWallet: true,
      connector: {
        id: 'pyth',
        name: 'Pyth',
        enabled: true,
        readReady: true,
        actionKind: 'read_only',
      },
    });
    const requirements = buildEvidenceRequirements(routePlan, {
      walletAddress: 'Wallet1111111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      connectorId: 'pyth',
      connectorProfile: 'oracle',
      connectorEnabled: true,
      connectorReadReady: true,
      isWalletScoped: true,
    });
    const oracleReq = requirements.find((req) => req.routeId === 'protocol_connector.read_facts');
    expect(oracleReq?.ttlMs).toBe(30_000);
  });

  it('upgrades swap_dex profile to require Jupiter routes when the router already selected them', () => {
    const routePlan = planAgentReviewFactRoutes({
      actionType: 'jupiter_swap',
      intent: 'Swap SOL for USDC',
      hasWallet: true,
      hasTokenMints: true,
      connector: {
        id: 'jupiter',
        name: 'Jupiter',
        enabled: true,
        readReady: true,
        actionKind: 'jupiter_swap',
      },
    });
    const requirements = buildEvidenceRequirements(routePlan, {
      walletAddress: 'Wallet1111111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      connectorId: 'jupiter',
      connectorProfile: 'swap_dex',
      connectorEnabled: true,
      connectorReadReady: true,
      isWalletScoped: true,
    });
    const profile = AGENT_CONNECTOR_RISK_PROFILES.swap_dex;
    for (const routeId of profile.requiredRouteIds) {
      const req = requirements.find((r) => r.routeId === routeId);
      expect(req, `missing required route ${routeId}`).toBeDefined();
      expect(req?.blocking).toBe(true);
    }
  });

  it('synthesizes missing required routes when the profile demands them', () => {
    const routePlan = planAgentReviewFactRoutes({
      actionType: 'jupiter_swap',
      hasWallet: true,
      hasTokenMints: false, // no token mints -> birdeye routes not selected
      connector: {
        id: 'jupiter',
        name: 'Jupiter',
        enabled: true,
        readReady: true,
        actionKind: 'jupiter_swap',
      },
    });
    const requirements = buildEvidenceRequirements(routePlan, {
      walletAddress: 'Wallet1111111111111111111111111111111111111',
      cluster: 'mainnet-beta',
      connectorId: 'jupiter',
      connectorProfile: 'swap_dex',
      connectorEnabled: true,
      connectorReadReady: true,
      isWalletScoped: true,
    });
    const synth = requirements.find((req) => req.routeId === 'birdeye.price_multi');
    expect(synth).toBeDefined();
    expect(synth?.status).toBe('required');
    expect(synth?.blocking).toBe(true);
    expect(synth?.reason.toLowerCase()).toContain('did not select');
  });
});
