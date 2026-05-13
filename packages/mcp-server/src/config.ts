import { readFile } from 'node:fs/promises';

import { ProtocolError, type Cluster } from '@solana-agent-wallet-adapter/core';

export interface TokenLimitConfig {
  symbol: string;
  mint: string;
  decimals: number;
  maxTransfer: string;
}

export interface AgentWalletConfig {
  cluster: Cluster;
  rpcUrl: string;
  mainnet: {
    enabled: boolean;
    maxSolTransfer: string;
    maxSwapInput: string;
    maxSlippageBps: number;
    allowArbitraryTransactions: boolean;
  };
  tokens: TokenLimitConfig[];
  jupiter: {
    /** Legacy swap/order base URL. Prefer swapBaseUrl for new config. */
    baseUrl: string;
    swapBaseUrl?: string;
    lendBaseUrl?: string;
    triggerBaseUrl?: string;
    recurringBaseUrl?: string;
    tokensBaseUrl?: string;
    priceBaseUrl?: string;
    predictionBaseUrl?: string;
    apiKeyEnv: string;
  };
  recurring?: RecurringPolicyConfig;
  recipients?: Record<string, RecipientCapConfig>;
  connectors?: ConnectorPolicyConfig;
}

export interface RecurringPolicyConfig {
  maxLifetimeAmount?: Record<string, string>;
  maxPerWeekAmount?: Record<string, string>;
  maxPerMonthAmount?: Record<string, string>;
}

export interface RecipientCapConfig {
  label?: string;
  lifetimeMax?: Record<string, string>;
  perMonthMax?: Record<string, string>;
}

export interface ConnectorPolicyConfig {
  marginfi?: MarginfiPolicyConfig;
}

export interface MarginfiPolicyConfig {
  minHealthRatio?: number;
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
export const WIF_MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
export const PYUSD_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
export const MSOL_MINT = 'mSoLzYCxHdYgdzU16g5QSh3KZK7ytfqcJm7So';

export const DEFAULT_JUPITER_SWAP_BASE_URL = 'https://api.jup.ag/swap/v2';
export const DEFAULT_JUPITER_LEND_BASE_URL = 'https://api.jup.ag/lend/v1';
export const DEFAULT_JUPITER_TRIGGER_BASE_URL = 'https://api.jup.ag/trigger/v2';
export const DEFAULT_JUPITER_RECURRING_BASE_URL = 'https://api.jup.ag/recurring/v1';
export const DEFAULT_JUPITER_TOKENS_BASE_URL = 'https://api.jup.ag/tokens/v2';
export const DEFAULT_JUPITER_PRICE_BASE_URL = 'https://api.jup.ag/price/v3';
export const DEFAULT_JUPITER_PREDICTION_BASE_URL = 'https://api.jup.ag/prediction/v1';

export const DEFAULT_TOKEN_REGISTRY: TokenLimitConfig[] = [
  {
    symbol: 'USDC',
    mint: USDC_MINT,
    decimals: 6,
    maxTransfer: '25',
  },
  {
    symbol: 'JUP',
    mint: JUP_MINT,
    decimals: 6,
    maxTransfer: '25',
  },
  {
    symbol: 'BONK',
    mint: BONK_MINT,
    decimals: 5,
    maxTransfer: '1000000',
  },
  {
    symbol: 'WIF',
    mint: WIF_MINT,
    decimals: 6,
    maxTransfer: '25',
  },
  {
    symbol: 'PYUSD',
    mint: PYUSD_MINT,
    decimals: 6,
    maxTransfer: '25',
  },
  {
    symbol: 'mSOL',
    mint: MSOL_MINT,
    decimals: 9,
    maxTransfer: '25',
  },
];

export const DEFAULT_CONFIG: AgentWalletConfig = {
  cluster: 'mainnet-beta',
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  mainnet: {
    enabled: true,
    maxSolTransfer: '0.05',
    maxSwapInput: '0.05',
    maxSlippageBps: 100,
    allowArbitraryTransactions: true,
  },
  tokens: DEFAULT_TOKEN_REGISTRY,
  jupiter: {
    baseUrl: DEFAULT_JUPITER_SWAP_BASE_URL,
    swapBaseUrl: DEFAULT_JUPITER_SWAP_BASE_URL,
    lendBaseUrl: DEFAULT_JUPITER_LEND_BASE_URL,
    triggerBaseUrl: DEFAULT_JUPITER_TRIGGER_BASE_URL,
    recurringBaseUrl: DEFAULT_JUPITER_RECURRING_BASE_URL,
    tokensBaseUrl: DEFAULT_JUPITER_TOKENS_BASE_URL,
    priceBaseUrl: DEFAULT_JUPITER_PRICE_BASE_URL,
    predictionBaseUrl: DEFAULT_JUPITER_PREDICTION_BASE_URL,
    apiKeyEnv: 'JUPITER_API_KEY',
  },
  connectors: {
    marginfi: {
      minHealthRatio: 1.1,
    },
  },
};

export async function loadConfig(path: string | undefined): Promise<AgentWalletConfig> {
  if (!path) {
    return DEFAULT_CONFIG;
  }
  const raw = await readFile(path, 'utf8');
  return normalizeConfig(JSON.parse(raw) as Partial<AgentWalletConfig>);
}

export function normalizeConfig(input: Partial<AgentWalletConfig>): AgentWalletConfig {
  const cluster = input.cluster ?? DEFAULT_CONFIG.cluster;
  const rpcUrl = firstEnvValue('SOLANA_RPC_URL', 'HELIUS_RPC_URL') ?? input.rpcUrl ?? defaultRpcUrl(cluster);
  const mainnet = {
    ...DEFAULT_CONFIG.mainnet,
    ...(input.mainnet ?? {}),
  };
  const tokens = input.tokens ?? DEFAULT_CONFIG.tokens;
  const jupiter = {
    ...DEFAULT_CONFIG.jupiter,
    ...(input.jupiter ?? {}),
  };
  const configuredSwapBaseUrl =
    firstEnvValue('JUPITER_SWAP_BASE_URL', 'JUP_ULTRA_BASE', 'JUPITER_BASE_URL') ??
    input.jupiter?.swapBaseUrl ??
    input.jupiter?.baseUrl ??
    DEFAULT_JUPITER_SWAP_BASE_URL;
  const swapBaseUrl = stripTrailingSlashes(configuredSwapBaseUrl);
  jupiter.baseUrl = swapBaseUrl;
  jupiter.swapBaseUrl = swapBaseUrl;
  jupiter.lendBaseUrl = stripTrailingSlashes(
    firstEnvValue('JUPITER_LEND_BASE_URL') ?? jupiter.lendBaseUrl ?? DEFAULT_JUPITER_LEND_BASE_URL,
  );
  jupiter.triggerBaseUrl = stripTrailingSlashes(
    firstEnvValue('JUPITER_TRIGGER_BASE_URL') ?? jupiter.triggerBaseUrl ?? DEFAULT_JUPITER_TRIGGER_BASE_URL,
  );
  jupiter.recurringBaseUrl = stripTrailingSlashes(
    firstEnvValue('JUPITER_RECURRING_BASE_URL') ?? jupiter.recurringBaseUrl ?? DEFAULT_JUPITER_RECURRING_BASE_URL,
  );
  jupiter.tokensBaseUrl = stripTrailingSlashes(
    firstEnvValue('JUPITER_TOKENS_BASE_URL') ?? jupiter.tokensBaseUrl ?? DEFAULT_JUPITER_TOKENS_BASE_URL,
  );
  jupiter.priceBaseUrl = stripTrailingSlashes(
    firstEnvValue('JUPITER_PRICE_BASE_URL') ?? jupiter.priceBaseUrl ?? DEFAULT_JUPITER_PRICE_BASE_URL,
  );
  jupiter.predictionBaseUrl = stripTrailingSlashes(
    firstEnvValue('JUPITER_PREDICTION_BASE_URL') ?? jupiter.predictionBaseUrl ?? DEFAULT_JUPITER_PREDICTION_BASE_URL,
  );
  if (!process.env[jupiter.apiKeyEnv]?.trim() && process.env.JUP_API_KEY?.trim()) {
    jupiter.apiKeyEnv = 'JUP_API_KEY';
  }
  const recurring = input.recurring;
  const recipients = input.recipients;
  const connectors = {
    ...DEFAULT_CONFIG.connectors,
    ...(input.connectors ?? {}),
    marginfi: {
      ...DEFAULT_CONFIG.connectors?.marginfi,
      ...(input.connectors?.marginfi ?? {}),
    },
  };
  return {
    cluster,
    rpcUrl,
    mainnet,
    tokens,
    jupiter,
    ...(recurring !== undefined && { recurring }),
    ...(recipients !== undefined && { recipients }),
    connectors,
  };
}

function firstEnvValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

export function requireMainnetEnabled(config: AgentWalletConfig): void {
  if (config.cluster === 'mainnet-beta' && !config.mainnet.enabled) {
    throw new ProtocolError(
      'unauthorized',
      'Mainnet is disabled. Set mainnet.enabled=true in agent-wallet.config.json to allow real SOL actions.',
    );
  }
}

export function defaultRpcUrl(cluster: Cluster): string {
  switch (cluster) {
    case 'mainnet-beta':
      return 'https://api.mainnet-beta.solana.com';
    case 'devnet':
      return 'https://api.devnet.solana.com';
    case 'testnet':
      return 'https://api.testnet.solana.com';
    case 'localnet':
      return 'http://127.0.0.1:8899';
  }
}
