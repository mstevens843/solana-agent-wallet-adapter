export type AgentFactNeed =
  | 'wallet_identity'
  | 'wallet_transfers'
  | 'wallet_holdings'
  | 'token_metadata'
  | 'token_security'
  | 'token_market'
  | 'swap_quote'
  | 'swap_route'
  | 'protocol_position'
  | 'global_market'
  | 'external_research'
  | 'tx_simulation';

export type AgentFactProvider =
  | 'wallet'
  | 'helius'
  | 'birdeye'
  | 'coingecko'
  | 'jupiter'
  | 'dexscreener'
  | 'alternative_me'
  | 'protocol_connector'
  | 'external_research'
  | 'rpc';

export type AgentFactRouteStatus = 'required' | 'optional';

export type AgentConnectorProfileKind =
  | 'swap_dex'
  | 'lending_borrow'
  | 'liquidity_pool'
  | 'staking_lst'
  | 'vault_yield'
  | 'yield_earn'
  | 'perps_margin'
  | 'nft_marketplace'
  | 'governance'
  | 'multisig'
  | 'bridge'
  | 'oracle'
  | 'jupiter';

export type AgentConnectorReadCapability =
  | 'positions'
  | 'rewards'
  | 'markets'
  | 'blinks'
  | 'swap'
  | 'tokens'
  | 'price'
  | 'earn'
  | 'borrow'
  | 'withdraw'
  | 'repay'
  | 'add_liquidity'
  | 'close'
  | 'marketplace'
  | 'oracle'
  | 'governance'
  | 'treasury'
  | 'bridge'
  | 'strategies'
  | 'prediction'
  | 'perps'
  | 'trigger'
  | 'recurring';

export type AgentFactRouteParam = string | number | boolean;

export interface AgentFactRoute {
  id: string;
  need: AgentFactNeed;
  provider: AgentFactProvider;
  endpoint: string;
  status: AgentFactRouteStatus;
  reason: string;
  cacheKey?: string;
  params?: Record<string, AgentFactRouteParam>;
}

export interface AgentFactSkippedNeed {
  need: AgentFactNeed;
  reason: string;
}

export interface AgentFactRoutePlan {
  routes: AgentFactRoute[];
  skipped: AgentFactSkippedNeed[];
  routeText: string;
  /**
   * True when the user's decision is a pure off-chain/current-fact gate that does not reference the
   * protocol/position. Threaded into the evidence context so the connector risk-profile upgrade does
   * not re-require connector reads the router deliberately demoted to optional.
   */
  offChainGateOnly: boolean;
}

export interface PlanAgentReviewFactRoutesInput {
  actionType?: string;
  intent?: string;
  route?: string;
  risk?: string;
  approval?: string;
  userNotes?: string;
  instruction?: string;
  question?: string;
  prompt?: string;
  parameters?: Record<string, string>;
  hasWallet?: boolean;
  hasTokenMints?: boolean;
  hasProtocolConnector?: boolean;
  connector?: AgentReviewConnectorContext;
  /**
   * Set to true when the plan record carries a serialized transaction (base64) that the
   * agent can simulate before approval. Only used by the rpc.simulate_transaction route —
   * if false, simulation is never tagged even when the question asks for it.
   */
  hasPreparedTx?: boolean;
  /**
   * Connector risk profile when known. Used only to upgrade simulation from "not tagged"
   * to "optional" for inherently risky profiles (perps, bridge, multisig) when a tx exists.
   */
  riskProfile?: AgentConnectorProfileKind;
}

export interface AgentReviewConnectorContext {
  id?: string;
  name?: string;
  enabled?: boolean;
  readReady?: boolean;
  readSource?: string;
  actionSource?: string;
  capabilities?: string[];
  actionKind?: string;
  operation?: string;
}

const PROTOCOL_ACTION_TYPES = new Set([
  'blink_action',
  'custom_transaction',
  'read_only',
  'custom',
]);
const LENDING_BORROW_CONNECTORS = new Set(['kamino', 'marginfi', 'project0', 'save']);
const LIQUIDITY_CONNECTORS = new Set(['raydium', 'orca', 'meteora']);
const STAKING_CONNECTORS = new Set(['jito', 'marinade', 'sanctum']);
const NFT_CONNECTORS = new Set(['tensor', 'magiceden']);
const GOVERNANCE_CONNECTORS = new Set(['realms']);
const MULTISIG_CONNECTORS = new Set(['squads']);
const BRIDGE_CONNECTORS = new Set(['wormhole', 'mayan']);
const YIELD_EARN_CONNECTORS = new Set(['lulo']);
const DRIFT_VAULT_HINT_RE = /(?:^|[^a-z0-9])vault(?:[^a-z0-9]|$)/i;
const PERPS_HINT_RE = /perps?|perpetual|leverage|liquidation/i;
const SWAP_HINT_RE = /(?:^|[^a-z0-9])swap(?:[^a-z0-9]|$)|aggregator|jupiter\s+swap/i;
const UNTRUSTED_ACTION_TYPES = new Set(['custom_transaction', 'blink_action', 'custom']);
const SIMULATION_HIGH_RISK_PROFILES = new Set<AgentConnectorProfileKind>(['perps_margin', 'bridge', 'multisig']);
// Phrases that mean "the user wants to know what this tx will actually do on chain".
// Matches imperative or interrogative outcome questions; deliberately narrow so we don't
// fire simulation for unrelated mentions of "result" in token-market questions.
const SIMULATION_OUTCOME_RE = /\b(will\s+this|what\s+(?:will|happens?|changes?|do(?:es)?)|drain|balance\s+after|outcome|side[-\s]?effects?|state\s+change|preview\s+the\s+effects?)\b/i;
// Match prompts that genuinely demand a live executable quote (price impact, output amount,
// best route comparison). Generic mentions of "swap" or "slippage" do not qualify — the user
// already supplied those values on the draft form. Only when the question asks the agent to
// derive quote/route information do we require a live Jupiter fetch.
const SWAP_QUOTE_DEMAND_RE = /\b(price\s*impact|best\s*route|how\s*much.*(?:get|receive|out)|compare.*(?:dex|aggregator|route|venue)|optimal\s*(?:route|venue)|optimize|fair\s*price|live\s*quote|fetch.*quote|expected\s*output|min(?:imum)?\s*received)\b/i;

// Match backward-looking / history-asking phrases only — not imperatives like "send to bob"
// or noun forms like "this transfer" that describe the current action. The router should
// trigger Helius only when the user is actually asking about transfer history.
const TRANSFER_CONTEXT_RE = /\b(sent|paid|payment|payout|counterparty|recipient\s+history|wallet\s+activity|transaction\s+history|recent\s+activity|duplicate|already|same\s+recipient|past\s+transfers?|previous\s+transfers?|prior\s+transfers?)\b/i;
const HOLDINGS_REQUIRED_RE = /\b(balance|balances|holding|holdings|portfolio|position|positions|exposure|own|owns|do i have|can afford|enough funds|wallet tokens|available funds|insufficient|afford)\b/i;
const HOLDINGS_OPTIONAL_RE = /\b(swap|transfer|deposit|withdraw|borrow|repay|stake|unstake|liquidity|vault|lend|collateral|dca|recurring|position)\b/i;
const TOKEN_IDENTITY_RE = /\b(token|tokens|mint|mints|symbol|metadata|name|address|verify|verified)\b/i;
const TOKEN_SECURITY_RE = /\b(unknown token|new token|safety|safe|risk|risky|scam|honeypot|rug|mint authority|minting authority|freeze authority|mintable|owner authority|creation|created|age|true token|security|verify token|verified token)\b/i;
const TOKEN_MARKET_TERM_RE = /\b(token\s+price|coin\s+price|asset\s+price|market cap|mcap|fdv|liquidity|volume|24h|change|volatility|spread|pool|pair|onchain price|dex\s*screener|birdeye|coingecko)\b/i;
const TOKEN_PRICE_SYMBOL_RE = /\b(sol|btc|eth|usdc|usdt|jup|bonk|wif|pyusd)\b[^.\n]{0,80}\b(price|value|worth|above|over|greater than|more than|>=?|below|under|less than|<=?|at least|at most)\b[^.\n]{0,40}\$?\s*\d/i;
const TOKEN_PRICE_SYMBOL_REVERSED = /\b(price|value|worth|above|over|greater than|more than|>=?|below|under|less than|<=?|at least|at most)\b[^.\n]{0,80}\b(sol|btc|eth|usdc|usdt|jup|bonk|wif|pyusd)\b/i;
const TOKEN_PRICE_SUBJECT_RE = /\b(?:input|output|this|the)?\s*(token|coin|mint|asset)\b[^.\n]{0,80}\b(price|value|worth|above|over|greater than|more than|>=?|below|under|less than|<=?|at least|at most)\b[^.\n]{0,40}\$?\s*\d/i;
const TOKEN_MARKET_DEPTH_RE = /\b(market cap|mcap|fdv|volume|24h|change|coingecko|pool count|onchain price|history|historical)\b/i;
const PROTOCOL_RE = /\b(protocol|dapp|connector|position|positions|rewards|claim|health|collateral|vault|pool|lp|lend|borrow|repay|deposit|withdraw|stake|unstake|oracle|pyth|margin|liquidation)\b/i;
const GLOBAL_MARKET_RE = /\b(fear\s*(?:&|and)\s*greed|sentiment|btc dominance|bitcoin dominance|eth dominance|total market cap|global market|market conditions|crypto market|risk on|risk off|macro|dominance)\b/i;
const EXTERNAL_RESEARCH_RE = /\b(latest|current|today|news|headline|status page|outage|incident|docs?|documentation|release notes|announcement|recent exploit|exploit|hack|governance vote|proposal)\b/i;
const OFF_CHAIN_DECISION_RE = /\b(plan|subscription|service charge|monthly|phone plan|mobile plan|membership|invoice|bill|fee|cost|rate|netflix|spotify|t-?mobile|helium|outage|incident|exploit|business day|holiday|spy|website|status page|governance vote|proposal)\b/i;

export function planAgentReviewFactRoutes(input: PlanAgentReviewFactRoutesInput): AgentFactRoutePlan {
  const routes: AgentFactRoute[] = [];
  const skipped: AgentFactSkippedNeed[] = [];
  const seen = new Set<string>();
  const actionType = normalize(input.actionType);
  const text = routePlanningText(input);
  const decisionText = routeDecisionText(input);
  const hasWallet = input.hasWallet === true;
  const hasTokenMints = input.hasTokenMints === true;
  const connector = normalizedConnectorContext(input.connector);
  const hasProtocolConnector = input.hasProtocolConnector === true || connector?.readReady === true;

  const addRoute = (route: AgentFactRoute): void => {
    if (seen.has(route.id)) return;
    seen.add(route.id);
    routes.push(route);
  };
  const skip = (need: AgentFactNeed, reason: string): void => {
    if (skipped.some((entry) => entry.need === need && entry.reason === reason)) return;
    skipped.push({ need, reason });
  };

  if (hasWallet) {
    addRoute({
      id: 'wallet.connected_public_key',
      need: 'wallet_identity',
      provider: 'wallet',
      endpoint: 'connected_public_key',
      status: 'required',
      reason: 'Approval/denial must be scoped to the connected or draft wallet public key.',
    });
  } else {
    skip('wallet_identity', 'No connected wallet or draft wallet address was available.');
  }

  // Transfer history is only useful when the QUESTION explicitly cares about it
  // (duplicate payment, recipient history, recent activity, etc.). Action type alone
  // (e.g., transfer_sol) does NOT imply the agent needs transfer history — calling
  // Helius for an unrelated question (e.g., a USD-threshold approval) wastes a network
  // round-trip and adds noise to the gate.
  if (TRANSFER_CONTEXT_RE.test(text)) {
    if (hasWallet) {
      addRoute({
        id: 'helius.getTransfersByAddress',
        need: 'wallet_transfers',
        provider: 'helius',
        endpoint: 'getTransfersByAddress',
        status: 'required',
        reason: 'The question explicitly asks about transfer history, recipient history, or duplicate payments.',
      });
    } else {
      skip('wallet_transfers', 'Transfer history requires a wallet public key.');
    }
  }

  // Wallet holdings are only queried when the QUESTION cares about balance/affordability/
  // exposure (required) or when the question mentions a wallet operation that benefits from
  // a quick balance sanity check (optional). Action type alone does NOT add this route — the
  // chain rejects insufficient-funds transactions, so we don't need a Birdeye round-trip just
  // because the plan is a transfer.
  const holdingsRequired = HOLDINGS_REQUIRED_RE.test(text);
  const holdingsUseful = holdingsRequired || (HOLDINGS_OPTIONAL_RE.test(text) && !OFF_CHAIN_DECISION_RE.test(decisionText));
  if (holdingsUseful) {
    if (hasWallet) {
      addRoute({
        id: 'birdeye.wallet_token_list',
        need: 'wallet_holdings',
        provider: 'birdeye',
        endpoint: 'wallet-token-list',
        status: holdingsRequired ? 'required' : 'optional',
        reason: holdingsRequired
          ? 'The question needs wallet balances, holdings, or affordability evidence.'
          : 'Wallet holdings are useful context for this money-moving action.',
      });
    } else {
      skip('wallet_holdings', 'Wallet holdings require a wallet public key.');
    }
  }

  const tokenIdentityRequired = TOKEN_IDENTITY_RE.test(decisionText);
  const tokenSecurityRequired = TOKEN_SECURITY_RE.test(decisionText);
  const tokenMarketRequired = tokenMarketRequiredByUser(decisionText);
  // True when the user's decision is a pure off-chain/current-fact gate (e.g. "approve if Helium
  // plan < $20"). Action-mechanics evidence (swap quote/route, connector reads) must not be REQUIRED
  // for such a question — answer only what was asked. The extra !PROTOCOL_RE guard keeps connector
  // facts required whenever the question actually references the protocol/position/health.
  const offChainDecision = offChainDecisionOnly(decisionText, {
    tokenIdentityRequired,
    tokenSecurityRequired,
    tokenMarketRequired,
    globalMarketRequired: GLOBAL_MARKET_RE.test(decisionText),
  });
  const offChainGateOnly = offChainDecision && !PROTOCOL_RE.test(decisionText);
  if (tokenIdentityRequired) {
    if (hasTokenMints) {
      addRoute({
        id: 'birdeye.token_metadata',
        need: 'token_metadata',
        provider: 'birdeye',
        endpoint: 'token-meta',
        status: 'required',
        reason: 'The question asks for token identity, symbol, metadata, or verification evidence.',
      });
    } else {
      skip('token_metadata', 'Token metadata lookup needs a resolved Solana mint address.');
    }
  }

  if (tokenSecurityRequired) {
    if (hasTokenMints) {
      addRoute({
        id: 'birdeye.token_security',
        need: 'token_security',
        provider: 'birdeye',
        endpoint: 'token-security',
        status: 'required',
        reason: 'The question asks for token safety, authority, age, or scam-risk evidence.',
      });
    } else {
      skip('token_security', 'Token security lookup needs a resolved Solana mint address.');
    }
  }

  if (tokenMarketRequired) {
    if (hasTokenMints) {
      addRoute({
        id: 'birdeye.price_multi',
        need: 'token_market',
        provider: 'birdeye',
        endpoint: 'price-multi',
        status: 'required',
        reason: 'The question depends on token price, liquidity, or market threshold evidence.',
      });
      addRoute({
        id: 'coingecko.token_evidence',
        need: 'token_market',
        provider: 'coingecko',
        endpoint: 'token-evidence',
        status: TOKEN_MARKET_DEPTH_RE.test(decisionText) ? 'required' : 'optional',
        reason: TOKEN_MARKET_DEPTH_RE.test(decisionText)
          ? 'The question needs market-cap, volume, 24h change, or broader token-market evidence.'
          : 'CoinGecko can supplement BirdEye with secondary token-market evidence.',
      });
      addRoute({
        id: 'dexscreener.token_pairs',
        need: 'token_market',
        provider: 'dexscreener',
        endpoint: 'token-pairs/v1/solana/{mint}',
        status: 'optional',
        reason: 'DEX Screener is a fallback when primary Solana token-market providers have no row.',
      });
    } else {
      skip('token_market', 'Token market lookup needs a resolved Solana mint address.');
    }
  }

  // Swap-execution evidence (Jupiter quote/route/slippage) describes a SWAP DRAFT, so it is required
  // ONLY for actions that actually execute a swap: an explicit swap, or a recurring DCA swap. Action
  // type is the SOLE determinant — never free-text prose. A send, a proof-sign (manual_review), an
  // evidence review (read_only), a transfer, or any connector action has no swap draft and must
  // answer the user's question on its own merits — never blocked by a bogus "Swap draft has no
  // slippage cap" gate just because incidental prose (e.g. the medium-risk template "…fees, route,
  // and memo…" or the "DCA review proof" copy "…swap-capable recurring engine…") mentions the word.
  const swapLike =
    actionType === 'swap' ||
    (actionType === 'recurring_payment' && input.parameters?.actionKind === 'swap');
  if (swapLike) {
    const amountString = (input.parameters?.amount ?? input.parameters?.inputAmount ?? '').trim();
    const hasAmount = amountString.length > 0 && Number(amountString) > 0;
    const slippageString = (input.parameters?.slippageBps ?? input.parameters?.maxSlippage ?? '').trim();
    const hasSlippage = slippageString.length > 0;
    const quoteDemanded = SWAP_QUOTE_DEMAND_RE.test(text) || !hasAmount || !hasSlippage;
    if (!quoteDemanded && offChainDecision) {
      skip('swap_quote', 'Swap quote not selected: the user request only asks an off-chain/current-fact gate.');
      skip('swap_route', 'Swap route not selected: the user request only asks an off-chain/current-fact gate.');
    } else {
      const quoteStatus: AgentFactRouteStatus = quoteDemanded ? 'required' : 'optional';
      const quoteReason = quoteDemanded
        ? !hasAmount
          ? 'Swap draft has no amount; a Jupiter quote is required to compute the executable order.'
          : !hasSlippage
            ? 'Swap draft has no slippage cap; a Jupiter quote is required before approval.'
            : 'The question asks for live quote details (price impact, output amount, best route).'
        : 'Quote/route resolve at the wallet step; user already supplied amount and slippage.';
      addRoute({
        id: 'jupiter.swap_order_preview',
        need: 'swap_quote',
        provider: 'jupiter',
        endpoint: 'swap.order existing tool',
        status: quoteStatus,
        reason: quoteReason,
      });
      addRoute({
        id: 'jupiter.swap_route',
        need: 'swap_route',
        provider: 'jupiter',
        endpoint: 'swap.order routePlan',
        status: quoteStatus,
        reason: 'Tracks the executable Jupiter route alongside the quote.',
      });
    }
  }

  // Pre-sign transaction simulation. Only tagged when the question or action source warrants
  // it AND a serialized tx is already on the record. Designed to be opt-in: most plans (simple
  // transfers, phone-plan threshold checks, first-class adapter actions without an outcome
  // question) never trigger this and never call the RPC.
  const wantsSimulationOutcome = SIMULATION_OUTCOME_RE.test(text);
  const isUntrustedAction = UNTRUSTED_ACTION_TYPES.has(actionType);
  const highRiskProfile = input.riskProfile ? SIMULATION_HIGH_RISK_PROFILES.has(input.riskProfile) : false;
  if (input.hasPreparedTx) {
    if (wantsSimulationOutcome || isUntrustedAction) {
      addRoute({
        id: 'rpc.simulate_transaction',
        need: 'tx_simulation',
        provider: 'rpc',
        endpoint: 'simulateTransaction',
        status: 'required',
        reason: wantsSimulationOutcome
          ? 'The question asks about the on-chain effects of this transaction.'
          : `Action source (${actionType}) is untrusted; simulation is required to verify on-chain effects.`,
      });
    } else if (highRiskProfile) {
      addRoute({
        id: 'rpc.simulate_transaction',
        need: 'tx_simulation',
        provider: 'rpc',
        endpoint: 'simulateTransaction',
        status: 'optional',
        reason: `Risk profile (${input.riskProfile}) benefits from simulating effects before approval.`,
      });
    }
  } else if (wantsSimulationOutcome) {
    // Outcome question asked but no tx available — record as skipped need so the gate
    // surfaces it as needs_input rather than silently dropping the user's intent.
    skip('tx_simulation', 'Simulation requested but no serialized transaction is on the record yet.');
  }

  const connectorPlan = connector ? connectorReadRoutePlan(connector, actionType, text) : undefined;
  if (connector && connectorPlan) {
    if (connector.enabled === false) {
      skip('protocol_position', `${connectorPlan.label} connector is selected but disabled.`);
    } else if (connector.readReady === false) {
      skip('protocol_position', `${connectorPlan.label} connector read APIs are not ready.`);
    } else {
      addRoute({
        id: 'protocol_connector.read_facts',
        need: 'protocol_position',
        provider: 'protocol_connector',
        endpoint: 'connector-read-facts',
        // Off-chain gate questions that don't reference the protocol demote connector reads to
        // optional context so they never block (parity with the swap branch above). The risk-profile
        // upgrade in agentEvidenceRequirements honors the same offChainGateOnly flag.
        status: connectorPlan.required && !offChainGateOnly ? 'required' : 'optional',
        reason: connectorPlan.reason,
        cacheKey: `${connector.id}:${connectorPlan.capability}`,
        params: stripEmptyRouteParams({
          connectorId: connector.id,
          connectorName: connector.name,
          profile: connectorPlan.profile,
          capability: connectorPlan.capability,
          actionKind: connector.actionKind,
          operation: connector.operation,
        }),
      });
    }
  } else {
    const protocolNeeded = hasProtocolConnector || PROTOCOL_ACTION_TYPES.has(actionType) || PROTOCOL_RE.test(text);
    if (protocolNeeded && hasProtocolConnector) {
      addRoute({
        id: 'protocol_connector.read_facts',
        need: 'protocol_position',
        provider: 'protocol_connector',
        endpoint: 'connector-read-facts',
        status: PROTOCOL_RE.test(text) ? 'required' : 'optional',
        reason: 'Protocol-specific positions, rewards, or health should use the selected connector read path.',
      });
    } else if (protocolNeeded && PROTOCOL_RE.test(text)) {
      skip('protocol_position', 'Protocol fact lookup needs a matching enabled connector.');
    }
  }

  if (GLOBAL_MARKET_RE.test(text)) {
    addRoute({
      id: 'coingecko.global',
      need: 'global_market',
      provider: 'coingecko',
      endpoint: 'global',
      status: 'required',
      reason: 'The question asks for global crypto-market conditions.',
    });
    addRoute({
      id: 'alternative_me.fear_greed',
      need: 'global_market',
      provider: 'alternative_me',
      endpoint: 'fng',
      status: /fear\s*(?:&|and)\s*greed|sentiment/i.test(text) ? 'required' : 'optional',
      reason: 'Fear & Greed is useful sentiment context for market-condition questions.',
    });
  }

  if (EXTERNAL_RESEARCH_RE.test(text)) {
    addRoute({
      id: 'external_research.current_web',
      need: 'external_research',
      provider: 'external_research',
      endpoint: 'ai-native-current-research',
      status: 'required',
      reason: 'The question references current events, docs, status, or news outside deterministic wallet/provider facts.',
    });
  }

  return {
    routes,
    skipped,
    routeText: routePlanText(routes, skipped),
    offChainGateOnly,
  };
}

function offChainDecisionOnly(
  decisionText: string,
  flags: {
    tokenIdentityRequired: boolean;
    tokenSecurityRequired: boolean;
    tokenMarketRequired: boolean;
    globalMarketRequired: boolean;
  },
): boolean {
  if (!decisionText.trim()) return false;
  if (!OFF_CHAIN_DECISION_RE.test(decisionText)) return false;
  if (flags.tokenIdentityRequired || flags.tokenSecurityRequired || flags.tokenMarketRequired || flags.globalMarketRequired) return false;
  if (SWAP_QUOTE_DEMAND_RE.test(decisionText)) return false;
  if (/\b(slippage|price impact|minimum received|min received|output amount|route|quote|jupiter|dex|aggregator|token age|mint authority|freeze authority|market cap|liquidity|volume|fear\s*(?:&|and)\s*greed|btc dominance|total market cap)\b/i.test(decisionText)) return false;
  return true;
}

function routePlanningText(input: PlanAgentReviewFactRoutesInput): string {
  const parameterText = input.parameters
    ? Object.entries(input.parameters)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n')
    : '';
  return [
    input.actionType,
    input.intent,
    input.route,
    input.risk,
    input.approval,
    input.userNotes,
    input.instruction,
    input.question,
    input.prompt,
    parameterText,
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join('\n')
    .toLowerCase();
}

function routeDecisionText(input: PlanAgentReviewFactRoutesInput): string {
  const userFacing = [
    input.userNotes,
    input.instruction,
    input.question,
    input.prompt,
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join('\n')
    .toLowerCase();
  if (userFacing.trim().length > 0) return userFacing;
  return [
    input.intent,
    input.route,
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join('\n')
    .toLowerCase();
}

function tokenMarketRequiredByUser(text: string): boolean {
  return TOKEN_MARKET_TERM_RE.test(text) ||
    TOKEN_PRICE_SYMBOL_RE.test(text) ||
    TOKEN_PRICE_SYMBOL_REVERSED.test(text) ||
    TOKEN_PRICE_SUBJECT_RE.test(text);
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function normalizedConnectorContext(
  connector: AgentReviewConnectorContext | undefined,
): AgentReviewConnectorContext | undefined {
  const id = normalize(connector?.id);
  if (!id) return undefined;
  return {
    ...connector,
    id,
    name: connector?.name?.trim() || id,
    actionKind: normalize(connector?.actionKind),
    operation: connector?.operation?.trim(),
    readSource: connector?.readSource?.trim(),
    actionSource: connector?.actionSource?.trim(),
  };
}

interface ConnectorReadRoutePlan {
  profile: AgentConnectorProfileKind;
  capability: AgentConnectorReadCapability;
  required: boolean;
  label: string;
  reason: string;
}

function connectorReadRoutePlan(
  connector: AgentReviewConnectorContext,
  actionType: string,
  text: string,
): ConnectorReadRoutePlan | undefined {
  const id = connector.id ?? '';
  const profile = connectorProfileKind(id, connector.actionKind ?? actionType);
  if (!profile) return undefined;
  const capability = connectorReadCapability(id, profile, connector.actionKind ?? actionType, text);
  const label = connector.name || id;
  const selectedAction = Boolean(connector.actionKind || actionType === 'read_only' || actionType === 'blink_action' || actionType === 'custom_transaction');
  return {
    profile,
    capability,
    label,
    required: selectedAction || PROTOCOL_RE.test(text),
    reason: connectorReadReason(label, profile, capability),
  };
}

export function connectorProfileKind(id: string, actionKind: string): AgentConnectorProfileKind | undefined {
  if (id === 'jupiter') {
    if (SWAP_HINT_RE.test(actionKind)) return 'swap_dex';
    if (PERPS_HINT_RE.test(actionKind)) return 'perps_margin';
    return 'jupiter';
  }
  if (id === 'drift') {
    if (DRIFT_VAULT_HINT_RE.test(actionKind)) return 'vault_yield';
    if (PERPS_HINT_RE.test(actionKind)) return 'perps_margin';
    return 'perps_margin';
  }
  if (MULTISIG_CONNECTORS.has(id)) return 'multisig';
  if (YIELD_EARN_CONNECTORS.has(id)) return 'yield_earn';
  if (LENDING_BORROW_CONNECTORS.has(id)) return 'lending_borrow';
  if (LIQUIDITY_CONNECTORS.has(id)) return 'liquidity_pool';
  if (STAKING_CONNECTORS.has(id)) return 'staking_lst';
  if (NFT_CONNECTORS.has(id)) return 'nft_marketplace';
  if (GOVERNANCE_CONNECTORS.has(id)) return 'governance';
  if (BRIDGE_CONNECTORS.has(id) || /\b(bridge|cross[-\s]?chain|wormhole|mayan)\b/.test(actionKind)) return 'bridge';
  if (id === 'pyth') return 'oracle';
  return undefined;
}

function connectorReadCapability(
  connectorId: string,
  profile: AgentConnectorProfileKind,
  actionKind: string,
  text: string,
): AgentConnectorReadCapability {
  const action = `${actionKind} ${text}`;
  switch (profile) {
    case 'jupiter':
      if (/trigger|limit|oco|otoco/.test(action)) return 'trigger';
      if (/recurring|dca/.test(action)) return 'recurring';
      if (/perps?|perpetual/.test(action)) return 'perps';
      if (/prediction|orderbook|polymarket|kalshi/.test(action)) return 'prediction';
      if (/lend_earn|earn|deposit|mint|redeem/.test(action)) return 'earn';
      if (/lend_borrow|borrow|repay|collateral|health/.test(action)) return 'positions';
      if (/(^|_)swap\b|jupiter\s+swap/.test(action)) return 'swap';
      if (/token|mint|risk/.test(action)) return 'tokens';
      if (/price|quote|market/.test(action)) return 'price';
      return 'swap';
    case 'swap_dex':
      if (/token|mint|risk/.test(action)) return 'tokens';
      if (/price|quote|impact|slippage|market/.test(action)) return 'price';
      return 'swap';
    case 'lending_borrow':
      if (/reward|claim|earnings/.test(action)) return 'rewards';
      if (connectorId === 'kamino') return /market|reserve|rate|apy/.test(action) ? 'markets' : 'positions';
      if (/borrow/.test(action)) return 'borrow';
      if (/repay/.test(action)) return 'repay';
      if (/withdraw|unstake|complete/.test(action)) return 'withdraw';
      if (/deposit|supply|earn|mint/.test(action)) return 'earn';
      if (/market|reserve|bank|vault|rate|apy/.test(action)) return 'markets';
      return 'positions';
    case 'liquidity_pool':
      if (/fee|fees|reward|harvest|claim|farm/.test(action)) return 'rewards';
      if (/pool|market|liquidity|add|remove|increase|decrease/.test(action)) return 'positions';
      return 'positions';
    case 'staking_lst':
      if (/swap/.test(action)) return 'swap';
      if (/withdraw|unstake|claim|remove/.test(action)) return 'withdraw';
      if (/stake|deposit|add|liquidity|earn/.test(action)) return 'earn';
      if (/market|pool|validator|lst|apy/.test(action)) return 'markets';
      return 'positions';
    case 'vault_yield':
      if (/withdraw|complete|cancel|redeem/.test(action)) return 'withdraw';
      if (/deposit|stake|earn|mint/.test(action)) return 'earn';
      if (/market|vault|strategy|apy/.test(action)) return 'markets';
      return 'positions';
    case 'yield_earn':
      if (/withdraw|complete|redeem|cancel/.test(action)) return 'withdraw';
      if (/deposit|earn|supply|mint|rate|apy|market/.test(action)) return 'earn';
      return 'positions';
    case 'perps_margin':
      if (/withdraw|complete|cancel|redeem/.test(action)) return 'withdraw';
      if (/deposit|earn|stake|fund/.test(action)) return 'earn';
      if (/market|vault|custody|pool/.test(action)) return 'markets';
      return 'perps';
    case 'nft_marketplace':
      if (/buy|bid|list|sweep|floor|collection|market/.test(action)) return 'marketplace';
      return 'positions';
    case 'governance':
      if (/treasury|vault|transfer/.test(action)) return 'treasury';
      return 'governance';
    case 'multisig':
      if (/treasury|vault|transfer|fund/.test(action)) return 'treasury';
      return 'governance';
    case 'bridge':
      if (/transfer|redeem|recover|resume|quote|bridge|destination/.test(action)) return 'bridge';
      return 'positions';
    case 'oracle':
      return 'oracle';
  }
}

function connectorReadReason(
  label: string,
  profile: AgentConnectorProfileKind,
  capability: AgentConnectorReadCapability,
): string {
  switch (profile) {
    case 'swap_dex':
      return `${label} swap approvals need selected connector facts; live quote, route, and token-market reads are prompt-scoped.`;
    case 'lending_borrow':
      return `${label} approvals need ${capability} facts for positions, reserves, health, or claimable rewards.`;
    case 'liquidity_pool':
      return `${label} approvals need pool, LP position, fee, or reward facts from the connector.`;
    case 'staking_lst':
      return `${label} approvals need staking, LST, pool, quote, or wallet-position facts from the connector.`;
    case 'vault_yield':
      return `${label} approvals need vault position, deposit/withdraw state, and strategy facts from the connector.`;
    case 'yield_earn':
      return `${label} approvals need earn position, withdrawal state, and rate facts from the connector.`;
    case 'perps_margin':
      return `${label} approvals need margin/custody, market, leverage, and liquidation/health facts from the connector.`;
    case 'nft_marketplace':
      return `${label} approvals need NFT collection, listing, bid, or wallet NFT facts from the connector.`;
    case 'governance':
      return `${label} approvals need governance, proposal, signer, threshold, or treasury facts from the connector.`;
    case 'multisig':
      return `${label} approvals need multisig threshold, signer membership, transaction index, and vault/treasury facts.`;
    case 'bridge':
      return `${label} approvals need route, destination, fee, transfer-status, or bridge-exposure facts.`;
    case 'oracle':
      return `${label} checks need oracle price, confidence, and freshness evidence.`;
    case 'jupiter':
      return `${label} approvals need Jupiter ${capability} facts for the selected Jupiter product.`;
  }
}

function stripEmptyRouteParams(
  params: Record<string, AgentFactRouteParam | undefined>,
): Record<string, AgentFactRouteParam> | undefined {
  const out: Record<string, AgentFactRouteParam> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function routePlanText(routes: AgentFactRoute[], skipped: AgentFactSkippedNeed[]): string {
  if (!routes.length && !skipped.length) return 'No external fact routes selected.';
  const required = routes.filter((route) => route.status === 'required').length;
  const optional = routes.length - required;
  const providers = [...new Set(routes.map((route) => route.provider))].join(', ') || 'none';
  const skippedText = skipped.length ? ` ${skipped.length} need${skipped.length === 1 ? '' : 's'} skipped.` : '';
  return `Fact router selected ${routes.length} route${routes.length === 1 ? '' : 's'} (${required} required, ${optional} optional) across ${providers}.${skippedText}`;
}
