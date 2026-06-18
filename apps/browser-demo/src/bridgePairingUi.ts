// Self-contained pairing modals for the "use your ChatGPT/Claude plan from your computer" flow.
// Built imperatively (createElement → document.body) so they don't have to thread state through the
// main.ts render loop. All logic + logging lives in bridgePairing.ts; this is the DOM shell.
//
//  - openDesktopPairingModal: desktop (Tauri) — POST /bridge/pair/start, render the QR, poll status.
//  - openPhonePairingModal: phone (Android) — scan (BarcodeDetector) or paste the QR, claim via the
//    native bridge, poll status, and on success run onPaired() (which configures the paired-bridge
//    device-agent and switches the AI mode).

import {
  type AsyncPairBridge,
  type BridgeRequestFn,
  type NativePairBridge,
  type PairingPayload,
  parsePairingPayload,
  startDesktopPairing,
  pollDesktopPairStatus,
  stopDesktopPairing,
  renderPairingQrDataUrl,
  startPhonePairing,
  readPhonePairStatus,
  pairTag,
} from './bridgePairing.js';
import type {
  AiKeyPasteClipboardResult,
  AiKeyPasteClipboardUnavailableReason,
} from './aiKeyPaste.js';
import { logDeviceAgentDiag } from './deviceAgent/runtime/diagnosticLog.js';
import { t, tf } from './demo-i18n/uiLang.js';

interface NativeQrScanResult {
  ok?: boolean;
  rawValue?: string;
  error?: string;
}

interface NativeQrScannerPending {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface NativeQrScannerCallbackBridge {
  resolve(requestId: string, envelope: NativeQrScanResult): void;
  reject(requestId: string, envelope: NativeQrScanResult): void;
}

const NATIVE_QR_SCAN_TIMEOUT_MS = 120_000;
const nativeQrScannerPending = new Map<string, NativeQrScannerPending>();
let nativeQrScannerNonce = 0;

// The single close() of the currently-open modal — runs its registered cleanup (poll timers, camera
// stream) so opening another modal or any close path never leaks them.
let activeClose: (() => void) | null = null;

function closeActiveModal(): void {
  activeClose?.();
}

interface ModalShell {
  body: HTMLElement;
  close: () => void;
  /** Register teardown (clear intervals, stop camera). Runs once, on ANY close path. */
  onClose: (cleanup: () => void) => void;
}

function buildModalShell(title: string): ModalShell {
  closeActiveModal();
  const overlay = document.createElement('div');
  overlay.className = 'bridge-pair-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);padding:20px;';
  const panel = document.createElement('div');
  panel.className = 'bridge-pair-panel';
  panel.style.cssText =
    'background:#0b1410;border:1px solid #1f3a2c;border-radius:14px;max-width:420px;width:100%;color:#e7f2ea;padding:20px;box-shadow:0 16px 48px rgba(0,0,0,0.5);font-family:inherit;';
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:12px;';
  const heading = document.createElement('strong');
  heading.textContent = title;
  heading.style.cssText = 'font-size:16px;';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', t('Close'));
  closeBtn.style.cssText = 'background:transparent;border:0;color:#9fb8ab;font-size:18px;cursor:pointer;line-height:1;';
  const body = document.createElement('div');
  header.append(heading, closeBtn);
  panel.append(header, body);
  overlay.append(panel);
  let cleanup: (() => void) | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      cleanup?.();
    } catch {
      // teardown must never throw out of a close handler
    }
    overlay.remove();
    if (activeClose === close) activeClose = null;
  };
  closeBtn.addEventListener('click', close);
  // Backdrop click closes too — must run the SAME close() so cleanup fires (camera/timers).
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
  activeClose = close;
  return { body, close, onClose: (fn) => { cleanup = fn; } };
}

function statusLine(text: string, tone: 'info' | 'ok' | 'warn' = 'info'): HTMLElement {
  const el = document.createElement('p');
  el.style.cssText = 'margin:10px 0 0;font-size:13px;';
  setStatusLine(el, text, tone);
  return el;
}

function setStatusLine(el: HTMLElement, text: string, tone: 'info' | 'ok' | 'warn' = 'info'): void {
  el.textContent = text;
  el.style.color = tone === 'ok' ? '#5fe3a1' : tone === 'warn' ? '#ffb27a' : '#bcd3c7';
  // Live region so paste/pairing outcomes are announced to assistive tech.
  // Warnings interrupt; ordinary progress/success messages stay polite.
  el.setAttribute('role', tone === 'warn' ? 'alert' : 'status');
  el.setAttribute('aria-live', tone === 'warn' ? 'assertive' : 'polite');
}

// --- Desktop -----------------------------------------------------------------------------------

export interface DesktopPairingDeps {
  bridgeRequest: BridgeRequestFn;
}

export async function openDesktopPairingModal(deps: DesktopPairingDeps): Promise<void> {
  const { body, onClose } = buildModalShell(t('Plan Connector QR'));
  const intro = document.createElement('p');
  intro.style.cssText = 'margin:0;font-size:13px;color:#bcd3c7;';
  intro.textContent =
    t('Scan this with Agentic Android to run AI on the plan connected to this computer. Keep this computer awake and signed in.');
  const qrWrap = document.createElement('div');
  qrWrap.style.cssText = 'display:flex;justify-content:center;margin:16px 0;min-height:240px;align-items:center;';
  const status = statusLine(t('Starting…'));
  body.append(intro, qrWrap, status);

  let polling: ReturnType<typeof setInterval> | null = null;
  let pollFailures = 0;
  const stopPolling = () => {
    if (polling) {
      clearInterval(polling);
      polling = null;
    }
  };
  // On close: stop the UI poll, then ask the relay AUTHORITATIVELY whether a phone actually claimed.
  // Stop the desktop controller ONLY if not paired — a just-paired session reports paired:true and
  // keeps running to serve the phone; an abandoned (never-scanned) one is torn down so its controller
  // doesn't poll the relay forever (each poll touch()es the session, so it never TTL-sweeps). Using
  // server truth (not the ≤2s-lagging UI flag) closes BOTH the round-1 close-race and the round-2
  // abandoned-pairing leak.
  onClose(() => {
    stopPolling();
    void (async () => {
      try {
        const s = await pollDesktopPairStatus(deps.bridgeRequest);
        if (!s.paired) await stopDesktopPairing(deps.bridgeRequest);
      } catch {
        // Can't confirm — leave it; the controller's own abandon timeout reaps an unclaimed session.
      }
    })();
  });

  try {
    const state = await startDesktopPairing(deps.bridgeRequest);
    if (!state.qrPayload) {
      status.replaceWith(statusLine(t('Could not start pairing. Is the local bridge running?'), 'warn'));
      return;
    }
    const dataUrl = await renderPairingQrDataUrl(state.qrPayload);
    if (dataUrl) {
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = t('Pairing QR code');
      img.style.cssText = 'width:240px;height:240px;border-radius:8px;background:#fff;padding:8px;';
      qrWrap.append(img);
    } else {
      // Fallback: show the raw payload so the user can paste it on the phone.
      const pre = document.createElement('textarea');
      pre.readOnly = true;
      pre.value = state.qrPayload;
      pre.style.cssText = 'width:100%;height:90px;font-family:monospace;font-size:11px;background:#06100c;color:#cfe;border:1px solid #1f3a2c;border-radius:8px;padding:8px;';
      qrWrap.append(pre);
    }
    status.replaceWith(statusLine(t('Waiting for Android to scan…')));
    const liveStatus = body.lastElementChild as HTMLElement;
    polling = setInterval(async () => {
      try {
        const s = await pollDesktopPairStatus(deps.bridgeRequest);
        pollFailures = 0;
        if (s.paired) {
          stopPolling();
          liveStatus.textContent = t('Android connected. You can close this and use AI from the phone.');
          liveStatus.style.color = '#5fe3a1';
        } else if (!s.active) {
          stopPolling();
          liveStatus.textContent = t('Pairing expired. Close and try again.');
          liveStatus.style.color = '#ffb27a';
        }
      } catch {
        // Bound the "Waiting…" state — after repeated poll failures the bridge/relay is unreachable,
        // so surface a terminal error instead of spinning forever.
        pollFailures += 1;
        if (pollFailures >= 5) {
          stopPolling();
          liveStatus.textContent = t('Couldn’t reach the pairing service. Check your connection, then close and try again.');
          liveStatus.style.color = '#ffb27a';
        }
      }
    }, 2000);
  } catch (err) {
    logDeviceAgentDiag('warn', 'bridge-pair.desktop_modal_error', { message: err instanceof Error ? err.message : String(err) });
    status.replaceWith(statusLine(t('Pairing failed to start. Make sure the local bridge is running.'), 'warn'));
  }
}

// --- Phone -------------------------------------------------------------------------------------

export interface PhonePairingDeps {
  bridge: NativePairBridge | undefined;
  /** Async pairing driver for iOS (Promise-based native scanner + relay + E2EE). When present, scan/
   *  pair/status route through it instead of the synchronous Android `bridge`. */
  asyncBridge?: AsyncPairBridge;
  /** Called once the phone reports paired — wire this to configure the paired-bridge device agent.
   *  `connector` is the desktop's subscription connector from the QR (codex/claude/gemini), if present. */
  onPaired: (connector?: string) => void;
  readClipboardText?: () => Promise<AiKeyPasteClipboardResult>;
}

/**
 * Single assembly point for PhonePairingDeps so both mount sites (the Android pair-phone
 * modal and the Plan Connector panel) stay in lockstep. `readClipboardText` is REQUIRED here,
 * so a call site that forgets to wire the one-tap Paste button fails typecheck rather than
 * silently degrading to "Clipboard paste is unavailable here".
 */
export function buildPhonePairingDeps(input: {
  bridge: NativePairBridge | undefined;
  asyncBridge?: AsyncPairBridge;
  readClipboardText: () => Promise<AiKeyPasteClipboardResult>;
  onPaired: (connector?: string) => void;
}): PhonePairingDeps {
  return {
    bridge: input.bridge,
    ...(input.asyncBridge ? { asyncBridge: input.asyncBridge } : {}),
    readClipboardText: input.readClipboardText,
    onPaired: input.onPaired,
  };
}

export interface PhonePairingPanelOptions {
  introText?: string;
  scanLabel?: string;
  pasteLabel?: string;
  clipboardPasteButtonLabel?: string;
  pasteButtonLabel?: string;
  connectedText?: string;
  invalidCodeText?: string;
}

export function openPhonePairingModal(deps: PhonePairingDeps): void {
  const { body, onClose } = buildModalShell(t('Scan computer QR'));
  const cleanup = mountPhonePairingPanel(body, deps, {
    introText:
      t('On your AI-connected computer, open the Agentic connector QR page. Then scan that QR here or paste the pairing code.'),
  });
  onClose(cleanup);
}

export function mountPhonePairingPanel(
  container: HTMLElement,
  deps: PhonePairingDeps,
  options: PhonePairingPanelOptions = {},
): () => void {
  logDeviceAgentDiag('info', 'bridge-pair.phone_panel_mount', {
    nativeScanner: Boolean(deps.bridge?.bridgeScanPairingQr),
    nativePair: Boolean(deps.bridge?.bridgePair),
    nativeStatus: Boolean(deps.bridge?.bridgePairStatus),
    asyncBridge: Boolean(deps.asyncBridge),
  });
  container.innerHTML = '';
  container.classList.add('phone-pairing-panel');
  const intro = document.createElement('p');
  intro.style.cssText = 'margin:0;font-size:13px;color:#bcd3c7;';
  intro.textContent =
    options.introText
      ?? t('On your AI-connected computer, open the Agentic connector QR page. Then scan that QR here or paste the pairing code.');
  const video = document.createElement('video');
  video.setAttribute('playsinline', 'true');
  video.setAttribute('autoplay', 'true');
  video.muted = true;
  video.style.cssText = 'width:100%;border-radius:10px;margin:12px 0;display:none;background:#000;max-height:260px;';
  const scanBtn = makeButton(options.scanLabel ?? t('Scan computer QR'));
  scanBtn.classList.add('phone-pairing-scan-button');
  const pasteLabel = document.createElement('label');
  pasteLabel.textContent = options.pasteLabel ?? t('Or paste the pairing code:');
  pasteLabel.style.cssText = 'display:block;font-size:12px;color:#9fb8ab;margin-top:12px;';
  const pasteArea = document.createElement('textarea');
  // Stable id so captureMobileRailRenderSnapshot/restoreMobileRailRenderSnapshot can
  // preserve focus + caret across rail-sheet re-renders (it only restores elements with an id).
  pasteArea.id = 'phonePairingPasteArea';
  pasteArea.placeholder = '{"v":1,"relay":"…","uuid":"…","token":"…"}';
  // font-size:16px avoids iOS zoom-on-focus (mirrors the .phone-pairing-panel textarea rule).
  pasteArea.style.cssText = 'width:100%;height:64px;font-family:monospace;font-size:16px;background:#06100c;color:#cfe;border:1px solid #1f3a2c;border-radius:8px;padding:8px;margin-top:4px;';
  const clipboardPasteBtn = makeButton(options.clipboardPasteButtonLabel ?? t('Paste'));
  clipboardPasteBtn.classList.add('phone-pairing-clipboard-paste-button');
  const connectLabel = options.pasteButtonLabel ?? t('Pair with this code');
  const pasteBtn = makeButton(connectLabel);
  pasteBtn.classList.add('phone-pairing-connect-button');
  // Layout (grid, gap, margins, button width/margin overrides) is owned by the
  // .phone-pairing-actions rules in styles.css — no inline duplication here.
  const pasteActionRow = document.createElement('div');
  pasteActionRow.className = 'phone-pairing-actions';
  pasteActionRow.append(clipboardPasteBtn, pasteBtn);
  const status = statusLine('');
  container.append(intro, video, scanBtn, pasteLabel, pasteArea, pasteActionRow, status);

  let polling: ReturnType<typeof setInterval> | null = null;
  let stream: MediaStream | null = null;
  let scanning = false;
  const cleanup = () => {
    scanning = false;
    if (polling) clearInterval(polling);
    polling = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };

  const beginPairing = async (payload: PairingPayload) => {
    const tag = await pairTag(payload.uuid);
    logDeviceAgentDiag('info', 'bridge-pair.phone_pair_begin', {
      tag,
      relayHost: relayHostForLog(payload.relay),
      e2ee: Boolean(payload.e2ee),
    });
    cleanup();
    video.style.display = 'none';
    setStatusLine(status, t('Pairing…'));
    // iOS: claim runs in JS (relay + E2EE); a successful claim persists credentials, so the pairing is
    // confirmed immediately — no native status poll needed.
    if (deps.asyncBridge) {
      let asyncResult: { ok: boolean; error?: string };
      try {
        asyncResult = await deps.asyncBridge.pair(payload);
      } catch (err) {
        asyncResult = { ok: false, error: err instanceof Error ? err.message : 'pair_failed' };
      }
      if (!asyncResult.ok) {
        logDeviceAgentDiag('warn', 'bridge-pair.phone_pair_start_failed', { tag, error: asyncResult.error ?? '' });
        setStatusLine(status, pairErrorMessage(asyncResult.error), 'warn');
        return;
      }
      logDeviceAgentDiag('info', 'bridge-pair.phone_pair_status_paired', { tag });
      setStatusLine(status, options.connectedText ?? t('Paired. AI now runs on your computer’s plan.'), 'ok');
      deps.onPaired(payload.connector);
      return;
    }
    const result = await startPhonePairing(deps.bridge, payload);
    if (!result.ok) {
      logDeviceAgentDiag('warn', 'bridge-pair.phone_pair_start_failed', {
        tag,
        error: result.error ?? '',
      });
      setStatusLine(status, pairErrorMessage(result.error), 'warn');
      return;
    }
    polling = setInterval(() => {
      const s = readPhonePairStatus(deps.bridge);
      if (s.paired) {
        if (polling) clearInterval(polling);
        polling = null;
        logDeviceAgentDiag('info', 'bridge-pair.phone_pair_status_paired', { tag });
        setStatusLine(status, options.connectedText ?? t('Paired. AI now runs on your computer’s plan.'), 'ok');
        deps.onPaired(payload.connector);
      } else if (s.error) {
        if (polling) clearInterval(polling);
        polling = null;
        logDeviceAgentDiag('warn', 'bridge-pair.phone_pair_status_error', {
          tag,
          error: s.error,
        });
        setStatusLine(status, pairErrorMessage(s.error), 'warn');
      }
    }, 1200);
  };

  clipboardPasteBtn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
  });
  clipboardPasteBtn.addEventListener('click', async () => {
    logDeviceAgentDiag('info', 'bridge-pair.clipboard_paste_click', {
      available: Boolean(deps.readClipboardText),
    });
    if (!deps.readClipboardText) {
      setStatusLine(status, t('Clipboard paste is unavailable here. Type the code or use the system paste menu.'), 'warn');
      return;
    }
    clipboardPasteBtn.disabled = true;
    try {
      const clipboard = await deps.readClipboardText();
      if (clipboard.kind === 'unavailable') {
        logDeviceAgentDiag('warn', 'bridge-pair.clipboard_paste_unavailable', {
          reason: clipboard.reason,
        });
        setStatusLine(status, pairingPasteUnavailableMessage(clipboard.reason), 'warn');
        return;
      }
      const text = clipboard.text.trim();
      if (!text) {
        logDeviceAgentDiag('warn', 'bridge-pair.clipboard_paste_empty', {});
        setStatusLine(status, t('Clipboard empty. Copy the pairing code from your computer, then tap Paste.'), 'warn');
        return;
      }
      pasteArea.value = text;
      logDeviceAgentDiag('info', 'bridge-pair.clipboard_paste_done', {
        chars: text.length,
      });
      setStatusLine(status, tf('Pairing code pasted. Tap {connectLabel}.', { connectLabel }));
    } finally {
      clipboardPasteBtn.disabled = false;
    }
  });

  pasteBtn.addEventListener('click', () => {
    const raw = pasteArea.value;
    logDeviceAgentDiag('info', 'bridge-pair.paste_click', { chars: raw.length });
    const payload = parsePairingPayload(pasteArea.value);
    if (!payload) {
      logDeviceAgentDiag('warn', 'bridge-pair.paste_bad_payload', { chars: raw.length });
      setStatusLine(
        status,
        options.invalidCodeText ?? t('That code isn’t valid. Copy the whole pairing code from the computer.'),
        'warn',
      );
      return;
    }
    void pairTag(payload.uuid).then((tag) => {
      logDeviceAgentDiag('info', 'bridge-pair.paste_payload_ok', {
        tag,
        relayHost: relayHostForLog(payload.relay),
        e2ee: Boolean(payload.e2ee),
      });
    }).catch(() => undefined);
    void beginPairing(payload);
  });

  scanBtn.addEventListener('click', async () => {
    const Detector = (globalThis as Record<string, unknown>).BarcodeDetector as
      | (new (opts?: { formats?: string[] }) => { detect: (src: CanvasImageSource) => Promise<Array<{ rawValue: string }>> })
      | undefined;
    const browserMedia = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
    logDeviceAgentDiag('info', 'bridge-pair.scan_click', {
      nativeScanner: Boolean(deps.bridge?.bridgeScanPairingQr),
      asyncScanner: Boolean(deps.asyncBridge),
      browserDetector: Boolean(Detector),
      browserMedia,
    });
    // iOS: the native AVFoundation scanner resolves a Promise directly (no global callback bridge).
    if (deps.asyncBridge) {
      scanBtn.disabled = true;
      setStatusLine(status, t('Opening camera…'));
      try {
        const rawValue = await deps.asyncBridge.scanQr();
        const payload = parsePairingPayload(rawValue);
        if (!payload) {
          setStatusLine(
            status,
            options.invalidCodeText ?? t('That code isn’t valid. Copy the whole pairing code from the computer.'),
            'warn',
          );
          return;
        }
        void beginPairing(payload);
      } catch (err) {
        const code = err instanceof Error ? err.message : String(err);
        logDeviceAgentDiag('warn', 'bridge-pair.ios_scan_failed', { code });
        setStatusLine(status, nativeQrScanErrorMessage(code), code === 'cancelled' ? 'info' : 'warn');
      } finally {
        scanBtn.disabled = false;
      }
      return;
    }
    if (deps.bridge?.bridgeScanPairingQr) {
      scanBtn.disabled = true;
      setStatusLine(status, t('Opening camera…'));
      try {
        logDeviceAgentDiag('info', 'bridge-pair.native_scan_click', {});
        const rawValue = await scanPairingQrNative(deps.bridge);
        logDeviceAgentDiag('info', 'bridge-pair.native_scan_result', { rawChars: rawValue.length });
        const payload = parsePairingPayload(rawValue);
        if (!payload) {
          logDeviceAgentDiag('warn', 'bridge-pair.native_scan_bad_payload', { rawChars: rawValue.length });
          setStatusLine(
            status,
            options.invalidCodeText ?? t('That code isn’t valid. Copy the whole pairing code from the computer.'),
            'warn',
          );
          return;
        }
        const tag = await pairTag(payload.uuid);
        logDeviceAgentDiag('info', 'bridge-pair.native_scan_payload_ok', {
          tag,
          relayHost: relayHostForLog(payload.relay),
          e2ee: Boolean(payload.e2ee),
        });
        void beginPairing(payload);
      } catch (err) {
        const code = err instanceof Error ? err.message : String(err);
        logDeviceAgentDiag('warn', 'bridge-pair.native_scan_failed', { code });
        setStatusLine(status, nativeQrScanErrorMessage(code), code === 'cancelled' ? 'info' : 'warn');
      } finally {
        scanBtn.disabled = false;
      }
      return;
    }

    if (!Detector || !browserMedia) {
      logDeviceAgentDiag('warn', 'bridge-pair.camera_unavailable', {
        browserDetector: Boolean(Detector),
        browserMedia,
      });
      setStatusLine(status, t('Camera scanning isn’t available here - paste the code instead.'), 'warn');
      return;
    }
    try {
      logDeviceAgentDiag('info', 'bridge-pair.camera_get_user_media_start', {});
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      video.srcObject = stream;
      video.style.display = 'block';
      video.setAttribute('controls', 'false');
      await video.play();
      logDeviceAgentDiag('info', 'bridge-pair.camera_stream_ready', {});
      const detector = new Detector({ formats: ['qr_code'] });
      scanning = true;
      const tick = async () => {
        if (!scanning) return;
        try {
          const codes = await detector.detect(video);
          const payload = codes.length ? parsePairingPayload(codes[0]!.rawValue) : null;
          if (payload) {
            const tag = await pairTag(payload.uuid);
            logDeviceAgentDiag('info', 'bridge-pair.camera_payload_ok', {
              tag,
              relayHost: relayHostForLog(payload.relay),
              e2ee: Boolean(payload.e2ee),
            });
            void beginPairing(payload);
            return;
          }
        } catch {
          // keep scanning
        }
        if (scanning) requestAnimationFrame(() => void tick());
      };
      void tick();
    } catch (err) {
      logDeviceAgentDiag('warn', 'bridge-pair.camera_failed', { message: err instanceof Error ? err.message : String(err) });
      setStatusLine(status, t('Couldn’t open the camera - paste the code instead.'), 'warn');
    }
  });

  return cleanup;
}

function scanPairingQrNative(bridge: NativePairBridge): Promise<string> {
  if (!bridge.bridgeScanPairingQr) return Promise.reject(new Error('scanner_unavailable'));
  installNativeQrScannerCallbackBridge();
  const requestId = `pairing-qr-${Date.now()}-${nativeQrScannerNonce++}`;
  logDeviceAgentDiag('info', 'bridge-pair.native_scan_start', { requestId });
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      nativeQrScannerPending.delete(requestId);
      logDeviceAgentDiag('warn', 'bridge-pair.native_scan_timeout', { requestId });
      reject(new Error('timeout'));
    }, NATIVE_QR_SCAN_TIMEOUT_MS);
    nativeQrScannerPending.set(requestId, { resolve, reject, timer });
    try {
      // Call AS a method on the bridge so `this` is the injected `AgenticAndroid`
      // object. Android WebView rejects detached @JavascriptInterface calls with
      // "Java bridge method can't be invoked on a non-injected object".
      bridge.bridgeScanPairingQr!(requestId);
      logDeviceAgentDiag('info', 'bridge-pair.native_scan_invoked', { requestId });
    } catch (err) {
      globalThis.clearTimeout(timer);
      nativeQrScannerPending.delete(requestId);
      logDeviceAgentDiag('error', 'bridge-pair.native_scan_sync_throw', {
        requestId,
        message: err instanceof Error ? err.message : String(err),
      });
      reject(new Error('native_exception'));
    }
  });
}

function installNativeQrScannerCallbackBridge(): void {
  const root = globalThis as typeof globalThis & { __agenticAndroidQrScannerBridge?: NativeQrScannerCallbackBridge };
  if (root.__agenticAndroidQrScannerBridge) return;
  root.__agenticAndroidQrScannerBridge = {
    resolve(requestId, envelope) {
      settleNativeQrScan(requestId, envelope, false);
    },
    reject(requestId, envelope) {
      settleNativeQrScan(requestId, envelope, true);
    },
  };
}

function settleNativeQrScan(requestId: string, envelope: NativeQrScanResult, forceReject: boolean): void {
  const pending = nativeQrScannerPending.get(requestId);
  if (!pending) {
    logDeviceAgentDiag('warn', 'bridge-pair.native_scan_unmatched_callback', {
      requestId,
      error: typeof envelope?.error === 'string' ? envelope.error : '',
      ok: envelope?.ok === true,
    });
    return;
  }
  nativeQrScannerPending.delete(requestId);
  globalThis.clearTimeout(pending.timer);
  const error = typeof envelope?.error === 'string' ? envelope.error : 'scan_failed';
  if (forceReject || envelope?.ok === false) {
    logDeviceAgentDiag('warn', 'bridge-pair.native_scan_callback_error', { requestId, error });
    pending.reject(new Error(error));
    return;
  }
  const rawValue = typeof envelope?.rawValue === 'string' ? envelope.rawValue.trim() : '';
  if (!rawValue) {
    logDeviceAgentDiag('warn', 'bridge-pair.native_scan_empty_callback', { requestId, error });
    pending.reject(new Error(error));
    return;
  }
  logDeviceAgentDiag('info', 'bridge-pair.native_scan_callback_ok', { requestId, rawChars: rawValue.length });
  pending.resolve(rawValue);
}

function nativeQrScanErrorMessage(code: string): string {
  switch (code) {
    case 'cancelled':
      return t('Scanner closed. Scan again or paste the code instead.');
    case 'permission_denied':
      return t('Camera permission is off - allow camera access or paste the code instead.');
    case 'camera_unavailable':
      return t('No usable camera was found - paste the code instead.');
    case 'timeout':
      return t('Scanner timed out. Scan again or paste the code instead.');
    case 'origin':
      return t('Scanner was blocked by the Android bridge origin check - reload the app and try again.');
    case 'invalid_request':
      return t('Scanner request was rejected by Android - reload the app and try again.');
    case 'not_enabled':
      return t('Plan Connector scanning is not enabled in this app build - paste the code instead.');
    case 'scanner_busy':
      return t('Scanner is already open. Close it or wait, then scan again.');
    case 'scanner_unavailable':
      return t('This app build does not expose the native scanner - paste the code instead.');
    case 'native_exception':
      return t('Android could not open the scanner. Check logcat, or paste the code instead.');
    case 'scan_failed':
      return t('Scanner did not return a QR code - scan again or paste the code instead.');
    default:
      return t('Couldn’t scan the QR - paste the code instead.');
  }
}

function pairingPasteUnavailableMessage(reason: AiKeyPasteClipboardUnavailableReason): string {
  switch (reason) {
    case 'android-native-missing':
      return t('This Android build does not expose one-tap paste. Update the app, or type the code manually.');
    case 'android-native-failed':
      return t('Android blocked clipboard access. Copy the pairing code again, then tap Paste.');
    case 'ios-native-missing':
      return t('This iOS build does not expose one-tap paste. Update the app, or type the code manually.');
    case 'ios-native-failed':
      return t('iOS blocked clipboard access. Copy the pairing code again, then tap Paste.');
    default:
      return t('Clipboard paste is unavailable here. Type the code or use the system paste menu.');
  }
}

function relayHostForLog(relay: string): string {
  try {
    return new URL(relay).host;
  } catch {
    return 'invalid';
  }
}

function makeButton(label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.className = 'bridge-pair-button';
  btn.style.cssText =
    'width:100%;margin-top:8px;padding:10px;border-radius:8px;border:1px solid #2a5340;background:#12241b;color:#e7f2ea;font-size:13px;cursor:pointer;';
  return btn;
}

function pairErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'not_enabled':
      return t('Plan Connector is not enabled in this app build.');
    case 'relay_not_allowed':
      return t('That code points at an untrusted server - scan the QR from your own computer.');
    case 'incomplete_payload':
    case 'bad_payload':
      return t('That code is incomplete. Copy the whole pairing code from the computer.');
    case 'bridge_unavailable':
      return t('Pairing isn’t available in this app build.');
    default:
      return code ? tf('Pairing failed: {code}', { code }) : t('Pairing failed. Generate a fresh QR on your computer and try again.');
  }
}
