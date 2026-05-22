// Public surface for `@solana-agent-wallet-adapter/embedded-wallet`.
//
// Consumers typically need only `registerAgenticWallet()` at boot. The
// `createAgenticWallet` / IPC bindings are exported for tests and for
// future per-brand picker panels (Slice D) that drive the wallet directly.

export { AGENTIC_WALLET_ICON } from './icon.js';
export {
  createTauriWalletIpc,
  detectTauriInvoke,
  type WalletCreated,
  type WalletIpc,
  type WalletStatus,
} from './ipc.js';
export {
  base64ToBytes,
  bytesToBase64,
  extractMessageBytes,
  isVersionedTransaction,
  stitchSignature,
} from './transaction.js';
export {
  registerAgenticWallet,
  resetAgenticWalletRegistration,
  type RegisterAgenticWalletOptions,
} from './register.js';
export { AGENTIC_WALLET_NAME, createAgenticWallet } from './wallet.js';
