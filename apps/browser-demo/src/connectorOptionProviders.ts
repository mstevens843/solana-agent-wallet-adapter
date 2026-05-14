import type { ProtocolConnectorId } from './connectedDapps.js';

export interface ConnectorOptionMeta {
  apy?: string;
  tvl?: string;
  balance?: string;
  symbol?: string;
  market?: string;
  tokenXSymbol?: string;
  tokenYSymbol?: string;
  tokenMintX?: string;
  tokenMintY?: string;
  binStep?: string;
  tokenASymbol?: string;
  tokenBSymbol?: string;
  tokenAMint?: string;
  tokenBMint?: string;
  feeBps?: string;
  poolType?: string;
  programId?: string;
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
  collections?: Array<Record<string, unknown>> | Record<string, unknown>;
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

function asDisplayString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asString(value);
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
  {
    symbol: 'SOL',
    mint: 'So11111111111111111111111111111111111111112',
    description: 'Native SOL earn pool',
  },
  {
    symbol: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    description: 'USD stablecoin earn pool',
  },
  {
    symbol: 'USDT',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    description: 'USDT stablecoin earn pool',
  },
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
        const value = fallback.mint ?? fallback.symbol;
        if (seen.has(value) || seen.has(fallback.symbol)) continue;
        seen.add(value);
        all.push({
          value,
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

const PROJECT0_COMMON_BANKS: Array<{ symbol: string; description: string }> = [
  { symbol: 'USDC', description: 'USDC bank · Project 0' },
  { symbol: 'SOL', description: 'SOL bank · Project 0' },
  { symbol: 'USDT', description: 'USDT bank · Project 0' },
  { symbol: 'JitoSOL', description: 'JitoSOL bank · Project 0' },
];

function genericListing(resp: BridgeFactsResponse | null, keys: string[]): Array<Record<string, unknown>> {
  if (!resp) return [];
  for (const key of keys) {
    const snapshot = resp.snapshot as Record<string, unknown> | undefined;
    if (snapshot && Array.isArray(snapshot[key])) return snapshot[key] as Array<Record<string, unknown>>;
    const snapshotValue = snapshot?.[key];
    if (isRecord(snapshotValue) && Array.isArray(snapshotValue.rows)) {
      return snapshotValue.rows as Array<Record<string, unknown>>;
    }
    if (isRecord(snapshotValue) && Array.isArray(snapshotValue.collections)) {
      return snapshotValue.collections as Array<Record<string, unknown>>;
    }
    if (Array.isArray((resp as Record<string, unknown>)[key])) return (resp as Record<string, unknown>)[key] as Array<Record<string, unknown>>;
    const direct = (resp as Record<string, unknown>)[key];
    if (isRecord(direct) && Array.isArray(direct.rows)) return direct.rows as Array<Record<string, unknown>>;
    if (isRecord(direct) && Array.isArray(direct.collections)) return direct.collections as Array<Record<string, unknown>>;
  }
  const factsArray = (resp as Record<string, unknown>).facts;
  if (Array.isArray(factsArray)) return factsArray as Array<Record<string, unknown>>;
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

const project0BankProvider: ConnectorOptionProvider = {
  id: 'project0.bank',
  connectorId: 'project0',
  ttlMs: 60_000,
  async fetch({ walletAddress, bridge }) {
    const positionsResp = walletAddress
      ? await safeBridgeFacts(bridge, { connectorId: 'project0', capability: 'positions', walletAddress })
      : null;
    const banksResp = await safeBridgeFacts(bridge, { connectorId: 'project0', capability: 'markets' });
    const seen = new Set<string>();
    const positions: ConnectorOption[] = [];
    for (const entry of genericListing(positionsResp, ['banks', 'positions', 'accounts'])) {
      const bank = pickIdentifier(entry, ['bankAddress', 'address', 'bankMint', 'mint']);
      if (!bank || seen.has(bank)) continue;
      seen.add(bank);
      const symbol = asString(entry.bankSymbol) ?? asString(entry.tokenSymbol) ?? asString(entry.symbol);
      const venue = asString(entry.venue) ?? 'Project 0';
      positions.push({
        value: bank,
        label: symbol ? `${symbol} bank` : `Bank ${bank.slice(0, 6)}…`,
        detail: `Open ${venue} position`,
        group: 'positions',
        meta: { symbol, market: venue },
      });
    }
    const banks: ConnectorOption[] = [];
    for (const entry of genericListing(banksResp, ['banks', 'reserves'])) {
      const bank = pickIdentifier(entry, ['bankAddress', 'address', 'bankMint', 'mint']);
      if (!bank || seen.has(bank)) continue;
      seen.add(bank);
      const symbol = asString(entry.bankSymbol) ?? asString(entry.tokenSymbol) ?? asString(entry.symbol);
      const apy = asString(entry.lendingApy) ?? asString(entry.depositApy) ?? asString(entry.apy);
      const venue = asString(entry.venue) ?? 'Project 0';
      banks.push({
        value: bank,
        label: symbol ? `${symbol} bank` : `Bank ${bank.slice(0, 6)}…`,
        detail: apy ? `Deposit APY ${apy}` : `${venue} bank`,
        group: 'all',
        meta: { symbol, apy, market: venue },
      });
    }
    if (banks.length === 0) {
      for (const fallback of PROJECT0_COMMON_BANKS) {
        if (seen.has(fallback.symbol)) continue;
        banks.push({
          value: fallback.symbol,
          label: `${fallback.symbol} bank`,
          detail: fallback.description,
          group: 'all',
          meta: { symbol: fallback.symbol, market: 'Project 0' },
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

const SAVE_KNOWN_RESERVE_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};

function saveReserveOptionValue(entry: Record<string, unknown>): { value: string; symbol?: string; mint?: string } | undefined {
  const rawSymbol = asString(entry.reserveSymbol) ?? asString(entry.tokenSymbol) ?? asString(entry.symbol);
  const symbol = rawSymbol ? rawSymbol.toUpperCase() : undefined;
  const mint = asString(entry.reserveMint) ?? asString(entry.mint);
  const knownSymbol = mint ? SAVE_KNOWN_RESERVE_MINTS[mint] : undefined;
  const value = knownSymbol ?? symbol ?? mint;
  return value ? { value, symbol: knownSymbol ?? symbol, mint } : undefined;
}

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
      const selection = saveReserveOptionValue(entry);
      if (!selection || seen.has(selection.value)) continue;
      seen.add(selection.value);
      const reserveAddress = pickIdentifier(entry, ['reserveAddress', 'address']);
      positions.push({
        value: selection.value,
        label: selection.symbol ? `${selection.symbol} reserve` : `Reserve ${selection.value.slice(0, 6)}…`,
        detail: reserveAddress ? `Open Save obligation · ${reserveAddress.slice(0, 6)}…` : 'Open Save obligation',
        group: 'positions',
        meta: { symbol: selection.symbol },
      });
    }
    const reserves: ConnectorOption[] = [];
    for (const entry of genericListing(reservesResp, ['reserves'])) {
      const selection = saveReserveOptionValue(entry);
      if (!selection || seen.has(selection.value)) continue;
      seen.add(selection.value);
      const apy = asString(entry.lendApy) ?? asString(entry.supplyApy) ?? asString(entry.apy);
      const reserveAddress = pickIdentifier(entry, ['reserveAddress', 'address']);
      reserves.push({
        value: selection.value,
        label: selection.symbol ? `${selection.symbol} reserve` : `Reserve ${selection.value.slice(0, 6)}…`,
        detail: [apy ? `Supply APY ${apy}` : 'Save reserve', reserveAddress ? reserveAddress.slice(0, 6) + '…' : '']
          .filter(Boolean)
          .join(' · '),
        group: 'all',
        meta: { symbol: selection.symbol, apy },
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

// Seeded from Drift's public vault config. The bridge-backed catalog is used
// when available; this keeps the selector usable when that read is unavailable.
const DRIFT_COMMON_VAULTS: Array<{
  vaultAddress: string;
  name: string;
  manager: string;
  depositSymbol: string;
}> = [
  {
    vaultAddress: 'CoHd9JpwfcA76XQGA4AYfnjvAtWKoBQ6eWBkFzR1A2ui',
    name: 'hJLP (USDC)',
    manager: 'Gauntlet',
    depositSymbol: 'USDC',
  },
  {
    vaultAddress: 'AocrjhFd2oxyVccz1vdnZc9Hd9bnW9ejuWWH73PedykU',
    name: 'hJLP (In Kind)',
    manager: 'Gauntlet',
    depositSymbol: 'JLP',
  },
  {
    vaultAddress: 'EuSLjg23BrtwYAk1t4TFe5ArYSXCVXLBqrHRBfWQiTeJ',
    name: 'SOL Super Staking',
    manager: 'Neutral Trade',
    depositSymbol: 'SOL',
  },
  {
    vaultAddress: '9omhWDzVxpX1vPBxAhJpVao7baoVzZpNib32vozZLxGm',
    name: 'JLP Delta Neutral V5',
    manager: 'Neutral Trade',
    depositSymbol: 'USDC',
  },
  {
    vaultAddress: 'CG2zv4wsSetgs6mAucEKnHPwSoZSLYMwGroembTUNeaU',
    name: 'Neutralized JLP (Deposit JLP)',
    manager: 'Neutral Trade',
    depositSymbol: 'JLP',
  },
  {
    vaultAddress: '2dNSa3fBPMoxcs46NhtdLeTJuLasDt6VYNG4vopa7mWw',
    name: 'JLP Hedge Vault',
    manager: 'PrimeNumber',
    depositSymbol: 'USDC',
  },
  {
    vaultAddress: 'JCigGWJJRCPas7B9eUe2JgkyqQjGxMKkvZcJ7VQaNBqx',
    name: 'hJLP 2x (USDC)',
    manager: 'Gauntlet',
    depositSymbol: 'USDC',
  },
  {
    vaultAddress: 'FHF1EiAW12oCrHRh3Ycd1ZZQgCHRPRaC5wQFC68Twafq',
    name: 'hJLP Max',
    manager: 'Gauntlet',
    depositSymbol: 'USDC',
  },
  {
    vaultAddress: '4F7c7v9cZHatcZLy9TZFv1jrRrReACLBxciMkbDqVkfQ',
    name: 'JitoSOL Plus',
    manager: 'Gauntlet',
    depositSymbol: 'JitoSOL',
  },
  {
    vaultAddress: '6aowo7AoE6rw8CS6knd746XiRysuiEjs9YpZyHRAMnor',
    name: 'dSOL Plus',
    manager: 'Gauntlet',
    depositSymbol: 'dSOL',
  },
  {
    vaultAddress: 'BVddkVtFJLCihbVrtLo8e3iEd9NftuLunaznAxFFW8vf',
    name: 'BTC Super Staking',
    manager: 'Neutral Trade',
    depositSymbol: 'BTC',
  },
  {
    vaultAddress: 'ENr5e1BMN5vFUHf4iCCPzR4GjWCKgtHnQcdniRQqMdEL',
    name: 'ETH Super Staking',
    manager: 'Neutral Trade',
    depositSymbol: 'ETH',
  },
];

const DRIFT_PUBLIC_VAULT_CATALOG_URL =
  'https://drift-public.s3.eu-central-1.amazonaws.com/vaults/configs.json';

function driftVaultFallbackOptions(seen: Set<string>): ConnectorOption[] {
  const options: ConnectorOption[] = [];
  for (const fallback of DRIFT_COMMON_VAULTS) {
    if (seen.has(fallback.vaultAddress)) continue;
    seen.add(fallback.vaultAddress);
    options.push({
      value: fallback.vaultAddress,
      label: fallback.name,
      detail: `${fallback.depositSymbol} deposits · ${fallback.manager} · Drift vault catalog fallback`,
      group: 'all',
      meta: { symbol: fallback.depositSymbol, market: fallback.manager },
    });
  }
  return options;
}

async function driftVaultPublicCatalogOptions(seen: Set<string>): Promise<ConnectorOption[]> {
  const fetcher = globalThis.fetch;
  if (!fetcher) return [];
  try {
    const response = await fetcher(DRIFT_PUBLIC_VAULT_CATALOG_URL, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return [];
    const body = await response.json();
    if (!Array.isArray(body)) return [];
    const options: ConnectorOption[] = [];
    for (const item of body) {
      if (!isRecord(item) || item.hidden === true) continue;
      const vault = asString(item.vaultPubkeyString) ?? asString(item.vaultAddress) ?? asString(item.address);
      const name = asString(item.name) ?? asString(item.vaultName);
      if (!vault || !name || seen.has(vault)) continue;
      seen.add(vault);
      const manager = driftVaultManagerName(item);
      const symbol = asString(item.depositSymbol) ?? driftDepositAssetSymbol(item.depositAsset);
      options.push({
        value: vault,
        label: name,
        detail: [
          symbol ? `${symbol} deposits` : '',
          manager ? `Manager ${manager}` : '',
          'Drift vault catalog',
        ].filter(Boolean).join(' · '),
        group: 'all',
        meta: { symbol, market: manager },
      });
    }
    return sortDriftVaultOptions(options);
  } catch {
    return [];
  }
}

function driftDepositAssetSymbol(value: unknown): string | undefined {
  const asset = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : undefined;
  if (asset === undefined || !Number.isFinite(asset)) return undefined;
  const symbols: Record<number, string> = {
    0: 'USDC',
    1: 'SOL',
    3: 'BTC',
    4: 'ETH',
    6: 'JitoSOL',
    9: 'JTO',
    15: 'DRIFT',
    17: 'dSOL',
    19: 'JLP',
    27: 'cbBTC',
    52: 'dfdvSOL',
  };
  return symbols[asset];
}

function driftVaultManagerName(entry: Record<string, unknown>): string | undefined {
  const manager = entry.vaultManager;
  if (isRecord(manager)) return asString(manager.name);
  return asString(entry.managerName);
}

function driftVaultLabel(name: string | undefined, vaultAddress: string): string {
  if (!name) return `Vault ${vaultAddress.slice(0, 6)}…`;
  return /\bvault\b/i.test(name) ? name : `${name} vault`;
}

function sortDriftVaultOptions(options: ConnectorOption[]): ConnectorOption[] {
  return options.slice().sort((left, right) => {
    const leftRank = driftVaultSymbolRank(left.meta?.symbol);
    const rightRank = driftVaultSymbolRank(right.meta?.symbol);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.label.localeCompare(right.label);
  });
}

function driftVaultSymbolRank(symbol: string | undefined): number {
  const normalized = symbol?.trim().toUpperCase();
  if (normalized === 'SOL') return 0;
  if (normalized === 'USDC') return 1;
  return 2;
}

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
        label: driftVaultLabel(name, vault),
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
      const manager = driftVaultManagerName(entry);
      const symbol = asString(entry.depositSymbol) ?? driftDepositAssetSymbol(entry.depositAsset);
      const details = [
        symbol ? `${symbol} deposits` : '',
        manager ? `Manager ${manager}` : '',
        apy ? `Net APY ${apy}` : '',
      ].filter(Boolean);
      vaults.push({
        value: vault,
        label: name ?? `Vault ${vault.slice(0, 6)}…`,
        detail: details.length ? details.join(' · ') : 'Drift strategy vault',
        group: 'all',
        meta: { symbol, apy, market: manager },
      });
    }
    if (vaults.length === 0) vaults.push(...await driftVaultPublicCatalogOptions(seen));
    if (vaults.length === 0) vaults.push(...driftVaultFallbackOptions(seen));
    return [...positions, ...sortDriftVaultOptions(vaults)];
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

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RAY_MINT = '4k3Dyjzvzp8eG8ud5Htx7Tyv6GhtNsbD5gQ4YnWLbB9Y';
const RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const RAYDIUM_CLMM_PROGRAM_ID = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

interface LiquidityPoolCatalogEntry {
  address: string;
  name: string;
  tvl: string;
  tokenASymbol: string;
  tokenBSymbol: string;
  tokenAMint: string;
  tokenBMint: string;
  feeBps?: string;
  poolType?: string;
  programId?: string;
}

// Verified mainnet pools only. Do not list legacy AMM v4 addresses as CPMM;
// the Raydium adapter supports CPMM and CLMM builders, not AMM v4 liquidity.
const RAYDIUM_CPMM_POOL_CATALOG: LiquidityPoolCatalogEntry[] = [
  {
    address: '47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4',
    name: 'SOL-USDC',
    tvl: '$1.7K',
    tokenASymbol: 'SOL',
    tokenBSymbol: 'USDC',
    tokenAMint: SOL_MINT,
    tokenBMint: USDC_MINT,
    poolType: 'cpmm',
    programId: RAYDIUM_CPMM_PROGRAM_ID,
  },
];
const RAYDIUM_CLMM_POOL_CATALOG: LiquidityPoolCatalogEntry[] = [
  {
    address: '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv',
    name: 'SOL-USDC 0.04%',
    tvl: '$22M',
    tokenASymbol: 'SOL',
    tokenBSymbol: 'USDC',
    tokenAMint: SOL_MINT,
    tokenBMint: USDC_MINT,
    feeBps: '4',
    poolType: 'clmm',
    programId: RAYDIUM_CLMM_PROGRAM_ID,
  },
  {
    address: '8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj',
    name: 'SOL-USDC 0.25%',
    tvl: '$6M',
    tokenASymbol: 'SOL',
    tokenBSymbol: 'USDC',
    tokenAMint: SOL_MINT,
    tokenBMint: USDC_MINT,
    feeBps: '25',
    poolType: 'clmm',
    programId: RAYDIUM_CLMM_PROGRAM_ID,
  },
  {
    address: 'AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA',
    name: 'RAY-SOL 0.25%',
    tvl: '$3M',
    tokenASymbol: 'RAY',
    tokenBSymbol: 'SOL',
    tokenAMint: RAY_MINT,
    tokenBMint: SOL_MINT,
    feeBps: '25',
    poolType: 'clmm',
    programId: RAYDIUM_CLMM_PROGRAM_ID,
  },
];

function liquidityCatalogMeta(entry: LiquidityPoolCatalogEntry): ConnectorOptionMeta {
  return {
    tvl: entry.tvl,
    tokenASymbol: entry.tokenASymbol,
    tokenBSymbol: entry.tokenBSymbol,
    tokenAMint: entry.tokenAMint,
    tokenBMint: entry.tokenBMint,
    ...(entry.feeBps !== undefined && { feeBps: entry.feeBps }),
    ...(entry.poolType !== undefined && { poolType: entry.poolType }),
    ...(entry.programId !== undefined && { programId: entry.programId }),
  };
}

function raydiumEntryMeta(entry: Record<string, unknown>, poolType: 'cpmm' | 'clmm'): ConnectorOptionMeta {
  const tokenA: Record<string, unknown> = isRecord(entry.mintA) ? entry.mintA : isRecord(entry.tokenA) ? entry.tokenA : {};
  const tokenB: Record<string, unknown> = isRecord(entry.mintB) ? entry.mintB : isRecord(entry.tokenB) ? entry.tokenB : {};
  const tokenASymbol = asString(tokenA.symbol) ?? asString(entry.tokenASymbol) ?? asString(entry.tokenA);
  const tokenBSymbol = asString(tokenB.symbol) ?? asString(entry.tokenBSymbol) ?? asString(entry.tokenB);
  const tokenAMint = pickIdentifier(tokenA, ['address', 'mint']) ?? asString(entry.tokenAMint);
  const tokenBMint = pickIdentifier(tokenB, ['address', 'mint']) ?? asString(entry.tokenBMint);
  const feeBps = asDisplayString(entry.feeBps) ?? feeBpsFromRate(entry.feeRate);
  const programId = asString(entry.programId);
  return {
    poolType,
    ...(tokenASymbol !== undefined && { tokenASymbol }),
    ...(tokenBSymbol !== undefined && { tokenBSymbol }),
    ...(tokenAMint !== undefined && { tokenAMint }),
    ...(tokenBMint !== undefined && { tokenBMint }),
    ...(feeBps !== undefined && { feeBps }),
    ...(programId !== undefined && { programId }),
  };
}

function feeBpsFromRate(value: unknown): string | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const bps = numeric < 1 ? numeric * 10_000 : numeric / 100;
  return Number.isInteger(bps) ? String(bps) : bps.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function raydiumProgramMatchesPoolType(programId: string, poolType: 'cpmm' | 'clmm'): boolean {
  return poolType === 'cpmm'
    ? programId === RAYDIUM_CPMM_PROGRAM_ID
    : programId === RAYDIUM_CLMM_PROGRAM_ID;
}

function orcaEntryMeta(entry: Record<string, unknown>): ConnectorOptionMeta {
  const tokenA: Record<string, unknown> = isRecord(entry.tokenA) ? entry.tokenA : isRecord(entry.mintA) ? entry.mintA : {};
  const tokenB: Record<string, unknown> = isRecord(entry.tokenB) ? entry.tokenB : isRecord(entry.mintB) ? entry.mintB : {};
  const tokenASymbol = asString(tokenA.symbol) ?? asString(entry.tokenASymbol) ?? asString(entry.tokenA);
  const tokenBSymbol = asString(tokenB.symbol) ?? asString(entry.tokenBSymbol) ?? asString(entry.tokenB);
  const tokenAMint = pickIdentifier(tokenA, ['address', 'mint']) ?? asString(entry.tokenMintA) ?? asString(entry.tokenAMint);
  const tokenBMint = pickIdentifier(tokenB, ['address', 'mint']) ?? asString(entry.tokenMintB) ?? asString(entry.tokenBMint);
  const feeBps = asDisplayString(entry.feeBps) ?? feeBpsFromRate(entry.feeRate);
  return {
    poolType: 'whirlpool',
    programId: ORCA_WHIRLPOOL_PROGRAM_ID,
    ...(tokenASymbol !== undefined && { tokenASymbol }),
    ...(tokenBSymbol !== undefined && { tokenBSymbol }),
    ...(tokenAMint !== undefined && { tokenAMint }),
    ...(tokenBMint !== undefined && { tokenBMint }),
    ...(feeBps !== undefined && { feeBps }),
  };
}

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
        const programId = asString(entry.programId);
        if (programId && !raydiumProgramMatchesPoolType(programId, poolType)) continue;
        seen.add(pool);
        const symbol = asString(entry.poolName) ?? asString(entry.name);
        positions.push({
          value: pool,
          label: symbol ? `${symbol} ${poolType.toUpperCase()}` : `Pool ${pool.slice(0, 6)}…`,
          detail: 'Open Raydium position',
          group: 'positions',
          meta: raydiumEntryMeta(entry, poolType),
        });
      }
      const pools: ConnectorOption[] = [];
      for (const entry of genericListing(poolsResp, ['pools'])) {
        const entryType = asString(entry.poolType) ?? asString(entry.type);
        if (entryType && entryType.toLowerCase() !== poolType) continue;
        const pool = pickIdentifier(entry, ['poolId', 'poolAddress', 'address']);
        if (!pool || seen.has(pool)) continue;
        const programId = asString(entry.programId);
        if (programId && !raydiumProgramMatchesPoolType(programId, poolType)) continue;
        seen.add(pool);
        const symbol = asString(entry.poolName) ?? asString(entry.name);
        const tvl = asString(entry.tvl) ?? asString(entry.tvlUsd);
        const meta = {
          ...raydiumEntryMeta(entry, poolType),
          ...(tvl !== undefined && { tvl }),
        };
        pools.push({
          value: pool,
          label: symbol ? `${symbol} ${poolType.toUpperCase()}` : `Pool ${pool.slice(0, 6)}…`,
          detail: tvl ? `TVL $${tvl}` : `Raydium ${poolType.toUpperCase()} pool`,
          group: 'all',
          meta,
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
            meta: liquidityCatalogMeta(entry),
          });
        }
      }
      return [...positions, ...pools];
    },
  };
}

const raydiumCpmmPoolProvider = buildRaydiumPoolProvider('raydium.cpmm.pool', 'cpmm');
const raydiumClmmPoolProvider = buildRaydiumPoolProvider('raydium.clmm.pool', 'clmm');

const raydiumPoolProvider: ConnectorOptionProvider = {
  id: 'raydium.pool',
  connectorId: 'raydium',
  ttlMs: 60_000,
  async fetch(ctx) {
    const combined = [
      ...(await raydiumCpmmPoolProvider.fetch(ctx)),
      ...(await raydiumClmmPoolProvider.fetch(ctx)),
    ];
    const seen = new Set<string>();
    const out: ConnectorOption[] = [];
    for (const option of combined) {
      if (seen.has(option.value)) continue;
      seen.add(option.value);
      out.push(option);
    }
    return out;
  },
};

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

const METEORA_DATA_API_POOLS_URL = 'https://dlmm.datapi.meteora.ag/pools';
const METEORA_COMMON_POOL_QUERIES = ['SOL-USDC', 'JUP-SOL', 'WIF-SOL', 'JLP-USDC'];

interface MeteoraPoolCatalogEntry {
  address: string;
  name: string;
  tvl: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenMintX: string;
  tokenMintY: string;
}

// Verified against Meteora's DLMM Data API and Solana RPC on 2026-05-14. These
// keep the dropdown useful if the live Data API is temporarily unavailable.
const METEORA_POOL_CATALOG: MeteoraPoolCatalogEntry[] = [
  {
    address: 'BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y',
    name: 'SOL-USDC',
    tvl: '$5.6M',
    tokenXSymbol: 'SOL',
    tokenYSymbol: 'USDC',
    tokenMintX: 'So11111111111111111111111111111111111111112',
    tokenMintY: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
  {
    address: 'C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg',
    name: 'JUP-SOL',
    tvl: '$3.3M',
    tokenXSymbol: 'JUP',
    tokenYSymbol: 'SOL',
    tokenMintX: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    tokenMintY: 'So11111111111111111111111111111111111111112',
  },
  {
    address: '8Ve9KtGNtLRxCQNAVfkHEP5GRZHjdj6BjB1RQFZewG6V',
    name: '$WIF-SOL',
    tvl: '$1.9M',
    tokenXSymbol: '$WIF',
    tokenYSymbol: 'SOL',
    tokenMintX: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzL9HYxdM65zcjm',
    tokenMintY: 'So11111111111111111111111111111111111111112',
  },
  {
    address: 'J27e5izvX4nbaaRDjMKv7DogQzcPidCAECxzE6rK4bF7',
    name: 'JLP-USDC',
    tvl: '$2.9M',
    tokenXSymbol: 'JLP',
    tokenYSymbol: 'USDC',
    tokenMintX: 'JLPzabj7Fo6CRGvfMZZ4B8V5i2APtESc8YHYtpSrgK9',
    tokenMintY: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
];

function formatUsdCompact(value: unknown): string | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  if (numeric >= 1_000_000_000) return `$${(numeric / 1_000_000_000).toFixed(numeric >= 10_000_000_000 ? 0 : 1)}B`;
  if (numeric >= 1_000_000) return `$${(numeric / 1_000_000).toFixed(numeric >= 10_000_000 ? 0 : 1)}M`;
  if (numeric >= 1_000) return `$${(numeric / 1_000).toFixed(numeric >= 10_000 ? 0 : 1)}K`;
  return `$${Math.round(numeric)}`;
}

function firstMeteoraPoolToken(entry: Record<string, unknown>, side: 'x' | 'y'): Record<string, unknown> | undefined {
  const direct = entry[`mint_${side}`] ?? entry[`token_${side}`] ?? entry[`token${side.toUpperCase()}`];
  if (isRecord(direct)) return direct;
  const tokens = entry.tokens;
  if (Array.isArray(tokens)) {
    const index = side === 'x' ? 0 : 1;
    const token = tokens[index];
    if (isRecord(token)) return token;
  }
  return undefined;
}

function meteoraPoolOptionFromApi(entry: Record<string, unknown>): ConnectorOption | undefined {
  if (entry.is_blacklisted === true) return undefined;
  const address = pickIdentifier(entry, ['address', 'pool_address', 'poolAddress', 'lb_pair', 'lbPair']);
  if (!address) return undefined;
  const tokenX = firstMeteoraPoolToken(entry, 'x');
  const tokenY = firstMeteoraPoolToken(entry, 'y');
  const poolConfig = isRecord(entry.pool_config) ? entry.pool_config : undefined;
  const tokenXSymbol = asString(tokenX?.symbol) ?? asString(entry.token_x_symbol) ?? asString(entry.tokenXSymbol);
  const tokenYSymbol = asString(tokenY?.symbol) ?? asString(entry.token_y_symbol) ?? asString(entry.tokenYSymbol);
  const tokenMintX = pickIdentifier(tokenX ?? {}, ['address', 'mint', 'token_mint', 'tokenMint']) ??
    asString(entry.mint_x) ??
    asString(entry.tokenMintX);
  const tokenMintY = pickIdentifier(tokenY ?? {}, ['address', 'mint', 'token_mint', 'tokenMint']) ??
    asString(entry.mint_y) ??
    asString(entry.tokenMintY);
  const name = asString(entry.name) ??
    asString(entry.pool_name) ??
    (tokenXSymbol && tokenYSymbol ? `${tokenXSymbol}-${tokenYSymbol}` : undefined);
  const tvl = formatUsdCompact(entry.liquidity) ?? formatUsdCompact(entry.tvl) ?? asString(entry.tvl);
  const binStep = asDisplayString(entry.bin_step) ?? asDisplayString(entry.binStep) ?? asDisplayString(poolConfig?.bin_step);
  return {
    value: address,
    label: name ? `${name} DLMM` : `Pool ${address.slice(0, 6)}…`,
    detail: [tvl ? `TVL ${tvl}` : '', binStep ? `Bin step ${binStep}` : '', 'Meteora DLMM pool']
      .filter(Boolean)
      .join(' · '),
    group: 'all',
    meta: {
      tvl,
      tokenXSymbol,
      tokenYSymbol,
      tokenMintX,
      tokenMintY,
      binStep,
    },
  };
}

async function fetchMeteoraPoolsFromDataApi(query: string): Promise<ConnectorOption[]> {
  if (typeof fetch !== 'function') return [];
  const params = new URLSearchParams({
    query,
    page_size: '3',
    sort_by: 'tvl:desc',
  });
  const response = await fetch(`${METEORA_DATA_API_POOLS_URL}?${params.toString()}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) return [];
  const payload = await response.json();
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.pools)
        ? payload.pools
      : [];
  const options: ConnectorOption[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const option = meteoraPoolOptionFromApi(row);
    if (option) options.push(option);
  }
  return options;
}

async function fetchMeteoraCommonPoolsFromDataApi(): Promise<ConnectorOption[]> {
  const batches = await Promise.all(
    METEORA_COMMON_POOL_QUERIES.map(async (query) => {
      try {
        return await fetchMeteoraPoolsFromDataApi(query);
      } catch {
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  const options: ConnectorOption[] = [];
  for (const batch of batches) {
    for (const option of batch) {
      if (seen.has(option.value)) continue;
      seen.add(option.value);
      options.push(option);
      break;
    }
  }
  return options;
}

function meteoraCatalogOptions(seen: Set<string>): ConnectorOption[] {
  const options: ConnectorOption[] = [];
  for (const entry of METEORA_POOL_CATALOG) {
    if (seen.has(entry.address)) continue;
    seen.add(entry.address);
    options.push({
      value: entry.address,
      label: `${entry.name} DLMM`,
      detail: `TVL ${entry.tvl} · Meteora DLMM pool`,
      group: 'all',
      meta: {
        tvl: entry.tvl,
        tokenXSymbol: entry.tokenXSymbol,
        tokenYSymbol: entry.tokenYSymbol,
        tokenMintX: entry.tokenMintX,
        tokenMintY: entry.tokenMintY,
      },
    });
  }
  return options;
}

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
      const tokenXSymbol = asString(entry.tokenXSymbol) ?? asString(entry.tokenX);
      const tokenYSymbol = asString(entry.tokenYSymbol) ?? asString(entry.tokenY);
      const tokenMintX = asString(entry.tokenMintX);
      const tokenMintY = asString(entry.tokenMintY);
      positions.push({
        value: pool,
        label: name ? `${name} DLMM` : `Pool ${pool.slice(0, 6)}…`,
        detail: 'Existing position in this pool',
        group: 'positions',
        meta: { tokenXSymbol, tokenYSymbol, tokenMintX, tokenMintY },
      });
    }
    const pools: ConnectorOption[] = [];
    for (const entry of genericListing(poolsResp, ['pools'])) {
      const pool = pickIdentifier(entry, ['poolAddress', 'pool', 'address']);
      if (!pool || seen.has(pool)) continue;
      seen.add(pool);
      const name = asString(entry.poolName) ?? asString(entry.name);
      const tvl = asString(entry.tvl);
      const tokenXSymbol = asString(entry.tokenXSymbol) ?? asString(entry.tokenX);
      const tokenYSymbol = asString(entry.tokenYSymbol) ?? asString(entry.tokenY);
      const tokenMintX = asString(entry.tokenMintX);
      const tokenMintY = asString(entry.tokenMintY);
      pools.push({
        value: pool,
        label: name ? `${name} DLMM` : `Pool ${pool.slice(0, 6)}…`,
        detail: tvl ? `TVL ${tvl}` : 'Meteora DLMM pool',
        group: 'all',
        meta: { tvl, tokenXSymbol, tokenYSymbol, tokenMintX, tokenMintY },
      });
    }
    if (pools.length === 0) {
      for (const option of await fetchMeteoraCommonPoolsFromDataApi()) {
        if (seen.has(option.value)) continue;
        seen.add(option.value);
        pools.push(option);
      }
    }
    if (pools.length === 0) {
      pools.push(...meteoraCatalogOptions(seen));
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
const ORCA_WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const ORCA_WHIRLPOOL_CATALOG: LiquidityPoolCatalogEntry[] = [
  {
    address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
    name: 'SOL/USDC 0.04%',
    tvl: '$29M',
    tokenASymbol: 'SOL',
    tokenBSymbol: 'USDC',
    tokenAMint: SOL_MINT,
    tokenBMint: USDC_MINT,
    feeBps: '4',
    poolType: 'whirlpool',
    programId: ORCA_WHIRLPOOL_PROGRAM_ID,
  },
  {
    address: '4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4',
    name: 'SOL/USDC 0.05%',
    tvl: '$10M',
    tokenASymbol: 'SOL',
    tokenBSymbol: 'USDC',
    tokenAMint: SOL_MINT,
    tokenBMint: USDC_MINT,
    feeBps: '5',
    poolType: 'whirlpool',
    programId: ORCA_WHIRLPOOL_PROGRAM_ID,
  },
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
        meta: orcaEntryMeta(entry),
      });
    }
    const pools: ConnectorOption[] = [];
    for (const entry of genericListing(poolsResp, ['whirlpools', 'pools'])) {
      const pool = pickIdentifier(entry, ['whirlpoolAddress', 'whirlpool', 'address']);
      if (!pool || seen.has(pool)) continue;
      seen.add(pool);
      const name = asString(entry.poolName) ?? asString(entry.name);
      const tvl = asString(entry.tvl);
      const meta = {
        ...orcaEntryMeta(entry),
        ...(tvl !== undefined && { tvl }),
      };
      pools.push({
        value: pool,
        label: name ? `${name} whirlpool` : `Whirlpool ${pool.slice(0, 6)}…`,
        detail: tvl ? `TVL ${tvl}` : 'Orca whirlpool',
        group: 'all',
        meta,
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
          meta: liquidityCatalogMeta(entry),
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

const MAGICEDEN_COLLECTION_CATALOG: Array<{ id: string; name: string; detail: string }> = [
  { id: 'mad_lads', name: 'Mad Lads', detail: 'Magic Eden popular collection' },
  { id: 'famous_fox_federation', name: 'Famous Fox Federation', detail: 'Magic Eden popular collection' },
  { id: 'okay_bears', name: 'Okay Bears', detail: 'Magic Eden popular collection' },
  { id: 'tensorians', name: 'Tensorians', detail: 'Magic Eden popular collection' },
  { id: 'claynosaurz', name: 'Claynosaurz', detail: 'Magic Eden popular collection' },
  { id: 'smb_gen2', name: 'SMB Gen2', detail: 'Magic Eden popular collection' },
];

const TENSOR_COLLECTION_CATALOG: Array<{ id: string; name: string; detail: string }> = [
  { id: 'madlads', name: 'Mad Lads', detail: 'Tensor supported collection' },
  { id: 'tensorians', name: 'Tensorians', detail: 'Tensor supported collection' },
  { id: 'claynosaurz', name: 'Claynosaurz', detail: 'Tensor supported collection' },
  { id: 'okay_bears', name: 'Okay Bears', detail: 'Tensor supported collection' },
  { id: 'famous_fox_federation', name: 'Famous Fox Federation', detail: 'Tensor supported collection' },
  { id: 'solana_monkey_business', name: 'Solana Monkey Business', detail: 'Tensor supported collection' },
];

function nftCollectionCatalog(connectorId: 'magiceden' | 'tensor'): Array<{ id: string; name: string; detail: string }> {
  return connectorId === 'magiceden' ? MAGICEDEN_COLLECTION_CATALOG : TENSOR_COLLECTION_CATALOG;
}

function nftCollectionIdentifier(entry: Record<string, unknown>, connectorId: 'magiceden' | 'tensor'): string | undefined {
  return connectorId === 'magiceden'
    ? pickIdentifier(entry, ['collectionSymbol', 'symbol', 'slug', 'collectionId', 'id'])
    : pickIdentifier(entry, ['collectionId', 'slug', 'symbol', 'collectionSymbol', 'id']);
}

function nftCollectionLabel(entry: Record<string, unknown>, value: string): string {
  return asString(entry.name) ??
    asString(entry.displayName) ??
    asString(entry.collectionName) ??
    value;
}

function nftCollectionDetail(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  const rank = asDisplayString(entry.rank);
  const floor = asDisplayString(entry.floorPriceSol) ?? asDisplayString(entry.floorPrice) ?? asDisplayString(entry.floor);
  const volume = asDisplayString(entry.volume24hSol) ?? asDisplayString(entry.volume24h) ?? asDisplayString(entry.volume);
  const listed = asDisplayString(entry.listedCount) ?? asDisplayString(entry.numListed) ?? asDisplayString(entry.listings);
  if (rank) parts.push(`#${rank}`);
  if (floor) parts.push(`Floor ${floor} SOL`);
  if (volume) parts.push(`24h ${volume} SOL`);
  if (listed) parts.push(`${listed} listed`);
  return parts.join(' · ') || 'NFT collection';
}

function buildNftCollectionProvider(id: string, connectorId: 'magiceden' | 'tensor'): ConnectorOptionProvider {
  return {
    id,
    connectorId,
    ttlMs: 5 * 60_000,
    async fetch({ bridge }) {
      const resp = await safeBridgeFacts(bridge, { connectorId, capability: 'markets', limit: 25 });
      const seen = new Set<string>();
      const out: ConnectorOption[] = [];
      for (const entry of genericListing(resp, ['collections'])) {
        const collection = nftCollectionIdentifier(entry, connectorId);
        if (!collection || seen.has(collection)) continue;
        seen.add(collection);
        const name = nftCollectionLabel(entry, collection);
        out.push({
          value: collection,
          label: name,
          detail: nftCollectionDetail(entry),
          group: 'all',
          meta: { symbol: asString(entry.symbol) ?? asString(entry.collectionSymbol) ?? asString(entry.slug) },
        });
      }
      if (out.length === 0) {
        for (const entry of nftCollectionCatalog(connectorId)) {
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
      const mint = pickIdentifier(entry, ['mintAddress', 'mint', 'sourceMint', 'address']);
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
    const resp = await safeBridgeFacts(bridge, { connectorId: 'wormhole', capability: 'markets', sourceMint });
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

const PYTH_COMMON_FEEDS: Array<{ symbol: string; feedId: string; displayName: string }> = [
  {
    symbol: 'SOL/USD',
    feedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    displayName: 'Solana / US Dollar',
  },
  {
    symbol: 'USDC/USD',
    feedId: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
    displayName: 'USD Coin / US Dollar',
  },
  {
    symbol: 'USDT/USD',
    feedId: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
    displayName: 'Tether USD / US Dollar',
  },
  {
    symbol: 'JITOSOL/USD',
    feedId: '67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb',
    displayName: 'Jito SOL / US Dollar',
  },
  {
    symbol: 'MSOL/USD',
    feedId: 'c2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4',
    displayName: 'Marinade SOL / US Dollar',
  },
  {
    symbol: 'BSOL/USD',
    feedId: '89875379e70f8fbadc17aef315adf3a8d5d160b811435537e03c97e8aac97d9c',
    displayName: 'BlazeStake SOL / US Dollar',
  },
  {
    symbol: 'BTC/USD',
    feedId: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    displayName: 'Bitcoin / US Dollar',
  },
  {
    symbol: 'ETH/USD',
    feedId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    displayName: 'Ethereum / US Dollar',
  },
];

const pythFeedProvider: ConnectorOptionProvider = {
  id: 'pyth.feed',
  connectorId: 'pyth',
  ttlMs: 10 * 60_000,
  async fetch({ bridge }) {
    const resp = await safeBridgeFacts(bridge, { connectorId: 'pyth', capability: 'markets' });
    const out: ConnectorOption[] = [];
    const seen = new Set<string>();
    for (const entry of genericListing(resp, ['feeds'])) {
      const id = pickIdentifier(entry, ['feedId', 'id', 'priceFeedId']);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const symbol = asString(entry.symbol);
      out.push({
        value: id,
        label: symbol ?? id.slice(0, 12),
        detail: asString(entry.assetClass) ?? 'Pyth feed',
        group: 'all',
        meta: { symbol },
      });
    }
    if (out.length === 0) {
      for (const entry of PYTH_COMMON_FEEDS) {
        out.push({
          value: entry.feedId,
          label: entry.symbol,
          detail: entry.displayName,
          group: 'all',
          meta: { symbol: entry.symbol },
        });
      }
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
  registerConnectorOptionProvider(project0BankProvider);
  registerConnectorOptionProvider(saveReserveProvider);
  registerConnectorOptionProvider(driftVaultProvider);
  registerConnectorOptionProvider(luloMintProvider);
  registerConnectorOptionProvider(raydiumPoolProvider);
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
