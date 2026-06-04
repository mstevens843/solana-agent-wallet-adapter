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
  buildIosConnectUrlCandidates,
  buildIosSignMessageUrl,
  buildIosSignMessageUrlCandidates,
  buildIosSignTransactionUrl,
  buildIosSignTransactionUrlCandidates,
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
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

export type IosNativeWalletId = IosWalletId;

export interface IosNativeEnvironment {
  isNative: boolean;
  platform: string;
  isIos: boolean;
  isIosNative: boolean;
  callbackScheme: string;
}

export const IOS_CLOUD_SESSION_REHYDRATED_EVENT = 'agentic-cloud-session-rehydrated';

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

export type IosNativeWalletLaunchStrategy = 'native-open' | 'webview-location';

export interface IosNativeCallbackWaiterMatch {
  status: 'match' | 'no_match' | 'ambiguous';
  key?: string;
  requestId?: string;
  matchKind: 'explicit' | 'active';
}

interface AgenticSecureStatePlugin {
  get(options: { key: string }): Promise<{ value?: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  clearNamespace(options: { prefix: string }): Promise<void>;
}

interface AgenticWalletConnectPlugin {
  wcConnect(options?: { cluster?: Cluster; appUrl?: string }): Promise<{ uri?: string; topic?: string; pubkey?: string }>;
  wcLaunchWallet(options: { uri: string; walletId?: string }): Promise<{ launched?: boolean; url?: string }>;
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
  // Re-open Jupiter for a pending connect/sign (force). Used by the manual
  // "Open Jupiter again" backstop when Jupiter cold-dropped the deep link.
  wcReForeground(): Promise<{ ok?: boolean }>;
}

interface AgenticBiometricCanAuthenticateResult {
  status: number;
  kind: string;
  biometryType?: string;
  message?: string;
}

interface AgenticBiometricPromptResult {
  ok: boolean;
  kind?: string;
  authType?: string;
  code?: number;
  message?: string;
}

interface AgenticBiometricPlugin {
  canAuthenticate(options?: { allowDeviceCredential?: boolean }): Promise<AgenticBiometricCanAuthenticateResult>;
  prompt(options: {
    title?: string;
    subtitle?: string;
    description?: string;
    reason?: string;
    fallbackTitle?: string;
    negativeButton?: string;
    allowDeviceCredential?: boolean;
  }): Promise<AgenticBiometricPromptResult>;
}

interface AgenticSystemInfo {
  manufacturer: string;
  model: string;
  device: string;
  systemVersion: string;
  sdkInt: number;
  release: string;
  locale: string;
  timezone: string;
  batteryPercent: number;
  networkType: string;
  packageName: string;
}

interface AgenticSystemPlugin {
  openExternal(options: { url: string }): Promise<{ ok: boolean }>;
  systemInfo(): Promise<AgenticSystemInfo>;
  clipboardWrite(options: { text: string; label?: string }): Promise<{ ok: boolean }>;
  haptic(options: { pattern: 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' }): Promise<{ ok: boolean }>;
  showNotification(options: { title: string; body?: string; tag?: string; channelId?: string }): Promise<{
    ok: boolean;
    kind?: string;
    id?: string;
    tag?: string;
    message?: string;
  }>;
  requestNotificationAuthorization(): Promise<{
    status: 'authorized' | 'provisional' | 'ephemeral' | 'denied' | 'unknown';
  }>;
  appLifecycleState(): Promise<{ state: 'active' | 'inactive' | 'background' | 'unknown' }>;
  devLog(options: {
    component?: string;
    method?: string;
    step?: string;
    level?: 'info' | 'fail';
    message?: string;
    metadata?: Record<string, string>;
  }): Promise<{ ok: boolean }>;
  setDebugLogging(options: { enabled: boolean }): Promise<{ ok: boolean }>;
}

interface AgenticRemoteConfigStatus {
  version: number;
  source: 'server' | 'cache' | 'bundled';
  fetchedAtMs: number;
  walletCount: number;
  envelopeVersion: string;
}

interface AgenticRemoteConfigPlugin {
  get(): Promise<unknown>;
  refresh(options?: { force?: boolean }): Promise<AgenticRemoteConfigStatus>;
  status(): Promise<AgenticRemoteConfigStatus>;
}

interface AgenticDeviceAgentStatus {
  available: boolean;
  enabled: boolean;
  configured: boolean;
  state: string;
  runtime: string;
  provider?: string;
  apiFormat?: string;
  baseUrl?: string;
  model?: string;
  message?: string;
  checkedAt?: string | number;
  updatedAt?: string | number;
  lastError?: { code?: string; message?: string; subcode?: string } | string | null;
}

interface AgenticDeviceAgentPlugin {
  deviceAgentRequest(options: {
    requestId: string;
    method: string;
    payloadJson: string;
    debugBaseUrl?: string;
  }): Promise<unknown>;
  status(): Promise<AgenticDeviceAgentStatus>;
  configure(options: {
    clear?: boolean;
    provider?: string;
    apiFormat?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<AgenticDeviceAgentStatus>;
  start(options: Record<string, unknown>): Promise<AgenticDeviceAgentStatus>;
  stop(): Promise<AgenticDeviceAgentStatus>;
  generatePlan(payload: Record<string, unknown>): Promise<unknown>;
  reviewPlan(payload: Record<string, unknown>): Promise<unknown>;
  ask(payload: Record<string, unknown>): Promise<unknown>;
}

interface AgenticStreamingSessionPlugin {
  prepareSessionSigner(options?: { metadata?: Record<string, unknown> }): Promise<{
    signerId: string;
    ephemeralSignerPubkey: string;
    signerRuntime: string;
    activeSessions: number;
  }>;
  createSession(options: {
    sessionId: string;
    ephemeralPrivkeyBase64: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  bindPreparedSession(options: { sessionId: string; signerId: string; metadata?: Record<string, unknown> }): Promise<unknown>;
  activateSession(options: { sessionId: string; metadata?: Record<string, unknown> }): Promise<unknown>;
  signVoucher(options: { sessionId: string; voucherJson: string }): Promise<{
    sessionId: string;
    signature: string;
    signatureEncoding: string;
    voucherHash: string;
    cached: boolean;
    latencyMs: number;
    activeSessions: number;
  }>;
  signSettlementTx(options: { sessionId: string; settlement: Record<string, unknown> }): Promise<unknown>;
  revokeLocalSession(options: { sessionId: string }): Promise<{ sessionId: string; revoked: boolean; activeSessions: number }>;
  statusJson(): Promise<{
    available: boolean;
    runtime: string;
    signerRuntime: string;
    activeSessions: number;
    remainingDisplay: string;
    message?: string;
    capabilities: string[];
  }>;
  notificationState(): Promise<{ activeCount: number; remainingDisplay: string; text: string }>;
}

const AgenticSecureState = registerPlugin<AgenticSecureStatePlugin>('AgenticSecureState');
const AgenticWalletConnect = registerPlugin<AgenticWalletConnectPlugin>('AgenticWalletConnect');
// New plugins (Phase 0.5 wiring; native bodies filled in Phases 1–4):
const AgenticBiometric = registerPlugin<AgenticBiometricPlugin>('AgenticBiometric');
const AgenticSystem = registerPlugin<AgenticSystemPlugin>('AgenticSystem');
const AgenticRemoteConfig = registerPlugin<AgenticRemoteConfigPlugin>('AgenticRemoteConfig');
const AgenticDeviceAgent = registerPlugin<AgenticDeviceAgentPlugin>('AgenticDeviceAgent');
const AgenticStreamingSession = registerPlugin<AgenticStreamingSessionPlugin>('AgenticStreamingSession');
// Re-export under named globals so cross-platform call sites can address them
// the same way they address the Android equivalents. Phases 1–4 fill these in.
if (typeof globalThis !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as Record<string, unknown>;
  g.__agenticIosBiometricBridge = AgenticBiometric;
  g.__agenticIosSystemBridge = AgenticSystem;
  g.__agenticIosRemoteConfigBridge = AgenticRemoteConfig;
  g.__agenticIosDeviceAgentBridge = AgenticDeviceAgent;
  g.__agenticIosStreamingBridge = AgenticStreamingSession;
}

const AUTH_CACHE_KEY = 'agentic-ios-auth-cache-v1';
const PENDING_STATE_KEY = 'agentic-ios-pending-state-v1';
const CLOUD_SESSION_TOKEN_KEY = 'cloudSessionToken';
export const DEFAULT_IOS_APP_URL = 'https://agentic-signer.com';
const DEFAULT_CALLBACK_SCHEME = 'agenticwallet';
const DEFAULT_REQUEST_TTL_MS = 120_000;
const MOBILE_WALLET_DEBUG_TIMEOUT_MS = 1500;
const MOBILE_WALLET_DEBUG_WALLETS = new Set(['backpack', 'jupiter']);
const FALSE_ENV_VALUES = new Set(['0', 'false', 'no', 'off', 'native', 'swift']);
const IOS_URL_SUBSCRIBERS = new Set<(url: string) => void>();
let urlDispatcherInstalled = false;
let urlDispatcherPromise: Promise<void> | null = null;
let cloudSessionTokenHydrated = false;
let cachedCloudSessionToken = '';
let cloudSessionTokenWriteCounter = 0;

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

export function iosNativeAppUrl(): string {
  const viteEnv = (import.meta as ImportMeta & {
    env?: Record<string, string | boolean | undefined>;
  }).env;
  const lookup = (key: string) => envValue(viteEnv, key);
  return (
    httpsOrigin(lookup('VITE_AGENTIC_IOS_APP_URL')) ??
    httpsOrigin(lookup('VITE_AGENTIC_CLOUD_API_BASE_URL')) ??
    httpsOrigin(lookup('AGENTIC_CLOUD_API_BASE_URL')) ??
    DEFAULT_IOS_APP_URL
  );
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

export function iosNativeCloudSessionToken(): string {
  if (!cloudSessionTokenHydrated) {
    cloudSessionTokenHydrated = true;
    void hydrateCloudSessionTokenFromSecureState();
  }
  return cachedCloudSessionToken;
}

export async function setIosNativeCloudSessionToken(token: string): Promise<boolean> {
  const value = (token ?? '').trim();
  cachedCloudSessionToken = value;
  cloudSessionTokenHydrated = true;
  cloudSessionTokenWriteCounter += 1;
  try {
    await writeState(CLOUD_SESSION_TOKEN_KEY, value, 'error');
    return true;
  } catch (err) {
    iosLog('error', 'AgenticSecureState', 'setCloudSessionToken', 'FAIL', 'error', 'cloud session token write failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function clearIosNativeCloudSessionToken(): Promise<boolean> {
  cachedCloudSessionToken = '';
  cloudSessionTokenHydrated = true;
  cloudSessionTokenWriteCounter += 1;
  try {
    await removeState(CLOUD_SESSION_TOKEN_KEY, 'error');
    return true;
  } catch (err) {
    iosLog('error', 'AgenticSecureState', 'clearCloudSessionToken', 'FAIL', 'error', 'cloud session token remove failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function hydrateCloudSessionTokenFromSecureState(): Promise<void> {
  const writeCounter = cloudSessionTokenWriteCounter;
  try {
    const value = (await readState(CLOUD_SESSION_TOKEN_KEY, 'debug') ?? '').trim();
    if (!value || writeCounter !== cloudSessionTokenWriteCounter || value === cachedCloudSessionToken) return;
    cachedCloudSessionToken = value;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(IOS_CLOUD_SESSION_REHYDRATED_EVENT));
    }
  } catch (err) {
    iosLog('debug', 'AgenticSecureState', 'hydrateCloudSessionToken', 'SKIP', 'debug', 'cloud session token unavailable', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function listIosNativeWalletOptions(): ReadonlyArray<IosNativeWalletOption> {
  return IOS_WALLETS.map((wallet) => ({
    id: wallet.id,
    name: wallet.name,
    detail: 'iOS wallet',
    transport: wallet.transport,
    appStoreUrl: wallet.appStoreUrl,
  }));
}

export async function iosNativeCacheSummary(): Promise<{ count: number; latest?: IosAuthRecord }> {
  const cache = new IosAuthCache('info');
  const latest = await cache.latest();
  return {
    count: await cache.count(),
    ...(latest ? { latest } : {}),
  };
}

export async function restoreLatestIosNativeWallet(
  options: Omit<IosNativeWalletBackendOptions, 'walletId'> & { walletId?: IosNativeWalletId },
): Promise<IosNativeRestoreResult | null> {
  const cache = new IosAuthCache(options.logLevel ?? 'info');
  const latest = options.walletId ? await cache.latestForWallet(options.walletId) : await cache.latest();
  if (!latest || !isUsableRecord(latest)) {
    iosLog(options.logLevel ?? 'info', 'IosNativeWalletBackend', 'restoreLatest', 'SKIP', 'info', 'no cached iOS authorization');
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
  private lastWalletConnectReturnAt = 0;

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

  async connectSelectedWallet(): Promise<string> {
    const record = this.walletId === 'jupiter'
      ? await this.connectJupiter({ forceNew: true })
      : await this.connectDeepLink(this.walletId);
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
    const latest = await this.cache.latestForWallet(this.walletId);
    if (!latest || latest.walletId !== this.walletId || !isUsableRecord(latest)) {
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
    const selectedRecord =
      this.activeRecord?.walletId === this.walletId
        ? this.activeRecord
        : await this.cache.latestForWallet(this.walletId);
    const pubkey = selectedRecord?.publicKey ?? '';
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
    const redirect = iosNativeRedirectForWallet(walletId, this.callbackScheme, 'connect', requestId, this.appUrl);
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
    const connectParams = {
      appUrl: this.appUrl,
      cluster: this.cluster,
      dappEncryptionPublicKey: dapp.publicKey,
      redirectLink: redirect,
    };
    const connectUrl = buildIosConnectUrl(walletId, connectParams);
    const connectUrlCandidates = buildIosConnectUrlCandidates(walletId, connectParams);
    const callbackPromise = this.waitForCallback('connect', requestId);
    this.log('connectDeepLink', 'URL_BUILT', 'info', 'opening wallet connect link', {
      requestId,
      wallet: walletId,
      appUrl: urlOriginShape(this.appUrl),
      walletUrl: urlShape(connectUrl),
      candidateCount: String(connectUrlCandidates.length),
      callback: urlShape(redirect),
    });
    await emitMobileWalletDebug(this.logLevel, {
      appUrl: this.appUrl,
      wallet: walletId,
      method: 'connect',
      step: 'url_built',
      requestId,
      strategy: iosNativeWalletLaunchStrategy(walletId),
      walletUrl: urlShape(connectUrl),
      callback: urlShape(redirect),
      candidateCount: String(connectUrlCandidates.length),
    });
    await openWalletUrls(connectUrlCandidates, this.logLevel, {
      appUrl: this.appUrl,
      wallet: walletId,
      method: 'connect',
      requestId,
    });
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

  private async connectJupiter(options: { forceNew?: boolean } = {}): Promise<IosAuthRecord> {
    await this.ensureCallbackSubscription();
    // In a debug session, allow the native logger to print raw payloads/signatures
    // (DEBUG builds already default this on; this also enables it for a Release
    // build running with logLevel='debug'). Best-effort, native-only.
    if (this.logLevel === 'debug' && safeIsNativePlatform()) {
      void AgenticSystem.setDebugLogging({ enabled: true }).catch(() => undefined);
    }
    const requestId = newSigningRequestId();
    const startedAt = Date.now();
    try {
      await emitMobileWalletDebug(this.logLevel, {
        appUrl: this.appUrl,
        wallet: 'jupiter',
        method: 'connect',
        step: 'wc_connect_start',
        requestId,
        strategy: 'walletconnect',
      });
      if (options.forceNew) {
        await emitMobileWalletDebug(this.logLevel, {
          appUrl: this.appUrl,
          wallet: 'jupiter',
          method: 'connect',
          step: 'wc_disconnect_start',
          requestId,
          strategy: 'walletconnect',
        });
        await callWalletConnect('wcDisconnect', () => AgenticWalletConnect.wcDisconnect(), this.logLevel).catch((err) => {
          void emitMobileWalletDebug(this.logLevel, {
            appUrl: this.appUrl,
            wallet: 'jupiter',
            method: 'connect',
            step: 'wc_disconnect_failed',
            requestId,
            strategy: 'walletconnect',
            message: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        });
      }
      const existing = options.forceNew
        ? null
        : await callWalletConnect('wcGetSession', () => AgenticWalletConnect.wcGetSession(), this.logLevel).catch(() => null);
      if (existing?.connected && existing.pubkey) {
        await emitMobileWalletDebug(this.logLevel, {
          appUrl: this.appUrl,
          wallet: 'jupiter',
          method: 'connect',
          step: 'wc_existing_session',
          requestId,
          strategy: 'walletconnect',
          pubkey: short(existing.pubkey),
          topic: short(existing.topic ?? ''),
        });
        return this.storeJupiterRecord(existing.pubkey, existing.topic);
      }
      this.log('connectJupiter', 'START', 'info', 'starting Jupiter WalletConnect session');
      const pairing = await callWalletConnect(
        'wcConnect',
        () => AgenticWalletConnect.wcConnect({ cluster: this.cluster, appUrl: this.appUrl }),
        this.logLevel,
      );
      await emitMobileWalletDebug(this.logLevel, {
        appUrl: this.appUrl,
        wallet: 'jupiter',
        method: 'connect',
        step: 'wc_pairing_created',
        requestId,
        strategy: 'walletconnect',
        walletUrl: walletConnectUriShape(pairing.uri),
        topic: short(pairing.topic ?? ''),
        pubkey: short(pairing.pubkey ?? ''),
      });
      if (pairing.pubkey) {
        return this.storeJupiterRecord(pairing.pubkey, pairing.topic);
      }
      if (!pairing.uri) {
        throw new ProtocolError('wallet_unreachable', 'Jupiter WalletConnect did not return a pairing URI.');
      }
      await emitMobileWalletDebug(this.logLevel, {
        appUrl: this.appUrl,
        wallet: 'jupiter',
        method: 'connect',
        step: 'wc_launch_start',
        requestId,
        strategy: 'walletconnect',
        walletUrl: walletConnectUriShape(pairing.uri),
      });
      const launch = await callWalletConnect(
        'wcLaunchWallet',
        () => AgenticWalletConnect.wcLaunchWallet({ uri: pairing.uri!, walletId: 'jupiter' }),
        this.logLevel,
      );
      await emitMobileWalletDebug(this.logLevel, {
        appUrl: this.appUrl,
        wallet: 'jupiter',
        method: 'connect',
        step: 'wc_launch_done',
        requestId,
        strategy: 'walletconnect',
        walletUrl: urlShape(launch.url ?? ''),
        code: launch.launched === false ? 'not_launched' : 'launched',
      });
      if (launch.launched === false) {
        throw new ProtocolError(
          'wallet_unreachable',
          'iOS could not open Jupiter for WalletConnect. Open Jupiter on this device and try connecting again.',
        );
      }
      await emitMobileWalletDebug(this.logLevel, {
        appUrl: this.appUrl,
        wallet: 'jupiter',
        method: 'connect',
        step: 'wc_wait_start',
        requestId,
        strategy: 'walletconnect',
        topic: short(pairing.topic ?? ''),
      });
      const session = await callWalletConnect(
        'wcWaitForSession',
        () => AgenticWalletConnect.wcWaitForSession({ timeoutMs: this.requestTtlMs }),
        this.logLevel,
      );
      if (!session.pubkey) {
        throw new ProtocolError('wallet_unreachable', 'Jupiter did not return a Solana account.');
      }
      await emitMobileWalletDebug(this.logLevel, {
        appUrl: this.appUrl,
        wallet: 'jupiter',
        method: 'connect',
        step: 'wc_session_approved',
        requestId,
        strategy: 'walletconnect',
        pubkey: short(session.pubkey),
        topic: short(session.topic ?? pairing.topic ?? ''),
      });
      this.scheduleWalletConnectReturnMissingDebug({ method: 'connect', requestId, startedAt });
      return this.storeJupiterRecord(session.pubkey, session.topic ?? pairing.topic);
    } catch (err) {
      const protocolErr = protocolErrorFromUnknown(err, 'Jupiter WalletConnect failed.');
      await emitMobileWalletDebug(this.logLevel, {
        appUrl: this.appUrl,
        wallet: 'jupiter',
        method: 'connect',
        step: 'wc_fail',
        requestId,
        strategy: 'walletconnect',
        code: protocolErr.code,
        message: protocolErr.message,
        ...walletConnectDiagnostics(protocolErr.message),
      });
      throw err;
    }
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
    const redirect = iosNativeRedirectForWallet(record.walletId, this.callbackScheme, 'sign', request.id, this.appUrl);
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
    const urlCandidates =
      request.kind === 'sign_message'
        ? buildIosSignMessageUrlCandidates({
            walletId: record.walletId,
            dappEncryptionPublicKey: dappPublicKey,
            redirectLink: redirect,
            payload,
            sharedSecret,
          })
        : buildIosSignTransactionUrlCandidates({
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
      candidateCount: String(urlCandidates.length),
      callback: urlShape(redirect),
    });
    await emitMobileWalletDebug(this.logLevel, {
      appUrl: this.appUrl,
      wallet: record.walletId,
      method: request.kind,
      step: 'url_built',
      requestId: request.id,
      strategy: iosNativeWalletLaunchStrategy(record.walletId),
      walletUrl: urlShape(url),
      callback: urlShape(redirect),
      candidateCount: String(urlCandidates.length),
    });
    await openWalletUrls(urlCandidates, this.logLevel, {
      appUrl: this.appUrl,
      wallet: record.walletId,
      method: request.kind,
      requestId: request.id,
    });
    const callbackUrl = await callbackPromise;
    const decoded = parseIosSigningCallback(callbackUrl, sharedSecret);
    await this.clearPendingRuntimeState();
    return this.resolveDeepLinkSigningResult(request, decoded);
  }

  private async signWithJupiter(
    request: SigningRequest,
    record: IosAuthRecord,
  ): Promise<{ signature: string; txid?: string }> {
    await this.ensureCallbackSubscription();
    const payload = decodeSigningPayload(request.payload.data, request.payload.encoding);
    const startedAt = Date.now();
    await emitMobileWalletDebug(this.logLevel, {
      appUrl: this.appUrl,
      wallet: 'jupiter',
      method: 'sign',
      step: 'wc_sign_start',
      requestId: request.id,
      strategy: 'walletconnect',
      kind: request.kind,
      pubkey: short(record.publicKey),
      topic: short(record.walletConnectTopic ?? ''),
    });
    try {
      switch (request.kind) {
        case 'sign_message': {
          const message = bs58.encode(payload);
          await this.emitJupiterRequestLaunchDebug(request, record);
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
          await this.emitJupiterSignResultDebug(request, result);
          if (!result.signature) {
            throw new ProtocolError('wallet_unreachable', 'Jupiter did not return a message signature.');
          }
          this.scheduleWalletConnectReturnMissingDebug({
            method: 'sign',
            requestId: request.id,
            startedAt,
            kind: request.kind,
          });
          return { signature: result.signature };
        }
        case 'sign_transaction': {
          const transactionBase64 = iosNativeWalletConnectTransactionParam(request.payload);
          await this.emitJupiterRequestLaunchDebug(request, record);
          const result = await callWalletConnect(
            'wcSignTransaction',
            () =>
              AgenticWalletConnect.wcSignTransaction({
                pubkey: record.publicKey,
                transaction: transactionBase64,
                timeoutMs: this.requestTtlMs,
                walletId: 'jupiter',
              }),
            this.logLevel,
          );
          await this.emitJupiterSignResultDebug(request, result);
          if (result.transaction) {
            const signedBytes =
              result.transactionEncoding === 'base64' ? decodeBase64(result.transaction) : bs58.decode(result.transaction);
            this.scheduleWalletConnectReturnMissingDebug({
              method: 'sign',
              requestId: request.id,
              startedAt,
              kind: request.kind,
            });
            return { signature: encodeBase64(signedBytes) };
          }
          if (result.signature) {
            this.scheduleWalletConnectReturnMissingDebug({
              method: 'sign',
              requestId: request.id,
              startedAt,
              kind: request.kind,
            });
            return {
              signature: encodeBase64(
                attachSolanaSignature(payload, record.publicKey, result.signature),
              ),
            };
          }
          throw new ProtocolError('wallet_unreachable', 'Jupiter did not return a signed transaction.');
        }
        case 'sign_and_send_transaction': {
          const transactionBase64 = iosNativeWalletConnectTransactionParam(request.payload);
          try {
            await this.emitJupiterRequestLaunchDebug(request, record);
            const result = await callWalletConnect(
              'wcSignAndSendTransaction',
              () =>
                AgenticWalletConnect.wcSignAndSendTransaction({
                  pubkey: record.publicKey,
                  transaction: transactionBase64,
                  timeoutMs: this.requestTtlMs,
                  walletId: 'jupiter',
                }),
              this.logLevel,
            );
            await this.emitJupiterSignResultDebug(request, result);
            const txid = result.txid ?? result.signature;
            if (!txid) {
              throw new ProtocolError('wallet_unreachable', 'Jupiter did not return a transaction id.');
            }
            this.scheduleWalletConnectReturnMissingDebug({
              method: 'sign',
              requestId: request.id,
              startedAt,
              kind: request.kind,
            });
            return { signature: txid, txid };
          } catch (err) {
            if (!isUnsupportedWalletConnectMethod(err)) {
              throw err;
            }
            await emitMobileWalletDebug(this.logLevel, {
              appUrl: this.appUrl,
              wallet: 'jupiter',
              method: 'sign',
              step: 'wc_sign_fallback',
              requestId: request.id,
              strategy: 'walletconnect',
              kind: request.kind,
              code: 'unsupported_method',
              message: err instanceof Error ? err.message : String(err),
            });
          }
          await this.emitJupiterRequestLaunchDebug(request, record);
          const signed = await callWalletConnect(
            'wcSignTransaction',
            () =>
              AgenticWalletConnect.wcSignTransaction({
                pubkey: record.publicKey,
                transaction: transactionBase64,
                timeoutMs: this.requestTtlMs,
                walletId: 'jupiter',
              }),
            this.logLevel,
          );
          await this.emitJupiterSignResultDebug(request, signed);
          const signedBytes = signed.transaction
            ? signed.transactionEncoding === 'base64'
              ? decodeBase64(signed.transaction)
              : bs58.decode(signed.transaction)
            : signed.signature
              ? attachSolanaSignature(payload, record.publicKey, signed.signature)
              : null;
          if (!signedBytes) {
            throw new ProtocolError('wallet_unreachable', 'Jupiter did not return a signed transaction.');
          }
          const txid = await this.connection.sendRawTransaction(signedBytes, {
            preflightCommitment: 'confirmed',
            maxRetries: 3,
          });
          await this.connection.confirmTransaction(txid, 'confirmed');
          await emitMobileWalletDebug(this.logLevel, {
            appUrl: this.appUrl,
            wallet: 'jupiter',
            method: 'sign',
            step: 'wc_sign_result',
            requestId: request.id,
            strategy: 'walletconnect',
            kind: request.kind,
            resultKeys: 'txid',
            code: 'fallback_sent',
            message: short(txid),
          });
          this.scheduleWalletConnectReturnMissingDebug({
            method: 'sign',
            requestId: request.id,
            startedAt,
            kind: request.kind,
          });
          return { signature: txid, txid };
        }
      }
    } catch (err) {
      const protocolErr = protocolErrorFromUnknown(err, 'Jupiter signing failed.');
      await emitMobileWalletDebug(this.logLevel, {
        appUrl: this.appUrl,
        wallet: 'jupiter',
        method: 'sign',
        step: 'wc_sign_fail',
        requestId: request.id,
        strategy: 'walletconnect',
        kind: request.kind,
        code: protocolErr.code,
        message: protocolErr.message,
      });
      throw err;
    }
  }

  private async emitJupiterRequestLaunchDebug(request: SigningRequest, record: IosAuthRecord): Promise<void> {
    // The native WalletConnect core foregrounds Jupiter for the request (peer
    // redirect → jupiter://) once the request is on the relay, and posts a
    // tappable return notification when the response arrives while backgrounded.
    await emitMobileWalletDebug(this.logLevel, {
      appUrl: this.appUrl,
      wallet: 'jupiter',
      method: 'sign',
      step: 'wc_request_launch_native',
      requestId: request.id,
      strategy: 'walletconnect',
      kind: request.kind,
      topic: short(record.walletConnectTopic ?? ''),
      pubkey: short(record.publicKey),
      code: 'jupiter_native_foreground',
      message: 'Native bridge foregrounds Jupiter and notifies on return.',
    });
  }

  private async emitJupiterSignResultDebug(request: SigningRequest, result: object): Promise<void> {
    const response = result as { signature?: unknown; transaction?: unknown; txid?: unknown };
    await emitMobileWalletDebug(this.logLevel, {
      appUrl: this.appUrl,
      wallet: 'jupiter',
      method: 'sign',
      step: 'wc_sign_result',
      requestId: request.id,
      strategy: 'walletconnect',
      kind: request.kind,
      resultKeys: Object.keys(result).sort().join(',') || 'none',
      code: response.txid ? 'txid' : response.transaction ? 'transaction' : response.signature ? 'signature' : 'empty',
    });
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
    if (iosNativeIsWalletConnectReturnUrl(url.toString())) {
      this.lastWalletConnectReturnAt = Date.now();
      this.log('handleIncomingUrl', 'DONE', 'info', 'WalletConnect return callback received', {
        callback: urlShape(url.toString()),
      });
      void emitMobileWalletDebug(this.logLevel, {
        appUrl: this.appUrl,
        wallet: this.walletId,
        method: 'walletconnect',
        step: 'wc_return_callback_received',
        strategy: 'walletconnect',
        callback: urlShape(url.toString()),
      });
      return;
    }
    const phase = callbackPhase(url);
    if (!phase) {
      return;
    }
    const requestId = url.searchParams.get('requestId');
    const match = iosNativeResolveCallbackWaiterKey(this.waiters.keys(), phase, requestId);
    if (match.status !== 'match' || !match.key || !match.requestId) {
      this.log('handleIncomingUrl', 'FAIL', 'error', 'callback did not match an active waiter', {
        callback: urlShape(url.toString()),
        matchStatus: match.status,
        matchKind: match.matchKind,
        phase,
      });
      void emitMobileWalletDebug(this.logLevel, {
        appUrl: this.appUrl,
        wallet: this.walletId,
        method: phase,
        step: 'callback_unmatched',
        callback: urlShape(url.toString()),
        code: match.status,
      });
      return;
    }
    const waiter = this.waiters.get(match.key);
    this.log('handleIncomingUrl', waiter ? 'MATCH' : 'ORPHAN', 'info', 'iOS callback received', {
      phase,
      requestId: match.requestId,
      matchKind: match.matchKind,
      callback: urlShape(url.toString()),
    });
    void emitMobileWalletDebug(this.logLevel, {
      appUrl: this.appUrl,
      wallet: this.walletId,
      method: phase,
      step: waiter ? 'callback_match' : 'callback_orphan',
      requestId: match.requestId,
      callback: urlShape(url.toString()),
      matchKind: match.matchKind,
    });
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    this.waiters.delete(match.key);
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

  private scheduleWalletConnectReturnMissingDebug(input: {
    method: 'connect' | 'sign';
    requestId: string;
    startedAt: number;
    kind?: SigningRequest['kind'];
  }): void {
    if (typeof window === 'undefined') {
      return;
    }
    window.setTimeout(() => {
      if (this.lastWalletConnectReturnAt >= input.startedAt) {
        return;
      }
      void emitMobileWalletDebug(this.logLevel, {
        appUrl: this.appUrl,
        wallet: 'jupiter',
        method: input.method,
        step: 'wc_return_missing_timeout',
        requestId: input.requestId,
        strategy: 'walletconnect',
        ...(input.kind ? { kind: input.kind } : {}),
      });
    }, 1800);
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

function httpsOrigin(value: string | boolean | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function envValue(
  viteEnv: Record<string, string | boolean | undefined> | undefined,
  key: string,
): string | boolean | undefined {
  const viteValue = viteEnv?.[key];
  if (viteValue !== undefined) {
    return viteValue;
  }
  return (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env?.[key];
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

export function iosNativeIsWalletConnectReturnUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl.replace(/#$/, ''));
  } catch {
    return false;
  }
  const isNativeCallback =
    url.protocol === 'agenticwallet:';
  const isUniversalCallback =
    url.protocol === 'https:' &&
    url.pathname.endsWith('/ios/callback/walletconnect');
  if (!isNativeCallback && !isUniversalCallback) {
    return false;
  }
  if (isNativeCallback && !url.hostname && !url.pathname) {
    return true;
  }
  return (
    (url.hostname === 'callback' && url.pathname.endsWith('/walletconnect')) ||
    url.searchParams.get('phase') === 'walletconnect' ||
    isUniversalCallback
  );
}

export function iosNativeWalletLaunchStrategy(walletId: IosNativeWalletId): IosNativeWalletLaunchStrategy {
  return walletId === 'backpack' ? 'webview-location' : 'native-open';
}

export function iosNativeRedirectForWallet(
  walletId: IosNativeWalletId,
  callbackScheme: string,
  phase: 'connect' | 'sign',
  requestId: string,
  appUrl = DEFAULT_IOS_APP_URL,
): string {
  if (walletId !== 'backpack') {
    return makeIosRedirect(callbackScheme, phase, requestId);
  }
  return new URL(`/ios/callback/${phase}`, iosNativeAssociatedDomainOrigin(appUrl)).toString();
}

function iosNativeAssociatedDomainOrigin(appUrl: string): string {
  try {
    const url = new URL(appUrl);
    if (url.protocol === 'https:' && url.hostname === 'agentic-signer.com') {
      return url.origin;
    }
  } catch {
    // Fall through to the production associated domain.
  }
  return DEFAULT_IOS_APP_URL;
}

export function iosNativeResolveCallbackWaiterKey(
  waiterKeys: Iterable<string>,
  phase: 'connect' | 'sign',
  requestId: string | null,
): IosNativeCallbackWaiterMatch {
  if (requestId) {
    return {
      status: 'match',
      key: waiterKey(phase, requestId),
      requestId,
      matchKind: 'explicit',
    };
  }
  const prefix = `${phase}:`;
  const matches = [...waiterKeys].filter((key) => key.startsWith(prefix));
  if (matches.length === 0) {
    return { status: 'no_match', matchKind: 'active' };
  }
  if (matches.length > 1) {
    return { status: 'ambiguous', matchKind: 'active' };
  }
  const key = matches[0]!;
  return {
    status: 'match',
    key,
    requestId: key.slice(prefix.length),
    matchKind: 'active',
  };
}

function waiterKey(phase: 'connect' | 'sign', requestId: string): string {
  return `${phase}:${requestId}`;
}

interface WalletUrlOpenContext {
  appUrl: string;
  wallet: string;
  method: string;
  requestId: string;
}

interface MobileWalletDebugEvent {
  appUrl: string;
  wallet: string;
  method: string;
  step: string;
  requestId?: string;
  strategy?: string;
  walletUrl?: string;
  callback?: string;
  candidateCount?: string;
  candidateIndex?: string;
  matchKind?: string;
  topic?: string;
  pubkey?: string;
  kind?: string;
  resultKeys?: string;
  relayHost?: string;
  originHost?: string;
  projectIdPrefix?: string;
  socketStatus?: string;
  code?: string;
  message?: string;
}

async function openWalletUrls(
  urls: readonly string[],
  logLevel: IosNativeLogLevel,
  context?: WalletUrlOpenContext,
): Promise<void> {
  if (urls.length === 0) {
    throw new ProtocolError('wallet_unreachable', 'No iOS wallet URL was available.');
  }
  const strategy = context ? iosNativeWalletLaunchStrategy(context.wallet as IosNativeWalletId) : 'native-open';
  if (safeIsNativePlatform() && strategy === 'native-open') {
    for (const [index, url] of urls.entries()) {
      const metadata = {
        ...contextMetadata(context),
        walletUrl: urlShape(url),
        candidateIndex: String(index + 1),
        candidateCount: String(urls.length),
        strategy,
      };
      try {
        await emitMobileWalletDebug(logLevel, {
          ...(context ?? { appUrl: DEFAULT_IOS_APP_URL, wallet: '', method: 'unknown', requestId: '' }),
          step: 'native_open_start',
          strategy,
          walletUrl: urlShape(url),
          candidateIndex: String(index + 1),
          candidateCount: String(urls.length),
        });
        const result = await AgenticSystem.openExternal({ url });
        if (result.ok) {
          iosLog(logLevel, 'AgenticSystem', 'openWalletUrls', 'DONE', 'info', 'wallet URL opened', metadata);
          await emitMobileWalletDebug(logLevel, {
            ...(context ?? { appUrl: DEFAULT_IOS_APP_URL, wallet: '', method: 'unknown', requestId: '' }),
            step: 'native_open_done',
            strategy,
            walletUrl: urlShape(url),
            candidateIndex: String(index + 1),
            candidateCount: String(urls.length),
          });
          return;
        }
        iosLog(logLevel, 'AgenticSystem', 'openWalletUrls', 'FALLBACK', 'info', 'native open declined wallet URL', metadata);
        await emitMobileWalletDebug(logLevel, {
          ...(context ?? { appUrl: DEFAULT_IOS_APP_URL, wallet: '', method: 'unknown', requestId: '' }),
          step: 'native_open_declined',
          strategy,
          walletUrl: urlShape(url),
          candidateIndex: String(index + 1),
          candidateCount: String(urls.length),
          code: 'declined',
        });
      } catch (err) {
        iosLog(logLevel, 'AgenticSystem', 'openWalletUrls', 'FALLBACK', 'debug', 'native open failed', {
          ...metadata,
          message: err instanceof Error ? err.message : String(err),
        });
        await emitMobileWalletDebug(logLevel, {
          ...(context ?? { appUrl: DEFAULT_IOS_APP_URL, wallet: '', method: 'unknown', requestId: '' }),
          step: 'native_open_failed',
          strategy,
          walletUrl: urlShape(url),
          candidateIndex: String(index + 1),
          candidateCount: String(urls.length),
          code: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  const url = urls.find((candidate) => candidate.startsWith('https://')) ?? urls[0]!;
  iosLog(logLevel, 'AgenticSystem', 'openWalletUrls', 'WINDOW_LOCATION', 'info', 'opening wallet URL through WebView location', {
    ...contextMetadata(context),
    walletUrl: urlShape(url),
    candidateCount: String(urls.length),
    strategy: 'webview-location',
  });
  await emitMobileWalletDebug(logLevel, {
    ...(context ?? { appUrl: DEFAULT_IOS_APP_URL, wallet: '', method: 'unknown', requestId: '' }),
    step: 'webview_location',
    strategy: 'webview-location',
    walletUrl: urlShape(url),
    candidateCount: String(urls.length),
  });
  if (typeof window.location.assign === 'function') {
    window.location.assign(url);
  } else {
    window.location.href = url;
  }
}

export async function iosNativeOpenExternalUrl(url: string): Promise<boolean> {
  if (safeIsNativePlatform()) {
    try {
      const result = await AgenticSystem.openExternal({ url });
      if (result.ok) return true;
    } catch {
      // Fall through to WebView navigation for non-native test surfaces.
    }
  }
  if (typeof window === 'undefined') return false;
  if (typeof window.location.assign === 'function') {
    window.location.assign(url);
  } else {
    window.location.href = url;
  }
  return true;
}

export type IosNativeNotificationAuthStatus =
  | 'authorized'
  | 'provisional'
  | 'ephemeral'
  | 'denied'
  | 'unknown';

/**
 * Request notification permission at a deliberate moment (e.g. right after
 * connecting Jupiter) so the native WalletConnect layer can later post a
 * tappable "approval complete" notification that brings the user back from
 * Jupiter on iOS 17+/18, where silent app-to-app redirects are blocked.
 * Returns the resolved status; never throws.
 */
export async function iosNativeEnsureReturnNotificationPermission(): Promise<IosNativeNotificationAuthStatus> {
  if (!safeIsNativePlatform()) return 'unknown';
  try {
    const result = await AgenticSystem.requestNotificationAuthorization();
    return result?.status ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Whether a resolved status lets us post return notifications. */
export function iosNativeNotificationStatusCanNotify(status: IosNativeNotificationAuthStatus): boolean {
  return status === 'authorized' || status === 'provisional' || status === 'ephemeral';
}

/**
 * Force-re-open Jupiter for a pending connect/sign. Backs the manual "Open
 * Jupiter again" button: Jupiter cold-starts unreliably and sometimes drops our
 * deep link to jup.ag, so the native side retains the in-flight launch and
 * re-fires it on demand. Best-effort, native-only, never throws.
 */
export async function iosNativeReForegroundJupiter(): Promise<boolean> {
  if (!safeIsNativePlatform()) return false;
  try {
    const result = await AgenticWalletConnect.wcReForeground();
    return result?.ok === true;
  } catch {
    return false;
  }
}

function contextMetadata(context: WalletUrlOpenContext | undefined): Record<string, string> {
  if (!context) return {};
  return {
    wallet: context.wallet,
    method: context.method,
    requestId: context.requestId,
  };
}

// Forward a mobile-wallet-debug event into the NATIVE syslog (via AgenticSystem.devLog
// → AgenticIOSLog → NSLog) so the JS connect/sign steps appear in the same
// `idevicesyslog | grep "[AgentIOSApp]"` terminal stream as the native logs. JS
// console output never reaches the device syslog, so this bridge is what makes a
// single unified terminal trace possible. Best-effort, native-only, fire-and-forget.
function forwardNativeDevLog(event: MobileWalletDebugEvent): void {
  if (!safeIsNativePlatform()) return;
  try {
    const metadata = mobileWalletDebugPayload(event);
    const level: 'info' | 'fail' =
      /fail|error|reject|timeout|missing/i.test(event.step) || event.code === 'error' ? 'fail' : 'info';
    void AgenticSystem.devLog({
      component: `JS:${event.wallet}`,
      method: event.method,
      step: event.step,
      level,
      message: event.message ?? '',
      metadata,
    }).catch(() => undefined);
  } catch {
    // never let logging break the flow
  }
}

async function emitMobileWalletDebug(logLevel: IosNativeLogLevel, event: MobileWalletDebugEvent): Promise<void> {
  if (!MOBILE_WALLET_DEBUG_WALLETS.has(event.wallet)) {
    return;
  }
  forwardNativeDevLog(event);
  try {
    const endpoint = new URL('/api/mobile-wallet-debug', event.appUrl).toString();
    const payload = mobileWalletDebugPayload(event);
    await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentic-client': 'ios-bundled',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    }, MOBILE_WALLET_DEBUG_TIMEOUT_MS);
  } catch (err) {
    iosLog(logLevel, 'MobileWalletDebug', 'emit', 'SKIP', 'debug', 'debug telemetry failed', {
      wallet: event.wallet,
      step: event.step,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function mobileWalletDebugPayload(event: MobileWalletDebugEvent): Record<string, string> {
  return {
    wallet: event.wallet,
    method: event.method,
    step: event.step,
    ...(event.requestId ? { requestId: event.requestId } : {}),
    ...(event.strategy ? { strategy: event.strategy } : {}),
    ...(event.walletUrl ? { walletUrl: event.walletUrl } : {}),
    ...(event.callback ? { callback: event.callback } : {}),
    ...(event.candidateCount ? { candidateCount: event.candidateCount } : {}),
    ...(event.candidateIndex ? { candidateIndex: event.candidateIndex } : {}),
    ...(event.matchKind ? { matchKind: event.matchKind } : {}),
    ...(event.topic ? { topic: event.topic } : {}),
    ...(event.pubkey ? { pubkey: event.pubkey } : {}),
    ...(event.kind ? { kind: event.kind } : {}),
    ...(event.resultKeys ? { resultKeys: event.resultKeys } : {}),
    ...(event.relayHost ? { relayHost: event.relayHost } : {}),
    ...(event.originHost ? { originHost: event.originHost } : {}),
    ...(event.projectIdPrefix ? { projectIdPrefix: event.projectIdPrefix } : {}),
    ...(event.socketStatus ? { socketStatus: event.socketStatus } : {}),
    ...(event.code ? { code: event.code } : {}),
    ...(event.message ? { message: event.message } : {}),
  };
}

function walletConnectDiagnostics(message: string): Partial<MobileWalletDebugEvent> {
  const relayHost = diagnosticValue(message, 'relayHost');
  const originHost = diagnosticValue(message, 'originHost');
  const projectIdPrefix = diagnosticValue(message, 'projectIdPrefix');
  const socketStatus = diagnosticValue(message, 'socketStatus');
  return {
    ...(relayHost ? { relayHost } : {}),
    ...(originHost ? { originHost } : {}),
    ...(projectIdPrefix ? { projectIdPrefix } : {}),
    ...(socketStatus ? { socketStatus } : {}),
  };
}

function diagnosticValue(message: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\|\\s*)${escaped}=([^|]+)`).exec(message);
  const value = match?.[1]?.trim();
  return value || undefined;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<void> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller
    ? globalThis.setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  try {
    const response = await fetch(url, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`debug telemetry HTTP ${response.status}`);
    }
  } finally {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  }
}

function decodeSigningPayload(data: string, encoding: 'utf8' | 'base64'): Uint8Array {
  return encoding === 'utf8' ? encodeUtf8(data) : decodeBase64(data);
}

export function iosNativeWalletConnectTransactionParam(payload: SigningRequest['payload']): string {
  return encodeBase64(decodeSigningPayload(payload.data, payload.encoding));
}

export function attachSolanaSignature(transactionBytes: Uint8Array, signerAddress: string, signatureBase58: string): Uint8Array {
  const signer = new PublicKey(signerAddress);
  const signature = bs58.decode(signatureBase58);
  if (signature.length !== 64) {
    throw new ProtocolError('wallet_unreachable', 'WalletConnect returned a malformed Solana signature.');
  }

  try {
    const legacy = Transaction.from(transactionBytes);
    legacy.addSignature(signer, signature as unknown as Buffer);
    return new Uint8Array(legacy.serialize({ requireAllSignatures: false, verifySignatures: false }));
  } catch {
    const versioned = VersionedTransaction.deserialize(transactionBytes);
    const message = versioned.message as {
      header: { numRequiredSignatures: number };
      staticAccountKeys?: PublicKey[];
      accountKeys?: PublicKey[];
    };
    const accountKeys = message.staticAccountKeys ?? message.accountKeys ?? [];
    const signerIndex = accountKeys.findIndex((key) => key.equals(signer));
    if (
      signerIndex < 0 ||
      signerIndex >= message.header.numRequiredSignatures ||
      signerIndex >= versioned.signatures.length
    ) {
      throw new ProtocolError('wallet_unreachable', 'WalletConnect signature did not match a required transaction signer.');
    }
    versioned.signatures[signerIndex] = signature;
    return versioned.serialize();
  }
}

function isUnsupportedWalletConnectMethod(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes('unsupported') ||
    lower.includes('not supported') ||
    lower.includes('method not found') ||
    lower.includes('wc_rpc_-32601')
  );
}

function isUsableRecord(record: IosAuthRecord): boolean {
  if (record.authenticated === false || !record.publicKey || !record.walletId) {
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

function urlOriginShape(value: string): string {
  try {
    const url = new URL(value);
    return `scheme=${url.protocol.replace(':', '')} host=${url.host} path=${url.pathname}`;
  } catch {
    return 'invalid_url';
  }
}

function walletConnectUriShape(value: string | undefined): string {
  if (!value) return 'none';
  if (value.startsWith('wc:')) {
    const topic = value.slice(3).split('@')[0] ?? '';
    const query = value.includes('?') ? value.slice(value.indexOf('?') + 1) : '';
    const keys = query
      ? [...new URLSearchParams(query).keys()].sort().join(',')
      : '';
    return `scheme=wc topic=${short(topic, 6, 4)} query_keys=${keys}`;
  }
  return urlShape(value);
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
