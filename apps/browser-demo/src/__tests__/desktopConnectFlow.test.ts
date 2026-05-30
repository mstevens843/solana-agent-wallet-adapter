import { describe, expect, it } from 'vitest';

import {
  buildDesktopBrowserConnectUrl,
  buildDesktopBrowserIntentUrl,
  canUseMultiPathWalletFlow,
  desktopBridgeNotReadyMessage,
  initialDesktopConnectFlowState,
  isDesktopBridgeReady,
  reduceDesktopConnectFlow,
  shouldRenderDetachedLedgerOverlay,
  shouldRenderDetachedWalletConnectOverlay,
  type DesktopConnectFlowState,
} from '../desktopConnectFlow.js';

const initial = (): DesktopConnectFlowState => initialDesktopConnectFlowState();

describe('multi-path wallet flow surface gates', () => {
  it('enables the copied connect flow on desktop and regular website surfaces', () => {
    expect(canUseMultiPathWalletFlow({
      isAndroidNative: false,
      isIosNative: false,
      isTauriNative: true,
    })).toBe(true);
    expect(canUseMultiPathWalletFlow({
      isAndroidNative: false,
      isIosNative: false,
      isTauriNative: false,
    })).toBe(true);
  });

  it('keeps CLI wallet-host pages on direct Wallet Standard discovery', () => {
    expect(canUseMultiPathWalletFlow({
      isAndroidNative: false,
      isIosNative: false,
      isCliMode: true,
      isTauriNative: false,
    })).toBe(false);
    expect(canUseMultiPathWalletFlow({
      isAndroidNative: false,
      isIosNative: false,
      isCliMode: true,
      isTauriNative: true,
    })).toBe(false);
  });

  it('keeps native mobile surfaces on their native wallet paths', () => {
    expect(canUseMultiPathWalletFlow({
      isAndroidNative: true,
      isIosNative: false,
      isTauriNative: false,
    })).toBe(false);
    expect(canUseMultiPathWalletFlow({
      isAndroidNative: false,
      isIosNative: true,
      isTauriNative: false,
    })).toBe(false);
  });

  it('suppresses detached overlays while the copied inline flow owns that step', () => {
    expect(shouldRenderDetachedWalletConnectOverlay({
      isTauriNative: false,
      flowStep: 'qr',
    })).toBe(false);
    expect(shouldRenderDetachedLedgerOverlay({
      isTauriNative: false,
      flowStep: 'ledger',
    })).toBe(false);
  });

  it('keeps detached overlays available outside inline QR/Ledger steps on the website', () => {
    expect(shouldRenderDetachedWalletConnectOverlay({
      isTauriNative: false,
      flowStep: 'method',
    })).toBe(true);
    expect(shouldRenderDetachedLedgerOverlay({
      isTauriNative: false,
      flowStep: 'method',
    })).toBe(true);
  });

  it('keeps detached WalletConnect and Ledger overlays suppressed inside Tauri', () => {
    expect(shouldRenderDetachedWalletConnectOverlay({
      isTauriNative: true,
      flowStep: 'idle',
    })).toBe(false);
    expect(shouldRenderDetachedLedgerOverlay({
      isTauriNative: true,
      flowStep: 'idle',
    })).toBe(false);
  });
});

describe('buildDesktopBrowserConnectUrl', () => {
  it('targets the shared /connect page with desktop surface and bridge credentials', () => {
    const url = new URL(buildDesktopBrowserConnectUrl({
      walletHostUrl: 'http://127.0.0.1:5174/app?wallet=phantom',
      bridgeUrl: 'http://127.0.0.1:8787',
      bridgeToken: 'test-token',
    }));
    expect(url.origin).toBe('http://127.0.0.1:5174');
    expect(url.pathname).toBe('/connect');
    expect(url.searchParams.get('bridgeUrl')).toBe('http://127.0.0.1:8787');
    expect(url.searchParams.get('token')).toBe('test-token');
    expect(url.searchParams.get('mode')).toBe('cli');
    expect(url.searchParams.get('intent')).toBe('connect');
    expect(url.searchParams.get('surface')).toBe('desktop');
    expect(url.searchParams.has('wallet')).toBe(false);
  });

  it('omits the token param when bridgeToken is empty (avoids leaking a wrong default)', () => {
    const url = new URL(buildDesktopBrowserConnectUrl({
      walletHostUrl: 'http://127.0.0.1:5174',
      bridgeUrl: 'http://127.0.0.1:8787',
      bridgeToken: '',
    }));
    expect(url.searchParams.has('token')).toBe(false);
  });

  it('embeds the rotated Rust-generated token verbatim', () => {
    const rotatedToken = 'b'.repeat(48);
    const url = new URL(buildDesktopBrowserConnectUrl({
      walletHostUrl: 'http://127.0.0.1:5174',
      bridgeUrl: 'http://127.0.0.1:8787',
      bridgeToken: rotatedToken,
    }));
    expect(url.searchParams.get('token')).toBe(rotatedToken);
  });

  it('builds a dedicated desktop /sign URL for one request', () => {
    const url = new URL(buildDesktopBrowserIntentUrl({
      walletHostUrl: 'http://127.0.0.1:5174/connect',
      bridgeUrl: 'http://127.0.0.1:8787',
      bridgeToken: 'test-token',
      intent: 'sign',
      requestId: 'req-123',
    }));
    expect(url.pathname).toBe('/sign');
    expect(url.searchParams.get('intent')).toBe('sign');
    expect(url.searchParams.get('surface')).toBe('desktop');
    expect(url.searchParams.get('requestId')).toBe('req-123');
  });
});

describe('desktop bridge readiness', () => {
  it('requires both a running child process and reachable endpoint', () => {
    expect(isDesktopBridgeReady({ running: true, bridgeReachable: true })).toBe(true);
    expect(isDesktopBridgeReady({ running: true, bridgeReachable: false })).toBe(false);
    expect(isDesktopBridgeReady({ running: false, bridgeReachable: true })).toBe(false);
    expect(isDesktopBridgeReady(null)).toBe(false);
  });

  it('prefers the latest IPC fallback error for not-ready messaging', () => {
    expect(desktopBridgeNotReadyMessage(null, 'IPC unavailable')).toBe('IPC unavailable');
  });

  it('uses the runtime lastError when present', () => {
    expect(desktopBridgeNotReadyMessage({
      running: false,
      bridgeReachable: false,
      lastError: 'Bridge did not become reachable at http://127.0.0.1:8787.',
    })).toBe('Bridge did not become reachable at http://127.0.0.1:8787.');
  });

  it('falls back to warning diagnostics before the generic message', () => {
    expect(desktopBridgeNotReadyMessage({
      running: false,
      bridgeReachable: false,
      diagnostics: [
        { level: 'info', label: 'Runtime', message: 'Informational only.' },
        { level: 'warn', label: 'Config', message: 'Missing action config.' },
      ],
    })).toBe('Missing action config.');
  });
});

describe('initialDesktopConnectFlowState', () => {
  it('starts at idle with no brand, no poll start, and no QR wallet picked', () => {
    expect(initial()).toEqual({
      step: 'idle',
      extensionDiscovered: false,
      selectedBrandId: null,
      awaitingBrowserStartedAt: null,
      qrWallet: null,
    });
  });
});

describe('reduceDesktopConnectFlow — startMethod', () => {
  it('transitions idle → method', () => {
    const next = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    expect(next.step).toBe('method');
  });

  it('is a no-op when already past idle (prevents accidental state loss)', () => {
    const atMethod = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const again = reduceDesktopConnectFlow(atMethod, { type: 'startMethod' });
    expect(again).toBe(atMethod);
  });
});

describe('reduceDesktopConnectFlow — pickMethod', () => {
  const method = (): DesktopConnectFlowState =>
    reduceDesktopConnectFlow(initial(), { type: 'startMethod' });

  it('extension → extension (browser wallet controls stay inline)', () => {
    const next = reduceDesktopConnectFlow(method(), { type: 'pickMethod', method: 'extension' });
    expect(next.step).toBe('extension');
    expect(next.extensionDiscovered).toBe(false);
    expect(next.selectedBrandId).toBeNull();
  });

  it('qr → qr (no brand yet)', () => {
    const next = reduceDesktopConnectFlow(method(), { type: 'pickMethod', method: 'qr' });
    expect(next.step).toBe('qr');
    expect(next.selectedBrandId).toBeNull();
  });

  it('ledger → ledger', () => {
    const next = reduceDesktopConnectFlow(method(), { type: 'pickMethod', method: 'ledger' });
    expect(next.step).toBe('ledger');
  });

  it('is ignored when not in method step', () => {
    const next = reduceDesktopConnectFlow(initial(), {
      type: 'pickMethod',
      method: 'qr',
    });
    expect(next.step).toBe('idle');
  });
});

describe('reduceDesktopConnectFlow — beginAwaitingBrowser', () => {
  it('moves to awaiting-browser and stamps the start time', () => {
    const next = reduceDesktopConnectFlow(initial(), {
      type: 'beginAwaitingBrowser',
      brandId: 'phantom',
      startedAt: 1000,
    });
    expect(next.step).toBe('awaiting-browser');
    expect(next.selectedBrandId).toBe('phantom');
    expect(next.awaitingBrowserStartedAt).toBe(1000);
  });

  it('allows brandless browser waits for the shared /connect page', () => {
    const next = reduceDesktopConnectFlow(initial(), {
      type: 'beginAwaitingBrowser',
      startedAt: 1000,
    });
    expect(next.step).toBe('awaiting-browser');
    expect(next.selectedBrandId).toBeNull();
    expect(next.awaitingBrowserStartedAt).toBe(1000);
  });
});

describe('reduceDesktopConnectFlow — back', () => {
  it('method → idle', () => {
    const atMethod = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const back = reduceDesktopConnectFlow(atMethod, { type: 'back' });
    expect(back.step).toBe('idle');
  });

  it('qr with no wallet picked → method', () => {
    const atMethod = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const atQr = reduceDesktopConnectFlow(atMethod, { type: 'pickMethod', method: 'qr' });
    const back = reduceDesktopConnectFlow(atQr, { type: 'back' });
    expect(back.step).toBe('method');
  });

  it('extension → method', () => {
    const atMethod = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const atExtension = reduceDesktopConnectFlow(atMethod, {
      type: 'pickMethod',
      method: 'extension',
    });
    const back = reduceDesktopConnectFlow(atExtension, { type: 'back' });
    expect(back.step).toBe('method');
  });

  it('ledger → method', () => {
    const atMethod = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const atLedger = reduceDesktopConnectFlow(atMethod, {
      type: 'pickMethod',
      method: 'ledger',
    });
    const back = reduceDesktopConnectFlow(atLedger, { type: 'back' });
    expect(back.step).toBe('method');
  });

  it('awaiting-browser → method (clears brand + start time)', () => {
    const at = reduceDesktopConnectFlow(initial(), {
      type: 'beginAwaitingBrowser',
      brandId: 'phantom',
      startedAt: 1000,
    });
    const back = reduceDesktopConnectFlow(at, { type: 'back' });
    expect(back.step).toBe('method');
    expect(back.selectedBrandId).toBeNull();
    expect(back.awaitingBrowserStartedAt).toBeNull();
  });

  it('idle is a no-op (returns same state object)', () => {
    const initialState = initial();
    expect(reduceDesktopConnectFlow(initialState, { type: 'back' })).toBe(initialState);
  });
});

describe('reduceDesktopConnectFlow — markExtensionDiscovered', () => {
  function atExtension(): DesktopConnectFlowState {
    const m = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    return reduceDesktopConnectFlow(m, { type: 'pickMethod', method: 'extension' });
  }

  it('marks the Browser extension step as explicitly discovered', () => {
    const next = reduceDesktopConnectFlow(atExtension(), { type: 'markExtensionDiscovered' });
    expect(next.step).toBe('extension');
    expect(next.extensionDiscovered).toBe(true);
  });

  it('is ignored outside the Browser extension step', () => {
    const method = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    expect(reduceDesktopConnectFlow(method, { type: 'markExtensionDiscovered' })).toBe(method);
  });

  it('back from Browser extension clears the discovery flag', () => {
    const discovered = reduceDesktopConnectFlow(atExtension(), { type: 'markExtensionDiscovered' });
    const back = reduceDesktopConnectFlow(discovered, { type: 'back' });
    expect(back.step).toBe('method');
    expect(back.extensionDiscovered).toBe(false);
  });
});

describe('reduceDesktopConnectFlow — reset', () => {
  it('jumps from any step straight to idle', () => {
    const at = reduceDesktopConnectFlow(initial(), {
      type: 'beginAwaitingBrowser',
      brandId: 'phantom',
      startedAt: 1000,
    });
    const r = reduceDesktopConnectFlow(at, { type: 'reset' });
    expect(r).toEqual(initialDesktopConnectFlowState());
  });

  it('idle → idle is a no-op (returns same object)', () => {
    const initialState = initial();
    expect(reduceDesktopConnectFlow(initialState, { type: 'reset' })).toBe(initialState);
  });
});

describe('reduceDesktopConnectFlow — pickQrWallet', () => {
  function atQr(): DesktopConnectFlowState {
    const m = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    return reduceDesktopConnectFlow(m, { type: 'pickMethod', method: 'qr' });
  }

  it('entering the QR step always starts on the picker (qrWallet === null)', () => {
    expect(atQr().qrWallet).toBeNull();
  });

  it('picks Backpack as the QR wallet', () => {
    const next = reduceDesktopConnectFlow(atQr(), {
      type: 'pickQrWallet',
      wallet: 'backpack',
    });
    expect(next.step).toBe('qr');
    expect(next.qrWallet).toBe('backpack');
  });

  it('picks Phantom as the QR wallet', () => {
    const next = reduceDesktopConnectFlow(atQr(), {
      type: 'pickQrWallet',
      wallet: 'phantom',
    });
    expect(next.qrWallet).toBe('phantom');
  });

  it('switching wallets while in the QR step replaces the selection', () => {
    const backpack = reduceDesktopConnectFlow(atQr(), {
      type: 'pickQrWallet',
      wallet: 'backpack',
    });
    const solflare = reduceDesktopConnectFlow(backpack, {
      type: 'pickQrWallet',
      wallet: 'solflare',
    });
    expect(solflare.qrWallet).toBe('solflare');
  });

  it('picking the already-active wallet is a no-op (returns same object)', () => {
    const backpack = reduceDesktopConnectFlow(atQr(), {
      type: 'pickQrWallet',
      wallet: 'backpack',
    });
    expect(reduceDesktopConnectFlow(backpack, { type: 'pickQrWallet', wallet: 'backpack' })).toBe(
      backpack,
    );
  });

  it('is ignored outside the QR step', () => {
    const method = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const noop = reduceDesktopConnectFlow(method, { type: 'pickQrWallet', wallet: 'phantom' });
    expect(noop).toBe(method);
  });
});

describe('reduceDesktopConnectFlow — back behaviour on the QR step', () => {
  function atQrWith(wallet: 'backpack' | 'jupiter' | 'phantom' | 'solflare'): DesktopConnectFlowState {
    const m = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const qr = reduceDesktopConnectFlow(m, { type: 'pickMethod', method: 'qr' });
    return reduceDesktopConnectFlow(qr, { type: 'pickQrWallet', wallet });
  }

  it('back from a picked wallet returns to the picker (qrWallet = null)', () => {
    const back = reduceDesktopConnectFlow(atQrWith('phantom'), { type: 'back' });
    expect(back.step).toBe('qr');
    expect(back.qrWallet).toBeNull();
  });

  it('back from the picker pops to method', () => {
    const m = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const qr = reduceDesktopConnectFlow(m, { type: 'pickMethod', method: 'qr' });
    const back = reduceDesktopConnectFlow(qr, { type: 'back' });
    expect(back.step).toBe('method');
  });

  it('two backs from a picked wallet reach the method picker', () => {
    const back1 = reduceDesktopConnectFlow(atQrWith('backpack'), { type: 'back' });
    const back2 = reduceDesktopConnectFlow(back1, { type: 'back' });
    expect(back2.step).toBe('method');
  });
});

describe('reduceDesktopConnectFlow — pickMethod resets qrWallet', () => {
  it('re-entering the QR step from method always lands on the picker', () => {
    const m1 = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const qr1 = reduceDesktopConnectFlow(m1, { type: 'pickMethod', method: 'qr' });
    const phantom = reduceDesktopConnectFlow(qr1, {
      type: 'pickQrWallet',
      wallet: 'phantom',
    });
    const back1 = reduceDesktopConnectFlow(phantom, { type: 'back' }); // → picker
    const back2 = reduceDesktopConnectFlow(back1, { type: 'back' }); // → method
    const qr2 = reduceDesktopConnectFlow(back2, { type: 'pickMethod', method: 'qr' });
    expect(qr2.qrWallet).toBeNull();
  });
});
