export const BROWSER_WALLET_SESSION_VERSION = 1;
export const BROWSER_WALLET_PLACEHOLDER_VALUE = '';
export const BROWSER_WALLET_PLACEHOLDER_LABEL = 'Choose wallet';

export interface BrowserWalletCandidate {
  name: string;
}

export interface BrowserWalletSession {
  version: typeof BROWSER_WALLET_SESSION_VERSION;
  walletName: string;
  cluster: string;
  connectedAt: string;
}

export interface BrowserWalletPickerOption {
  value: string;
  label: string;
  meta?: string;
  detail?: string;
  disabled?: boolean;
}

export function createBrowserWalletSession(
  walletName: string,
  cluster: string,
  connectedAt = new Date().toISOString(),
): BrowserWalletSession {
  return {
    version: BROWSER_WALLET_SESSION_VERSION,
    walletName,
    cluster,
    connectedAt,
  };
}

export function isPersistedBrowserWalletSession(value: unknown): value is BrowserWalletSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrowserWalletSession>;
  return (
    candidate.version === BROWSER_WALLET_SESSION_VERSION &&
    nonEmptyString(candidate.walletName) &&
    nonEmptyString(candidate.cluster) &&
    nonEmptyString(candidate.connectedAt)
  );
}

export function discoveredSelectedWalletName(
  wallets: ReadonlyArray<BrowserWalletCandidate>,
  selectedWalletName: string,
): string {
  const selected = findWalletByName(wallets, selectedWalletName);
  return selected?.name ?? '';
}

export function reconcileBrowserWalletSelection(
  wallets: ReadonlyArray<BrowserWalletCandidate>,
  selectedWalletName: string,
): string {
  return discoveredSelectedWalletName(wallets, selectedWalletName);
}

export function hasDiscoveredBrowserWalletSelection(
  wallets: ReadonlyArray<BrowserWalletCandidate>,
  selectedWalletName: string,
): boolean {
  return Boolean(discoveredSelectedWalletName(wallets, selectedWalletName));
}

export function browserWalletRestoreName(
  wallets: ReadonlyArray<BrowserWalletCandidate>,
  session: BrowserWalletSession | undefined,
  cluster: string,
): string {
  if (!session || session.cluster !== cluster) return '';
  return discoveredSelectedWalletName(wallets, session.walletName);
}

export function browserWalletPickerOptions(
  wallets: ReadonlyArray<BrowserWalletCandidate>,
): BrowserWalletPickerOption[] {
  if (wallets.length === 0) {
    return [
      {
        value: BROWSER_WALLET_PLACEHOLDER_VALUE,
        label: 'No wallets discovered',
        meta: 'Wallet provider',
        disabled: true,
      },
    ];
  }
  return [
    {
      value: BROWSER_WALLET_PLACEHOLDER_VALUE,
      label: BROWSER_WALLET_PLACEHOLDER_LABEL,
      meta: 'Wallet provider',
      detail: 'Select an installed provider before connecting.',
      disabled: true,
    },
    ...wallets.map((wallet) => ({
      value: wallet.name,
      label: wallet.name,
      meta: 'Wallet provider',
    })),
  ];
}

function findWalletByName(
  wallets: ReadonlyArray<BrowserWalletCandidate>,
  walletName: string,
): BrowserWalletCandidate | undefined {
  const normalized = normalizeWalletName(walletName);
  if (!normalized) return undefined;
  return wallets.find((wallet) => normalizeWalletName(wallet.name) === normalized);
}

function normalizeWalletName(value: string): string {
  return value.trim().toLowerCase();
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
