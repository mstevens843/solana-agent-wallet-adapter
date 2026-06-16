import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AsyncPairBridge, NativePairBridge } from '../bridgePairing.js';
import { buildPhonePairingDeps, mountPhonePairingPanel } from '../bridgePairingUi.js';

class FakeElement {
  readonly tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = '';
  value = '';
  placeholder = '';
  className = '';
  muted = false;
  srcObject: unknown = null;
  hidden = false;
  disabled = false;
  style: Record<string, string> & { cssText: string } = { cssText: '' };
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, Array<(event: unknown) => void>> = {};
  readonly classList = {
    add: (...classes: string[]) => {
      const current = new Set(this.className.split(/\s+/).filter(Boolean));
      classes.forEach((className) => current.add(className));
      this.className = Array.from(current).join(' ');
    },
  };

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners[type] ??= [];
    this.listeners[type]!.push(handler);
  }

  append(...nodes: FakeElement[]): void {
    nodes.forEach((node) => {
      node.parent = this;
      this.children.push(node);
    });
  }

  replaceWith(node: FakeElement): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index < 0) return;
    node.parent = this.parent;
    this.parent.children[index] = node;
    this.parent = null;
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  click(): void {
    this.listeners.click?.forEach((handler) => handler({ target: this, currentTarget: this }));
  }

  async play(): Promise<void> {
    return undefined;
  }

  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }
}

function installFakeDocument(): { body: FakeElement; createElement: (tagName: string) => FakeElement } {
  const fakeDocument = {
    body: new FakeElement('body'),
    createElement: (tagName: string) => new FakeElement(tagName),
  };
  vi.stubGlobal('document', fakeDocument);
  return fakeDocument;
}

function elementsByTag(root: FakeElement, tagName: string): FakeElement[] {
  const normalized = tagName.toLowerCase();
  return [
    ...(root.tagName === normalized ? [root] : []),
    ...root.children.flatMap((child) => elementsByTag(child, normalized)),
  ];
}

// Select by stable class instead of positional button index so a future control inserted
// before these does not silently mis-target a test.
function byClass(root: FakeElement, className: string): FakeElement | null {
  if (root.className.split(/\s+/).filter(Boolean).includes(className)) return root;
  for (const child of root.children) {
    const found = byClass(child, className);
    if (found) return found;
  }
  return null;
}

const scanButton = (root: FakeElement): FakeElement | null => byClass(root, 'phone-pairing-scan-button');
const clipboardPasteButton = (root: FakeElement): FakeElement | null =>
  byClass(root, 'phone-pairing-clipboard-paste-button');
const connectButton = (root: FakeElement): FakeElement | null => byClass(root, 'phone-pairing-connect-button');

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function captureDiagLogs(): { info: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn> } {
  vi.stubGlobal('__AGENTIC_DEVICE_AGENT_DEBUG__', true);
  return {
    info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  };
}

function logged(spy: ReturnType<typeof vi.spyOn>, pattern: string): boolean {
  return spy.mock.calls.some((call: unknown[]) => String(call[0]).includes(pattern));
}

describe('mountPhonePairingPanel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a clear error for invalid pasted pairing codes', () => {
    const document = installFakeDocument();
    const logs = captureDiagLogs();
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: undefined,
      onPaired: vi.fn(),
    });

    elementsByTag(container, 'textarea')[0]!.value = 'not a pairing payload';
    connectButton(container)!.click();

    expect(container.lastElementChild?.textContent).toContain('valid');
    expect(container.lastElementChild?.attributes.role).toBe('alert');
    expect(container.lastElementChild?.attributes['aria-live']).toBe('assertive');
    expect(logged(logs.info, 'bridge-pair.phone_panel_mount')).toBe(true);
    expect(logged(logs.info, 'bridge-pair.paste_click chars=21')).toBe(true);
    expect(logged(logs.warn, 'bridge-pair.paste_bad_payload chars=21')).toBe(true);
    cleanup();
  });

  it('pastes a pairing code from the native clipboard without connecting immediately', async () => {
    const document = installFakeDocument();
    const logs = captureDiagLogs();
    const container = document.createElement('div');
    const pairingCode = JSON.stringify({
      relay: 'https://agentic-signer.com',
      uuid: 'uuid-1',
      token: 'token-1',
    });
    const bridgePair = vi.fn();
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: { bridgePair },
      readClipboardText: vi.fn(async () => ({
        kind: 'text' as const,
        source: 'android-native' as const,
        text: ` ${pairingCode} `,
      })),
      onPaired: vi.fn(),
    });
    const textarea = elementsByTag(container, 'textarea')[0]!;
    const focusSpy = vi.fn();
    (textarea as unknown as { focus: (options?: unknown) => void }).focus = focusSpy;

    clipboardPasteButton(container)!.click();
    await flushMicrotasks();

    expect(textarea.value).toBe(pairingCode);
    expect(focusSpy).not.toHaveBeenCalled();
    expect(bridgePair).not.toHaveBeenCalled();
    expect(container.lastElementChild?.textContent).toContain('Pairing code pasted');
    expect(logged(logs.info, 'bridge-pair.clipboard_paste_done')).toBe(true);
    cleanup();
  });

  it('shows a clear error when the pairing clipboard is empty', async () => {
    const document = installFakeDocument();
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: undefined,
      readClipboardText: vi.fn(async () => ({
        kind: 'text' as const,
        source: 'android-native' as const,
        text: '   ',
      })),
      onPaired: vi.fn(),
    });

    clipboardPasteButton(container)!.click();
    await flushMicrotasks();

    expect(container.lastElementChild?.textContent).toContain('Clipboard empty');
    cleanup();
  });

  it('shows a native clipboard failure when pairing paste is blocked', async () => {
    const document = installFakeDocument();
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: undefined,
      readClipboardText: vi.fn(async () => ({
        kind: 'unavailable' as const,
        reason: 'android-native-failed' as const,
      })),
      onPaired: vi.fn(),
    });

    clipboardPasteButton(container)!.click();
    await flushMicrotasks();

    expect(container.lastElementChild?.textContent).toContain('Android blocked clipboard access');
    expect(clipboardPasteButton(container)!.disabled).toBe(false);
    cleanup();
  });

  it('explains the Paste button is unavailable when no clipboard reader is wired', async () => {
    const document = installFakeDocument();
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: undefined,
      onPaired: vi.fn(),
    });

    const pasteButton = clipboardPasteButton(container)!;
    pasteButton.click();
    await flushMicrotasks();

    expect(container.lastElementChild?.textContent).toContain('unavailable here');
    // Guard returns before the disable/finally, so the button must stay tappable.
    expect(pasteButton.disabled).toBe(false);
    cleanup();
  });

  it('re-enables the Paste button after an empty clipboard', async () => {
    const document = installFakeDocument();
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: undefined,
      readClipboardText: vi.fn(async () => ({
        kind: 'text' as const,
        source: 'android-native' as const,
        text: '   ',
      })),
      onPaired: vi.fn(),
    });

    clipboardPasteButton(container)!.click();
    await flushMicrotasks();

    expect(clipboardPasteButton(container)!.disabled).toBe(false);
    cleanup();
  });

  it.each([
    ['android-native-missing', 'does not expose one-tap paste'],
    ['ios-native-missing', 'does not expose one-tap paste'],
    ['ios-native-failed', 'iOS blocked clipboard access'],
    ['web-unavailable', 'unavailable here'],
    ['web-failed', 'unavailable here'],
  ] as const)('maps the %s clipboard reason to clear pairing copy', async (reason, expected) => {
    const document = installFakeDocument();
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: undefined,
      readClipboardText: vi.fn(async () => ({ kind: 'unavailable' as const, reason })),
      onPaired: vi.fn(),
    });

    clipboardPasteButton(container)!.click();
    await flushMicrotasks();

    expect(container.lastElementChild?.textContent).toContain(expected);
    cleanup();
  });

  it('falls back to paste when camera QR scanning is unavailable', () => {
    const document = installFakeDocument();
    vi.stubGlobal('navigator', {});
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: undefined,
      onPaired: vi.fn(),
    });

    scanButton(container)!.click();

    expect(container.lastElementChild?.textContent).toContain('paste the code instead');
    cleanup();
  });

  it('uses the native Android QR scanner when the bridge exposes it', async () => {
    vi.useFakeTimers();
    const document = installFakeDocument();
    const logs = captureDiagLogs();
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => new ArrayBuffer(32)),
      },
    });
    const onPaired = vi.fn();
    let scanRequestId = '';
    // Regular function (not arrow) so `this` is observable: Android WebView requires
    // bridge methods to be invoked as a property of the injected object. A detached
    // call would land here with `this === undefined`, mirroring the native rejection.
    let scanThis: unknown;
    const bridgeScanPairingQr = vi.fn(function (this: unknown, requestId: string) {
      scanThis = this;
      scanRequestId = requestId;
    });
    const bridgePair = vi.fn((_json: string) => JSON.stringify({ ok: true, status: 'pairing' }));
    const bridgePairStatus = vi.fn(() => JSON.stringify({ paired: true, pairing: false, enabled: true, error: null }));
    const bridge: NativePairBridge = { bridgeScanPairingQr, bridgePair, bridgePairStatus };
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, { bridge, onPaired });

    scanButton(container)!.click();
    await flushMicrotasks();

    expect(bridgeScanPairingQr).toHaveBeenCalledTimes(1);
    expect(scanThis).toBe(bridge);
    expect(scanRequestId).toMatch(/^pairing-qr-/);
    expect(logged(logs.info, 'bridge-pair.scan_click')).toBe(true);
    expect(logged(logs.info, 'nativeScanner=true')).toBe(true);

    const callbackBridge = (globalThis as unknown as {
      __agenticAndroidQrScannerBridge: {
        resolve: (requestId: string, envelope: { ok: boolean; rawValue: string }) => void;
      };
    }).__agenticAndroidQrScannerBridge;
    callbackBridge.resolve(scanRequestId, {
      ok: true,
      rawValue: JSON.stringify({
        relay: 'https://agentic-signer.com',
        uuid: 'uuid-1',
        token: 'token-1',
      }),
    });
    await flushMicrotasks();

    expect(bridgePair).toHaveBeenCalledTimes(1);
    expect(logged(logs.info, 'bridge-pair.native_scan_payload_ok')).toBe(true);
    expect(logged(logs.info, 'relayHost=agentic-signer.com')).toBe(true);
    await vi.advanceTimersByTimeAsync(1200);
    expect(bridgePairStatus).toHaveBeenCalled();
    expect(onPaired).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('keeps paste fallback available when native QR scanner is cancelled', async () => {
    const document = installFakeDocument();
    let scanRequestId = '';
    const bridgeScanPairingQr = vi.fn((requestId: string) => {
      scanRequestId = requestId;
    });
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: { bridgeScanPairingQr },
      onPaired: vi.fn(),
    });

    scanButton(container)!.click();
    await flushMicrotasks();
    (globalThis as unknown as {
      __agenticAndroidQrScannerBridge: {
        resolve: (requestId: string, envelope: { ok: false; error: string }) => void;
      };
    }).__agenticAndroidQrScannerBridge.resolve(scanRequestId, { ok: false, error: 'cancelled' });
    await flushMicrotasks();

    expect(container.lastElementChild?.textContent).toContain('Scanner closed');
    expect(elementsByTag(container, 'textarea')[0]).toBeTruthy();
    cleanup();
  });

  it('shows the native scanner feature-disabled error clearly', async () => {
    const document = installFakeDocument();
    let scanRequestId = '';
    const bridgeScanPairingQr = vi.fn((requestId: string) => {
      scanRequestId = requestId;
    });
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: { bridgeScanPairingQr },
      onPaired: vi.fn(),
    });

    scanButton(container)!.click();
    await flushMicrotasks();
    (globalThis as unknown as {
      __agenticAndroidQrScannerBridge: {
        resolve: (requestId: string, envelope: { ok: false; error: string }) => void;
      };
    }).__agenticAndroidQrScannerBridge.resolve(scanRequestId, { ok: false, error: 'not_enabled' });
    await flushMicrotasks();

    expect(container.lastElementChild?.textContent).toContain('not enabled');
    cleanup();
  });

  it('shows the native scanner busy error clearly', async () => {
    const document = installFakeDocument();
    let scanRequestId = '';
    const bridgeScanPairingQr = vi.fn((requestId: string) => {
      scanRequestId = requestId;
    });
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: { bridgeScanPairingQr },
      onPaired: vi.fn(),
    });

    scanButton(container)!.click();
    await flushMicrotasks();
    (globalThis as unknown as {
      __agenticAndroidQrScannerBridge: {
        resolve: (requestId: string, envelope: { ok: false; error: string }) => void;
      };
    }).__agenticAndroidQrScannerBridge.resolve(scanRequestId, { ok: false, error: 'scanner_busy' });
    await flushMicrotasks();

    expect(container.lastElementChild?.textContent).toContain('already open');
    cleanup();
  });

  it('shows a native scanner exception instead of a generic scan failure', async () => {
    const document = installFakeDocument();
    const bridgeScanPairingQr = vi.fn(() => {
      throw new Error('Java exception was raised during method invocation');
    });
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: { bridgeScanPairingQr },
      onPaired: vi.fn(),
    });

    scanButton(container)!.click();
    await flushMicrotasks();

    expect(container.lastElementChild?.textContent).toContain('Android could not open the scanner');
    cleanup();
  });

  it('pairs through the native bridge and calls onPaired after status confirms', async () => {
    vi.useFakeTimers();
    const document = installFakeDocument();
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => new ArrayBuffer(32)),
      },
    });
    const onPaired = vi.fn();
    const bridgePair = vi.fn((_json: string) => JSON.stringify({ ok: true, status: 'pairing' }));
    const bridgePairStatus = vi.fn(() => JSON.stringify({ paired: true, pairing: false, enabled: true, error: null }));
    const bridge: NativePairBridge = { bridgePair, bridgePairStatus };
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, { bridge, onPaired });

    elementsByTag(container, 'textarea')[0]!.value = JSON.stringify({
      relay: 'https://agentic-signer.com',
      uuid: 'uuid-1',
      token: 'token-1',
    });
    connectButton(container)!.click();

    await flushMicrotasks();
    expect(bridgePair).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1200);

    expect(bridgePairStatus).toHaveBeenCalled();
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(container.lastElementChild?.textContent).toContain('AI now runs on your computer');
    expect(container.lastElementChild?.attributes.role).toBe('status');
    expect(container.lastElementChild?.attributes['aria-live']).toBe('polite');
    cleanup();
  });

  it('cleanup stops an active camera stream', async () => {
    const document = installFakeDocument();
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] };
    class Detector {
      async detect(): Promise<Array<{ rawValue: string }>> {
        return [];
      }
    }
    vi.stubGlobal('BarcodeDetector', Detector);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => stream),
      },
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
    const container = document.createElement('div');
    const cleanup = mountPhonePairingPanel(container as unknown as HTMLElement, {
      bridge: undefined,
      onPaired: vi.fn(),
    });

    scanButton(container)!.click();
    await flushMicrotasks();
    cleanup();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('buildPhonePairingDeps', () => {
  it('always forwards readClipboardText so the one-tap Paste button stays wired', () => {
    const readClipboardText = vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'web-unavailable' as const }));
    const onPaired = vi.fn();
    const bridge = { bridgePair: vi.fn() } as unknown as NativePairBridge;

    const deps = buildPhonePairingDeps({ bridge, readClipboardText, onPaired });

    expect(deps.readClipboardText).toBe(readClipboardText);
    expect(deps.bridge).toBe(bridge);
    expect(deps.onPaired).toBe(onPaired);
    expect('asyncBridge' in deps).toBe(false);
  });

  it('includes asyncBridge only when provided', () => {
    const asyncBridge = { scan: vi.fn(), pair: vi.fn(), status: vi.fn() } as unknown as AsyncPairBridge;
    const deps = buildPhonePairingDeps({
      bridge: undefined,
      asyncBridge,
      readClipboardText: vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'web-unavailable' as const })),
      onPaired: vi.fn(),
    });

    expect(deps.asyncBridge).toBe(asyncBridge);
  });
});
