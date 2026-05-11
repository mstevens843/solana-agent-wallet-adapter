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
    baseUrl: string;
    apiKeyEnv: string;
  };
  recurring?: RecurringPolicyConfig;
}

export interface RecurringPolicyConfig {
  maxLifetimeAmount?: Record<string, string>;
  maxPerWeekAmount?: Record<string, string>;
  maxPerMonthAmount?: Record<string, string>;
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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
  tokens: [
    {
      symbol: 'USDC',
      mint: USDC_MINT,
      decimals: 6,
      maxTransfer: '25',
    },
  ],
  jupiter: {
    baseUrl: 'https://api.jup.ag/ultra/v1',
    apiKeyEnv: 'JUPITER_API_KEY',
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
  const jupiterBaseUrl = firstEnvValue('JUP_ULTRA_BASE', 'JUPITER_BASE_URL');
  if (jupiterBaseUrl) {
    jupiter.baseUrl = jupiterBaseUrl;
  }
  if (!process.env[jupiter.apiKeyEnv]?.trim() && process.env.JUP_API_KEY?.trim()) {
    jupiter.apiKeyEnv = 'JUP_API_KEY';
  }
  const recurring = input.recurring;
  return { cluster, rpcUrl, mainnet, tokens, jupiter, ...(recurring !== undefined && { recurring }) };
}

function firstEnvValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
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
