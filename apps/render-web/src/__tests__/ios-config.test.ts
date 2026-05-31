import { describe, expect, it } from 'vitest';

import { getIosRemoteConfig } from '../cloud/iosConfig.js';

describe('iOS remote config', () => {
  it('includes WalletConnect relay and redirect defaults for native Jupiter pairing', () => {
    const config = getIosRemoteConfig({});

    expect(config.walletConnectRelayHost).toBe('relay.walletconnect.com');
    expect(config.walletConnectRelayOrigin).toBe('https://agentic-signer.com');
    expect(config.walletConnectRedirectNative).toBe('agenticwallet://');
    expect(config.walletConnectRedirectUniversal).toBe('https://agentic-signer.com/ios/callback/walletconnect');
  });

  it('normalizes WalletConnect project, relay, and redirect env values', () => {
    const config = getIosRemoteConfig({
      WALLETCONNECT_PROJECT_ID: '7c5434a4b0dffb44ae4344c1da2f9825',
      WALLETCONNECT_RELAY_HOST: 'wss://relay.walletconnect.com/path',
      WALLETCONNECT_RELAY_ORIGIN: 'https://agentic-signer.com/app',
      WALLETCONNECT_REDIRECT_NATIVE: 'agenticwallet://',
      WALLETCONNECT_REDIRECT_UNIVERSAL: 'https://agentic-signer.com/ios/callback/walletconnect?source=env',
    });

    expect(config.walletConnectProjectId).toBe('7c5434a4b0dffb44ae4344c1da2f9825');
    expect(config.walletConnectRelayHost).toBe('relay.walletconnect.com');
    expect(config.walletConnectRelayOrigin).toBe('https://agentic-signer.com');
    expect(config.walletConnectRedirectNative).toBe('agenticwallet://');
    expect(config.walletConnectRedirectUniversal).toBe('https://agentic-signer.com/ios/callback/walletconnect?source=env');
  });
});
