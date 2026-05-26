import { describe, expect, it } from 'vitest';

import {
  AGENTIC_PRODUCTION_ORIGIN,
  resolveDesktopPairingRelayBaseUrl,
  resolveQrConnectAppUrl,
} from '../desktopQrConfig.js';

describe('desktop QR config', () => {
  it('defaults local dev relay and QR app URLs to the current origin', () => {
    const origin = 'http://127.0.0.1:5174';

    expect(resolveDesktopPairingRelayBaseUrl({ PROD: false }, origin)).toBe(origin);
    expect(resolveQrConnectAppUrl({ PROD: false }, origin)).toBe(origin);
  });

  it('defaults production relay and QR app URLs to agentic-signer.com', () => {
    const origin = 'http://127.0.0.1:5174';

    expect(resolveDesktopPairingRelayBaseUrl({ PROD: true }, origin)).toBe(AGENTIC_PRODUCTION_ORIGIN);
    expect(resolveQrConnectAppUrl({ PROD: true }, origin)).toBe(AGENTIC_PRODUCTION_ORIGIN);
  });

  it('respects explicit relay and QR app URL overrides', () => {
    expect(resolveDesktopPairingRelayBaseUrl({
      PROD: false,
      VITE_AGENTIC_CLOUD_API_BASE_URL: 'https://relay.example.com/',
    }, 'http://127.0.0.1:5174')).toBe('https://relay.example.com');

    expect(resolveQrConnectAppUrl({
      PROD: false,
      VITE_AGENTIC_QR_CONNECT_APP_URL: 'https://phone.example.com/',
    }, 'http://127.0.0.1:5174')).toBe('https://phone.example.com');
  });
});
