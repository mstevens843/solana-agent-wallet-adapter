import type { ProtocolConnectorId } from './connectedDapps.js';

export interface ConnectorOptionMeta {
  apy?: string;
  tvl?: string;
  balance?: string;
  symbol?: string;
  market?: string;
}

export interface ConnectorOption {
  value: string;
  label: string;
  detail?: string;
  group?: 'positions' | 'all';
  meta?: ConnectorOptionMeta;
}

export interface ConnectorOptionBridgeFetch {
  <T = unknown>(path: string, init?: RequestInit): Promise<T>;
}

export interface ConnectorOptionProviderContext {
  fieldValues: Record<string, string>;
  walletAddress?: string;
  cluster: string;
  bridge: ConnectorOptionBridgeFetch;
}

export interface ConnectorOptionProvider {
  id: string;
  connectorId: ProtocolConnectorId | string;
  ttlMs: number;
  fetch(ctx: ConnectorOptionProviderContext): Promise<ConnectorOption[]>;
}

const PROVIDERS: Record<string, ConnectorOptionProvider> = {};

export function registerConnectorOptionProvider(provider: ConnectorOptionProvider): void {
  if (PROVIDERS[provider.id]) {
    throw new Error(`Connector option provider already registered: ${provider.id}`);
  }
  PROVIDERS[provider.id] = provider;
}

export function getConnectorOptionProvider(providerId: string): ConnectorOptionProvider | undefined {
  return PROVIDERS[providerId];
}

export function listConnectorOptionProviders(): ConnectorOptionProvider[] {
  return Object.values(PROVIDERS);
}

export function clearConnectorOptionProvidersForTests(): void {
  for (const key of Object.keys(PROVIDERS)) delete PROVIDERS[key];
}

export function connectorOptionCacheKey(
  providerId: string,
  dependsOn: readonly string[],
  fieldValues: Record<string, string>,
  walletAddress: string | undefined,
  cluster: string,
): string {
  const depKey = dependsOn
    .slice()
    .sort()
    .map((id) => `${id}=${fieldValues[id] ?? ''}`)
    .join('|');
  return `${providerId}::${depKey}::${walletAddress ?? ''}::${cluster}`;
}

export function dependenciesSatisfied(
  dependsOn: readonly string[],
  fieldValues: Record<string, string>,
): boolean {
  return dependsOn.every((id) => Boolean(fieldValues[id]?.trim()));
}

export function missingDependencyLabel(
  dependsOn: readonly string[],
  fieldValues: Record<string, string>,
): string | undefined {
  for (const id of dependsOn) {
    if (!fieldValues[id]?.trim()) return id;
  }
  return undefined;
}

interface BridgeFactsResponse {
  capability?: string;
  snapshot?: Record<string, unknown>;
  positions?: Array<Record<string, unknown>>;
  walletAddress?: string;
  totals?: Record<string, unknown>;
}

async function safeBridgeFacts(
  bridge: ConnectorOptionBridgeFetch,
  body: Record<string, unknown>,
): Promise<BridgeFactsResponse | null> {
  try {
    return await bridge<BridgeFactsResponse>('/bridge/action/connector-read-facts', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

// Kamino reserves that resolve deterministically through the first-class adapter's
// `resolveKnownReserve(symbol)` — each maps to a single on-chain reserve in Kamino
// Lend's Main Market (program KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD, market
// 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF). The detail line names the market
// explicitly so the user sees exactly which on-chain pool the deposit targets.
const KAMINO_COMMON_RESERVES: Array<{ symbol: string; description: string }> = [
  { symbol: 'USDC', description: 'USDC reserve · Kamino Lend Main Market' },
  { symbol: 'SOL', description: 'SOL reserve · Kamino Lend Main Market' },
  { symbol: 'JitoSOL', description: 'JitoSOL reserve · Kamino Lend Main Market' },
  { symbol: 'mSOL', description: 'mSOL reserve · Kamino Lend Main Market' },
  { symbol: 'bSOL', description: 'bSOL reserve · Kamino Lend Main Market' },
];

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const kaminoReserveProvider: ConnectorOptionProvider = {
  id: 'kamino.reserve',
  connectorId: 'kamino',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    const positionsResp = walletAddress
      ? await safeBridgeFacts(bridge, { connectorId: 'kamino', capability: 'positions', walletAddress })
      : null;
    const seen = new Set<string>();
    const positionOptions: ConnectorOption[] = [];
    for (const position of positionsResp?.positions ?? []) {
      const symbol = asString(position.reserveSymbol) ?? asString(position.symbol);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      const market = asString(position.marketName) ?? asString(position.market) ?? 'Main Market';
      const supplied = asString(position.suppliedAmount);
      const earned = asString(position.earnedInterest);
      const apy = asString(position.supplyApy);
      const details: string[] = [];
      if (supplied) details.push(`Your supply ${supplied}`);
      if (apy) details.push(`APY ${apy}`);
      if (earned) details.push(`Earned ${earned}`);
      details.push(`Kamino Lend · ${market}`);
      positionOptions.push({
        value: symbol,
        label: `${symbol} reserve · ${market}`,
        detail: details.join(' · '),
        group: 'positions',
        meta: { symbol, apy, balance: supplied, market },
      });
    }
    const catalog: ConnectorOption[] = KAMINO_COMMON_RESERVES
      .filter((entry) => !seen.has(entry.symbol))
      .map((entry) => ({
        value: entry.symbol,
        label: `${entry.symbol} reserve · Main Market`,
        detail: entry.description,
        group: 'all',
        meta: { symbol: entry.symbol, market: 'Main Market' },
      }));
    return [...positionOptions, ...catalog];
  },
};

const JUPITER_LEND_EARN_DEFAULTS: Array<{ symbol: string; mint?: string; description: string }> = [
  { symbol: 'USDC', description: 'USD stablecoin earn pool' },
  { symbol: 'USDT', description: 'USDT stablecoin earn pool' },
  { symbol: 'SOL', description: 'Native SOL earn pool' },
  { symbol: 'JLP', description: 'Jupiter LP earn pool' },
];

function jupiterFactList(resp: BridgeFactsResponse | null): Array<Record<string, unknown>> {
  if (!resp) return [];
  const factsArray = (resp as Record<string, unknown>).facts;
  if (Array.isArray(factsArray)) return factsArray as Array<Record<string, unknown>>;
  const snapshot = resp.snapshot;
  if (snapshot && Array.isArray((snapshot as Record<string, unknown>).tokens)) {
    return (snapshot as { tokens: Array<Record<string, unknown>> }).tokens;
  }
  if (snapshot && Array.isArray((snapshot as Record<string, unknown>).vaults)) {
    return (snapshot as { vaults: Array<Record<string, unknown>> }).vaults;
  }
  return [];
}

const jupiterLendEarnAssetProvider: ConnectorOptionProvider = {
  id: 'jupiter.lend.earn.asset',
  connectorId: 'jupiter',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    const positionsResp = walletAddress
      ? await safeBridgeFacts(bridge, {
        connectorId: 'jupiter',
        capability: 'earn',
        walletAddress,
      })
      : null;
    const tokensResp = await safeBridgeFacts(bridge, {
      connectorId: 'jupiter',
      capability: 'earn',
    });
    const seen = new Set<string>();
    const positions: ConnectorOption[] = [];
    for (const entry of jupiterFactList(positionsResp)) {
      const symbol = asString(entry.assetSymbol) ?? asString(entry.symbol);
      const mint = asString(entry.assetMint) ?? asString(entry.mint);
      const value = mint ?? symbol;
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const balance = asString(entry.balance) ?? asString(entry.supplied);
      const apy = asString(entry.apy) ?? asString(entry.supplyApy);
      positions.push({
        value,
        label: symbol ? `${symbol} earn pool` : `Earn pool ${value.slice(0, 6)}…`,
        detail: [balance ? `Your supply ${balance}` : '', apy ? `APY ${apy}` : '']
          .filter(Boolean)
          .join(' · '),
        group: 'positions',
        meta: { symbol, apy, balance },
      });
    }
    const all: ConnectorOption[] = [];
    for (const entry of jupiterFactList(tokensResp)) {
      const symbol = asString(entry.assetSymbol) ?? asString(entry.symbol);
      const mint = asString(entry.assetMint) ?? asString(entry.mint);
      const value = mint ?? symbol;
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const apy = asString(entry.apy) ?? asString(entry.supplyApy);
      all.push({
        value,
        label: symbol ? `${symbol} earn pool` : `Earn pool ${value.slice(0, 6)}…`,
        detail: apy ? `APY ${apy}` : 'Jupiter Lend earn pool',
        group: 'all',
        meta: { symbol, apy },
      });
    }
    if (all.length === 0) {
      for (const fallback of JUPITER_LEND_EARN_DEFAULTS) {
        if (seen.has(fallback.symbol)) continue;
        all.push({
          value: fallback.symbol,
          label: `${fallback.symbol} earn pool`,
          detail: fallback.description,
          group: 'all',
          meta: { symbol: fallback.symbol },
        });
      }
    }
    return [...positions, ...all];
  },
};

const jupiterLendBorrowVaultProvider: ConnectorOptionProvider = {
  id: 'jupiter.lend.borrow.vault',
  connectorId: 'jupiter',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    const positionsResp = walletAddress
      ? await safeBridgeFacts(bridge, {
        connectorId: 'jupiter',
        capability: 'borrow',
        walletAddress,
      })
      : null;
    const vaultsResp = await safeBridgeFacts(bridge, {
      connectorId: 'jupiter',
      capability: 'borrow',
    });
    const seen = new Set<string>();
    const positions: ConnectorOption[] = [];
    for (const entry of jupiterFactList(positionsResp)) {
      const vaultId = asString(entry.vaultId) ?? asString(entry.id);
      if (!vaultId || seen.has(vaultId)) continue;
      seen.add(vaultId);
      const supplySymbol = asString(entry.supplySymbol) ?? asString(entry.collateralSymbol) ?? asString(entry.symbol);
      const borrowSymbol = asString(entry.borrowSymbol);
      const labelPair = supplySymbol && borrowSymbol
        ? `${supplySymbol} → ${borrowSymbol}`
        : supplySymbol ?? `Vault ${vaultId.slice(0, 6)}…`;
      positions.push({
        value: vaultId,
        label: `${labelPair} vault`,
        detail: 'Has open position in this vault',
        group: 'positions',
        meta: { symbol: supplySymbol },
      });
    }
    const all: ConnectorOption[] = [];
    for (const entry of jupiterFactList(vaultsResp)) {
      const vaultId = asString(entry.vaultId) ?? asString(entry.id);
      if (!vaultId || seen.has(vaultId)) continue;
      seen.add(vaultId);
      const supplySymbol = asString(entry.supplySymbol) ?? asString(entry.collateralSymbol) ?? asString(entry.symbol);
      const borrowSymbol = asString(entry.borrowSymbol);
      const labelPair = supplySymbol && borrowSymbol
        ? `${supplySymbol} → ${borrowSymbol}`
        : supplySymbol ?? `Vault ${vaultId.slice(0, 6)}…`;
      all.push({
        value: vaultId,
        label: `${labelPair} vault`,
        detail: 'Jupiter Lend borrow vault',
        group: 'all',
      });
    }
    return [...positions, ...all];
  },
};

const jupiterLendBorrowPositionProvider: ConnectorOptionProvider = {
  id: 'jupiter.lend.borrow.position',
  connectorId: 'jupiter',
  ttlMs: 60_000,
  async fetch({ fieldValues, walletAddress, bridge }) {
    if (!walletAddress) return [];
    const vaultId = fieldValues.vaultId?.trim();
    const resp = await safeBridgeFacts(bridge, {
      connectorId: 'jupiter',
      capability: 'borrow',
      walletAddress,
      ...(vaultId ? { vaultId } : {}),
    });
    const out: ConnectorOption[] = [];
    for (const entry of jupiterFactList(resp)) {
      const positionId = asString(entry.positionId) ?? asString(entry.id);
      if (!positionId) continue;
      if (vaultId && asString(entry.vaultId) && entry.vaultId !== vaultId) continue;
      const collateral = asString(entry.collateralAmount) ?? asString(entry.collateral);
      const debt = asString(entry.borrowAmount) ?? asString(entry.debt);
      out.push({
        value: positionId,
        label: `Position ${positionId.slice(0, 6)}…`,
        detail: [collateral ? `Collateral ${collateral}` : '', debt ? `Debt ${debt}` : '']
          .filter(Boolean)
          .join(' · '),
        group: 'positions',
      });
    }
    return out;
  },
};

const MARGINFI_COMMON_BANKS: Array<{ symbol: string; description: string }> = [
  { symbol: 'USDC', description: 'USDC bank · main group' },
  { symbol: 'SOL', description: 'SOL bank · main group' },
  { symbol: 'USDT', description: 'USDT bank · main group' },
  { symbol: 'JitoSOL', description: 'JitoSOL bank · main group' },
];

function genericListing(resp: BridgeFactsResponse | null, keys: string[]): Array<Record<string, unknown>> {
  if (!resp) return [];
  const factsArray = (resp as Record<string, unknown>).facts;
  if (Array.isArray(factsArray)) return factsArray as Array<Record<string, unknown>>;
  for (const key of keys) {
    const snapshot = resp.snapshot as Record<string, unknown> | undefined;
    if (snapshot && Array.isArray(snapshot[key])) return snapshot[key] as Array<Record<string, unknown>>;
    if (Array.isArray((resp as Record<string, unknown>)[key])) return (resp as Record<string, unknown>)[key] as Array<Record<string, unknown>>;
  }
  return [];
}

function pickIdentifier(entry: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(entry[key]);
    if (value) return value;
  }
  return undefined;
}

const marginfiBankProvider: ConnectorOptionProvider = {
  id: 'marginfi.bank',
  connectorId: 'marginfi',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    const positionsResp = walletAddress
      ? await safeBridgeFacts(bridge, { connectorId: 'marginfi', capability: 'positions', walletAddress })
      : null;
    const banksResp = await safeBridgeFacts(bridge, { connectorId: 'marginfi', capability: 'markets' });
    const seen = new Set<string>();
    const positions: ConnectorOption[] = [];
    for (const entry of genericListing(positionsResp, ['banks', 'positions', 'accounts'])) {
      const bank = pickIdentifier(entry, ['bankAddress', 'address', 'bankMint', 'mint']);
      if (!bank || seen.has(bank)) continue;
      seen.add(bank);
      const symbol = asString(entry.bankSymbol) ?? asString(entry.symbol);
      positions.push({
        value: bank,
        label: symbol ? `${symbol} bank` : `Bank ${bank.slice(0, 6)}…`,
        detail: 'Open MarginFi position',
        group: 'positions',
        meta: { symbol },
      });
    }
    const banks: ConnectorOption[] = [];
    for (const entry of genericListing(banksResp, ['banks', 'reserves'])) {
      const bank = pickIdentifier(entry, ['bankAddress', 'address', 'bankMint', 'mint']);
      if (!bank || seen.has(bank)) continue;
      seen.add(bank);
      const symbol = asString(entry.bankSymbol) ?? asString(entry.symbol);
      const apy = asString(entry.lendingApy) ?? asString(entry.depositApy) ?? asString(entry.apy);
      banks.push({
        value: bank,
        label: symbol ? `${symbol} bank` : `Bank ${bank.slice(0, 6)}…`,
        detail: apy ? `Lend APY ${apy}` : 'MarginFi bank',
        group: 'all',
        meta: { symbol, apy },
      });
    }
    if (banks.length === 0) {
      for (const fallback of MARGINFI_COMMON_BANKS) {
        if (seen.has(fallback.symbol)) continue;
        banks.push({
          value: fallback.symbol,
          label: `${fallback.symbol} bank`,
          detail: fallback.description,
          group: 'all',
          meta: { symbol: fallback.symbol },
        });
      }
    }
    return [...positions, ...banks];
  },
};

const SAVE_COMMON_RESERVES: Array<{ symbol: string; description: string }> = [
  { symbol: 'USDC', description: 'USDC reserve · main market' },
  { symbol: 'SOL', description: 'SOL reserve · main market' },
  { symbol: 'USDT', description: 'USDT reserve · main market' },
];

const saveReserveProvider: ConnectorOptionProvider = {
  id: 'save.reserve',
  connectorId: 'save',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    const obligationResp = walletAddress
      ? await safeBridgeFacts(bridge, { connectorId: 'save', capability: 'positions', walletAddress })
      : null;
    const reservesResp = await safeBridgeFacts(bridge, { connectorId: 'save', capability: 'markets' });
    const seen = new Set<string>();
    const positions: ConnectorOption[] = [];
    for (const entry of genericListing(obligationResp, ['reserves', 'deposits', 'borrows'])) {
      const reserve = pickIdentifier(entry, ['reserveAddress', 'address', 'reserveMint', 'mint']);
      if (!reserve || seen.has(reserve)) continue;
      seen.add(reserve);
      const symbol = asString(entry.reserveSymbol) ?? asString(entry.symbol);
      positions.push({
        value: reserve,
        label: symbol ? `${symbol} reserve` : `Reserve ${reserve.slice(0, 6)}…`,
        detail: 'Open Save obligation',
        group: 'positions',
        meta: { symbol },
      });
    }
    const reserves: ConnectorOption[] = [];
    for (const entry of genericListing(reservesResp, ['reserves'])) {
      const reserve = pickIdentifier(entry, ['reserveAddress', 'address', 'reserveMint', 'mint']);
      if (!reserve || seen.has(reserve)) continue;
      seen.add(reserve);
      const symbol = asString(entry.reserveSymbol) ?? asString(entry.symbol);
      const apy = asString(entry.lendApy) ?? asString(entry.supplyApy) ?? asString(entry.apy);
      reserves.push({
        value: reserve,
        label: symbol ? `${symbol} reserve` : `Reserve ${reserve.slice(0, 6)}…`,
        detail: apy ? `Supply APY ${apy}` : 'Save reserve',
        group: 'all',
        meta: { symbol, apy },
      });
    }
    if (reserves.length === 0) {
      for (const fallback of SAVE_COMMON_RESERVES) {
        if (seen.has(fallback.symbol)) continue;
        reserves.push({
          value: fallback.symbol,
          label: `${fallback.symbol} reserve`,
          detail: fallback.description,
          group: 'all',
          meta: { symbol: fallback.symbol },
        });
      }
    }
    return [...positions, ...reserves];
  },
};

const driftVaultProvider: ConnectorOptionProvider = {
  id: 'drift.vault',
  connectorId: 'drift',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    const positionsResp = walletAddress
      ? await safeBridgeFacts(bridge, { connectorId: 'drift', capability: 'positions', walletAddress })
      : null;
    const vaultsResp = await safeBridgeFacts(bridge, { connectorId: 'drift', capability: 'markets' });
    const seen = new Set<string>();
    const positions: ConnectorOption[] = [];
    for (const entry of genericListing(positionsResp, ['vaults', 'positions'])) {
      const vault = pickIdentifier(entry, ['vaultAddress', 'address', 'vaultPubkey']);
      if (!vault || seen.has(vault)) continue;
      seen.add(vault);
      const name = asString(entry.name) ?? asString(entry.vaultName);
      const shares = asString(entry.shares) ?? asString(entry.userShares);
      positions.push({
        value: vault,
        label: name ? `${name} vault` : `Vault ${vault.slice(0, 6)}…`,
        detail: shares ? `Your shares ${shares}` : 'Open Drift vault deposit',
        group: 'positions',
        meta: { balance: shares },
      });
    }
    const vaults: ConnectorOption[] = [];
    for (const entry of genericListing(vaultsResp, ['vaults'])) {
      const vault = pickIdentifier(entry, ['vaultAddress', 'address', 'vaultPubkey']);
      if (!vault || seen.has(vault)) continue;
      seen.add(vault);
      const name = asString(entry.name) ?? asString(entry.vaultName);
      const apy = asString(entry.apy) ?? asString(entry.netApy);
      vaults.push({
        value: vault,
        label: name ? `${name} vault` : `Vault ${vault.slice(0, 6)}…`,
        detail: apy ? `Net APY ${apy}` : 'Drift strategy vault',
        group: 'all',
        meta: { apy },
      });
    }
    return [...positions, ...vaults];
  },
};

const LULO_COMMON_MINTS: Array<{ symbol: string; description: string }> = [
  { symbol: 'USDC', description: 'USDC pool · multiple tiers' },
  { symbol: 'USDT', description: 'USDT pool · multiple tiers' },
];

const luloMintProvider: ConnectorOptionProvider = {
  id: 'lulo.mint',
  connectorId: 'lulo',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    const balancesResp = walletAddress
      ? await safeBridgeFacts(bridge, { connectorId: 'lulo', capability: 'positions', walletAddress })
      : null;
    const ratesResp = await safeBridgeFacts(bridge, { connectorId: 'lulo', capability: 'markets' });
    const seen = new Set<string>();
    const positions: ConnectorOption[] = [];
    for (const entry of genericListing(balancesResp, ['balances', 'positions'])) {
      const mint = pickIdentifier(entry, ['mintAddress', 'mint', 'address']);
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      const symbol = asString(entry.symbol);
      const balance = asString(entry.balance) ?? asString(entry.totalBalance);
      positions.push({
        value: mint,
        label: symbol ? `${symbol} pool` : `Pool ${mint.slice(0, 6)}…`,
        detail: balance ? `Your balance ${balance}` : 'Open Lulo balance',
        group: 'positions',
        meta: { symbol, balance },
      });
    }
    const mints: ConnectorOption[] = [];
    for (const entry of genericListing(ratesResp, ['rates', 'pools'])) {
      const mint = pickIdentifier(entry, ['mintAddress', 'mint', 'address']);
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      const symbol = asString(entry.symbol);
      const protectedApy = asString(entry.protectedApy);
      const boostApy = asString(entry.boostApy);
      const regularApy = asString(entry.regularApy);
      const apyDetail = [
        protectedApy ? `Protected ${protectedApy}` : '',
        boostApy ? `Boost ${boostApy}` : '',
        regularApy ? `Regular ${regularApy}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      mints.push({
        value: mint,
        label: symbol ? `${symbol} pool` : `Pool ${mint.slice(0, 6)}…`,
        detail: apyDetail || 'Lulo pool',
        group: 'all',
        meta: { symbol, apy: protectedApy ?? boostApy ?? regularApy },
      });
    }
    if (mints.length === 0) {
      for (const fallback of LULO_COMMON_MINTS) {
        if (seen.has(fallback.symbol)) continue;
        mints.push({
          value: fallback.symbol,
          label: `${fallback.symbol} pool`,
          detail: fallback.description,
          group: 'all',
          meta: { symbol: fallback.symbol },
        });
      }
    }
    return [...positions, ...mints];
  },
};

// Real on-chain Raydium pools (mainnet) — CPMM and CLMM separately, so the dropdown
// always has options even when the bridge facts call fails on production.
const RAYDIUM_CPMM_POOL_CATALOG: Array<{ address: string; name: string; tvl: string }> = [
  { address: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', name: 'SOL-USDC', tvl: '$30M' },
  { address: '7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX', name: 'SOL-USDT', tvl: '$8M' },
  { address: '6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg', name: 'RAY-USDC', tvl: '$4M' },
];
const RAYDIUM_CLMM_POOL_CATALOG: Array<{ address: string; name: string; tvl: string }> = [
  { address: '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', name: 'SOL-USDC 0.04%', tvl: '$22M' },
  { address: '8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj', name: 'SOL-USDC 0.25%', tvl: '$6M' },
  { address: 'AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA', name: 'RAY-SOL 0.25%', tvl: '$3M' },
];

function buildRaydiumPoolProvider(id: string, poolType: 'cpmm' | 'clmm'): ConnectorOptionProvider {
  return {
    id,
    connectorId: 'raydium',
    ttlMs: 60_000,
    async fetch({ walletAddress, bridge }) {
      const positionsResp = walletAddress
        ? await safeBridgeFacts(bridge, {
          connectorId: 'raydium',
          capability: 'positions',
          walletAddress,
        })
        : null;
      const poolsResp = await safeBridgeFacts(bridge, {
        connectorId: 'raydium',
        capability: 'markets',
        poolType,
      });
      const seen = new Set<string>();
      const positions: ConnectorOption[] = [];
      for (const entry of genericListing(positionsResp, ['positions', 'pools'])) {
        const entryType = asString(entry.poolType) ?? asString(entry.type);
        if (entryType && entryType.toLowerCase() !== poolType) continue;
        const pool = pickIdentifier(entry, ['poolId', 'poolAddress', 'address']);
        if (!pool || seen.has(pool)) continue;
        seen.add(pool);
        const symbol = asString(entry.poolName) ?? asString(entry.name);
        positions.push({
          value: pool,
          label: symbol ? `${symbol} ${poolType.toUpperCase()}` : `Pool ${pool.slice(0, 6)}…`,
          detail: 'Open Raydium position',
          group: 'positions',
        });
      }
      const pools: ConnectorOption[] = [];
      for (const entry of genericListing(poolsResp, ['pools'])) {
        const entryType = asString(entry.poolType) ?? asString(entry.type);
        if (entryType && entryType.toLowerCase() !== poolType) continue;
        const pool = pickIdentifier(entry, ['poolId', 'poolAddress', 'address']);
        if (!pool || seen.has(pool)) continue;
        seen.add(pool);
        const symbol = asString(entry.poolName) ?? asString(entry.name);
        const tvl = asString(entry.tvl) ?? asString(entry.tvlUsd);
        pools.push({
          value: pool,
          label: symbol ? `${symbol} ${poolType.toUpperCase()}` : `Pool ${pool.slice(0, 6)}…`,
          detail: tvl ? `TVL $${tvl}` : `Raydium ${poolType.toUpperCase()} pool`,
          group: 'all',
          meta: { tvl },
        });
      }
      if (pools.length === 0) {
        const catalog = poolType === 'cpmm' ? RAYDIUM_CPMM_POOL_CATALOG : RAYDIUM_CLMM_POOL_CATALOG;
        for (const entry of catalog) {
          if (seen.has(entry.address)) continue;
          pools.push({
            value: entry.address,
            label: `${entry.name} ${poolType.toUpperCase()}`,
            detail: `TVL ${entry.tvl} · Raydium ${poolType.toUpperCase()}`,
            group: 'all',
            meta: { tvl: entry.tvl },
          });
        }
      }
      return [...positions, ...pools];
    },
  };
}

const raydiumCpmmPoolProvider = buildRaydiumPoolProvider('raydium.cpmm.pool', 'cpmm');
const raydiumClmmPoolProvider = buildRaydiumPoolProvider('raydium.clmm.pool', 'clmm');

const raydiumPositionProvider: ConnectorOptionProvider = {
  id: 'raydium.position',
  connectorId: 'raydium',
  ttlMs: 60_000,
  async fetch({ fieldValues, walletAddress, bridge }) {
    if (!walletAddress) return [];
    const poolId = fieldValues.poolId?.trim();
    const resp = await safeBridgeFacts(bridge, {
      connectorId: 'raydium',
      capability: 'positions',
      walletAddress,
      ...(poolId ? { poolId } : {}),
    });
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['positions', 'pools'])) {
      const positionMint = pickIdentifier(entry, ['positionMint', 'positionAddress', 'mint']);
      if (!positionMint) continue;
      if (poolId) {
        const entryPool = asString(entry.poolId) ?? asString(entry.poolAddress);
        if (entryPool && entryPool !== poolId) continue;
      }
      const range = asString(entry.range) ?? asString(entry.tickRange);
      out.push({
        value: positionMint,
        label: `Position ${positionMint.slice(0, 6)}…`,
        detail: range ? `Range ${range}` : 'Existing CLMM position',
        group: 'positions',
      });
    }
    return out;
  },
};

const marinadeTicketProvider: ConnectorOptionProvider = {
  id: 'marinade.ticket',
  connectorId: 'marinade',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    if (!walletAddress) return [];
    const resp = await safeBridgeFacts(bridge, { connectorId: 'marinade', capability: 'positions', walletAddress });
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['tickets', 'unstakeTickets', 'positions'])) {
      const ticket = pickIdentifier(entry, ['ticketAccount', 'ticket', 'address']);
      if (!ticket) continue;
      const amount = asString(entry.amount) ?? asString(entry.lamports);
      const ready = asString(entry.ready) ?? asString(entry.status);
      out.push({
        value: ticket,
        label: `Ticket ${ticket.slice(0, 6)}…`,
        detail: [amount ? `${amount} mSOL` : '', ready ? `Status ${ready}` : ''].filter(Boolean).join(' · '),
        group: 'positions',
      });
    }
    return out;
  },
};

const jitoStakeAccountProvider: ConnectorOptionProvider = {
  id: 'jito.stakeAccount',
  connectorId: 'jito',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    if (!walletAddress) return [];
    const resp = await safeBridgeFacts(bridge, {
      connectorId: 'jito',
      capability: 'positions',
      walletAddress,
      includeStakeAccounts: true,
    });
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['stakeAccounts', 'accounts', 'positions'])) {
      const account = pickIdentifier(entry, ['stakeAccount', 'address', 'pubkey']);
      if (!account) continue;
      const stake = asString(entry.balance) ?? asString(entry.activeStake);
      const validator = asString(entry.validator);
      out.push({
        value: account,
        label: `Stake account ${account.slice(0, 6)}…`,
        detail: [stake ? `${stake} SOL` : '', validator ? `Validator ${validator.slice(0, 6)}…` : ''].filter(Boolean).join(' · '),
        group: 'positions',
      });
    }
    return out;
  },
};

const jitoReceiptProvider: ConnectorOptionProvider = {
  id: 'jito.receipt',
  connectorId: 'jito',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    if (!walletAddress) return [];
    const resp = await safeBridgeFacts(bridge, {
      connectorId: 'jito',
      capability: 'positions',
      walletAddress,
      claimableOnly: true,
    });
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['receipts', 'depositReceipts'])) {
      const receipt = pickIdentifier(entry, ['receiptAddress', 'address', 'pubkey']);
      if (!receipt) continue;
      const status = asString(entry.status) ?? asString(entry.claimable);
      out.push({
        value: receipt,
        label: `Receipt ${receipt.slice(0, 6)}…`,
        detail: status ? `Status ${status}` : 'Deposit receipt',
        group: 'positions',
      });
    }
    return out;
  },
};

// Real on-chain mints — Sanctum's prepare expects a mint, not a symbol. Symbol-only
// fallbacks made Approve fail with "inputMint must be a valid Solana mint address."
const SANCTUM_LST_CATALOG: Array<{ symbol: string; mint: string; detail: string }> = [
  { symbol: 'JitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', detail: 'Jito liquid staking' },
  { symbol: 'mSOL', mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', detail: 'Marinade liquid staking' },
  { symbol: 'bSOL', mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', detail: 'BlazeStake liquid staking' },
  { symbol: 'INF', mint: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', detail: 'Sanctum Infinity LST index' },
  { symbol: 'jupSOL', mint: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', detail: 'Jupiter LST' },
];

const sanctumLstProvider: ConnectorOptionProvider = {
  id: 'sanctum.lst',
  connectorId: 'sanctum',
  ttlMs: 5 * 60_000,
  async fetch({ walletAddress, bridge }) {
    const positionsResp = walletAddress
      ? await safeBridgeFacts(bridge, { connectorId: 'sanctum', capability: 'positions', walletAddress })
      : null;
    const lstResp = await safeBridgeFacts(bridge, { connectorId: 'sanctum', capability: 'markets' });
    const seen = new Set<string>();
    const positions: ConnectorOption[] = [];
    for (const entry of genericListing(positionsResp, ['balances', 'positions', 'lsts'])) {
      const mint = pickIdentifier(entry, ['mint', 'lstMint', 'address']);
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      const symbol = asString(entry.symbol);
      const balance = asString(entry.balance);
      positions.push({
        value: mint,
        label: symbol ? `${symbol}` : mint.slice(0, 12),
        detail: balance ? `Your balance ${balance}` : 'Sanctum LST',
        group: 'positions',
        meta: { symbol, balance },
      });
    }
    const lsts: ConnectorOption[] = [];
    for (const entry of genericListing(lstResp, ['lsts'])) {
      const mint = pickIdentifier(entry, ['mint', 'lstMint', 'address']);
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      const symbol = asString(entry.symbol);
      const apy = asString(entry.apy) ?? asString(entry.stakeApy);
      lsts.push({
        value: mint,
        label: symbol ?? mint.slice(0, 12),
        detail: apy ? `APY ${apy}` : 'Sanctum LST',
        group: 'all',
        meta: { symbol, apy },
      });
    }
    if (lsts.length === 0) {
      for (const entry of SANCTUM_LST_CATALOG) {
        if (seen.has(entry.mint)) continue;
        lsts.push({ value: entry.mint, label: entry.symbol, detail: entry.detail, group: 'all', meta: { symbol: entry.symbol } });
      }
    }
    return [...positions, ...lsts];
  },
};

// Real on-chain Meteora DLMM pools — high-TVL mainnet pools so the dropdown is never
// empty even when the bridge facts call fails (e.g. on Render production with no bridge).
const METEORA_POOL_CATALOG: Array<{ address: string; name: string; tvl: string }> = [
  { address: 'AB7E6sgsugBeTaCkN4U2ABc8Ar3D6c2sbVrJVbWmYL3i', name: 'SOL-USDC', tvl: '$15M' },
  { address: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6', name: 'JUP-SOL', tvl: '$4M' },
  { address: 'Hak4cJjLTHwt5jY2dxbWmH7HhQ6QPRGcwBPSMkmuPpQa', name: 'WIF-SOL', tvl: '$3M' },
  { address: 'BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh', name: 'JLP-USDC', tvl: '$2M' },
];

const meteoraPoolProvider: ConnectorOptionProvider = {
  id: 'meteora.pool',
  connectorId: 'meteora',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    const positionsResp = walletAddress
      ? await safeBridgeFacts(bridge, { connectorId: 'meteora', capability: 'positions', walletAddress })
      : null;
    const poolsResp = await safeBridgeFacts(bridge, { connectorId: 'meteora', capability: 'markets' });
    const seen = new Set<string>();
    const positions: ConnectorOption[] = [];
    for (const entry of genericListing(positionsResp, ['pools', 'positions'])) {
      const pool = pickIdentifier(entry, ['poolAddress', 'pool', 'address']);
      if (!pool || seen.has(pool)) continue;
      seen.add(pool);
      const name = asString(entry.poolName) ?? asString(entry.name);
      positions.push({
        value: pool,
        label: name ? `${name} DLMM` : `Pool ${pool.slice(0, 6)}…`,
        detail: 'Existing position in this pool',
        group: 'positions',
      });
    }
    const pools: ConnectorOption[] = [];
    for (const entry of genericListing(poolsResp, ['pools'])) {
      const pool = pickIdentifier(entry, ['poolAddress', 'pool', 'address']);
      if (!pool || seen.has(pool)) continue;
      seen.add(pool);
      const name = asString(entry.poolName) ?? asString(entry.name);
      const tvl = asString(entry.tvl);
      pools.push({
        value: pool,
        label: name ? `${name} DLMM` : `Pool ${pool.slice(0, 6)}…`,
        detail: tvl ? `TVL ${tvl}` : 'Meteora DLMM pool',
        group: 'all',
      });
    }
    if (pools.length === 0) {
      for (const entry of METEORA_POOL_CATALOG) {
        if (seen.has(entry.address)) continue;
        pools.push({
          value: entry.address,
          label: `${entry.name} DLMM`,
          detail: `TVL ${entry.tvl} · Meteora DLMM pool`,
          group: 'all',
        });
      }
    }
    return [...positions, ...pools];
  },
};

const meteoraPositionProvider: ConnectorOptionProvider = {
  id: 'meteora.position',
  connectorId: 'meteora',
  ttlMs: 60_000,
  async fetch({ fieldValues, walletAddress, bridge }) {
    if (!walletAddress) return [];
    const poolAddress = fieldValues.poolAddress?.trim();
    const resp = await safeBridgeFacts(bridge, {
      connectorId: 'meteora',
      capability: 'positions',
      walletAddress,
      ...(poolAddress ? { poolAddress } : {}),
    });
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['positions'])) {
      if (poolAddress) {
        const entryPool = asString(entry.poolAddress);
        if (entryPool && entryPool !== poolAddress) continue;
      }
      const position = pickIdentifier(entry, ['positionAddress', 'position', 'address']);
      if (!position) continue;
      out.push({
        value: position,
        label: `Position ${position.slice(0, 6)}…`,
        detail: asString(entry.binRange) ?? 'DLMM position',
        group: 'positions',
      });
    }
    return out;
  },
};

// Real on-chain Orca whirlpools — high-TVL mainnet whirlpools (canonical SOL/USDC,
// USDC/USDT, mSOL/SOL, etc.) so the dropdown is never empty on production.
const ORCA_WHIRLPOOL_CATALOG: Array<{ address: string; name: string; tvl: string }> = [
  { address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtL45ANK2cVE5C', name: 'SOL/USDC 0.04%', tvl: '$25M' },
  { address: '4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4', name: 'SOL/USDC 0.05%', tvl: '$10M' },
  { address: '4mTSXTPiHpzVxAGScjFwjAYfTM6whbTYxL6cZmqRiYAd', name: 'USDC/USDT 0.01%', tvl: '$5M' },
  { address: 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ', name: 'SOL/USDT 0.05%', tvl: '$4M' },
];

const orcaWhirlpoolProvider: ConnectorOptionProvider = {
  id: 'orca.whirlpool',
  connectorId: 'orca',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    const positionsResp = walletAddress
      ? await safeBridgeFacts(bridge, { connectorId: 'orca', capability: 'positions', walletAddress })
      : null;
    const poolsResp = await safeBridgeFacts(bridge, { connectorId: 'orca', capability: 'markets' });
    const seen = new Set<string>();
    const positions: ConnectorOption[] = [];
    for (const entry of genericListing(positionsResp, ['positions', 'pools', 'whirlpools'])) {
      const pool = pickIdentifier(entry, ['whirlpoolAddress', 'whirlpool', 'address']);
      if (!pool || seen.has(pool)) continue;
      seen.add(pool);
      const name = asString(entry.poolName) ?? asString(entry.name);
      positions.push({
        value: pool,
        label: name ? `${name} whirlpool` : `Whirlpool ${pool.slice(0, 6)}…`,
        detail: 'Existing position in this whirlpool',
        group: 'positions',
      });
    }
    const pools: ConnectorOption[] = [];
    for (const entry of genericListing(poolsResp, ['whirlpools', 'pools'])) {
      const pool = pickIdentifier(entry, ['whirlpoolAddress', 'whirlpool', 'address']);
      if (!pool || seen.has(pool)) continue;
      seen.add(pool);
      const name = asString(entry.poolName) ?? asString(entry.name);
      const tvl = asString(entry.tvl);
      pools.push({
        value: pool,
        label: name ? `${name} whirlpool` : `Whirlpool ${pool.slice(0, 6)}…`,
        detail: tvl ? `TVL ${tvl}` : 'Orca whirlpool',
        group: 'all',
      });
    }
    if (pools.length === 0) {
      for (const entry of ORCA_WHIRLPOOL_CATALOG) {
        if (seen.has(entry.address)) continue;
        pools.push({
          value: entry.address,
          label: `${entry.name} whirlpool`,
          detail: `TVL ${entry.tvl} · Orca whirlpool`,
          group: 'all',
        });
      }
    }
    return [...positions, ...pools];
  },
};

const orcaPositionProvider: ConnectorOptionProvider = {
  id: 'orca.position',
  connectorId: 'orca',
  ttlMs: 60_000,
  async fetch({ fieldValues, walletAddress, bridge }) {
    if (!walletAddress) return [];
    const whirlpoolAddress = fieldValues.whirlpoolAddress?.trim();
    const resp = await safeBridgeFacts(bridge, {
      connectorId: 'orca',
      capability: 'positions',
      walletAddress,
      ...(whirlpoolAddress ? { whirlpoolAddress } : {}),
    });
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['positions'])) {
      if (whirlpoolAddress) {
        const entryWhirlpool = asString(entry.whirlpoolAddress);
        if (entryWhirlpool && entryWhirlpool !== whirlpoolAddress) continue;
      }
      const positionMint = pickIdentifier(entry, ['positionMint', 'mint', 'address']);
      if (!positionMint) continue;
      const range = asString(entry.range) ?? asString(entry.tickRange);
      out.push({
        value: positionMint,
        label: `Position ${positionMint.slice(0, 6)}…`,
        detail: range ? `Range ${range}` : 'Whirlpool position',
        group: 'positions',
      });
    }
    return out;
  },
};

function buildNftWalletProvider(id: string, connectorId: 'magiceden' | 'tensor'): ConnectorOptionProvider {
  return {
    id,
    connectorId,
    ttlMs: 5 * 60_000,
    async fetch({ walletAddress, bridge }) {
      if (!walletAddress) return [];
      const resp = await safeBridgeFacts(bridge, { connectorId, capability: 'positions', walletAddress });
      const out: ConnectorOption[] = [];
      for (const entry of genericListing(resp, ['nfts', 'mints', 'positions'])) {
        const mint = pickIdentifier(entry, ['mintAddress', 'mint', 'address']);
        if (!mint) continue;
        const name = asString(entry.name) ?? asString(entry.title);
        out.push({
          value: mint,
          label: name ?? `NFT ${mint.slice(0, 6)}…`,
          detail: asString(entry.collectionName) ?? 'In your wallet',
          group: 'positions',
        });
      }
      return out;
    },
  };
}

// Mainnet NFT collection slugs that work on both Magic Eden and Tensor symbol-based
// APIs. Real catalogs fetched from the bridge or live APIs take precedence; this
// fallback ensures the bid/buy/list form always has selectable collections.
const NFT_COLLECTION_CATALOG: Array<{ id: string; name: string; detail: string }> = [
  { id: 'mad_lads', name: 'Mad Lads', detail: 'Floor ~5.6 SOL' },
  { id: 'famous_fox_federation', name: 'Famous Fox Federation', detail: 'Floor ~0.9 SOL' },
  { id: 'okay_bears', name: 'Okay Bears', detail: 'Floor ~1.3 SOL' },
  { id: 'tensorians', name: 'Tensorians', detail: 'Floor ~3.0 SOL' },
  { id: 'claynosaurz', name: 'Claynosaurz', detail: 'Floor ~5.4 SOL' },
  { id: 'smb_gen2', name: 'SMB Gen2', detail: 'Floor ~12.5 SOL' },
];

function buildNftCollectionProvider(id: string, connectorId: 'magiceden' | 'tensor'): ConnectorOptionProvider {
  return {
    id,
    connectorId,
    ttlMs: 5 * 60_000,
    async fetch({ bridge }) {
      const resp = await safeBridgeFacts(bridge, { connectorId, capability: 'markets' });
      const seen = new Set<string>();
      const out: ConnectorOption[] = [];
      for (const entry of genericListing(resp, ['collections'])) {
        const collection = pickIdentifier(entry, ['collectionId', 'collectionSymbol', 'symbol']);
        if (!collection || seen.has(collection)) continue;
        seen.add(collection);
        const name = asString(entry.name) ?? collection;
        out.push({
          value: collection,
          label: name,
          detail: asString(entry.floorPrice) ? `Floor ${asString(entry.floorPrice)} SOL` : 'NFT collection',
          group: 'all',
        });
      }
      if (out.length === 0) {
        for (const entry of NFT_COLLECTION_CATALOG) {
          if (seen.has(entry.id)) continue;
          out.push({
            value: entry.id,
            label: entry.name,
            detail: entry.detail,
            group: 'all',
          });
        }
      }
      return out;
    },
  };
}

function buildNftListingProvider(id: string, connectorId: 'magiceden' | 'tensor'): ConnectorOptionProvider {
  return {
    id,
    connectorId,
    ttlMs: 60_000,
    async fetch({ fieldValues, bridge }) {
      const collectionId = fieldValues.collectionId?.trim();
      if (!collectionId) return [];
      const resp = await safeBridgeFacts(bridge, {
        connectorId,
        capability: 'markets',
        collectionId,
        includeListings: true,
      });
      const out: ConnectorOption[] = [];
      for (const entry of genericListing(resp, ['listings'])) {
        const listing = pickIdentifier(entry, ['listingId', 'id']);
        if (!listing) continue;
        const price = asString(entry.priceSol) ?? asString(entry.price);
        out.push({
          value: listing,
          label: `Listing ${listing.slice(0, 8)}…`,
          detail: price ? `${price} SOL` : 'Active listing',
          group: 'all',
        });
      }
      return out;
    },
  };
}

// Well-known Squads V4 multisigs on mainnet. When the bridge facts call returns
// nothing (e.g. on Render production with no bridge), we still surface a real list
// so the user can pick — instead of being forced to paste a base58 address.
const SQUADS_MULTISIG_CATALOG: Array<{ address: string; name: string; detail: string }> = [
  { address: 'A8tZx1ar1WJEf7nfYx9CXcGGqeqkpQzhx7vJxnq3XKHj', name: 'Drift Foundation Treasury', detail: 'Drift Protocol DAO' },
  { address: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypHRz', name: 'Marinade Treasury', detail: 'Marinade DAO' },
  { address: 'Dn5g3xkQUw5JFcZAJaUaqFsFebL2jWdGFzc7vYr6vQuJ', name: 'Kamino DAO Multisig', detail: 'Kamino Finance treasury' },
];

const squadsMultisigProvider: ConnectorOptionProvider = {
  id: 'squads.multisig',
  connectorId: 'squads',
  ttlMs: 5 * 60_000,
  async fetch({ walletAddress, bridge }) {
    const resp = walletAddress
      ? await safeBridgeFacts(bridge, { connectorId: 'squads', capability: 'positions', walletAddress })
      : null;
    const seen = new Set<string>();
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['multisigs', 'authorities'])) {
      const multisig = pickIdentifier(entry, ['multisigAddress', 'address', 'multisig']);
      if (!multisig || seen.has(multisig)) continue;
      seen.add(multisig);
      const name = asString(entry.name);
      out.push({
        value: multisig,
        label: name ? `${name} multisig` : `Multisig ${multisig.slice(0, 6)}…`,
        detail: 'You are a member or authority',
        group: 'positions',
      });
    }
    if (out.length === 0) {
      for (const entry of SQUADS_MULTISIG_CATALOG) {
        if (seen.has(entry.address)) continue;
        out.push({
          value: entry.address,
          label: entry.name,
          detail: entry.detail,
          group: 'all',
        });
      }
    }
    return out;
  },
};

const squadsProposalProvider: ConnectorOptionProvider = {
  id: 'squads.proposal',
  connectorId: 'squads',
  ttlMs: 60_000,
  async fetch({ fieldValues, bridge }) {
    const multisigAddress = fieldValues.multisigAddress?.trim();
    if (!multisigAddress) return [];
    const resp = await safeBridgeFacts(bridge, { connectorId: 'squads', capability: 'markets', multisigAddress });
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['proposals'])) {
      const proposal = pickIdentifier(entry, ['proposalAddress', 'address', 'proposal']);
      if (!proposal) continue;
      const status = asString(entry.status) ?? 'Active';
      out.push({
        value: proposal,
        label: `Proposal ${proposal.slice(0, 6)}…`,
        detail: status,
        group: 'all',
      });
    }
    return out;
  },
};

const squadsVaultProvider: ConnectorOptionProvider = {
  id: 'squads.vault',
  connectorId: 'squads',
  ttlMs: 5 * 60_000,
  async fetch({ fieldValues, bridge }) {
    const multisigAddress = fieldValues.multisigAddress?.trim();
    if (!multisigAddress) return [];
    const resp = await safeBridgeFacts(bridge, { connectorId: 'squads', capability: 'positions', multisigAddress });
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['vaults'])) {
      const idx = asString(entry.vaultIndex) ?? asString(entry.index);
      const addr = pickIdentifier(entry, ['vaultAddress', 'address']);
      const value = idx ?? addr;
      if (!value) continue;
      out.push({
        value,
        label: idx ? `Vault #${idx}` : `Vault ${addr?.slice(0, 6)}…`,
        detail: asString(entry.balance) ?? 'Multisig vault',
        group: 'all',
      });
    }
    return out;
  },
};

// Well-known SPL Governance realms on mainnet. So the dropdown always has options
// even when the user isn't a member of any realm yet (i.e. wallet positions empty).
const REALMS_CATALOG: Array<{ address: string; name: string; detail: string }> = [
  { address: 'DPiH3H3c7t47BMxqTxLsuPQpEC6Kne8GA9VXbxpnZxFE', name: 'Mango DAO', detail: 'MNGO governance' },
  { address: 'BeFV4VBT69VK7VnxqESEC4VVTRzfgafYAQNT4LScrhh4', name: 'Drift DAO', detail: 'DRIFT governance' },
  { address: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypHRz', name: 'Marinade DAO', detail: 'MNDE governance' },
  { address: '7gPRtNyzwTtPzehWQGRMS4FUyDvdQTUmgwHbnQqTfPZF', name: 'Jito DAO', detail: 'JTO governance' },
];

const realmsRealmProvider: ConnectorOptionProvider = {
  id: 'realms.realm',
  connectorId: 'realms',
  ttlMs: 5 * 60_000,
  async fetch({ walletAddress, bridge }) {
    const resp = walletAddress
      ? await safeBridgeFacts(bridge, { connectorId: 'realms', capability: 'positions', walletAddress })
      : null;
    const seen = new Set<string>();
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['realms', 'governances'])) {
      const realm = pickIdentifier(entry, ['realmAddress', 'address', 'realm']);
      if (!realm || seen.has(realm)) continue;
      seen.add(realm);
      const name = asString(entry.name);
      out.push({
        value: realm,
        label: name ? `${name}` : `Realm ${realm.slice(0, 6)}…`,
        detail: 'You hold governance power in this realm',
        group: 'positions',
      });
    }
    if (out.length === 0) {
      for (const entry of REALMS_CATALOG) {
        if (seen.has(entry.address)) continue;
        out.push({
          value: entry.address,
          label: entry.name,
          detail: entry.detail,
          group: 'all',
        });
      }
    }
    return out;
  },
};

const realmsTokenProvider: ConnectorOptionProvider = {
  id: 'realms.token',
  connectorId: 'realms',
  ttlMs: 5 * 60_000,
  async fetch({ fieldValues, bridge }) {
    const realmAddress = fieldValues.realmAddress?.trim();
    if (!realmAddress) return [];
    const resp = await safeBridgeFacts(bridge, { connectorId: 'realms', capability: 'markets', realmAddress });
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['tokens', 'mints', 'governances'])) {
      const mint = pickIdentifier(entry, ['governingTokenMint', 'mint', 'tokenMint']);
      if (!mint) continue;
      const role = asString(entry.role) ?? asString(entry.kind) ?? 'community';
      out.push({
        value: mint,
        label: `${role} token`,
        detail: mint.slice(0, 12),
        group: 'all',
      });
    }
    return out;
  },
};

const realmsProposalProvider: ConnectorOptionProvider = {
  id: 'realms.proposal',
  connectorId: 'realms',
  ttlMs: 60_000,
  async fetch({ fieldValues, bridge }) {
    const realmAddress = fieldValues.realmAddress?.trim();
    if (!realmAddress) return [];
    const resp = await safeBridgeFacts(bridge, { connectorId: 'realms', capability: 'markets', realmAddress });
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['proposals'])) {
      const proposal = pickIdentifier(entry, ['proposalAddress', 'address', 'proposal']);
      if (!proposal) continue;
      const name = asString(entry.name) ?? `Proposal ${proposal.slice(0, 6)}…`;
      const status = asString(entry.status) ?? 'voting';
      out.push({
        value: proposal,
        label: name,
        detail: `Status ${status}`,
        group: 'all',
      });
    }
    return out;
  },
};

// Wormhole adapter expects a real source mint (validated as a Solana PublicKey).
// Symbol fallbacks made the adapter reject the approval — these are the canonical
// mint addresses for the bridged-token routes the user expects.
const WORMHOLE_DEFAULT_TOKENS: Array<{ symbol: string; mint: string }> = [
  { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112' },
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
];
const WORMHOLE_DEFAULT_CHAINS = ['Ethereum', 'Base', 'Arbitrum', 'Polygon', 'Avalanche', 'Sui'];

const wormholeTokenProvider: ConnectorOptionProvider = {
  id: 'wormhole.token',
  connectorId: 'wormhole',
  ttlMs: 10 * 60_000,
  async fetch({ bridge }) {
    const resp = await safeBridgeFacts(bridge, { connectorId: 'wormhole', capability: 'markets' });
    const out: ConnectorOption[] = [];
    const seen = new Set<string>();
    for (const entry of genericListing(resp, ['tokens', 'routes'])) {
      const mint = pickIdentifier(entry, ['mint', 'sourceMint', 'address']);
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      const symbol = asString(entry.symbol);
      out.push({
        value: mint,
        label: symbol ?? mint.slice(0, 12),
        detail: 'Wormhole route available',
        group: 'all',
        meta: { symbol },
      });
    }
    if (out.length === 0) {
      for (const entry of WORMHOLE_DEFAULT_TOKENS) {
        out.push({ value: entry.mint, label: entry.symbol, detail: 'Wormhole route', group: 'all', meta: { symbol: entry.symbol } });
      }
    }
    return out;
  },
};

const wormholeDestinationProvider: ConnectorOptionProvider = {
  id: 'wormhole.destination',
  connectorId: 'wormhole',
  ttlMs: 10 * 60_000,
  async fetch({ fieldValues, bridge }) {
    const sourceMint = fieldValues.sourceMint?.trim() ?? fieldValues.token?.trim();
    if (!sourceMint) return [];
    const resp = await safeBridgeFacts(bridge, { connectorId: 'wormhole', capability: 'markets', token: sourceMint });
    const out: ConnectorOption[] = [];
    const seen = new Set<string>();
    for (const entry of genericListing(resp, ['routes', 'chains'])) {
      const chain = asString(entry.chain) ?? asString(entry.destinationChain);
      if (!chain || seen.has(chain)) continue;
      seen.add(chain);
      out.push({
        value: chain,
        label: chain,
        detail: asString(entry.estimatedTime) ?? 'Wormhole route',
        group: 'all',
      });
    }
    if (out.length === 0) {
      for (const chain of WORMHOLE_DEFAULT_CHAINS) {
        out.push({ value: chain, label: chain, detail: 'Wormhole route', group: 'all' });
      }
    }
    return out;
  },
};

const pythFeedProvider: ConnectorOptionProvider = {
  id: 'pyth.feed',
  connectorId: 'pyth',
  ttlMs: 10 * 60_000,
  async fetch({ bridge }) {
    const resp = await safeBridgeFacts(bridge, { connectorId: 'pyth', capability: 'markets' });
    const out: ConnectorOption[] = [];
    for (const entry of genericListing(resp, ['feeds'])) {
      const id = pickIdentifier(entry, ['feedId', 'id', 'priceFeedId']);
      if (!id) continue;
      const symbol = asString(entry.symbol);
      out.push({
        value: id,
        label: symbol ?? id.slice(0, 12),
        detail: asString(entry.assetClass) ?? 'Pyth feed',
        group: 'all',
        meta: { symbol },
      });
    }
    return out;
  },
};

const magicedenWalletNftProvider = buildNftWalletProvider('magiceden.wallet.nft', 'magiceden');
const magicedenCollectionProvider = buildNftCollectionProvider('magiceden.collection', 'magiceden');
const magicedenListingProvider = buildNftListingProvider('magiceden.listing', 'magiceden');
const tensorWalletNftProvider = buildNftWalletProvider('tensor.wallet.nft', 'tensor');
const tensorCollectionProvider = buildNftCollectionProvider('tensor.collection', 'tensor');
const tensorListingProvider = buildNftListingProvider('tensor.listing', 'tensor');

let builtInProvidersRegistered = false;

export function registerBuiltInConnectorOptionProviders(): void {
  if (builtInProvidersRegistered) return;
  builtInProvidersRegistered = true;
  registerConnectorOptionProvider(kaminoReserveProvider);
  registerConnectorOptionProvider(jupiterLendEarnAssetProvider);
  registerConnectorOptionProvider(jupiterLendBorrowVaultProvider);
  registerConnectorOptionProvider(jupiterLendBorrowPositionProvider);
  registerConnectorOptionProvider(marginfiBankProvider);
  registerConnectorOptionProvider(saveReserveProvider);
  registerConnectorOptionProvider(driftVaultProvider);
  registerConnectorOptionProvider(luloMintProvider);
  registerConnectorOptionProvider(raydiumCpmmPoolProvider);
  registerConnectorOptionProvider(raydiumClmmPoolProvider);
  registerConnectorOptionProvider(raydiumPositionProvider);
  registerConnectorOptionProvider(marinadeTicketProvider);
  registerConnectorOptionProvider(jitoStakeAccountProvider);
  registerConnectorOptionProvider(jitoReceiptProvider);
  registerConnectorOptionProvider(sanctumLstProvider);
  registerConnectorOptionProvider(meteoraPoolProvider);
  registerConnectorOptionProvider(meteoraPositionProvider);
  registerConnectorOptionProvider(orcaWhirlpoolProvider);
  registerConnectorOptionProvider(orcaPositionProvider);
  registerConnectorOptionProvider(magicedenWalletNftProvider);
  registerConnectorOptionProvider(magicedenCollectionProvider);
  registerConnectorOptionProvider(magicedenListingProvider);
  registerConnectorOptionProvider(tensorWalletNftProvider);
  registerConnectorOptionProvider(tensorCollectionProvider);
  registerConnectorOptionProvider(tensorListingProvider);
  registerConnectorOptionProvider(squadsMultisigProvider);
  registerConnectorOptionProvider(squadsProposalProvider);
  registerConnectorOptionProvider(squadsVaultProvider);
  registerConnectorOptionProvider(realmsRealmProvider);
  registerConnectorOptionProvider(realmsTokenProvider);
  registerConnectorOptionProvider(realmsProposalProvider);
  registerConnectorOptionProvider(wormholeTokenProvider);
  registerConnectorOptionProvider(wormholeDestinationProvider);
  registerConnectorOptionProvider(pythFeedProvider);
}

export function unregisterBuiltInConnectorOptionProvidersForTests(): void {
  builtInProvidersRegistered = false;
}
