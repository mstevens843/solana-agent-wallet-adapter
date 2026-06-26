// Wormhole (bridge) + Pyth (oracle) connector atoms. Wormhole 'positions' returns the
// wallet's bridge exposure snapshot; Pyth 'oracle' returns symbol-scoped price evidence
// (NOT wallet-scoped — it reads a feed, not a wallet). Both requiresClientKey: false
// (Wormhole = RPC + SDK; Pyth = public Hermes API).

import type { ConnectorActionAtom, ConnectorFactArgs } from './types.js';
import { asArray, compact, num, obj, shortMint, str } from './util.js';

// Wormhole positions envelope: { snapshot: WormholeWalletBridgeExposure }.
export function formatWormholeBridge(raw: Record<string, unknown>): Record<string, unknown> {
  const snapshot = obj(raw.snapshot) ?? raw;
  const pending = asArray(snapshot.pendingTransfers);
  const recent = asArray(snapshot.recentTransfers);
  const transfer = (t: Record<string, unknown>) => compact({
    to: str(t.destinationChain),
    state: str(t.state),
    redeemed: typeof t.redeemed === 'boolean' ? t.redeemed : undefined,
    nextAction: str(t.nextAction),
    token: str(t.destinationToken),
  });
  if (!pending.length && !recent.length) {
    return compact({ kind: 'wormhole_bridge', sourceChain: str(snapshot.sourceChain), note: 'No bridge transfers for this wallet.' });
  }
  return compact({
    kind: 'wormhole_bridge',
    sourceChain: str(snapshot.sourceChain),
    pendingCount: pending.length || undefined,
    pending: pending.length ? pending.slice(0, 5).map(transfer) : undefined,
    recentCount: recent.length || undefined,
    recent: recent.length ? recent.slice(0, 3).map(transfer) : undefined,
  });
}

// Pyth envelope: { evidence: PythOracleEvidence } (oracle) or { snapshot: PythPriceSnapshot } (markets).
export function formatPythOracle(raw: Record<string, unknown>): Record<string, unknown> {
  const e = obj(raw.evidence) ?? obj(raw.snapshot);
  if (!e) return { kind: 'pyth_oracle', note: 'No Pyth feed resolved; provide a symbol (e.g. SOL).' };
  return compact({
    kind: 'pyth_oracle',
    symbol: str(e.symbol) ?? str(e.displayName),
    price: str(e.priceUi),
    confidence: str(e.confidenceUi),
    confidenceBps: num(e.confidenceBps),
    ageSeconds: num(e.ageSeconds),
    status: str(e.status),
  });
}

export const BRIDGE_ORACLE_ATOMS: ConnectorActionAtom[] = [
  {
    connectorId: 'wormhole',
    action: 'bridge',
    aliases: ['bridge', 'bridges', 'transfer', 'transfers', 'exposure', 'redeem', 'portal', 'cross-chain', 'crosschain', 'pending', 'position', 'positions'],
    knowledge: {
      title: 'Wormhole Bridge',
      summary: "Read your Wormhole bridge exposure — pending and recent cross-chain transfers with their state, redeem status, and next action.",
      capabilities: ['read your bridge exposure (pending/recent transfers, redeem status, next action)', 'inspect supported routes + token snapshots', 'prepare Solana-source transfers, redeem on Solana, recover/resume'],
      requiredParams: ['walletAddress for your bridge exposure'],
      constraints: [
        'Live reads need the Wormhole SDK present in the runtime (otherwise unavailable)',
        'Write actions (bridge transfer, redeem, recover/resume) are prepare-only and require enabling Wormhole in Protocol Connectors',
      ],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_wormhole_wallet_bridge_exposure',
      capability: 'positions',
      buildInput: (a: ConnectorFactArgs) => compact({ ...(a.walletAddress ? { walletAddress: a.walletAddress } : {}) }),
      format: formatWormholeBridge,
    },
  },
  {
    connectorId: 'pyth',
    action: 'oracle',
    aliases: ['oracle', 'price', 'price feed', 'feed', 'confidence', 'pyth', 'staleness'],
    knowledge: {
      title: 'Pyth Oracle',
      summary: 'Read the on-chain Pyth oracle price for a symbol: price, confidence interval, age/staleness, and a fresh/stale/wide-confidence status.',
      capabilities: ['read oracle price + confidence + freshness for a symbol', 'feed search + batch reads + on-chain price-update account reads'],
      requiredParams: ['a symbol (e.g. SOL, BTC) or feed id via query'],
      constraints: [
        'Read-only market data via the public Pyth Hermes API (not wallet-scoped)',
        'Posting an on-chain price update is a separate prepare path (needs the Pyth Solana receiver SDK)',
      ],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_pyth_oracle_evidence',
      capability: 'oracle',
      buildInput: (a: ConnectorFactArgs) => compact({ ...(a.query ? { symbol: a.query } : a.mint ? { symbol: a.mint } : {}) }),
      format: formatPythOracle,
    },
  },
];
