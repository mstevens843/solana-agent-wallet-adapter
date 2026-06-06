/**
 * Native IWA wallet backend (iOS only) for Phantom / Solflare / Backpack.
 *
 * This is the JS half of the integration with the shipped `ios-solana-wallet-adapter`
 * Swift package: it implements the same `WalletBackend` contract every wallet action
 * in the app already funnels through (`SolanaSigningClient` → `WalletBackend`), but
 * instead of building encrypted deeplinks in TypeScript (the legacy
 * `IosNativeWalletBackend`), it delegates connect + signing to the native
 * `AgenticNativeWallet` Capacitor plugin, which drives `WalletAdapterClient`.
 *
 * Jupiter is NOT handled here — it stays on the legacy `IosNativeWalletBackend`
 * WalletConnect path. Selection between this backend and the legacy one happens in
 * `main.ts` behind `IS_IOS_APP` + the `iosNativeIwaAdapter` feature flag.
 *
 * Capabilities deliberately report the SAME `backend: 'ios-native-${walletId}'`
 * strings as the legacy backend so `walletProofSigning.ts` keeps its existing
 * routing unchanged (Phantom/Solflare proofs via memo-tx, Backpack via signMessage).
 */
import { registerPlugin } from '@capacitor/core';

import {
  newSigningRequestId,
  ProtocolError,
  type AdapterCapabilities,
  type ApprovalResource,
  type Cluster,
  type SigningPayload,
  type SigningRequest,
  type SigningRequestId,
  type SigningResult,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';
import {
  encodeBase64,
  encodeUtf8,
  iosWalletDescriptor,
} from '@solana-agent-wallet-adapter/ios-link/deeplink';

import { getIosRemoteConfig } from './iosConfigClient.js';
import type { IosNativeLogLevel, IosNativeWalletId } from './iosNative.js';

/** Wallets routed through the native IWA adapter. Jupiter is intentionally excluded. */
export type NativeIwaWalletId = 'phantom' | 'solflare' | 'backpack';

const NATIVE_IWA_WALLET_IDS: ReadonlySet<string> = new Set<NativeIwaWalletId>([
  'phantom',
  'solflare',
  'backpack',
]);

/** True when `walletId` is a wallet the native IWA adapter can handle. */
export function isNativeIwaWalletId(walletId: string): walletId is NativeIwaWalletId {
  return NATIVE_IWA_WALLET_IDS.has(walletId);
}

const DEFAULT_REQUEST_TTL_MS = 120_000;
const IWA_FEATURE_FLAG = 'iosNativeIwaAdapter';

// ---------------------------------------------------------------------------
// Capacitor plugin surface (native AgenticNativeWalletPlugin)
// ---------------------------------------------------------------------------

interface AgenticNativeWalletPlugin {
  connect(options: { walletId: string; cluster: string }): Promise<{ publicKey: string }>;
  disconnect(): Promise<{ ok: boolean }>;
  getSession(): Promise<{ connected: boolean; publicKey?: string; walletId?: string }>;
  resumeSession(options: { walletId: string; cluster: string }): Promise<{ connected: boolean; publicKey?: string }>;
  signMessage(options: { message: string }): Promise<{ signature: string; signatureEncoding?: string }>;
  signTransaction(options: { transaction: string }): Promise<{ signature: string; transactionEncoding?: string }>;
  signAllTransactions(options: { transactions: string[] }): Promise<{ transactions: string[]; transactionEncoding?: string }>;
  signAndSendTransaction(options: { transaction: string }): Promise<{ signature: string; txid?: string }>;
  clearState(): Promise<{ cleared: boolean }>;
  clearAllState(): Promise<{ cleared: boolean }>;
}

const AgenticNativeWallet = registerPlugin<AgenticNativeWalletPlugin>('AgenticNativeWallet');

// ---------------------------------------------------------------------------
// Feature flag (default ON — see plan: prove the native path first)
// ---------------------------------------------------------------------------

let cachedIwaFlag: boolean | null = null;

/**
 * Synchronous read used by callers that can't await (e.g. `iosBackendOrNew`).
 * Defaults to ON when the flag has never been resolved or is absent server-side,
 * so the native adapter is the live path without any cloud-config change. Only an
 * explicit server `iosNativeIwaAdapter === false` (after `refreshNativeIwaAdapterFlag`)
 * flips back to the legacy JS-deeplink path.
 */
export function iosNativeIwaAdapterEnabled(): boolean {
  return cachedIwaFlag ?? true;
}

/** Pull the latest flag value from remote config; safe to call before connect/restore. */
export async function refreshNativeIwaAdapterFlag(): Promise<boolean> {
  try {
    const snapshot = await getIosRemoteConfig();
    const value = snapshot?.featureFlags?.[IWA_FEATURE_FLAG];
    cachedIwaFlag = typeof value === 'boolean' ? value : true;
  } catch {
    cachedIwaFlag = cachedIwaFlag ?? true;
  }
  return iosNativeIwaAdapterEnabled();
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export interface NativeIwaWalletBackendOptions {
  walletId: NativeIwaWalletId;
  cluster: Cluster;
  requestTtlMs?: number;
  logLevel?: IosNativeLogLevel;
}

export interface NativeIwaRestoreResult {
  backend: NativeIwaWalletBackend;
  address: string;
  walletId: NativeIwaWalletId;
  walletName: string;
  cacheCount: number;
}

interface PendingEntry {
  approval: ApprovalResource;
  createdAt: number;
}

export class NativeIwaWalletBackend implements WalletBackend {
  private readonly walletId: NativeIwaWalletId;
  private readonly cluster: Cluster;
  private readonly requestTtlMs: number;
  private readonly logLevel: IosNativeLogLevel;
  private readonly approvals = new Map<SigningRequestId, PendingEntry>();
  private address: string | null = null;

  constructor(options: NativeIwaWalletBackendOptions) {
    if (!isNativeIwaWalletId(options.walletId)) {
      throw new ProtocolError('invalid_request', `Unsupported native IWA wallet: ${options.walletId}`);
    }
    this.walletId = options.walletId;
    this.cluster = options.cluster;
    this.requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
    this.logLevel = options.logLevel ?? 'info';
    this.log('constructor', 'backend initialized', { wallet: this.walletId, cluster: this.cluster });
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      backend: `ios-native-${this.walletId}`,
      cluster: [this.cluster],
      supports: {
        signMessage: true,
        signTransaction: true,
        signAndSendTransaction: true,
        multiSign: false,
        simulationPreview: false,
      },
      ...(this.address ? { address: this.address } : {}),
    };
  }

  async getAddress(): Promise<string> {
    if (this.address) return this.address;
    const cached = await this.reconnectLatest();
    if (cached) return cached;
    return this.connectSelectedWallet();
  }

  /** User-initiated connect: always opens the wallet round-trip. */
  async connectSelectedWallet(): Promise<string> {
    const res = await AgenticNativeWallet.connect({ walletId: this.walletId, cluster: this.cluster });
    if (!res.publicKey) {
      throw new ProtocolError('wallet_unreachable', 'Native wallet returned no public key.');
    }
    this.address = res.publicKey;
    this.log('connectSelectedWallet', 'connected', { pubkey: res.publicKey });
    return res.publicKey;
  }

  /** Silent restore from the native Keychain session, if any. */
  async reconnectLatest(): Promise<string | null> {
    const res = await AgenticNativeWallet.resumeSession({ walletId: this.walletId, cluster: this.cluster });
    if (res.connected && res.publicKey) {
      this.address = res.publicKey;
      this.log('reconnectLatest', 'restored', { pubkey: res.publicKey });
      return res.publicKey;
    }
    return null;
  }

  async submit(request: SigningRequest): Promise<ApprovalResource> {
    if (request.cluster !== this.cluster) {
      throw new ProtocolError(
        'cluster_mismatch',
        `Native IWA backend is configured for ${this.cluster}; request targets ${request.cluster}.`,
      );
    }
    if (!this.address) {
      await this.getAddress();
    }
    const approval: ApprovalResource = { requestId: request.id, status: 'pending' };
    this.approvals.set(request.id, { approval, createdAt: Date.now() });
    this.log('submit', 'queued', { requestId: request.id, kind: request.kind });
    void this.resolveSigningRequest(request).catch((err: unknown) => {
      const entry = this.approvals.get(request.id);
      if (!entry || entry.approval.status !== 'pending') return;
      const protocolErr = toProtocolError(err);
      entry.approval = {
        requestId: request.id,
        status: protocolErr.code === 'user_rejected' ? 'rejected' : 'failed',
        error: protocolErr.toPayload(),
      };
      this.log('submit', 'failed', { requestId: request.id, code: protocolErr.code });
    });
    return approval;
  }

  async poll(requestId: SigningRequestId): Promise<ApprovalResource> {
    const entry = this.approvals.get(requestId);
    if (!entry) {
      throw new ProtocolError('invalid_request', `Unknown native IWA request id: ${requestId}`);
    }
    if (entry.approval.status === 'pending' && Date.now() - entry.createdAt > this.requestTtlMs) {
      entry.approval = {
        requestId,
        status: 'expired',
        error: { code: 'expired', message: 'Native IWA approval request expired.', recoverable: true },
      };
    }
    return entry.approval;
  }

  async cancel(requestId: SigningRequestId): Promise<void> {
    const entry = this.approvals.get(requestId);
    if (!entry) return;
    entry.approval = {
      requestId,
      status: 'rejected',
      error: { code: 'user_rejected', message: 'Native IWA approval cancelled by caller.', recoverable: false },
    };
  }

  async disconnect(): Promise<void> {
    await AgenticNativeWallet.disconnect().catch(() => undefined);
    this.address = null;
    this.log('disconnect', 'local session dropped', {});
  }

  // --- Maintenance surface (mirrors IosNativeMaintenanceBackend in main.ts) ---

  async clearTransientState(reason: string): Promise<void> {
    for (const [requestId, entry] of this.approvals) {
      if (entry.approval.status !== 'pending') continue;
      entry.approval = {
        requestId,
        status: 'expired',
        error: { code: 'expired', message: 'Native IWA transient state cleared.', recoverable: true },
      };
    }
    this.log('clearTransientState', 'cleared', { reason });
  }

  async clearStateFullReset(reason: string): Promise<void> {
    await this.clearTransientState(reason);
    await AgenticNativeWallet.clearState().catch(() => undefined);
    this.address = null;
    this.log('clearStateFullReset', 'done', { reason });
  }

  async clearAllCachedAuthorizations(): Promise<void> {
    await this.clearTransientState('clear_all_cached_authorizations');
    await AgenticNativeWallet.clearAllState().catch(() => undefined);
    this.address = null;
    this.log('clearAllCachedAuthorizations', 'done', {});
  }

  // --- Internals ---

  private async resolveSigningRequest(request: SigningRequest): Promise<void> {
    const entry = this.approvals.get(request.id);
    if (!entry) return;
    const result = await this.sign(request);
    entry.approval = { requestId: request.id, status: 'approved', result };
    this.log('resolveSigningRequest', 'approved', { requestId: request.id, kind: request.kind });
  }

  private async sign(request: SigningRequest): Promise<SigningResult> {
    switch (request.kind) {
      case 'sign_message': {
        const message = payloadToBase64(request.payload);
        const res = await AgenticNativeWallet.signMessage({ message });
        if (!res.signature) {
          throw new ProtocolError('wallet_unreachable', 'Native wallet returned no message signature.');
        }
        // Base58 signature — matches the legacy backend's sign_message encoding.
        return { signature: res.signature };
      }
      case 'sign_transaction': {
        const res = await AgenticNativeWallet.signTransaction({ transaction: request.payload.data });
        if (!res.signature) {
          throw new ProtocolError('wallet_unreachable', 'Native wallet returned no signed transaction.');
        }
        // Base64 signed-transaction bytes — matches the legacy backend's encoding.
        return { signature: res.signature };
      }
      case 'sign_and_send_transaction': {
        const res = await AgenticNativeWallet.signAndSendTransaction({ transaction: request.payload.data });
        if (!res.signature) {
          throw new ProtocolError('wallet_unreachable', 'Native wallet returned no broadcast signature.');
        }
        // Base58 txid — matches the legacy backend's sign_and_send encoding.
        return { signature: res.signature, txid: res.txid ?? res.signature };
      }
      default:
        throw new ProtocolError('unsupported_method', `Native IWA backend cannot handle ${request.kind}.`);
    }
  }

  private log(method: string, message: string, metadata: Record<string, unknown>): void {
    if (this.logLevel === 'silent' || this.logLevel === 'error') return;
    if (this.logLevel !== 'debug' && method.startsWith('resolveSigning')) return;
    // eslint-disable-next-line no-console
    console.debug(`[NativeIwaWalletBackend] ${method}: ${message}`, metadata);
  }
}

/**
 * Mirror of `restoreLatestIosNativeWallet` for the native IWA path: silently
 * restore a Keychain session on launch. Returns null when there is nothing to
 * resume so the caller can fall back to the "no cached authorization" state.
 */
export async function restoreLatestNativeIwaWallet(
  options: NativeIwaWalletBackendOptions,
): Promise<NativeIwaRestoreResult | null> {
  const backend = new NativeIwaWalletBackend(options);
  const address = await backend.reconnectLatest();
  if (!address) return null;
  const descriptor = iosWalletDescriptor(options.walletId);
  return {
    backend,
    address,
    walletId: options.walletId,
    walletName: descriptor?.name ?? options.walletId,
    // Native sessions live in the Keychain (single active record); surface 1 as
    // "a session exists" for the cache-count UI rather than the legacy JS count.
    cacheCount: 1,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function payloadToBase64(payload: SigningPayload): string {
  // sign_message arrives as a UTF-8 string; transactions arrive already base64.
  return payload.encoding === 'base64' ? payload.data : encodeBase64(encodeUtf8(payload.data));
}

function toProtocolError(err: unknown): ProtocolError {
  if (err instanceof ProtocolError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // Capacitor surfaces a rejected promise; map the wallet's user-rejection code.
  const code = /reject|cancel|denied/i.test(message) ? 'user_rejected' : 'wallet_unreachable';
  return new ProtocolError(code, message || 'Native IWA signing failed.');
}
