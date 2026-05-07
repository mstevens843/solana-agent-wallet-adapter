import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAgentMwaRegistrationForTests,
  detectMwaEnvironment,
  isMobileWalletAdapterWallet,
  registerAgentMobileWalletAdapter,
} from '../index.js';

const registerMwa = vi.fn();

vi.mock('@solana-mobile/wallet-standard-mobile', () => ({
  registerMwa,
  createDefaultAuthorizationCache: () => ({ cache: 'auth' }),
  createDefaultChainSelector: () => ({ selector: 'chain' }),
  createDefaultWalletNotFoundHandler: () => ({ handler: 'not-found' }),
}));

describe('mwa-mobile-web', () => {
  beforeEach(() => {
    registerMwa.mockClear();
    __resetAgentMwaRegistrationForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects Android Chrome and filters unsupported browsers', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});

    const chrome = detectMwaEnvironment(
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36',
    );
    const firefox = detectMwaEnvironment(
      'Mozilla/5.0 (Android 15; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0',
    );

    expect(chrome.isAndroid).toBe(true);
    expect(chrome.isChrome).toBe(true);
    expect(chrome.supportsMwaMobileWeb).toBe(true);
    expect(firefox.isAndroid).toBe(true);
    expect(firefox.isChrome).toBe(false);
    expect(firefox.supportsMwaMobileWeb).toBe(false);
  });

  it('detects iOS Safari as Wallet Standard fallback only', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});

    const safari = detectMwaEnvironment(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
    );

    expect(safari.isIos).toBe(true);
    expect(safari.isSafari).toBe(true);
    expect(safari.supportsMwaMobileWeb).toBe(false);
    expect(safari.supportsIosWalletStandardFallback).toBe(true);
  });

  it('no-ops outside a browser context', async () => {
    const result = await registerAgentMobileWalletAdapter({
      appIdentity: { name: 'Agent Wallet', uri: 'https://example.com' },
      logLevel: 'silent',
    });

    expect(result).toMatchObject({
      registered: false,
      skippedReason: 'not_browser',
    });
    expect(registerMwa).not.toHaveBeenCalled();
  });

  it('skips MWA registration in iOS browsers', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
    });

    const result = await registerAgentMobileWalletAdapter({
      appIdentity: { name: 'Agent Wallet', uri: 'https://example.com' },
      logLevel: 'silent',
    });

    expect(result).toMatchObject({
      registered: false,
      skippedReason: 'unsupported_environment',
    });
    expect(registerMwa).not.toHaveBeenCalled();
  });

  it('registers once in a browser context', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36',
    });

    const first = await registerAgentMobileWalletAdapter({
      appIdentity: { name: 'Agent Wallet', uri: 'https://example.com', icon: '/icon.png' },
      chains: ['solana:devnet', 'solana:mainnet-beta'],
      logLevel: 'silent',
    });
    const second = await registerAgentMobileWalletAdapter({
      appIdentity: { name: 'Agent Wallet', uri: 'https://example.com' },
      logLevel: 'silent',
    });

    expect(first.registered).toBe(true);
    expect(second).toMatchObject({
      registered: false,
      skippedReason: 'already_registered',
    });
    expect(registerMwa).toHaveBeenCalledTimes(1);
    expect(registerMwa.mock.calls[0]?.[0]).toMatchObject({
      appIdentity: { name: 'Agent Wallet', uri: 'https://example.com', icon: '/icon.png' },
      chains: ['solana:devnet', 'solana:mainnet'],
    });
  });

  it('identifies Mobile Wallet Adapter wallet names', () => {
    expect(isMobileWalletAdapterWallet({ name: 'Mobile Wallet Adapter' })).toBe(true);
    expect(isMobileWalletAdapterWallet({ name: 'Phantom' })).toBe(false);
  });
});
