export type WalletProviderLogoId = 'backpack' | 'phantom' | 'solflare' | 'jupiter' | 'seedVault';

export interface AndroidWalletBrandStatus {
  walletType?: number;
  walletPackage?: string;
  walletUriBase?: string;
  walletIcon?: string;
  accountLabel?: string;
}

interface WalletBrand {
  displayName: string;
  logoId: WalletProviderLogoId;
  walletTypes?: readonly number[];
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
    walletTypes: [25],
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
    walletTypes: [50],
    matchers: [
      'seed vault',
      'seedvault',
      'seed-vault',
      'seedvaultimpl',
      'seedvaultwallet',
      'solanamobilewallet',
      'solana mobile wallet',
    ],
  },
];

const WALLET_PROVIDER_LOGO_IDS = new Set<WalletProviderLogoId>([
  'backpack',
  'phantom',
  'solflare',
  'jupiter',
  'seedVault',
]);

const SEED_VAULT_ICON_HEAD = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAANgAAADY';
const SEED_VAULT_ICON_TAIL_SENTINEL =
  'QChlppOaiUo1Z22pIwKl0xN6leqUK+T8P/q4PWPnCdaVAAAAAElFTkSuQmCC';

export function walletLogoIdForProviderName(name: string): WalletProviderLogoId | undefined {
  return walletBrandForText(name)?.logoId;
}

export function androidWalletDisplayNameFromStatus(status: AndroidWalletBrandStatus | null): string {
  const brand = walletBrandForAndroidStatus(status);
  if (brand) return brand.displayName;
  const accountLabel = status?.accountLabel?.trim();
  if (accountLabel) return accountLabel;
  return 'Mobile Wallet Adapter';
}

export function walletLogoIdFromAndroidStatus(status: AndroidWalletBrandStatus | null): WalletProviderLogoId | undefined {
  return walletBrandForAndroidStatus(status)?.logoId;
}

export function isWalletProviderLogoId(value: unknown): value is WalletProviderLogoId {
  return typeof value === 'string' && WALLET_PROVIDER_LOGO_IDS.has(value as WalletProviderLogoId);
}

function walletBrandForType(walletType: number | undefined): WalletBrand | undefined {
  if (typeof walletType !== 'number') return undefined;
  return WALLET_BRANDS.find((brand) => brand.walletTypes?.includes(walletType));
}

function walletBrandForAndroidStatus(status: AndroidWalletBrandStatus | null): WalletBrand | undefined {
  return (
    walletBrandForType(status?.walletType) ??
    walletBrandForText(status?.walletPackage ?? '') ??
    walletBrandForText(status?.walletUriBase ?? '') ??
    walletBrandForKnownIcon(status?.walletIcon ?? '') ??
    walletBrandForText(status?.walletIcon ?? '') ??
    walletBrandForText(status?.accountLabel ?? '')
  );
}

function walletBrandForText(value: string): WalletBrand | undefined {
  const normalized = normalizeWalletBrandText(value);
  if (!normalized) return undefined;
  return WALLET_BRANDS.find((brand) =>
    brand.matchers.some((matcher) => normalized.includes(normalizeWalletBrandText(matcher))),
  );
}

function walletBrandForKnownIcon(walletIcon: string): WalletBrand | undefined {
  const normalized = normalizeWalletIconSignature(walletIcon);
  if (!normalized) return undefined;
  if (normalized.includes(SEED_VAULT_ICON_HEAD) && normalized.includes(SEED_VAULT_ICON_TAIL_SENTINEL)) {
    return WALLET_BRANDS.find((brand) => brand.logoId === 'seedVault');
  }
  return undefined;
}

function normalizeWalletBrandText(value: string): string {
  return value.trim().replace(/\\\//g, '/').toLowerCase().replace(/[_./:-]+/g, ' ');
}

function normalizeWalletIconSignature(value: string): string {
  return value.trim().replace(/\\\//g, '/').replace(/\\n/g, '').replace(/\s+/g, '');
}
