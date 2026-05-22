// Public surface for `@solana-agent-wallet-adapter/walletconnect-solana`.

export {
  clusterForChainId,
  isSolanaWalletConnectChainId,
  solanaWalletConnectChainId,
  walletStandardChainForCluster,
  type SolanaClusterId,
  type SolanaWalletStandardChain,
} from './chains.js';
export {
  createWalletConnectSolanaClient,
  type SignClientLike,
  type WalletConnectSession,
  type WalletConnectSessionStruct,
  type WalletConnectSolanaClient,
  type WalletConnectSolanaClientOptions,
} from './client.js';
export {
  createWalletConnectSolanaWallet,
  type CreateWalletConnectSolanaWalletOptions,
  type WalletConnectBrand,
} from './wallet.js';
export {
  registerWalletConnectSolanaWallet,
  resetWalletConnectRegistry,
  unregisterAllWalletConnectWallets,
  unregisterWalletConnectSolanaWallet,
} from './register.js';
