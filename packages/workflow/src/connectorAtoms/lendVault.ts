// Kamino Lend + Drift Vaults connector atoms. Both read via connectorReadFacts capability
// 'positions' (wallet-level, requiresClientKey: false) returning positions[] + totals.
// Kamino positions are lending reserves; Drift positions are strategy-vault deposits.
// NOTE: Drift is deprecated/read-only after the ~$285M April-2026 exploit — reads remain
// for position monitoring, no new deposits.

import type { ConnectorActionAtom, ConnectorFactArgs } from './types.js';
import { asArray, compact, num, obj, shortMint, str } from './util.js';

const walletInput = (a: ConnectorFactArgs) => compact({ ...(a.walletAddress ? { walletAddress: a.walletAddress } : {}) });

// Kamino positions envelope: { positions: KaminoPosition[], totals:{reserves,totalSupplied,totalEarned} }.
export function formatKaminoLend(raw: Record<string, unknown>): Record<string, unknown> {
  const positions = asArray(raw.positions);
  const totals = obj(raw.totals);
  if (!positions.length) {
    return { kind: 'kamino_lend', count: 0, note: 'No Kamino Lend positions for this wallet.' };
  }
  return compact({
    kind: 'kamino_lend',
    count: positions.length,
    totalSupplied: str(totals?.totalSupplied),
    totalEarned: str(totals?.totalEarned),
    positions: positions.slice(0, 8).map((p) => compact({
      asset: str(p.reserveSymbol) ?? shortMint(str(p.reserveMint)),
      supplied: str(p.suppliedAmount),
      value: str(p.currentValue),
      earned: str(p.earnedInterest),
      apy: num(p.supplyApy),
    })),
  });
}

// Drift positions envelope: { positions: DriftVaultDepositor[], totals:{vaultCount,pendingWithdrawCount,totalShares,totalValue} }.
export function formatDriftVault(raw: Record<string, unknown>): Record<string, unknown> {
  const positions = asArray(raw.positions);
  const totals = obj(raw.totals);
  if (!positions.length) {
    return { kind: 'drift_vault', count: 0, note: 'No Drift vault positions for this wallet.' };
  }
  return compact({
    kind: 'drift_vault',
    count: positions.length,
    totalValue: str(totals?.totalValue),
    pendingWithdraws: num(totals?.pendingWithdrawCount),
    positions: positions.slice(0, 8).map((p) => compact({
      vault: shortMint(str(p.vaultAddress)),
      shares: str(p.shares),
      value: str(p.valueAtSharePrice),
      pendingWithdraw: str(p.pendingWithdrawShares) && str(p.pendingWithdrawShares) !== '0' ? str(p.pendingWithdrawShares) : undefined,
      redeemableAt: num(p.redeemableAt),
    })),
  });
}

// Lulo positions envelope: { snapshot: { rows: LuloPositionRow[] } } (Protected/Boost/Regular).
export function formatLuloLend(raw: Record<string, unknown>): Record<string, unknown> {
  const snapshot = obj(raw.snapshot) ?? raw;
  const rows = asArray(snapshot.rows);
  if (!rows.length) {
    return { kind: 'lulo_lend', count: 0, note: 'No Lulo positions for this wallet.' };
  }
  return compact({
    kind: 'lulo_lend',
    count: rows.length,
    positions: rows.slice(0, 8).map((r) => compact({
      asset: str(r.symbol) ?? shortMint(str(r.mintAddress)),
      type: str(r.depositType),
      amount: str(r.amountUi),
      earned: str(r.earnedInterestUi),
      apy: num(r.apy),
      withdrawable: str(r.withdrawableUi),
      pendingWithdrawals: asArray(r.pendingWithdrawals).length || undefined,
    })),
  });
}

export const LEND_VAULT_ATOMS: ConnectorActionAtom[] = [
  {
    connectorId: 'kamino',
    action: 'lend',
    aliases: ['lend', 'supply', 'deposit', 'earn', 'position', 'positions', 'reserve', 'klend', 'withdraw'],
    knowledge: {
      title: 'Kamino Lend',
      summary: 'Supply assets to Kamino Lend reserves to earn yield; read your supplied positions with current value, earned interest, and APY.',
      capabilities: ['read your supplied reserve positions (value, earned interest, APY)', 'inspect reserve markets', 'prepare deposit / withdraw and earnings-proof checks'],
      requiredParams: ['walletAddress for your positions'],
      constraints: [
        'Mainnet-only; live reads need the Kamino (klend) SDK wired into the runtime (otherwise unavailable)',
        'Write actions (deposit / withdraw) are prepare-only and require enabling Kamino in Protocol Connectors',
      ],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_kamino_get_positions',
      capability: 'positions',
      buildInput: walletInput,
      format: formatKaminoLend,
    },
  },
  {
    connectorId: 'drift',
    action: 'vault',
    aliases: ['vault', 'vaults', 'strategy', 'position', 'positions', 'deposit', 'withdraw'],
    knowledge: {
      title: 'Drift Strategy Vaults',
      summary: 'Read your Drift strategy-vault positions: shares, current value, and the withdraw lifecycle (pending request + redeemable time).',
      capabilities: ['read your vault positions (shares, value, pending withdrawals)', 'inspect the vault catalog'],
      requiredParams: ['walletAddress for your positions'],
      constraints: [
        'DEPRECATED / read-only: Drift was exploited (~$285M, April 2026) — no new deposits; reads remain for position monitoring only',
        'Mainnet-only; live reads need the Drift vault SDK wired into the runtime (otherwise unavailable)',
        'V1 does not expose perp trading',
      ],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_drift_wallet_vault_positions',
      capability: 'positions',
      buildInput: walletInput,
      format: formatDriftVault,
    },
  },
  {
    connectorId: 'lulo',
    action: 'lend',
    aliases: ['lend', 'lending', 'supply', 'deposit', 'earn', 'position', 'positions', 'protected', 'boost', 'regular', 'withdraw', 'balance'],
    knowledge: {
      title: 'Lulo Lending',
      summary: 'Supply assets to Lulo (Protected / Boost / Regular) to earn; read your balances per pool type with earned interest, APY, withdrawable amount, and pending withdrawals.',
      capabilities: ['read your Lulo balances (protected/boost/regular) with APY + earned interest', 'inspect live rates + pool metadata', 'prepare deposit / withdraw / complete-withdrawal'],
      requiredParams: ['walletAddress for your positions'],
      constraints: [
        'Live reads need a Lulo API key (LULO_API_KEY) configured in the runtime, otherwise unavailable',
        'Write actions (deposit / withdraw) are prepare-only and require enabling Lulo in Protocol Connectors',
      ],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_lulo_wallet_balances',
      capability: 'positions',
      buildInput: walletInput,
      format: formatLuloLend,
    },
  },
];
