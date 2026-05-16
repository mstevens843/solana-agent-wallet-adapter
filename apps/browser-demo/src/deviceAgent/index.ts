// Browser-native Device Agent runtime barrel.
// See docs/plans/browser-device-agent-runtime-plan.md for the full plan.
// Phases 1-4 fill the runtime/, storage/, provider/, and prompts/ subdirectories.
// Phase 5 finalizes this barrel with the dispatcher exports.

export {
  __resetBrowserDeviceAgentForTests,
  browserDeviceAgentRequest,
  browserDeviceAgentStatusSnapshot,
  getBrowserDeviceAgentSecretStoreMode,
  initBrowserDeviceAgent,
  isBrowserDeviceAgentInitialized,
  setBrowserDeviceAgentSecretStoreMode,
  setBrowserDeviceAgentWalletAddress,
  type BrowserDeviceAgentDeps,
  type ConfigMetadata,
  type MetadataStore,
} from './dispatcher.js';
export type { SecretStoreMode } from './storage/secretStore.js';
