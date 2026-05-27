import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEDGER_DERIVATION_PATH,
  initialLedgerOverlayState,
  ledgerOverlayBodyHtml,
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

  it('confirmingAddress moves from confirm-address to the waiting state', () => {
    const confirm: LedgerOverlayState = {
      ...initialLedgerOverlayState(),
      mode: 'confirm-address',
      address: ADDR,
    };
    const next = reduceLedgerOverlay(confirm, { type: 'confirmingAddress' });
    expect(next.mode).toBe('confirming-address');
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

  it('renders confirm-address with stacked derivation path + shortened address + Connect button', () => {
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'confirm-address',
      address: ADDR,
    });
    expect(html).toContain('confirm the address on your device');
    expect(html).toContain('class="ledger-overlay-code"');
    // Path apostrophes are HTML-escaped on the way out.
    expect(html).toContain(DEFAULT_LEDGER_DERIVATION_PATH.replace(/'/g, '&#39;'));
    // Short form uses the first 6 + last 6.
    expect(html).toContain(`${ADDR.slice(0, 6)}…${ADDR.slice(-6)}`);
    expect(html).toContain('title="EmaginedRust11111111111111111111111111111111"');
    expect(html).toMatch(/data-ledger-action="confirm-address"[^>]*>Connect this Ledger/);
  });

  it('renders confirming-address with a Ledger approval prompt and disabled actions', () => {
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'confirming-address',
      address: ADDR,
    });
    expect(html).toContain('Approve this address on your Ledger');
    expect(html).toContain('Waiting for Ledger approval');
    expect(html).toContain('class="toast-spinner"');
    expect(html).toContain('<button type="button" class="utility" disabled>Cancel</button>');
    expect(html).toContain('<button type="button" class="primary" disabled>Connect this Ledger</button>');
    expect(html).not.toContain('data-ledger-action="confirm-address"');
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

describe('ledgerOverlayBodyHtml (inline render)', () => {
  it('returns empty string when mode is closed', () => {
    expect(ledgerOverlayBodyHtml(initialLedgerOverlayState())).toBe('');
  });

  it('omits the scrim, dialog wrapper, and close button', () => {
    const html = ledgerOverlayBodyHtml({
      ...initialLedgerOverlayState(),
      mode: 'searching',
    });
    expect(html).not.toContain('ledger-overlay-scrim');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('ledger-overlay-head');
    expect(html).not.toContain('ledger-overlay-close');
    expect(html).toContain('Looking for a Ledger device');
  });

  it('renders the confirm-address body with derivation path + connect cta', () => {
    const html = ledgerOverlayBodyHtml({
      ...initialLedgerOverlayState(),
      mode: 'confirm-address',
      address: ADDR,
      device: { productName: 'Nano X', vendorId: 0x2c97, productId: 0x4011 },
    });
    expect(html).toContain('Review this Ledger account');
    // The HTML factory escapes apostrophes in the derivation path; assert on a
    // stable substring rather than the raw constant.
    expect(html).toContain('m/44');
    expect(html).toContain('501');
    expect(html).toContain('data-ledger-action="confirm-address"');
    expect(html).not.toContain('role="dialog"');
  });

  it('renders the error body with retry/cancel affordances', () => {
    const html = ledgerOverlayBodyHtml({
      ...initialLedgerOverlayState(),
      mode: 'error',
      error: 'user rejected on device',
    });
    expect(html).toContain('user rejected on device');
    expect(html).toContain('data-ledger-action="retry"');
    expect(html).toContain('data-ledger-action="cancel"');
    expect(html).not.toContain('role="dialog"');
  });
});
