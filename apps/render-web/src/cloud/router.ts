import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
  type AiPlanRequest,
  type AiReviewRequest,
  type BirdeyeHistoryPriceType,
  type BirdeyeOhlcvType,
  type BirdeyePriceVolumeType,
  type BirdeyeTokenListSortBy,
  type HeliusTransferFilters,
  type ConnectorFactReadInput,
  type DAppAdapterContext,
} from '@solana-agent-wallet-adapter/mcp-server';
import { Connection } from '@solana/web3.js';

import {
  AuthValidationError,
  buildCloudWorkspaceDeleteMessage,
  buildWalletLoginMessage,
  createAuthNonceResponse,
  createCloudWorkspaceDeleteIntentResponse,
  normalizeWalletAddress,
  parseVerifyWalletRequest,
  verifyWalletSignature,
} from './auth.js';
import { isSecureRequest, serializeClearSessionCookie, serializeSessionCookie } from './cookies.js';
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
import { createAgentBackgroundWatch } from './agentBackgroundWatch.js';
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
  createStatelessConnectorPreparer,
  type ConnectorTransactionPreparer,
  type StatelessConnectorTransactionPreparer,
} from './prepareConnectorTransaction.js';
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

const MAX_JSON_BYTES = 64 * 1024;
const AUTH_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 60;
const WRITE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const WRITE_RATE_LIMIT_MAX_ATTEMPTS = 180;
const HOSTED_AI_RATE_LIMIT_MAX_ATTEMPTS = 30;

const REGISTERED_API_ROUTES = [
  'GET /api/ai/status',
  'POST /api/ai/generate-plan',
  'POST /api/ai/review-plan',
  'POST /api/ai/ask-about-plan',
  'POST /api/auth/nonce',
  'POST /api/auth/verify-wallet',
  'POST /api/auth/logout',
  'POST /api/cloud-workspace/delete-intent',
  'POST /api/cloud-workspace/delete',
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
  'POST /api/swap/order',
  'POST /api/swap/execute',
  'POST /api/connector/prepare-transaction',
  'POST /api/connector/read-facts',
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

type ConnectorReadFactsRequest = ConnectorFactReadInput & {
  cluster: WorkflowCluster;
  walletAddress: string;
};

type WalletBackend = DAppAdapterContext['backend'];

export type StatelessConnectorFactsReader = (input: ConnectorReadFactsRequest) => Promise<Record<string, unknown>>;

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

class MemoryAuthRateLimiter implements AuthRateLimiter {
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();

  allow(input: AuthRateLimitInput): boolean {
    const bucketKey = `${input.route}:${input.key}`;
    const now = input.now.getTime();
    const bucket = this.buckets.get(bucketKey);
    const windowMs = rateLimitWindowMs(input.route);
    const maxAttempts = rateLimitMaxAttempts(input.route);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      this.buckets.set(bucketKey, { windowStart: now, count: 1 });
      return true;
    }
    if (bucket.count >= maxAttempts) {
      return false;
    }
    bucket.count += 1;
    return true;
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
  const workflowService = new WorkflowService(workflowStore, {
    ...(options.connectorPreparer ? { connectorPreparer: options.connectorPreparer } : {}),
  });
  const statelessConnectorPreparer = options.statelessConnectorPreparer ?? createStatelessConnectorPreparer();
  const statelessConnectorReader = options.statelessConnectorReader ?? createStatelessConnectorFactsReader();
  const workflowApiHandler = createWorkflowApiHandler({
    service: workflowService,
    getSession: sessionResolver,
  });
  const evidenceStore = isEvidenceStore(store) ? store : evidenceStoreAdapterForCloudStore(store);
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
          notificationService.enqueueOccurrenceReady(walletAddress, schedule.id, occurrence.id).then(() => undefined)
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
  return {
    store,
    async handle(req, res, url) {
      if (!url.pathname.startsWith('/api/')) {
        return false;
      }

      try {
        enforceSameOrigin(req, url);
        enforceJsonWriteRequest(req);
        await enforceAuthRateLimit(req, url, clock, authRateLimiter);
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
  if (origin) {
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
    throw new ApiError(429, route === '/api/ai/generate-plan' || route === '/api/ai/review-plan' || route === '/api/ai/ask-about-plan'
      ? 'Too many hosted AI drafting attempts. Try again later.'
      : route === '/api/auth/nonce' || route === '/api/auth/verify-wallet'
        ? 'Too many wallet auth attempts. Try again later.'
        : 'Too many workflow requests. Try again later.');
  }
}

function authRateLimitedRoute(pathname: string): AuthRateLimitInput['route'] | undefined {
  if (pathname === '/api/auth/nonce' || pathname === '/api/auth/verify-wallet') return pathname;
  if (pathname === '/api/ai/generate-plan') return pathname;
  if (pathname === '/api/ai/review-plan') return pathname;
  if (pathname === '/api/ai/ask-about-plan') return pathname;
  if (pathname.startsWith('/api/plans')) return '/api/plans:*';
  if (pathname.startsWith('/api/approvals')) return '/api/approvals:*';
  if (pathname.startsWith('/api/connector')) return '/api/approvals:*';
  if (pathname.startsWith('/api/recurring')) return '/api/recurring:*';
  if (pathname.startsWith('/api/evidence')) return '/api/evidence:*';
  if (pathname.startsWith('/api/swap')) return '/api/swap:*';
  if (pathname.startsWith('/api/birdeye')) return '/api/birdeye:*';
  if (pathname.startsWith('/api/helius')) return '/api/helius:*';
  if (pathname.startsWith('/api/coingecko')) return '/api/coingecko:*';
  if (pathname.startsWith('/api/cloud-workspace')) return '/api/cloud-workspace:*';
  if (pathname === '/api/auth/logout') return pathname;
  return undefined;
}

function rateLimitWindowMs(route: string): number {
  if (route === '/api/auth/nonce' || route === '/api/auth/verify-wallet') return AUTH_RATE_LIMIT_WINDOW_MS;
  return WRITE_RATE_LIMIT_WINDOW_MS;
}

function rateLimitMaxAttempts(route: string): number {
  if (route === '/api/auth/nonce' || route === '/api/auth/verify-wallet') return AUTH_RATE_LIMIT_MAX_ATTEMPTS;
  if (route === '/api/ai/generate-plan' || route === '/api/ai/review-plan' || route === '/api/ai/ask-about-plan') return HOSTED_AI_RATE_LIMIT_MAX_ATTEMPTS;
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
): Promise<void> {
  if (url.pathname === '/api/ai/status') {
    requireMethod(req, 'GET');
    writeJson(res, 200, {
      available: true,
      mode: 'hosted-byok',
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
  writeJson(res, 200, sessionResponse(session.record));
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
  res.setHeader('set-cookie', serializeClearSessionCookie(shouldSetSecureCookie(req)));
  writeJson(res, 200, { ok: true, signedOut: true, deleted });
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
    throw new ApiError(401, 'Sign in required for Hosted BYOK drafting.');
  }
  const body = await readJsonBody(req) as HostedAiBody;
  const settings = hostedSettings(body.settings);
  const request = hostedPlanRequest(body.request);
  const planner = new BridgeAiPlanner();

  try {
    planner.setSessionKey({
      apiKey: settings.apiKey,
      provider: settings.provider.id,
      apiFormat: settings.provider.apiFormat,
      baseUrl: settings.provider.baseUrl,
      model: settings.model,
    });
    writeJson(res, 200, await planner.generatePlan(request));
  } catch (err) {
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
    throw new ApiError(401, 'Sign in required for Hosted BYOK agent review.');
  }
  const body = await readJsonBody(req) as HostedAiReviewBody;
  const settings = hostedSettings(body.settings);
  const request = hostedReviewRequestForSession(body.request, session.walletAddress);
  const planner = new BridgeAiPlanner();

  try {
    planner.setSessionKey({
      apiKey: settings.apiKey,
      provider: settings.provider.id,
      apiFormat: settings.provider.apiFormat,
      baseUrl: settings.provider.baseUrl,
      model: settings.model,
    });
    writeJson(res, 200, await planner.reviewPlan(request));
  } catch (err) {
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
    : requiredBodyString(body, 'capability') as ConnectorFactReadInput['capability'];
  const input: ConnectorReadFactsRequest = {
    ...(body as unknown as ConnectorFactReadInput),
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
  const txid = await solanaConnection(cluster).sendRawTransaction(Buffer.from(signedTransaction, 'base64'), {
    preflightCommitment: 'confirmed',
    maxRetries: 5,
  });
  writeJson(res, 200, { txid, signature: txid });
}

async function handleSolanaSignatureStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonRecord(await readJsonBody(req), 'Solana signature status body');
  const cluster = requiredCluster(body.cluster);
  const txid = requiredBodyString(body.txid ?? body.signature, 'txid');
  const status = (await solanaConnection(cluster).getSignatureStatuses([txid], {
    searchTransactionHistory: true,
  })).value[0];
  if (!status) {
    writeJson(res, 200, { txStatus: 'pending' });
    return;
  }
  if (status.err) {
    writeJson(res, 200, {
      txStatus: 'failed',
      confirmationStatus: status.confirmationStatus,
      error: JSON.stringify(status.err),
    });
    return;
  }
  if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
    writeJson(res, 200, { txStatus: 'confirmed', confirmationStatus: status.confirmationStatus });
    return;
  }
  writeJson(res, 200, { txStatus: 'pending', confirmationStatus: status.confirmationStatus });
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
  writeJson(res, 200, await requestBirdeyeForRender(() => requestBirdeyePriceMulti(addresses, { includeLiquidity })));
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

function createStatelessConnectorFactsReader(): StatelessConnectorFactsReader {
  return async ({ cluster, walletAddress, ...input }) => {
    const rpcUrl = solanaRpcUrl(cluster);
    const service = new AgentWalletActionService({
      backend: readOnlyWalletBackend(walletAddress, cluster),
      config: {
        ...DEFAULT_CONFIG,
        cluster,
        rpcUrl,
      },
      connection: new Connection(rpcUrl, 'confirmed'),
    });
    return service.connectorReadFacts({
      ...input,
      walletAddress,
    });
  };
}

function readOnlyWalletBackend(walletAddress: string, cluster: WorkflowCluster): WalletBackend {
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
      throw new Error('Cloud connector reads cannot request wallet signatures.');
    },
    async poll() {
      throw new Error('Cloud connector reads cannot poll wallet approvals.');
    },
  };
}

function solanaRpcUrl(cluster: WorkflowCluster): string {
  if (process.env.SOLANA_RPC_URL?.trim()) return process.env.SOLANA_RPC_URL.trim();
  if (process.env.HELIUS_RPC_URL?.trim()) return process.env.HELIUS_RPC_URL.trim();
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

function hostedSettings(input: HostedAiBody['settings']): {
  apiKey: string;
  provider: HostedProviderPreset;
  model: string;
} {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'Missing hosted AI settings.');
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
  return { apiKey, provider, model };
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

function hostedReviewRequestForSession(input: unknown, walletAddress: string): AiReviewRequest {
  return withSessionWalletContext(hostedReviewRequest(input), walletAddress);
}

function hostedAskRequestForSession(input: unknown, walletAddress: string): AiAskRequest {
  return withSessionWalletContext(hostedAskRequest(input), walletAddress);
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
    throw new ApiError(401, 'Sign in required for Hosted BYOK agent ask.');
  }
  const body = await readJsonBody(req) as HostedAiAskBody;
  const settings = hostedSettings(body.settings);
  const request = hostedAskRequestForSession(body.request, session.walletAddress);
  const planner = new BridgeAiPlanner();

  try {
    planner.setSessionKey({
      apiKey: settings.apiKey,
      provider: settings.provider.id,
      apiFormat: settings.provider.apiFormat,
      baseUrl: settings.provider.baseUrl,
      model: settings.model,
    });
    writeJson(res, 200, await planner.askAboutPlan(request));
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
    const status = code === 'invalid_request' ? 400 : 502;
    const message = err instanceof Error ? redactSecrets(err.message, settings.apiKey) : 'AI provider ask request failed.';
    writeJson(res, status, { error: message });
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
  if (bytes > MAX_JSON_BYTES) {
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
  if (!payload || typeof payload !== 'object') {
    throw new ApiError(400, 'Preference payload must be a JSON object or array.');
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
  };
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

function rateLimitKey(req: IncomingMessage): string {
  const forwardedFor = firstHeaderValue(req.headers['x-forwarded-for']);
  const clientIp = forwardedFor?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  return clientIp;
}

function shouldSetSecureCookie(req: IncomingMessage): boolean {
  return isSecureRequest(req) ||
    isProductionRequest() ||
    publicOriginUsesHttps();
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
