import { describe, expect, it } from 'vitest';

import {
  AGENTIC_PRODUCTION_ORIGIN,
  resolveDesktopPairingRelayBaseUrl,
  resolveQrConnectAppUrl,
} from '../desktopQrConfig.js';

describe('desktop QR config', () => {
  it('defaults dev and prod to the production cloud relay (QR pairing is cross-device)', () => {
    // Phones can't reach `http://127.0.0.1:5174`, and the relay's own HTTPS
    // gate would reject http URLs anyway — so even in `PROD=false` we must
    // point at agentic-signer.com.
    expect(resolveDesktopPairingRelayBaseUrl({ PROD: false })).toBe(AGENTIC_PRODUCTION_ORIGIN);
    expect(resolveQrConnectAppUrl({ PROD: false })).toBe(AGENTIC_PRODUCTION_ORIGIN);
    expect(resolveDesktopPairingRelayBaseUrl({ PROD: true })).toBe(AGENTIC_PRODUCTION_ORIGIN);
    expect(resolveQrConnectAppUrl({ PROD: true })).toBe(AGENTIC_PRODUCTION_ORIGIN);
  });

  it('respects explicit overrides for self-hosted relays / ngrok tunnels', () => {
    expect(resolveDesktopPairingRelayBaseUrl({
      VITE_AGENTIC_CLOUD_API_BASE_URL: 'https://relay.example.com/',
    })).toBe('https://relay.example.com');

    expect(resolveQrConnectAppUrl({
      VITE_AGENTIC_QR_CONNECT_APP_URL: 'https://phone.example.com/',
    })).toBe('https://phone.example.com');
  });

  it('falls back to the production origin when the override is empty/whitespace', () => {
    expect(resolveDesktopPairingRelayBaseUrl({
      VITE_AGENTIC_CLOUD_API_BASE_URL: '   ',
    })).toBe(AGENTIC_PRODUCTION_ORIGIN);

    expect(resolveQrConnectAppUrl({
      VITE_AGENTIC_QR_CONNECT_APP_URL: '',
    })).toBe(AGENTIC_PRODUCTION_ORIGIN);
  });
});
