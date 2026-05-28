import { describe, expect, it } from 'vitest';

import type { LedgerAccountCandidate } from '../ledgerAccounts.js';
import {
  DEFAULT_LEDGER_DERIVATION_PATH,
  initialLedgerOverlayState,
  ledgerConfirmationRetryState,
  ledgerOverlayBodyHtml,
  ledgerOverlayHtml,
  reduceLedgerOverlay,
  type LedgerOverlayState,
} from '../ledgerOverlay.js';

const ADDR = 'EmaginedRust11111111111111111111111111111111';
const ADDR_2 = 'LedgerSecond1111111111111111111111111111111';

function account(overrides: Partial<LedgerAccountCandidate> = {}): LedgerAccountCandidate {
  return {
    derivationPath: `m/44'/501'/0'/0'`,
    family: 'default',
    index: 0,
    order: 0,
    address: ADDR,
    publicKeyB64: 'AAAA',
    solBalanceLamports: 0,
    solBalanceLabel: '0.00 SOL',
    balanceStatus: 'loaded',
    hasActivity: false,
    activityStatus: 'loaded',
    lastSelected: false,
    recentRank: null,
    ...overrides,
  };
}

describe('initialLedgerOverlayState', () => {
  it('starts closed with empty scan state and the default Solana derivation path', () => {
    expect(initialLedgerOverlayState()).toEqual({
      mode: 'closed',
      device: null,
      address: null,
      derivationPath: DEFAULT_LEDGER_DERIVATION_PATH,
      accounts: [],
      accountsExpanded: false,
      canLoadMore: false,
      loadingMore: false,
      scanProgress: 0,
      scanStatus: '',
      error: '',
    });
  });
});

describe('reduceLedgerOverlay', () => {
  it('open switches to searching and resets transient fields', () => {
    const dirty: LedgerOverlayState = {
      ...initialLedgerOverlayState(),
      mode: 'error',
      device: { productName: 'old', vendorId: 1, productId: 1 },
      address: 'OLD',
      derivationPath: 'm/foo',
      accounts: [account()],
      accountsExpanded: true,
      canLoadMore: true,
      loadingMore: true,
      scanProgress: 33,
      scanStatus: 'old',
      error: 'old',
    };
    const next = reduceLedgerOverlay(dirty, { type: 'open' });
    expect(next).toEqual({
      ...initialLedgerOverlayState(),
      mode: 'searching',
    });
  });

  it('deviceFound moves searching to app-check and stores the device', () => {
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

  it('scanStarted moves to scanning-addresses and clears previous accounts', () => {
    const inAppCheck: LedgerOverlayState = {
      ...initialLedgerOverlayState(),
      mode: 'app-check',
      accounts: [account()],
    };
    const next = reduceLedgerOverlay(inAppCheck, {
      type: 'scanStarted',
      status: 'Retrieving addresses',
      progress: 12,
    });
    expect(next.mode).toBe('scanning-addresses');
    expect(next.accounts).toEqual([]);
    expect(next.scanStatus).toBe('Retrieving addresses');
    expect(next.scanProgress).toBe(12);
  });

  it('accountsReady moves to choose-address and selects the preferred address', () => {
    const accounts = [
      account(),
      account({
        address: ADDR_2,
        derivationPath: `m/44'/501'/1'/0'`,
        index: 1,
        order: 1,
        solBalanceLamports: 1_000_000,
        solBalanceLabel: '0.001 SOL',
      }),
    ];
    const next = reduceLedgerOverlay(
      { ...initialLedgerOverlayState(), mode: 'scanning-addresses' },
      {
        type: 'accountsReady',
        accounts,
        selectedAddress: ADDR_2,
        canLoadMore: true,
      },
    );
    expect(next.mode).toBe('choose-address');
    expect(next.address).toBe(ADDR_2);
    expect(next.derivationPath).toBe(`m/44'/501'/1'/0'`);
    expect(next.canLoadMore).toBe(true);
  });

  it('selectAccount updates the selected address and path', () => {
    const accounts = [
      account(),
      account({ address: ADDR_2, derivationPath: `m/44'/501'/2'`, family: 'legacy', index: 2 }),
    ];
    const choose = reduceLedgerOverlay(
      { ...initialLedgerOverlayState(), mode: 'scanning-addresses' },
      { type: 'accountsReady', accounts, selectedAddress: ADDR, canLoadMore: false },
    );
    const next = reduceLedgerOverlay(choose, { type: 'selectAccount', address: ADDR_2 });
    expect(next.address).toBe(ADDR_2);
    expect(next.derivationPath).toBe(`m/44'/501'/2'`);
  });

  it('toggleAccountsExpanded flips the chooser expansion state', () => {
    const choose: LedgerOverlayState = {
      ...initialLedgerOverlayState(),
      mode: 'choose-address',
      accounts: [account()],
      address: ADDR,
    };
    expect(reduceLedgerOverlay(choose, { type: 'toggleAccountsExpanded' }).accountsExpanded).toBe(true);
  });

  it('loadMoreStarted keeps the chooser visible and marks loading', () => {
    const choose: LedgerOverlayState = {
      ...initialLedgerOverlayState(),
      mode: 'choose-address',
      accounts: [account()],
      address: ADDR,
    };
    const next = reduceLedgerOverlay(choose, {
      type: 'loadMoreStarted',
      status: 'Retrieving more',
      progress: 10,
    });
    expect(next.mode).toBe('choose-address');
    expect(next.loadingMore).toBe(true);
    expect(next.scanStatus).toBe('Retrieving more');
  });

  it('confirmingAddress moves from choose-address to the waiting state', () => {
    const choose: LedgerOverlayState = {
      ...initialLedgerOverlayState(),
      mode: 'choose-address',
      accounts: [account()],
      address: ADDR,
    };
    const next = reduceLedgerOverlay(choose, { type: 'confirmingAddress' });
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
      ...initialLedgerOverlayState(),
      mode: 'choose-address',
      device: { productName: 'Nano X', vendorId: 1, productId: 1 },
      address: ADDR,
      accounts: [account()],
    };
    expect(reduceLedgerOverlay(dirty, { type: 'close' })).toEqual(initialLedgerOverlayState());
  });

  it('ledgerConfirmationRetryState restores a failed selected-account confirmation', () => {
    const failed: LedgerOverlayState = {
      ...initialLedgerOverlayState(),
      mode: 'error',
      accounts: [
        account(),
        account({ address: ADDR_2, derivationPath: `m/44'/501'/4'/0'`, index: 4, order: 4 }),
      ],
      address: ADDR_2,
      derivationPath: `m/44'/501'/4'/0'`,
      canLoadMore: true,
      error: 'ledger returned SW 0x6511',
    };

    expect(ledgerConfirmationRetryState(failed)).toMatchObject({
      mode: 'choose-address',
      address: ADDR_2,
      derivationPath: `m/44'/501'/4'/0'`,
      canLoadMore: true,
      error: '',
    });
  });

  it('ledgerConfirmationRetryState returns null for discovery errors without accounts', () => {
    expect(
      ledgerConfirmationRetryState({
        ...initialLedgerOverlayState(),
        mode: 'error',
        error: 'no Ledger device detected',
      }),
    ).toBeNull();
  });
});

describe('ledgerOverlayBodyHtml surfaces', () => {
  it('uses browser-session copy on website surfaces', () => {
    const html = ledgerOverlayBodyHtml({
      ...initialLedgerOverlayState(),
      mode: 'choose-address',
      accounts: [account()],
      address: ADDR,
    }, 'website');

    expect(html).toContain('this browser session');
    expect(html).not.toContain('this desktop app');
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
    expect(html).toContain('preparing account discovery');
  });

  it('renders scan progress with instructions and status', () => {
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'scanning-addresses',
      scanProgress: 16,
      scanStatus: 'Retrieving addresses...',
    });
    expect(html).toContain('Open the Solana app');
    expect(html).toContain('16%');
    expect(html).toContain('Retrieving addresses');
  });

  it('renders choose-address with top accounts, view-more, load-more, and confirm', () => {
    const accounts = Array.from({ length: 4 }, (_, index) =>
      account({
        address: `${ADDR.slice(0, -1)}${index}`,
        index,
        order: index,
        derivationPath: `m/44'/501'/${index}'/0'`,
      }),
    );
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'choose-address',
      address: accounts[0]!.address,
      derivationPath: accounts[0]!.derivationPath,
      accounts,
      canLoadMore: true,
    });
    expect(html).toContain('Select the Ledger address');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('View 2 More');
    expect(html).toContain('Load 20 more');
    expect(html).toContain('class="ledger-account-content"');
    expect(html).toContain('aria-label="Use Account 0');
    expect(html).toContain('aria-label="Copy Ledger address');
    expect(html).toContain('data-ledger-action="copy-address"');
    expect(html).toMatch(/data-ledger-action="confirm-address"[^>]*>Confirm/);
    expect(html).toContain('aria-selected="true"');
  });

  it('labels the second recent Ledger account as previous', () => {
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'choose-address',
      address: ADDR,
      accounts: [
        account({ address: ADDR, lastSelected: true, recentRank: 0 }),
        account({ address: ADDR_2, recentRank: 1 }),
      ],
    });
    expect(html).toContain('Last used');
    expect(html).toContain('Previous');
  });

  it('renders confirming-address with a Ledger approval prompt and disabled actions', () => {
    const html = ledgerOverlayHtml({
      ...initialLedgerOverlayState(),
      mode: 'confirming-address',
      address: ADDR,
    });
    expect(html).toContain('Approve this selected address on your Ledger');
    expect(html).toContain('Waiting for Ledger approval');
    expect(html).toContain('class="toast-spinner"');
    expect(html).toContain('<button type="button" class="utility" disabled>Cancel</button>');
    expect(html).toContain('<button type="button" class="primary" disabled>Confirm</button>');
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

  it('renders the choose-address body with selectable rows', () => {
    const html = ledgerOverlayBodyHtml({
      ...initialLedgerOverlayState(),
      mode: 'choose-address',
      address: ADDR,
      accounts: [account()],
      device: { productName: 'Nano X', vendorId: 0x2c97, productId: 0x4011 },
    });
    expect(html).toContain('Select the Ledger address');
    expect(html).toContain('data-ledger-action="select-account"');
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
