// Jupiter connector action atoms (v1). Jupiter is built-in via the project's own API
// and already has read tools for every action, so all the live-fact recipes below map
// onto existing actionService.connectorReadFacts capabilities. The `format` functions
// project the raw connectorReadFacts envelope ({ connector, capability, ...data, facts })
// into a compact, token-efficient block — that projection is the core token win.

import type { ConnectorActionAtom, ConnectorFactArgs } from './types.js';
import { asArray, clampConnectorFacts, compact, num, obj, shortMint, str, stripConnector } from './util.js';

// Re-exported for back-compat with existing importers (index.ts, consumers).
export { clampConnectorFacts };

// Jupiter swap order-preview envelope: { preview: {...}, facts }. Projects the quote.
export function formatJupiterSwapQuote(raw: Record<string, unknown>): Record<string, unknown> {
  const p = obj(raw.preview) ?? raw;
  return compact({
    kind: 'jupiter_swap_quote',
    inputMint: shortMint(str(p.inputMint)),
    outputMint: shortMint(str(p.outputMint)),
    inAmount: str(p.inAmount),
    outAmount: str(p.outAmount),
    minOut: str(p.otherAmountThreshold),
    slippageBps: num(p.slippageBps),
    priceImpactPct: num(p.priceImpactPct) ?? str(p.priceImpact),
    swapMode: str(p.swapMode),
    route: Array.isArray(p.routePlan) ? (p.routePlan as unknown[]).length : undefined,
  });
}

// ---- the atoms ------------------------------------------------------------------

export const JUPITER_ATOMS: ConnectorActionAtom[] = [
  {
    connectorId: 'jupiter',
    action: 'lend',
    aliases: ['lend', 'earn', 'supply', 'yield', 'deposit', 'apy', 'interest'],
    knowledge: {
      title: 'Jupiter Lend (Earn)',
      summary: 'Supply assets to Jupiter Earn vaults to earn yield; read live vault rates and your positions.',
      capabilities: ['supply / withdraw on Earn vaults', 'read your supplied positions + APY', 'read market rates per asset'],
      requiredParams: ['walletAddress for your positions; assetMint for one token; neither for the market list'],
      constraints: ['REST reads work without an API key', 'evidence only — reads do not approve actions'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_jupiter_lend_earn_positions',
      capability: 'earn',
      buildInput: (a: ConnectorFactArgs) => compact({
        ...(a.walletAddress ? { walletAddress: a.walletAddress } : {}),
        ...(a.mint ? { reserveMint: a.mint } : {}),
      }),
      format: (raw) => {
        const positions = asArray(raw.positions);
        if (positions.length) {
          return {
            kind: 'lend_positions',
            count: positions.length,
            positions: positions.slice(0, 8).map((p) => compact({
              asset: str(p.tokenSymbol) ?? shortMint(str(p.assetMint)),
              supplied: str(p.underlyingAmount),
              apy: num(p.apy),
              rewardApy: num(p.rewardApy),
            })),
            asOf: str(raw.asOf) ?? str(positions[0]?.asOf),
          };
        }
        const tokens = asArray(raw.tokens);
        if (tokens.length) {
          return {
            kind: 'lend_markets',
            count: tokens.length,
            markets: tokens.slice(0, 10).map((t) => compact({
              asset: str(t.tokenSymbol) ?? shortMint(str(t.assetMint)),
              apy: num(t.apy),
              rewardApy: num(t.rewardApy),
              utilization: num(t.utilization),
            })),
          };
        }
        const token = obj(raw.token);
        if (token) {
          return compact({
            kind: 'lend_market',
            asset: str(token.tokenSymbol) ?? shortMint(str(token.assetMint)),
            apy: num(token.apy),
            rewardApy: num(token.rewardApy),
            utilization: num(token.utilization),
          });
        }
        return { kind: 'lend', note: 'No Jupiter lend data returned.' };
      },
    },
  },
  {
    connectorId: 'jupiter',
    action: 'borrow',
    aliases: ['borrow', 'loan', 'debt', 'collateral', 'health', 'health factor', 'ltv', 'liquidation'],
    knowledge: {
      title: 'Jupiter Borrow',
      summary: 'Borrow against collateral in Jupiter Borrow vaults; read your positions, debt, and liquidation health.',
      capabilities: ['deposit collateral / borrow / repay / withdraw', 'read your positions + health ratio', 'list borrow vaults'],
      requiredParams: ['walletAddress (falls back to the connected wallet) for positions'],
      constraints: [
        'Borrow writes need the optional @jup-ag/lend SDK; without it, borrow reads + prepares are blocked while swap + earn keep working',
        'borrow / withdraw-collateral are blocked below the configured min health ratio (default 1.25)',
      ],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_jupiter_lend_borrow_positions',
      capability: 'positions',
      buildInput: (a: ConnectorFactArgs) => compact({ ...(a.walletAddress ? { walletAddress: a.walletAddress } : {}) }),
      format: (raw) => {
        const positions = asArray(raw.positions);
        if (positions.length) {
          return {
            kind: 'borrow_positions',
            count: positions.length,
            positions: positions.slice(0, 8).map((p) => compact({
              vault: num(p.vaultId),
              collateral: str(p.collateralAmount),
              debt: str(p.debtAmount),
              collateralUsd: str(p.collateralValueUsd),
              debtUsd: str(p.debtValueUsd),
              health: num(p.healthRatio) ?? str(p.healthRatioText),
              status: str(p.liquidationStatus),
            })),
            asOf: str(raw.asOf) ?? str(positions[0]?.asOf),
          };
        }
        const vaults = asArray(raw.vaults);
        if (vaults.length) {
          return {
            kind: 'borrow_vaults',
            count: vaults.length,
            vaults: vaults.slice(0, 10).map((v) => compact({
              vault: num(v.vaultId),
              supply: str(v.supplySymbol),
              borrow: str(v.borrowSymbol),
              borrowApr: num(v.borrowApr),
              supplyApy: num(v.supplyApy),
              ltvBps: num(v.ltvBps),
            })),
          };
        }
        return { kind: 'borrow', note: 'No Jupiter borrow positions for this wallet.' };
      },
    },
  },
  {
    connectorId: 'jupiter',
    action: 'limit',
    aliases: ['limit', 'trigger', 'tp', 'sl', 'tp/sl', 'take profit', 'stop loss', 'limit order'],
    knowledge: {
      title: 'Jupiter Limit / TP-SL (Trigger V2)',
      summary: 'Place and track limit, take-profit and stop-loss (trigger) orders; read your open and historical orders.',
      capabilities: ['create / edit / cancel single, OCO and OTOCO trigger orders', 'read open orders + history'],
      requiredParams: ['walletAddress for your orders'],
      constraints: [
        'Disabled by default until the Jupiter Trigger flag is enabled',
        'Trigger orders deposit into a Jupiter-managed custody vault; fills execute through Jupiter automation outside the Agentic approval inbox',
      ],
      enabledByDefault: false,
    },
    factSpec: {
      readTool: 'solana_jupiter_trigger_orders',
      capability: 'trigger',
      buildInput: (a: ConnectorFactArgs) => compact({ ...(a.walletAddress ? { walletAddress: a.walletAddress } : {}) }),
      format: (raw) => clampConnectorFacts(stripConnector(raw)),
    },
  },
  {
    connectorId: 'jupiter',
    action: 'dca',
    aliases: ['dca', 'recurring', 'dollar cost', 'dollar-cost', 'schedule', 'auto buy', 'auto-buy'],
    knowledge: {
      title: 'Jupiter DCA (Recurring)',
      summary: 'Create time-based native DCA orders (and manage deprecated price orders); read your recurring orders.',
      capabilities: ['create / cancel time-based DCA orders', 'read active recurring orders'],
      requiredParams: ['walletAddress for your orders'],
      constraints: [
        'Disabled by default until the Jupiter Recurring flag is enabled',
        'Future fills execute through Jupiter automation outside the Agentic approval inbox',
      ],
      enabledByDefault: false,
    },
    factSpec: {
      readTool: 'solana_jupiter_recurring_orders',
      capability: 'recurring',
      buildInput: (a: ConnectorFactArgs) => compact({ ...(a.walletAddress ? { walletAddress: a.walletAddress } : {}) }),
      format: (raw) => clampConnectorFacts(stripConnector(raw)),
    },
  },
  {
    connectorId: 'jupiter',
    action: 'perps',
    aliases: ['perp', 'perps', 'perpetual', 'perpetuals', 'leverage', 'futures', 'jlp'],
    knowledge: {
      title: 'Jupiter Perps',
      summary: 'Read-only research surface for Jupiter Perps; reports API readiness. No perps writes or leverage recommendations.',
      capabilities: ['read perps API/readiness status'],
      requiredParams: ['none'],
      constraints: [
        'Read-only in v1: pool / custody / position snapshots return unsupported_method until the official API stabilizes',
        'All perps writes, leverage recommendations and JLP writes are denied',
      ],
      enabledByDefault: false,
    },
    factSpec: {
      readTool: 'solana_jupiter_perps_status',
      capability: 'perps',
      buildInput: () => ({}),
      format: (raw) => compact({
        kind: 'perps_status',
        supported: true,
        readOnly: raw.readOnly === false ? false : true,
        apiStatus: str(raw.apiStatus),
        officialDocsStatus: str(raw.officialDocsStatus),
        warnings: Array.isArray(raw.warnings) ? (raw.warnings as unknown[]).slice(0, 3) : undefined,
      }),
    },
  },
  {
    connectorId: 'jupiter',
    action: 'prediction',
    aliases: ['prediction', 'predict', 'prediction market', 'betting', 'odds'],
    knowledge: {
      title: 'Jupiter Prediction',
      summary: 'Read live Jupiter prediction-market events and markets (beta, read-only).',
      capabilities: ['search events', 'read events / markets / orderbook'],
      requiredParams: ['query to search events'],
      constraints: ['Beta and read-only in v1 (no order create/close/claim)', 'Disabled by default until the Jupiter Prediction flag is enabled'],
      enabledByDefault: false,
    },
    factSpec: {
      readTool: 'solana_jupiter_prediction_search_events',
      capability: 'prediction',
      buildInput: (a: ConnectorFactArgs) => compact({ ...(a.query ? { query: a.query } : {}) }),
      format: (raw) => clampConnectorFacts(stripConnector(raw)),
    },
  },
  // Live swap quote: preview the best-route output (amount, price impact, route) before
  // proposing. Token *prices* / safety still go through get_token_price / get_token_safety.
  {
    connectorId: 'jupiter',
    action: 'swap',
    aliases: ['swap', 'trade', 'exchange', 'convert', 'quote'],
    knowledge: {
      title: 'Jupiter Swap (Ultra / v2)',
      summary: 'Best-route token swaps via Jupiter. Preview a live quote (output amount, price impact, route) with get_connector_facts action=swap, then propose the swap for approval.',
      capabilities: ['preview a swap quote (output amount, price impact, route)', 'prepare a swap for wallet approval'],
      requiredParams: ['inputToken, outputToken, amount (per the input token) for a live quote'],
      constraints: ['Quote preview + execution refresh need a Jupiter API key', 'After previewing, call propose_wallet_action kind=swap to stage it for approval'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_jupiter_order_preview',
      capability: 'swap',
      buildInput: (a: ConnectorFactArgs) => compact({
        ...(a.inputToken ? { inputToken: a.inputToken } : {}),
        ...(a.outputToken ? { outputToken: a.outputToken } : {}),
        ...(a.amount ? { amount: a.amount } : {}),
      }),
      format: formatJupiterSwapQuote,
    },
  },
  // Knowledge-only: a Jupiter "portfolio" is assembled from the lend + borrow position
  // reads above; there is no single cross-product aggregate read in v1.
  {
    connectorId: 'jupiter',
    action: 'portfolio',
    aliases: ['portfolio', 'overview', 'my positions', 'holdings overview', 'everything'],
    knowledge: {
      title: 'Jupiter Portfolio',
      summary: 'Your Jupiter footprint = Earn (lend) positions + Borrow positions. There is no single aggregate read.',
      capabilities: ['assemble from action=lend and action=borrow'],
      requiredParams: ['walletAddress'],
      constraints: ['Call get_connector_facts twice (action=lend, action=borrow) and combine; wallet SOL/SPL balances come from walletBalance context'],
      enabledByDefault: true,
    },
  },
];
