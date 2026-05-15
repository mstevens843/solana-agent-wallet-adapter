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

const SWAP_QUOTE_ROUTE = 'jupiter.swap_order_preview';
const SWAP_ROUTE_ROUTE = 'jupiter.swap_route';
const TOKEN_PRICE_ROUTE = 'birdeye.price_multi';
const TOKEN_SECURITY_ROUTE = 'birdeye.token_security';
const WALLET_HOLDINGS_ROUTE = 'birdeye.wallet_token_list';
const CONNECTOR_READ_ROUTE = 'protocol_connector.read_facts';

export const AGENT_CONNECTOR_RISK_PROFILES: Readonly<Record<AgentConnectorProfileKind, AgentConnectorRiskProfile>> = Object.freeze({
  swap_dex: {
    kind: 'swap_dex',
    label: 'Swap / DEX',
    requiredRouteIds: [SWAP_QUOTE_ROUTE, SWAP_ROUTE_ROUTE, TOKEN_PRICE_ROUTE],
    requiredNeeds: ['swap_quote', 'swap_route', 'token_market'],
    rationale: 'Swap approvals need quote, executable route, and current token-market evidence.',
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

export function applyConnectorRiskProfileRequirements(
  requirements: AgentEvidenceRequirement[],
  routePlan: AgentFactRoutePlan,
  context: AgentEvidenceContext,
): AgentEvidenceRequirement[] {
  const profileKind = context.connectorProfile;
  if (!profileKind) return requirements;
  const profile = AGENT_CONNECTOR_RISK_PROFILES[profileKind];
  if (!profile) return requirements;
  const byRouteId = new Map(requirements.map((req) => [req.routeId, req]));
  let touched = false;
  for (const routeId of profile.requiredRouteIds) {
    const req = byRouteId.get(routeId);
    if (req) {
      if (req.status !== 'required' || !req.blocking) {
        byRouteId.set(routeId, { ...req, status: 'required', blocking: true });
        touched = true;
      }
    } else {
      // The router did not select this route id; record a synthetic required-but-missing requirement
      // so the pre-AI gate can detect it as a hard block rather than silently passing.
      byRouteId.set(routeId, syntheticRequirementForProfile(profile, routeId, context));
      touched = true;
    }
  }
  if (!touched) return requirements;
  return Array.from(byRouteId.values());
}

function syntheticRequirementForProfile(
  profile: AgentConnectorRiskProfile,
  routeId: string,
  context: AgentEvidenceContext,
): AgentEvidenceRequirement {
  const provider = providerForSyntheticRouteId(routeId);
  return {
    id: requirementIdFor(routeId),
    routeId,
    need: needForSyntheticRouteId(routeId, profile),
    provider,
    endpoint: routeId,
    status: 'required',
    ttlMs: ttlForRoute({ id: routeId } as AgentFactRoute, context.connectorProfile),
    blocking: true,
    reason: `${profile.label} risk profile requires ${routeId} but the router did not select it.`,
    ...(context.connectorProfile ? { connectorProfile: context.connectorProfile } : {}),
    ...(context.connectorId ? { connectorId: context.connectorId } : {}),
  };
}

function providerForSyntheticRouteId(routeId: string): AgentEvidenceRequirement['provider'] {
  if (routeId.startsWith('jupiter.')) return 'jupiter';
  if (routeId.startsWith('birdeye.')) return 'birdeye';
  if (routeId.startsWith('coingecko.')) return 'coingecko';
  if (routeId.startsWith('helius.')) return 'helius';
  if (routeId.startsWith('protocol_connector.')) return 'protocol_connector';
  if (routeId.startsWith('wallet.')) return 'wallet';
  if (routeId.startsWith('external_research.')) return 'external_research';
  if (routeId.startsWith('alternative_me.')) return 'alternative_me';
  if (routeId.startsWith('dexscreener.')) return 'dexscreener';
  return 'external_research';
}

function needForSyntheticRouteId(routeId: string, profile: AgentConnectorRiskProfile): AgentFactNeed {
  if (routeId === SWAP_QUOTE_ROUTE) return 'swap_quote';
  if (routeId === SWAP_ROUTE_ROUTE) return 'swap_route';
  if (routeId === TOKEN_PRICE_ROUTE) return 'token_market';
  if (routeId === TOKEN_SECURITY_ROUTE) return 'token_security';
  if (routeId === WALLET_HOLDINGS_ROUTE) return 'wallet_holdings';
  if (routeId === CONNECTOR_READ_ROUTE) return 'protocol_position';
  return profile.requiredNeeds[0] ?? 'protocol_position';
}
