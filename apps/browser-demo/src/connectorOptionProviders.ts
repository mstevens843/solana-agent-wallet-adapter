import type { ProtocolConnectorId } from './connectedDapps.js';

export interface ConnectorOptionMeta {
  apy?: string;
  tvl?: string;
  balance?: string;
  symbol?: string;
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

const KAMINO_COMMON_RESERVES: Array<{ symbol: string; description: string }> = [
  { symbol: 'USDC', description: 'USD stablecoin · main market' },
  { symbol: 'SOL', description: 'Native SOL · main market' },
  { symbol: 'JitoSOL', description: 'Jito staked SOL · main market' },
  { symbol: 'mSOL', description: 'Marinade staked SOL · main market' },
  { symbol: 'bSOL', description: 'Blaze staked SOL · main market' },
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
      const supplied = asString(position.suppliedAmount);
      const earned = asString(position.earnedInterest);
      const apy = asString(position.supplyApy);
      const details: string[] = [];
      if (supplied) details.push(`Your supply ${supplied}`);
      if (apy) details.push(`APY ${apy}`);
      if (earned) details.push(`Earned ${earned}`);
      positionOptions.push({
        value: symbol,
        label: `${symbol} reserve`,
        detail: details.join(' · '),
        group: 'positions',
        meta: { symbol, apy, balance: supplied },
      });
    }
    const catalog: ConnectorOption[] = KAMINO_COMMON_RESERVES
      .filter((entry) => !seen.has(entry.symbol))
      .map((entry) => ({
        value: entry.symbol,
        label: `${entry.symbol} reserve`,
        detail: entry.description,
        group: 'all',
        meta: { symbol: entry.symbol },
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
}

export function unregisterBuiltInConnectorOptionProvidersForTests(): void {
  builtInProvidersRegistered = false;
}
