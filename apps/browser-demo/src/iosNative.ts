import { Capacitor, registerPlugin } from '@capacitor/core';
import { App as CapacitorApp, type URLOpenListenerEvent } from '@capacitor/app';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

import {
  newSigningRequestId,
  ProtocolError,
  type AdapterCapabilities,
  type ApprovalResource,
  type Cluster,
  type SigningRequest,
  type SigningRequestId,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';
import {
  buildIosConnectUrl,
  buildIosSignMessageUrl,
  buildIosSignTransactionUrl,
  decodeBase64,
  encodeBase64,
  encodeUtf8,
  IOS_WALLETS,
  iosWalletDescriptor,
  makeIosRedirect,
  parseIosConnectCallback,
  parseIosSigningCallback,
  type IosDeepLinkWalletId,
  type IosWalletId,
} from '@solana-agent-wallet-adapter/ios-link/deeplink';
import { Connection } from '@solana/web3.js';

export type IosNativeWalletId = IosWalletId;

export interface IosNativeEnvironment {
  isNative: boolean;
  platform: string;
  isIos: boolean;
  isIosNative: boolean;
  callbackScheme: string;
}

export interface IosNativeWalletBackendOptions {
  walletId: IosNativeWalletId;
  cluster: Cluster;
  appUrl: string;
  callbackScheme?: string;
  rpcUrl?: string;
  requestTtlMs?: number;
  logLevel?: IosNativeLogLevel;
}

export interface IosNativeRestoreResult {
  backend: IosNativeWalletBackend;
  address: string;
  walletId: IosNativeWalletId;
  walletName: string;
  cacheCount: number;
}

export interface IosNativeWalletOption {
  id: IosNativeWalletId;
  name: string;
  detail: string;
  transport: 'encrypted-deeplink' | 'walletconnect';
  appStoreUrl: string;
}

export type IosNativeLogLevel = 'silent' | 'error' | 'info' | 'debug';

interface IosAuthRecord {
  publicKey: string;
  walletId: IosNativeWalletId;
  walletName: string;
  cluster: Cluster;
  session?: string;
  walletEncryptionPublicKeyBase64?: string;
  walletEncryptionPublicKeyBase58?: string;
  sharedSecretBase64?: string;
  dappPublicKeyBase64?: string;
  dappSecretKeyBase64?: string;
  walletConnectTopic?: string;
  timestampUnixSeconds: number;
  authenticated: boolean;
}

interface IosAuthCacheRoot {
  schema: 1;
  latest: string;
  records: Record<string, IosAuthRecord>;
}

interface PendingRuntimeState {
  schema: 1;
  phase: 'connect' | 'sign';
  requestId: string;
  walletId: IosNativeWalletId;
  cluster: Cluster;
  createdAt: number;
  dappPublicKeyBase64?: string;
  dappSecretKeyBase64?: string;
}

interface PendingApprovalEntry {
  approval: ApprovalResource;
  request?: SigningRequest;
  createdAt: number;
}

interface CallbackWaiter {
  resolve(url: string): void;
  reject(err: Error): void;
  timer: number;
}

interface AgenticSecureStatePlugin {
  get(options: { key: string }): Promise<{ value?: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  clearNamespace(options: { prefix: string }): Promise<void>;
}

interface AgenticWalletConnectPlugin {
  wcConnect(options?: { cluster?: Cluster; appUrl?: string }): Promise<{ uri?: string; topic?: string; pubkey?: string }>;
  wcLaunchWallet(options: { uri: string; walletId?: string }): Promise<{ launched?: boolean }>;
  wcWaitForSession(options?: { timeoutMs?: number }): Promise<{ pubkey?: string; topic?: string }>;
  wcGetSession(): Promise<{ connected?: boolean; pubkey?: string; topic?: string }>;
  wcSignMessage(options: {
    pubkey: string;
    message: string;
    timeoutMs?: number;
    walletId?: string;
  }): Promise<{ signature?: string }>;
  wcSignTransaction(options: {
    pubkey: string;
    transaction: string;
    timeoutMs?: number;
    walletId?: string;
  }): Promise<{ signature?: string; transaction?: string; transactionEncoding?: 'base58' | 'base64' }>;
  wcSignAndSendTransaction(options: {
    pubkey: string;
    transaction: string;
    timeoutMs?: number;
    walletId?: string;
  }): Promise<{ signature?: string; txid?: string }>;
  wcDisconnect(): Promise<{ disconnected?: boolean }>;
  wcClearState(): Promise<{ cleared?: boolean }>;
}

const AgenticSecureState = registerPlugin<AgenticSecureStatePlugin>('AgenticSecureState');
const AgenticWalletConnect = registerPlugin<AgenticWalletConnectPlugin>('AgenticWalletConnect');

const AUTH_CACHE_KEY = 'agentic-ios-auth-cache-v1';
const PENDING_STATE_KEY = 'agentic-ios-pending-state-v1';
const DEFAULT_CALLBACK_SCHEME = 'agenticwallet';
const DEFAULT_REQUEST_TTL_MS = 120_000;
const FALSE_ENV_VALUES = new Set(['0', 'false', 'no', 'off', 'native', 'swift']);
const IOS_URL_SUBSCRIBERS = new Set<(url: string) => void>();
let urlDispatcherInstalled = false;
let urlDispatcherPromise: Promise<void> | null = null;

export function capacitorIosAppEnabled(): boolean {
  const viteEnv = (import.meta as ImportMeta & {
    env?: Record<string, string | boolean | undefined>;
  }).env;
  const raw =
    viteEnv?.VITE_CAPACITOR_IOS_APP ??
    viteEnv?.VITE_CAPACITATOR_IOS_APP ??
    viteEnv?.CAPACITOR_IOS_APP ??
    viteEnv?.CAPACITATOR_IOS_APP ??
    'true';
  return !FALSE_ENV_VALUES.has(String(raw).trim().toLowerCase());
}

export function detectIosNativeEnvironment(callbackScheme = DEFAULT_CALLBACK_SCHEME): IosNativeEnvironment {
  const platform = safeCapacitorPlatform();
  const useCapacitorIosApp = capacitorIosAppEnabled();
  const isNative = useCapacitorIosApp && safeIsNativePlatform();
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const uaLooksIos =
    /iPhone|iPad|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
  const isIos = platform === 'ios' || uaLooksIos;
  return {
    isNative,
    platform,
    isIos,
    isIosNative: useCapacitorIosApp && isNative && platform === 'ios',
    callbackScheme,
  };
}

export function listIosNativeWalletOptions(): ReadonlyArray<IosNativeWalletOption> {
  return IOS_WALLETS.map((wallet) => ({
    id: wallet.id,
    name: wallet.name,
    detail: wallet.transport === 'walletconnect' ? 'WalletConnect / Reown' : 'Encrypted iOS deeplink',
    transport: wallet.transport,
    appStoreUrl: wallet.appStoreUrl,
  }));
}

export async function iosNativeCacheSummary(): Promise<{ count: number; latest?: IosAuthRecord }> {
  const cache = new IosAuthCache('info');
  return {
    count: await cache.count(),
    latest: await cache.latest(),
  };
}

export async function restoreLatestIosNativeWallet(
  options: Omit<IosNativeWalletBackendOptions, 'walletId'> & { walletId?: IosNativeWalletId },
): Promise<IosNativeRestoreResult | null> {
  const cache = new IosAuthCache(options.logLevel ?? 'info');
  const latest = await cache.latest();
  if (!latest) {
    iosLog(options.logLevel ?? 'info', 'IosNativeWalletBackend', 'restoreLatest', 'SKIP', 'info', 'no cached iOS authorization');
    return null;
  }
  if (options.walletId && latest.walletId !== options.walletId) {
    iosLog(options.logLevel ?? 'info', 'IosNativeWalletBackend', 'restoreLatest', 'SKIP', 'info', 'latest cache belongs to a different wallet', {
      requestedWallet: options.walletId,
      cachedWallet: latest.walletId,
    });
    return null;
  }
  const backend = new IosNativeWalletBackend({
    ...options,
    walletId: latest.walletId,
  });
  const restored = await backend.reconnectLatest(options.cluster);
  if (!restored) {
    return null;
  }
  return {
    backend,
    address: restored.publicKey,
    walletId: restored.walletId,
    walletName: restored.walletName,
    cacheCount: await cache.count(),
  };
}

export class IosNativeWalletBackend implements WalletBackend {
  private readonly walletId: IosNativeWalletId;
  private readonly cluster: Cluster;
  private readonly appUrl: string;
  private readonly callbackScheme: string;
  private readonly requestTtlMs: number;
  private readonly logLevel: IosNativeLogLevel;
  private readonly connection: Connection;
  private readonly cache: IosAuthCache;
  private readonly approvals = new Map<SigningRequestId, PendingApprovalEntry>();
  private readonly waiters = new Map<string, CallbackWaiter>();
  private activeRecord: IosAuthRecord | null = null;
  private subscribed = false;

  static async restoreLatest(options: Omit<IosNativeWalletBackendOptions, 'walletId'>): Promise<IosNativeRestoreResult | null> {
    return restoreLatestIosNativeWallet(options);
  }

  constructor(options: IosNativeWalletBackendOptions) {
    const descriptor = iosWalletDescriptor(options.walletId);
    if (!descriptor) {
      throw new ProtocolError('invalid_request', `Unsupported iOS wallet: ${options.walletId}`);
    }
    this.walletId = options.walletId;
    this.cluster = options.cluster;
    this.appUrl = options.appUrl;
    this.callbackScheme = options.callbackScheme ?? DEFAULT_CALLBACK_SCHEME;
    this.requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
    this.logLevel = options.logLevel ?? 'info';
    this.connection = new Connection(options.rpcUrl ?? defaultRpcUrl(options.cluster), 'confirmed');
    this.cache = new IosAuthCache(this.logLevel);
    this.log('constructor', 'READY', 'info', 'backend initialized', {
      wallet: this.walletId,
      cluster: this.cluster,
      callbackScheme: this.callbackScheme,
      transport: descriptor.transport,
    });
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
      ...(this.activeRecord && { address: this.activeRecord.publicKey }),
    };
  }

  async getAddress(): Promise<string> {
    if (this.activeRecord) {
      return this.activeRecord.publicKey;
    }
    const cached = await this.reconnectLatest(this.cluster);
    if (cached) {
      return cached.publicKey;
    }
    const record = this.walletId === 'jupiter' ? await this.connectJupiter() : await this.connectDeepLink(this.walletId);
    return record.publicKey;
  }

  async submit(request: SigningRequest): Promise<ApprovalResource> {
    if (request.cluster !== this.cluster) {
      throw new ProtocolError(
        'cluster_mismatch',
        `iOS native backend is configured for ${this.cluster}; request targets ${request.cluster}.`,
      );
    }
    if (!this.activeRecord) {
      await this.getAddress();
    }
    const approval: ApprovalResource = {
      requestId: request.id,
      status: 'pending',
    };
    this.approvals.set(request.id, {
      approval,
      request,
      createdAt: Date.now(),
    });
    this.log('submit', 'START', 'info', 'signing request queued', {
      requestId: request.id,
      kind: request.kind,
      wallet: this.walletId,
    });
    void this.resolveSigningRequest(request).catch((err: unknown) => {
      const entry = this.approvals.get(request.id);
      if (!entry || entry.approval.status !== 'pending') {
        return;
      }
      const protocolErr = protocolErrorFromUnknown(err, 'iOS signing failed.');
      entry.approval = {
        requestId: request.id,
        status: protocolErr.code === 'user_rejected' ? 'rejected' : 'failed',
        error: protocolErr.toPayload(),
      };
      this.log('submit', 'FAIL', 'error', 'signing request failed', {
        requestId: request.id,
        code: protocolErr.code,
        message: protocolErr.message,
      });
    });
    return approval;
  }

  async poll(requestId: SigningRequestId): Promise<ApprovalResource> {
    const entry = this.approvals.get(requestId);
    if (!entry) {
      throw new ProtocolError('invalid_request', `Unknown iOS native request id: ${requestId}`);
    }
    this.expireIfNeeded(requestId, entry);
    return entry.approval;
  }

  async cancel(requestId: SigningRequestId): Promise<void> {
    const entry = this.approvals.get(requestId);
    if (!entry) return;
    entry.approval = {
      requestId,
      status: 'rejected',
      error: {
        code: 'user_rejected',
        message: 'iOS native approval request cancelled by caller.',
        recoverable: false,
      },
    };
    await this.clearPendingRuntimeState();
    this.rejectWaiter('sign', requestId, new ProtocolError('user_rejected', 'iOS native approval request cancelled.'));
    this.log('cancel', 'DONE', 'info', 'approval cancelled', { requestId });
  }

  async reconnectLatest(cluster = this.cluster): Promise<IosAuthRecord | null> {
    const latestForWallet = await this.cache.latestForWallet(this.walletId);
    const latest = latestForWallet ?? (await this.cache.latest());
    if (!latest || !isUsableRecord(latest)) {
      this.log('reconnectLatest', 'SKIP', 'info', 'no usable cached authorization', { wallet: this.walletId });
      return null;
    }
    this.activeRecord = {
      ...latest,
      cluster,
      authenticated: true,
      timestampUnixSeconds: nowSeconds(),
    };
    await this.cache.set(this.activeRecord);
    this.log('reconnectLatest', 'SUCCESS', 'info', 'cached authorization restored', {
      wallet: this.activeRecord.walletId,
      pubkey: short(this.activeRecord.publicKey),
      cluster,
    });
    return this.activeRecord;
  }

  async disconnect(): Promise<void> {
    if (this.activeRecord) {
      await this.cache.set({
        ...this.activeRecord,
        authenticated: false,
        timestampUnixSeconds: nowSeconds(),
      });
    }
    this.activeRecord = null;
    await this.clearTransientState('disconnect');
    this.log('disconnect', 'DONE', 'info', 'local session disconnected with cache retained');
  }

  async clearTransientState(reason: string): Promise<void> {
    for (const [requestId, entry] of this.approvals) {
      if (entry.approval.status !== 'pending') continue;
      entry.approval = {
        requestId,
        status: 'expired',
        error: {
          code: 'expired',
          message: 'iOS transient approval state was cleared.',
          recoverable: true,
        },
      };
    }
    for (const [key, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new ProtocolError('expired', 'iOS transient callback state was cleared.'));
      this.waiters.delete(key);
    }
    await this.clearPendingRuntimeState();
    this.log('clearTransientState', 'DONE', 'info', 'transient state cleared', { reason });
  }

  async clearStateFullReset(reason: string): Promise<void> {
    const pubkey = this.activeRecord?.publicKey ?? (await this.cache.latest())?.publicKey ?? '';
    await this.clearTransientState(reason);
    if (pubkey) {
      await this.cache.clear(pubkey);
    }
    this.activeRecord = null;
    if (this.walletId === 'jupiter') {
      await callWalletConnect('wcDisconnect', () => AgenticWalletConnect.wcDisconnect(), this.logLevel).catch(() => undefined);
    }
    this.log('clearStateFullReset', 'DONE', 'info', 'authorization cleared', {
      reason,
      pubkey: short(pubkey),
    });
  }

  async clearAllCachedAuthorizations(): Promise<void> {
    await this.clearTransientState('clear_all_cached_authorizations');
    await this.cache.clearAll();
    this.activeRecord = null;
    await callWalletConnect('wcClearState', () => AgenticWalletConnect.wcClearState(), this.logLevel).catch(() => undefined);
    this.log('clearAllCachedAuthorizations', 'DONE', 'info', 'all cached iOS authorizations cleared');
  }

  private async connectDeepLink(walletId: IosDeepLinkWalletId): Promise<IosAuthRecord> {
    await this.ensureCallbackSubscription();
    const dapp = nacl.box.keyPair();
    const requestId = newSigningRequestId();
    const redirect = makeIosRedirect(this.callbackScheme, 'connect', requestId);
    await this.setPendingRuntimeState({
      schema: 1,
      phase: 'connect',
      requestId,
      walletId,
      cluster: this.cluster,
      createdAt: Date.now(),
      dappPublicKeyBase64: encodeBase64(dapp.publicKey),
      dappSecretKeyBase64: encodeBase64(dapp.secretKey),
    });
    const connectUrl = buildIosConnectUrl(walletId, {
      appUrl: this.appUrl,
      cluster: this.cluster,
      dappEncryptionPublicKey: dapp.publicKey,
      redirectLink: redirect,
    });
    const callbackPromise = this.waitForCallback('connect', requestId);
    this.log('connectDeepLink', 'URL_BUILT', 'info', 'opening wallet connect link', {
      requestId,
      wallet: walletId,
      walletUrl: urlShape(connectUrl),
      callback: urlShape(redirect),
    });
    openWalletUrl(connectUrl);
    const callbackUrl = await callbackPromise;
    const decoded = parseIosConnectCallback(walletId, callbackUrl, dapp.secretKey);
    const descriptor = iosWalletDescriptor(walletId)!;
    const record: IosAuthRecord = {
      publicKey: decoded.publicKey,
      walletId,
      walletName: descriptor.name,
      cluster: this.cluster,
      session: decoded.session,
      walletEncryptionPublicKeyBase64: encodeBase64(decoded.walletEncryptionPublicKey),
      walletEncryptionPublicKeyBase58: decoded.walletEncryptionPublicKeyBase58,
      sharedSecretBase64: encodeBase64(decoded.sharedSecret),
      dappPublicKeyBase64: encodeBase64(dapp.publicKey),
      dappSecretKeyBase64: encodeBase64(dapp.secretKey),
      timestampUnixSeconds: nowSeconds(),
      authenticated: true,
    };
    this.activeRecord = record;
    await this.cache.set(record);
    await this.clearPendingRuntimeState();
    this.log('connectDeepLink', 'SUCCESS', 'info', 'wallet connected and cached', {
      requestId,
      wallet: walletId,
      pubkey: short(record.publicKey),
      decryptPath: decoded.decryptPath,
      keyAlias: decoded.walletEncryptionKeyAlias,
    });
    return record;
  }

  private async connectJupiter(): Promise<IosAuthRecord> {
    const existing = await callWalletConnect('wcGetSession', () => AgenticWalletConnect.wcGetSession(), this.logLevel).catch(() => null);
    if (existing?.connected && existing.pubkey) {
      return this.storeJupiterRecord(existing.pubkey, existing.topic);
    }
    this.log('connectJupiter', 'START', 'info', 'starting Jupiter WalletConnect session');
    const pairing = await callWalletConnect(
      'wcConnect',
      () => AgenticWalletConnect.wcConnect({ cluster: this.cluster, appUrl: this.appUrl }),
      this.logLevel,
    );
    if (pairing.pubkey) {
      return this.storeJupiterRecord(pairing.pubkey, pairing.topic);
    }
    if (!pairing.uri) {
      throw new ProtocolError('wallet_unreachable', 'Jupiter WalletConnect did not return a pairing URI.');
    }
    await callWalletConnect(
      'wcLaunchWallet',
      () => AgenticWalletConnect.wcLaunchWallet({ uri: pairing.uri!, walletId: 'jupiter' }),
      this.logLevel,
    );
    const session = await callWalletConnect(
      'wcWaitForSession',
      () => AgenticWalletConnect.wcWaitForSession({ timeoutMs: this.requestTtlMs }),
      this.logLevel,
    );
    if (!session.pubkey) {
      throw new ProtocolError('wallet_unreachable', 'Jupiter did not return a Solana account.');
    }
    return this.storeJupiterRecord(session.pubkey, session.topic ?? pairing.topic);
  }

  private async storeJupiterRecord(pubkey: string, topic?: string): Promise<IosAuthRecord> {
    const descriptor = iosWalletDescriptor('jupiter')!;
    const record: IosAuthRecord = {
      publicKey: pubkey,
      walletId: 'jupiter',
      walletName: descriptor.name,
      cluster: this.cluster,
      walletConnectTopic: topic,
      timestampUnixSeconds: nowSeconds(),
      authenticated: true,
    };
    this.activeRecord = record;
    await this.cache.set(record);
    this.log('connectJupiter', 'SUCCESS', 'info', 'Jupiter WalletConnect session cached', {
      pubkey: short(pubkey),
      topic: short(topic ?? ''),
    });
    return record;
  }

  private async resolveSigningRequest(request: SigningRequest): Promise<void> {
    const entry = this.approvals.get(request.id);
    if (!entry) {
      return;
    }
    const record = this.activeRecord;
    if (!record) {
      throw new ProtocolError('unauthorized', 'No iOS wallet is connected.');
    }
    const result =
      record.walletId === 'jupiter'
        ? await this.signWithJupiter(request, record)
        : await this.signWithDeepLink(request, record as IosAuthRecord & { walletId: IosDeepLinkWalletId });
    entry.approval = {
      requestId: request.id,
      status: 'approved',
      result,
    };
    this.log('resolveSigningRequest', 'SUCCESS', 'info', 'signing request resolved', {
      requestId: request.id,
      kind: request.kind,
      wallet: record.walletId,
      txid: short(result.txid ?? ''),
    });
  }

  private async signWithDeepLink(
    request: SigningRequest,
    record: IosAuthRecord & { walletId: IosDeepLinkWalletId },
  ): Promise<{ signature: string; txid?: string }> {
    await this.ensureCallbackSubscription();
    if (!record.sharedSecretBase64 || !record.dappPublicKeyBase64 || !record.session) {
      throw new ProtocolError('unauthorized', 'Cached iOS deeplink authorization is incomplete. Connect again.');
    }
    const sharedSecret = decodeBase64(record.sharedSecretBase64);
    const dappPublicKey = decodeBase64(record.dappPublicKeyBase64);
    const payload = this.buildDeepLinkSigningPayload(request, record.session);
    const redirect = makeIosRedirect(this.callbackScheme, 'sign', request.id);
    await this.setPendingRuntimeState({
      schema: 1,
      phase: 'sign',
      requestId: request.id,
      walletId: record.walletId,
      cluster: this.cluster,
      createdAt: Date.now(),
      dappPublicKeyBase64: record.dappPublicKeyBase64,
      dappSecretKeyBase64: record.dappSecretKeyBase64,
    });
    const url =
      request.kind === 'sign_message'
        ? buildIosSignMessageUrl({
            walletId: record.walletId,
            dappEncryptionPublicKey: dappPublicKey,
            redirectLink: redirect,
            payload,
            sharedSecret,
          })
        : buildIosSignTransactionUrl({
            walletId: record.walletId,
            dappEncryptionPublicKey: dappPublicKey,
            redirectLink: redirect,
            payload,
            sharedSecret,
          });
    const callbackPromise = this.waitForCallback('sign', request.id);
    this.log('signWithDeepLink', 'URL_BUILT', 'info', 'opening wallet signing link', {
      requestId: request.id,
      wallet: record.walletId,
      kind: request.kind,
      payloadKeys: Object.keys(payload).sort().join(','),
      walletUrl: urlShape(url),
      callback: urlShape(redirect),
    });
    openWalletUrl(url);
    const callbackUrl = await callbackPromise;
    const decoded = parseIosSigningCallback(callbackUrl, sharedSecret);
    await this.clearPendingRuntimeState();
    return this.resolveDeepLinkSigningResult(request, decoded);
  }

  private async signWithJupiter(
    request: SigningRequest,
    record: IosAuthRecord,
  ): Promise<{ signature: string; txid?: string }> {
    const payload = decodeSigningPayload(request.payload.data, request.payload.encoding);
    switch (request.kind) {
      case 'sign_message': {
        const message = bs58.encode(payload);
        const result = await callWalletConnect(
          'wcSignMessage',
          () =>
            AgenticWalletConnect.wcSignMessage({
              pubkey: record.publicKey,
              message,
              timeoutMs: this.requestTtlMs,
              walletId: 'jupiter',
            }),
          this.logLevel,
        );
        if (!result.signature) {
          throw new ProtocolError('wallet_unreachable', 'Jupiter did not return a message signature.');
        }
        return { signature: result.signature };
      }
      case 'sign_transaction': {
        const result = await callWalletConnect(
          'wcSignTransaction',
          () =>
            AgenticWalletConnect.wcSignTransaction({
              pubkey: record.publicKey,
              transaction: bs58.encode(payload),
              timeoutMs: this.requestTtlMs,
              walletId: 'jupiter',
            }),
          this.logLevel,
        );
        if (result.transaction) {
          const signedBytes =
            result.transactionEncoding === 'base64' ? decodeBase64(result.transaction) : bs58.decode(result.transaction);
          return { signature: encodeBase64(signedBytes) };
        }
        if (result.signature) {
          return { signature: result.signature };
        }
        throw new ProtocolError('wallet_unreachable', 'Jupiter did not return a signed transaction.');
      }
      case 'sign_and_send_transaction': {
        const result = await callWalletConnect(
          'wcSignAndSendTransaction',
          () =>
            AgenticWalletConnect.wcSignAndSendTransaction({
              pubkey: record.publicKey,
              transaction: bs58.encode(payload),
              timeoutMs: this.requestTtlMs,
              walletId: 'jupiter',
            }),
          this.logLevel,
        );
        const txid = result.txid ?? result.signature;
        if (!txid) {
          throw new ProtocolError('wallet_unreachable', 'Jupiter did not return a transaction id.');
        }
        return { signature: txid, txid };
      }
    }
  }

  private buildDeepLinkSigningPayload(request: SigningRequest, session: string): Record<string, unknown> {
    const bytes = decodeSigningPayload(request.payload.data, request.payload.encoding);
    switch (request.kind) {
      case 'sign_message':
        return {
          session,
          message: bs58.encode(bytes),
          display: 'utf8',
        };
      case 'sign_transaction':
      case 'sign_and_send_transaction':
        return {
          session,
          transaction: bs58.encode(bytes),
        };
    }
  }

  private async resolveDeepLinkSigningResult(
    request: SigningRequest,
    decoded: ReturnType<typeof parseIosSigningCallback>,
  ): Promise<{ signature: string; txid?: string }> {
    switch (request.kind) {
      case 'sign_message':
        if (!decoded.signature) {
          throw new ProtocolError('wallet_unreachable', 'iOS wallet returned no message signature.');
        }
        return { signature: decoded.signature };
      case 'sign_transaction':
        if (!decoded.transactionBytes) {
          throw new ProtocolError('wallet_unreachable', 'iOS wallet returned no signed transaction.');
        }
        return { signature: encodeBase64(decoded.transactionBytes) };
      case 'sign_and_send_transaction': {
        if (!decoded.transactionBytes) {
          throw new ProtocolError('wallet_unreachable', 'iOS wallet returned no signed transaction.');
        }
        const txid = await this.connection.sendRawTransaction(decoded.transactionBytes, {
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
        await this.connection.confirmTransaction(txid, 'confirmed');
        return { signature: txid, txid };
      }
    }
  }

  private async ensureCallbackSubscription(): Promise<void> {
    await installIosUrlDispatcher();
    if (this.subscribed) {
      return;
    }
    IOS_URL_SUBSCRIBERS.add((url) => this.handleIncomingUrl(url));
    this.subscribed = true;
  }

  private handleIncomingUrl(rawUrl: string): void {
    let url: URL;
    try {
      url = new URL(rawUrl.replace(/#$/, ''));
    } catch {
      return;
    }
    const phase = callbackPhase(url);
    if (!phase) {
      return;
    }
    const requestId = url.searchParams.get('requestId');
    if (!requestId) {
      this.log('handleIncomingUrl', 'FAIL', 'error', 'callback missing requestId', {
        callback: urlShape(url.toString()),
      });
      return;
    }
    const key = waiterKey(phase, requestId);
    const waiter = this.waiters.get(key);
    this.log('handleIncomingUrl', waiter ? 'MATCH' : 'ORPHAN', 'info', 'iOS callback received', {
      phase,
      requestId,
      callback: urlShape(url.toString()),
    });
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    this.waiters.delete(key);
    waiter.resolve(url.toString());
  }

  private waitForCallback(phase: 'connect' | 'sign', requestId: string): Promise<string> {
    const key = waiterKey(phase, requestId);
    const existing = this.waiters.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.waiters.delete(key);
      existing.reject(new ProtocolError('expired', 'Superseded by a newer iOS callback waiter.'));
    }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiters.delete(key);
        reject(new ProtocolError('expired', `iOS wallet callback timed out after ${this.requestTtlMs}ms.`));
      }, this.requestTtlMs);
      this.waiters.set(key, { resolve, reject, timer });
    });
  }

  private rejectWaiter(phase: 'connect' | 'sign', requestId: string, err: Error): void {
    const key = waiterKey(phase, requestId);
    const waiter = this.waiters.get(key);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    this.waiters.delete(key);
    waiter.reject(err);
  }

  private expireIfNeeded(requestId: SigningRequestId, entry: PendingApprovalEntry): void {
    if (entry.approval.status !== 'pending') {
      return;
    }
    if (Date.now() <= entry.createdAt + this.requestTtlMs) {
      return;
    }
    entry.approval = {
      requestId,
      status: 'expired',
      error: {
        code: 'expired',
        message: 'iOS wallet approval request expired.',
        recoverable: true,
      },
    };
    this.rejectWaiter('sign', requestId, new ProtocolError('expired', 'iOS wallet approval request expired.'));
    this.log('expireIfNeeded', 'EXPIRED', 'info', 'request expired', { requestId });
  }

  private async setPendingRuntimeState(state: PendingRuntimeState): Promise<void> {
    await writeState(PENDING_STATE_KEY, JSON.stringify(state), this.logLevel);
  }

  private async clearPendingRuntimeState(): Promise<void> {
    await removeState(PENDING_STATE_KEY, this.logLevel);
  }

  private log(
    method: string,
    step: string,
    level: Exclude<IosNativeLogLevel, 'silent'>,
    message: string,
    metadata: Record<string, string> = {},
  ): void {
    iosLog(this.logLevel, 'IosNativeWalletBackend', method, step, level, message, metadata);
  }
}

class IosAuthCache {
  constructor(private readonly logLevel: IosNativeLogLevel) {}

  async latest(): Promise<IosAuthRecord | null> {
    const root = await this.load();
    if (root.latest) {
      const latest = root.records[root.latest];
      if (latest) return latest;
    }
    const records = Object.values(root.records).sort((a, b) => b.timestampUnixSeconds - a.timestampUnixSeconds);
    return records[0] ?? null;
  }

  async latestForWallet(walletId: IosNativeWalletId): Promise<IosAuthRecord | null> {
    const root = await this.load();
    const records = Object.values(root.records)
      .filter((record) => record.walletId === walletId)
      .sort((a, b) => b.timestampUnixSeconds - a.timestampUnixSeconds);
    return records[0] ?? null;
  }

  async count(): Promise<number> {
    return Object.keys((await this.load()).records).length;
  }

  async set(record: IosAuthRecord): Promise<void> {
    const root = await this.load();
    root.records[record.publicKey] = record;
    root.latest = record.publicKey;
    await this.save(root);
    iosLog(this.logLevel, 'IosAuthCache', 'set', 'DONE', 'info', 'cache record saved', {
      wallet: record.walletId,
      pubkey: short(record.publicKey),
      count: String(Object.keys(root.records).length),
    });
  }

  async clear(publicKey: string): Promise<void> {
    const root = await this.load();
    delete root.records[publicKey];
    if (root.latest === publicKey) {
      const latest = Object.values(root.records).sort((a, b) => b.timestampUnixSeconds - a.timestampUnixSeconds)[0];
      root.latest = latest?.publicKey ?? '';
    }
    await this.save(root);
    iosLog(this.logLevel, 'IosAuthCache', 'clear', 'DONE', 'info', 'cache record cleared', {
      pubkey: short(publicKey),
      count: String(Object.keys(root.records).length),
    });
  }

  async clearAll(): Promise<void> {
    await this.save({ schema: 1, latest: '', records: {} });
    iosLog(this.logLevel, 'IosAuthCache', 'clearAll', 'DONE', 'info', 'cache cleared');
  }

  private async load(): Promise<IosAuthCacheRoot> {
    const raw = await readState(AUTH_CACHE_KEY, this.logLevel);
    if (!raw) {
      return { schema: 1, latest: '', records: {} };
    }
    try {
      const parsed = JSON.parse(raw) as IosAuthCacheRoot;
      return {
        schema: 1,
        latest: typeof parsed.latest === 'string' ? parsed.latest : '',
        records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {},
      };
    } catch (err) {
      iosLog(this.logLevel, 'IosAuthCache', 'load', 'FAIL', 'error', 'cache parse failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      return { schema: 1, latest: '', records: {} };
    }
  }

  private async save(root: IosAuthCacheRoot): Promise<void> {
    await writeState(AUTH_CACHE_KEY, JSON.stringify(root), this.logLevel);
  }
}

async function installIosUrlDispatcher(): Promise<void> {
  if (urlDispatcherInstalled) {
    return;
  }
  if (urlDispatcherPromise) {
    return urlDispatcherPromise;
  }
  urlDispatcherPromise = (async () => {
    urlDispatcherInstalled = true;
    try {
      const launchUrl = await CapacitorApp.getLaunchUrl();
      if (launchUrl?.url) {
        dispatchIosUrl(launchUrl.url);
      }
    } catch (err) {
      iosLog('info', 'IosUrlDispatcher', 'getLaunchUrl', 'SKIP', 'debug', 'launch URL unavailable', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await CapacitorApp.addListener('appUrlOpen', (event: URLOpenListenerEvent) => {
        dispatchIosUrl(event.url);
      });
      iosLog('info', 'IosUrlDispatcher', 'install', 'DONE', 'info', 'Capacitor appUrlOpen listener installed');
    } catch (err) {
      iosLog('info', 'IosUrlDispatcher', 'install', 'FAIL', 'error', 'Capacitor appUrlOpen listener failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  })();
  return urlDispatcherPromise;
}

function dispatchIosUrl(url: string): void {
  for (const subscriber of IOS_URL_SUBSCRIBERS) {
    subscriber(url);
  }
}

function callbackPhase(url: URL): 'connect' | 'sign' | null {
  const phase = url.searchParams.get('phase');
  if (phase === 'connect' || phase === 'sign') {
    return phase;
  }
  if (url.pathname.endsWith('/connect') || url.pathname.endsWith('/ios/callback/connect')) {
    return 'connect';
  }
  if (url.pathname.endsWith('/sign') || url.pathname.endsWith('/ios/callback/sign')) {
    return 'sign';
  }
  return null;
}

function waiterKey(phase: 'connect' | 'sign', requestId: string): string {
  return `${phase}:${requestId}`;
}

function openWalletUrl(url: string): void {
  window.location.href = url;
}

function decodeSigningPayload(data: string, encoding: 'utf8' | 'base64'): Uint8Array {
  return encoding === 'utf8' ? encodeUtf8(data) : decodeBase64(data);
}

function isUsableRecord(record: IosAuthRecord): boolean {
  if (!record.publicKey || !record.walletId) {
    return false;
  }
  if (record.walletId === 'jupiter') {
    return true;
  }
  return Boolean(record.session && record.sharedSecretBase64 && record.dappPublicKeyBase64);
}

async function callWalletConnect<T>(
  method: string,
  call: () => Promise<T>,
  logLevel: IosNativeLogLevel,
): Promise<T> {
  try {
    const result = await call();
    iosLog(logLevel, 'AgenticWalletConnect', method, 'DONE', 'info', 'native WalletConnect method returned');
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    iosLog(logLevel, 'AgenticWalletConnect', method, 'FAIL', 'error', 'native WalletConnect method failed', {
      message,
    });
    if (message.toLowerCase().includes('not implemented')) {
      throw new ProtocolError(
        'unsupported_method',
        'The iOS app is missing the AgenticWalletConnect native plugin required for Jupiter.',
      );
    }
    throw err;
  }
}

async function readState(key: string, logLevel: IosNativeLogLevel): Promise<string | null> {
  if (safeIsNativePlatform()) {
    try {
      const result = await AgenticSecureState.get({ key });
      if (result.value !== undefined) {
        return result.value ?? null;
      }
    } catch (err) {
      iosLog(logLevel, 'AgenticSecureState', 'get', 'SKIP', 'debug', 'native state get unavailable', {
        key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return localStorage.getItem(key);
}

async function writeState(key: string, value: string, logLevel: IosNativeLogLevel): Promise<void> {
  if (safeIsNativePlatform()) {
    try {
      await AgenticSecureState.set({ key, value });
      return;
    } catch (err) {
      iosLog(logLevel, 'AgenticSecureState', 'set', 'SKIP', 'debug', 'native state set unavailable', {
        key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  localStorage.setItem(key, value);
}

async function removeState(key: string, logLevel: IosNativeLogLevel): Promise<void> {
  if (safeIsNativePlatform()) {
    try {
      await AgenticSecureState.remove({ key });
      return;
    } catch (err) {
      iosLog(logLevel, 'AgenticSecureState', 'remove', 'SKIP', 'debug', 'native state remove unavailable', {
        key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  localStorage.removeItem(key);
}

function defaultRpcUrl(cluster: Cluster): string {
  switch (cluster) {
    case 'mainnet-beta':
      return 'https://api.mainnet-beta.solana.com';
    case 'devnet':
      return 'https://api.devnet.solana.com';
    case 'testnet':
      return 'https://api.testnet.solana.com';
    case 'localnet':
      return 'http://127.0.0.1:8899';
  }
}

function safeCapacitorPlatform(): string {
  try {
    return Capacitor.getPlatform();
  } catch {
    return 'web';
  }
}

function safeIsNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function protocolErrorFromUnknown(err: unknown, fallbackMessage: string): ProtocolError {
  if (err instanceof ProtocolError) {
    return err;
  }
  if (err instanceof Error) {
    const message = err.message || fallbackMessage;
    const lower = message.toLowerCase();
    if (lower.includes('reject') || lower.includes('denied') || lower.includes('cancel')) {
      return new ProtocolError('user_rejected', message);
    }
    if (lower.includes('timeout') || lower.includes('expired')) {
      return new ProtocolError('expired', message);
    }
    if (lower.includes('not implemented') || lower.includes('unsupported')) {
      return new ProtocolError('unsupported_method', message);
    }
    return new ProtocolError('wallet_unreachable', message);
  }
  return new ProtocolError('wallet_unreachable', fallbackMessage);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function urlShape(value: string): string {
  try {
    const url = new URL(value);
    return `scheme=${url.protocol.replace(':', '')} host=${url.host} path=${url.pathname} query_keys=${[...url.searchParams.keys()].sort().join(',')}`;
  } catch {
    return 'invalid_url';
  }
}

function short(value: string, prefix = 8, suffix = 8): string {
  if (value.length <= prefix + suffix) return value;
  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}

function iosLog(
  configured: IosNativeLogLevel,
  component: string,
  method: string,
  step: string,
  level: Exclude<IosNativeLogLevel, 'silent'>,
  message: string,
  metadata: Record<string, string> = {},
): void {
  if (!shouldLog(configured, level)) {
    return;
  }
  const suffix = Object.entries(metadata)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${sanitizeKey(key)}=${quoteLogValue(sanitizeValue(key, value))}`)
    .join(' ');
  console.info(
    `[AgentIOSApp] [${component}] ${method} | ${step} phase=${level === 'error' ? 'FAIL' : 'INFO'} message=${quoteLogValue(message)}${suffix ? ` ${suffix}` : ''}`,
  );
}

function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function sanitizeValue(key: string, value: string): string {
  const normalized = key.toLowerCase();
  if (
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('private') ||
    normalized.includes('shared') ||
    normalized.includes('session') ||
    normalized.includes('payload') ||
    normalized.includes('signature') ||
    normalized.includes('transaction') ||
    normalized.includes('ciphertext') ||
    normalized.includes('plaintext')
  ) {
    return '[redacted]';
  }
  return redactUrl(value).slice(0, 240);
}

function redactUrl(value: string): string {
  return value.replace(/([?&][^=&]*(?:api[-_]?key|token|secret|session|payload|signature|transaction)[^=&]*=)[^&\s]+/gi, '$1[redacted]');
}

function quoteLogValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function shouldLog(configured: IosNativeLogLevel, event: Exclude<IosNativeLogLevel, 'silent'>): boolean {
  const rank = { silent: 0, error: 1, info: 2, debug: 3 } as const;
  return rank[event] <= rank[configured];
}
