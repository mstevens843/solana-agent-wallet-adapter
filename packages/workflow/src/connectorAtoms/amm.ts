// AMM / concentrated-liquidity connector atoms: Raydium, Orca, Meteora. These are
// first-class on-chain adapters (no project-owned REST API like Jupiter), but they flow
// through the SAME actionService.connectorReadFacts mechanism — capability 'positions'
// reads the wallet's LP positions over RPC (requiresClientKey: false). So the only new
// code is the registry entries + a shared compact projection of the positions envelope.

import type { ConnectorActionAtom, ConnectorFactArgs } from './types.js';
import { asArray, compact, num, obj, shortMint, str } from './util.js';

// A token entry inside tokenAmounts / feesOwed / rewardsOwed: { mint, amount, symbol? }.
function tokenLabel(t: Record<string, unknown>): string | undefined {
  return str(t.symbol) ?? shortMint(str(t.mint));
}

// "SOL/USDC" from the position's tokenAmounts (uniform across all three), falling back to
// the connector-specific mint-pair fields (meteora X/Y, orca A/B) when amounts are absent.
function ammPairLabel(p: Record<string, unknown>): string | undefined {
  const labels = asArray(p.tokenAmounts).map(tokenLabel).filter((x): x is string => !!x);
  if (labels.length) return labels.slice(0, 2).join('/');
  const a = shortMint(str(p.tokenMintX) ?? str(p.tokenMintA));
  const b = shortMint(str(p.tokenMintY) ?? str(p.tokenMintB));
  return a && b ? `${a}/${b}` : (a ?? b);
}

// Compact "1.2 USDC, 0.01 SOL" from a token-amount array; drops zero/empty entries.
function amtSummary(value: unknown): string | undefined {
  const rows = asArray(value)
    .map((t) => {
      const amount = str(t.amount) ?? (num(t.amount) !== undefined ? String(num(t.amount)) : undefined);
      if (!amount || amount === '0') return undefined;
      const sym = str(t.symbol) ?? shortMint(str(t.mint));
      return sym ? `${amount} ${sym}` : amount;
    })
    .filter((x): x is string => !!x);
  return rows.length ? rows.slice(0, 3).join(', ') : undefined;
}

// PURE projection of the connectorReadFacts positions envelope -> a compact LP block.
// Shared by all three AMMs; reads only fields common to their position shapes.
export function formatAmmLiquidity(raw: Record<string, unknown>, connectorId: string): Record<string, unknown> {
  const positions = asArray(raw.positions);
  const totals = obj(raw.totals);
  if (!positions.length) {
    return { kind: `${connectorId}_lp`, count: 0, note: `No ${connectorId} liquidity positions for this wallet.` };
  }
  return compact({
    kind: `${connectorId}_lp`,
    count: positions.length,
    inRange: num(totals?.inRange),
    outOfRange: num(totals?.outOfRange),
    // Raydium-only totals; undefined (dropped) for orca/meteora.
    clmm: num(totals?.clmmPositions),
    cpmm: num(totals?.cpmmPositions),
    farm: num(totals?.farmPositions),
    positions: positions.slice(0, 6).map((p) => compact({
      pair: ammPairLabel(p),
      type: str(p.positionType) ?? str(p.poolType),
      inRange: typeof p.inRange === 'boolean' ? p.inRange : undefined,
      liquidity: str(p.liquidity) ?? str(p.lpAmount),
      fees: amtSummary(p.feesOwed),
      rewards: amtSummary(p.rewardsOwed),
      pool: shortMint(str(p.poolAddress) ?? str(p.whirlpoolAddress) ?? str(p.poolId)),
    })),
  });
}

const walletInput = (a: ConnectorFactArgs) => compact({ ...(a.walletAddress ? { walletAddress: a.walletAddress } : {}) });

export const AMM_ATOMS: ConnectorActionAtom[] = [
  {
    connectorId: 'raydium',
    action: 'liquidity',
    aliases: ['liquidity', 'lp', 'position', 'positions', 'pool', 'clmm', 'cpmm', 'farm'],
    knowledge: {
      title: 'Raydium Liquidity (CPMM / CLMM / Farms)',
      summary: 'Provide liquidity to Raydium CPMM/CLMM pools and stake in farms; read your positions, fees owed, and pending farm rewards.',
      capabilities: ['read your LP positions (CPMM/CLMM) + farm stakes', 'see fees owed, pending rewards, and in-range status', 'prepare add/remove liquidity, fee collect, farm stake/unstake/harvest'],
      requiredParams: ['walletAddress for your positions; a poolId for a single-pool snapshot'],
      constraints: [
        'Mainnet-only; live reads need the Raydium SDK present in the runtime (otherwise unavailable)',
        'Pool snapshots and fee/reward claims need a specific poolId / positionMint',
        'Write actions are prepare-only and require enabling Raydium in Protocol Connectors',
      ],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_raydium_wallet_positions',
      capability: 'positions',
      buildInput: walletInput,
      format: (raw) => formatAmmLiquidity(raw, 'raydium'),
    },
  },
  {
    connectorId: 'orca',
    action: 'liquidity',
    aliases: ['liquidity', 'lp', 'position', 'positions', 'pool', 'whirlpool', 'whirlpools', 'clmm'],
    knowledge: {
      title: 'Orca Whirlpools Liquidity',
      summary: 'Provide concentrated liquidity in Orca Whirlpools; read your positions, fees owed, rewards, and in-range status.',
      capabilities: ['read your Whirlpool positions', 'see fees owed, rewards, and in/out-of-range status', 'prepare increase/decrease liquidity, collect fees, collect rewards'],
      requiredParams: ['walletAddress for your positions; a whirlpoolAddress for a single-pool snapshot'],
      constraints: [
        'Mainnet-only; live reads need the Orca Whirlpools SDK present in the runtime (otherwise unavailable)',
        'Pool snapshots and fee/reward claims need a specific whirlpoolAddress / positionMint',
        'Write actions are prepare-only and require enabling Orca in Protocol Connectors',
      ],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_orca_wallet_positions',
      capability: 'positions',
      buildInput: walletInput,
      format: (raw) => formatAmmLiquidity(raw, 'orca'),
    },
  },
  {
    connectorId: 'meteora',
    action: 'liquidity',
    aliases: ['liquidity', 'lp', 'position', 'positions', 'pool', 'dlmm', 'bin'],
    knowledge: {
      title: 'Meteora DLMM Liquidity',
      summary: 'Provide liquidity to Meteora DLMM (bin-based) pools; read your positions, fees, rewards, and in/out-of-range bins.',
      capabilities: ['read your DLMM positions', 'see fees owed, rewards, and in-range bins', 'prepare add/remove liquidity, claim fees/rewards, close position'],
      requiredParams: ['walletAddress for your positions; a poolAddress for a single-pool snapshot'],
      constraints: [
        'Mainnet-only; live reads need the Meteora DLMM SDK present in the runtime (otherwise unavailable)',
        'Pool snapshots and fee/reward claims need a specific poolAddress + positionAddress',
        'Some claim / remove-liquidity approvals require multiple sequential wallet signatures; write actions require enabling Meteora in Protocol Connectors',
      ],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_meteora_wallet_positions',
      capability: 'positions',
      buildInput: walletInput,
      format: (raw) => formatAmmLiquidity(raw, 'meteora'),
    },
  },
];
