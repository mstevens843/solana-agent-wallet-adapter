// Phone↔desktop pairing for the "use your ChatGPT/Claude plan from your computer" path.
//
// Two sides, one module:
//  - Desktop (Tauri webview): POST /bridge/pair/start to mint a QR, render it, poll /bridge/pair/status.
//  - Phone (Android WebView): parse the scanned/pasted QR, hand it to the native AgenticAndroid bridge
//    (which validates the relay host + claims + stores the device bearer), poll bridgePairStatus().
//
// Deterministic, secret-safe logging: every step emits one stable `[device-agent:diag] bridge-pair.*`
// line via logDeviceAgentDiag (keys sorted, no randomness). `tag` = first 8 hex of sha256(uuid), the
// SAME correlation id the relay / desktop / phone hops derive — so a pairing + its AI requests line up
// across all logs without ever logging the uuid (a bearer-grade secret) or the one-time token.

import { logDeviceAgentDiag } from './deviceAgent/runtime/diagnosticLog.js';

export interface PairingPayload {
  relay: string;
  uuid: string;
  token: string;
  /** Subscription connector the desktop runs (codex/claude/gemini), for provider display on the phone. */
  connector?: string;
  e2ee?: {
    alg: string;
    desktopPub: string;
    pairSecret: string;
  };
}

/** Honest AI-path copy (WS5): never imply a pure-phone subscription path exists. */
export const AI_PLAN_OPTION_COPY = {
  pairedBridge: {
    title: 'Plan Connector',
    subtitle: 'Runs on your own computer. Keep that computer awake and signed in.',
  },
  byoKey: {
    title: 'Paste an API key',
    subtitle: 'Works anywhere with no computer, billed to your own provider account.',
  },
} as const;

/** Parse a scanned/pasted QR payload: JSON `{ v, relay, uuid, token, e2ee? }` (see bridgePairingClient.ts). */
export function parsePairingPayload(text: string): PairingPayload | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const relay = typeof obj.relay === 'string' ? obj.relay.trim() : '';
  const uuid = typeof obj.uuid === 'string' ? obj.uuid.trim() : '';
  const token = typeof obj.token === 'string' ? obj.token.trim() : '';
  if (!relay || !uuid || !token) return null;
  const version = obj.v === undefined ? 1 : Number(obj.v);
  if (!Number.isInteger(version) || version < 1) return null;
  const e2ee = parsePairingE2ee(obj.e2ee);
  if (version >= 2 && !e2ee) return null;
  const connector = typeof obj.connector === 'string' && ['codex', 'claude', 'gemini'].includes(obj.connector.trim())
    ? obj.connector.trim()
    : undefined;
  return { relay, uuid, token, ...(connector ? { connector } : {}), ...(e2ee ? { e2ee } : {}) };
}

function parsePairingE2ee(value: unknown): PairingPayload['e2ee'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const alg = typeof obj.alg === 'string' ? obj.alg.trim() : '';
  const desktopPub = typeof obj.desktopPub === 'string' ? obj.desktopPub.trim() : '';
  const pairSecret = typeof obj.pairSecret === 'string' ? obj.pairSecret.trim() : '';
  if (!alg || !desktopPub || !pairSecret) return undefined;
  return { alg, desktopPub, pairSecret };
}

/** Correlation tag: first 8 hex of sha256(uuid). Best-effort (returns '' if SubtleCrypto absent). */
export async function pairTag(uuid: string): Promise<string> {
  try {
    const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
    if (!subtle) return '';
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(uuid));
    return Array.from(new Uint8Array(digest).slice(0, 4))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}

// --- Desktop side (Tauri) --------------------------------------------------------------------

export interface DesktopPairState {
  active: boolean;
  paired: boolean;
  pairUuid: string | null;
  relayBaseUrl: string;
  qrPayload: string | null;
  startedAt: number | null;
}

export type BridgeRequestFn = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

/** Start (or restart) a pairing on the desktop bridge and return the state (incl. the QR payload). */
export async function startDesktopPairing(bridgeRequest: BridgeRequestFn): Promise<DesktopPairState> {
  const state = await bridgeRequest<DesktopPairState>('/bridge/pair/start', { method: 'POST' });
  const tag = state.pairUuid ? await pairTag(state.pairUuid) : '';
  logDeviceAgentDiag('info', 'bridge-pair.desktop_start', {
    tag,
    relay: state.relayBaseUrl,
    hasQr: Boolean(state.qrPayload),
  });
  return state;
}

export async function pollDesktopPairStatus(bridgeRequest: BridgeRequestFn): Promise<DesktopPairState> {
  const state = await bridgeRequest<DesktopPairState>('/bridge/pair/status', { method: 'GET' });
  const tag = state.pairUuid ? await pairTag(state.pairUuid) : '';
  logDeviceAgentDiag('debug', 'bridge-pair.desktop_status', { tag, active: state.active, paired: state.paired });
  return state;
}

export async function stopDesktopPairing(bridgeRequest: BridgeRequestFn): Promise<void> {
  await bridgeRequest('/bridge/pair/stop', { method: 'POST' });
  logDeviceAgentDiag('info', 'bridge-pair.desktop_stop', {});
}

/** Render the QR payload to a data URL (dynamic `qrcode` import, mirroring main.ts's usage). */
export async function renderPairingQrDataUrl(qrPayload: string): Promise<string> {
  try {
    const mod = await import('qrcode');
    const generator = (mod as { default?: typeof import('qrcode') }).default ?? mod;
    return await generator.toDataURL(qrPayload, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  } catch (err) {
    logDeviceAgentDiag('warn', 'bridge-pair.qr_failed', { message: err instanceof Error ? err.message : String(err) });
    return '';
  }
}

// --- Phone side (Android WebView) ------------------------------------------------------------

export interface NativePairBridge {
  bridgePairEnabled?: () => boolean;
  bridgePair?: (payloadJson: string) => string;
  bridgePairStatus?: () => string;
  bridgeUnpair?: () => string;
  bridgeScanPairingQr?: (requestId: string) => void;
}

export interface PhonePairStatus {
  paired: boolean;
  pairing: boolean;
  enabled: boolean;
  error: string | null;
}

/**
 * Async pairing driver for surfaces whose native bridge is Promise-based (iOS Capacitor) rather than
 * the synchronous `@JavascriptInterface` Android exposes. `mountPhonePairingPanel` routes scan/pair/
 * status/unpair through this when present, leaving the synchronous Android `NativePairBridge` path
 * untouched. The concrete iOS implementation lives in `iosPairBridge.ts`.
 */
export interface AsyncPairBridge {
  /** Capability check: the native scanner/relay plumbing is present in this binary. */
  enabled(): boolean;
  /** Launch the native camera scanner and resolve with the raw scanned QR string. */
  scanQr(): Promise<string>;
  /** Claim the pairing (relay HTTP) and persist credentials. */
  pair(payload: PairingPayload): Promise<{ ok: boolean; error?: string }>;
  /** Current pairing status (local credentials + optional relay refinement). */
  status(): Promise<PhonePairStatus>;
  /** Revoke the pairing and clear stored credentials. */
  unpair(): Promise<void>;
}

/** Self-heal decision: a persisted `pairedBridge` flag should be cleared when it's set but the device
 *  can't actually be paired (not an Android app surface, or the native pairing is gone). Keeps the JS
 *  flag from booting into a "every request throws not-paired" mode after an app-data wipe / unpair. */
export function shouldClearPersistedPairedBridge(input: {
  pairedBridge: boolean;
  /** True when the current app surface can hold a native pairing at all (Android, or iOS with the
   *  pairing plugin present). A flag that rode onto a surface that can't pair is always cleared. */
  surfaceSupportsPairing: boolean;
  nativePaired: boolean;
}): boolean {
  if (!input.pairedBridge) return false;
  return !input.surfaceSupportsPairing || !input.nativePaired;
}

export function phonePairingEnabled(bridge: NativePairBridge | undefined): boolean {
  try {
    return Boolean(bridge?.bridgePairEnabled?.());
  } catch {
    return false;
  }
}

export interface StartPhonePairResult {
  ok: boolean;
  error?: string;
}

/** Hand a parsed pairing payload to the native bridge to claim + store (async; poll status after). */
export async function startPhonePairing(
  bridge: NativePairBridge | undefined,
  payload: PairingPayload,
): Promise<StartPhonePairResult> {
  const tag = await pairTag(payload.uuid);
  if (!bridge?.bridgePair) {
    logDeviceAgentDiag('warn', 'bridge-pair.phone_unavailable', { tag });
    return { ok: false, error: 'bridge_unavailable' };
  }
  let raw = '{}';
  try {
    raw = bridge.bridgePair(JSON.stringify(payload));
  } catch (err) {
    logDeviceAgentDiag('warn', 'bridge-pair.phone_threw', { tag, message: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: 'native_threw' };
  }
  const result = safeParse(raw);
  const ok = result.ok === true;
  const error = typeof result.error === 'string' ? result.error : undefined;
  logDeviceAgentDiag('info', 'bridge-pair.phone_start', { tag, ok, error: error ?? '' });
  return { ok, ...(error ? { error } : {}) };
}

export function readPhonePairStatus(bridge: NativePairBridge | undefined): PhonePairStatus {
  const fallback: PhonePairStatus = { paired: false, pairing: false, enabled: false, error: null };
  if (!bridge?.bridgePairStatus) return fallback;
  try {
    const parsed = safeParse(bridge.bridgePairStatus()) as Partial<PhonePairStatus>;
    const status: PhonePairStatus = {
      paired: Boolean(parsed.paired),
      pairing: Boolean(parsed.pairing),
      enabled: Boolean(parsed.enabled),
      error: typeof parsed.error === 'string' ? parsed.error : null,
    };
    logDeviceAgentDiag('debug', 'bridge-pair.phone_status', {
      paired: status.paired,
      pairing: status.pairing,
      hasError: status.error !== null,
    });
    return status;
  } catch {
    return fallback;
  }
}

export function unpairPhone(bridge: NativePairBridge | undefined): boolean {
  if (!bridge?.bridgeUnpair) return false;
  try {
    bridge.bridgeUnpair();
    logDeviceAgentDiag('info', 'bridge-pair.phone_unpaired', {});
    return true;
  } catch {
    return false;
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
