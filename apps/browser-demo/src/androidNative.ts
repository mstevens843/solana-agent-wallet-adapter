import {
  ProtocolError,
  type AdapterCapabilities,
  type ApprovalResource,
  type Cluster,
  type ErrorCode,
  type ProtocolErrorPayload,
  type SigningRequest,
  type SigningRequestId,
  type SigningResult,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';

declare const __AGENTIC_BROWSER_BUILD_COMMIT__: string | undefined;

import {
  androidWalletDisplayNameFromStatus,
  walletLogoIdFromAndroidStatus,
  type WalletProviderLogoId,
} from './walletBranding.js';

export interface AndroidNativeEnvironment {
  isAndroidNative: boolean;
  bridgeAvailable: boolean;
}

export interface AndroidNativeRestoreResult {
  backend: AndroidNativeWalletBackend;
  address: string;
  walletName: string;
  walletLogoId?: WalletProviderLogoId;
  authCacheKey?: string;
  walletPackage?: string;
  walletType?: number;
  cacheCount: number;
}

export interface AndroidNativeWalletBackendOptions {
  cluster: Cluster;
  rpcUrl?: string;
  address?: string;
  authCacheKey?: string;
  walletPackage?: string;
  walletType?: number;
}

interface AndroidNativeBridge {
  mwaRequest?: (requestId: string, method: string, payloadJson: string) => void;
  isDebugBuild?: () => boolean;
  secureGet?: (key: string) => string;
  secureSet?: (key: string, value: string) => boolean;
  secureDelete?: (key: string) => boolean;
}

interface AndroidNativeCallbackBridge {
  resolve(requestId: string, payload: unknown): void;
  reject(requestId: string, error: NativeMwaError): void;
}

interface PendingNativeRequest {
  method: string;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: number;
  startedAt: number;
  graceTimer?: number;
}

interface NativeMwaError {
  code?: string;
  message?: string;
}

interface AndroidMwaStatus {
  connected: boolean;
  address?: string;
  authCacheKey?: string;
  sessionKey?: string;
  cluster?: Cluster;
  walletType?: number;
  walletUriBase?: string;
  walletIcon?: string;
  walletPackage?: string;
  accountLabel?: string;
  cachedCount: number;
  capabilities?: AdapterCapabilities;
}

interface AndroidNativeSignProofResult {
  signature: string;
  encoding?: string;
  transactionBase64?: string;
}

export interface AndroidNativeSignInResult {
  signature: string;
  signedMessage: string;
  publicKey: string;
  address: string;
  accountLabel?: string;
  chains?: string[];
  features?: string[];
  authToken?: string;
  authTokenLen?: number;
  walletPackage?: string;
  cluster?: Cluster;
  path?: string;
}

const ANDROID_NATIVE_TIMEOUT_MS = 120_000;
// Defense-in-depth grace timers for the OS-chooser-dismissal bug. If the user dismisses the
// Android system "Open with Wallet" chooser by tapping outside, the native MWA library
// suspends indefinitely and never invokes the bridge callback. The native lifecycle watchdog
// in MwaController catches this primarily; this JS layer is the safety net.
//
// - PICKER_GRACE_MIN_AGE_MS: don't arm the grace timer until the request has been pending
//   for at least this long. Prevents false positives if a focus/visibility event fires
//   before the chooser visually presents.
// - PICKER_GRACE_REJECT_MS: after focus/visibility says we're back on the page, wait this
//   long for a legitimate result. If still pending, force-reject as user_rejected.
const ANDROID_PICKER_GRACE_MIN_AGE_MS = 400;
const ANDROID_PICKER_GRACE_REJECT_MS = 1_500;
const CLOUD_SESSION_TOKEN_KEY = 'cloudSessionToken';
const pendingNativeRequests = new Map<string, PendingNativeRequest>();
let nextRequestNonce = 1;

export function detectAndroidNativeEnvironment(): AndroidNativeEnvironment {
  const bridge = androidNativeBridge();
  return {
    isAndroidNative: Boolean(bridge?.mwaRequest),
    bridgeAvailable: Boolean(bridge),
  };
}

/**
 * True when the UI is running inside the Android app shell.
 *
 * The build-time `VITE_AGENTIC_ANDROID_APP` flag is only set when the APK bakes
 * its own bundle. The release app live-loads the SAME bundle Render serves to
 * the public website (which has NO build flag), so we must ALSO detect the shell
 * at runtime via the injected `AgenticAndroid` bridge — otherwise Android-only UI
 * stays hidden in the live bundle and only a new APK could surface it. Desktop
 * browsers have no bridge global, so this stays false there. Mirrors the runtime
 * fallback in `resolveTauriAppSurface` and keeps shell identity bundle-agnostic.
 */
export function resolveAndroidAppSurface(): boolean {
  const viteEnv = (import.meta as ImportMeta & {
    env?: { VITE_AGENTIC_ANDROID_APP?: string };
  }).env;
  const explicit = String(viteEnv?.VITE_AGENTIC_ANDROID_APP ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(explicit)) return true;
  return Boolean(androidNativeBridge());
}

export function androidNativePostRestoreRoute(route: string | null | undefined): '/app' | null {
  return route === '/demo' ? '/app' : null;
}

export function isUnsupportedAndroidNativeBridgeMethodError(err: unknown, method?: string): boolean {
  const code = normalizedAndroidNativeErrorCode(err);
  if (code !== 'unsupported_method') return false;
  if (!method) return true;
  const message = androidNativeErrorMessage(err);
  return !message || message.includes(method) || message.includes('Unsupported Android MWA bridge method');
}

export async function androidNativeCacheSummary(): Promise<{ count: number }> {
  const status = await androidNativeRequest<AndroidMwaStatus>('status');
  return { count: status.cachedCount };
}

export function androidNativeCloudSessionToken(): string {
  const bridge = androidNativeBridge();
  if (!bridge?.secureGet) return '';
  try {
    return bridge.secureGet(CLOUD_SESSION_TOKEN_KEY).trim();
  } catch (err) {
    logAndroidNative('secureGet', 'FAIL', {
      key: CLOUD_SESSION_TOKEN_KEY,
      error: err instanceof Error ? err.message : String(err),
    }, 'warn');
    return '';
  }
}

export function setAndroidNativeCloudSessionToken(token: string): boolean {
  const bridge = androidNativeBridge();
  if (!bridge?.secureSet) return false;
  try {
    return bridge.secureSet(CLOUD_SESSION_TOKEN_KEY, token);
  } catch (err) {
    logAndroidNative('secureSet', 'FAIL', {
      key: CLOUD_SESSION_TOKEN_KEY,
      tokenChars: token.length,
      error: err instanceof Error ? err.message : String(err),
    }, 'warn');
    return false;
  }
}

export function clearAndroidNativeCloudSessionToken(): boolean {
  const bridge = androidNativeBridge();
  if (!bridge?.secureDelete) return false;
  try {
    return bridge.secureDelete(CLOUD_SESSION_TOKEN_KEY);
  } catch (err) {
    logAndroidNative('secureDelete', 'FAIL', {
      key: CLOUD_SESSION_TOKEN_KEY,
      error: err instanceof Error ? err.message : String(err),
    }, 'warn');
    return false;
  }
}

export async function restoreLatestAndroidNativeWallet(
  options: AndroidNativeWalletBackendOptions,
): Promise<AndroidNativeRestoreResult | null> {
  const backend = new AndroidNativeWalletBackend(options);
  const expectedAddress = options.address?.trim();
  const expectedAuthCacheKey = options.authCacheKey?.trim();
  const expectedWalletPackage = options.walletPackage?.trim();
  const expectedWalletType = typeof options.walletType === 'number' ? options.walletType : undefined;
  const attempts: AndroidNativeRestoreAttempt[] = [];

  if (expectedAuthCacheKey) {
    attempts.push({
      method: 'reconnectSession',
      reason: 'web_session_key',
      expectedAddress,
      run: () => backend.reconnectSession(expectedAuthCacheKey, expectedAddress),
    });
  }
  if (expectedAddress && (expectedWalletPackage || typeof expectedWalletType === 'number')) {
    attempts.push({
      method: 'reconnectForPubkey',
      reason: 'web_session_provider',
      expectedAddress,
      run: () => backend.reconnectForPubkey(expectedAddress, {
        walletPackage: expectedWalletPackage,
        walletType: expectedWalletType,
      }),
    });
  }
  attempts.push({
    method: 'reconnectLatest',
    reason: attempts.length > 0 ? 'native_latest_fallback' : 'native_latest',
    expectedAddress,
    run: () => backend.reconnectLatest(),
  });

  let restoredAddress: string | null = null;
  let restoredMethod: AndroidNativeRestoreMethod = 'reconnectLatest';
  for (const [index, attempt] of attempts.entries()) {
    const nextAttempt = attempts[index + 1];
    logAndroidNative('WEB_RESTORE_NATIVE_CALL', 'START', {
      method: attempt.method,
      reason: attempt.reason,
      attempt: index + 1,
      attempts: attempts.length,
      fallback: index > 0,
      cluster: options.cluster,
      hasAuthCacheKey: Boolean(expectedAuthCacheKey),
      expectedAddress: expectedAddress ?? '',
      walletPackage: expectedWalletPackage ?? '',
      walletType: typeof expectedWalletType === 'number' ? expectedWalletType : '',
    });
    let address: string | null = null;
    try {
      address = await attempt.run();
    } catch (err) {
      restoredMethod = attempt.method;
      if (isUnsupportedAndroidNativeBridgeMethodError(err, attempt.method)) {
        logAndroidNative('WEB_RESTORE_ATTEMPT_UNSUPPORTED', 'FAIL', {
          method: attempt.method,
          reason: 'native_bridge_unsupported_method',
          attempt: index + 1,
          attempts: attempts.length,
          cluster: options.cluster,
          code: normalizedAndroidNativeErrorCode(err),
          message: androidNativeErrorMessage(err),
          willFallback: Boolean(nextAttempt),
          webBuildCommit: androidWebBuildCommit(),
        }, 'warn');
        logAndroidRestoreFallback(attempt, nextAttempt, 'unsupported_method', index, attempts.length, options.cluster, backend.cacheCount());
        continue;
      }
      throw err;
    }
    restoredMethod = attempt.method;
    if (!address) {
      logAndroidNative('WEB_RESTORE_RESULT', 'FAIL', {
        method: attempt.method,
        reason: 'no_address',
        cluster: options.cluster,
        ok: false,
        cacheCount: backend.cacheCount(),
        willFallback: index < attempts.length - 1,
      }, 'warn');
      logAndroidRestoreFallback(attempt, nextAttempt, 'no_address', index, attempts.length, options.cluster, backend.cacheCount());
      continue;
    }
    if (attempt.method !== 'reconnectLatest' && attempt.expectedAddress && address !== attempt.expectedAddress) {
      logAndroidNative('WEB_RESTORE_RESULT', 'FAIL', {
        method: attempt.method,
        reason: 'expected_address_mismatch',
        cluster: options.cluster,
        ok: false,
        address,
        expectedAddress: attempt.expectedAddress,
        cacheCount: backend.cacheCount(),
        willFallback: index < attempts.length - 1,
      }, 'warn');
      logAndroidRestoreFallback(attempt, nextAttempt, 'expected_address_mismatch', index, attempts.length, options.cluster, backend.cacheCount());
      continue;
    }
    if (attempt.method === 'reconnectLatest' && attempt.expectedAddress && address !== attempt.expectedAddress) {
      logAndroidNative('WEB_RESTORE_NATIVE_CACHE_WINS', 'SUCCESS', {
        method: attempt.method,
        reason: 'web_session_address_stale',
        cluster: options.cluster,
        address,
        expectedAddress: attempt.expectedAddress,
        cacheCount: backend.cacheCount(),
      });
    }
    restoredAddress = address;
    break;
  }

  if (!restoredAddress) {
    logAndroidNative('WEB_RESTORE_RESULT', 'FAIL', {
      method: restoredMethod,
      cluster: options.cluster,
      ok: false,
      cacheCount: backend.cacheCount(),
      reason: 'no_restorable_authorization',
    }, 'warn');
    return null;
  }
  const authCacheKey = backend.authCacheKey();
  const walletPackage = backend.walletPackage();
  const walletType = backend.walletType();
  logAndroidNative('WEB_RESTORE_RESULT', 'SUCCESS', {
    method: restoredMethod,
    cluster: options.cluster,
    ok: true,
    address: restoredAddress,
    authCacheKey: authCacheKey ?? '',
    walletPackage: walletPackage ?? '',
    walletType: typeof walletType === 'number' ? walletType : '',
    cacheCount: backend.cacheCount(),
  });
  return {
    backend,
    address: restoredAddress,
    walletName: backend.walletName(),
    walletLogoId: backend.walletLogoId(),
    ...(authCacheKey ? { authCacheKey } : {}),
    ...(walletPackage ? { walletPackage } : {}),
    ...(typeof walletType === 'number' ? { walletType } : {}),
    cacheCount: backend.cacheCount(),
  };
}

type AndroidNativeRestoreMethod = 'reconnectSession' | 'reconnectForPubkey' | 'reconnectLatest';

interface AndroidNativeRestoreAttempt {
  method: AndroidNativeRestoreMethod;
  reason: 'web_session_key' | 'web_session_provider' | 'native_latest_fallback' | 'native_latest';
  expectedAddress?: string;
  run: () => Promise<string | null>;
}

function logAndroidRestoreFallback(
  attempt: AndroidNativeRestoreAttempt,
  nextAttempt: AndroidNativeRestoreAttempt | undefined,
  reason: string,
  index: number,
  attempts: number,
  cluster: Cluster,
  cacheCount: number,
): void {
  if (!nextAttempt) return;
  logAndroidNative('WEB_RESTORE_FALLBACK', 'START', {
    fromMethod: attempt.method,
    toMethod: nextAttempt.method,
    reason,
    attempt: index + 1,
    nextAttempt: index + 2,
    attempts,
    cluster,
    cacheCount,
    webBuildCommit: androidWebBuildCommit(),
  });
}

export class AndroidNativeWalletBackend implements WalletBackend {
  private readonly cluster: Cluster;
  private rpcUrl?: string;
  private readonly targetWalletPackage?: string;
  private readonly targetWalletType?: number;
  private readonly approvals = new Map<SigningRequestId, ApprovalResource>();
  private activeStatus: AndroidMwaStatus | null = null;

  constructor(options: AndroidNativeWalletBackendOptions) {
    this.cluster = requireAndroidNativeCluster(options.cluster);
    this.rpcUrl = normalizeRpcUrl(options.rpcUrl);
    const walletPackage = options.walletPackage?.trim();
    this.targetWalletPackage = walletPackage ? walletPackage : undefined;
    this.targetWalletType = typeof options.walletType === 'number' ? options.walletType : undefined;
  }

  setRpcUrl(rpcUrl: string | undefined): void {
    this.rpcUrl = normalizeRpcUrl(rpcUrl);
  }

  async capabilities(): Promise<AdapterCapabilities> {
    if (!this.activeStatus?.capabilities) {
      await this.refreshStatus();
    }
    if (this.activeStatus?.capabilities) {
      return this.activeStatus.capabilities;
    }
    return androidCapabilities(this.cluster, this.activeStatus?.address);
  }

  async getAddress(): Promise<string> {
    if (this.activeStatus?.address) {
      return this.activeStatus.address;
    }
    const status = await this.refreshStatus();
    if (status.address) {
      return status.address;
    }
    return this.connect();
  }

  async connect(): Promise<string> {
    const status = await androidNativeRequest<AndroidMwaStatus>('connect', {
      cluster: this.cluster,
      ...(this.targetWalletPackage ? { walletPackage: this.targetWalletPackage } : {}),
      ...(typeof this.targetWalletType === 'number' ? { walletType: this.targetWalletType } : {}),
      ...this.nativeRpcContext(),
    });
    this.applyStatus(status);
    if (!status.address) {
      throw new ProtocolError('wallet_unreachable', 'Android MWA did not return a wallet address.');
    }
    return status.address;
  }

  async reconnectLatest(): Promise<string | null> {
    logAndroidNative('WEB_RESTORE_NATIVE_CALL', 'START', {
      method: 'reconnectLatest',
      cluster: this.cluster,
    });
    const status = await androidNativeRequest<AndroidMwaStatus>('reconnectLatest', {
      cluster: this.cluster,
      ...this.nativeRpcContext(),
    });
    this.applyStatus(status);
    logAndroidNative('WEB_RESTORE_RESULT', status.address ? 'SUCCESS' : 'FAIL', {
      method: 'reconnectLatest',
      cluster: this.cluster,
      ok: Boolean(status.address),
      address: status.address ?? '',
      authCacheKey: status.authCacheKey ?? '',
      cacheCount: status.cachedCount,
    }, status.address ? 'info' : 'warn');
    return status.address ?? null;
  }

  async reconnectSession(authCacheKey: string, expectedAddress?: string): Promise<string | null> {
    const key = authCacheKey.trim();
    if (!key) return null;
    const address = expectedAddress?.trim();
    logAndroidNative('WEB_RESTORE_NATIVE_CALL', 'START', {
      method: 'reconnectSession',
      cluster: this.cluster,
      hasAuthCacheKey: true,
      expectedAddress: address ?? '',
    });
    const status = await androidNativeRequest<AndroidMwaStatus>('reconnectSession', {
      cluster: this.cluster,
      authCacheKey: key,
      sessionKey: key,
      ...(address && { address, pubkey: address, publicKey: address }),
      ...this.nativeRpcContext(),
    });
    this.applyStatus(status);
    logAndroidNative('WEB_RESTORE_RESULT', status.address ? 'SUCCESS' : 'FAIL', {
      method: 'reconnectSession',
      cluster: this.cluster,
      ok: Boolean(status.address),
      address: status.address ?? '',
      expectedAddress: address ?? '',
      authCacheKey: status.authCacheKey ?? '',
      cacheCount: status.cachedCount,
    }, status.address ? 'info' : 'warn');
    if (address && status.address && status.address !== address) {
      throw new ProtocolError(
        'unauthorized',
        `Android MWA restored ${shortAddress(status.address)} but expected ${shortAddress(address)}.`,
      );
    }
    return status.address ?? null;
  }

  async reconnectForPubkey(
    pubkeyBase58: string,
    options: { walletPackage?: string; walletType?: number } = {},
  ): Promise<string | null> {
    const pubkey = pubkeyBase58.trim();
    if (!pubkey) return null;
    logAndroidNative('WEB_RESTORE_NATIVE_CALL', 'START', {
      method: 'reconnectForPubkey',
      cluster: this.cluster,
      expectedAddress: pubkey,
      walletPackage: options.walletPackage ?? '',
      walletType: typeof options.walletType === 'number' ? options.walletType : '',
    });
    const status = await androidNativeRequest<AndroidMwaStatus>('reconnectForPubkey', {
      cluster: this.cluster,
      pubkey,
      publicKey: pubkey,
      address: pubkey,
      ...(options.walletPackage?.trim() ? { walletPackage: options.walletPackage.trim() } : {}),
      ...(typeof options.walletType === 'number' ? { walletType: options.walletType } : {}),
      ...this.nativeRpcContext(),
    });
    this.applyStatus(status);
    logAndroidNative('WEB_RESTORE_RESULT', status.address ? 'SUCCESS' : 'FAIL', {
      method: 'reconnectForPubkey',
      cluster: this.cluster,
      ok: Boolean(status.address),
      address: status.address ?? '',
      expectedAddress: pubkey,
      walletPackage: options.walletPackage ?? '',
      walletType: typeof options.walletType === 'number' ? options.walletType : '',
      authCacheKey: status.authCacheKey ?? '',
      cacheCount: status.cachedCount,
    }, status.address ? 'info' : 'warn');
    return status.address ?? null;
  }

  async submit(request: SigningRequest): Promise<ApprovalResource> {
    if (request.cluster !== this.cluster) {
      throw new ProtocolError(
        'cluster_mismatch',
        `Android native MWA is connected to ${this.cluster}; request targets ${request.cluster}.`,
      );
    }
    await this.getAddress();
    const approval: ApprovalResource = {
      requestId: request.id,
      status: 'pending',
    };
    this.approvals.set(request.id, approval);
    const nativeRequest = {
      ...request,
      ...this.nativeRpcContext(),
    };
    logAndroidNative('submit', 'START', {
      requestId: request.id,
      kind: request.kind,
      cluster: request.cluster,
      payload: formatNativePayload(nativeRequest),
    });

    void androidNativeRequest<SigningResult>('sign', nativeRequest)
      .then((result) => {
        this.approvals.set(request.id, {
          requestId: request.id,
          status: 'approved',
          result,
        });
        logAndroidNative('submit', 'SUCCESS', {
          requestId: request.id,
          kind: request.kind,
          result: formatNativePayload(result),
        });
      })
      .catch((err: unknown) => {
        const protocolErr = protocolErrorFromUnknown(err);
        this.approvals.set(request.id, {
          requestId: request.id,
          status: protocolErr.code === 'user_rejected' ? 'rejected' : 'failed',
          error: protocolErr.toPayload(),
        });
        logAndroidNative('submit', 'FAIL', {
          requestId: request.id,
          kind: request.kind,
          code: protocolErr.code,
          message: protocolErr.message,
          error: protocolErr.toPayload(),
        }, 'warn');
      });

    return approval;
  }

  async poll(requestId: SigningRequestId): Promise<ApprovalResource> {
    const approval = this.approvals.get(requestId);
    if (!approval) {
      throw new ProtocolError('invalid_request', `Unknown Android native MWA request id: ${requestId}`);
    }
    return approval;
  }

  async cancel(requestId: SigningRequestId): Promise<void> {
    const approval = this.approvals.get(requestId);
    if (!approval) return;
    this.approvals.set(requestId, {
      requestId,
      status: 'rejected',
      error: {
        code: 'user_rejected',
        message: 'Android native MWA approval request cancelled by caller.',
        recoverable: false,
      },
    });
  }

  /**
   * Signs an ownership-proof message via the native bridge.
   *
   * Native owns the routing: wallets verified-good for MWA `sign_messages` get the
   * UTF-8 ed25519 message-signing path and return `encoding: "utf8"` (omitted from
   * the JSON when default-stripped). Phantom, Solflare, Seed Vault (Seeker —
   * including the production "Wallet" app), and any wallet whose package the bridge
   * couldn't fingerprint (blank `walletPackage`) get a memo-only legacy transaction
   * whose memo data is the proof bytes — they return `encoding: "tx-memo-proof"`
   * together with `transactionBase64` (the full never-broadcast signed tx) so the
   * server-side verifier can extract the memo and ed25519-verify the signature over
   * the transaction message bytes.
   */
  async signProof(
    message: string,
    summary?: string,
  ): Promise<{
    signature: string;
    encoding: 'utf8' | 'tx-memo-proof';
    transactionBase64?: string;
  }> {
    if (!message) {
      throw new ProtocolError('invalid_request', 'signProof requires a non-empty message.');
    }
    await this.getAddress();
    const requestId = `android-mwa-sign-proof-${Date.now()}-${nextRequestNonce++}`;
    const nativeRequest: Record<string, unknown> = {
      id: requestId,
      kind: 'sign_proof',
      payload: { data: message, encoding: 'utf8' },
      cluster: this.cluster,
      ...this.nativeRpcContext(),
    };
    if (summary && summary.trim().length > 0) {
      nativeRequest.display = { summary };
    }
    logAndroidNative('signProof', 'START', {
      requestId,
      cluster: this.cluster,
      messageChars: message.length,
    });
    const result = await androidNativeRequest<AndroidNativeSignProofResult>('sign', nativeRequest);
    const encoding: 'utf8' | 'tx-memo-proof' =
      result.encoding === 'tx-memo-proof' ? 'tx-memo-proof' : 'utf8';
    if (encoding === 'tx-memo-proof' && !result.transactionBase64) {
      throw new ProtocolError(
        'wallet_unreachable',
        'Android native MWA returned a tx-memo-proof result without transactionBase64.',
      );
    }
    logAndroidNative('signProof', 'SUCCESS', {
      requestId,
      encoding,
      hasTransactionBase64: Boolean(result.transactionBase64),
    });
    return {
      signature: result.signature,
      encoding,
      ...(result.transactionBase64 && { transactionBase64: result.transactionBase64 }),
    };
  }

  async signInWithSolana(input: {
    domain: string;
    statement: string;
  }): Promise<AndroidNativeSignInResult> {
    const domain = input.domain.trim();
    const statement = input.statement.trim();
    if (!domain || !statement) {
      throw new ProtocolError('invalid_request', 'Android SIWS sign-in requires a domain and statement.');
    }
    logAndroidNative('signInWithSolana', 'START', {
      cluster: this.cluster,
      domain,
      statementChars: statement.length,
    });
    const result = await androidNativeRequest<AndroidNativeSignInResult>('signIn', {
      cluster: this.cluster,
      domain,
      statement,
      ...this.nativeRpcContext(),
    });
    const address = (result.address || result.publicKey || '').trim();
    if (!address) {
      throw new ProtocolError('wallet_unreachable', 'Android MWA SIWS did not return a wallet address.');
    }
    await this.refreshStatus().catch(() => undefined);
    if (!this.activeStatus?.address) {
      this.applyStatus({
        connected: true,
        address,
        cluster: this.cluster,
        walletPackage: result.walletPackage,
        accountLabel: result.accountLabel,
        cachedCount: 1,
        capabilities: androidCapabilities(this.cluster, address),
      });
    }
    logAndroidNative('signInWithSolana', 'SUCCESS', {
      cluster: this.cluster,
      address: shortAddress(address),
      path: result.path ?? '',
      signedMessageChars: result.signedMessage?.length ?? 0,
    });
    return {
      ...result,
      address,
      publicKey: result.publicKey || address,
    };
  }

  async disconnect(): Promise<void> {
    const status = await androidNativeRequest<AndroidMwaStatus>('disconnect');
    this.applyStatus(status);
  }

  async clearTransientState(): Promise<void> {
    const status = await androidNativeRequest<AndroidMwaStatus>('clearTransient');
    this.applyStatus(status);
  }

  async clearStateFullReset(): Promise<void> {
    const status = await androidNativeRequest<AndroidMwaStatus>('fullReset');
    this.applyStatus(status);
  }

  async clearAllCachedAuthorizations(): Promise<void> {
    const status = await androidNativeRequest<AndroidMwaStatus>('clearAllAccounts');
    this.applyStatus(status);
  }

  walletName(): string {
    return walletNameFromStatus(this.activeStatus);
  }

  walletLogoId(): WalletProviderLogoId | undefined {
    return walletLogoIdFromAndroidStatus(this.activeStatus);
  }

  cacheCount(): number {
    return this.activeStatus?.cachedCount ?? 0;
  }

  authCacheKey(): string | undefined {
    return this.activeStatus?.authCacheKey || this.activeStatus?.sessionKey || undefined;
  }

  walletPackage(): string | undefined {
    return this.activeStatus?.walletPackage || undefined;
  }

  walletType(): number | undefined {
    return typeof this.activeStatus?.walletType === 'number' ? this.activeStatus.walletType : undefined;
  }

  private async refreshStatus(): Promise<AndroidMwaStatus> {
    const status = await androidNativeRequest<AndroidMwaStatus>('status');
    this.applyStatus(status);
    return status;
  }

  private nativeRpcContext(): { rpcUrl?: string } {
    return this.rpcUrl ? { rpcUrl: this.rpcUrl } : {};
  }

  private applyStatus(status: AndroidMwaStatus): void {
    this.activeStatus = {
      ...status,
      capabilities: normalizeAndroidCapabilities(status, this.cluster),
    };
  }
}

function androidCapabilities(cluster: Cluster, address?: string): AdapterCapabilities {
  const connected = Boolean(address);
  return {
    backend: 'android-native-mwa',
    cluster: [cluster],
    supports: {
      signMessage: false,
      signTransaction: false,
      signAndSendTransaction: connected,
      multiSign: false,
      simulationPreview: false,
    },
    ...(address && { address }),
  };
}

function normalizeAndroidCapabilities(status: AndroidMwaStatus, cluster: Cluster): AdapterCapabilities {
  if (!status.capabilities) {
    return androidCapabilities(cluster, status.address);
  }
  return {
    ...status.capabilities,
    ...(status.address && !status.capabilities.address && { address: status.address }),
  };
}

function requireAndroidNativeCluster(cluster: Cluster): Cluster {
  if (cluster === 'localnet') {
    throw new ProtocolError(
      'cluster_mismatch',
      'Android native MWA supports mainnet-beta, devnet, and testnet. Select devnet for local testing.',
    );
  }
  return cluster;
}

function normalizeRpcUrl(rpcUrl: string | undefined): string | undefined {
  const trimmed = rpcUrl?.trim();
  return trimmed ? trimmed : undefined;
}

export function androidNativeRequest<T>(method: string, payload?: unknown): Promise<T> {
  installAndroidNativeCallbackBridge();
  const bridge = androidNativeBridge();
  if (!bridge?.mwaRequest) {
    return Promise.reject(new ProtocolError('wallet_unreachable', 'Android native MWA bridge is not available.'));
  }
  const injectedBridge = bridge as AndroidNativeBridge & {
    mwaRequest: NonNullable<AndroidNativeBridge['mwaRequest']>;
  };
  const requestId = `android-mwa-${Date.now()}-${nextRequestNonce++}`;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      clearAndroidPickerGraceTimer(requestId);
      pendingNativeRequests.delete(requestId);
      logAndroidNative('request', 'FAIL', { method, requestId, reason: 'timeout' }, 'warn');
      reject(new ProtocolError('expired', `Android native MWA request ${requestId} timed out.`));
    }, ANDROID_NATIVE_TIMEOUT_MS);
    pendingNativeRequests.set(requestId, {
      method,
      resolve: (value) => resolve(value as T),
      reject,
      timer,
      startedAt: Date.now(),
    });
    try {
      const payloadJson = JSON.stringify(payload ?? {});
      logAndroidNative('request', 'START', {
        method,
        requestId,
        payloadChars: payloadJson.length,
        payloadHash: deterministicHash(payloadJson),
        payload: formatNativePayload(payload ?? {}),
      });
      injectedBridge.mwaRequest(requestId, method, payloadJson);
    } catch (err) {
      window.clearTimeout(timer);
      clearAndroidPickerGraceTimer(requestId);
      pendingNativeRequests.delete(requestId);
      logAndroidNative(
        'request',
        'FAIL',
        {
          method,
          requestId,
          error: err instanceof Error ? err.message : String(err),
          payload: formatNativePayload(payload ?? {}),
        },
        'warn',
      );
      reject(protocolErrorFromUnknown(err));
    }
  });
}

function installAndroidNativeCallbackBridge(): void {
  const globalWindow = window as Window & { __agenticAndroidMwaBridge?: AndroidNativeCallbackBridge };
  if (globalWindow.__agenticAndroidMwaBridge) {
    return;
  }
  globalWindow.__agenticAndroidMwaBridge = {
    resolve(requestId, payload) {
      const pending = pendingNativeRequests.get(requestId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      clearAndroidPickerGraceTimer(requestId);
      pendingNativeRequests.delete(requestId);
      logAndroidNative('request', 'SUCCESS', {
        method: pending.method,
        requestId,
        payload: formatNativePayload(payload),
      });
      pending.resolve(payload);
    },
    reject(requestId, error) {
      const pending = pendingNativeRequests.get(requestId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      clearAndroidPickerGraceTimer(requestId);
      pendingNativeRequests.delete(requestId);
      logAndroidNative('request', 'FAIL', {
        method: pending.method,
        requestId,
        code: error.code ?? 'UNKNOWN',
        message: error.message ?? 'Android native MWA request failed.',
        error: formatNativePayload(error),
      }, 'warn');
      pending.reject(protocolErrorFromNative(error));
    },
  };
  installAndroidPickerGraceWatchers();
}

function clearAndroidPickerGraceTimer(requestId: string): void {
  const pending = pendingNativeRequests.get(requestId);
  if (pending?.graceTimer !== undefined) {
    window.clearTimeout(pending.graceTimer);
    pending.graceTimer = undefined;
  }
}

function clearAllAndroidPickerGraceTimers(): void {
  for (const pending of pendingNativeRequests.values()) {
    if (pending.graceTimer !== undefined) {
      window.clearTimeout(pending.graceTimer);
      pending.graceTimer = undefined;
    }
  }
}

function armAndroidPickerGraceTimers(): void {
  const now = Date.now();
  for (const [requestId, pending] of pendingNativeRequests.entries()) {
    if (pending.graceTimer !== undefined) continue;
    if (now - pending.startedAt < ANDROID_PICKER_GRACE_MIN_AGE_MS) continue;
    pending.graceTimer = window.setTimeout(() => {
      // Re-check pending — the legitimate resolve/reject may have arrived between scheduling
      // and firing. If still pending, the user dismissed the chooser without selection.
      const still = pendingNativeRequests.get(requestId);
      if (!still) return;
      window.clearTimeout(still.timer);
      still.graceTimer = undefined;
      pendingNativeRequests.delete(requestId);
      logAndroidNative(
        'request',
        'FAIL',
        {
          method: still.method,
          requestId,
          reason: 'picker_dismissed',
          elapsedMs: Date.now() - still.startedAt,
        },
        'warn',
      );
      still.reject(
        new ProtocolError('user_rejected', 'Wallet picker dismissed without selection.'),
      );
    }, ANDROID_PICKER_GRACE_REJECT_MS);
  }
}

let androidPickerGraceWatchersInstalled = false;

function installAndroidPickerGraceWatchers(): void {
  if (androidPickerGraceWatchersInstalled) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  androidPickerGraceWatchersInstalled = true;
  // When the page regains focus while a request is in flight, arm a grace timer per request.
  // When focus moves AWAY (wallet app took foreground), clear all grace timers — a legitimate
  // wallet flow is in progress and we must not false-cancel it. Only continuous focus on the
  // WebView for ANDROID_PICKER_GRACE_REJECT_MS after the chooser was open indicates the user
  // dismissed without picking a wallet.
  const onFocusOrVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (pendingNativeRequests.size === 0) return;
    armAndroidPickerGraceTimers();
  };
  const onBlurOrHidden = () => {
    clearAllAndroidPickerGraceTimers();
  };
  window.addEventListener('focus', onFocusOrVisible);
  window.addEventListener('blur', onBlurOrHidden);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onFocusOrVisible();
    else onBlurOrHidden();
  });
}

function androidNativeBridge(): AndroidNativeBridge | undefined {
  return (globalThis as typeof globalThis & { AgenticAndroid?: AndroidNativeBridge }).AgenticAndroid;
}

function androidNativeDebugEnabled(): boolean {
  try {
    return androidNativeBridge()?.isDebugBuild?.() === true;
  } catch {
    return false;
  }
}

function protocolErrorFromUnknown(err: unknown): ProtocolError {
  if (err instanceof ProtocolError) {
    return err;
  }
  if (isProtocolPayload(err)) {
    return ProtocolError.fromPayload(err);
  }
  if (isNativeMwaError(err)) {
    return protocolErrorFromNative(err);
  }
  return new ProtocolError('wallet_unreachable', err instanceof Error ? err.message : String(err));
}

function protocolErrorFromNative(error: NativeMwaError): ProtocolError {
  return new ProtocolError(nativeErrorCode(error.code), error.message || 'Android native MWA request failed.');
}

function normalizedAndroidNativeErrorCode(err: unknown): ErrorCode | '' {
  if (err instanceof ProtocolError) return err.code;
  if (isNativeMwaError(err)) return nativeErrorCode(err.code);
  if (isProtocolPayload(err)) return err.code;
  return '';
}

function androidNativeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isProtocolPayload(err)) return err.message;
  if (isNativeMwaError(err)) return err.message ?? '';
  return String(err ?? '');
}

function androidWebBuildCommit(): string {
  try {
    return typeof __AGENTIC_BROWSER_BUILD_COMMIT__ === 'string' && __AGENTIC_BROWSER_BUILD_COMMIT__
      ? __AGENTIC_BROWSER_BUILD_COMMIT__
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function nativeErrorCode(code?: string): ErrorCode {
  switch ((code ?? '').toUpperCase()) {
    case 'USER_REJECTED':
      return 'user_rejected';
    case 'UNAUTHORIZED':
    case 'WALLET_AUTH_MISMATCH':
    case 'WALLET_CHANGED':
    case 'INSUFFICIENT_FUNDS_FOR_RENT':
      return 'unauthorized';
    case 'CLUSTER_MISMATCH':
      return 'cluster_mismatch';
    case 'UNSUPPORTED_METHOD':
    case 'SIWS_UNSUPPORTED_FOR_WALLET':
    case 'WALLET_SIGN_MESSAGES_UNSUPPORTED':
    case 'JUPITER_SIGN_TRANSACTION_UNSUPPORTED':
      return 'unsupported_method';
    case 'INVALID_PAYLOADS':
    case 'INVALID_REQUEST':
      return 'invalid_request';
    case 'NO_WALLET_FOUND':
    case 'WALLET_HUNG':
    case 'WALLET_ERROR':
    case 'WALLET_NATIVE_SIGN_AND_SEND_UNSUPPORTED':
    case 'RPC_BROADCAST_FAILED':
    default:
      return 'wallet_unreachable';
  }
}

function isProtocolPayload(value: unknown): value is ProtocolErrorPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProtocolErrorPayload>;
  return typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

function isNativeMwaError(value: unknown): value is NativeMwaError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as NativeMwaError;
  return typeof candidate.code === 'string' || typeof candidate.message === 'string';
}

function walletNameFromStatus(status: AndroidMwaStatus | null): string {
  return androidWalletDisplayNameFromStatus(status);
}

function logAndroidNative(
  operation: string,
  phase: 'START' | 'SUCCESS' | 'FAIL',
  fields: Record<string, unknown>,
  level: 'info' | 'warn' = 'info',
): void {
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${stringifyLogValue(value)}`)
    .join(' ');
  const line = `[AgentAndroidNative] ${operation} | ${phase}${details ? ` ${details}` : ''}`;
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.info(line);
}

function stringifyLogValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch (err) {
    return JSON.stringify(err instanceof Error ? err.message : String(value)) ?? '"[unserializable]"';
  }
}

function formatNativePayload(value: unknown): unknown {
  if (androidNativeDebugEnabled()) {
    return redactNativePayload(value);
  }
  return summarizeNativePayload(value);
}

function redactNativePayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactNativePayload);
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'walletIcon' && typeof entry === 'string') {
      output[key] = {
        redacted: true,
        kind: entry.startsWith('data:image/') ? 'data-image' : entry.startsWith('http') ? 'url' : 'inline',
        chars: entry.length,
        hash: deterministicHash(entry),
      };
    } else {
      output[key] = redactNativePayload(entry);
    }
  }
  return output;
}

function summarizeNativePayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (isSigningRequestLike(value)) {
    const request = value as SigningRequest;
    return {
      id: request.id,
      kind: request.kind,
      cluster: request.cluster,
      payload: {
        encoding: request.payload.encoding,
        chars: request.payload.data.length,
        hash: deterministicHash(request.payload.data),
      },
      display: request.display
        ? {
            summary: request.display.summary,
            riskLevel: request.display.riskLevel,
            simulationErr: request.display.simulation?.err ?? null,
            simulationLogCount: request.display.simulation?.logs?.length ?? 0,
          }
        : undefined,
      rpcUrl: (request as SigningRequest & { rpcUrl?: string }).rpcUrl,
      expiresAt: request.expiresAt,
    };
  }
  if (isSigningResultLike(value)) {
    const result = value as SigningResult;
    return {
      signature: result.signature,
      txid: result.txid,
    };
  }
  if (isNativeMwaError(value)) {
    return {
      code: value.code,
      message: value.message,
    };
  }
  return value;
}

function isSigningRequestLike(value: object): value is SigningRequest {
  const candidate = value as Partial<SigningRequest>;
  return typeof candidate.id === 'string'
    && typeof candidate.kind === 'string'
    && typeof candidate.cluster === 'string'
    && typeof candidate.payload === 'object'
    && candidate.payload !== null
    && typeof candidate.payload.data === 'string'
    && typeof candidate.payload.encoding === 'string';
}

function isSigningResultLike(value: object): value is SigningResult {
  const candidate = value as Partial<SigningResult>;
  return typeof candidate.signature === 'string' || typeof candidate.txid === 'string';
}

function deterministicHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function shortAddress(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 4)}...${value.slice(-4)}`;
}
