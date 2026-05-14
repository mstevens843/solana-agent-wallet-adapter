export const DRIFT_VAULT_CATALOG_URL =
  'https://drift-public.s3.eu-central-1.amazonaws.com/vaults/configs.json';

export interface DriftVaultCatalogEntry {
  vaultAddress: string;
  vaultPubkey: string;
  name: string;
  vaultName: string;
  managerName?: string;
  depositAsset?: number;
  depositSymbol?: string;
  description?: string;
  featured?: boolean;
  source: 'drift-public-vault-config';
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

const DRIFT_DEPOSIT_ASSET_SYMBOLS: Record<number, string> = {
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

export async function fetchDriftVaultCatalog(
  fetchImpl: FetchLike = defaultFetch,
): Promise<DriftVaultCatalogEntry[]> {
  const response = await fetchImpl(DRIFT_VAULT_CATALOG_URL, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Drift vault catalog returned HTTP ${response.status}.`);
  }

  const raw = await response.json();
  if (!Array.isArray(raw)) {
    throw new Error('Drift vault catalog response was not an array.');
  }

  const seen = new Set<string>();
  const vaults: DriftVaultCatalogEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item) || item.hidden === true) continue;
    const vaultAddress = asString(item.vaultPubkeyString) ??
      asString(item.vaultAddress) ??
      asString(item.address);
    const name = asString(item.name) ?? asString(item.vaultName);
    if (!vaultAddress || !name || seen.has(vaultAddress)) continue;
    seen.add(vaultAddress);

    const manager = isRecord(item.vaultManager) ? item.vaultManager : undefined;
    const managerName = asString(manager?.name) ?? asString(item.managerName);
    const depositAsset = asNumber(item.depositAsset);
    const depositSymbol = asString(item.depositSymbol) ??
      (depositAsset !== undefined ? DRIFT_DEPOSIT_ASSET_SYMBOLS[depositAsset] : undefined);
    const description = asString(item.description);

    vaults.push({
      vaultAddress,
      vaultPubkey: vaultAddress,
      name,
      vaultName: name,
      ...(managerName !== undefined && { managerName }),
      ...(depositAsset !== undefined && { depositAsset }),
      ...(depositSymbol !== undefined && { depositSymbol }),
      ...(description !== undefined && { description }),
      ...(typeof item.featured === 'boolean' && { featured: item.featured }),
      source: 'drift-public-vault-config',
    });
  }
  return vaults;
}

async function defaultFetch(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<FetchResponseLike> {
  const fetcher = (globalThis as typeof globalThis & { fetch?: FetchLike }).fetch;
  if (!fetcher) {
    throw new Error('fetch is not available to load the Drift vault catalog.');
  }
  return fetcher(url, init);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
