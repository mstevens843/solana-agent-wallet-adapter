import type {
  AgentConnectorProfileKind,
  AgentFactNeed,
  AgentFactRoute,
  AgentFactRoutePlan,
} from './agentFactRouter.js';
import {
  type AgentEvidenceContext,
  type AgentEvidenceRequirement,
  ttlForRoute,
} from './agentEvidence.js';

export interface AgentConnectorRiskProfile {
  kind: AgentConnectorProfileKind;
  label: string;
  /** Route ids that must be present + required for this profile to pass approval. */
  requiredRouteIds: string[];
  /** Fact needs that this profile demands (used when a route id is not available but the need still matters). */
  requiredNeeds: AgentFactNeed[];
  /** Optional notes shown when a required route is missing. */
  rationale: string;
}

const WALLET_HOLDINGS_ROUTE = 'birdeye.wallet_token_list';
const CONNECTOR_READ_ROUTE = 'protocol_connector.read_facts';

export const AGENT_CONNECTOR_RISK_PROFILES: Readonly<Record<AgentConnectorProfileKind, AgentConnectorRiskProfile>> = Object.freeze({
  swap_dex: {
    kind: 'swap_dex',
    label: 'Swap / DEX',
    requiredRouteIds: [],
    requiredNeeds: [],
    rationale: 'Swap approvals use prompt-scoped evidence. Token-market and live quote routes are required only when the router selected them from the user request or missing draft fields.',
  },
  lending_borrow: {
    kind: 'lending_borrow',
    label: 'Lending / Borrow',
    requiredRouteIds: [WALLET_HOLDINGS_ROUTE, CONNECTOR_READ_ROUTE],
    requiredNeeds: ['wallet_holdings', 'protocol_position'],
    rationale: 'Lending/borrow approvals need wallet holdings and protocol position/health facts.',
  },
  liquidity_pool: {
    kind: 'liquidity_pool',
    label: 'Liquidity Pool',
    requiredRouteIds: [CONNECTOR_READ_ROUTE],
    requiredNeeds: ['protocol_position'],
    rationale: 'LP approvals need pool/position facts from the connector.',
  },
  staking_lst: {
    kind: 'staking_lst',
    label: 'Staking / LST',
    requiredRouteIds: [CONNECTOR_READ_ROUTE],
    requiredNeeds: ['protocol_position'],
    rationale: 'Staking approvals need stake/LST position and exchange/withdrawal facts.',
  },
  vault_yield: {
    kind: 'vault_yield',
    label: 'Vault / Yield',
    requiredRouteIds: [WALLET_HOLDINGS_ROUTE, CONNECTOR_READ_ROUTE],
    requiredNeeds: ['wallet_holdings', 'protocol_position'],
    rationale: 'Vault approvals need wallet holdings and vault deposit/withdraw state from the connector.',
  },
  yield_earn: {
    kind: 'yield_earn',
    label: 'Yield Earn',
    requiredRouteIds: [WALLET_HOLDINGS_ROUTE, CONNECTOR_READ_ROUTE],
    requiredNeeds: ['wallet_holdings', 'protocol_position'],
    rationale: 'Earn approvals need wallet holdings and earn position/withdrawal state from the connector.',
  },
  perps_margin: {
    kind: 'perps_margin',
    label: 'Perps / Margin',
    requiredRouteIds: [CONNECTOR_READ_ROUTE],
    requiredNeeds: ['protocol_position'],
    rationale: 'Perps approvals need margin/custody, leverage, and liquidation/health facts from the connector.',
  },
  nft_marketplace: {
    kind: 'nft_marketplace',
    label: 'NFT Marketplace',
    requiredRouteIds: [CONNECTOR_READ_ROUTE],
    requiredNeeds: ['protocol_position'],
    rationale: 'NFT approvals need collection/listing/bid/ownership facts from the connector.',
  },
  governance: {
    kind: 'governance',
    label: 'Governance',
    requiredRouteIds: [CONNECTOR_READ_ROUTE],
    requiredNeeds: ['protocol_position'],
    rationale: 'Governance approvals need proposal/realm/vote/treasury facts from the connector.',
  },
  multisig: {
    kind: 'multisig',
    label: 'Multisig',
    requiredRouteIds: [CONNECTOR_READ_ROUTE],
    requiredNeeds: ['protocol_position'],
    rationale: 'Multisig approvals need signer/threshold/transaction/vault facts from the connector.',
  },
  bridge: {
    kind: 'bridge',
    label: 'Bridge',
    requiredRouteIds: [CONNECTOR_READ_ROUTE],
    requiredNeeds: ['protocol_position'],
    rationale: 'Bridge approvals need route/destination/recipient/status facts from the connector.',
  },
  oracle: {
    kind: 'oracle',
    label: 'Oracle',
    requiredRouteIds: [CONNECTOR_READ_ROUTE],
    requiredNeeds: ['protocol_position'],
    rationale: 'Oracle checks need price, confidence, and freshness evidence.',
  },
  jupiter: {
    kind: 'jupiter',
    label: 'Jupiter Product',
    requiredRouteIds: [CONNECTOR_READ_ROUTE],
    requiredNeeds: ['protocol_position'],
    rationale: 'Jupiter product approvals need product-specific facts (trigger, recurring, lend, perps, prediction).',
  },
});

export function requirementIdFor(routeId: string): string {
  return `req.${routeId}`;
}

function isRouteBlocking(route: AgentFactRoute, context: AgentEvidenceContext): boolean {
  if (route.status === 'required') return true;
  // wallet identity is always blocking when present in a wallet-scoped review
  if (route.id === 'wallet.connected_public_key' && context.isWalletScoped !== false) return true;
  return false;
}

function requirementFromRoute(
  route: AgentFactRoute,
  context: AgentEvidenceContext,
): AgentEvidenceRequirement {
  const isConnectorRead = route.id === 'protocol_connector.read_facts';
  const profileKind = (route.params?.profile as AgentConnectorProfileKind | undefined) ?? context.connectorProfile;
  const connectorId = (route.params?.connectorId as string | undefined) ?? context.connectorId;
  const capability = route.params?.capability as string | undefined;
  return {
    id: requirementIdFor(route.id),
    routeId: route.id,
    need: route.need,
    provider: route.provider,
    endpoint: route.endpoint,
    status: route.status,
    ttlMs: ttlForRoute(route, isConnectorRead ? profileKind : undefined),
    blocking: isRouteBlocking(route, context),
    reason: route.reason,
    ...(isConnectorRead && profileKind ? { connectorProfile: profileKind } : {}),
    ...(isConnectorRead && connectorId ? { connectorId } : {}),
    ...(isConnectorRead && capability ? { capability } : {}),
  };
}

export function buildEvidenceRequirements(
  routePlan: AgentFactRoutePlan,
  context: AgentEvidenceContext,
): AgentEvidenceRequirement[] {
  const requirements = routePlan.routes.map((route) => requirementFromRoute(route, context));
  return applyConnectorRiskProfileRequirements(requirements, routePlan, context);
}

/**
 * Decorate-only: upgrade matching optional requirements to required+blocking based on the
 * connector risk profile. We never synthesize routes the router didn't select — the router is
 * the single source of truth for which provider endpoints are queryable. If a profile expects
 * a route that's missing, fix the router; do not fabricate evidence requirements here.
 */
export function applyConnectorRiskProfileRequirements(
  requirements: AgentEvidenceRequirement[],
  _routePlan: AgentFactRoutePlan,
  context: AgentEvidenceContext,
): AgentEvidenceRequirement[] {
  // A pure off-chain gate question does not depend on the connector's positions/health, so do not
  // upgrade connector reads to required+blocking — the router already demoted them to optional and
  // they remain available as non-blocking context. Answer only what was asked.
  if (context.offChainGateOnly) return requirements;
  const profileKind = context.connectorProfile;
  if (!profileKind) return requirements;
  const profile = AGENT_CONNECTOR_RISK_PROFILES[profileKind];
  if (!profile) return requirements;
  const wanted = new Set(profile.requiredRouteIds);
  let touched = false;
  const next = requirements.map((req) => {
    if (!wanted.has(req.routeId)) return req;
    if (req.status === 'required' && req.blocking) return req;
    touched = true;
    return { ...req, status: 'required' as const, blocking: true };
  });
  return touched ? next : requirements;
}
