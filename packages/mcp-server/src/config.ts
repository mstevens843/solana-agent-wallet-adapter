import { readFile } from 'node:fs/promises';

import { PublicKey } from '@solana/web3.js';

import { ProtocolError, type Cluster } from '@solana-agent-wallet-adapter/core';

import { resolveJupiterReferral, type JupiterReferralParams } from './adapters/jupiter/referral.js';

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
    portfolioBaseUrl?: string;
    sendBaseUrl?: string;
    studioBaseUrl?: string;
    transactionBaseUrl?: string;
    /** Optional only when official Jupiter Perps endpoints stabilize. No default; opt-in via JUPITER_PERPS_BASE_URL. */
    perpsBaseUrl?: string;
    apiKeyEnv: string;
    /**
     * Ultra integrator-fee params applied to swap `/order` requests when the
     * operator has configured JUPITER_REFERRAL_ACCOUNT (+ JUPITER_REFERRAL_FEE_BPS).
     * Absent = no platform fee. See adapters/jupiter/referral.ts.
     */
    referral?: JupiterReferralParams;
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
  project0?: Project0PolicyConfig;
  jupiter?: JupiterConnectorPolicyConfig;
  phoenix?: PhoenixConnectorPolicyConfig;
}

export interface PhoenixConnectorPolicyConfig {
  perps?: PhoenixPerpsPolicyConfig;
  vulcan?: PhoenixVulcanPolicyConfig;
}

/**
 * Phoenix Perpetuals execution-bridge via Vulcan (Ellipsis Labs CLI for traders and AI agents).
 *
 * The Phoenix Perpetuals adapter ships read tools + policy-gated action stubs; live tx-building is blocked until
 * the Rise SDK lands on npm. This bridge lets the agent execute real Phoenix trades by proxying to a local
 * `vulcan mcp` subprocess. Dangerous calls are intercepted into Agentic's prepared-action inbox so the user
 * approves each one before Vulcan signs.
 *
 * Default disabled — operator must opt in and supply a wallet name (and password for live trading).
 */
export interface PhoenixVulcanPolicyConfig {
  enabled?: boolean;
  /** Vulcan binary path; defaults to "vulcan" (PATH lookup). */
  binaryPath?: string;
  /** Stored Vulcan wallet identifier; forwarded as VULCAN_WALLET_NAME. (Single-wallet mode.) */
  walletName?: string;
  /**
   * Env var to read the Vulcan wallet password from at process start. Default `VULCAN_WALLET_PASSWORD`.
   * Resolved once at bridge start; never stored on disk by Agentic.
   */
  walletPasswordEnvVar?: string;
  /** Spawn vulcan with `--allow-dangerous` so signing tools become available. */
  allowDangerous?: boolean;
  /** Per-tool-call timeout. Default 60s. */
  maxToolCallTimeoutMs?: number;
  /** D1: enable transport-crash auto-restart with exponential backoff. Default false (fail-loud). */
  autoRestart?: boolean;
  /** D1: backoff schedule between restart attempts. Default [1000, 2000, 5000, 10000, 30000]. */
  restartBackoffMs?: readonly number[];
  /** D2: reject start() when upstream `serverInfo.name` doesn't equal this. Defensive identity check. */
  requiredServerName?: string;
  /** D2: pin the upstream vulcan binary version. Exact match against `serverInfo.version`. */
  requiredServerVersion?: string;
  /**
   * D4 multi-wallet mode: when this map is non-empty, the bridge builds a `VulcanWalletRegistry` instead of a
   * single client. Each key is a wallet name; each value is the env var that holds that wallet's password.
   * Example: `{ alice: 'ALICE_VULCAN_PASSWORD', bob: 'BOB_VULCAN_PASSWORD' }`.
   */
  walletPasswordsByEnvVar?: Record<string, string>;
  /**
   * D4: allowlist of wallet names that the registry accepts. When set, an agent passing an unknown wallet name
   * via `vulcanWalletName` is rejected. Prevents cross-tenant wallet spawning.
   */
  allowedWallets?: string[];
  /** D4: default wallet name to use when a call doesn't specify one. Falls back to `walletName` if unset. */
  defaultWalletName?: string;
}

export interface MarginfiPolicyConfig {
  minHealthRatio?: number;
}

export interface Project0PolicyConfig {
  minHealthRatio?: number;
  apiBaseUrl?: string;
}

export interface JupiterConnectorPolicyConfig {
  minBorrowHealthRatio?: number;
  maxBorrowLtvBps?: number;
  useSdk?: boolean;
  tokenPrice?: JupiterTokenPricePolicyConfig;
  prediction?: JupiterPredictionPolicyConfig;
  perps?: JupiterPerpsPolicyConfig;
  trigger?: JupiterTriggerPolicyConfig;
  recurring?: JupiterRecurringPolicyConfig;
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

export interface JupiterRecurringPolicyConfig {
  enabled?: boolean;
  maxDepositAmount?: Record<string, string>;
  maxOrderCount?: number;
  maxLifetimeDays?: number;
  minIntervalSeconds?: number;
  allowDeprecatedPriceOrders?: boolean;
}

export const DEFAULT_JUPITER_RECURRING_MAX_ORDER_COUNT = 100;
export const DEFAULT_JUPITER_RECURRING_MIN_INTERVAL_SECONDS = 3600;

export const DEFAULT_JUPITER_RECURRING_POLICY: Required<
  Pick<JupiterRecurringPolicyConfig, 'enabled' | 'maxOrderCount' | 'minIntervalSeconds' | 'allowDeprecatedPriceOrders'>
> = {
  enabled: false,
  maxOrderCount: DEFAULT_JUPITER_RECURRING_MAX_ORDER_COUNT,
  minIntervalSeconds: DEFAULT_JUPITER_RECURRING_MIN_INTERVAL_SECONDS,
  allowDeprecatedPriceOrders: true,
};

export interface ResolvedJupiterRecurringPolicy {
  enabled: boolean;
  maxOrderCount: number;
  minIntervalSeconds: number;
  allowDeprecatedPriceOrders: boolean;
  maxDepositAmount?: Record<string, string>;
  maxLifetimeDays?: number;
}

export function getJupiterRecurringPolicy(config: AgentWalletConfig): ResolvedJupiterRecurringPolicy {
  const policy = config.connectors?.jupiter?.recurring;
  const resolved: ResolvedJupiterRecurringPolicy = {
    enabled: policy?.enabled ?? DEFAULT_JUPITER_RECURRING_POLICY.enabled,
    maxOrderCount: policy?.maxOrderCount ?? DEFAULT_JUPITER_RECURRING_POLICY.maxOrderCount,
    minIntervalSeconds: policy?.minIntervalSeconds ?? DEFAULT_JUPITER_RECURRING_POLICY.minIntervalSeconds,
    allowDeprecatedPriceOrders:
      policy?.allowDeprecatedPriceOrders ?? DEFAULT_JUPITER_RECURRING_POLICY.allowDeprecatedPriceOrders,
  };
  if (policy?.maxDepositAmount !== undefined) resolved.maxDepositAmount = policy.maxDepositAmount;
  if (policy?.maxLifetimeDays !== undefined) resolved.maxLifetimeDays = policy.maxLifetimeDays;
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

export interface PhoenixPerpsPolicyConfig {
  /** Default false: Phoenix is in private beta and Rise SDK is not yet on npm. */
  enabled?: boolean;
  /** Default false: reads + previews always allowed; writes blocked only when this is true. */
  readOnly?: boolean;
  /** Default true: writes return policy_paper_mode_only until 24h paper soak passes and operator flips this off. */
  paperModeOnly?: boolean;
  /** Default 5x. Phoenix UI currently advertises 15x on SOL-PERP; we ship conservative. */
  maxLeverage?: number;
  /** Default 15%. Health preview rejects opens that project below this buffer. */
  minLiquidationBufferPct?: number;
  /** Default `['SOL-PERP']`. Empty array means *deny all*; expand as new markets are validated. */
  allowedSymbols?: string[];
  /** Default $250. Notional = baseSize × leverage × markPriceUsd; capped per prepared action. */
  maxNotionalUsd?: number;
}

export const DEFAULT_PHOENIX_PERPS_POLICY: Required<PhoenixPerpsPolicyConfig> = {
  enabled: false,
  readOnly: false,
  paperModeOnly: true,
  maxLeverage: 5,
  minLiquidationBufferPct: 15,
  allowedSymbols: ['SOL-PERP'],
  maxNotionalUsd: 250,
};

export function getPhoenixPerpsPolicy(
  config: AgentWalletConfig,
): Required<PhoenixPerpsPolicyConfig> {
  const policy = config.connectors?.phoenix?.perps;
  return {
    enabled: policy?.enabled ?? DEFAULT_PHOENIX_PERPS_POLICY.enabled,
    readOnly: policy?.readOnly ?? DEFAULT_PHOENIX_PERPS_POLICY.readOnly,
    paperModeOnly: policy?.paperModeOnly ?? DEFAULT_PHOENIX_PERPS_POLICY.paperModeOnly,
    maxLeverage: policy?.maxLeverage ?? DEFAULT_PHOENIX_PERPS_POLICY.maxLeverage,
    minLiquidationBufferPct:
      policy?.minLiquidationBufferPct ?? DEFAULT_PHOENIX_PERPS_POLICY.minLiquidationBufferPct,
    allowedSymbols: policy?.allowedSymbols ?? DEFAULT_PHOENIX_PERPS_POLICY.allowedSymbols,
    maxNotionalUsd: policy?.maxNotionalUsd ?? DEFAULT_PHOENIX_PERPS_POLICY.maxNotionalUsd,
  };
}

export const DEFAULT_PHOENIX_VULCAN_POLICY: Required<
  Pick<PhoenixVulcanPolicyConfig, 'enabled' | 'binaryPath' | 'walletPasswordEnvVar' | 'allowDangerous' | 'maxToolCallTimeoutMs'>
> = {
  enabled: false,
  binaryPath: 'vulcan',
  walletPasswordEnvVar: 'VULCAN_WALLET_PASSWORD',
  allowDangerous: false,
  maxToolCallTimeoutMs: 60_000,
};

export interface ResolvedPhoenixVulcanPolicy {
  enabled: boolean;
  binaryPath: string;
  walletName?: string;
  walletPasswordEnvVar: string;
  allowDangerous: boolean;
  maxToolCallTimeoutMs: number;
  autoRestart: boolean;
  restartBackoffMs?: readonly number[];
  requiredServerName?: string;
  requiredServerVersion?: string;
  walletPasswordsByEnvVar?: Record<string, string>;
  allowedWallets?: string[];
  defaultWalletName?: string;
}

export function getPhoenixVulcanPolicy(config: AgentWalletConfig): ResolvedPhoenixVulcanPolicy {
  const policy = config.connectors?.phoenix?.vulcan;
  const envEnabled = process.env.PHOENIX_VULCAN_ENABLED?.toLowerCase().trim() === 'true';
  const envDangerous = process.env.PHOENIX_VULCAN_ALLOW_DANGEROUS?.toLowerCase().trim() === 'true';
  const envAutoRestart = process.env.PHOENIX_VULCAN_AUTO_RESTART?.toLowerCase().trim() === 'true';
  const envRequiredVersion = process.env.PHOENIX_VULCAN_REQUIRED_VERSION?.trim();
  const resolved: ResolvedPhoenixVulcanPolicy = {
    enabled: policy?.enabled ?? envEnabled,
    binaryPath:
      policy?.binaryPath ?? process.env.PHOENIX_VULCAN_BINARY?.trim() ?? DEFAULT_PHOENIX_VULCAN_POLICY.binaryPath,
    walletPasswordEnvVar: policy?.walletPasswordEnvVar ?? DEFAULT_PHOENIX_VULCAN_POLICY.walletPasswordEnvVar,
    allowDangerous: policy?.allowDangerous ?? envDangerous,
    maxToolCallTimeoutMs: policy?.maxToolCallTimeoutMs ?? DEFAULT_PHOENIX_VULCAN_POLICY.maxToolCallTimeoutMs,
    autoRestart: policy?.autoRestart ?? envAutoRestart,
  };
  const walletName = policy?.walletName ?? process.env.VULCAN_WALLET_NAME?.trim();
  if (walletName) resolved.walletName = walletName;
  if (policy?.restartBackoffMs) resolved.restartBackoffMs = policy.restartBackoffMs;
  if (policy?.requiredServerName) resolved.requiredServerName = policy.requiredServerName;
  const requiredVersion = policy?.requiredServerVersion ?? envRequiredVersion;
  if (requiredVersion) resolved.requiredServerVersion = requiredVersion;
  if (policy?.walletPasswordsByEnvVar && Object.keys(policy.walletPasswordsByEnvVar).length > 0) {
    resolved.walletPasswordsByEnvVar = policy.walletPasswordsByEnvVar;
  }
  if (policy?.allowedWallets && policy.allowedWallets.length > 0) {
    resolved.allowedWallets = policy.allowedWallets;
  }
  if (policy?.defaultWalletName) resolved.defaultWalletName = policy.defaultWalletName;
  return resolved;
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
export const WIF_MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
export const PYUSD_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
export const MSOL_MINT = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';

/**
 * Solana Mobile Seeker ecosystem token. The mainnet mint is not hardcoded
 * because $SKR was not stable at the time this code shipped; deployments set
 * `SKR_TOKEN_MINT` (and optionally `SKR_TOKEN_DECIMALS`/`SKR_TOKEN_MAX_TRANSFER`)
 * to enable it. When unset OR set to a malformed value, $SKR is omitted from
 * the registry entirely so non-Seeker deployments are unaffected and operator
 * typos surface as a loud startup log rather than a silent downstream failure.
 */
export const SKR_MINT: string = (() => {
  const raw = (process.env.SKR_TOKEN_MINT ?? '').trim();
  if (!raw) return '';
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `[config] SKR_TOKEN_MINT="${raw}" is not a valid base58 Solana pubkey; $SKR features will remain disabled.`,
    );
    return '';
  }
})();
const SKR_DECIMALS: number = (() => {
  const raw = (process.env.SKR_TOKEN_DECIMALS ?? '').trim();
  if (!raw) return 6;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 18 ? n : 6;
})();
const SKR_MAX_TRANSFER: string = (() => {
  const raw = (process.env.SKR_TOKEN_MAX_TRANSFER ?? '').trim();
  return /^\d+(\.\d+)?$/.test(raw) ? raw : '1000';
})();

const SKR_REGISTRY_ENTRY: TokenLimitConfig | null = SKR_MINT
  ? { symbol: 'SKR', mint: SKR_MINT, decimals: SKR_DECIMALS, maxTransfer: SKR_MAX_TRANSFER }
  : null;

export const DEFAULT_JUPITER_SWAP_BASE_URL = 'https://api.jup.ag/swap/v2';
export const DEFAULT_JUPITER_LEND_BASE_URL = 'https://api.jup.ag/lend/v1';
export const DEFAULT_JUPITER_TRIGGER_BASE_URL = 'https://api.jup.ag/trigger/v2';
export const DEFAULT_JUPITER_RECURRING_BASE_URL = 'https://api.jup.ag/recurring/v1';
export const DEFAULT_JUPITER_TOKENS_BASE_URL = 'https://api.jup.ag/tokens/v2';
export const DEFAULT_JUPITER_PRICE_BASE_URL = 'https://api.jup.ag/price/v3';
export const DEFAULT_JUPITER_PREDICTION_BASE_URL = 'https://api.jup.ag/prediction/v1';
export const DEFAULT_JUPITER_PORTFOLIO_BASE_URL = 'https://api.jup.ag/portfolio/v1';
export const DEFAULT_JUPITER_SEND_BASE_URL = 'https://api.jup.ag/send/v1';
export const DEFAULT_JUPITER_STUDIO_BASE_URL = 'https://api.jup.ag/studio/v1';
export const DEFAULT_JUPITER_TRANSACTION_BASE_URL = 'https://api.jup.ag/tx/v1';
export const DEFAULT_PROJECT0_API_BASE_URL = 'https://ai.0.xyz';
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
  ...(SKR_REGISTRY_ENTRY ? [SKR_REGISTRY_ENTRY] : []),
];

export const DEFAULT_CONFIG: AgentWalletConfig = {
  cluster: 'devnet',
  rpcUrl: 'https://api.devnet.solana.com',
  mainnet: {
    enabled: false,
    maxSolTransfer: '0.05',
    maxSwapInput: '0.05',
    maxSlippageBps: 100,
    allowArbitraryTransactions: false,
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
    portfolioBaseUrl: DEFAULT_JUPITER_PORTFOLIO_BASE_URL,
    sendBaseUrl: DEFAULT_JUPITER_SEND_BASE_URL,
    studioBaseUrl: DEFAULT_JUPITER_STUDIO_BASE_URL,
    transactionBaseUrl: DEFAULT_JUPITER_TRANSACTION_BASE_URL,
    apiKeyEnv: 'JUPITER_API_KEY',
  },
  connectors: {
    marginfi: {
      minHealthRatio: 1.1,
    },
    project0: {
      minHealthRatio: 1.1,
      apiBaseUrl: DEFAULT_PROJECT0_API_BASE_URL,
    },
    jupiter: {
      minBorrowHealthRatio: 1.25,
      maxBorrowLtvBps: 8500,
      useSdk: true,
      tokenPrice: {
        enabled: true,
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
      recurring: {
        enabled: DEFAULT_JUPITER_RECURRING_POLICY.enabled,
        maxOrderCount: DEFAULT_JUPITER_RECURRING_POLICY.maxOrderCount,
        minIntervalSeconds: DEFAULT_JUPITER_RECURRING_POLICY.minIntervalSeconds,
        allowDeprecatedPriceOrders: DEFAULT_JUPITER_RECURRING_POLICY.allowDeprecatedPriceOrders,
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
  jupiter.portfolioBaseUrl = stripTrailingSlashes(
    firstEnvValue('JUPITER_PORTFOLIO_BASE_URL') ?? jupiter.portfolioBaseUrl ?? DEFAULT_JUPITER_PORTFOLIO_BASE_URL,
  );
  jupiter.sendBaseUrl = stripTrailingSlashes(
    firstEnvValue('JUPITER_SEND_BASE_URL') ?? jupiter.sendBaseUrl ?? DEFAULT_JUPITER_SEND_BASE_URL,
  );
  jupiter.studioBaseUrl = stripTrailingSlashes(
    firstEnvValue('JUPITER_STUDIO_BASE_URL') ?? jupiter.studioBaseUrl ?? DEFAULT_JUPITER_STUDIO_BASE_URL,
  );
  jupiter.transactionBaseUrl = stripTrailingSlashes(
    firstEnvValue('JUPITER_TX_BASE_URL', 'JUPITER_TRANSACTION_BASE_URL') ??
      jupiter.transactionBaseUrl ??
      DEFAULT_JUPITER_TRANSACTION_BASE_URL,
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
  // Platform fee on swaps: apply the operator's Ultra referral params when
  // configured via env (JUPITER_REFERRAL_ACCOUNT + JUPITER_REFERRAL_FEE_BPS).
  // Env takes precedence over any value carried in the config file.
  const referral = resolveJupiterReferral() ?? input.jupiter?.referral;
  if (referral) {
    jupiter.referral = referral;
  } else {
    delete jupiter.referral;
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
    project0: {
      ...DEFAULT_CONFIG.connectors?.project0,
      ...(input.connectors?.project0 ?? {}),
      apiBaseUrl: stripTrailingSlashes(
        firstEnvValue('PROJECT0_API_BASE_URL', 'P0_API_BASE_URL') ??
          input.connectors?.project0?.apiBaseUrl ??
          DEFAULT_PROJECT0_API_BASE_URL,
      ),
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
      recurring: {
        ...DEFAULT_CONFIG.connectors?.jupiter?.recurring,
        ...(input.connectors?.jupiter?.recurring ?? {}),
      },
    },
  };
  if (process.env.JUPITER_LEND_USE_SDK !== undefined) {
    const value = process.env.JUPITER_LEND_USE_SDK.trim().toLowerCase();
    if (value === 'false' || value === '0') connectors.jupiter.useSdk = false;
    if (value === 'true' || value === '1') connectors.jupiter.useSdk = true;
  }
  applyJupiterTriggerEnvOverrides(connectors.jupiter.trigger);
  applyJupiterRecurringEnvOverrides(connectors.jupiter.recurring);
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

function applyJupiterRecurringEnvOverrides(recurring: JupiterRecurringPolicyConfig | undefined): void {
  if (!recurring) return;
  const enabledRaw = process.env.CONNECTORS_JUPITER_RECURRING_ENABLED?.trim().toLowerCase();
  if (enabledRaw === 'true' || enabledRaw === '1') recurring.enabled = true;
  if (enabledRaw === 'false' || enabledRaw === '0') recurring.enabled = false;
  const numericEnv = (name: string): number | undefined => {
    const raw = process.env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const maxOrderCount = numericEnv('CONNECTORS_JUPITER_RECURRING_MAX_ORDER_COUNT');
  if (maxOrderCount !== undefined) recurring.maxOrderCount = maxOrderCount;
  const maxLifetimeDays = numericEnv('CONNECTORS_JUPITER_RECURRING_MAX_LIFETIME_DAYS');
  if (maxLifetimeDays !== undefined) recurring.maxLifetimeDays = maxLifetimeDays;
  const minIntervalSeconds = numericEnv('CONNECTORS_JUPITER_RECURRING_MIN_INTERVAL_SECONDS');
  if (minIntervalSeconds !== undefined) recurring.minIntervalSeconds = minIntervalSeconds;
  const allowDeprecatedRaw = process.env.CONNECTORS_JUPITER_RECURRING_ALLOW_DEPRECATED_PRICE_ORDERS?.trim().toLowerCase();
  if (allowDeprecatedRaw === 'true' || allowDeprecatedRaw === '1') recurring.allowDeprecatedPriceOrders = true;
  if (allowDeprecatedRaw === 'false' || allowDeprecatedRaw === '0') recurring.allowDeprecatedPriceOrders = false;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

export function requireMainnetEnabled(config: AgentWalletConfig): void {
  if (config.cluster === 'mainnet-beta' && !config.mainnet?.enabled) {
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
