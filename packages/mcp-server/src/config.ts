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
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const DEFAULT_CONFIG: AgentWalletConfig = {
  cluster: 'mainnet-beta',
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  mainnet: {
    enabled: false,
    maxSolTransfer: '0.05',
    maxSwapInput: '0.05',
    maxSlippageBps: 100,
    allowArbitraryTransactions: false,
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
    baseUrl: 'https://api.jup.ag/swap/v2',
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
  const rpcUrl = process.env.SOLANA_RPC_URL ?? input.rpcUrl ?? defaultRpcUrl(cluster);
  const mainnet = {
    ...DEFAULT_CONFIG.mainnet,
    ...(input.mainnet ?? {}),
  };
  const tokens = input.tokens ?? DEFAULT_CONFIG.tokens;
  const jupiter = {
    ...DEFAULT_CONFIG.jupiter,
    ...(input.jupiter ?? {}),
  };
  return { cluster, rpcUrl, mainnet, tokens, jupiter };
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
