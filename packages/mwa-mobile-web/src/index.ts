import type { Wallet } from '@wallet-standard/base';

export type MwaMobileWebLogLevel = 'silent' | 'info';

export interface AgentMwaAppIdentity {
  name: string;
  uri: string;
  icon?: string;
}

export interface RegisterAgentMobileWalletAdapterOptions {
  appIdentity: AgentMwaAppIdentity;
  chains?: ReadonlyArray<'solana:devnet' | 'solana:testnet' | 'solana:mainnet' | 'solana:mainnet-beta'>;
  logLevel?: MwaMobileWebLogLevel;
}

export interface MwaEnvironment {
  isBrowser: boolean;
  isAndroid: boolean;
  isChrome: boolean;
  isIos: boolean;
  isSafari: boolean;
  supportsMwaMobileWeb: boolean;
  supportsIosWalletStandardFallback: boolean;
  userAgent: string;
}

export interface RegisterAgentMobileWalletAdapterResult {
  registered: boolean;
  skippedReason?: 'not_browser' | 'already_registered' | 'unsupported_environment' | 'registration_failed';
  environment: MwaEnvironment;
}

type RegisterMwaModule = typeof import('@solana-mobile/wallet-standard-mobile');

const MWA_WALLET_NAME_HINTS = ['mobile wallet adapter', 'mobile wallet', 'mwa'];

let registered = false;

export async function registerAgentMobileWalletAdapter(
  options: RegisterAgentMobileWalletAdapterOptions,
): Promise<RegisterAgentMobileWalletAdapterResult> {
  const environment = detectMwaEnvironment();
  const logLevel = options.logLevel ?? 'info';

  if (!environment.isBrowser) {
    log(logLevel, 'register', 'SKIP reason=not_browser');
    return { registered: false, skippedReason: 'not_browser', environment };
  }

  if (!environment.supportsMwaMobileWeb) {
    log(
      logLevel,
      'register',
      `SKIP reason=unsupported_environment android=${environment.isAndroid} chrome=${environment.isChrome} ios=${environment.isIos} safari=${environment.isSafari}`,
    );
    return { registered: false, skippedReason: 'unsupported_environment', environment };
  }

  if (registered) {
    log(logLevel, 'register', 'SKIP reason=already_registered');
    return { registered: false, skippedReason: 'already_registered', environment };
  }

  try {
    const module = await import('@solana-mobile/wallet-standard-mobile');
    module.registerMwa({
      appIdentity: {
        name: options.appIdentity.name,
        uri: options.appIdentity.uri,
        ...(options.appIdentity.icon !== undefined && { icon: options.appIdentity.icon }),
      },
      authorizationCache: module.createDefaultAuthorizationCache(),
      chains: normalizeChains(options.chains),
      chainSelector: module.createDefaultChainSelector(),
      onWalletNotFound: module.createDefaultWalletNotFoundHandler(),
    });
    registered = true;
    log(
      logLevel,
      'register',
      `DONE android=${environment.isAndroid} chrome=${environment.isChrome} chains=${normalizeChains(options.chains).join(',')}`,
    );
    return { registered: true, environment };
  } catch (err) {
    log(logLevel, 'register', `FAIL error="${err instanceof Error ? err.message : String(err)}"`);
    return { registered: false, skippedReason: 'registration_failed', environment };
  }
}

export function detectMwaEnvironment(userAgent = globalUserAgent()): MwaEnvironment {
  const globals = globalThis as { window?: unknown; document?: unknown };
  const isBrowser = globals.window !== undefined && globals.document !== undefined;
  const normalized = userAgent.toLowerCase();
  const isAndroid = normalized.includes('android');
  const isChrome =
    normalized.includes('chrome/') &&
    !normalized.includes('edg/') &&
    !normalized.includes('opr/') &&
    !normalized.includes('firefox/');
  const isIos =
    normalized.includes('iphone') ||
    normalized.includes('ipad') ||
    normalized.includes('ipod') ||
    (normalized.includes('macintosh') && normalized.includes('mobile/'));
  const isSafari =
    normalized.includes('safari/') &&
    !normalized.includes('chrome/') &&
    !normalized.includes('crios/') &&
    !normalized.includes('fxios/') &&
    !normalized.includes('edgios/');
  const supportsMwaMobileWeb = isBrowser && isAndroid && isChrome;
  return {
    isBrowser,
    isAndroid,
    isChrome,
    isIos,
    isSafari,
    supportsMwaMobileWeb,
    supportsIosWalletStandardFallback: isBrowser && isIos,
    userAgent,
  };
}

export function isMobileWalletAdapterWallet(wallet: Pick<Wallet, 'name'>): boolean {
  const normalized = wallet.name.toLowerCase();
  return MWA_WALLET_NAME_HINTS.some((hint) => normalized.includes(hint));
}

export function __resetAgentMwaRegistrationForTests(): void {
  registered = false;
}

function normalizeChains(
  chains: RegisterAgentMobileWalletAdapterOptions['chains'],
): ReadonlyArray<'solana:devnet' | 'solana:testnet' | 'solana:mainnet'> {
  const selected = chains ?? ['solana:devnet', 'solana:mainnet'];
  return selected.map((chain) => (chain === 'solana:mainnet-beta' ? 'solana:mainnet' : chain));
}

function globalUserAgent(): string {
  const globals = globalThis as { navigator?: { userAgent?: string } };
  if (globals.navigator === undefined) {
    return '';
  }
  return globals.navigator.userAgent ?? '';
}

function log(level: MwaMobileWebLogLevel, op: string, message: string): void {
  if (level === 'silent') {
    return;
  }
  console.info(`[AgentMWA] ${op} | ${message}`);
}
