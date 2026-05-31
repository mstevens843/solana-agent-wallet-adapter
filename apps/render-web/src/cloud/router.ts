import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createPairingHandler } from './pairingHandler.js';

import {
  AgentWalletActionService,
  BridgeAiPlanner,
  DEFAULT_CONFIG,
  getTransfersByAddress,
  listCoinGeckoEndpointCatalog,
  requestBirdeyeExitLiquidityMulti,
  requestBirdeyeHistoryPrice,
  requestBirdeyeNewListings,
  requestBirdeyeOhlcv,
  requestBirdeyePriceMulti,
  requestBirdeyePriceVolumeMulti,
  requestBirdeyePriceVolumeSingle,
  requestBirdeyeSearch,
  requestBirdeyeTokenCreationInfo,
  requestBirdeyeTokenHolders,
  requestBirdeyeTokenListV3,
  requestBirdeyeTokenMetadata,
  requestBirdeyeTokenSecurity,
  requestBirdeyeTrendingTokens,
  requestBirdeyeWalletTokenList,
  requestCoinGeckoEndpoint,
  requestCoinGeckoGlobal,
  requestCoinGeckoSolanaTokenEvidence,
  type AiApiFormat,
  type AiAskRequest,
  type AiChatRequest,
  type AiPlanRequest,
  type AiReviewRequest,
  type BirdeyeHistoryPriceType,
  type BirdeyeOhlcvType,
  type BirdeyePriceVolumeType,
  type BirdeyeTokenListSortBy,
  type HeliusTransferFilters,
} from '@solana-agent-wallet-adapter/mcp-server';
import { Connection, PublicKey } from '@solana/web3.js';

import { getAndroidRemoteConfig } from './androidConfig.js';
import { getIosRemoteConfig } from './iosConfig.js';
import { handlePolicyEnrich } from './policyEnrich.js';
import {
  AuthValidationError,
  buildAgentProfilePublishMessage,
  buildAgentProfileTakedownMessage,
  buildCloudWorkspaceDeleteMessage,
  buildWalletLoginMessage,
  createAgentProfilePublishIntentResponse,
  createAgentProfileTakedownIntentResponse,
  createAuthNonceResponse,
  createCloudWorkspaceDeleteIntentResponse,
  normalizeWalletAddress,
  parseVerifyWalletRequest,
  verifyWalletSignature,
} from './auth.js';
import {
  hashProfilePayload,
  validateProfilePayload,
  type AgentPaymentProfilePayload,
} from '@solana-agent-wallet-adapter/a2a-agent-card';
import { isSecureRequest, serializeClearSessionCookie, serializeSessionCookie } from './cookies.js';
// Side-effect import: each Phase-1 dev-API route module self-registers on load.
import './devApiHandlers.js';
import { listDevApiHandlers, type DevApiHandlerContext } from './devApiRegistry.js';
import { deviceAgentFeatureEnabled, deviceAgentRuntimeAvailability, devLayer1Enabled, isAllowedDeviceAgentWallet, isAllowedDevWallet } from './devGate.js';
import { createEvidenceApiHandler, evidenceStoreAdapterForCloudStore } from './evidenceRoutes.js';
import type { EvidenceStore } from './evidenceService.js';
import { MemoryWorkflowStore } from './memoryStore.js';
import { isRecurringNotificationStore, RecurringNotificationService } from './notificationService.js';
import {
  createRecurringApprovalSink,
  createRecurringApprovalStatusReader,
  createRecurringOccurrenceHistoryHydrator,
} from './recurringApprovalSink.js';
import {
  createRecurringPolicyEnforcer,
  loadRecurringPolicyFromEnv,
  type RecurringPolicyConfig,
} from './recurringPolicy.js';
import { createRecurringApiHandler, recurringStoreAdapterForCloudStore } from './recurringRoutes.js';
import { RecurringService, type RecurringStore } from './recurringService.js';
import { redactSecrets } from './redaction.js';
import { resolveReleaseDownloads } from './releaseDownloads.js';
import { createAgentBackgroundWatch } from './agentBackgroundWatch.js';
import {
  createStatelessConnectorFactsReader,
  solanaRpcUrl,
  type ConnectorReadFactsRequest,
  type StatelessConnectorFactsReader,
} from './connectorFactsReader.js';
import { RecurringScheduler } from './scheduler.js';
import { createWalletSession, deleteSessionFromRequest, SESSION_TTL_MS, sessionFromRequest } from './session.js';
import {
  CLOUD_PREFERENCE_NAMESPACES,
  sessionResponse,
  systemClock,
  type CloudPreferenceNamespace,
  type CloudPreferenceRecord,
  type CloudPreferencesStore,
  type CloudWorkspaceDeleteCounts,
  type CloudWorkspaceDeleteStore,
  type Clock,
  type WorkflowStore,
} from './store.js';
import { WorkflowService, type WorkflowStore as OneTimeWorkflowStore } from './workflowService.js';
import {
  AdapterError,
  createDefaultConnectorPreparer,
  createStatelessConnectorPreparer,
  type ConnectorSecretsLoader,
  type ConnectorTransactionPreparer,
  type StatelessConnectorTransactionPreparer,
} from './prepareConnectorTransaction.js';
import {
  ConnectorSecretsError,
  createConnectorSecretsService,
  emptyConnectorSecretsSummary,
  isByoKeyConnectorId,
  resolveConnectorSecretsKek,
  type ByoKeyConnectorId,
  type ConnectorSecretsService,
} from './connectorSecrets.js';
import { createWorkflowApiHandler } from './workflowRoutes.js';
import {
  buildKaminoSdkClient,
  buildDriftVaultClient,
  buildSaveSdkClient,
  buildWormholeSdkClient,
  isDriftVaultConfigured,
  isKaminoConfigured,
  isSaveConfigured,
  isWormholeConfigured,
  setDriftVaultClientFactory,
  setKaminoClientFactory,
  setSaveClientFactory,
  setWormholeClientFactory,
} from '@solana-agent-wallet-adapter/mcp-server';

// Cap raised from 64 KB → 1 MB to accommodate AI workflow payloads (review +
// ask routes), which legitimately bundle plan + policyBundle.evaluations +
// context.evidenceFacts + context.researchEvidence + sources. The Helium-style
// prompt with web-search grounding routinely lands at 80-200 KB; 64 KB was
// causing intermittent 413 "Request body is too large" on production. 1 MB
// stays well below Render's default nginx body cap.
const MAX_JSON_BYTES = 1024 * 1024;
// Preference payloads (user settings, agent-policy lists, connector keys) stay
// modest — 64 KB is generous for any single preference key and protects against
// a misconfigured client trying to stash an entire database in preferences.
const MAX_PREFERENCE_JSON_BYTES = 64 * 1024;
const AUTH_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 60;
const WRITE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const WRITE_RATE_LIMIT_MAX_ATTEMPTS = 180;
const HOSTED_AI_RATE_LIMIT_MAX_ATTEMPTS = 30;
// Hard ceiling for upstream LLM round-trip latency. Anthropic/OpenAI streaming
// completions routinely run 20-30s on long prompts; 45s gives headroom while
// preventing hung-request pileup on Render's HTTP connection pool during an
// upstream incident. The rate limiter alone wouldn't help here — hung sockets
// still hold their slot. Raised by [handleHostedAi*] handlers via
// [runWithHostedAiTimeout]. Emits 504 on timeout.
const HOSTED_AI_TIMEOUT_MS = 45_000;
const DEFAULT_ANDROID_CLOUD_ORIGIN = 'https://agentic.local';
const DEFAULT_IOS_CLOUD_ORIGIN = 'capacitor://localhost';
// Tauri 2 webview origins. macOS / Linux use the `tauri://localhost` custom
// scheme; Windows (WebView2) uses `http://tauri.localhost`. `https://tauri.localhost`
// covers the Tauri 2 builds that opt into the secure variant and matches the
// `connect-src` entry in apps/desktop-shell/src-tauri/tauri.conf.json.
const DEFAULT_DESKTOP_CLOUD_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
];
// Vite dev server bound by apps/browser-demo/vite.config.ts (port 5174). Only
// included outside production so the live Render API does not trust an
// arbitrary local server on the same port.
const DEFAULT_DESKTOP_DEV_CLOUD_ORIGINS = [
  'http://127.0.0.1:5174',
  'http://localhost:5174',
];
const CORS_ALLOWED_HEADERS = 'authorization, content-type, x-agentic-client';
const CORS_ALLOWED_METHODS = 'GET, POST, PATCH, PUT, DELETE, OPTIONS';
const APPLE_APP_SITE_ASSOCIATION_PATH = '/.well-known/apple-app-site-association';
const DEFAULT_IOS_BUNDLE_ID = 'com.agentic.wallet';
const IOS_UNIVERSAL_LINK_PATHS = [
  '/app',
  '/app/*',
  '/connect',
  '/connect/*',
  '/approve',
  '/approve/*',
  '/sign',
  '/sign/*',
  '/ios/callback',
  '/ios/callback/*',
  '/ios/approval',
  '/ios/approval/*',
  '/sign-in',
  '/sign-in/*',
  '/agentic-login',
  '/agentic-login/*',
] as const;

type RenderDeviceAgentState = 'stopped' | 'running';

interface RenderDeviceAgentSession {
  configured: boolean;
  state: RenderDeviceAgentState;
  provider?: string;
  apiFormat?: string;
  baseUrl?: string;
  model?: string;
  updatedAt: string;
}

const renderDeviceAgentSessions = new Map<string, RenderDeviceAgentSession>();

const REGISTERED_API_ROUTES = [
  'GET /api/ai/status',
  'GET /api/releases/downloads',
  'GET /api/android-config',
  'GET /api/mobile-config',
  'POST /api/policy/enrich',
  'POST /api/ai/generate-plan',
  'POST /api/ai/review-plan',
  'POST /api/ai/ask-about-plan',
  'POST /api/ai/chat',
  'GET /api/device-agent/status',
  'POST /api/device-agent/control',
  'POST /api/auth/nonce',
  'POST /api/auth/verify-wallet',
  'POST /api/auth/logout',
  'POST /api/cloud-workspace/delete-intent',
  'POST /api/cloud-workspace/delete',
  'POST /api/agents/profile-intent',
  'PUT /api/agents/profile',
  'DELETE /api/agents/profile',
  'GET /api/session',
  'GET /api/audit',
  '/api/plans',
  '/api/approvals',
  'POST /api/approvals/cleanup-recurring-backlog',
  'POST /api/approvals/:id/wallet-execution',
  'POST /api/approvals/:id/prepare-transaction',
  'POST /api/approvals/:id/finalization/prepare',
  'POST /api/approvals/:id/finalization/:finalizationId/submit',
  'POST /api/approvals/:id/finalization/:finalizationId/confirm',
  'POST /api/approvals/:id/finalization/:finalizationId/fail',
  'GET /api/approvals/:id/finalization',
  '/api/completed',
  '/api/recurring',
  'GET /api/recurring/:id/occurrences',
  'GET /api/recurring/:id/notifications',
  'POST /api/recurring/:id/notifications/rotate',
  'POST /api/recurring/:id/pause',
  'POST /api/recurring/:id/resume',
  '/api/evidence',
  'POST /api/solana/latest-blockhash',
  'POST /api/solana/send-transaction',
  'POST /api/solana/signature-status',
  'POST /api/solana/parsed-account-info',
  'POST /api/solana/wallet-balance-summary',
  'POST /api/swap/order',
  'POST /api/swap/execute',
  'POST /api/connector/prepare-transaction',
  'POST /api/connector/read-facts',
  'GET /api/spend/envelopes',
  'POST /api/birdeye/price-multi',
  'POST /api/birdeye/price-volume',
  'POST /api/birdeye/history-price',
  'POST /api/birdeye/ohlcv',
  'POST /api/birdeye/search',
  'POST /api/birdeye/token-meta',
  'POST /api/birdeye/token-security',
  'POST /api/birdeye/token-holders',
  'POST /api/birdeye/token-creation-info',
  'POST /api/birdeye/exit-liquidity-multi',
  'POST /api/birdeye/trending',
  'POST /api/birdeye/new-listings',
  'POST /api/birdeye/token-list-v3',
  'POST /api/birdeye/wallet-token-list',
  'POST /api/helius/transfers-by-address',
  'GET /api/coingecko/endpoints',
  'GET /api/coingecko/global',
  'POST /api/coingecko/read',
  'POST /api/coingecko/token-evidence',
] as const;

type HostedProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter';

interface HostedProviderPreset {
  id: HostedProviderId;
  label: string;
  apiFormat: AiApiFormat;
  baseUrl: string;
  defaultModel: string;
}

interface HostedAiBody {
  settings?: {
    apiKey?: unknown;
    provider?: unknown;
    model?: unknown;
    mode?: unknown;
  };
  request?: unknown;
}

interface HostedAiReviewBody {
  settings?: HostedAiBody['settings'];
  request?: unknown;
}

interface HostedAiAskBody {
  settings?: HostedAiBody['settings'];
  request?: unknown;
}

interface HostedAiChatBody {
  settings?: HostedAiBody['settings'];
  request?: unknown;
}

interface HostedAiResolvedSettings {
  apiKey: string;
  provider: string;
  apiFormat: AiApiFormat;
  baseUrl: string;
  model: string;
  mode: 'hosted-byok' | 'hosted-managed';
}

export interface CloudApiRouterOptions {
  store?: WorkflowStore;
  clock?: Clock;
  authRateLimiter?: AuthRateLimiter | false;
  recurringPolicy?: RecurringPolicyConfig;
  /**
   * Test-only override: replace the adapter-backed transaction preparer used by
   * `POST /api/approvals/:id/prepare-transaction`. Production code constructs the default
   * preparer via `createDefaultConnectorPreparer()` in `prepareConnectorTransaction.ts`.
   */
  connectorPreparer?: ConnectorTransactionPreparer;
  /**
   * Test-only override: replace the stateless preparer used by
   * `POST /api/connector/prepare-transaction`. Production constructs the default via
   * `createStatelessConnectorPreparer()` in `prepareConnectorTransaction.ts`.
   */
  statelessConnectorPreparer?: StatelessConnectorTransactionPreparer;
  /**
   * Test-only override: replace the stateless connector fact reader used by
   * `POST /api/connector/read-facts`. Production constructs a read-only action service.
   */
  statelessConnectorReader?: StatelessConnectorFactsReader;
}

export interface CloudApiRouter {
  readonly store: WorkflowStore;
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

export interface AuthRateLimitInput {
  key: string;
  route: string;
  now: Date;
}

export interface AuthRateLimiter {
  allow(input: AuthRateLimitInput): boolean | Promise<boolean>;
}

export class MemoryAuthRateLimiter implements AuthRateLimiter {
  private readonly buckets = new Map<string, { windowStart: number; count: number; windowMs: number }>();
  // Sweep cadence: ~1/minute under load (cheap walk + delete). Tied to the
  // longest rate-limit window (5 min) so an idle key gets removed within ~2
  // windows of inactivity. Without this, the map grows monotonically per
  // unique route:clientIp pair — a memory leak under botnet / X-F-F-spoof
  // pressure (cardinality = unique-IP × unique-route).
  private lastSweepMs = 0;
  private static readonly SWEEP_INTERVAL_MS = 60_000;

  allow(input: AuthRateLimitInput): boolean {
    const bucketKey = `${input.route}:${input.key}`;
    const now = input.now.getTime();
    const windowMs = rateLimitWindowMs(input.route);
    const maxAttempts = rateLimitMaxAttempts(input.route);
    this.maybeSweep(now);
    const bucket = this.buckets.get(bucketKey);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      this.buckets.set(bucketKey, { windowStart: now, count: 1, windowMs });
      return true;
    }
    if (bucket.count >= maxAttempts) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweepMs < MemoryAuthRateLimiter.SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = now;
    for (const [key, bucket] of this.buckets) {
      // Delete buckets whose window has expired with no new traffic. Using
      // 2× as the cutoff means we keep an entry for one full window past
      // last touch so legitimate slow callers don't lose their count if a
      // sweep happens to land between their requests.
      if (now - bucket.windowStart >= 2 * bucket.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}

const HOSTED_PROVIDER_PRESETS: Record<HostedProviderId, HostedProviderPreset> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    apiFormat: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Claude / Anthropic',
    apiFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    apiFormat: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    apiFormat: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
  },
};

// Wire connector SDK clients once per process so approvals can build real unsigned
// transactions. Each factory is a no-op until first use; heavy loads happen
// lazily inside the client.
function ensureConnectorSdksConfigured(): void {
  const rpcUrl = (process.env.SOLANA_RPC_URL ?? process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com').trim();
  if (!isDriftVaultConfigured()) {
    setDriftVaultClientFactory(() => buildDriftVaultClient({ rpcUrl }));
  }
  if (!isKaminoConfigured()) {
    setKaminoClientFactory(() => buildKaminoSdkClient({ rpcUrl }));
  }
  if (!isSaveConfigured()) {
    setSaveClientFactory(() => buildSaveSdkClient({ rpcUrl }));
  }
  if (!isWormholeConfigured()) {
    setWormholeClientFactory(() => buildWormholeSdkClient({ rpcUrl }));
  }
}

export function createCloudApiRouter(options: CloudApiRouterOptions = {}): CloudApiRouter {
  ensureConnectorSdksConfigured();
  const store = options.store ?? createDefaultWorkflowStore();
  const clock = options.clock ?? systemClock;
  const authRateLimiter = options.authRateLimiter === false
    ? undefined
    : options.authRateLimiter ?? new MemoryAuthRateLimiter();
  const sessionResolver = async (req: IncomingMessage) => {
    const session = await sessionFromRequest({ req, store, clock });
    return session ? { walletAddress: session.walletAddress, sessionId: session.tokenHash } : null;
  };
  const workflowStore = requireOneTimeWorkflowStore(store);
  const connectorSecretsService = buildConnectorSecretsService(store);
  const secretsLoader: ConnectorSecretsLoader | undefined = connectorSecretsService
    ? (wallet) => connectorSecretsService.loadAll(wallet)
    : undefined;
  const connectorPreparer =
    options.connectorPreparer ??
    createDefaultConnectorPreparer(secretsLoader ? { secretsLoader } : {});
  const workflowService = new WorkflowService(workflowStore, { connectorPreparer });
  const statelessConnectorPreparer =
    options.statelessConnectorPreparer ??
    createStatelessConnectorPreparer(secretsLoader ? { secretsLoader } : {});
  const statelessConnectorReader =
    options.statelessConnectorReader ?? createStatelessConnectorFactsReader(secretsLoader ? { secretsLoader } : {});
  const evidenceStore = isEvidenceStore(store) ? store : evidenceStoreAdapterForCloudStore(store);
  const workflowApiHandler = createWorkflowApiHandler({
    service: workflowService,
    store: workflowStore,
    evidenceStore,
    clock,
    getSession: sessionResolver,
  });
  const evidenceApiHandler = createEvidenceApiHandler({
    store: evidenceStore,
    getSession: sessionResolver,
  });
  const recurringStore = isRecurringStore(store) ? store : recurringStoreAdapterForCloudStore(store);
  const recurringPolicy = options.recurringPolicy ?? loadRecurringPolicyFromEnv();
  const notificationStore = isRecurringNotificationStore(recurringStore) ? recurringStore : undefined;
  const notificationService = notificationStore
    ? new RecurringNotificationService(notificationStore)
    : undefined;
  const recurringService = new RecurringService(recurringStore, {
    approvalSink: createRecurringApprovalSink(workflowService),
    approvalStatusReader: createRecurringApprovalStatusReader(workflowStore),
    occurrenceHistoryHydrator: createRecurringOccurrenceHistoryHydrator(workflowStore),
    policyEnforcer: createRecurringPolicyEnforcer(recurringPolicy),
    notificationSink: notificationService
      ? ({ walletAddress, schedule, occurrence }) =>
          notificationService
            .enqueueOccurrenceReady(walletAddress, schedule.id, occurrence.id)
            .then(() => undefined)
            // Intentionally fire-and-forget (notification is best-effort, never
            // blocks the scheduler), but a silent unhandled rejection would hide
            // webhook outages from ops. Log with stable grep tag so a delivery
            // backlog is visible without standing up a separate metric.
            .catch((err: unknown) => {
              console.warn(
                `recurring_notify_enqueue_failed walletAddress=${walletAddress} scheduleId=${schedule.id} occurrenceId=${occurrence.id} err=${err instanceof Error ? err.message : String(err)}`,
              );
            })
      : undefined,
  });
  const recurringApiHandler = createRecurringApiHandler({
    service: recurringService,
    getSession: sessionResolver,
  });
  if (process.env.AGENTIC_ENABLE_WEB_SCHEDULER === '1') {
    const agentWatch = createAgentBackgroundWatch({
      workflowService,
      recurringService,
    });
    const recurringScheduler = new RecurringScheduler({
      service: recurringService,
      store: recurringStore,
      ...(agentWatch ? { onAfterWalletTick: agentWatch } : {}),
    });
    recurringScheduler.start();
  }
  // Cross-device pairing relay for the desktop Discover → "Scan QR with
  // phone" → Phantom/Solflare flow. Owns its own CORS, JSON parsing, and
  // rate-limiting (pairing UUIDs are the secret, so it sits OUTSIDE the
  // same-origin gate other /api routes enforce).
  const pairingHandler = createPairingHandler();
  return {
    store,
    async handle(req, res, url) {
      if (
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/.well-known/') &&
        !url.pathname.startsWith('/agents/')
      ) {
        return false;
      }

      // Pairing relay short-circuits before the same-origin gate. Skip
      // for any other route — falls through to the normal pipeline.
      if (url.pathname.startsWith('/api/pair/')) {
        return await pairingHandler.handle(req, res, url);
      }

      if (url.pathname === APPLE_APP_SITE_ASSOCIATION_PATH) {
        handleAppleAppSiteAssociation(req, res);
        return true;
      }

      try {
        applyCloudCorsHeaders(req, res);
        if (req.method === 'OPTIONS') {
          handleCloudCorsPreflight(req, res);
          return true;
        }
        enforceSameOrigin(req, url);
        enforceJsonWriteRequest(req);
        await enforceAuthRateLimit(req, url, clock, authRateLimiter);

        // Dev-only Layer 1 dispatch (AP2 / ACP / A2A AgentCard / Bridge router).
        // Public routes (e.g. /.well-known/agent.json) bypass the wallet gate;
        // all other dev routes require devLayer1Enabled() AND a session whose
        // wallet is in AGENTIC_DEV_WALLET_ALLOWLIST. Non-matching prefixes fall
        // through to the existing API route table below.
        const devHandlers = listDevApiHandlers();
        let devHandled = false;
        for (const handler of devHandlers) {
          if (!url.pathname.startsWith(handler.prefix)) continue;
          if (!handler.methods.includes(req.method ?? 'GET')) continue;
          let walletAddress: string | undefined;
          if (!handler.publicRoute) {
            if (!devLayer1Enabled()) {
              writeJson(res, 403, { error: 'dev_layer1_disabled' });
              devHandled = true;
              break;
            }
            const session = await sessionFromRequest({ req, store, clock });
            walletAddress = session?.walletAddress;
            if (!isAllowedDevWallet(walletAddress)) {
              writeJson(res, 403, { error: 'dev_layer1_disabled' });
              devHandled = true;
              break;
            }
          }
          const context: DevApiHandlerContext = {
            walletAddress,
            workflowService,
            workflowStore,
            evidenceStore,
            clock,
          };
          if (await handler.handle(req, res, url, context)) {
            devHandled = true;
            break;
          }
        }
        if (devHandled) return true;

        await routeApiRequest(
          req,
          res,
          url,
          store,
          clock,
          workflowStore,
          evidenceStore,
          recurringStore,
          workflowApiHandler,
          evidenceApiHandler,
          recurringApiHandler,
          statelessConnectorPreparer,
          statelessConnectorReader,
          connectorSecretsService,
        );
      } catch (err) {
        const status = err instanceof ApiError ? err.status : err instanceof AuthValidationError ? 400 : 500;
        const message = err instanceof Error ? redactSecrets(err.message) : 'Unexpected server error.';
        writeJson(res, status, { error: message });
      }
      return true;
    },
  };
}

export function createDefaultWorkflowStore(): WorkflowStore {
  return new MemoryWorkflowStore();
}

function enforceSameOrigin(req: IncomingMessage, url: URL): void {
  if (!isStateChangingMethod(req.method)) return;
  const origin = firstHeaderValue(req.headers.origin);
  const client = firstHeaderValue(req.headers['x-agentic-client'])?.toLowerCase();
  if (origin) {
    if (isAllowedRequestOrigin(origin, client)) return;
    assertSameHost(origin, requestDomain(req, url));
    return;
  }
  if (!isProductionRequest()) return;
  const referer = firstHeaderValue(req.headers.referer);
  if (!referer) {
    throw new ApiError(403, 'State-changing API requests require a same-origin browser context.');
  }
  assertSameHost(referer, requestDomain(req, url));
}

function applyCloudCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = firstHeaderValue(req.headers.origin);
  const client = firstHeaderValue(req.headers['x-agentic-client'])?.toLowerCase();
  if (!origin || !isAllowedRequestOrigin(origin, client)) return;
  // For opaque `null` origins (custom-scheme Tauri webviews) echo `null` back
  // so Chromium's CORS check passes. Normal allowlisted origins get the
  // canonical scheme://host form.
  const ackOrigin = origin === 'null' ? 'null' : normalizeOrigin(origin);
  res.setHeader('access-control-allow-origin', ackOrigin);
  res.setHeader('access-control-allow-methods', CORS_ALLOWED_METHODS);
  res.setHeader('access-control-allow-headers', CORS_ALLOWED_HEADERS);
  res.setHeader('access-control-max-age', '600');
  appendVaryHeader(res, 'Origin');
}

function handleCloudCorsPreflight(req: IncomingMessage, res: ServerResponse): void {
  const origin = firstHeaderValue(req.headers.origin);
  const client = firstHeaderValue(req.headers['x-agentic-client'])?.toLowerCase();
  if (!origin || !isAllowedRequestOrigin(origin, client)) {
    writeJson(res, 403, { error: 'cors_origin_not_allowed' });
    return;
  }
  res.statusCode = 204;
  res.end();
}

function handleAppleAppSiteAssociation(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    writeJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const appID = resolveIosAssociatedAppId(process.env);
  if (!appID) {
    writeJson(res, 503, { error: 'ios_app_id_not_configured' });
    return;
  }

  const body = JSON.stringify({
    applinks: {
      apps: [],
      details: [
        {
          appID,
          paths: IOS_UNIVERSAL_LINK_PATHS,
        },
      ],
    },
  });
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=3600');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

function resolveIosAssociatedAppId(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = (env.AGENTIC_IOS_ASSOCIATED_APP_ID ?? env.AGENTIC_IOS_APP_ID ?? '').trim();
  if (explicit) {
    return isValidIosAssociatedAppId(explicit) ? explicit : undefined;
  }

  const prefix = (env.AGENTIC_IOS_APP_ID_PREFIX ?? env.APPLE_TEAM_ID ?? '').trim();
  const bundleId = (env.AGENTIC_IOS_BUNDLE_ID ?? DEFAULT_IOS_BUNDLE_ID).trim();
  if (!/^[A-Z0-9]{10}$/.test(prefix) || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(bundleId)) {
    return undefined;
  }
  return `${prefix}.${bundleId}`;
}

function isValidIosAssociatedAppId(appID: string): boolean {
  return /^[A-Z0-9]{10}\.[A-Za-z0-9][A-Za-z0-9.-]*$/.test(appID);
}

function isAllowedCloudCorsOrigin(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return configuredCloudCorsOrigins().has(normalized);
}

// Chromium emits `Origin: null` for cross-origin requests issued from custom
// schemes (e.g. `tauri://localhost` on macOS / Linux). We accept that opaque
// origin only when the client identifies itself as a desktop bundle, matching
// the trust model we already apply to allowlisted-origin desktop-bundled
// callers. The CLI path stays origin-less by design (no header check needed
// here — shouldReturnBearerSession handles cli-bundled directly).
function isAllowedRequestOrigin(origin: string | undefined, client: string | undefined): boolean {
  if (origin && isAllowedCloudCorsOrigin(origin)) return true;
  if (origin === 'null' && client === 'desktop-bundled') return true;
  return false;
}

function configuredCloudCorsOrigins(): Set<string> {
  const configured = [
    DEFAULT_ANDROID_CLOUD_ORIGIN,
    DEFAULT_IOS_CLOUD_ORIGIN,
    ...DEFAULT_DESKTOP_CLOUD_ORIGINS,
    ...(isProductionRequest() ? [] : DEFAULT_DESKTOP_DEV_CLOUD_ORIGINS),
    ...(process.env.AGENTIC_ANDROID_WEBVIEW_ORIGIN ? [process.env.AGENTIC_ANDROID_WEBVIEW_ORIGIN] : []),
    ...String(process.env.AGENTIC_CLOUD_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ];
  return new Set(configured.map(normalizeOrigin).filter(Boolean));
}

function normalizeOrigin(origin: string): string {
  try {
    const parsed = new URL(origin);
    // For non-special schemes (tauri:, app:, etc.) URL.origin serializes to
    // the literal string "null" per WHATWG. That would collapse every
    // custom-scheme webview into the same opaque bucket and break the
    // allowlist (tauri://localhost would compare equal to any other opaque
    // origin). Preserve the literal scheme://host for these so the
    // allowlist can distinguish, and so the CORS ACAO echo matches what
    // the browser actually sent.
    if (parsed.origin === 'null') {
      return `${parsed.protocol}//${parsed.host}`.toLowerCase();
    }
    return parsed.origin.toLowerCase();
  } catch {
    return '';
  }
}

function appendVaryHeader(res: ServerResponse, value: string): void {
  const existing = res.getHeader('vary');
  const parts = new Set(
    String(existing ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
  parts.add(value);
  res.setHeader('vary', [...parts].join(', '));
}

function assertSameHost(rawUrl: string, expectedHost: string): void {
  let actualHost: string;
  try {
    actualHost = new URL(rawUrl).host.toLowerCase();
  } catch {
    throw new ApiError(403, 'Cross-origin requests are not allowed.');
  }
  if (actualHost !== expectedHost) {
    throw new ApiError(403, 'Cross-origin requests are not allowed.');
  }
}

function enforceJsonWriteRequest(req: IncomingMessage): void {
  if (!isStateChangingMethod(req.method)) return;
  if (req.method === 'DELETE') return;
  const contentType = firstHeaderValue(req.headers['content-type']);
  if (!contentType?.toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'State-changing API requests must use application/json.');
  }
}

async function enforceAuthRateLimit(
  req: IncomingMessage,
  url: URL,
  clock: Clock,
  limiter: AuthRateLimiter | undefined,
): Promise<void> {
  if (!limiter || req.method !== 'POST') return;
  const route = authRateLimitedRoute(url.pathname);
  if (!route) return;
  const allowed = await limiter.allow({
    key: rateLimitKey(req),
    route,
    now: clock.now(),
  });
  if (!allowed) {
    throw new ApiError(429, route === '/api/ai/generate-plan' || route === '/api/ai/review-plan' || route === '/api/ai/ask-about-plan' || route === '/api/ai/chat'
      ? 'Too many hosted AI drafting attempts. Try again later.'
      : route === '/api/auth/nonce' || route === '/api/auth/verify-wallet'
        ? 'Too many wallet auth attempts. Try again later.'
        : 'Too many workflow requests. Try again later.');
  }
}

export function authRateLimitedRoute(pathname: string): AuthRateLimitInput['route'] | undefined {
  if (pathname === '/api/auth/nonce' || pathname === '/api/auth/verify-wallet') return pathname;
  if (pathname === '/api/ai/generate-plan') return pathname;
  if (pathname === '/api/ai/review-plan') return pathname;
  if (pathname === '/api/ai/ask-about-plan') return pathname;
  if (pathname === '/api/ai/chat') return pathname;
  if (pathname.startsWith('/api/plans')) return '/api/plans:*';
  if (pathname.startsWith('/api/approvals')) return '/api/approvals:*';
  if (pathname.startsWith('/api/connector')) return '/api/approvals:*';
  if (pathname.startsWith('/api/recurring')) return '/api/recurring:*';
  if (pathname.startsWith('/api/evidence')) return '/api/evidence:*';
  if (pathname.startsWith('/api/solana')) return '/api/solana:*';
  if (pathname.startsWith('/api/swap')) return '/api/swap:*';
  if (pathname.startsWith('/api/birdeye')) return '/api/birdeye:*';
  if (pathname.startsWith('/api/helius')) return '/api/helius:*';
  if (pathname.startsWith('/api/coingecko')) return '/api/coingecko:*';
  if (pathname.startsWith('/api/cloud-workspace')) return '/api/cloud-workspace:*';
  // Dev-API surfaces. Without these clauses the route categorizer returns
  // undefined and enforceAuthRateLimit short-circuits — a dev wallet (or a
  // compromised one) could spam these write endpoints without bound. The
  // WRITE_RATE_LIMIT bucket (180 attempts / 5 min) is the right shape for
  // skill installs, signal subscriptions, spend annotations, and streaming
  // session lifecycle ops.
  if (pathname.startsWith('/api/skills')) return '/api/skills:*';
  if (pathname.startsWith('/api/signals')) return '/api/signals:*';
  if (pathname.startsWith('/api/spend')) return '/api/spend:*';
  if (pathname.startsWith('/api/streaming')) return '/api/streaming:*';
  if (pathname === '/api/auth/logout') return pathname;
  return undefined;
}

function rateLimitWindowMs(route: string): number {
  if (route === '/api/auth/nonce' || route === '/api/auth/verify-wallet') return AUTH_RATE_LIMIT_WINDOW_MS;
  return WRITE_RATE_LIMIT_WINDOW_MS;
}

function rateLimitMaxAttempts(route: string): number {
  if (route === '/api/auth/nonce' || route === '/api/auth/verify-wallet') return AUTH_RATE_LIMIT_MAX_ATTEMPTS;
  if (route === '/api/ai/generate-plan' || route === '/api/ai/review-plan' || route === '/api/ai/ask-about-plan' || route === '/api/ai/chat') return HOSTED_AI_RATE_LIMIT_MAX_ATTEMPTS;
  return WRITE_RATE_LIMIT_MAX_ATTEMPTS;
}

function isStateChangingMethod(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

async function routeApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: WorkflowStore,
  clock: Clock,
  workflowStore: WorkflowStore & OneTimeWorkflowStore,
  evidenceStore: EvidenceStore,
  recurringStore: RecurringStore,
  workflowApiHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  evidenceApiHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  recurringApiHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  statelessConnectorPreparer: StatelessConnectorTransactionPreparer,
  statelessConnectorReader: StatelessConnectorFactsReader,
  connectorSecretsService: ConnectorSecretsService | undefined,
): Promise<void> {
  if (url.pathname === '/api/ai/status') {
    requireMethod(req, 'GET');
    const managed = managedHostedAiSettings();
    writeJson(res, 200, {
      available: true,
      mode: managed ? 'hosted-managed' : 'hosted-byok',
      managed: managed ? {
        available: true,
        provider: managed.provider,
        apiFormat: managed.apiFormat,
        model: managed.model,
      } : {
        available: false,
      },
      providers: Object.values(HOSTED_PROVIDER_PRESETS).map(({ id, label, apiFormat, defaultModel }) => ({
        id,
        label,
        apiFormat,
        defaultModel,
      })),
      build: {
        commit: process.env.RENDER_GIT_COMMIT?.slice(0, 12) ?? process.env.AGENTIC_BUILD_ID ?? 'unknown',
        deployedAt: process.env.RENDER_DEPLOY_TIMESTAMP ?? null,
        routes: REGISTERED_API_ROUTES,
      },
    });
    return;
  }

  if (url.pathname === '/api/releases/downloads') {
    requireMethod(req, 'GET');
    writeJson(res, 200, await resolveReleaseDownloads());
    return;
  }

  if (url.pathname.replace(/\/$/, '') === '/api/android-config') {
    requireMethod(req, 'GET');
    const startedAt = Date.now();
    const cfg = getAndroidRemoteConfig();
    const body = JSON.stringify(cfg);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    // `private`: confine cache to the per-client local cache (Android's HTTP cache,
    // a single browser session). Prevents CDN-shared poisoning where one bad
    // response could cripple every fetcher in a region. `max-age=300` gives
    // ~5min freshness window. `stale-while-revalidate=60` matches the Android
    // RemoteConfigLoader's REFRESH_DEBOUNCE_MS so a bad config can persist at
    // most ~60s past its TTL.
    res.setHeader('cache-control', 'private, max-age=300, stale-while-revalidate=60');
    res.end(body);
    // Single-line structured log for ops grep. Keep tags stable (the grep cost
    // of "android_config_fetch" should outweigh log-shape evolution).
    const client = firstHeaderValue(req.headers['x-agentic-client']) ?? '';
    const ua = firstHeaderValue(req.headers['user-agent']) ?? '';
    console.log(
      `android_config_fetch status=200 ms=${Date.now() - startedAt} version=${cfg.version} wallets=${cfg.walletRegistry.length} client=${JSON.stringify(client)} ua=${JSON.stringify(ua.slice(0, 120))}`,
    );
    return;
  }

  if (url.pathname.replace(/\/$/, '') === '/api/mobile-config') {
    requireMethod(req, 'GET');
    const startedAt = Date.now();
    // Default to ios for safety: the new endpoint is added FOR iOS; Android keeps
    // hitting /api/android-config. `?platform=android` is supported for future
    // Android client migration.
    const platform = (url.searchParams.get('platform') ?? 'ios').toLowerCase();
    const cfg = platform === 'android' ? getAndroidRemoteConfig() : getIosRemoteConfig();
    const body = JSON.stringify(cfg);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'private, max-age=300, stale-while-revalidate=60');
    res.end(body);
    const client = firstHeaderValue(req.headers['x-agentic-client']) ?? '';
    const ua = firstHeaderValue(req.headers['user-agent']) ?? '';
    console.log(
      `mobile_config_fetch status=200 platform=${platform} ms=${Date.now() - startedAt} version=${cfg.version} wallets=${cfg.walletRegistry.length} client=${JSON.stringify(client)} ua=${JSON.stringify(ua.slice(0, 120))}`,
    );
    return;
  }

  if (url.pathname === '/api/policy/enrich') {
    requireMethod(req, 'POST');
    const startedAt = Date.now();
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'Invalid JSON body' }));
      return;
    }
    const result = await handlePolicyEnrich(body);
    res.statusCode = result.ok ? 200 : 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    // Don't cache — policy resolution is stateful (live prices change per second).
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(result));
    const client = firstHeaderValue(req.headers['x-agentic-client']) ?? '';
    const atomCount = result.ok
      ? (Array.isArray((result.policyBundle as Record<string, unknown>).atoms)
          ? ((result.policyBundle as Record<string, unknown>).atoms as unknown[]).length
          : 0)
      : 0;
    console.log(
      `policy_enrich_fetch status=${res.statusCode} ms=${Date.now() - startedAt} atoms=${atomCount} client=${JSON.stringify(client)}`,
    );
    return;
  }

  if (url.pathname === '/api/ai/generate-plan') {
    requireMethod(req, 'POST');
    await handleHostedAiRequest(req, res, store, clock);
    return;
  }

  if (url.pathname === '/api/ai/review-plan') {
    requireMethod(req, 'POST');
    await handleHostedAiReviewRequest(req, res, store, clock);
    return;
  }

  if (url.pathname === '/api/ai/ask-about-plan') {
    requireMethod(req, 'POST');
    await handleHostedAiAskRequest(req, res, store, clock);
    return;
  }

  if (url.pathname === '/api/ai/chat') {
    requireMethod(req, 'POST');
    await handleHostedAiChatRequest(req, res, store, clock);
    return;
  }

  if (url.pathname === '/api/device-agent/status') {
    requireMethod(req, 'GET');
    await handleDeviceAgentStatus(req, res, store, clock);
    return;
  }

  if (url.pathname === '/api/device-agent/control') {
    requireMethod(req, 'POST');
    await handleDeviceAgentControl(req, res, store, clock);
    return;
  }

  if (url.pathname === '/api/preferences/agent-policies') {
    if (req.method === 'GET') {
      await handleGetAgentPolicies(req, res, store, clock);
      return;
    }
    if (req.method === 'PUT') {
      await handlePutAgentPolicies(req, res, store, clock);
      return;
    }
    requireMethod(req, 'GET');
    return;
  }

  if (url.pathname === '/api/preferences') {
    requireMethod(req, 'GET');
    await handleListPreferences(req, res, store, clock);
    return;
  }

  const preferenceNamespace = preferenceNamespaceFromPath(url.pathname);
  if (preferenceNamespace) {
    if (req.method === 'GET') {
      await handleGetPreference(req, res, store, clock, preferenceNamespace);
      return;
    }
    if (req.method === 'PUT') {
      await handlePutPreference(req, res, store, clock, preferenceNamespace);
      return;
    }
    requireMethod(req, 'GET');
    return;
  }

  if (url.pathname === '/api/connector-secrets') {
    requireMethod(req, 'GET');
    await handleListConnectorSecrets(req, res, store, clock, connectorSecretsService);
    return;
  }

  const connectorSecretId = connectorIdFromPath(url.pathname);
  if (connectorSecretId) {
    if (req.method === 'POST') {
      await handlePostConnectorSecret(req, res, store, clock, connectorSecretsService, connectorSecretId);
      return;
    }
    if (req.method === 'DELETE') {
      await handleDeleteConnectorSecret(req, res, store, clock, connectorSecretsService, connectorSecretId);
      return;
    }
    requireMethod(req, 'POST');
    return;
  }

  if (url.pathname === '/api/auth/nonce') {
    requireMethod(req, 'POST');
    await handleAuthNonce(req, res, url, store, clock);
    return;
  }

  if (url.pathname === '/api/auth/verify-wallet') {
    requireMethod(req, 'POST');
    await handleVerifyWallet(req, res, url, store, clock);
    return;
  }

  if (url.pathname === '/api/auth/logout') {
    requireMethod(req, 'POST');
    await handleLogout(req, res, store, clock);
    return;
  }

  if (url.pathname === '/api/cloud-workspace/delete-intent') {
    requireMethod(req, 'POST');
    await handleCloudWorkspaceDeleteIntent(req, res, url, store, clock);
    return;
  }

  if (url.pathname === '/api/cloud-workspace/delete') {
    requireMethod(req, 'POST');
    await handleCloudWorkspaceDelete(
      req,
      res,
      url,
      store,
      clock,
      workflowStore,
      evidenceStore,
      recurringStore,
    );
    return;
  }

  if (url.pathname === '/api/agents/profile-intent') {
    requireMethod(req, 'POST');
    await handleAgentProfileIntent(req, res, url, store, clock);
    return;
  }

  if (url.pathname === '/api/agents/profile') {
    if (req.method === 'PUT') {
      await handleAgentProfilePublish(req, res, url, store, clock);
      return;
    }
    if (req.method === 'DELETE') {
      await handleAgentProfileTakedown(req, res, url, store, clock);
      return;
    }
    requireMethod(req, 'PUT');
    return;
  }

  if (url.pathname === '/api/session') {
    requireMethod(req, 'GET');
    const session = await sessionFromRequest({ req, store, clock });
    writeJson(res, 200, sessionResponse(session));
    return;
  }

  if (url.pathname === '/api/audit') {
    requireMethod(req, 'GET');
    await handleListAuditEvents(req, res, url, store, clock);
    return;
  }

  if (url.pathname === '/api/solana/latest-blockhash') {
    requireMethod(req, 'POST');
    await handleSolanaLatestBlockhash(req, res);
    return;
  }

  if (url.pathname === '/api/solana/send-transaction') {
    requireMethod(req, 'POST');
    await handleSolanaSendTransaction(req, res);
    return;
  }

  if (url.pathname === '/api/solana/signature-status') {
    requireMethod(req, 'POST');
    await handleSolanaSignatureStatus(req, res);
    return;
  }

  if (url.pathname === '/api/solana/parsed-account-info') {
    requireMethod(req, 'POST');
    await handleSolanaParsedAccountInfo(req, res);
    return;
  }

  if (url.pathname === '/api/solana/wallet-balance-summary') {
    requireMethod(req, 'POST');
    await handleSolanaWalletBalanceSummary(req, res);
    return;
  }

  if (url.pathname === '/api/swap/order') {
    requireMethod(req, 'POST');
    await handleJupiterSwapOrder(req, res);
    return;
  }

  if (url.pathname === '/api/swap/execute') {
    requireMethod(req, 'POST');
    await handleJupiterSwapExecute(req, res);
    return;
  }

  if (url.pathname === '/api/connector/prepare-transaction') {
    requireMethod(req, 'POST');
    await handleConnectorPrepareTransaction(req, res, statelessConnectorPreparer);
    return;
  }

  if (url.pathname === '/api/connector/read-facts') {
    requireMethod(req, 'POST');
    await handleConnectorReadFacts(req, res, store, clock, statelessConnectorReader);
    return;
  }

  if (url.pathname === '/api/birdeye/price-multi') {
    requireMethod(req, 'POST');
    await handleBirdeyePriceMulti(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/search') {
    requireMethod(req, 'POST');
    await handleBirdeyeSearch(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/token-meta') {
    requireMethod(req, 'POST');
    await handleBirdeyeTokenMetadata(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/token-security') {
    requireMethod(req, 'POST');
    await handleBirdeyeTokenSecurity(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/wallet-token-list') {
    requireMethod(req, 'POST');
    await handleBirdeyeWalletTokenList(req, res, store, clock);
    return;
  }

  if (url.pathname === '/api/birdeye/token-holders') {
    requireMethod(req, 'POST');
    await handleBirdeyeTokenHolders(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/token-creation-info') {
    requireMethod(req, 'POST');
    await handleBirdeyeTokenCreationInfo(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/exit-liquidity-multi') {
    requireMethod(req, 'POST');
    await handleBirdeyeExitLiquidityMulti(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/price-volume') {
    requireMethod(req, 'POST');
    await handleBirdeyePriceVolume(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/history-price') {
    requireMethod(req, 'POST');
    await handleBirdeyeHistoryPrice(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/ohlcv') {
    requireMethod(req, 'POST');
    await handleBirdeyeOhlcv(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/trending') {
    requireMethod(req, 'POST');
    await handleBirdeyeTrending(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/new-listings') {
    requireMethod(req, 'POST');
    await handleBirdeyeNewListings(req, res);
    return;
  }

  if (url.pathname === '/api/birdeye/token-list-v3') {
    requireMethod(req, 'POST');
    await handleBirdeyeTokenListV3(req, res);
    return;
  }

  if (url.pathname === '/api/helius/transfers-by-address') {
    requireMethod(req, 'POST');
    await handleHeliusTransfersByAddress(req, res, store, clock);
    return;
  }

  if (url.pathname === '/api/coingecko/global') {
    requireMethod(req, 'GET');
    await handleCoinGeckoGlobal(req, res);
    return;
  }

  if (url.pathname === '/api/coingecko/endpoints') {
    requireMethod(req, 'GET');
    writeJson(res, 200, listCoinGeckoEndpointCatalog());
    return;
  }

  if (url.pathname === '/api/coingecko/read') {
    requireMethod(req, 'POST');
    await handleCoinGeckoRead(req, res);
    return;
  }

  if (url.pathname === '/api/coingecko/token-evidence') {
    requireMethod(req, 'POST');
    await handleCoinGeckoTokenEvidence(req, res);
    return;
  }

  if (await workflowApiHandler(req, res)) {
    return;
  }

  if (await evidenceApiHandler(req, res)) {
    return;
  }

  if (await recurringApiHandler(req, res)) {
    return;
  }

  writeJson(res, 404, { error: 'not_found' });
}

async function handleAuthNonce(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Missing auth nonce request.');
  }
  await store.cleanupExpired(clock.now().toISOString());
  const walletAddress = normalizeWalletAddress((body as Record<string, unknown>).walletAddress);
  const response = createAuthNonceResponse({
    walletAddress,
    domain: requestDomain(req, url),
    clock,
  });
  await store.createAuthNonce({
    ...response,
    createdAt: response.issuedAt,
  });
  writeJson(res, 200, response);
}

async function handleVerifyWallet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const body = parseVerifyWalletRequest(await readJsonBody(req));
  const nonce = await store.getAuthNonce(body.nonce);
  const now = clock.now();
  if (!nonce || nonce.consumedAt) {
    throw new ApiError(401, 'Invalid or already used auth nonce.');
  }
  if (nonce.walletAddress !== body.walletAddress) {
    throw new ApiError(401, 'Wallet address does not match auth nonce.');
  }
  if (nonce.domain !== requestDomain(req, url)) {
    throw new ApiError(401, 'Signed domain does not match this server.');
  }
  if (body.domain && body.domain !== nonce.domain) {
    throw new ApiError(401, 'Signed domain does not match auth nonce.');
  }
  if (body.issuedAt && body.issuedAt !== nonce.issuedAt) {
    throw new ApiError(401, 'Signed issued time does not match auth nonce.');
  }
  if (body.expiresAt && body.expiresAt !== nonce.expiresAt) {
    throw new ApiError(401, 'Signed expiration time does not match auth nonce.');
  }
  if (Date.parse(nonce.issuedAt) > now.getTime() || Date.parse(nonce.expiresAt) <= now.getTime()) {
    throw new ApiError(401, 'Auth nonce has expired.');
  }
  const expectedMessage = buildWalletLoginMessage(nonce);
  if (body.message !== nonce.message || body.message !== expectedMessage) {
    throw new ApiError(401, 'Signed message does not match auth nonce.');
  }
  if (!verifyWalletSignature(body)) {
    throw new ApiError(401, 'Wallet signature could not be verified.');
  }

  const consumedAt = clock.now().toISOString();
  const consumed = await store.consumeAuthNonce(nonce.nonce, consumedAt);
  if (!consumed) {
    throw new ApiError(401, 'Invalid or already used auth nonce.');
  }
  const session = await createWalletSession({ store, walletAddress: body.walletAddress, clock });
  await store.forWallet(body.walletAddress).insertAuditEvent({
    id: randomUUID(),
    type: 'auth.session.created',
    createdAt: session.record.createdAt,
    metadata: {
      expiresAt: session.record.expiresAt,
    },
  });
  res.setHeader('set-cookie', serializeSessionCookie(session.token, {
    maxAgeSeconds: SESSION_TTL_MS / 1000,
    expires: new Date(session.record.expiresAt),
    secure: shouldSetSecureCookie(req),
  }));
  writeJson(res, 200, {
    ...sessionResponse(session.record),
    ...(shouldReturnBearerSession(req) ? { sessionToken: session.token } : {}),
  });
}

async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await deleteSessionFromRequest({ req, store, clock });
  if (session) {
    await store.forWallet(session.walletAddress).insertAuditEvent({
      id: randomUUID(),
      type: 'auth.session.deleted',
      createdAt: clock.now().toISOString(),
      metadata: {
        expiresAt: session.expiresAt,
      },
    });
  }
  res.setHeader('set-cookie', serializeClearSessionCookie(shouldSetSecureCookie(req)));
  writeJson(res, 200, sessionResponse(undefined));
}

async function handleCloudWorkspaceDeleteIntent(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  await readJsonBody(req);
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required.');
  }
  await store.cleanupExpired(clock.now().toISOString());
  const response = createCloudWorkspaceDeleteIntentResponse({
    walletAddress: session.walletAddress,
    domain: requestDomain(req, url),
    clock,
  });
  await store.createAuthNonce({
    ...response,
    createdAt: response.issuedAt,
  });
  writeJson(res, 200, response);
}

async function handleCloudWorkspaceDelete(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: WorkflowStore,
  clock: Clock,
  workflowStore: WorkflowStore & OneTimeWorkflowStore,
  evidenceStore: EvidenceStore,
  recurringStore: RecurringStore,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required.');
  }
  const body = parseCloudWorkspaceDeleteRequest(await readJsonBody(req), session.walletAddress);
  const nonce = await store.getAuthNonce(body.nonce);
  const now = clock.now();
  if (!nonce || nonce.consumedAt) {
    throw new ApiError(401, 'Invalid or already used deletion nonce.');
  }
  if (nonce.walletAddress !== session.walletAddress || body.walletAddress !== session.walletAddress) {
    throw new ApiError(401, 'Wallet address does not match the signed-in cloud session.');
  }
  if (nonce.domain !== requestDomain(req, url) || body.domain !== nonce.domain) {
    throw new ApiError(401, 'Signed domain does not match this server.');
  }
  if (body.issuedAt !== nonce.issuedAt || body.expiresAt !== nonce.expiresAt) {
    throw new ApiError(401, 'Signed deletion intent metadata does not match the nonce.');
  }
  if (Date.parse(nonce.issuedAt) > now.getTime() || Date.parse(nonce.expiresAt) <= now.getTime()) {
    throw new ApiError(401, 'Deletion nonce has expired.');
  }
  const expectedMessage = buildCloudWorkspaceDeleteMessage(nonce);
  if (body.message !== nonce.message || body.message !== expectedMessage) {
    throw new ApiError(401, 'Signed message does not match deletion intent.');
  }
  if (!verifyWalletSignature(body)) {
    throw new ApiError(401, 'Wallet signature could not be verified.');
  }
  const consumed = await store.consumeAuthNonce(nonce.nonce, clock.now().toISOString());
  if (!consumed) {
    throw new ApiError(401, 'Invalid or already used deletion nonce.');
  }

  const deleted = await deleteCloudWorkspaceRecords(
    session.walletAddress,
    store,
    workflowStore,
    evidenceStore,
    recurringStore,
  );
  await deleteSessionFromRequest({ req, store, clock });
  res.setHeader('set-cookie', serializeClearSessionCookie(shouldSetSecureCookie(req)));
  writeJson(res, 200, { ok: true, signedOut: true, deleted });
}

const AGENT_PROFILE_NAMESPACE: CloudPreferenceNamespace = 'agent-payment-profile';

async function handleAgentProfileIntent(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required to update your agent profile.');
  }
  const body = await readJsonBody(req);
  const record = (body && typeof body === 'object' && !Array.isArray(body)) ? body as Record<string, unknown> : {};
  const action = record.action === 'takedown' ? 'takedown' : 'publish';
  await store.cleanupExpired(clock.now().toISOString());

  let response;
  if (action === 'publish') {
    const payload = parseAgentProfilePayloadInput(record.payload);
    const payloadHashHex = await hashProfilePayload(payload);
    response = createAgentProfilePublishIntentResponse({
      walletAddress: session.walletAddress,
      domain: requestDomain(req, url),
      payloadHashHex,
      clock,
    });
  } else {
    response = createAgentProfileTakedownIntentResponse({
      walletAddress: session.walletAddress,
      domain: requestDomain(req, url),
      clock,
    });
  }

  await store.createAuthNonce({
    ...response,
    createdAt: response.issuedAt,
  });
  writeJson(res, 200, { ...response, action });
}

async function handleAgentProfilePublish(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required to publish your agent profile.');
  }
  const preferenceStore = isCloudPreferencesStore(store) ? store : undefined;
  if (!preferenceStore) {
    throw new ApiError(503, 'Profile storage is not configured on this server.');
  }
  const rawBody = await readJsonBody(req);
  const body = parseAgentProfileRequest(rawBody, session.walletAddress);
  const payload = parseAgentProfilePayloadInput((rawBody as Record<string, unknown>).payload);

  const nonce = await assertProfileNonce(store, body, session.walletAddress, requestDomain(req, url), clock);
  const recomputedHashHex = await hashProfilePayload(payload);
  const expectedMessage = buildAgentProfilePublishMessage(nonce, recomputedHashHex);
  if (body.message !== nonce.message || body.message !== expectedMessage) {
    throw new ApiError(401, 'Signed message does not match the profile publish intent.');
  }
  if (!verifyWalletSignature(body)) {
    throw new ApiError(401, 'Wallet signature could not be verified.');
  }
  const consumed = await store.consumeAuthNonce(nonce.nonce, clock.now().toISOString());
  if (!consumed) {
    throw new ApiError(401, 'Invalid or already used profile nonce.');
  }

  const existing = await preferenceStore.getPreference(session.walletAddress, AGENT_PROFILE_NAMESPACE);
  const saved = await preferenceStore.savePreference(session.walletAddress, {
    namespace: AGENT_PROFILE_NAMESPACE,
    payload,
    updatedAt: clock.now().toISOString(),
    version: (existing?.version ?? 0) + 1,
  });
  await store.forWallet(session.walletAddress).insertAuditEvent({
    id: randomUUID(),
    type: 'agent.profile.published',
    createdAt: saved.updatedAt,
    metadata: {
      version: saved.version,
      discoverable: payload.discoverable,
      payloadHash: recomputedHashHex,
    },
  });
  writeJson(res, 200, { ok: true, profile: saved });
}

async function handleAgentProfileTakedown(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required to take down your agent profile.');
  }
  const preferenceStore = isCloudPreferencesStore(store) ? store : undefined;
  if (!preferenceStore) {
    throw new ApiError(503, 'Profile storage is not configured on this server.');
  }
  const body = parseAgentProfileRequest(await readJsonBody(req), session.walletAddress);
  const nonce = await assertProfileNonce(store, body, session.walletAddress, requestDomain(req, url), clock);
  const expectedMessage = buildAgentProfileTakedownMessage(nonce);
  if (body.message !== nonce.message || body.message !== expectedMessage) {
    throw new ApiError(401, 'Signed message does not match the profile takedown intent.');
  }
  if (!verifyWalletSignature(body)) {
    throw new ApiError(401, 'Wallet signature could not be verified.');
  }
  const consumed = await store.consumeAuthNonce(nonce.nonce, clock.now().toISOString());
  if (!consumed) {
    throw new ApiError(401, 'Invalid or already used profile nonce.');
  }

  const existing = await preferenceStore.getPreference(session.walletAddress, AGENT_PROFILE_NAMESPACE);
  if (!existing) {
    writeJson(res, 200, { ok: true, profile: null });
    return;
  }
  const existingPayload = existing.payload && typeof existing.payload === 'object' && !Array.isArray(existing.payload)
    ? (existing.payload as Record<string, unknown>)
    : {};
  const hiddenPayload: AgentPaymentProfilePayload = {
    version: 1,
    discoverable: false,
    displayName: typeof existingPayload.displayName === 'string' ? existingPayload.displayName : '',
    acceptedTokens: Array.isArray(existingPayload.acceptedTokens)
      ? (existingPayload.acceptedTokens as AgentPaymentProfilePayload['acceptedTokens'])
      : [],
    protocols: Array.isArray(existingPayload.protocols)
      ? (existingPayload.protocols as AgentPaymentProfilePayload['protocols'])
      : [],
  };
  if (typeof existingPayload.contactEmail === 'string' && existingPayload.contactEmail.trim().length > 0) {
    hiddenPayload.contactEmail = existingPayload.contactEmail.trim();
  }
  const saved = await preferenceStore.savePreference(session.walletAddress, {
    namespace: AGENT_PROFILE_NAMESPACE,
    payload: hiddenPayload,
    updatedAt: clock.now().toISOString(),
    version: existing.version + 1,
  });
  await store.forWallet(session.walletAddress).insertAuditEvent({
    id: randomUUID(),
    type: 'agent.profile.takedown',
    createdAt: saved.updatedAt,
    metadata: { version: saved.version },
  });
  writeJson(res, 200, { ok: true, profile: saved });
}

interface AgentProfileSignedRequest {
  walletAddress: string;
  nonce: string;
  message: string;
  signature: string;
  domain: string;
  issuedAt: string;
  expiresAt: string;
  signatureEncoding: 'base58' | 'base64';
  proofEncoding?: 'utf8-message' | 'tx-memo-proof';
  proofTxBase64?: string;
}

function parseAgentProfileRequest(input: unknown, fallbackWalletAddress: string): AgentProfileSignedRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'Missing agent profile request body.');
  }
  const record = input as Record<string, unknown>;
  return {
    walletAddress: record.walletAddress === undefined
      ? fallbackWalletAddress
      : normalizeWalletAddress(record.walletAddress),
    nonce: requiredDeleteString(record.nonce, 'Missing profile nonce.'),
    message: requiredDeleteString(record.message, 'Missing signed profile message.'),
    signature: requiredDeleteString(record.signature, 'Missing wallet signature.'),
    domain: requiredDeleteString(record.domain, 'Missing signed domain.'),
    issuedAt: requiredDeleteString(record.issuedAt, 'Missing signed issued time.'),
    expiresAt: requiredDeleteString(record.expiresAt, 'Missing signed expiration time.'),
    signatureEncoding: parseSignatureEncoding(record.signatureEncoding),
    ...parseProofEncodingFields(record),
  };
}

async function assertProfileNonce(
  store: WorkflowStore,
  body: AgentProfileSignedRequest,
  sessionWalletAddress: string,
  serverDomain: string,
  clock: Clock,
): Promise<{ nonce: string; walletAddress: string; domain: string; issuedAt: string; expiresAt: string; message: string }> {
  const nonce = await store.getAuthNonce(body.nonce);
  const now = clock.now();
  if (!nonce || nonce.consumedAt) {
    throw new ApiError(401, 'Invalid or already used profile nonce.');
  }
  if (nonce.walletAddress !== sessionWalletAddress || body.walletAddress !== sessionWalletAddress) {
    throw new ApiError(401, 'Wallet address does not match the signed-in cloud session.');
  }
  if (nonce.domain !== serverDomain || body.domain !== nonce.domain) {
    throw new ApiError(401, 'Signed domain does not match this server.');
  }
  if (body.issuedAt !== nonce.issuedAt || body.expiresAt !== nonce.expiresAt) {
    throw new ApiError(401, 'Signed profile metadata does not match the nonce.');
  }
  if (Date.parse(nonce.issuedAt) > now.getTime() || Date.parse(nonce.expiresAt) <= now.getTime()) {
    throw new ApiError(401, 'Profile nonce has expired.');
  }
  if (!nonce.message) {
    throw new ApiError(401, 'Profile nonce is missing its canonical message.');
  }
  return nonce as { nonce: string; walletAddress: string; domain: string; issuedAt: string; expiresAt: string; message: string };
}

function parseAgentProfilePayloadInput(input: unknown): AgentPaymentProfilePayload {
  const result = validateProfilePayload(input);
  if (!result.ok) {
    const first = result.errors[0];
    throw new ApiError(400, first ? `Profile payload invalid: ${first.message}` : 'Profile payload invalid.');
  }
  return result.payload;
}

async function handleListAuditEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required.');
  }
  const recordType = url.searchParams.get('recordType');
  const recordId = url.searchParams.get('recordId');
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.max(1, Math.min(500, Number(limitParam) || 100)) : 100;
  const events = await store.forWallet(session.walletAddress).listAuditEvents();
  const filtered = events.filter((event) => {
    const meta = event.metadata as Record<string, unknown> | undefined;
    if (recordType) {
      const metaRecordType = typeof meta?.recordType === 'string' ? meta.recordType : undefined;
      const sourceRecordType = typeof meta?.sourceRecordType === 'string' ? meta.sourceRecordType : undefined;
      const subjectType = typeof meta?.subjectType === 'string' ? meta.subjectType : undefined;
      if (
        metaRecordType !== recordType &&
        sourceRecordType !== recordType &&
        subjectType !== recordType &&
        !event.type.startsWith(`${recordType}.`)
      ) return false;
    }
    if (recordId) {
      const metaRecordId = typeof meta?.recordId === 'string' ? meta.recordId : undefined;
      const sourceRecordId = typeof meta?.sourceRecordId === 'string' ? meta.sourceRecordId : undefined;
      const subjectId = typeof meta?.subjectId === 'string' ? meta.subjectId : undefined;
      const approvalId = typeof meta?.approvalId === 'string' ? meta.approvalId : undefined;
      if (
        metaRecordId !== recordId &&
        sourceRecordId !== recordId &&
        subjectId !== recordId &&
        approvalId !== recordId
      ) return false;
    }
    return true;
  });
  filtered.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  writeJson(res, 200, { events: filtered.slice(0, limit) });
}

async function handleHostedAiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required for hosted AI drafting.');
  }
  const body = await readJsonBody(req) as HostedAiBody;
  const settings = hostedSettings(body.settings);
  const request = hostedPlanRequest(body.request);
  const planner = new BridgeAiPlanner();

  try {
    planner.setSessionKey({
      apiKey: settings.apiKey,
      provider: settings.provider,
      apiFormat: settings.apiFormat,
      baseUrl: settings.baseUrl,
      model: settings.model,
    });
    writeJson(res, 200, await runWithHostedAiTimeout(planner.generatePlan(request)));
  } catch (err) {
    if (err instanceof ApiError) {
      writeJson(res, err.status, { error: err.message });
      return;
    }
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
    const status = code === 'invalid_request' ? 400 : 502;
    const message = err instanceof Error ? redactSecrets(err.message, settings.apiKey) : 'AI provider request failed.';
    writeJson(res, status, { error: message });
  }
}

async function handleHostedAiReviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required for hosted AI agent review.');
  }
  const body = await readJsonBody(req) as HostedAiReviewBody;
  const settings = hostedSettings(body.settings);
  const request = hostedReviewRequestForSession(body.request, session.walletAddress);
  const planner = new BridgeAiPlanner();

  try {
    planner.setSessionKey({
      apiKey: settings.apiKey,
      provider: settings.provider,
      apiFormat: settings.apiFormat,
      baseUrl: settings.baseUrl,
      model: settings.model,
    });
    writeJson(res, 200, await runWithHostedAiTimeout(planner.reviewPlan(request)));
  } catch (err) {
    if (err instanceof ApiError) {
      writeJson(res, err.status, { error: err.message });
      return;
    }
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
    const status = code === 'invalid_request' ? 400 : 502;
    const message = err instanceof Error ? redactSecrets(err.message, settings.apiKey) : 'AI provider request failed.';
    writeJson(res, status, { error: message });
  }
}

async function handleConnectorPrepareTransaction(
  req: IncomingMessage,
  res: ServerResponse,
  preparer: StatelessConnectorTransactionPreparer,
): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'connector prepare-transaction body');
  const kind = requiredBodyString(body, 'kind');
  const walletAddress = requiredBodyString(body, 'walletAddress');
  const cluster = requiredCluster(body.cluster);
  const params = body.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new ApiError(400, 'params must be an object.');
  }
  const summary = typeof body.summary === 'string' ? body.summary : undefined;
  try {
    const payload = await preparer({
      kind,
      params: params as Record<string, unknown>,
      walletAddress,
      cluster,
      ...(summary ? { summary } : {}),
    });
    writeJson(res, 200, payload);
  } catch (err) {
    if (err instanceof AdapterError) {
      if (err.code === 'unknown_kind' || err.code === 'not_executable') {
        throw new ApiError(422, err.message);
      }
      throw new ApiError(502, err.message);
    }
    throw new ApiError(502, err instanceof Error ? redactSecrets(err.message) : 'Connector prepare failed.');
  }
}

async function handleConnectorReadFacts(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
  reader: StatelessConnectorFactsReader,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required.');
  }
  const body = asJsonRecord(await readJsonBody(req), 'connector read-facts body');
  const connectorId = requiredBodyString(body, 'connectorId');
  const cluster = requiredCluster(body.cluster);
  const requestedWallet = typeof body.walletAddress === 'string' ? body.walletAddress.trim() : '';
  if (requestedWallet && requestedWallet !== session.walletAddress) {
    throw new ApiError(401, 'Wallet address does not match the signed-in cloud session.');
  }
  const capability = body.capability === undefined
    ? undefined
    : requiredBodyString(body, 'capability') as ConnectorReadFactsRequest['capability'];
  const input: ConnectorReadFactsRequest = {
    ...(body as unknown as ConnectorReadFactsRequest),
    connectorId,
    cluster,
    walletAddress: session.walletAddress,
    ...(capability !== undefined ? { capability } : {}),
  };
  try {
    writeJson(res, 200, await reader(input));
  } catch (err) {
    const protocolCode = protocolErrorCode(err);
    if (protocolCode) {
      const status = protocolCode === 'invalid_request' ? 400 : protocolCode === 'unauthorized' ? 401 : 502;
      throw new ApiError(status, err instanceof Error ? redactSecrets(err.message) : 'Connector read failed.');
    }
    if (err instanceof AdapterError) {
      throw new ApiError(err.code === 'unknown_kind' ? 422 : 502, err.message);
    }
    throw new ApiError(502, err instanceof Error ? redactSecrets(err.message) : 'Connector read failed.');
  }
}

async function handleJupiterSwapOrder(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'swap order body');
  const inputMint = requiredBodyString(body, 'inputMint');
  const outputMint = requiredBodyString(body, 'outputMint');
  const amount = requiredBodyString(body, 'amount');
  const taker = requiredBodyString(body, 'taker');
  const slippageBps = optionalIntegerBodyField(body, 'slippageBps');
  if (!/^\d+$/.test(amount)) {
    throw new ApiError(400, 'Swap order amount must be a raw integer string.');
  }
  const url = new URL(`${jupiterBaseUrl()}/order`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amount);
  url.searchParams.set('taker', taker);
  if (slippageBps !== undefined) {
    url.searchParams.set('slippageBps', String(slippageBps));
  }
  writeJson(res, 200, await requestJupiter(url));
}

async function handleSolanaLatestBlockhash(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'Solana latest blockhash body');
  const cluster = requiredCluster(body.cluster);
  writeJson(res, 200, await solanaConnection(cluster).getLatestBlockhash('confirmed'));
}

async function handleSolanaSendTransaction(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'Solana send transaction body');
  const cluster = requiredCluster(body.cluster);
  const signedTransaction = requiredBodyString(
    body.signedTransactionBase64 ?? body.signedTransaction,
    'signedTransaction',
  );
  const bytes = Buffer.from(signedTransaction, 'base64');
  const sendOptions = { preflightCommitment: 'confirmed' as const, maxRetries: 5 };
  const configuredUrl = solanaRpcUrl(cluster);
  try {
    const txid = await new Connection(configuredUrl, 'confirmed').sendRawTransaction(bytes, sendOptions);
    writeJson(res, 200, { txid, signature: txid });
    return;
  } catch (err) {
    if (!isRpcAuthRejectedSendError(err)) throw err;
    const fallbackUrl = publicSolanaRpcFallback(cluster);
    if (fallbackUrl === configuredUrl) throw err;
    try {
      const txid = await new Connection(fallbackUrl, 'confirmed').sendRawTransaction(bytes, sendOptions);
      console.warn(
        `[cloud:send-fallback] Configured RPC refused sendTransaction (${rpcAuthSendErrorSummary(err)}). ` +
        `Sent via public RPC ${fallbackUrl}.`,
      );
      writeJson(res, 200, { txid, signature: txid });
      return;
    } catch (fallbackErr) {
      if (isRpcAuthRejectedSendError(fallbackErr)) throw err;
      throw fallbackErr;
    }
  }
}

function isRpcAuthRejectedSendError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (!message) return false;
  if (/\b(401|403|451)\b/.test(message)) return true;
  if (/"code"\s*:\s*(?:401|403|451)/.test(message)) return true;
  if (/access\s+(?:forbidden|denied)|\bforbidden\b/.test(message)) return true;
  return false;
}

function rpcAuthSendErrorSummary(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function publicSolanaRpcFallback(cluster: WorkflowCluster): string {
  switch (cluster) {
    case 'mainnet-beta':
      return 'https://api.mainnet-beta.solana.com';
    case 'testnet':
      return 'https://api.testnet.solana.com';
    case 'localnet':
      return 'http://127.0.0.1:8899';
    case 'devnet':
    default:
      return 'https://api.devnet.solana.com';
  }
}

async function handleSolanaSignatureStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'Solana signature status body');
  const cluster = requiredCluster(body.cluster);
  const txid = requiredBodyString(body.txid ?? body.signature, 'txid');
  const status = (await solanaConnection(cluster).getSignatureStatuses([txid], {
    searchTransactionHistory: true,
  })).value[0];
  if (!status) {
    writeJson(res, 200, { txStatus: 'pending', found: false });
    return;
  }
  if (status.err) {
    writeJson(res, 200, {
      txStatus: 'failed',
      found: true,
      confirmationStatus: status.confirmationStatus,
      error: JSON.stringify(status.err),
    });
    return;
  }
  if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
    writeJson(res, 200, { txStatus: 'confirmed', found: true, confirmationStatus: status.confirmationStatus });
    return;
  }
  writeJson(res, 200, { txStatus: 'pending', found: true, confirmationStatus: status.confirmationStatus });
}

async function handleSolanaParsedAccountInfo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'Solana parsed account info body');
  const cluster = requiredCluster(body.cluster);
  const address = requiredBodyString(body.address, 'address');
  let mint: PublicKey;
  try {
    mint = new PublicKey(address);
  } catch {
    throw new ApiError(400, 'address is not a valid Solana public key.');
  }
  const account = await solanaConnection(cluster).getParsedAccountInfo(mint, 'confirmed');
  if (!account.value) {
    writeJson(res, 200, { exists: false, owner: null, decimals: null });
    return;
  }
  const owner = account.value.owner.toBase58();
  const parsedData = account.value.data;
  const parsed = parsedData && typeof parsedData === 'object' && 'parsed' in parsedData
    ? (parsedData as { parsed?: { info?: { decimals?: unknown } } }).parsed
    : undefined;
  const rawDecimals = parsed?.info?.decimals;
  const decimals = typeof rawDecimals === 'number' && Number.isInteger(rawDecimals) && rawDecimals >= 0
    ? rawDecimals
    : null;
  writeJson(res, 200, { exists: true, owner, decimals });
}

async function handleSolanaWalletBalanceSummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'Solana wallet balance summary body');
  const cluster = requiredCluster(body.cluster);
  const walletAddress = normalizeWalletAddress(requiredBodyString(body, 'walletAddress'));
  const mode = body.mode === 'full' ? 'full' : 'primary';
  const rpcUrl = solanaRpcUrl(cluster);
  const service = new AgentWalletActionService({
    backend: readOnlyWalletBalanceBackend(walletAddress, cluster),
    config: {
      ...DEFAULT_CONFIG,
      cluster,
      rpcUrl,
    },
    connection: new Connection(rpcUrl, 'confirmed'),
  });
  writeJson(res, 200, await service.walletBalanceSummary({ mode }));
}

async function handleJupiterSwapExecute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'swap execute body');
  const signedTransaction = requiredBodyString(body, 'signedTransaction');
  const requestId = requiredBodyString(body, 'requestId');
  const lastValidBlockHeight = body.lastValidBlockHeight;
  const executeBody: Record<string, unknown> = {
    signedTransaction,
    requestId,
  };
  if (typeof lastValidBlockHeight === 'string' || typeof lastValidBlockHeight === 'number') {
    executeBody.lastValidBlockHeight = lastValidBlockHeight;
  }
  writeJson(res, 200, await requestJupiter(`${jupiterBaseUrl()}/execute`, {
    method: 'POST',
    body: executeBody,
  }));
}

async function handleBirdeyePriceMulti(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye price body');
  const addresses = requiredStringArray(body.addresses, 'addresses');
  const includeLiquidity = typeof body.includeLiquidity === 'boolean' ? body.includeLiquidity : true;
  const checkLiquidity = optionalNumberBodyField(body, 'checkLiquidity');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyePriceMulti(addresses, {
    includeLiquidity,
    checkLiquidity,
    uiAmountMode: birdeyeUiAmountMode(body.uiAmountMode),
  })));
}

async function handleBirdeyeSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye search body');
  const keyword = requiredBodyString(body.keyword ?? body.query, 'keyword');
  const limit = optionalIntegerBodyField(body, 'limit');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeSearch(keyword, { limit })));
}

async function handleBirdeyeTokenMetadata(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye token metadata body');
  const addresses = requiredStringArray(body.addresses, 'addresses');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeTokenMetadata(addresses)));
}

async function handleBirdeyeTokenSecurity(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye token security body');
  const address = requiredBodyString(body, 'address');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeTokenSecurity(address)));
}

async function handleBirdeyeWalletTokenList(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required for wallet token list.');
  }
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye wallet token list body');
  assertWalletMatchesSession(body.walletAddress ?? body.wallet, session.walletAddress, 'walletAddress');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeWalletTokenList(session.walletAddress, {
    uiAmountMode: birdeyeUiAmountMode(body.uiAmountMode),
  })));
}

async function handleBirdeyeTokenHolders(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye token holders body');
  const address = requiredBodyString(body, 'address');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeTokenHolders(address, {
    limit: optionalIntegerBodyField(body, 'limit'),
    offset: optionalIntegerBodyField(body, 'offset'),
  })));
}

async function handleBirdeyeTokenCreationInfo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye token creation body');
  const address = requiredBodyString(body, 'address');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeTokenCreationInfo(address)));
}

async function handleBirdeyeExitLiquidityMulti(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye exit-liquidity body');
  const addresses = requiredStringArray(body.addresses, 'addresses');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeExitLiquidityMulti(addresses)));
}

async function handleBirdeyePriceVolume(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye price-volume body');
  const addresses = optionalStringArray(body.addresses);
  if (addresses.length) {
    writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyePriceVolumeMulti(addresses, {
      type: birdeyePriceVolumeType(body.type),
      uiAmountMode: birdeyeUiAmountMode(body.uiAmountMode),
    })));
    return;
  }
  const address = requiredBodyString(body, 'address');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyePriceVolumeSingle(address, {
    type: birdeyePriceVolumeType(body.type),
  })));
}

async function handleBirdeyeHistoryPrice(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye history price body');
  const address = requiredBodyString(body, 'address');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeHistoryPrice(address, {
    addressType: body.addressType === 'pair' ? 'pair' : 'token',
    type: birdeyeHistoryPriceType(body.type),
    timeFrom: optionalIntegerBodyField(body, 'timeFrom'),
    timeTo: optionalIntegerBodyField(body, 'timeTo'),
  })));
}

async function handleBirdeyeOhlcv(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye OHLCV body');
  const address = requiredBodyString(body, 'address');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeOhlcv(address, {
    type: birdeyeOhlcvType(body.type),
    timeFrom: optionalIntegerBodyField(body, 'timeFrom'),
    timeTo: optionalIntegerBodyField(body, 'timeTo'),
    currency: body.currency === 'native' ? 'native' : 'usd',
  })));
}

async function handleBirdeyeTrending(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye trending body');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeTrendingTokens({
    limit: optionalIntegerBodyField(body, 'limit'),
    offset: optionalIntegerBodyField(body, 'offset'),
  })));
}

async function handleBirdeyeNewListings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye new listings body');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeNewListings({
    limit: optionalIntegerBodyField(body, 'limit'),
    timeTo: optionalIntegerBodyField(body, 'timeTo'),
    includeMeme: typeof body.includeMeme === 'boolean' ? body.includeMeme : undefined,
  })));
}

async function handleBirdeyeTokenListV3(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'BirdEye token list v3 body');
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyeTokenListV3({
    limit: optionalIntegerBodyField(body, 'limit'),
    offset: optionalIntegerBodyField(body, 'offset'),
    sortBy: birdeyeTokenListSortBy(body.sortBy),
    sortType: body.sortType === 'asc' ? 'asc' : body.sortType === 'desc' ? 'desc' : undefined,
    minLiquidity: optionalNumberBodyField(body, 'minLiquidity'),
    minVolume24hUsd: optionalNumberBodyField(body, 'minVolume24hUsd'),
    includeMeme: typeof body.includeMeme === 'boolean' ? body.includeMeme : undefined,
  })));
}

async function handleHeliusTransfersByAddress(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required for wallet transfer history.');
  }
  const body = asJsonRecord(await readJsonBody(req), 'Helius transfer history body');
  assertWalletMatchesSession(body.address ?? body.walletAddress, session.walletAddress, 'address');
  writeJson(res, 200, await requestHeliusForRender(() => getTransfersByAddress(session.walletAddress, {
    with: optionalBodyString(body, 'with'),
    direction: heliusTransferDirection(body.direction),
    mint: optionalBodyString(body, 'mint'),
    solMode: body.solMode === 'separate' ? 'separate' : body.solMode === 'merged' ? 'merged' : undefined,
    filters: heliusTransferFilters(body.filters),
    limit: optionalIntegerBodyField(body, 'limit'),
    paginationToken: optionalBodyString(body, 'paginationToken'),
    commitment: body.commitment === 'confirmed' || body.commitment === 'finalized' ? body.commitment : undefined,
    sortOrder: body.sortOrder === 'asc' ? 'asc' : body.sortOrder === 'desc' ? 'desc' : undefined,
  })));
}

async function handleCoinGeckoGlobal(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const snapshot = await requestCoinGeckoGlobal();
    writeJson(res, 200, snapshot);
  } catch (err) {
    const message = err instanceof Error ? redactSecrets(err.message) : 'CoinGecko request failed.';
    throw new ApiError(502, message);
  }
}

async function handleCoinGeckoRead(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'CoinGecko read body');
  writeJson(res, 200, await requestCoinGeckoForRender(() => requestCoinGeckoEndpoint({
    endpointId: requiredBodyString(body, 'endpointId'),
    pathParams: optionalPathParamRecord(body.pathParams, 'pathParams'),
    query: optionalScalarRecord(body.query, 'query'),
  })));
}

async function handleCoinGeckoTokenEvidence(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'CoinGecko token evidence body');
  writeJson(res, 200, await requestCoinGeckoForRender(() => requestCoinGeckoSolanaTokenEvidence({
    mint: optionalBodyString(body, 'mint'),
    mints: optionalStringArray(body.mints, 'mints'),
    network: optionalBodyString(body, 'network'),
    includeOnchain: typeof body.includeOnchain === 'boolean' ? body.includeOnchain : undefined,
    maxTokenDetails: optionalIntegerBodyField(body, 'maxTokenDetails'),
  })));
}

async function requestBirdeyeForRender(callback: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return await callback();
  } catch (err) {
    const message = err instanceof Error ? redactSecrets(err.message) : 'BirdEye request failed.';
    const status = message.includes('Missing BirdEye API key') ? 501 : 502;
    throw new ApiError(status, message);
  }
}

async function requestCoinGeckoForRender(callback: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return await callback();
  } catch (err) {
    const message = err instanceof Error ? redactSecrets(err.message) : 'CoinGecko request failed.';
    const status = message.includes('Missing CoinGecko') ? 501 : 502;
    throw new ApiError(status, message);
  }
}

function optionalScalarRecord(value: unknown, label: string): Record<string, string | number | boolean | undefined> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, `${label} must be a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      throw new ApiError(400, `${label}.${key} must be a string, number, or boolean.`);
    }
    out[key] = entry;
  }
  return out;
}

function optionalPathParamRecord(value: unknown, label: string): Record<string, string | number> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, `${label} must be a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'string' && typeof entry !== 'number') {
      throw new ApiError(400, `${label}.${key} must be a string or number.`);
    }
    out[key] = entry;
  }
  return out;
}

async function requestHeliusForRender(callback: () => Promise<unknown>): Promise<unknown> {
  try {
    return await callback();
  } catch (err) {
    const message = err instanceof Error ? redactSecrets(err.message) : 'Helius request failed.';
    const status = message.includes('Missing Helius') ? 501 : 502;
    throw new ApiError(status, message);
  }
}

function protocolErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const record = err as { name?: unknown; code?: unknown };
  if (record.name !== 'ProtocolError' && typeof record.code !== 'string') return undefined;
  return typeof record.code === 'string' ? record.code : undefined;
}

async function requestJupiter(
  url: URL | string,
  init: { method?: 'POST'; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const apiKey = jupiterApiKey();
  if (!apiKey) {
    throw new ApiError(501, 'Jupiter swap execution is not configured. Set JUPITER_API_KEY or JUP_API_KEY on the Render service.');
  }
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
  };
  if (init.body) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const payload = await response.json().catch(() => ({})) as unknown;
  const record = asJsonRecord(payload, 'Jupiter response');
  if (!response.ok) {
    throw new ApiError(502, `Jupiter request failed with HTTP ${response.status}: ${JSON.stringify(record)}`);
  }
  return record;
}

function jupiterBaseUrl(): string {
  return (
    process.env.JUPITER_SWAP_BASE_URL?.trim() ||
    process.env.JUP_ULTRA_BASE?.trim() ||
    process.env.JUPITER_BASE_URL?.trim() ||
    'https://api.jup.ag/swap/v2'
  ).replace(/\/+$/, '');
}

function jupiterApiKey(): string | undefined {
  return process.env.JUPITER_API_KEY?.trim() || process.env.JUP_API_KEY?.trim() || undefined;
}

function solanaConnection(cluster: WorkflowCluster): Connection {
  return new Connection(solanaRpcUrl(cluster), 'confirmed');
}

function readOnlyWalletBalanceBackend(walletAddress: string, cluster: WorkflowCluster) {
  return {
    async capabilities() {
      return {
        backend: 'agentic-cloud-readonly',
        cluster: [cluster],
        address: walletAddress,
        supports: {
          signMessage: false,
          signTransaction: false,
          signAndSendTransaction: false,
          multiSign: false,
          simulationPreview: false,
        },
      };
    },
    async getAddress() {
      return walletAddress;
    },
    async submit() {
      throw new Error('Cloud balance reads cannot request wallet signatures.');
    },
    async poll() {
      throw new Error('Cloud balance reads cannot poll wallet approvals.');
    },
  };
}

function asJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new ApiError(400, `${label} must be a JSON object.`);
}

function requiredBodyString(bodyOrValue: Record<string, unknown> | unknown, key: string): string {
  const value = bodyOrValue && typeof bodyOrValue === 'object' && !Array.isArray(bodyOrValue)
    ? (bodyOrValue as Record<string, unknown>)[key]
    : bodyOrValue;
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new ApiError(400, `${key} is required.`);
}

function requiredStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError(400, `${key} must be an array.`);
  }
  const entries = value
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean);
  if (!entries.length) {
    throw new ApiError(400, `${key} must include at least one value.`);
  }
  return entries;
}

function optionalStringArray(value: unknown, key = 'addresses'): string[] {
  if (value === undefined || value === null) return [];
  return requiredStringArray(value, key);
}

type WorkflowCluster = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';

function requiredCluster(value: unknown): WorkflowCluster {
  if (value === 'mainnet-beta' || value === 'devnet' || value === 'testnet' || value === 'localnet') {
    return value;
  }
  throw new ApiError(400, 'cluster is required.');
}

function optionalIntegerBodyField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new ApiError(400, `${key} must be a non-negative integer.`);
  }
  return numeric;
}

function optionalNumberBodyField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ApiError(400, `${key} must be a number.`);
  }
  return numeric;
}

function optionalBodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function assertWalletMatchesSession(value: unknown, sessionWalletAddress: string, label: string): void {
  const raw = stringField(value).trim();
  if (!raw) return;
  let normalized: string;
  try {
    normalized = normalizeWalletAddress(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : `${label} must be a Solana public key.`;
    throw new ApiError(400, message);
  }
  if (normalized !== sessionWalletAddress) {
    throw new ApiError(403, `${label} must match the signed-in wallet.`);
  }
}

function birdeyeUiAmountMode(value: unknown): 'raw' | 'scaled' | 'both' | undefined {
  return value === 'raw' || value === 'scaled' || value === 'both' ? value : undefined;
}

function birdeyePriceVolumeType(value: unknown): BirdeyePriceVolumeType | undefined {
  return value === '1h' || value === '2h' || value === '4h' || value === '8h' || value === '24h' ? value : undefined;
}

function birdeyeHistoryPriceType(value: unknown): BirdeyeHistoryPriceType | undefined {
  return value === '1m' || value === '5m' || value === '15m' || value === '30m' ||
    value === '1H' || value === '2H' || value === '4H' || value === '8H' ||
    value === '12H' || value === '1D'
    ? value
    : undefined;
}

function birdeyeOhlcvType(value: unknown): BirdeyeOhlcvType | undefined {
  return value === '1m' || value === '3m' || value === '5m' || value === '15m' || value === '30m' ||
    value === '1H' || value === '2H' || value === '4H' || value === '6H' || value === '8H' ||
    value === '12H' || value === '1D' || value === '1W'
    ? value
    : undefined;
}

function birdeyeTokenListSortBy(value: unknown): BirdeyeTokenListSortBy | undefined {
  return value === 'liquidity' || value === 'market_cap' || value === 'fdv' ||
    value === 'v24hUSD' || value === 'v24hChangePercent' || value === 'price' ||
    value === 'priceChange24h' || value === 'trade24h' || value === 'uniqueWallet24h' ||
    value === 'last_trade_unix_time' || value === 'recent_listing_time'
    ? value
    : undefined;
}

function heliusTransferDirection(value: unknown): 'in' | 'out' | 'any' | undefined {
  return value === 'in' || value === 'out' || value === 'any' ? value : undefined;
}

function heliusTransferFilters(value: unknown): HeliusTransferFilters | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(heliusComparisonFilter(record.amount) ? { amount: heliusComparisonFilter(record.amount) } : {}),
    ...(heliusComparisonFilter(record.blockTime) ? { blockTime: heliusComparisonFilter(record.blockTime) } : {}),
    ...(heliusComparisonFilter(record.slot) ? { slot: heliusComparisonFilter(record.slot) } : {}),
  };
}

function heliusComparisonFilter(value: unknown): { gt?: number; gte?: number; lt?: number; lte?: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const filter = {
    ...(finiteNumber(record.gt) !== undefined ? { gt: finiteNumber(record.gt) } : {}),
    ...(finiteNumber(record.gte) !== undefined ? { gte: finiteNumber(record.gte) } : {}),
    ...(finiteNumber(record.lt) !== undefined ? { lt: finiteNumber(record.lt) } : {}),
    ...(finiteNumber(record.lte) !== undefined ? { lte: finiteNumber(record.lte) } : {}),
  };
  return Object.keys(filter).length ? filter : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : undefined;
  return numeric !== undefined && Number.isFinite(numeric) ? numeric : undefined;
}

function hostedSettings(input: HostedAiBody['settings']): HostedAiResolvedSettings {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'Missing hosted AI settings.');
  }
  const mode = stringField(input.mode).trim();
  if (mode === 'hosted-managed' || mode === 'managed') {
    const managed = managedHostedAiSettings();
    if (!managed) {
      throw new ApiError(501, 'Agentic hosted AI is not configured on this deployment.');
    }
    return managed;
  }
  const apiKey = stringField(input.apiKey).trim();
  if (!apiKey) {
    throw new ApiError(400, 'Missing AI API key.');
  }
  const providerId = stringField(input.provider).trim() || 'openai';
  if (!isHostedProviderId(providerId)) {
    throw new ApiError(400, 'Hosted BYOK supports preset providers only. Select OpenAI, Claude / Anthropic, Gemini, or OpenRouter.');
  }
  const provider = HOSTED_PROVIDER_PRESETS[providerId];
  const model = stringField(input.model).trim() || provider.defaultModel;
  if (model.length > 160) {
    throw new ApiError(400, 'AI model name is too long.');
  }
  return {
    apiKey,
    provider: provider.id,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    model,
    mode: 'hosted-byok',
  };
}

function managedHostedAiSettings(): HostedAiResolvedSettings | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  const apiKey = process.env.AGENTIC_HOSTED_AI_API_KEY?.trim()
    || process.env.AGENTIC_MANAGED_AI_API_KEY?.trim()
    || process.env.AGENTIC_AI_API_KEY?.trim()
    || anthropicKey
    || openAiKey
    || '';
  if (!apiKey) return null;

  const providerRaw = (process.env.AGENTIC_HOSTED_AI_PROVIDER
    ?? process.env.AGENTIC_AI_PROVIDER
    ?? (anthropicKey && apiKey === anthropicKey ? 'anthropic' : 'openai')).trim().toLowerCase();
  const providerId: HostedProviderId = isHostedProviderId(providerRaw) ? providerRaw : 'openai';
  const preset = HOSTED_PROVIDER_PRESETS[providerId];
  const apiFormat = managedAiApiFormat(process.env.AGENTIC_HOSTED_AI_API_FORMAT ?? process.env.AGENTIC_AI_API_FORMAT, preset.apiFormat);
  const baseUrl = (process.env.AGENTIC_HOSTED_AI_BASE_URL
    ?? process.env.AGENTIC_AI_BASE_URL
    ?? preset.baseUrl).trim();
  const model = (process.env.AGENTIC_HOSTED_AI_MODEL
    ?? process.env.AGENTIC_AI_MODEL
    ?? preset.defaultModel).trim();
  if (model.length > 160) {
    throw new ApiError(500, 'Managed hosted AI model name is too long.');
  }
  return {
    apiKey,
    provider: providerId,
    apiFormat,
    baseUrl,
    model,
    mode: 'hosted-managed',
  };
}

function managedAiApiFormat(value: string | undefined, fallback: AiApiFormat): AiApiFormat {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'anthropic') return 'anthropic';
  if (normalized === 'openai' || normalized === 'openai-compatible') return 'openai-compatible';
  return fallback;
}

function hostedPlanRequest(input: unknown): AiPlanRequest {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'Missing AI plan request.');
  }
  return input as AiPlanRequest;
}

function hostedReviewRequest(input: unknown): AiReviewRequest {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'Missing AI review request.');
  }
  return input as AiReviewRequest;
}

function hostedAskRequest(input: unknown): AiAskRequest {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'Missing AI ask request.');
  }
  const record = input as { question?: unknown; plan?: unknown };
  if (typeof record.question !== 'string' || !record.question.trim()) {
    throw new ApiError(400, 'Ask agent: a question is required.');
  }
  if (!record.plan || typeof record.plan !== 'object') {
    throw new ApiError(400, 'Ask agent: a plan is required.');
  }
  return input as AiAskRequest;
}

function hostedChatRequest(input: unknown): AiChatRequest {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'Missing AI chat request.');
  }
  const record = input as { messages?: unknown };
  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    throw new ApiError(400, 'Agent chat: a user message is required.');
  }
  return input as AiChatRequest;
}

function hostedReviewRequestForSession(input: unknown, walletAddress: string): AiReviewRequest {
  return withSessionWalletContext(hostedReviewRequest(input), walletAddress);
}

function hostedAskRequestForSession(input: unknown, walletAddress: string): AiAskRequest {
  return withSessionWalletContext(hostedAskRequest(input), walletAddress);
}

function hostedChatRequestForSession(input: unknown, walletAddress: string): AiChatRequest {
  return withSessionWalletContext(hostedChatRequest(input), walletAddress);
}

function withSessionWalletContext<T extends { walletAddress?: string; context?: Record<string, unknown>; cluster?: string }>(
  request: T,
  walletAddress: string,
): T {
  assertWalletMatchesSession(request.walletAddress, walletAddress, 'request.walletAddress');
  return {
    ...request,
    walletAddress,
    context: {
      ...(request.context ?? {}),
      connectedWallet: walletAddress,
      wallet: {
        address: walletAddress,
        publicKey: walletAddress,
        source: 'hosted_session',
        ...(request.cluster ? { cluster: request.cluster } : {}),
      },
    },
  };
}

async function handleHostedAiAskRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required for hosted AI agent ask.');
  }
  const body = await readJsonBody(req) as HostedAiAskBody;
  const settings = hostedSettings(body.settings);
  const request = hostedAskRequestForSession(body.request, session.walletAddress);
  const planner = new BridgeAiPlanner();

  try {
    planner.setSessionKey({
      apiKey: settings.apiKey,
      provider: settings.provider,
      apiFormat: settings.apiFormat,
      baseUrl: settings.baseUrl,
      model: settings.model,
    });
    writeJson(res, 200, await runWithHostedAiTimeout(planner.askAboutPlan(request)));
  } catch (err) {
    if (err instanceof ApiError) {
      writeJson(res, err.status, { error: err.message });
      return;
    }
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
    const status = code === 'invalid_request' ? 400 : 502;
    const message = err instanceof Error ? redactSecrets(err.message, settings.apiKey) : 'AI provider ask request failed.';
    writeJson(res, status, { error: message });
  }
}

async function handleHostedAiChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required for hosted AI agent chat.');
  }
  const body = await readJsonBody(req) as HostedAiChatBody;
  const settings = hostedSettings(body.settings);
  const request = hostedChatRequestForSession(body.request, session.walletAddress);
  const planner = new BridgeAiPlanner();

  try {
    planner.setSessionKey({
      apiKey: settings.apiKey,
      provider: settings.provider,
      apiFormat: settings.apiFormat,
      baseUrl: settings.baseUrl,
      model: settings.model,
    });
    writeJson(res, 200, await runWithHostedAiTimeout(planner.chat(request)));
  } catch (err) {
    if (err instanceof ApiError) {
      writeJson(res, err.status, { error: err.message });
      return;
    }
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
    const status = code === 'invalid_request' ? 400 : 502;
    const message = err instanceof Error ? redactSecrets(err.message, settings.apiKey) : 'AI provider chat request failed.';
    writeJson(res, status, { error: message });
  }
}

async function handleDeviceAgentStatus(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await requireDeviceAgentSession(req, store, clock);
  const current = renderDeviceAgentSessions.get(session.walletAddress);
  const state = current?.state ?? 'stopped';
  await recordDeviceAgentAudit(store, clock, session.walletAddress, 'device-agent.status.read', { state });
  writeJson(res, 200, deviceAgentStatusPayload(session.walletAddress));
}

async function handleDeviceAgentControl(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await requireDeviceAgentSession(req, store, clock);
  const body = await readJsonBody(req);
  let action: 'configure' | 'start' | 'stop' | 'clear';
  try {
    action = deviceAgentActionFromBody(body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      const rawAction = typeof body === 'object' && body !== null && 'action' in body
        ? String((body as { action?: unknown }).action)
        : '';
      console.warn('[device-agent] invalid request', {
        reason: 'unsupported_action',
        action: rawAction,
        walletShort: deviceAgentWalletShort(session.walletAddress),
      });
    }
    throw err;
  }
  const now = clock.now().toISOString();
  const current = renderDeviceAgentSessions.get(session.walletAddress);
  if (action === 'clear') {
    renderDeviceAgentSessions.delete(session.walletAddress);
    await recordDeviceAgentAudit(store, clock, session.walletAddress, 'device-agent.control.clear', {
      action,
      state: 'stopped',
    });
    writeJson(res, 200, deviceAgentStatusPayload(session.walletAddress, {
      configured: false,
      state: 'stopped',
      updatedAt: now,
    }));
    return;
  }
  const settings = deviceAgentSettingsFromBody(body);
  const configured = action === 'configure' || action === 'start'
    ? {
        configured: Boolean(settings.provider || settings.model || settings.baseUrl),
        state: action === 'start' ? 'running' as const : current?.state ?? 'stopped' as const,
        updatedAt: now,
        ...settings,
      }
    : {
        configured: current?.configured ?? false,
        state: action === 'stop' ? 'stopped' as const : 'running' as const,
        updatedAt: now,
        provider: current?.provider,
        apiFormat: current?.apiFormat,
        baseUrl: current?.baseUrl,
        model: current?.model,
      };
  renderDeviceAgentSessions.set(session.walletAddress, configured);
  await recordDeviceAgentAudit(store, clock, session.walletAddress, `device-agent.control.${action}`, {
    action,
    state: configured.state,
  });
  writeJson(res, 200, deviceAgentStatusPayload(session.walletAddress, configured));
}

async function requireDeviceAgentSession(
  req: IncomingMessage,
  store: WorkflowStore,
  clock: Clock,
): Promise<{ walletAddress: string }> {
  if (!deviceAgentFeatureEnabled()) {
    console.warn('[device-agent] access denied', { reason: 'feature_disabled' });
    throw new ApiError(403, 'Device Agent is not enabled on this server.');
  }
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    console.warn('[device-agent] access denied', { reason: 'no_session' });
    throw new ApiError(401, 'Sign in required for Device Agent.');
  }
  if (!isAllowedDeviceAgentWallet(session.walletAddress)) {
    console.warn('[device-agent] access denied', {
      reason: 'wallet_not_allowlisted',
      walletShort: deviceAgentWalletShort(session.walletAddress),
    });
    throw new ApiError(403, 'Device Agent is not enabled for this wallet.');
  }
  return { walletAddress: session.walletAddress };
}

function deviceAgentStatusPayload(walletAddress: string, override?: Partial<RenderDeviceAgentSession>): Record<string, unknown> {
  const status = {
    ...(renderDeviceAgentSessions.get(walletAddress) ?? {
      configured: false,
      state: 'stopped' as const,
      updatedAt: new Date(0).toISOString(),
    }),
    ...(override ?? {}),
  };
  return {
    available: true,
    enabled: true,
    configured: status.configured,
    state: status.state,
    runtime: 'render-gated',
    runtimes: deviceAgentRuntimeAvailability(),
    walletAddress,
    ...(status.provider ? { provider: status.provider } : {}),
    ...(status.apiFormat ? { apiFormat: status.apiFormat } : {}),
    ...(status.baseUrl ? { baseUrl: status.baseUrl } : {}),
    ...(status.model ? { model: status.model } : {}),
    message: 'Device Agent runtime is gated on Render; no cloud daemon is started.',
    updatedAt: status.updatedAt,
  };
}

function deviceAgentActionFromBody(body: unknown): 'configure' | 'start' | 'stop' | 'clear' {
  const action = typeof body === 'object' && body !== null && 'action' in body
    ? String((body as { action?: unknown }).action)
    : '';
  if (action === 'configure' || action === 'start' || action === 'stop' || action === 'clear') {
    return action;
  }
  throw new ApiError(400, 'Unsupported Device Agent control action.');
}

function deviceAgentSettingsFromBody(body: unknown): Partial<RenderDeviceAgentSession> {
  const settings = typeof body === 'object' && body !== null && 'settings' in body
    ? (body as { settings?: unknown }).settings
    : undefined;
  if (!settings || typeof settings !== 'object') return {};
  const input = settings as Record<string, unknown>;
  return {
    ...(typeof input.provider === 'string' && input.provider.trim() ? { provider: input.provider.trim() } : {}),
    ...(typeof input.apiFormat === 'string' && input.apiFormat.trim() ? { apiFormat: input.apiFormat.trim() } : {}),
    ...(typeof input.baseUrl === 'string' && input.baseUrl.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim() } : {}),
  };
}

function deviceAgentWalletShort(walletAddress: string): string {
  if (walletAddress.length <= 8) return walletAddress;
  return `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}`;
}

type DeviceAgentAuditType =
  | 'device-agent.status.read'
  | 'device-agent.control.configure'
  | 'device-agent.control.start'
  | 'device-agent.control.stop'
  | 'device-agent.control.clear';

async function recordDeviceAgentAudit(
  store: WorkflowStore,
  clock: Clock,
  walletAddress: string,
  type: DeviceAgentAuditType,
  extras: Record<string, string> = {},
): Promise<void> {
  // Audit is observability, not a security boundary. A failure (DB outage, transient store
  // error) must not abort the user-facing status/control response — the operation already
  // succeeded by the time we reach this call. Log the miss for operators and continue.
  try {
    await store.forWallet(walletAddress).insertAuditEvent({
      id: randomUUID(),
      type,
      createdAt: clock.now().toISOString(),
      metadata: { runtime: 'render-gated', ...extras },
    });
  } catch (err) {
    console.warn('[device-agent] audit failure', {
      type,
      walletShort: deviceAgentWalletShort(walletAddress),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleGetAgentPolicies(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required to read agent policies.');
  }
  const policyStore = isAgentPolicyStore(store) ? store : undefined;
  if (!policyStore) {
    writeJson(res, 200, { policies: [], version: 0, updatedAt: null });
    return;
  }
  const state = await policyStore.getAgentPolicies(session.walletAddress);
  if (!state) {
    writeJson(res, 200, { policies: [], version: 0, updatedAt: null });
    return;
  }
  writeJson(res, 200, {
    policies: state.policies,
    version: state.version,
    updatedAt: state.updatedAt,
  });
}

async function handlePutAgentPolicies(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required to save agent policies.');
  }
  const policyStore = isAgentPolicyStore(store) ? store : undefined;
  if (!policyStore) {
    throw new ApiError(503, 'Agent policy storage is not configured on this server.');
  }
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Missing agent policies payload.');
  }
  const record = body as { policies?: unknown; version?: unknown };
  if (!Array.isArray(record.policies)) {
    throw new ApiError(400, 'Agent policies payload must include a "policies" array.');
  }
  if (record.policies.length > 50) {
    throw new ApiError(400, 'Too many agent policies. Limit is 50.');
  }
  const existing = await policyStore.getAgentPolicies(session.walletAddress);
  const nextVersion = (existing?.version ?? 0) + 1;
  const saved = await policyStore.saveAgentPolicies(session.walletAddress, {
    policies: record.policies,
    updatedAt: clock.now().toISOString(),
    version: nextVersion,
  });
  writeJson(res, 200, {
    policies: saved.policies,
    version: saved.version,
    updatedAt: saved.updatedAt,
  });
}

async function handleListPreferences(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required to read preferences.');
  }
  const preferenceStore = isCloudPreferencesStore(store) ? store : undefined;
  if (!preferenceStore) {
    writeJson(res, 200, { preferences: [] });
    return;
  }
  const preferences = await preferenceStore.listPreferences(session.walletAddress, [...CLOUD_PREFERENCE_NAMESPACES]);
  writeJson(res, 200, { preferences });
}

async function handleGetPreference(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
  namespace: CloudPreferenceNamespace,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required to read preferences.');
  }
  const preferenceStore = isCloudPreferencesStore(store) ? store : undefined;
  if (!preferenceStore) {
    writeJson(res, 200, { namespace, payload: null, version: 0, updatedAt: null });
    return;
  }
  const preference = await preferenceStore.getPreference(session.walletAddress, namespace);
  writeJson(res, 200, preference ?? { namespace, payload: null, version: 0, updatedAt: null });
}

async function handlePutPreference(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
  namespace: CloudPreferenceNamespace,
): Promise<void> {
  if (namespace === 'agent-payment-profile') {
    throw new ApiError(405, 'Use /api/agents/profile (signed) to update this preference.');
  }
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required to save preferences.');
  }
  const preferenceStore = isCloudPreferencesStore(store) ? store : undefined;
  if (!preferenceStore) {
    throw new ApiError(503, 'Preference storage is not configured on this server.');
  }
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Missing preference payload.');
  }
  const payload = (body as { payload?: unknown }).payload;
  validatePreferencePayload(namespace, payload);
  const existing = await preferenceStore.getPreference(session.walletAddress, namespace);
  const saved = await preferenceStore.savePreference(session.walletAddress, {
    namespace,
    payload,
    updatedAt: clock.now().toISOString(),
    version: (existing?.version ?? 0) + 1,
  });
  writeJson(res, 200, saved);
}

function isAgentPolicyStore(store: unknown): store is { getAgentPolicies: (wallet: string) => Promise<{ policies: unknown[]; updatedAt: string; version: number } | undefined>; saveAgentPolicies: (wallet: string, state: { policies: unknown[]; updatedAt: string; version: number }) => Promise<{ policies: unknown[]; updatedAt: string; version: number }> } {
  if (!store || typeof store !== 'object') return false;
  const record = store as Record<string, unknown>;
  return typeof record.getAgentPolicies === 'function' && typeof record.saveAgentPolicies === 'function';
}

function isCloudPreferencesStore(store: unknown): store is CloudPreferencesStore {
  if (!store || typeof store !== 'object') return false;
  const record = store as Record<string, unknown>;
  return typeof record.listPreferences === 'function' &&
    typeof record.getPreference === 'function' &&
    typeof record.savePreference === 'function';
}

function buildConnectorSecretsService(store: unknown): ConnectorSecretsService | undefined {
  if (!isCloudPreferencesStore(store)) return undefined;
  try {
    const kek = resolveConnectorSecretsKek();
    return createConnectorSecretsService({ store, kek });
  } catch (err) {
    if (err instanceof ConnectorSecretsError) {
      // KEK not configured — connector-secrets feature stays disabled; reads
      // and writes will fall back to the env-based adapter factories.
      return undefined;
    }
    throw err;
  }
}

const CONNECTOR_SECRET_PATH = /^\/api\/connector-secrets\/([^/]+)$/;

function connectorIdFromPath(pathname: string): ByoKeyConnectorId | null {
  const match = CONNECTOR_SECRET_PATH.exec(pathname);
  if (!match) return null;
  const id = decodeURIComponent(match[1] ?? '');
  return isByoKeyConnectorId(id) ? id : null;
}

async function handleListConnectorSecrets(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
  service: ConnectorSecretsService | undefined,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required to read connector keys.');
  }
  if (!service) {
    writeJson(res, 200, { secrets: emptyConnectorSecretsSummary(), available: false });
    return;
  }
  const summary = await service.list(session.walletAddress);
  writeJson(res, 200, { secrets: summary, available: true });
}

async function handlePostConnectorSecret(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
  service: ConnectorSecretsService | undefined,
  connector: ByoKeyConnectorId,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required to save connector keys.');
  }
  if (!service) {
    throw new ApiError(503, 'Connector key storage is not configured on this server.');
  }
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Missing connector key payload.');
  }
  const apiKey = typeof (body as { apiKey?: unknown }).apiKey === 'string'
    ? ((body as { apiKey: string }).apiKey).trim()
    : '';
  if (!apiKey) {
    throw new ApiError(400, 'apiKey is required.');
  }
  if (apiKey.length > 1024) {
    throw new ApiError(400, 'apiKey is too long.');
  }
  const baseUrlRaw = (body as { baseUrl?: unknown }).baseUrl;
  let baseUrl: string | undefined;
  if (typeof baseUrlRaw === 'string' && baseUrlRaw.trim()) {
    const trimmed = baseUrlRaw.trim();
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('protocol');
      }
      baseUrl = trimmed;
    } catch {
      throw new ApiError(400, 'baseUrl must be a valid http(s) URL.');
    }
  }
  const summary = await service.save(session.walletAddress, connector, {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  });
  writeJson(res, 200, { connector, ...summary });
}

async function handleDeleteConnectorSecret(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  clock: Clock,
  service: ConnectorSecretsService | undefined,
  connector: ByoKeyConnectorId,
): Promise<void> {
  const session = await sessionFromRequest({ req, store, clock });
  if (!session) {
    throw new ApiError(401, 'Sign in required to remove connector keys.');
  }
  if (!service) {
    throw new ApiError(503, 'Connector key storage is not configured on this server.');
  }
  const removed = await service.delete(session.walletAddress, connector);
  writeJson(res, 200, { connector, removed });
}


function preferenceNamespaceFromPath(pathname: string): CloudPreferenceNamespace | null {
  const match = /^\/api\/preferences\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  const namespace = decodeURIComponent(match[1] ?? '');
  return isCloudPreferenceNamespace(namespace) ? namespace : null;
}

function isCloudPreferenceNamespace(value: string): value is CloudPreferenceNamespace {
  return (CLOUD_PREFERENCE_NAMESPACES as readonly string[]).includes(value);
}

function validatePreferencePayload(namespace: CloudPreferenceNamespace, payload: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
  if (bytes > MAX_PREFERENCE_JSON_BYTES) {
    throw new ApiError(400, 'Preference payload is too large.');
  }
  if (namespace === 'agent-policies') {
    if (!Array.isArray(payload)) {
      throw new ApiError(400, 'Agent policies preference must be an array.');
    }
    if (payload.length > 50) {
      throw new ApiError(400, 'Too many agent policies. Limit is 50.');
    }
    return;
  }
  if (namespace === 'mpp-config') {
    validateMppConfigPreferencePayload(payload);
    return;
  }
  if (!payload || typeof payload !== 'object') {
    throw new ApiError(400, 'Preference payload must be a JSON object or array.');
  }
}

function validateMppConfigPreferencePayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError(400, 'MPP config preference must be a JSON object.');
  }
  const record = payload as Record<string, unknown>;
  validateOptionalStringArray(record.acceptedRails, 'acceptedRails', 16);
  validateOptionalStringArray(record.allowedMints, 'allowedMints', 64);
  validateOptionalString(record.maxChallengeAmount, 'maxChallengeAmount', 64);
  validateOptionalString(record.endpoint, 'endpoint', 512);
  if (Array.isArray(record.acceptedRails)) {
    const validRails = record.acceptedRails.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
    if (validRails.length === 0) throw new ApiError(400, 'acceptedRails must include at least one supported rail.');
    for (const [index, rail] of validRails.entries()) {
      validateMppRailEntry(rail, `acceptedRails[${index}]`);
    }
  }
  validateDecimalString(record.maxChallengeAmount, 'maxChallengeAmount');
  validatePublicKeyList(record.allowedMints, 'allowedMints');
  validateUrlString(record.endpoint, 'endpoint');
  if (record.sessionPolicy !== undefined) {
    validateMppSessionPolicyPayload(record.sessionPolicy);
  }
}

function validateMppSessionPolicyPayload(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'MPP sessionPolicy must be a JSON object.');
  }
  const policy = value as Record<string, unknown>;
  validateOptionalStringArray(policy.allowedMerchantIds, 'sessionPolicy.allowedMerchantIds', 128);
  validateOptionalStringArray(policy.allowedMerchantOrigins, 'sessionPolicy.allowedMerchantOrigins', 128);
  validateOptionalStringArray(policy.allowedMerchantUrls, 'sessionPolicy.allowedMerchantUrls', 128);
  validateOptionalStringArray(policy.allowedResourceOrigins, 'sessionPolicy.allowedResourceOrigins', 128);
  validateOptionalStringArray(policy.allowedResourceUrls, 'sessionPolicy.allowedResourceUrls', 128);
  validateOptionalStringArray(policy.allowedOrigins, 'sessionPolicy.allowedOrigins', 128);
  validateOptionalStringArray(policy.allowedRecipients, 'sessionPolicy.allowedRecipients', 128);
  validateOptionalString(policy.maxAmount, 'sessionPolicy.maxAmount', 64);
  validateOriginList(policy.allowedMerchantOrigins, 'sessionPolicy.allowedMerchantOrigins');
  validateOriginList(policy.allowedResourceOrigins, 'sessionPolicy.allowedResourceOrigins');
  validateOriginList(policy.allowedOrigins, 'sessionPolicy.allowedOrigins');
  validateUrlList(policy.allowedMerchantUrls, 'sessionPolicy.allowedMerchantUrls');
  validateUrlList(policy.allowedResourceUrls, 'sessionPolicy.allowedResourceUrls');
  validatePublicKeyList(policy.allowedRecipients, 'sessionPolicy.allowedRecipients');
  validateDecimalString(policy.maxAmount, 'sessionPolicy.maxAmount');
  if (policy.requireSettlementConfirmed !== undefined && typeof policy.requireSettlementConfirmed !== 'boolean') {
    throw new ApiError(400, 'sessionPolicy.requireSettlementConfirmed must be a boolean.');
  }
}

function validateMppRailEntry(value: string, field: string): void {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'sol' || normalized === 'solana-sol') return;
  if (normalized === 'usdc' || normalized === 'spl' || normalized === 'solana-spl') return;
  validatePublicKey(value, field);
}

function validateDecimalString(value: unknown, field: string): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a decimal string.`);
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(trimmed)) {
    throw new ApiError(400, `${field} must be a positive decimal string.`);
  }
}

function validatePublicKeyList(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return;
  for (const [index, entry] of value.entries()) {
    validatePublicKey(entry, `${field}[${index}]`);
  }
}

function validatePublicKey(value: unknown, field: string): void {
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a Solana public key.`);
  try {
    new PublicKey(value.trim());
  } catch {
    throw new ApiError(400, `${field} must be a valid Solana public key.`);
  }
}

function validateOriginList(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return;
  for (const [index, entry] of value.entries()) {
    validateOriginString(entry, `${field}[${index}]`);
  }
}

function validateOriginString(value: unknown, field: string): void {
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be an origin URL.`);
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiError(400, `${field} must be a valid http(s) origin.`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== trimmed.replace(/\/+$/, '')) {
    throw new ApiError(400, `${field} must be an http(s) origin without a path.`);
  }
}

function validateUrlList(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return;
  for (const [index, entry] of value.entries()) {
    validateUrlString(entry, `${field}[${index}]`);
  }
}

function validateUrlString(value: unknown, field: string): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a URL.`);
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new ApiError(400, `${field} must be a valid http(s) URL.`);
  }
}

function validateOptionalStringArray(value: unknown, field: string, maxItems: number): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new ApiError(400, `${field} must be an array.`);
  if (value.length > maxItems) throw new ApiError(400, `${field} has too many entries.`);
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 512) {
      throw new ApiError(400, `${field} entries must be non-empty strings under 512 characters.`);
    }
  }
}

function validateOptionalString(value: unknown, field: string, maxLength: number): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ApiError(400, `${field} must be a string under ${maxLength} characters.`);
  }
}

interface CloudWorkspaceDeleteRequest {
  walletAddress: string;
  nonce: string;
  message: string;
  signature: string;
  domain: string;
  issuedAt: string;
  expiresAt: string;
  signatureEncoding: 'base58' | 'base64';
  proofEncoding?: 'utf8-message' | 'tx-memo-proof';
  proofTxBase64?: string;
}

function parseCloudWorkspaceDeleteRequest(input: unknown, fallbackWalletAddress: string): CloudWorkspaceDeleteRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'Missing cloud workspace deletion request.');
  }
  const record = input as Record<string, unknown>;
  return {
    walletAddress: record.walletAddress === undefined
      ? fallbackWalletAddress
      : normalizeWalletAddress(record.walletAddress),
    nonce: requiredDeleteString(record.nonce, 'Missing deletion nonce.'),
    message: requiredDeleteString(record.message, 'Missing signed deletion message.'),
    signature: requiredDeleteString(record.signature, 'Missing wallet signature.'),
    domain: requiredDeleteString(record.domain, 'Missing signed domain.'),
    issuedAt: requiredDeleteString(record.issuedAt, 'Missing signed issued time.'),
    expiresAt: requiredDeleteString(record.expiresAt, 'Missing signed expiration time.'),
    signatureEncoding: parseSignatureEncoding(record.signatureEncoding),
    ...parseProofEncodingFields(record),
  };
}

function parseProofEncodingFields(record: Record<string, unknown>): { proofEncoding?: 'utf8-message' | 'tx-memo-proof'; proofTxBase64?: string } {
  const encoding = record.proofEncoding;
  if (encoding === undefined || encoding === null || encoding === '') return {};
  if (encoding !== 'utf8-message' && encoding !== 'tx-memo-proof') {
    throw new ApiError(400, 'Unsupported proof encoding.');
  }
  const out: { proofEncoding: 'utf8-message' | 'tx-memo-proof'; proofTxBase64?: string } = { proofEncoding: encoding };
  const tx = stringField(record.proofTxBase64).trim();
  if (tx) out.proofTxBase64 = tx;
  return out;
}

function requiredDeleteString(value: unknown, message: string): string {
  const stringValue = stringField(value).trim();
  if (!stringValue) {
    throw new ApiError(400, message);
  }
  return stringValue;
}

function parseSignatureEncoding(value: unknown): 'base58' | 'base64' {
  if (value === undefined || value === 'base58') return 'base58';
  if (value === 'base64') return 'base64';
  throw new ApiError(400, 'Unsupported wallet signature encoding.');
}

async function deleteCloudWorkspaceRecords(
  walletAddress: string,
  store: WorkflowStore,
  _workflowStore: WorkflowStore & OneTimeWorkflowStore,
  evidenceStore: EvidenceStore,
  recurringStore: RecurringStore,
): Promise<CloudWorkspaceDeleteCounts> {
  if (!isCloudWorkspaceDeleteStore(store)) {
    throw new ApiError(501, 'Cloud workspace deletion is not supported by the configured store.');
  }
  const counts = await store.deleteCloudWorkspace(walletAddress);
  if ((evidenceStore as unknown) !== store) {
    counts.evidenceReceipts += await evidenceStore.deleteAllEvidence(walletAddress);
  }
  if ((recurringStore as unknown) !== store) {
    const recurringCounts = await recurringStore.deleteAllRecurringData(walletAddress);
    counts.recurringSchedules += recurringCounts.recurringSchedules;
    counts.recurringOccurrences += recurringCounts.recurringOccurrences;
    counts.recurringNotificationDeliveries += recurringCounts.recurringNotificationDeliveries;
  }
  return counts;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw new ApiError(413, 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON.');
  }
}

function requireMethod(req: IncomingMessage, method: string): void {
  if (req.method !== method) {
    throw new ApiError(405, 'method_not_allowed');
  }
}

function requestDomain(req: IncomingMessage, url: URL): string {
  if (process.env.AGENTIC_PUBLIC_ORIGIN) {
    return new URL(process.env.AGENTIC_PUBLIC_ORIGIN).host.toLowerCase();
  }
  return String(req.headers.host || url.host).toLowerCase();
}

export function rateLimitKey(req: IncomingMessage): string {
  // X-Forwarded-For is a comma-separated chain that each hop APPENDS to.
  // Render's edge runs as the outermost trusted proxy, so it appends the
  // observed TCP-peer IP after whatever the client sent. Taking the LAST
  // entry gives the edge-asserted client IP that a malicious client can't
  // spoof (anything BEFORE it is attacker-controllable). If the header is
  // missing (direct connection in local dev), fall back to the socket peer.
  const forwardedFor = firstHeaderValue(req.headers['x-forwarded-for']);
  if (forwardedFor) {
    const hops = forwardedFor.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1]!;
  }
  return req.socket.remoteAddress || 'unknown';
}

function shouldSetSecureCookie(req: IncomingMessage): boolean {
  return isSecureRequest(req) ||
    isProductionRequest() ||
    publicOriginUsesHttps();
}

function shouldReturnBearerSession(req: IncomingMessage): boolean {
  const origin = firstHeaderValue(req.headers.origin);
  const client = firstHeaderValue(req.headers['x-agentic-client'])?.toLowerCase();
  // android-bundled — Android TWA + loopback-cors. Requires CORS-allowed Origin.
  // ios-bundled — Capacitor iOS webview. Same bearer pattern as Android,
  //   but its custom-scheme Origin serializes as capacitor://localhost.
  // desktop-bundled — Tauri 2 webview. Same trust model as android-bundled:
  //   the bearer is only handed back when the request originates from a
  //   webview origin we explicitly recognize (tauri://localhost,
  //   http://tauri.localhost, https://tauri.localhost, or the dev Vite origin
  //   when running locally). Chromium emits `Origin: null` for some custom-
  //   scheme requests; isAllowedRequestOrigin handles that fallback when the
  //   client identifier matches a desktop bundle.
  // cli-bundled — Solana Agent Wallet CLI loopback callback. No Origin header is
  //   sent because the request originates from a CLI process; accept the client
  //   identifier alone because the CLI is local-only and the bearer is delivered
  //   straight back to the loopback receiver the caller spun up.
  if (client === 'cli-bundled') return true;
  if (client !== 'android-bundled' && client !== 'ios-bundled' && client !== 'desktop-bundled') return false;
  return isAllowedRequestOrigin(origin, client);
}

function isProductionRequest(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
}

function publicOriginUsesHttps(): boolean {
  if (!process.env.AGENTIC_PUBLIC_ORIGIN) return false;
  try {
    return new URL(process.env.AGENTIC_PUBLIC_ORIGIN).protocol === 'https:';
  } catch {
    return false;
  }
}

function isHostedProviderId(value: string): value is HostedProviderId {
  return value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'openrouter';
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  const trimmed = header?.trim();
  return trimmed || undefined;
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// Race `promise` against a timer. Resolves with the promise's value if it
// settles first; throws `ApiError(504, ...)` if the timer fires first.
// Note: this DOES NOT cancel the underlying work (the LLM HTTP request keeps
// running in the planner until it completes or its own TCP timeout fires).
// What it gives us is bounded client-facing latency + a freed Render HTTP
// socket — sufficient defense against upstream-LLM pileup. A true cancel
// would need AbortSignal plumbed through BridgeAiPlanner; out-of-scope here.
//
// `timeoutMs` defaults to HOSTED_AI_TIMEOUT_MS (45s) for production callers.
// Tests can override with a tighter value (e.g. 25ms) to exercise the timeout
// path without sleeping.
export async function runWithHostedAiTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = HOSTED_AI_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new ApiError(504, 'AI provider timed out.')),
        timeoutMs,
      );
      promise.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const ONE_TIME_WORKFLOW_METHODS: Array<keyof OneTimeWorkflowStore> = [
  'listPlans',
  'getPlan',
  'savePlan',
  'deletePlan',
  'listApprovals',
  'getApproval',
  'saveApproval',
  'listCompleted',
  'getCompleted',
  'saveCompleted',
  'deleteCompleted',
  'appendAuditEvent',
];

function isOneTimeWorkflowStore(store: WorkflowStore): store is WorkflowStore & OneTimeWorkflowStore {
  const candidate = store as Partial<Record<keyof OneTimeWorkflowStore, unknown>>;
  return ONE_TIME_WORKFLOW_METHODS.every((method) => typeof candidate[method] === 'function');
}

function requireOneTimeWorkflowStore(store: WorkflowStore): WorkflowStore & OneTimeWorkflowStore {
  if (!isOneTimeWorkflowStore(store)) {
    throw new Error('Configured workflow store does not implement one-time workflow records.');
  }
  return store;
}

function isEvidenceStore(store: WorkflowStore): store is WorkflowStore & EvidenceStore {
  return typeof (store as Partial<EvidenceStore>).listEvidence === 'function';
}

function isRecurringStore(store: WorkflowStore): store is WorkflowStore & RecurringStore {
  return typeof (store as Partial<RecurringStore>).listSchedules === 'function';
}

function isCloudWorkspaceDeleteStore(store: WorkflowStore): store is WorkflowStore & CloudWorkspaceDeleteStore {
  return typeof (store as Partial<CloudWorkspaceDeleteStore>).deleteCloudWorkspace === 'function';
}
