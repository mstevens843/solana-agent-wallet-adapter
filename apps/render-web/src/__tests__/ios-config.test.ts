import { describe, expect, it } from 'vitest';

import { getIosRemoteConfig } from '../cloud/iosConfig.js';

describe('iOS remote config', () => {
  it('includes WalletConnect relay defaults for native Jupiter pairing', () => {
    const config = getIosRemoteConfig({});

    expect(config.walletConnectRelayHost).toBe('relay.walletconnect.com');
    expect(config.walletConnectRelayOrigin).toBe('https://agentic-signer.com');
  });

  it('normalizes WalletConnect project and relay env values', () => {
    const config = getIosRemoteConfig({
      WALLETCONNECT_PROJECT_ID: '7c5434a4b0dffb44ae4344c1da2f9825',
      WALLETCONNECT_RELAY_HOST: 'wss://relay.walletconnect.com/path',
      WALLETCONNECT_RELAY_ORIGIN: 'https://agentic-signer.com/app',
    });

    expect(config.walletConnectProjectId).toBe('7c5434a4b0dffb44ae4344c1da2f9825');
    expect(config.walletConnectRelayHost).toBe('relay.walletconnect.com');
    expect(config.walletConnectRelayOrigin).toBe('https://agentic-signer.com');
  });
});
