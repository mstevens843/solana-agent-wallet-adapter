export type WalletProviderLogoId = 'backpack' | 'phantom' | 'solflare' | 'jupiter' | 'seedVault';

export interface AndroidWalletBrandStatus {
  walletPackage?: string;
  walletUriBase?: string;
  accountLabel?: string;
}

interface WalletBrand {
  displayName: string;
  logoId: WalletProviderLogoId;
  matchers: readonly string[];
}

const WALLET_BRANDS: readonly WalletBrand[] = [
  {
    displayName: 'Backpack',
    logoId: 'backpack',
    matchers: ['backpack'],
  },
  {
    displayName: 'Phantom',
    logoId: 'phantom',
    matchers: ['phantom'],
  },
  {
    displayName: 'Solflare',
    logoId: 'solflare',
    matchers: ['solflare'],
  },
  {
    displayName: 'Jupiter',
    logoId: 'jupiter',
    matchers: ['jupiter', 'jup.ag'],
  },
  {
    displayName: 'Seed Vault',
    logoId: 'seedVault',
    matchers: [
      'seed vault',
      'seedvault',
      'seed-vault',
      'seedvaultimpl',
      'solanamobilewallet',
      'solana mobile wallet',
    ],
  },
];

export function walletLogoIdForProviderName(name: string): WalletProviderLogoId | undefined {
  return walletBrandForText(name)?.logoId;
}

export function androidWalletDisplayNameFromStatus(status: AndroidWalletBrandStatus | null): string {
  const brand =
    walletBrandForText(status?.walletPackage ?? '') ??
    walletBrandForText(status?.walletUriBase ?? '') ??
    walletBrandForText(status?.accountLabel ?? '');
  if (brand) return brand.displayName;
  const accountLabel = status?.accountLabel?.trim();
  if (accountLabel) return accountLabel;
  return 'Mobile Wallet Adapter';
}

function walletBrandForText(value: string): WalletBrand | undefined {
  const normalized = normalizeWalletBrandText(value);
  if (!normalized) return undefined;
  return WALLET_BRANDS.find((brand) =>
    brand.matchers.some((matcher) => normalized.includes(normalizeWalletBrandText(matcher))),
  );
}

function normalizeWalletBrandText(value: string): string {
  return value.trim().toLowerCase().replace(/[_./:-]+/g, ' ');
}
