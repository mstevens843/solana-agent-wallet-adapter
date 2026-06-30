import type { CapacitorConfig } from '@capacitor/cli';

const LIVE_ORIGIN = 'https://agentic-signer.com';
const ALLOW_NAVIGATION = ['agentic-signer.com', 'agentic-seeker.com'];
const iosWebMode = resolveIosWebMode();

const config: CapacitorConfig = {
  appId: 'com.agentic.wallet',
  appName: 'Agentic',
  webDir: 'dist',
  bundledWebRuntime: false,
  // AGENTIC_IOS_WEB_MODE=live is the App Store mode. It live-loads the UI from
  // Render so web changes ship through a Render redeploy without a new App Store
  // build. AGENTIC_IOS_WEB_MODE=local omits `server.url` and serves the bundled
  // local dist from capacitor://localhost for device testing.
  ...(iosWebMode === 'live'
    ? {
        server: {
          url: LIVE_ORIGIN,
          cleartext: false,
          allowNavigation: ALLOW_NAVIGATION,
        },
      }
    : {}),
  ios: {
    contentInset: 'automatic',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#050706',
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

function resolveIosWebMode(): 'live' | 'local' {
  const raw = String(process.env.AGENTIC_IOS_WEB_MODE ?? process.env.VITE_AGENTIC_IOS_WEB_MODE ?? 'live')
    .trim()
    .toLowerCase();
  if (!raw || raw === 'live') return 'live';
  if (raw === 'local') return 'local';
  throw new Error(`Unsupported AGENTIC_IOS_WEB_MODE=${raw}. Use "live" or "local".`);
}
