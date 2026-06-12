// Self-contained pairing modals for the "use your ChatGPT/Claude plan from your computer" flow.
// Built imperatively (createElement → document.body) so they don't have to thread state through the
// main.ts render loop. All logic + logging lives in bridgePairing.ts; this is the DOM shell.
//
//  - openDesktopPairingModal: desktop (Tauri) — POST /bridge/pair/start, render the QR, poll status.
//  - openPhonePairingModal: phone (Android) — scan (BarcodeDetector) or paste the QR, claim via the
//    native bridge, poll status, and on success run onPaired() (which configures the paired-bridge
//    device-agent and switches the AI mode).

import {
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
import { logDeviceAgentDiag } from './deviceAgent/runtime/diagnosticLog.js';

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
  closeBtn.setAttribute('aria-label', 'Close');
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
  el.textContent = text;
  const color = tone === 'ok' ? '#5fe3a1' : tone === 'warn' ? '#ffb27a' : '#bcd3c7';
  el.style.cssText = `margin:10px 0 0;font-size:13px;color:${color};`;
  return el;
}

// --- Desktop -----------------------------------------------------------------------------------

export interface DesktopPairingDeps {
  bridgeRequest: BridgeRequestFn;
}

export async function openDesktopPairingModal(deps: DesktopPairingDeps): Promise<void> {
  const { body, onClose } = buildModalShell('Plan Connector QR');
  const intro = document.createElement('p');
  intro.style.cssText = 'margin:0;font-size:13px;color:#bcd3c7;';
  intro.textContent =
    'Scan this with Agentic Android to run AI on the plan connected to this computer. Keep this computer awake and signed in.';
  const qrWrap = document.createElement('div');
  qrWrap.style.cssText = 'display:flex;justify-content:center;margin:16px 0;min-height:240px;align-items:center;';
  const status = statusLine('Starting…');
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
      status.replaceWith(statusLine('Could not start pairing. Is the local bridge running?', 'warn'));
      return;
    }
    const dataUrl = await renderPairingQrDataUrl(state.qrPayload);
    if (dataUrl) {
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = 'Pairing QR code';
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
    status.replaceWith(statusLine('Waiting for Android to scan…'));
    const liveStatus = body.lastElementChild as HTMLElement;
    polling = setInterval(async () => {
      try {
        const s = await pollDesktopPairStatus(deps.bridgeRequest);
        pollFailures = 0;
        if (s.paired) {
          stopPolling();
          liveStatus.textContent = '✓ Android connected. You can close this and use AI from the phone.';
          liveStatus.style.color = '#5fe3a1';
        } else if (!s.active) {
          stopPolling();
          liveStatus.textContent = 'Pairing expired. Close and try again.';
          liveStatus.style.color = '#ffb27a';
        }
      } catch {
        // Bound the "Waiting…" state — after repeated poll failures the bridge/relay is unreachable,
        // so surface a terminal error instead of spinning forever.
        pollFailures += 1;
        if (pollFailures >= 5) {
          stopPolling();
          liveStatus.textContent = 'Couldn’t reach the pairing service. Check your connection, then close and try again.';
          liveStatus.style.color = '#ffb27a';
        }
      }
    }, 2000);
  } catch (err) {
    logDeviceAgentDiag('warn', 'bridge-pair.desktop_modal_error', { message: err instanceof Error ? err.message : String(err) });
    status.replaceWith(statusLine('Pairing failed to start. Make sure the local bridge is running.', 'warn'));
  }
}

// --- Phone -------------------------------------------------------------------------------------

export interface PhonePairingDeps {
  bridge: NativePairBridge | undefined;
  /** Called once the phone reports paired — wire this to configure the paired-bridge device agent. */
  onPaired: () => void;
}

export interface PhonePairingPanelOptions {
  introText?: string;
  scanLabel?: string;
  pasteLabel?: string;
  pasteButtonLabel?: string;
  connectedText?: string;
  invalidCodeText?: string;
}

export function openPhonePairingModal(deps: PhonePairingDeps): void {
  const { body, onClose } = buildModalShell('Scan computer QR');
  const cleanup = mountPhonePairingPanel(body, deps, {
    introText:
      'On your AI-connected computer, open the Agentic connector QR page. Then scan that QR here or paste the pairing code.',
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
  });
  container.innerHTML = '';
  container.classList.add('phone-pairing-panel');
  const intro = document.createElement('p');
  intro.style.cssText = 'margin:0;font-size:13px;color:#bcd3c7;';
  intro.textContent =
    options.introText
      ?? 'On your AI-connected computer, open the Agentic connector QR page. Then scan that QR here or paste the pairing code.';
  const video = document.createElement('video');
  video.setAttribute('playsinline', 'true');
  video.setAttribute('autoplay', 'true');
  video.muted = true;
  video.style.cssText = 'width:100%;border-radius:10px;margin:12px 0;display:none;background:#000;max-height:260px;';
  const scanBtn = makeButton(options.scanLabel ?? 'Scan computer QR');
  const pasteLabel = document.createElement('label');
  pasteLabel.textContent = options.pasteLabel ?? 'Or paste the pairing code:';
  pasteLabel.style.cssText = 'display:block;font-size:12px;color:#9fb8ab;margin-top:12px;';
  const pasteArea = document.createElement('textarea');
  pasteArea.placeholder = '{"v":1,"relay":"…","uuid":"…","token":"…"}';
  pasteArea.style.cssText = 'width:100%;height:64px;font-family:monospace;font-size:11px;background:#06100c;color:#cfe;border:1px solid #1f3a2c;border-radius:8px;padding:8px;margin-top:4px;';
  const pasteBtn = makeButton(options.pasteButtonLabel ?? 'Pair with this code');
  const status = statusLine('');
  container.append(intro, video, scanBtn, pasteLabel, pasteArea, pasteBtn, status);

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
    status.textContent = 'Pairing…';
    status.style.color = '#bcd3c7';
    const result = await startPhonePairing(deps.bridge, payload);
    if (!result.ok) {
      logDeviceAgentDiag('warn', 'bridge-pair.phone_pair_start_failed', {
        tag,
        error: result.error ?? '',
      });
      status.textContent = pairErrorMessage(result.error);
      status.style.color = '#ffb27a';
      return;
    }
    polling = setInterval(() => {
      const s = readPhonePairStatus(deps.bridge);
      if (s.paired) {
        if (polling) clearInterval(polling);
        polling = null;
        logDeviceAgentDiag('info', 'bridge-pair.phone_pair_status_paired', { tag });
        status.textContent = options.connectedText ?? '✓ Paired. AI now runs on your computer’s plan.';
        status.style.color = '#5fe3a1';
        deps.onPaired();
      } else if (s.error) {
        if (polling) clearInterval(polling);
        polling = null;
        logDeviceAgentDiag('warn', 'bridge-pair.phone_pair_status_error', {
          tag,
          error: s.error,
        });
        status.textContent = pairErrorMessage(s.error);
        status.style.color = '#ffb27a';
      }
    }, 1200);
  };

  pasteBtn.addEventListener('click', () => {
    const raw = pasteArea.value;
    logDeviceAgentDiag('info', 'bridge-pair.paste_click', { chars: raw.length });
    const payload = parsePairingPayload(pasteArea.value);
    if (!payload) {
      logDeviceAgentDiag('warn', 'bridge-pair.paste_bad_payload', { chars: raw.length });
      status.textContent = options.invalidCodeText ?? 'That code isn’t valid. Copy the whole pairing code from the computer.';
      status.style.color = '#ffb27a';
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
      browserDetector: Boolean(Detector),
      browserMedia,
    });
    if (deps.bridge?.bridgeScanPairingQr) {
      scanBtn.disabled = true;
      status.textContent = 'Opening camera…';
      status.style.color = '#bcd3c7';
      try {
        logDeviceAgentDiag('info', 'bridge-pair.native_scan_click', {});
        const rawValue = await scanPairingQrNative(deps.bridge);
        logDeviceAgentDiag('info', 'bridge-pair.native_scan_result', { rawChars: rawValue.length });
        const payload = parsePairingPayload(rawValue);
        if (!payload) {
          logDeviceAgentDiag('warn', 'bridge-pair.native_scan_bad_payload', { rawChars: rawValue.length });
          status.textContent = options.invalidCodeText ?? 'That code isn’t valid. Copy the whole pairing code from the computer.';
          status.style.color = '#ffb27a';
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
        status.textContent = nativeQrScanErrorMessage(code);
        status.style.color = code === 'cancelled' ? '#bcd3c7' : '#ffb27a';
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
      status.textContent = 'Camera scanning isn’t available here — paste the code instead.';
      status.style.color = '#ffb27a';
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
      status.textContent = 'Couldn’t open the camera — paste the code instead.';
      status.style.color = '#ffb27a';
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
      return 'Scanner closed. Scan again or paste the code instead.';
    case 'permission_denied':
      return 'Camera permission is off — allow camera access or paste the code instead.';
    case 'camera_unavailable':
      return 'No usable camera was found — paste the code instead.';
    case 'timeout':
      return 'Scanner timed out. Scan again or paste the code instead.';
    case 'origin':
      return 'Scanner was blocked by the Android bridge origin check — reload the app and try again.';
    case 'invalid_request':
      return 'Scanner request was rejected by Android — reload the app and try again.';
    case 'not_enabled':
      return 'Plan Connector scanning is not enabled in this app build — paste the code instead.';
    case 'scanner_busy':
      return 'Scanner is already open. Close it or wait, then scan again.';
    case 'scanner_unavailable':
      return 'This app build does not expose the native scanner — paste the code instead.';
    case 'native_exception':
      return 'Android could not open the scanner. Check logcat, or paste the code instead.';
    case 'scan_failed':
      return 'Scanner did not return a QR code — scan again or paste the code instead.';
    default:
      return 'Couldn’t scan the QR — paste the code instead.';
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
      return 'Plan Connector is not enabled in this app build.';
    case 'relay_not_allowed':
      return 'That code points at an untrusted server — scan the QR from your own computer.';
    case 'incomplete_payload':
    case 'bad_payload':
      return 'That code is incomplete. Copy the whole pairing code from the computer.';
    case 'bridge_unavailable':
      return 'Pairing isn’t available in this app build.';
    default:
      return code ? `Pairing failed: ${code}` : 'Pairing failed. Generate a fresh QR on your computer and try again.';
  }
}
