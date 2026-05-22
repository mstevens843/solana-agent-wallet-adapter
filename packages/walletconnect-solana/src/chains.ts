// Solana CAIP-2 chain IDs as understood by WalletConnect v2 wallets.
//
// Copied from `packages/ios-link/src/jupiterWalletConnect.ts` to keep the
// new package's dependency tree lean — `ios-link` pulls in Node-only
// modules (`node:fs`, `node:path`) that the browser-demo Vite build
// otherwise would need polyfilled.
//
// CAIP-2 reference (Solana namespace): the chain ID is the first 32 chars
// of the genesis hash's base58 representation, prefixed by `solana:`.

export type SolanaClusterId = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';

export interface SolanaChainEntry {
  cluster: SolanaClusterId;
  chainId: string;
}

const CHAIN_BY_CLUSTER: Record<SolanaClusterId, string> = {
  'mainnet-beta': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  testnet: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
  // Localnet shares devnet genesis hash; helpful for local validators that
  // emulate devnet's chain ID.
  localnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};

export function solanaWalletConnectChainId(cluster: SolanaClusterId): string {
  return CHAIN_BY_CLUSTER[cluster];
}

export function isSolanaWalletConnectChainId(value: string): boolean {
  if (!value.startsWith('solana:')) return false;
  return Object.values(CHAIN_BY_CLUSTER).includes(value);
}

export function clusterForChainId(chainId: string): SolanaClusterId | null {
  for (const [cluster, id] of Object.entries(CHAIN_BY_CLUSTER) as Array<[SolanaClusterId, string]>) {
    if (id === chainId) return cluster;
  }
  return null;
}

/** Wallet Standard chain identifiers used by Solana wallets. */
export type SolanaWalletStandardChain =
  | 'solana:mainnet'
  | 'solana:devnet'
  | 'solana:testnet'
  | 'solana:localnet';

export function walletStandardChainForCluster(cluster: SolanaClusterId): SolanaWalletStandardChain {
  switch (cluster) {
    case 'mainnet-beta':
      return 'solana:mainnet';
    case 'devnet':
      return 'solana:devnet';
    case 'testnet':
      return 'solana:testnet';
    case 'localnet':
      return 'solana:localnet';
  }
}
