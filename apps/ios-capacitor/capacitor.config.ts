import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.agentic.wallet',
  appName: 'Agentic',
  webDir: 'dist',
  bundledWebRuntime: false,
  ios: {
    contentInset: 'automatic',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#050806',
    },
  },
  // Capacitor 8 discovers plugins via packageClassList for SPM-linked targets.
  // Every @objc(...) class in packages/ios-capacitor-bridge/ios/Plugin/ that
  // conforms to CAPBridgedPlugin must be listed here.
  packageClassList: [
    'AppPlugin',
    'AgenticSecureStatePlugin',
    'AgenticWalletConnectPlugin',
    'AgenticBiometricPlugin',
    'AgenticSystemPlugin',
    'AgenticRemoteConfigPlugin',
    'AgenticDeviceAgentPlugin',
    'AgenticStreamingSessionPlugin',
  ],
};

export default config;
