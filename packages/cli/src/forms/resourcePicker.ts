import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest, tryBridgeRequest } from '../http/index.js';
import { select, input, spinner, badge } from '../tui/index.js';

// Per (connectorId:fieldName), how to fetch the catalog and shape a picker row.
// Falls back to text input when no entry is registered, the fetch fails, or
// the response is empty.
interface PickerSpec {
  capability: string;
  responsePath: string[];
  valueKey: string;
  labelFn: (row: Record<string, unknown>) => string;
  detailFn?: (row: Record<string, unknown>) => string | undefined;
  needsWallet?: boolean;
  extraParams?: Record<string, unknown>;
  // For wormhole-style fields the catalog is hardcoded; skip the fetch.
  staticChoices?: Array<{ value: string; name: string; description?: string }>;
}

const get = (row: Record<string, unknown>, key: string): unknown => row[key];
const str = (row: Record<string, unknown>, key: string): string | undefined => {
  const v = row[key];
  return typeof v === 'string' && v ? v : undefined;
};

const RESOURCE_PICKERS: Record<string, PickerSpec> = {
  // ─── Drift ────────────────────────────────────────────────────────────────
  'drift:vaultAddress': {
    capability: 'markets',
    responsePath: ['snapshot', 'vaults'],
    valueKey: 'vaultAddress',
    labelFn: (r) => str(r, 'name') ?? (str(r, 'vaultAddress')?.slice(0, 12)) ?? '?',
    detailFn: (r) => [str(r, 'manager'), str(r, 'depositSymbol'), r.apy ? `APY ${r.apy}` : null].filter(Boolean).join('  ·  '),
  },

  // ─── Meteora ──────────────────────────────────────────────────────────────
  'meteora:poolAddress': {
    capability: 'markets',
    responsePath: ['snapshot', 'pools'],
    valueKey: 'poolAddress',
    labelFn: (r) => str(r, 'name') ?? ((`${str(r, 'tokenXSymbol') ?? ''}/${str(r, 'tokenYSymbol') ?? ''}`.replace(/^\/|\/$/g, '')) || str(r, 'poolAddress')?.slice(0, 12) || '?'),
  },
  'meteora:positionAddress': {
    capability: 'positions',
    responsePath: ['positions'],
    valueKey: 'positionAddress',
    labelFn: (r) => `${str(r, 'positionAddress')?.slice(0, 12) ?? '?'}  in  ${str(r, 'poolAddress')?.slice(0, 8) ?? '?'}`,
    needsWallet: true,
  },

  // ─── Orca ─────────────────────────────────────────────────────────────────
  'orca:whirlpoolAddress': {
    capability: 'markets',
    responsePath: ['snapshot', 'whirlpools'],
    valueKey: 'whirlpoolAddress',
    labelFn: (r) => str(r, 'name') ?? ((`${str(r, 'tokenASymbol') ?? ''}/${str(r, 'tokenBSymbol') ?? ''}`.replace(/^\/|\/$/g, '')) || str(r, 'whirlpoolAddress')?.slice(0, 12) || '?'),
  },
  'orca:positionMint': {
    capability: 'positions',
    responsePath: ['positions'],
    valueKey: 'positionMint',
    labelFn: (r) => `${str(r, 'positionMint')?.slice(0, 12) ?? '?'}  ${str(r, 'whirlpoolAddress')?.slice(0, 8) ?? ''}`,
    needsWallet: true,
  },

  // ─── Raydium ──────────────────────────────────────────────────────────────
  'raydium:poolId': {
    capability: 'markets',
    responsePath: ['snapshot', 'cpmm'], // also try clmm via secondary path; simple version covers cpmm
    valueKey: 'poolId',
    labelFn: (r) => {
      const named = str(r, 'name');
      if (named) return named;
      const a = str(r, 'tokenAMint');
      const b = str(r, 'tokenBMint');
      if (a && b) return `${a.slice(0, 8)}/${b.slice(0, 8)}`;
      return str(r, 'poolId')?.slice(0, 12) ?? '?';
    },
  },
  'raydium:positionMint': {
    capability: 'positions',
    responsePath: ['positions'],
    valueKey: 'positionMint',
    labelFn: (r) => `${str(r, 'positionMint')?.slice(0, 12) ?? '?'}  pool ${str(r, 'poolId')?.slice(0, 8) ?? '?'}`,
    needsWallet: true,
  },

  // ─── Marinade ─────────────────────────────────────────────────────────────
  'marinade:ticketAccount': {
    capability: 'positions',
    responsePath: ['positions', 'tickets'],
    valueKey: 'ticketAccount',
    labelFn: (r) => `${str(r, 'ticketAccount')?.slice(0, 12) ?? '?'}  ${r.amount ?? ''} SOL`,
    detailFn: (r) => r.ready ? badge('claimable', 'ok') : badge(`waiting until ${str(r, 'redeemableAt') ?? '?'}`, 'warn'),
    needsWallet: true,
  },

  // ─── Jito ─────────────────────────────────────────────────────────────────
  'jito:stakeAccount': {
    capability: 'positions',
    responsePath: ['stakeAccounts'],
    valueKey: 'stakeAccount',
    labelFn: (r) => `${str(r, 'stakeAccount')?.slice(0, 12) ?? '?'}  ${r.activeStake ?? r.balance ?? ''} SOL`,
    needsWallet: true,
    extraParams: { includeStakeAccounts: true },
  },
  'jito:receiptAddress': {
    capability: 'positions',
    responsePath: ['receipts'],
    valueKey: 'receiptAddress',
    labelFn: (r) => `${str(r, 'receiptAddress')?.slice(0, 12) ?? '?'}  ${r.jitoSolAmount ?? ''} JitoSOL`,
    detailFn: (r) => r.claimable ? badge('claimable', 'ok') : badge(String(r.status ?? '—'), 'muted'),
    needsWallet: true,
    extraParams: { claimableOnly: true },
  },

  // ─── MarginFi / Project0 / Save / Sanctum / Kamino ────────────────────────
  'marginfi:bankAddress': {
    capability: 'markets',
    responsePath: ['snapshot', 'banks'],
    valueKey: 'bankAddress',
    labelFn: (r) => `${str(r, 'bankSymbol') ?? str(r, 'symbol') ?? '?'}  ${str(r, 'bankAddress')?.slice(0, 10) ?? ''}`,
    detailFn: (r) => r.depositApy ? `APY ${r.depositApy}` : undefined,
  },
  'marginfi:bankMint': {
    capability: 'markets',
    responsePath: ['snapshot', 'banks'],
    valueKey: 'bankMint',
    labelFn: (r) => `${str(r, 'bankSymbol') ?? str(r, 'symbol') ?? '?'}`,
  },
  'project0:bankAddress': {
    capability: 'markets',
    responsePath: ['snapshot', 'banks'],
    valueKey: 'bankAddress',
    labelFn: (r) => `${str(r, 'symbol') ?? '?'}  ${str(r, 'bankAddress')?.slice(0, 10) ?? ''}`,
  },
  'project0:bankMint': {
    capability: 'markets',
    responsePath: ['snapshot', 'banks'],
    valueKey: 'bankMint',
    labelFn: (r) => `${str(r, 'symbol') ?? '?'}`,
  },
  'save:reserveMint': {
    capability: 'markets',
    responsePath: ['snapshot', 'reserves'],
    valueKey: 'reserveMint',
    labelFn: (r) => str(r, 'symbol') ?? str(r, 'reserveMint')?.slice(0, 12) ?? '?',
    detailFn: (r) => r.supplyApy ? `Supply APY ${r.supplyApy}` : undefined,
  },
  'kamino:reserveMint': {
    capability: 'markets',
    responsePath: ['snapshot', 'reserves'],
    valueKey: 'reserveMint',
    labelFn: (r) => str(r, 'symbol') ?? str(r, 'reserveMint')?.slice(0, 12) ?? '?',
  },
  'sanctum:lstMint': {
    capability: 'markets',
    responsePath: ['snapshot', 'lsts'],
    valueKey: 'mint',
    labelFn: (r) => `${str(r, 'symbol') ?? '?'}  ${str(r, 'mint')?.slice(0, 10) ?? ''}`,
    detailFn: (r) => r.apy ? `APY ${r.apy}` : undefined,
  },
  'sanctum:inputMint': {
    capability: 'markets',
    responsePath: ['snapshot', 'lsts'],
    valueKey: 'mint',
    labelFn: (r) => `${str(r, 'symbol') ?? '?'}`,
  },
  'sanctum:outputMint': {
    capability: 'markets',
    responsePath: ['snapshot', 'lsts'],
    valueKey: 'mint',
    labelFn: (r) => `${str(r, 'symbol') ?? '?'}`,
  },

  // ─── Squads ───────────────────────────────────────────────────────────────
  'squads:multisigAddress': {
    capability: 'positions',
    responsePath: ['multisigs'],
    valueKey: 'multisigAddress',
    labelFn: (r) => `${str(r, 'name') ?? '?'}  (${r.memberCount ?? '?'} members · threshold ${r.threshold ?? '?'})`,
    needsWallet: true,
  },
  'squads:proposalAddress': {
    capability: 'positions',
    responsePath: ['proposals'],
    valueKey: 'proposalAddress',
    labelFn: (r) => `${str(r, 'name') ?? str(r, 'proposalAddress')?.slice(0, 12) ?? '?'}  [${str(r, 'status') ?? '?'}]`,
    needsWallet: true,
  },

  // ─── Realms ───────────────────────────────────────────────────────────────
  'realms:realmAddress': {
    capability: 'positions',
    responsePath: ['realms'],
    valueKey: 'realmAddress',
    labelFn: (r) => str(r, 'name') ?? str(r, 'realmAddress')?.slice(0, 12) ?? '?',
    needsWallet: true,
  },
  'realms:proposalAddress': {
    capability: 'markets',
    responsePath: ['proposals'],
    valueKey: 'proposalAddress',
    labelFn: (r) => `${str(r, 'name') ?? str(r, 'proposalAddress')?.slice(0, 12) ?? '?'}  [${str(r, 'status') ?? '?'}]`,
  },
  'realms:governingTokenMint': {
    capability: 'markets',
    responsePath: ['tokens'],
    valueKey: 'governingTokenMint',
    labelFn: (r) => `${str(r, 'kind') ?? ''}  ${str(r, 'role') ?? ''}  ${str(r, 'governingTokenMint')?.slice(0, 10) ?? '?'}`,
  },

  // ─── Phoenix ──────────────────────────────────────────────────────────────
  'phoenix:symbol': {
    capability: 'markets',
    responsePath: ['markets'],
    valueKey: 'symbol',
    labelFn: (r) => `${str(r, 'symbol') ?? '?'}  mark ${r.markPrice ?? '?'}`,
    detailFn: (r) => r.fundingRate ? `funding ${r.fundingRate}` : undefined,
  },
  'phoenix:orderId': {
    capability: 'positions',
    responsePath: ['orders'],
    valueKey: 'orderId',
    labelFn: (r) => `${str(r, 'orderId')?.slice(0, 12) ?? '?'}  ${str(r, 'symbol') ?? ''}  ${str(r, 'side') ?? ''}`,
    needsWallet: true,
  },

  // ─── Pyth ─────────────────────────────────────────────────────────────────
  'pyth:priceFeedIds': {
    capability: 'markets',
    responsePath: ['snapshot', 'feeds'],
    valueKey: 'feedId',
    labelFn: (r) => `${str(r, 'symbol') ?? '?'}  ${str(r, 'feedId')?.slice(0, 16) ?? ''}`,
    detailFn: (r) => str(r, 'description'),
  },

  // ─── Jupiter ──────────────────────────────────────────────────────────────
  'jupiter:assetMint': {
    capability: 'earn',
    responsePath: ['snapshot', 'tokens'],
    valueKey: 'mint',
    labelFn: (r) => `${str(r, 'symbol') ?? '?'}  APY ${r.apy ?? '?'}`,
  },
  'jupiter:vaultId': {
    capability: 'borrow',
    responsePath: ['snapshot', 'vaults'],
    valueKey: 'vaultId',
    labelFn: (r) => `${str(r, 'supplySymbol') ?? '?'} → ${str(r, 'borrowSymbol') ?? '?'}  collateral ${str(r, 'collateralSymbol') ?? '?'}`,
  },

  // ─── Wormhole ─────────────────────────────────────────────────────────────
  'wormhole:destinationChain': {
    capability: '',
    responsePath: [],
    valueKey: 'value',
    labelFn: (r) => str(r, 'name') ?? '?',
    staticChoices: [
      { value: 'Solana',     name: 'Solana' },
      { value: 'Ethereum',   name: 'Ethereum' },
      { value: 'Polygon',    name: 'Polygon' },
      { value: 'Arbitrum',   name: 'Arbitrum' },
      { value: 'Optimism',   name: 'Optimism' },
      { value: 'Base',       name: 'Base' },
      { value: 'Avalanche',  name: 'Avalanche' },
      { value: 'Bsc',        name: 'BNB Smart Chain' },
      { value: 'Sui',        name: 'Sui' },
      { value: 'Aptos',      name: 'Aptos' },
      { value: 'Scroll',     name: 'Scroll' },
      { value: 'Linea',      name: 'Linea' },
      { value: 'Mantle',     name: 'Mantle' },
      { value: 'Bsquared',   name: 'Bsquared' },
      { value: 'Berachain',  name: 'Berachain' },
      { value: 'Blast',      name: 'Blast' },
      { value: 'Sei',        name: 'Sei' },
      { value: 'Worldchain', name: 'Worldchain' },
      { value: 'Xlayer',     name: 'X Layer' },
      { value: 'Unichain',   name: 'Unichain' },
      { value: 'Celo',       name: 'Celo' },
      { value: 'Fantom',     name: 'Fantom' },
    ],
  },
};

export interface PickRequest {
  options: GlobalOptions;
  connectorId: string;
  fieldName: string;
  label: string;
  required: boolean;
}

// Returns the picked value (string), '' for "skip optional", or null when no
// picker is registered. Caller falls through to a plain text prompt when null.
export async function tryResourcePick(req: PickRequest): Promise<string | null> {
  const key = `${req.connectorId}:${req.fieldName}`;
  const spec = RESOURCE_PICKERS[key];
  if (!spec) return null;

  let choices: Array<{ value: string; name: string; description?: string }> = [];
  if (spec.staticChoices) {
    choices = spec.staticChoices;
  } else {
    choices = await fetchChoices(req.options, req.connectorId, spec);
    if (choices.length === 0) {
      // Catalog empty or unreachable — fall through to plain text input so the
      // user can still paste an address by hand.
      console.log(badge(`No catalog rows returned for ${req.fieldName}; falling back to manual entry.`, 'muted'));
      return null;
    }
  }

  const PASTE = '__paste__';
  const SKIP  = '__skip__';
  const finalChoices: typeof choices = [...choices];
  finalChoices.push({ value: PASTE, name: 'Other — paste address / mint manually' });
  if (!req.required) finalChoices.push({ value: SKIP, name: 'Skip (leave blank)' });

  const picked = await select<string>({
    message: req.label,
    pageSize: Math.min(20, finalChoices.length + 1),
    choices: finalChoices,
  });

  if (picked === SKIP) return '';
  if (picked === PASTE) {
    const raw = await input({
      message: `Paste a value for ${req.fieldName}`,
      validate: (v) => {
        if (!v.trim() && req.required) return 'Required field.';
        return true;
      },
    });
    return raw.trim();
  }
  return picked;
}

async function fetchChoices(
  options: GlobalOptions,
  connectorId: string,
  spec: PickerSpec,
): Promise<Array<{ value: string; name: string; description?: string }>> {
  const spin = spinner(`Fetching ${connectorId} ${spec.capability}…`);
  try {
    const walletAddress = spec.needsWallet ? await fetchWallet(options) : undefined;
    const body: Record<string, unknown> = { connectorId, capability: spec.capability, ...(spec.extraParams ?? {}) };
    if (walletAddress) body.walletAddress = walletAddress;
    const raw = await bridgeRequest<Record<string, unknown>>(options, '/bridge/action/connector-read-facts', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    spin.stop();
    const rows = walkPath(raw, spec.responsePath);
    if (!Array.isArray(rows) || rows.length === 0) return [];
    return rows
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
      .map((r) => {
        const value = String(get(r, spec.valueKey) ?? '');
        if (!value) return null;
        const name = spec.labelFn(r) || value;
        const description = spec.detailFn?.(r);
        return description ? { value, name, description } : { value, name };
      })
      .filter((c): c is { value: string; name: string; description?: string } => c !== null);
  } catch (err) {
    spin.fail(`Picker fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function walkPath(raw: unknown, path: string[]): unknown {
  let cursor: unknown = raw;
  for (const segment of path) {
    if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

async function fetchWallet(options: GlobalOptions): Promise<string | undefined> {
  const status = await tryBridgeRequest<{ connected?: boolean; address?: string }>(options, '/bridge/action/status');
  if (status.ok && status.value.connected && status.value.address) return status.value.address;
  return undefined;
}
