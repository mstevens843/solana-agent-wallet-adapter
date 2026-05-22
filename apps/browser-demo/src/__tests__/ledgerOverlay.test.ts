import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEDGER_DERIVATION_PATH,
  initialLedgerOverlayState,
  ledgerOverlayHtml,
  reduceLedgerOverlay,
  type LedgerOverlayState,
} from '../ledgerOverlay.js';

const ADDR = 'EmaginedRust11111111111111111111111111111111';

describe('initialLedgerOverlayState', () => {
  it('starts closed with the default Solana derivation path', () => {
    expect(initialLedgerOverlayState()).toEqual({
      mode: 'closed',
      device: null,
      address: null,
      derivationPath: DEFAULT_LEDGER_DERIVATION_PATH,
      error: '',
    });
  });
});

describe('reduceLedgerOverlay', () => {
  it('open switches to searching and resets transient fields', () => {
    const dirty: LedgerOverlayState = {
      mode: 'error',
      device: { productName: 'old', vendorId: 1, productId: 1 },
      address: 'OLD',
      derivationPath: 'm/foo',
      error: 'old',
    };
    const next = reduceLedgerOverlay(dirty, { type: 'open' });
    expect(next).toEqual({
      mode: 'searching',
      device: null,
      address: null,
      derivationPath: DEFAULT_LEDGER_DERIVATION_PATH,
      error: '',
    });
  });

  it('deviceFound moves searching → app-check and stores the device', () => {
    const searching: LedgerOverlayState = {
      ...initialLedgerOverlayState(),
      mode: 'searching',
    };
    const next = reduceLedgerOverlay(searching, {
      type: 'deviceFound',
      device: { productName: 'Nano X', vendorId: 0x2C97, productId: 0x0004 },
    });
    expect(next.mode).toBe('app-check');
    expect(next.device?.productName).toBe('Nano X');
  });

  it('deviceFound is a no-op when the overlay is closed', () => {
    const closed = initialLedgerOverlayState();
    const next = reduceLedgerOverlay(closed, {
      type: 'deviceFound',
      device: { productName: 'Nano X', vendorId: 0, productId: 0 },
    });
    expect(next).toBe(closed);
  });

  it('addressReady moves to confirm-address and stores the address', () => {
    const inAppCheck: LedgerOverlayState = {
      ...initialLedgerOverlayState(),
      mode: 'app-check',
      device: { productName: 'Nano S Plus', vendorId: 0x2C97, productId: 0x0005 },
    };
    const next = reduceLedgerOverlay(inAppCheck, { type: 'addressReady', address: ADDR });
    expect(next.mode).toBe('confirm-address');
    expect(next.address).toBe(ADDR);
  });

  it('setError surfaces the message and switches to error mode', () => {
    const inAppCheck: LedgerOverlayState = {
      ...initialLedgerOverlayState(),
      mode: 'app-check',
    };
    const next = reduceLedgerOverlay(inAppCheck, {
      type: 'setError',
      error: 'user rejected on device',
    });
    expect(next.mode).toBe('error');
    expect(next.error).toBe('user rejected on device');
  });

  it('close returns to initial state', () => {
    const dirty: LedgerOverlayState = {
      mode: 'confirm-address',
      device: { productName: 'Nano X', vendorId: 1, productId: 1 },
      address: ADDR,
      derivationPath: 'm/foo',
      error: '',
    };
    expect(reduceLedgerOverlay(dirty, { type: 'close' })).toEqual(initialLedgerOverlayState());
  });
});

describe('ledgerOverlayHtml', () => {
  it('returns empty string when closed', () => {
    expect(ledgerOverlayHtml(initialLedgerOverlayState())).toBe('');
  });

  it('renders the searching body with a cancel button', () => {
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'searching',
    });
    expect(html).toContain('Connect Ledger');
    expect(html).toContain('Looking for a Ledger');
    expect(html).toContain('data-ledger-action="cancel"');
  });

  it('renders the app-check body with the product name', () => {
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'app-check',
      device: { productName: 'Nano S Plus', vendorId: 0x2C97, productId: 0x0005 },
    });
    expect(html).toContain('Found <strong>Nano S Plus</strong>');
  });

  it('renders confirm-address with derivation path + shortened address + Connect button', () => {
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'confirm-address',
      address: ADDR,
    });
    // Path apostrophes are HTML-escaped on the way out.
    expect(html).toContain(DEFAULT_LEDGER_DERIVATION_PATH.replace(/'/g, '&#39;'));
    // Short form uses the first 6 + last 6.
    expect(html).toContain(`${ADDR.slice(0, 6)}…${ADDR.slice(-6)}`);
    expect(html).toContain('title="EmaginedRust11111111111111111111111111111111"');
    expect(html).toMatch(/data-ledger-action="confirm-address"[^>]*>Connect this Ledger/);
  });

  it('renders the error body with retry + cancel', () => {
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'error',
      error: 'user rejected on device',
    });
    expect(html).toContain('user rejected on device');
    expect(html).toContain('data-ledger-action="retry"');
    expect(html).toContain('data-ledger-action="cancel"');
  });

  it('wires aria-labelledby on the dialog to the rendered h2 (a11y)', () => {
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'searching',
    });
    expect(html).toContain('aria-labelledby="ledger-overlay-title"');
    expect(html).toContain('<h2 id="ledger-overlay-title">');
    expect(html).not.toContain('aria-label="Connect Ledger"');
  });

  it('escapes user-supplied error and product name', () => {
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'app-check',
      device: { productName: '<script>alert(1)</script>', vendorId: 0, productId: 0 },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
