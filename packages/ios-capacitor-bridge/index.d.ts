export declare const pluginName: '@solana-agent-wallet-adapter/ios-capacitor-bridge';

// Capacitor plugin names registered by the iOS bridge package. These are the
// `jsName` values exposed via `registerPlugin<...>(name)` from the web shell
// (apps/browser-demo/src/iosNative.ts).
export declare const pluginNames: {
  readonly secureState: 'AgenticSecureState';
  readonly walletConnect: 'AgenticWalletConnect';
  readonly biometric: 'AgenticBiometric';
  readonly system: 'AgenticSystem';
  readonly remoteConfig: 'AgenticRemoteConfig';
  readonly deviceAgent: 'AgenticDeviceAgent';
  readonly streamingSession: 'AgenticStreamingSession';
};
