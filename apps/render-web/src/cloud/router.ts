import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  BridgeAiPlanner,
  type AiApiFormat,
  type AiPlanRequest,
} from '@solana-agent-wallet-adapter/mcp-server';

import {
  AuthValidationError,
  buildWalletLoginMessage,
  createAuthNonceResponse,
  normalizeWalletAddress,
  parseVerifyWalletRequest,
  verifyWalletSignature,
} from './auth.js';
import { isSecureRequest, serializeClearSessionCookie, serializeSessionCookie } from './cookies.js';
import { createEvidenceApiHandler, evidenceStoreAdapterForCloudStore } from './evidenceRoutes.js';
import type { EvidenceStore } from './evidenceService.js';
import { MemoryWorkflowStore } from './memoryStore.js';
import { createRecurringApprovalSink, createRecurringApprovalStatusReader } from './recurringApprovalSink.js';
import { createRecurringApiHandler, recurringStoreAdapterForCloudStore } from './recurringRoutes.js';
import { RecurringService, type RecurringStore } from './recurringService.js';
import { RecurringScheduler } from './scheduler.js';
import { createWalletSession, deleteSessionFromRequest, SESSION_TTL_MS, sessionFromRequest } from './session.js';
import { sessionResponse, systemClock, type Clock, type WorkflowStore } from './store.js';
import { WorkflowService, type WorkflowStore as OneTimeWorkflowStore } from './workflowService.js';
import { createWorkflowApiHandler } from './workflowRoutes.js';

const MAX_JSON_BYTES = 64 * 1024;
const AUTH_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 60;

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

export interface CloudApiRouterOptions {
  store?: WorkflowStore;
  clock?: Clock;
  authRateLimiter?: AuthRateLimiter | false;
}

export interface CloudApiRouter {
  readonly store: WorkflowStore;
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

export interface AuthRateLimitInput {
  key: string;
  route: '/api/auth/nonce' | '/api/auth/verify-wallet';
  now: Date;
}

export interface AuthRateLimiter {
  allow(input: AuthRateLimitInput): boolean | Promise<boolean>;
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

export function createCloudApiRouter(options: CloudApiRouterOptions = {}): CloudApiRouter {
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
  const workflowService = new WorkflowService(workflowStore);
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
  const recurringService = new RecurringService(recurringStore, {
    approvalSink: createRecurringApprovalSink(workflowService),
    approvalStatusReader: createRecurringApprovalStatusReader(workflowStore),
  });
  const recurringApiHandler = createRecurringApiHandler({
    service: recurringService,
    getSession: sessionResolver,
  });
  if (process.env.AGENTIC_ENABLE_WEB_SCHEDULER === '1') {
    const recurringScheduler = new RecurringScheduler({
      service: recurringService,
      store: recurringStore,
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
        await enforceAuthRateLimit(req, url, clock, authRateLimiter);
        await routeApiRequest(
          req,
          res,
          url,
          store,
          clock,
          workflowApiHandler,
          evidenceApiHandler,
          recurringApiHandler,
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

class MemoryAuthRateLimiter implements AuthRateLimiter {
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();

  allow(input: AuthRateLimitInput): boolean {
    const bucketKey = `${input.route}:${input.key}`;
    const now = input.now.getTime();
    const bucket = this.buckets.get(bucketKey);
    if (!bucket || now - bucket.windowStart >= AUTH_RATE_LIMIT_WINDOW_MS) {
      this.buckets.set(bucketKey, { windowStart: now, count: 1 });
      return true;
    }
    if (bucket.count >= AUTH_RATE_LIMIT_MAX_ATTEMPTS) {
      return false;
    }
    bucket.count += 1;
    return true;
  }
}

function enforceSameOrigin(req: IncomingMessage, url: URL): void {
  if (!isStateChangingMethod(req.method)) return;
  const origin = firstHeaderValue(req.headers.origin);
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    throw new ApiError(403, 'Cross-origin requests are not allowed.');
  }
  if (originHost !== requestDomain(req, url)) {
    throw new ApiError(403, 'Cross-origin requests are not allowed.');
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
    throw new ApiError(429, 'Too many wallet auth attempts. Try again later.');
  }
}

function authRateLimitedRoute(pathname: string): AuthRateLimitInput['route'] | undefined {
  return pathname === '/api/auth/nonce' || pathname === '/api/auth/verify-wallet' ? pathname : undefined;
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
  workflowApiHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  evidenceApiHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  recurringApiHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
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
    });
    return;
  }

  if (url.pathname === '/api/ai/generate-plan') {
    requireMethod(req, 'POST');
    await handleHostedAiRequest(req, res);
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

  if (url.pathname === '/api/session') {
    requireMethod(req, 'GET');
    const session = await sessionFromRequest({ req, store, clock });
    writeJson(res, 200, sessionResponse(session));
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

async function handleHostedAiRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    process.env.NODE_ENV === 'production' ||
    process.env.RENDER === 'true' ||
    publicOriginUsesHttps();
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

function redactSecrets(value: string, exactSecret = ''): string {
  const secret = exactSecret.trim();
  const exactRedacted = secret ? value.split(secret).join('[redacted]') : value;
  return exactRedacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-proj-[A-Za-z0-9._-]{8,}/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/(api[-_ ]?key|token|secret)(["':=\s]+)([^"',\s]{8,})/gi, '$1$2[redacted]');
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function isOneTimeWorkflowStore(store: WorkflowStore): store is WorkflowStore & OneTimeWorkflowStore {
  return typeof (store as Partial<OneTimeWorkflowStore>).listPlans === 'function';
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
