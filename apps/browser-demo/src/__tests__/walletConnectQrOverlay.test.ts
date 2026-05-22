import { describe, expect, it } from 'vitest';

import {
  WALLET_CONNECT_BRANDS,
  initialWalletConnectQrOverlayState,
  isWalletConnectSupportedBrand,
  reduceWalletConnectQrOverlay,
  walletConnectQrOverlayHtml,
  type WalletConnectQrOverlayState,
} from '../walletConnectQrOverlay.js';

describe('initialWalletConnectQrOverlayState', () => {
  it('starts closed with no brand, uri, or error', () => {
    expect(initialWalletConnectQrOverlayState()).toEqual({
      mode: 'closed',
      brandId: null,
      uri: null,
      qrDataUrl: null,
      error: '',
    });
  });
});

describe('isWalletConnectSupportedBrand', () => {
  it('returns true for all five wallet brands the desktop picker surfaces', () => {
    expect(isWalletConnectSupportedBrand('phantom')).toBe(true);
    expect(isWalletConnectSupportedBrand('solflare')).toBe(true);
    expect(isWalletConnectSupportedBrand('backpack')).toBe(true);
    expect(isWalletConnectSupportedBrand('jupiter')).toBe(true);
    expect(isWalletConnectSupportedBrand('magicEden')).toBe(true);
  });

  it('returns false for unknown brand ids', () => {
    expect(isWalletConnectSupportedBrand('agentic')).toBe(false);
    expect(isWalletConnectSupportedBrand('ledger')).toBe(false);
    expect(isWalletConnectSupportedBrand('')).toBe(false);
  });
});

describe('reduceWalletConnectQrOverlay — openConnecting', () => {
  it('switches to connecting mode and clears prior fields', () => {
    const dirty: WalletConnectQrOverlayState = {
      mode: 'error',
      brandId: 'old',
      uri: 'wc:old',
      qrDataUrl: 'data:image/png;base64,OLD',
      error: 'old error',
    };
    const next = reduceWalletConnectQrOverlay(dirty, {
      type: 'openConnecting',
      brandId: 'phantom',
    });
    expect(next).toEqual({
      mode: 'connecting',
      brandId: 'phantom',
      uri: null,
      qrDataUrl: null,
      error: '',
    });
  });
});

describe('reduceWalletConnectQrOverlay — setUri', () => {
  it('promotes connecting → awaiting-scan with the URI + QR', () => {
    const connecting: WalletConnectQrOverlayState = {
      mode: 'connecting',
      brandId: 'phantom',
      uri: null,
      qrDataUrl: null,
      error: '',
    };
    const next = reduceWalletConnectQrOverlay(connecting, {
      type: 'setUri',
      uri: 'wc:abc',
      qrDataUrl: 'data:image/png;base64,XYZ',
    });
    expect(next.mode).toBe('awaiting-scan');
    expect(next.uri).toBe('wc:abc');
    expect(next.qrDataUrl).toBe('data:image/png;base64,XYZ');
  });

  it('updates the URI on a fresh awaiting-scan refresh', () => {
    const awaiting: WalletConnectQrOverlayState = {
      mode: 'awaiting-scan',
      brandId: 'solflare',
      uri: 'wc:old',
      qrDataUrl: 'data:image/png;base64,OLD',
      error: '',
    };
    const next = reduceWalletConnectQrOverlay(awaiting, {
      type: 'setUri',
      uri: 'wc:new',
      qrDataUrl: 'data:image/png;base64,NEW',
    });
    expect(next.uri).toBe('wc:new');
  });

  it('is a no-op once we have left the pairing modes', () => {
    const closed = initialWalletConnectQrOverlayState();
    const next = reduceWalletConnectQrOverlay(closed, {
      type: 'setUri',
      uri: 'wc:abc',
      qrDataUrl: 'data:image/png;base64,XYZ',
    });
    expect(next).toBe(closed);
  });
});

describe('reduceWalletConnectQrOverlay — completing + error + close', () => {
  it('moves an open overlay into completing mode', () => {
    const awaiting: WalletConnectQrOverlayState = {
      mode: 'awaiting-scan',
      brandId: 'phantom',
      uri: 'wc:xyz',
      qrDataUrl: 'data:image/png;base64,Q',
      error: '',
    };
    const next = reduceWalletConnectQrOverlay(awaiting, { type: 'completing' });
    expect(next.mode).toBe('completing');
    expect(next.uri).toBe('wc:xyz');
  });

  it('does not transition a closed overlay into completing', () => {
    const closed = initialWalletConnectQrOverlayState();
    expect(reduceWalletConnectQrOverlay(closed, { type: 'completing' })).toBe(closed);
  });

  it('setError surfaces the message and switches to error mode', () => {
    const awaiting: WalletConnectQrOverlayState = {
      mode: 'awaiting-scan',
      brandId: 'phantom',
      uri: 'wc:xyz',
      qrDataUrl: 'data:image/png;base64,Q',
      error: '',
    };
    const next = reduceWalletConnectQrOverlay(awaiting, {
      type: 'setError',
      error: 'pairing expired',
    });
    expect(next.mode).toBe('error');
    expect(next.error).toBe('pairing expired');
  });

  it('close returns to initial state', () => {
    const dirty: WalletConnectQrOverlayState = {
      mode: 'awaiting-scan',
      brandId: 'phantom',
      uri: 'wc:xyz',
      qrDataUrl: 'data:image/png;base64,Q',
      error: '',
    };
    expect(reduceWalletConnectQrOverlay(dirty, { type: 'close' })).toEqual(
      initialWalletConnectQrOverlayState(),
    );
  });
});

describe('walletConnectQrOverlayHtml', () => {
  it('returns empty string when closed', () => {
    expect(walletConnectQrOverlayHtml({ state: initialWalletConnectQrOverlayState() })).toBe('');
  });

  it('renders a connecting message during init', () => {
    const html = walletConnectQrOverlayHtml({
      state: {
        mode: 'connecting',
        brandId: 'phantom',
        uri: null,
        qrDataUrl: null,
        error: '',
      },
    });
    expect(html).toContain('Connect Phantom via WalletConnect');
    expect(html).toContain('Preparing a WalletConnect session');
  });

  it('renders the QR + brand-specific deep-link button when awaiting scan', () => {
    const html = walletConnectQrOverlayHtml({
      state: {
        mode: 'awaiting-scan',
        brandId: 'phantom',
        uri: 'wc:topic@2?relay-protocol=irn&symKey=abc',
        qrDataUrl: 'data:image/png;base64,XXX',
        error: '',
      },
    });
    expect(html).toContain('src="data:image/png;base64,XXX"');
    expect(html).toContain('data-walletconnect-action="open-deeplink"');
    // Deep link should URL-encode the URI.
    expect(html).toContain('phantom://wc?uri=wc%3Atopic');
    expect(html).toContain('data-walletconnect-action="copy-uri"');
    expect(html).toContain('data-walletconnect-action="cancel"');
  });

  it('uses Solflare deep-link prefix when brand is solflare', () => {
    const html = walletConnectQrOverlayHtml({
      state: {
        mode: 'awaiting-scan',
        brandId: 'solflare',
        uri: 'wc:abc',
        qrDataUrl: 'data:image/png;base64,YYY',
        error: '',
      },
    });
    expect(html).toContain('solflare://wc?uri=wc%3Aabc');
    expect(html).toContain('Open Solflare');
  });

  it('falls back to a generic placeholder for unknown brands', () => {
    const html = walletConnectQrOverlayHtml({
      state: {
        mode: 'awaiting-scan',
        brandId: 'unknown-brand',
        uri: 'wc:abc',
        qrDataUrl: 'data:image/png;base64,YYY',
        error: '',
      },
    });
    expect(html).toContain('WalletConnect');
    // No deep-link button when the brand prefix is empty.
    expect(html).not.toContain('data-walletconnect-action="open-deeplink"');
  });

  it('renders an error message + close button in error mode', () => {
    const html = walletConnectQrOverlayHtml({
      state: {
        mode: 'error',
        brandId: 'phantom',
        uri: null,
        qrDataUrl: null,
        error: 'Pairing expired. Try again.',
      },
    });
    expect(html).toContain('Pairing expired');
    expect(html).toMatch(/data-walletconnect-action="cancel"/);
  });

  it('renders a completing message after approval', () => {
    const html = walletConnectQrOverlayHtml({
      state: {
        mode: 'completing',
        brandId: 'phantom',
        uri: 'wc:xyz',
        qrDataUrl: 'data:image/png;base64,Q',
        error: '',
      },
    });
    expect(html).toContain('Linking Phantom');
  });

  it('wires aria-labelledby on the dialog to the rendered h2 (a11y)', () => {
    const html = walletConnectQrOverlayHtml({
      state: {
        mode: 'connecting',
        brandId: 'phantom',
        uri: null,
        qrDataUrl: null,
        error: '',
      },
    });
    expect(html).toContain('aria-labelledby="walletconnect-qr-overlay-title"');
    expect(html).toContain('<h2 id="walletconnect-qr-overlay-title">');
    expect(html).not.toContain('aria-label="Connect Phantom via WalletConnect"');
  });

  it('escapes the URI and error fields to prevent injection', () => {
    const html = walletConnectQrOverlayHtml({
      state: {
        mode: 'error',
        brandId: 'phantom',
        uri: null,
        qrDataUrl: null,
        error: '<script>alert(1)</script>',
      },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('uses the logoUrl resolver when provided', () => {
    const html = walletConnectQrOverlayHtml({
      state: {
        mode: 'awaiting-scan',
        brandId: 'phantom',
        uri: 'wc:abc',
        qrDataUrl: 'data:image/png;base64,YYY',
        error: '',
      },
      logoUrl: (id) => `/logos/${id}.svg`,
    });
    expect(html).toContain('src="/logos/phantom.svg"');
  });

  it('exposes Phantom, Solflare, Backpack, Jupiter, and Magic Eden in the supported-brands map', () => {
    expect(Object.keys(WALLET_CONNECT_BRANDS).sort()).toEqual([
      'backpack',
      'jupiter',
      'magicEden',
      'phantom',
      'solflare',
    ]);
    expect(WALLET_CONNECT_BRANDS.phantom!.deepLinkPrefix).toMatch(/^phantom:/);
    expect(WALLET_CONNECT_BRANDS.solflare!.deepLinkPrefix).toMatch(/^solflare:/);
    expect(WALLET_CONNECT_BRANDS.backpack!.deepLinkPrefix).toMatch(/^backpack:/);
    expect(WALLET_CONNECT_BRANDS.jupiter!.deepLinkPrefix).toMatch(/^jupiter:/);
    expect(WALLET_CONNECT_BRANDS.magicEden!.deepLinkPrefix).toMatch(/^magiceden:/);
  });

  it('builds Backpack/Jupiter/Magic Eden deep-link URLs from the awaiting-scan state', () => {
    for (const brandId of ['backpack', 'jupiter', 'magicEden'] as const) {
      const html = walletConnectQrOverlayHtml({
        state: {
          mode: 'awaiting-scan',
          brandId,
          uri: 'wc:topic@2?relay-protocol=irn&symKey=abc',
          qrDataUrl: 'data:image/png;base64,XXX',
          error: '',
        },
      });
      const brand = WALLET_CONNECT_BRANDS[brandId]!;
      expect(html).toContain(`Open ${brand.name}`);
      // Anchor includes the brand-prefixed href with URL-encoded wc URI and
      // a data-walletconnect-action attribute for the bind layer.
      expect(html).toContain(`href="${brand.deepLinkPrefix}wc%3Atopic`);
      expect(html).toContain('data-walletconnect-action="open-deeplink"');
    }
  });
});
