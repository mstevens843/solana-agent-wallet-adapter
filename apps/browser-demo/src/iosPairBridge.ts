// iOS Plan Connector pairing adapter. Bridges the Promise-based iOS world (native QR scanner +
// WebCrypto E2EE + relay HTTP) to the surface-agnostic `AsyncPairBridge` the pairing UI consumes.
//
// Unlike Android — where the native bridge holds the device bearer and runs the relay calls in Kotlin —
// on iOS the relay claim/forward/poll and the E2EE all run here in the live-shipping SPA. The ONLY
// native dependency is the camera QR scanner (AgenticQrScanner). Credentials live in the Keychain via
// AgenticSecureState. The relay is platform-agnostic, so this behaves identically to Android.

import {
  BridgeRelayError,
  type BridgePairCreds,
  type BridgeRelayStatus,
  type ForwardOptions,
  claimPairing,
  forwardAi,
  relayStatus,
  unpairRelay,
} from './bridgeRelayClient.js';
import type { AsyncPairBridge, PairingPayload, PhonePairStatus } from './bridgePairing.js';
import { logDeviceAgentDiag } from './deviceAgent/runtime/diagnosticLog.js';
import {
  iosSecureGet,
  iosSecureRemove,
  iosSecureSet,
  isIosQrScannerAvailable,
  scanIosPairingQr,
} from './iosNative.js';

const CREDS_KEY = 'agentic.ios.plan-connector.creds.v1';

let credsCache: BridgePairCreds | null = null;
let credsLoaded = false;

/** Load credentials from the Keychain into the in-memory cache (once). */
export async function loadIosPairCreds(): Promise<BridgePairCreds | null> {
  if (credsLoaded) return credsCache;
  try {
    const raw = await iosSecureGet(CREDS_KEY);
    credsCache = raw ? (JSON.parse(raw) as BridgePairCreds) : null;
  } catch {
    credsCache = null;
  }
  credsLoaded = true;
  return credsCache;
}

/** Synchronous read of the cached credentials (null until {@link loadIosPairCreds} resolves). */
export function currentIosPairCreds(): BridgePairCreds | null {
  return credsCache;
}

export function hasIosPairCreds(): boolean {
  return credsCache !== null;
}

async function storeCreds(creds: BridgePairCreds): Promise<void> {
  // The in-memory cache is authoritative for this session; the Keychain write only governs
  // persistence across launches. Surface a write failure (so a non-persisting pairing is visible)
  // without breaking the live session.
  credsCache = creds;
  credsLoaded = true;
  try {
    await iosSecureSet(CREDS_KEY, JSON.stringify(creds));
  } catch (err) {
    logDeviceAgentDiag('warn', 'bridge-pair.ios_creds_persist_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function clearIosPairCreds(): Promise<void> {
  credsCache = null;
  credsLoaded = true;
  try {
    await iosSecureRemove(CREDS_KEY);
  } catch (err) {
    logDeviceAgentDiag('warn', 'bridge-pair.ios_creds_clear_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function ensureCreds(): Promise<BridgePairCreds | null> {
  return credsCache ?? (await loadIosPairCreds());
}

/** The connector (codex/claude/gemini) of the active pairing, for provider display after a restart. */
export function iosPairedConnector(): string | undefined {
  return credsCache?.connector;
}

/** Build the AsyncPairBridge the pairing UI mounts. */
export function buildIosPairBridge(): AsyncPairBridge {
  return {
    enabled: () => isIosQrScannerAvailable(),
    scanQr: () => scanIosPairingQr(),
    async pair(payload: PairingPayload): Promise<{ ok: boolean; error?: string }> {
      try {
        const creds = await claimPairing(payload);
        await storeCreds(creds);
        logDeviceAgentDiag('info', 'bridge-pair.ios_paired', { connector: creds.connector ?? '' });
        return { ok: true };
      } catch (err) {
        const error = err instanceof BridgeRelayError ? err.code : 'pair_failed';
        logDeviceAgentDiag('warn', 'bridge-pair.ios_pair_failed', { error });
        return { ok: false, error };
      }
    },
    async status(): Promise<PhonePairStatus> {
      const creds = await ensureCreds();
      // Local credential presence == paired; desktopOnline is surfaced separately by the presence chip.
      return {
        paired: Boolean(creds),
        pairing: false,
        enabled: isIosQrScannerAvailable(),
        error: null,
      };
    },
    async unpair(): Promise<void> {
      const creds = await ensureCreds();
      if (creds) await unpairRelay(creds);
      await clearIosPairCreds();
    },
  };
}

/** Forward an AI request to the paired desktop over the relay. Throws if unpaired. */
export async function iosForwardPlanRequest<T>(path: string, body: unknown, options?: ForwardOptions): Promise<T> {
  const creds = await ensureCreds();
  if (!creds) {
    throw new BridgeRelayError('unpaired', "This phone isn't paired to a computer. Open Plan Connector on the computer, then scan the QR.");
  }
  return forwardAi<T>(creds, path, body, options);
}

/** Relay presence probe for the online/offline chip. Returns null when unpaired. */
export async function iosRelayPresence(): Promise<BridgeRelayStatus | null> {
  const creds = await ensureCreds();
  if (!creds) return null;
  try {
    return await relayStatus(creds);
  } catch {
    return { paired: true, desktopOnline: false };
  }
}
