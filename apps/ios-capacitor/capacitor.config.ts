import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.agentic.wallet',
  appName: 'Agentic',
  webDir: 'dist',
  bundledWebRuntime: false,
  // Live-load the UI from Render so web changes ship without a new App Store
  // build, mirroring the Android WebView shell. `webDir: 'dist'` is still bundled
  // and acts as the OFFLINE FALLBACK: AgenticBridgeViewController (App target)
  // nulls `server.url` at launch when agentic-signer.com is unreachable, so the
  // app serves the baked-in copy from capacitor://localhost instead of blanking.
  // Both origins are trusted by AgenticBridgeOrigin.swift, so native plugins work
  // in either state.
  server: {
    url: 'https://agentic-signer.com',
    cleartext: false,
    allowNavigation: ['agentic-signer.com', 'agentic-seeker.com'],
  },
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
    'AgenticNativeWalletPlugin',
    'AgenticBiometricPlugin',
    'AgenticSystemPlugin',
    'AgenticRemoteConfigPlugin',
    'AgenticDeviceAgentPlugin',
    'AgenticStreamingSessionPlugin',
    'AgenticQrScannerPlugin',
  ],
};

export default config;
