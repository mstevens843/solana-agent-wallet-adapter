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
    /** Optional only when official Jupiter Perps endpoints stabilize. No default; opt-in via JUPITER_PERPS_BASE_URL. */
    perpsBaseUrl?: string;
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
  jupiter?: JupiterConnectorPolicyConfig;
}

export interface MarginfiPolicyConfig {
  minHealthRatio?: number;
}

export interface JupiterConnectorPolicyConfig {
  minBorrowHealthRatio?: number;
  maxBorrowLtvBps?: number;
  useSdk?: boolean;
  tokenPrice?: JupiterTokenPricePolicyConfig;
  prediction?: JupiterPredictionPolicyConfig;
  perps?: JupiterPerpsPolicyConfig;
  trigger?: JupiterTriggerPolicyConfig;
}

export interface JupiterTriggerPolicyConfig {
  enabled?: boolean;
  maxDepositUsd?: number;
  maxOrderLifetimeDays?: number;
  maxStopLossSlippageBps?: number;
  maxSlippageBps?: number;
  highSlippageWarnBps?: number;
}

export const DEFAULT_JUPITER_TRIGGER_MAX_ORDER_LIFETIME_DAYS = 30;
export const DEFAULT_JUPITER_TRIGGER_HIGH_SLIPPAGE_WARN_BPS = 300;
export const JUPITER_TRIGGER_MIN_ORDER_USD = 10;

export const DEFAULT_JUPITER_TRIGGER_POLICY: Required<
  Pick<JupiterTriggerPolicyConfig, 'enabled' | 'maxOrderLifetimeDays' | 'highSlippageWarnBps'>
> = {
  enabled: false,
  maxOrderLifetimeDays: DEFAULT_JUPITER_TRIGGER_MAX_ORDER_LIFETIME_DAYS,
  highSlippageWarnBps: DEFAULT_JUPITER_TRIGGER_HIGH_SLIPPAGE_WARN_BPS,
};

export interface ResolvedJupiterTriggerPolicy {
  enabled: boolean;
  maxOrderLifetimeDays: number;
  highSlippageWarnBps: number;
  maxDepositUsd?: number;
  maxStopLossSlippageBps?: number;
  maxSlippageBps?: number;
}

export function getJupiterTriggerPolicy(config: AgentWalletConfig): ResolvedJupiterTriggerPolicy {
  const policy = config.connectors?.jupiter?.trigger;
  const resolved: ResolvedJupiterTriggerPolicy = {
    enabled: policy?.enabled ?? DEFAULT_JUPITER_TRIGGER_POLICY.enabled,
    maxOrderLifetimeDays:
      policy?.maxOrderLifetimeDays ?? DEFAULT_JUPITER_TRIGGER_POLICY.maxOrderLifetimeDays,
    highSlippageWarnBps:
      policy?.highSlippageWarnBps ?? DEFAULT_JUPITER_TRIGGER_POLICY.highSlippageWarnBps,
  };
  if (policy?.maxDepositUsd !== undefined) resolved.maxDepositUsd = policy.maxDepositUsd;
  if (policy?.maxStopLossSlippageBps !== undefined) resolved.maxStopLossSlippageBps = policy.maxStopLossSlippageBps;
  if (policy?.maxSlippageBps !== undefined) resolved.maxSlippageBps = policy.maxSlippageBps;
  return resolved;
}

export interface JupiterTokenPricePolicyConfig {
  enabled?: boolean;
  maxBatchPriceIds?: number;
  maxSearchMintIds?: number;
}

export interface JupiterPredictionPolicyConfig {
  /** Default false: Jupiter Prediction is beta and disabled until the host opts in. */
  enabled?: boolean;
  /** Default true: v1 ships read-only reads; no order create/close/claim writes are exposed. */
  readOnly?: boolean;
}

export const DEFAULT_JUPITER_PREDICTION_POLICY: Required<JupiterPredictionPolicyConfig> = {
  enabled: false,
  readOnly: true,
};

export function getJupiterPredictionPolicy(
  config: AgentWalletConfig,
): Required<JupiterPredictionPolicyConfig> {
  const policy = config.connectors?.jupiter?.prediction;
  return {
    enabled: policy?.enabled ?? DEFAULT_JUPITER_PREDICTION_POLICY.enabled,
    readOnly: policy?.readOnly ?? DEFAULT_JUPITER_PREDICTION_POLICY.readOnly,
  };
}

export interface JupiterPerpsPolicyConfig {
  /** Default false: Jupiter Perps API is work in progress; account decoding stays gated. */
  enabled?: boolean;
  /** Default true: v1 exposes status reads only; all Perps writes are denied. */
  readOnly?: boolean;
}

export const DEFAULT_JUPITER_PERPS_POLICY: Required<JupiterPerpsPolicyConfig> = {
  enabled: false,
  readOnly: true,
};

export function getJupiterPerpsPolicy(
  config: AgentWalletConfig,
): Required<JupiterPerpsPolicyConfig> {
  const policy = config.connectors?.jupiter?.perps;
  return {
    enabled: policy?.enabled ?? DEFAULT_JUPITER_PERPS_POLICY.enabled,
    readOnly: policy?.readOnly ?? DEFAULT_JUPITER_PERPS_POLICY.readOnly,
  };
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
export const WIF_MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
export const PYUSD_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
export const MSOL_MINT = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';

export const DEFAULT_JUPITER_SWAP_BASE_URL = 'https://api.jup.ag/swap/v2';
export const DEFAULT_JUPITER_LEND_BASE_URL = 'https://api.jup.ag/lend/v1';
export const DEFAULT_JUPITER_TRIGGER_BASE_URL = 'https://api.jup.ag/trigger/v2';
export const DEFAULT_JUPITER_RECURRING_BASE_URL = 'https://api.jup.ag/recurring/v1';
export const DEFAULT_JUPITER_TOKENS_BASE_URL = 'https://api.jup.ag/tokens/v2';
export const DEFAULT_JUPITER_PRICE_BASE_URL = 'https://api.jup.ag/price/v3';
export const DEFAULT_JUPITER_PREDICTION_BASE_URL = 'https://api.jup.ag/prediction/v1';
export const DEFAULT_JUPITER_TOKEN_PRICE_MAX_BATCH_PRICE_IDS = 50;
export const DEFAULT_JUPITER_TOKEN_PRICE_MAX_SEARCH_MINT_IDS = 100;

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
    jupiter: {
      minBorrowHealthRatio: 1.25,
      maxBorrowLtvBps: 8500,
      useSdk: true,
      tokenPrice: {
        maxBatchPriceIds: DEFAULT_JUPITER_TOKEN_PRICE_MAX_BATCH_PRICE_IDS,
        maxSearchMintIds: DEFAULT_JUPITER_TOKEN_PRICE_MAX_SEARCH_MINT_IDS,
      },
      prediction: {
        enabled: DEFAULT_JUPITER_PREDICTION_POLICY.enabled,
        readOnly: DEFAULT_JUPITER_PREDICTION_POLICY.readOnly,
      },
      perps: {
        enabled: DEFAULT_JUPITER_PERPS_POLICY.enabled,
        readOnly: DEFAULT_JUPITER_PERPS_POLICY.readOnly,
      },
      trigger: {
        enabled: DEFAULT_JUPITER_TRIGGER_POLICY.enabled,
        maxOrderLifetimeDays: DEFAULT_JUPITER_TRIGGER_POLICY.maxOrderLifetimeDays,
        highSlippageWarnBps: DEFAULT_JUPITER_TRIGGER_POLICY.highSlippageWarnBps,
      },
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
  const perpsBaseUrlFromEnv = firstEnvValue('JUPITER_PERPS_BASE_URL');
  const perpsBaseUrl = perpsBaseUrlFromEnv ?? input.jupiter?.perpsBaseUrl;
  if (perpsBaseUrl) {
    jupiter.perpsBaseUrl = stripTrailingSlashes(perpsBaseUrl);
  } else {
    delete jupiter.perpsBaseUrl;
  }
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
    jupiter: {
      ...DEFAULT_CONFIG.connectors?.jupiter,
      ...(input.connectors?.jupiter ?? {}),
      tokenPrice: {
        ...DEFAULT_CONFIG.connectors?.jupiter?.tokenPrice,
        ...(input.connectors?.jupiter?.tokenPrice ?? {}),
      },
      prediction: {
        ...DEFAULT_CONFIG.connectors?.jupiter?.prediction,
        ...(input.connectors?.jupiter?.prediction ?? {}),
      },
      perps: {
        ...DEFAULT_CONFIG.connectors?.jupiter?.perps,
        ...(input.connectors?.jupiter?.perps ?? {}),
      },
      trigger: {
        ...DEFAULT_CONFIG.connectors?.jupiter?.trigger,
        ...(input.connectors?.jupiter?.trigger ?? {}),
      },
    },
  };
  if (process.env.JUPITER_LEND_USE_SDK !== undefined) {
    const value = process.env.JUPITER_LEND_USE_SDK.trim().toLowerCase();
    if (value === 'false' || value === '0') connectors.jupiter.useSdk = false;
    if (value === 'true' || value === '1') connectors.jupiter.useSdk = true;
  }
  applyJupiterTriggerEnvOverrides(connectors.jupiter.trigger);
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

function applyJupiterTriggerEnvOverrides(trigger: JupiterTriggerPolicyConfig | undefined): void {
  if (!trigger) return;
  const enabledRaw = process.env.CONNECTORS_JUPITER_TRIGGER_ENABLED?.trim().toLowerCase();
  if (enabledRaw === 'true' || enabledRaw === '1') trigger.enabled = true;
  if (enabledRaw === 'false' || enabledRaw === '0') trigger.enabled = false;
  const numericEnv = (name: string): number | undefined => {
    const raw = process.env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const maxDepositUsd = numericEnv('CONNECTORS_JUPITER_TRIGGER_MAX_DEPOSIT_USD');
  if (maxDepositUsd !== undefined) trigger.maxDepositUsd = maxDepositUsd;
  const maxOrderLifetimeDays = numericEnv('CONNECTORS_JUPITER_TRIGGER_MAX_ORDER_LIFETIME_DAYS');
  if (maxOrderLifetimeDays !== undefined) trigger.maxOrderLifetimeDays = maxOrderLifetimeDays;
  const maxStopLoss = numericEnv('CONNECTORS_JUPITER_TRIGGER_MAX_STOP_LOSS_SLIPPAGE_BPS');
  if (maxStopLoss !== undefined) trigger.maxStopLossSlippageBps = maxStopLoss;
  const maxSlippage = numericEnv('CONNECTORS_JUPITER_TRIGGER_MAX_SLIPPAGE_BPS');
  if (maxSlippage !== undefined) trigger.maxSlippageBps = maxSlippage;
  const highWarn = numericEnv('CONNECTORS_JUPITER_TRIGGER_HIGH_SLIPPAGE_WARN_BPS');
  if (highWarn !== undefined) trigger.highSlippageWarnBps = highWarn;
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
