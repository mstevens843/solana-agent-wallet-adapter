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

export interface AndroidNativeEnvironment {
  isAndroidNative: boolean;
  bridgeAvailable: boolean;
}

export interface AndroidNativeRestoreResult {
  backend: AndroidNativeWalletBackend;
  address: string;
  walletName: string;
  cacheCount: number;
}

export interface AndroidNativeWalletBackendOptions {
  cluster: Cluster;
}

interface AndroidNativeBridge {
  mwaRequest?: (requestId: string, method: string, payloadJson: string) => void;
}

interface AndroidNativeCallbackBridge {
  resolve(requestId: string, payload: unknown): void;
  reject(requestId: string, error: NativeMwaError): void;
}

interface PendingNativeRequest {
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
  walletPackage?: string;
  accountLabel?: string;
  cachedCount: number;
  capabilities?: AdapterCapabilities;
}

const ANDROID_NATIVE_TIMEOUT_MS = 120_000;
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
    cacheCount: backend.cacheCount(),
  };
}

export class AndroidNativeWalletBackend implements WalletBackend {
  private readonly cluster: Cluster;
  private readonly approvals = new Map<SigningRequestId, ApprovalResource>();
  private activeStatus: AndroidMwaStatus | null = null;

  constructor(options: AndroidNativeWalletBackendOptions) {
    this.cluster = requireAndroidNativeCluster(options.cluster);
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

    void androidNativeRequest<SigningResult>('sign', request)
      .then((result) => {
        this.approvals.set(request.id, {
          requestId: request.id,
          status: 'approved',
          result,
        });
      })
      .catch((err: unknown) => {
        const protocolErr = protocolErrorFromUnknown(err);
        this.approvals.set(request.id, {
          requestId: request.id,
          status: protocolErr.code === 'user_rejected' ? 'rejected' : 'failed',
          error: protocolErr.toPayload(),
        });
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

  cacheCount(): number {
    return this.activeStatus?.cachedCount ?? 0;
  }

  private async refreshStatus(): Promise<AndroidMwaStatus> {
    const status = await androidNativeRequest<AndroidMwaStatus>('status');
    this.applyStatus(status);
    return status;
  }

  private applyStatus(status: AndroidMwaStatus): void {
    this.activeStatus = {
      ...status,
      capabilities: status.capabilities ?? androidCapabilities(this.cluster, status.address),
    };
  }
}

function androidCapabilities(cluster: Cluster, address?: string): AdapterCapabilities {
  return {
    backend: 'android-native-mwa',
    cluster: [cluster],
    supports: {
      signMessage: true,
      signTransaction: true,
      signAndSendTransaction: true,
      multiSign: true,
      simulationPreview: false,
    },
    ...(address && { address }),
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

function androidNativeRequest<T>(method: string, payload?: unknown): Promise<T> {
  installAndroidNativeCallbackBridge();
  const bridge = androidNativeBridge();
  const mwaRequest = bridge?.mwaRequest;
  if (!mwaRequest) {
    return Promise.reject(new ProtocolError('wallet_unreachable', 'Android native MWA bridge is not available.'));
  }
  const requestId = `android-mwa-${Date.now()}-${nextRequestNonce++}`;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingNativeRequests.delete(requestId);
      reject(new ProtocolError('expired', `Android native MWA request ${requestId} timed out.`));
    }, ANDROID_NATIVE_TIMEOUT_MS);
    pendingNativeRequests.set(requestId, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    try {
      mwaRequest(requestId, method, JSON.stringify(payload ?? {}));
    } catch (err) {
      window.clearTimeout(timer);
      pendingNativeRequests.delete(requestId);
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
      pending.resolve(payload);
    },
    reject(requestId, error) {
      const pending = pendingNativeRequests.get(requestId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      pendingNativeRequests.delete(requestId);
      pending.reject(protocolErrorFromNative(error));
    },
  };
}

function androidNativeBridge(): AndroidNativeBridge | undefined {
  return (globalThis as typeof globalThis & { AgenticAndroid?: AndroidNativeBridge }).AgenticAndroid;
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
  const packageName = status?.walletPackage?.toLowerCase() ?? '';
  if (packageName.includes('phantom')) return 'Phantom';
  if (packageName.includes('solflare')) return 'Solflare';
  if (packageName.includes('backpack')) return 'Backpack';
  if (packageName.includes('jupiter')) return 'Jupiter';
  if (status?.accountLabel) return status.accountLabel;
  return 'Mobile Wallet Adapter';
}
