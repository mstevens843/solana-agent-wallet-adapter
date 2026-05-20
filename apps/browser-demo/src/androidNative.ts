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
  cacheCount: number;
}

export interface AndroidNativeWalletBackendOptions {
  cluster: Cluster;
  rpcUrl?: string;
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
}

interface NativeMwaError {
  code?: string;
  message?: string;
}

interface AndroidMwaStatus {
  connected: boolean;
  address?: string;
  cluster?: Cluster;
  walletType?: number;
  walletUriBase?: string;
  walletIcon?: string;
  walletPackage?: string;
  accountLabel?: string;
  cachedCount: number;
  capabilities?: AdapterCapabilities;
}

export interface AndroidNativeWalletHint {
  name: string;
  walletPackage: string;
  walletType?: number;
  logoId?: WalletProviderLogoId;
}

export interface AndroidNativeDetectedWallet extends AndroidNativeWalletHint {
  storeUrl?: string;
  installed: boolean;
  versionName?: string;
}

interface AndroidNativeDetectWalletsResult {
  wallets?: AndroidNativeDetectedWallet[];
}

interface AndroidNativeSignProofResult {
  signature: string;
  encoding?: string;
  transactionBase64?: string;
}

const ANDROID_NATIVE_TIMEOUT_MS = 120_000;
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

export async function androidNativeCacheSummary(): Promise<{ count: number }> {
  const status = await androidNativeRequest<AndroidMwaStatus>('status');
  return { count: status.cachedCount };
}

export async function detectAndroidNativeWallets(): Promise<AndroidNativeDetectedWallet[]> {
  const result = await androidNativeRequest<AndroidNativeDetectWalletsResult>('detectWallets');
  return Array.isArray(result.wallets)
    ? result.wallets
        .map(normalizeDetectedWallet)
        .filter((wallet): wallet is AndroidNativeDetectedWallet => Boolean(wallet))
    : [];
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
  const address = await backend.reconnectLatest();
  if (!address) {
    return null;
  }
  return {
    backend,
    address,
    walletName: backend.walletName(),
    walletLogoId: backend.walletLogoId(),
    cacheCount: backend.cacheCount(),
  };
}

export class AndroidNativeWalletBackend implements WalletBackend {
  private readonly cluster: Cluster;
  private rpcUrl?: string;
  private readonly approvals = new Map<SigningRequestId, ApprovalResource>();
  private activeStatus: AndroidMwaStatus | null = null;

  constructor(options: AndroidNativeWalletBackendOptions) {
    this.cluster = requireAndroidNativeCluster(options.cluster);
    this.rpcUrl = normalizeRpcUrl(options.rpcUrl);
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

  async connect(hint?: AndroidNativeWalletHint): Promise<string> {
    const status = await androidNativeRequest<AndroidMwaStatus>('connect', {
      cluster: this.cluster,
      ...(hint?.walletPackage && { walletPackage: hint.walletPackage }),
      ...(typeof hint?.walletType === 'number' && { walletType: hint.walletType }),
      ...this.nativeRpcContext(),
    });
    this.applyStatus(status);
    if (!status.address) {
      throw new ProtocolError('wallet_unreachable', 'Android MWA did not return a wallet address.');
    }
    return status.address;
  }

  async reconnectLatest(): Promise<string | null> {
    const status = await androidNativeRequest<AndroidMwaStatus>('reconnectLatest', {
      cluster: this.cluster,
      ...this.nativeRpcContext(),
    });
    this.applyStatus(status);
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
      pendingNativeRequests.delete(requestId);
      logAndroidNative('request', 'FAIL', { method, requestId, reason: 'timeout' }, 'warn');
      reject(new ProtocolError('expired', `Android native MWA request ${requestId} timed out.`));
    }, ANDROID_NATIVE_TIMEOUT_MS);
    pendingNativeRequests.set(requestId, {
      method,
      resolve: (value) => resolve(value as T),
      reject,
      timer,
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

function normalizeDetectedWallet(value: unknown): AndroidNativeDetectedWallet | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const walletPackage = typeof candidate.packageName === 'string'
    ? candidate.packageName.trim()
    : typeof candidate.walletPackage === 'string'
      ? candidate.walletPackage.trim()
      : '';
  if (!name || !walletPackage) return null;
  const walletType = typeof candidate.walletType === 'number' ? candidate.walletType : undefined;
  return {
    name,
    walletPackage,
    ...(walletType !== undefined && { walletType }),
    logoId: walletLogoIdFromAndroidStatus({ walletType, walletPackage, accountLabel: name }),
    storeUrl: typeof candidate.storeUrl === 'string' ? candidate.storeUrl : undefined,
    installed: candidate.installed === true,
    versionName: typeof candidate.versionName === 'string' ? candidate.versionName : undefined,
  };
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
