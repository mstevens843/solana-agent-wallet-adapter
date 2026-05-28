export type LedgerPathFamily = 'default' | 'legacy';

export interface LedgerAccountPath {
  derivationPath: string;
  family: LedgerPathFamily;
  index: number;
  order: number;
}

export interface LedgerDerivedAccount extends LedgerAccountPath {
  address: string;
  publicKeyB64: string;
}

export interface LedgerAccountCandidate extends LedgerDerivedAccount {
  solBalanceLamports: number | null;
  solBalanceLabel: string;
  balanceStatus: 'loaded' | 'unavailable';
  hasActivity: boolean | null;
  activityStatus: 'loaded' | 'unavailable';
  lastSelected: boolean;
}

export interface LedgerAccountOrderingContext {
  lastSelectedAddress?: string | null;
}

export function ledgerDerivationPath(family: LedgerPathFamily, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Ledger account index must be a non-negative integer; received ${index}.`);
  }
  if (family === 'default') return `m/44'/501'/${index}'/0'`;
  return `m/44'/501'/${index}'`;
}

export function ledgerAccountPaths(input: {
  defaultStart: number;
  defaultCount: number;
  legacyStart: number;
  legacyCount: number;
}): LedgerAccountPath[] {
  const paths: LedgerAccountPath[] = [];
  for (let i = 0; i < input.defaultCount; i += 1) {
    const index = input.defaultStart + i;
    paths.push({
      derivationPath: ledgerDerivationPath('default', index),
      family: 'default',
      index,
      order: index,
    });
  }
  for (let i = 0; i < input.legacyCount; i += 1) {
    const index = input.legacyStart + i;
    paths.push({
      derivationPath: ledgerDerivationPath('legacy', index),
      family: 'legacy',
      index,
      order: 10_000 + index,
    });
  }
  return paths;
}

export function ledgerAccountLabel(account: Pick<LedgerAccountPath, 'family' | 'index'>): string {
  return account.family === 'default'
    ? `Account ${account.index}`
    : `Legacy ${account.index}`;
}

export function mergeLedgerDerivedAccounts(
  paths: readonly LedgerAccountPath[],
  derived: readonly { derivationPath: string; address: string; publicKeyB64: string }[],
): LedgerDerivedAccount[] {
  const byPath = new Map(paths.map((path) => [path.derivationPath, path]));
  const out: LedgerDerivedAccount[] = [];
  for (const entry of derived) {
    const path = byPath.get(entry.derivationPath);
    if (!path) continue;
    out.push({
      ...path,
      address: entry.address,
      publicKeyB64: entry.publicKeyB64,
    });
  }
  return out;
}

export function formatLedgerSolBalance(lamports: number | null | undefined): string {
  if (typeof lamports !== 'number' || !Number.isFinite(lamports)) return 'Balance unavailable';
  if (lamports === 0) return '0.00 SOL';
  const sign = lamports < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(lamports));
  const whole = Math.floor(abs / 1_000_000_000);
  const fraction = String(abs % 1_000_000_000).padStart(9, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''} SOL`;
}

export function toLedgerAccountCandidate(
  account: LedgerDerivedAccount,
  enrichment: {
    solBalanceLamports?: number | null;
    balanceUnavailable?: boolean;
    hasActivity?: boolean | null;
    activityUnavailable?: boolean;
  } = {},
): LedgerAccountCandidate {
  const balanceUnavailable = enrichment.balanceUnavailable === true;
  const solBalanceLamports = balanceUnavailable
    ? null
    : typeof enrichment.solBalanceLamports === 'number'
      ? enrichment.solBalanceLamports
      : null;
  const activityUnavailable = enrichment.activityUnavailable === true;
  return {
    ...account,
    solBalanceLamports,
    solBalanceLabel: formatLedgerSolBalance(solBalanceLamports),
    balanceStatus: balanceUnavailable ? 'unavailable' : 'loaded',
    hasActivity: activityUnavailable ? null : enrichment.hasActivity ?? null,
    activityStatus: activityUnavailable ? 'unavailable' : 'loaded',
    lastSelected: false,
  };
}

export function rankLedgerAccounts(
  accounts: readonly LedgerAccountCandidate[],
  context: LedgerAccountOrderingContext = {},
): LedgerAccountCandidate[] {
  const lastSelectedAddress = context.lastSelectedAddress?.trim() || '';
  return accounts
    .map((account) => ({
      ...account,
      lastSelected: Boolean(lastSelectedAddress && account.address === lastSelectedAddress),
    }))
    .sort((a, b) => {
      const lastDelta = Number(b.lastSelected) - Number(a.lastSelected);
      if (lastDelta !== 0) return lastDelta;

      const aBalance = a.solBalanceLamports ?? 0;
      const bBalance = b.solBalanceLamports ?? 0;
      const nonzeroDelta = Number(bBalance > 0) - Number(aBalance > 0);
      if (nonzeroDelta !== 0) return nonzeroDelta;
      if (aBalance !== bBalance) return bBalance - aBalance;

      const activityDelta = Number(b.hasActivity === true) - Number(a.hasActivity === true);
      if (activityDelta !== 0) return activityDelta;

      return a.order - b.order;
    });
}

export function mergeLedgerAccountCandidates(
  existing: readonly LedgerAccountCandidate[],
  incoming: readonly LedgerAccountCandidate[],
): LedgerAccountCandidate[] {
  const byPath = new Map<string, LedgerAccountCandidate>();
  for (const account of existing) byPath.set(account.derivationPath, account);
  for (const account of incoming) byPath.set(account.derivationPath, account);
  return Array.from(byPath.values());
}
