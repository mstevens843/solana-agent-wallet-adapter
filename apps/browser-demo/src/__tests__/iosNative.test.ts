import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_IOS_APP_URL,
  iosNativeAppUrl,
  iosNativeWalletConnectTransactionParam,
} from '../iosNative.js';

describe('iosNativeAppUrl', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AGENTIC_IOS_APP_URL', '');
    vi.stubEnv('VITE_AGENTIC_CLOUD_API_BASE_URL', '');
    vi.stubEnv('AGENTIC_CLOUD_API_BASE_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the production HTTPS origin for native wallet sessions', () => {
    expect(iosNativeAppUrl()).toBe(DEFAULT_IOS_APP_URL);
  });

  it('uses an explicit iOS app URL as a normalized origin', () => {
    vi.stubEnv('VITE_AGENTIC_IOS_APP_URL', 'https://staging.agentic-signer.com/app?surface=ios');

    expect(iosNativeAppUrl()).toBe('https://staging.agentic-signer.com');
  });

  it('ignores non-HTTPS native webview origins and falls back to a hosted API origin', () => {
    vi.stubEnv('VITE_AGENTIC_IOS_APP_URL', 'capacitor://localhost');
    vi.stubEnv('VITE_AGENTIC_CLOUD_API_BASE_URL', 'https://agentic-signer.com/api/mobile-config');

    expect(iosNativeAppUrl()).toBe('https://agentic-signer.com');
  });
});

describe('iosNativeWalletConnectTransactionParam', () => {
  it('keeps Jupiter WalletConnect transaction payloads in base64', () => {
    expect(iosNativeWalletConnectTransactionParam({
      data: 'AQIDBA==',
      encoding: 'base64',
    })).toBe('AQIDBA==');
  });

  it('base64-encodes non-base64 transaction payloads before WalletConnect submission', () => {
    expect(iosNativeWalletConnectTransactionParam({
      data: 'tx',
      encoding: 'utf8',
    })).toBe('dHg=');
  });
});
