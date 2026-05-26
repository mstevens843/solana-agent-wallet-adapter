import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';

import { createPairingHandler } from '../render-web/src/cloud/pairingHandler.js';
import {
  buildAgenticAgentCard,
  defaultAgenticCapabilities,
  hashProfilePayload,
  validateAgentCard,
  validateProfilePayload,
  type AgentCard,
  type AgentPaymentProfilePayload,
  type AgenticProtocol,
} from '@solana-agent-wallet-adapter/a2a-agent-card';
import {
  buildAcpOutboundReceipt,
  cartToTransferParams,
  hashCart,
  validateAcpCart,
  type AcpCart,
} from '@solana-agent-wallet-adapter/acp-adapter';
import { LAUNCH_SKILLS } from '@solana-agent-wallet-adapter/launch-skills';
import {
  finalizationRequirementForAction,
  type ApprovalRequestRecord,
  type FinalizationSupport,
  type JsonObject,
  type WorkflowCluster,
} from '@solana-agent-wallet-adapter/workflow';
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';
import type { Plugin, ViteDevServer } from 'vite';

type SkillManifest = DevLayer1.skills.SkillManifest;
type SkillInstallRecord = DevLayer1.skills.SkillInstallRecord;
type SkillInstallStatus = DevLayer1.skills.SkillInstallStatus;

const PREVIEW_PATH = '/api/acp/cart/preview';
const APPROVE_PATH = '/api/acp/cart/approve';
const RECEIPT_PATH_RE = /^\/api\/acp\/cart\/([A-Za-z0-9_-]+)\/receipt$/;
const ACP_OUTBOUND_SOURCE = 'acp_outbound';
const SKILLS_PREFIX = '/api/skills';
const SKILLS_CATALOG_PATH = '/api/skills';
const SKILLS_MANIFESTS_PATH = '/api/skills/manifests';
const SKILLS_INSTALLS_PATH = '/api/skills/installs';
const SKILLS_AUTHOR_EARNINGS_RE = /^\/api\/skills\/authors\/([1-9A-HJ-NP-Za-km-z]{32,44})\/earnings$/;
const SKILLS_DETAIL_RE = /^\/api\/skills\/([a-z0-9][a-z0-9-]{0,63})$/;
const SKILLS_INSTALL_ACTION_RE = /^\/api\/skills\/installs\/([A-Za-z0-9_-]+)\/(pause|resume|uninstall)$/;
const AGGREGATOR_SKILL_RE = /^\/api\/aggregator\/skills\/([a-z0-9-]+)\/?$/;
const AGGREGATOR_WALLET_RE = /^\/api\/aggregator\/wallets\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/;
const STREAMING_PREFIX = '/api/streaming/';
const MPP_PREFIX = '/api/mpp/';
const AGENT_CARD_PREVIEW_PATH = '/api/agents/card';
const AGENT_CARD_PUBLIC_PATH = '/.well-known/agent.json';
const AGENT_PROFILE_NAMESPACE = 'agent-payment-profile';
const AGENT_PROFILE_PREFERENCE_PATH = `/api/preferences/${AGENT_PROFILE_NAMESPACE}`;
const AGENT_PROFILE_INTENT_PATH = '/api/agents/profile-intent';
const AGENT_PROFILE_WRITE_PATH = '/api/agents/profile';
const AGENT_PROFILE_NONCE_TTL_MS = 5 * 60 * 1000;
const PER_WALLET_AGENT_CARD_RE = /^\/agents\/([^/]+)\/card\.json$/;
const DEV_WALLET_HEADER = 'x-agentic-wallet-address';
const LOCAL_WALLET_FALLBACK = 'local-browser-wallet';
const LOCAL_AGENT_CARD_WALLET_FALLBACK = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
// Memory-only local dev fallback; production render-web still requires an operator key.
const LOCAL_STREAMING_DEV_KEY = 'YWdlbnRpYy1sb2NhbC1zdHJlYW1pbmctZGV2LTMyISE=';
const DEFAULT_AGENT_CARD_TOKENS = ['USDC', 'USDT', 'SOL'];
const MAX_JSON_BYTES = 64 * 1024;
const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const devApprovals = new Map<string, ApprovalRequestRecord>();
const localAgentProfiles = new Map<string, LocalAgentProfileRecord>();
const localAgentProfileIntents = new Map<string, LocalAgentProfileIntent>();
const localSkillCatalog = new Map<string, LocalSkillManifestRecord>();
const localSkillInstalls = new Map<string, SkillInstallRecord>();
let localStreamingApiPromise: Promise<LocalStreamingApi> | null = null;

interface LocalStreamingApiHandler {
  prefix: string;
  methods: readonly string[];
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    context: LocalStreamingApiContext,
  ) => Promise<boolean>;
}

interface LocalStreamingApiContext {
  walletAddress: string | undefined;
  workflowService: object;
  workflowStore: object;
  evidenceStore: object;
  clock: { now(): Date };
}

interface LocalStreamingApi {
  handlers: readonly LocalStreamingApiHandler[];
  context: Omit<LocalStreamingApiContext, 'walletAddress'>;
}

interface LocalStreamingRegistryModule {
  listDevApiHandlers(): readonly LocalStreamingApiHandler[];
}

interface LocalStreamingMemoryStoreModule {
  MemoryWorkflowStore: new () => object;
}

interface LocalStreamingWorkflowServiceModule {
  WorkflowService: new (store: object) => object;
}

interface LocalStreamingEvidenceStoreModule {
  MemoryEvidenceStore: new () => object;
}

interface LocalSkillManifestRecord {
  id: string;
  version: string;
  authorWallet: string;
  createdAt: string;
  updatedAt: string;
  manifest: SkillManifest;
}

interface LocalSkillInstallRow {
  install: SkillInstallRecord;
  manifest?: SkillManifest;
  recentExecutionCount: number;
  lastExecutionAt?: string;
  nextRunAt?: string;
  recurringScheduleStatus?: string;
}

interface LocalAgentProfileRecord {
  namespace: typeof AGENT_PROFILE_NAMESPACE;
  payload: AgentPaymentProfilePayload | null;
  updatedAt: string | null;
  version: number;
}

interface LocalAgentProfileIntent {
  nonce: string;
  message: string;
  domain: string;
  issuedAt: string;
  expiresAt: string;
  walletAddress: string;
  action: 'publish' | 'takedown';
  payloadHashHex?: string;
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large.');
    this.name = 'BodyTooLargeError';
  }
}

class InvalidJsonError extends Error {
  constructor() {
    super('Request body must be valid JSON.');
    this.name = 'InvalidJsonError';
  }
}

export function acpDevApiPlugin(): Plugin {
  seedLocalSkillsCatalog();
  return {
    name: 'browser-demo-local-dev-api',
    apply: 'serve',
    configureServer(server) {
      const localPairingHandler = createPairingHandler();
      server.httpServer?.once('close', () => localPairingHandler.shutdown());
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        try {
          if (url.pathname.startsWith('/api/pair/')) {
            const handled = await localPairingHandler.handle(req, res, url);
            if (!handled) next();
            return;
          }
          if (url.pathname.startsWith(STREAMING_PREFIX) || url.pathname.startsWith(MPP_PREFIX)) {
            const handled = await handleLocalStreamingApi(req, res, url, server);
            if (!handled) next();
            return;
          }
          if (await handleLocalAgentProfileApi(req, res, url)) {
            return;
          }
          if (handleLocalAgentCardApi(req, res, url)) {
            return;
          }
          if (url.pathname.startsWith('/api/acp/cart/')) {
            if (req.method !== 'POST') {
              writeJson(res, 405, { error: 'method_not_allowed', message: 'Use POST for ACP cart routes.' });
              return;
            }
            if (url.pathname === PREVIEW_PATH) {
              await handlePreview(req, res);
              return;
            }
            if (url.pathname === APPROVE_PATH) {
              await handleApprove(req, res);
              return;
            }
            const receiptMatch = RECEIPT_PATH_RE.exec(url.pathname);
            if (receiptMatch?.[1]) {
              await handleReceipt(req, res, receiptMatch[1]);
              return;
            }
            next();
            return;
          }
          if (url.pathname.startsWith(SKILLS_PREFIX) || url.pathname.startsWith('/api/aggregator/')) {
            const handled = await handleLocalSkillsApi(req, res, url);
            if (!handled) next();
            return;
          }
          next();
        } catch (err) {
          writeLocalDevError(res, err);
        }
      });
    },
  };
}

async function handleLocalStreamingApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  server: ViteDevServer,
): Promise<boolean> {
  const api = await localStreamingApi(server);
  const handler = api.handlers.find((candidate) => url.pathname.startsWith(candidate.prefix));
  if (!handler) return false;
  const method = req.method ?? 'GET';
  if (!handler.methods.includes(method)) {
    writeJson(res, 405, { error: 'method_not_allowed', message: 'Use GET, HEAD, or POST for local agent payment routes.' });
    return true;
  }
  return handler.handle(req, res, url, {
    ...api.context,
    walletAddress: walletAddressFromStreamingRequest(req, url),
  });
}

async function localStreamingApi(server: ViteDevServer): Promise<LocalStreamingApi> {
  localStreamingApiPromise ??= createLocalStreamingApi(server);
  return localStreamingApiPromise;
}

async function createLocalStreamingApi(server: ViteDevServer): Promise<LocalStreamingApi> {
  process.env.STREAMING_SESSION_ENCRYPTION_KEY ??= LOCAL_STREAMING_DEV_KEY;

  await Promise.all([
    server.ssrLoadModule(renderWebCloudModulePath('streamingRoutes.ts')),
    server.ssrLoadModule(renderWebCloudModulePath('mppRoutes.ts')),
  ]);
  const [{ listDevApiHandlers }, { MemoryWorkflowStore }, { WorkflowService }, { MemoryEvidenceStore }] = await Promise.all([
    server.ssrLoadModule(renderWebCloudModulePath('devApiRegistry.ts')) as Promise<LocalStreamingRegistryModule>,
    server.ssrLoadModule(renderWebCloudModulePath('memoryStore.ts')) as Promise<LocalStreamingMemoryStoreModule>,
    server.ssrLoadModule(renderWebCloudModulePath('workflowService.ts')) as Promise<LocalStreamingWorkflowServiceModule>,
    server.ssrLoadModule(renderWebCloudModulePath('evidenceService.ts')) as Promise<LocalStreamingEvidenceStoreModule>,
  ]);
  const handlers = listDevApiHandlers().filter((candidate) => candidate.prefix === STREAMING_PREFIX || candidate.prefix === MPP_PREFIX);
  if (!handlers.some((handler) => handler.prefix === STREAMING_PREFIX)) throw new Error('Local streaming dev API handler was not registered.');
  if (!handlers.some((handler) => handler.prefix === MPP_PREFIX)) throw new Error('Local MPP dev API handler was not registered.');
  const workflowStore = new MemoryWorkflowStore();

  return {
    handlers: handlers as readonly LocalStreamingApiHandler[],
    context: {
      workflowService: new WorkflowService(workflowStore),
      workflowStore,
      evidenceStore: new MemoryEvidenceStore(),
      clock: { now: () => new Date() },
    },
  };
}

function renderWebCloudModulePath(fileName: string): string {
  return join(workspaceRoot(), 'apps/render-web/src/cloud', fileName);
}

function workspaceRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function handleLocalAgentCardApi(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const isPreview = url.pathname === AGENT_CARD_PREVIEW_PATH;
  const isPublic = url.pathname === AGENT_CARD_PUBLIC_PATH;
  const perWalletMatch = PER_WALLET_AGENT_CARD_RE.exec(url.pathname);
  const perWalletAddress = perWalletMatch?.[1] ? decodeURIComponent(perWalletMatch[1]) : '';
  const isPerWallet = Boolean(perWalletAddress);
  if (!isPreview && !isPublic && !isPerWallet) return false;

  const method = req.method ?? 'GET';
  if ((isPublic || isPerWallet) && method === 'OPTIONS') {
    res.statusCode = 204;
    setAgentCardCorsHeaders(res);
    res.setHeader('access-control-max-age', '600');
    res.end();
    return true;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    writeJson(res, 405, {
      error: 'method_not_allowed',
      message: 'Use GET for the local Agent Card route.',
    });
    return true;
  }

  let card: AgentCard;
  if (isPerWallet) {
    if (!BASE58_PUBKEY_RE.test(perWalletAddress)) {
      writeJson(res, 404, { error: 'profile_not_found' });
      return true;
    }
    const profile = localAgentProfiles.get(perWalletAddress)?.payload;
    if (!profile?.discoverable) {
      writeJson(res, 404, { error: 'profile_not_found' });
      return true;
    }
    card = buildLocalAgentCard(req, url, {
      walletAddress: perWalletAddress,
      profile,
    });
  } else {
    card = buildLocalAgentCard(req, url);
  }
  const validation = validateAgentCard(card);
  if (!validation.valid) {
    writeJson(res, 500, {
      error: 'agent_card_invalid',
      message: validation.errors.join('; '),
    });
    return true;
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', isPublic || isPerWallet ? 'public, max-age=60' : 'no-store');
  if (isPublic || isPerWallet) setAgentCardCorsHeaders(res);
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  res.end(JSON.stringify(card));
  return true;
}

function buildLocalAgentCard(
  req: IncomingMessage,
  url: URL,
  input: { walletAddress?: string; profile?: AgentPaymentProfilePayload } = {},
): AgentCard {
  const profile = input.profile;
  return buildAgenticAgentCard({
    walletAddress: input.walletAddress ?? resolveLocalAgentCardWallet(req),
    baseUrl: resolveRequestOrigin(req, url),
    supportedTokens: profile?.acceptedTokens ?? DEFAULT_AGENT_CARD_TOKENS,
    capabilities: defaultAgenticCapabilities,
    ...(profile ? { name: profile.displayName } : {}),
    ...(profile ? { supportedProtocols: profile.protocols as AgenticProtocol[] } : {}),
    ...(profile?.contactEmail ? { contactEmail: profile.contactEmail } : {}),
    version: process.env.AGENTIC_BUILD_ID ?? '0.0.1-dev',
  });
}

function resolveLocalAgentCardWallet(req: IncomingMessage): string {
  const rawHeader = req.headers[DEV_WALLET_HEADER];
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const candidates = [
    typeof header === 'string' ? header.trim() : '',
    process.env.AGENTIC_AGENT_CARD_WALLET?.trim() ?? '',
    LOCAL_AGENT_CARD_WALLET_FALLBACK,
  ];
  return candidates.find((candidate) => BASE58_PUBKEY_RE.test(candidate)) ?? LOCAL_AGENT_CARD_WALLET_FALLBACK;
}

function resolveRequestOrigin(req: IncomingMessage, url: URL): string {
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = protoHeader === 'https' || (Array.isArray(protoHeader) && protoHeader.includes('https'))
    ? 'https'
    : 'http';
  const host = req.headers.host ?? url.host ?? '127.0.0.1:5174';
  return `${proto}://${host}`;
}

async function handleLocalAgentProfileApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === AGENT_PROFILE_PREFERENCE_PATH) {
    if (req.method !== 'GET') {
      writeJson(res, 405, {
        error: 'method_not_allowed',
        message: 'Use GET for the local agent payment profile preference.',
      });
      return true;
    }
    const walletAddress = walletAddressFromRequest(req);
    const record = localAgentProfiles.get(walletAddress);
    writeJson(res, 200, record ?? emptyLocalAgentProfileRecord());
    return true;
  }

  if (url.pathname === AGENT_PROFILE_INTENT_PATH) {
    if (req.method !== 'POST') {
      writeJson(res, 405, {
        error: 'method_not_allowed',
        message: 'Use POST for the local agent payment profile intent.',
      });
      return true;
    }
    await handleLocalAgentProfileIntent(req, res, url);
    return true;
  }

  if (url.pathname === AGENT_PROFILE_WRITE_PATH) {
    if (req.method === 'PUT') {
      await handleLocalAgentProfilePublish(req, res, url);
      return true;
    }
    if (req.method === 'DELETE') {
      await handleLocalAgentProfileTakedown(req, res, url);
      return true;
    }
    writeJson(res, 405, {
      error: 'method_not_allowed',
      message: 'Use PUT or DELETE for the local agent payment profile.',
    });
    return true;
  }

  return false;
}

async function handleLocalAgentProfileIntent(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const walletAddress = connectedWalletAddressFromRequest(req);
  if (!walletAddress) {
    writeJson(res, 403, {
      error: 'dev_wallet_missing',
      message: 'Connect a wallet before updating the local payment profile.',
    });
    return;
  }

  const body = await readJsonBody(req);
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const action = record.action === 'takedown' ? 'takedown' : 'publish';
  const payloadHashHex = action === 'publish'
    ? await validateAndHashLocalAgentProfilePayload(record.payload, res)
    : undefined;
  if (action === 'publish' && !payloadHashHex) return;

  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + AGENT_PROFILE_NONCE_TTL_MS).toISOString();
  const domain = requestDomain(req, url);
  const nonce = randomUUID().replace(/-/g, '');
  const fields = { domain, walletAddress, nonce, issuedAt, expiresAt };
  const intent: LocalAgentProfileIntent = {
    ...fields,
    action,
    message: action === 'publish'
      ? buildLocalAgentProfilePublishMessage(fields, payloadHashHex ?? '')
      : buildLocalAgentProfileTakedownMessage(fields),
    ...(payloadHashHex ? { payloadHashHex } : {}),
  };
  localAgentProfileIntents.set(intent.nonce, intent);
  pruneExpiredLocalAgentProfileIntents(now);
  writeJson(res, 200, { ...intent, localOnly: true });
}

async function handleLocalAgentProfilePublish(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const body = await readJsonBody(req);
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const walletAddress = walletAddressFromProfileWrite(record, req);
  if (!walletAddress) {
    writeJson(res, 403, {
      error: 'dev_wallet_missing',
      message: 'Connect a wallet before publishing the local payment profile.',
    });
    return;
  }

  const payload = validatedLocalAgentProfilePayload(record.payload, res);
  if (!payload) return;
  const payloadHashHex = await hashProfilePayload(payload);
  if (!assertLocalAgentProfileIntent(record, res, {
    action: 'publish',
    walletAddress,
    payloadHashHex,
    domain: requestDomain(req, url),
  })) return;

  const existing = localAgentProfiles.get(walletAddress);
  const saved: LocalAgentProfileRecord = {
    namespace: AGENT_PROFILE_NAMESPACE,
    payload,
    updatedAt: new Date().toISOString(),
    version: (existing?.version ?? 0) + 1,
  };
  localAgentProfiles.set(walletAddress, saved);
  writeJson(res, 200, { ok: true, profile: saved, localOnly: true });
}

async function handleLocalAgentProfileTakedown(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const body = await readJsonBody(req);
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const walletAddress = walletAddressFromProfileWrite(record, req);
  if (!walletAddress) {
    writeJson(res, 403, {
      error: 'dev_wallet_missing',
      message: 'Connect a wallet before taking down the local payment profile.',
    });
    return;
  }
  if (!assertLocalAgentProfileIntent(record, res, {
    action: 'takedown',
    walletAddress,
    domain: requestDomain(req, url),
  })) return;

  const existing = localAgentProfiles.get(walletAddress);
  if (!existing?.payload) {
    writeJson(res, 200, { ok: true, profile: null, localOnly: true });
    return;
  }
  const saved: LocalAgentProfileRecord = {
    namespace: AGENT_PROFILE_NAMESPACE,
    payload: {
      ...existing.payload,
      discoverable: false,
    },
    updatedAt: new Date().toISOString(),
    version: existing.version + 1,
  };
  localAgentProfiles.set(walletAddress, saved);
  writeJson(res, 200, { ok: true, profile: saved, localOnly: true });
}

function emptyLocalAgentProfileRecord(): LocalAgentProfileRecord {
  return {
    namespace: AGENT_PROFILE_NAMESPACE,
    payload: null,
    updatedAt: null,
    version: 0,
  };
}

function connectedWalletAddressFromRequest(req: IncomingMessage): string {
  const walletAddress = walletAddressFromRequest(req);
  return BASE58_PUBKEY_RE.test(walletAddress) ? walletAddress : '';
}

function walletAddressFromProfileWrite(record: Record<string, unknown>, req: IncomingMessage): string {
  const bodyWallet = typeof record.walletAddress === 'string' ? record.walletAddress.trim() : '';
  if (BASE58_PUBKEY_RE.test(bodyWallet)) return bodyWallet;
  return connectedWalletAddressFromRequest(req);
}

async function validateAndHashLocalAgentProfilePayload(
  value: unknown,
  res: ServerResponse,
): Promise<string | undefined> {
  const payload = validatedLocalAgentProfilePayload(value, res);
  if (!payload) return undefined;
  return hashProfilePayload(payload);
}

function validatedLocalAgentProfilePayload(
  value: unknown,
  res: ServerResponse,
): AgentPaymentProfilePayload | undefined {
  const validated = validateProfilePayload(value);
  if (!validated.ok) {
    writeJson(res, 400, {
      error: 'invalid_profile_payload',
      message: validated.errors.map((entry) => entry.message).join(' '),
      errors: validated.errors,
    });
    return undefined;
  }
  return validated.payload;
}

function assertLocalAgentProfileIntent(
  record: Record<string, unknown>,
  res: ServerResponse,
  expected: {
    action: 'publish' | 'takedown';
    walletAddress: string;
    domain: string;
    payloadHashHex?: string;
  },
): boolean {
  const nonce = typeof record.nonce === 'string' ? record.nonce.trim() : '';
  const intent = nonce ? localAgentProfileIntents.get(nonce) : undefined;
  if (!intent || Date.parse(intent.expiresAt) <= Date.now()) {
    writeJson(res, 401, { error: 'invalid_profile_nonce', message: 'Invalid or expired local profile nonce.' });
    return false;
  }
  const signature = typeof record.signature === 'string' ? record.signature.trim() : '';
  if (!signature) {
    writeJson(res, 400, { error: 'missing_signature', message: 'Wallet signature is required.' });
    return false;
  }
  const message = typeof record.message === 'string' ? record.message : '';
  if (
    intent.action !== expected.action ||
    intent.walletAddress !== expected.walletAddress ||
    intent.domain !== expected.domain ||
    intent.message !== message ||
    (expected.payloadHashHex !== undefined && intent.payloadHashHex !== expected.payloadHashHex)
  ) {
    writeJson(res, 401, {
      error: 'profile_intent_mismatch',
      message: 'Signed message does not match the local profile intent.',
    });
    return false;
  }
  localAgentProfileIntents.delete(intent.nonce);
  return true;
}

function pruneExpiredLocalAgentProfileIntents(now = new Date()): void {
  const cutoff = now.getTime();
  for (const [nonce, intent] of localAgentProfileIntents.entries()) {
    if (Date.parse(intent.expiresAt) <= cutoff) {
      localAgentProfileIntents.delete(nonce);
    }
  }
}

function requestDomain(req: IncomingMessage, url: URL): string {
  return req.headers.host ?? url.host ?? '127.0.0.1:5174';
}

function buildLocalAgentProfilePublishMessage(
  fields: Omit<LocalAgentProfileIntent, 'action' | 'message' | 'payloadHashHex'>,
  payloadHashHex: string,
): string {
  return [
    'Agentic Cloud wants you to publish your agent payment profile.',
    '',
    `Domain: ${fields.domain}`,
    `Wallet: ${fields.walletAddress}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expires At: ${fields.expiresAt}`,
    `Payload SHA-256: ${payloadHashHex}`,
    '',
    'This signature publishes a discovery profile only. It does not grant spending authority, delegated signing, or permission to move funds.',
  ].join('\n');
}

function buildLocalAgentProfileTakedownMessage(
  fields: Omit<LocalAgentProfileIntent, 'action' | 'message' | 'payloadHashHex'>,
): string {
  return [
    'Agentic Cloud wants you to take down your agent payment profile.',
    '',
    `Domain: ${fields.domain}`,
    `Wallet: ${fields.walletAddress}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expires At: ${fields.expiresAt}`,
    '',
    'This signature removes your wallet from discovery. It does not grant spending authority, delegated signing, or permission to move funds.',
  ].join('\n');
}

function setAgentCardCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  res.setHeader('vary', 'Origin');
}

async function handlePreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const requested = DevLayer1.acp.validateCreateAcpCartRequest(body);
  const cart = requested.cart;
  const validated = validateAcpCart(cart);
  const transfer = cartToTransferParams(validated, {
    ...(requested.dueAt !== undefined ? { dueAt: requested.dueAt } : {}),
    ...(requested.note !== undefined ? { note: requested.note } : {}),
  });

  writeJson(res, 200, {
    preview: {
      cart,
      transfer,
      totalFiat: validated.totalFiat,
      resolvedTokenMint: validated.resolvedTokenMint,
    },
  });
}

async function handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const walletAddress = walletAddressFromBody(body);
  if (!walletAddress) {
    writeJson(res, 403, {
      error: 'dev_wallet_missing',
      message: 'Connect a wallet before creating a local Pay Out approval.',
    });
    return;
  }

  const requested = DevLayer1.acp.validateCreateAcpCartRequest(body);
  const cart = requested.cart;
  const validated = validateAcpCart(cart);
  const transfer = cartToTransferParams(validated, {
    ...(requested.dueAt !== undefined ? { dueAt: requested.dueAt } : {}),
    ...(requested.note !== undefined ? { note: requested.note } : {}),
  });
  const cluster: WorkflowCluster = requested.cluster ?? cart.cluster;
  const cartJson = jsonObject(cart);
  const cartHash = hashCart(cart);
  const now = new Date().toISOString();
  const isSolPayment = cart.paymentToken === 'SOL';
  const approvalKind = isSolPayment ? 'transfer_sol' : 'transfer_spl';
  const finalizationRequirement = finalizationRequirementForAction(approvalKind);
  const finalizationSupport: FinalizationSupport = { required: true, supported: true };

  const params: JsonObject = isSolPayment
    ? {
        recipient: transfer.recipient,
        amountSol: transfer.amount,
        ...(cart.memo !== undefined ? { memo: cart.memo } : {}),
      }
    : {
        recipient: transfer.recipient,
        token: cart.paymentToken,
        amount: transfer.amount,
        tokenMint: validated.resolvedTokenMint,
        ...(cart.memo !== undefined ? { memo: cart.memo } : {}),
      };

  const approval: ApprovalRequestRecord = {
    id: `browser-acp_${randomUUID()}`,
    walletAddress,
    kind: approvalKind,
    status: 'ready',
    summary: `ACP: ${cart.merchant.name} — ${transfer.amount} ${cart.paymentToken}`,
    params,
    cluster,
    dueAt: cart.expiresAt ?? requested.dueAt ?? now,
    createdAt: now,
    updatedAt: now,
    amount: transfer.amount,
    token: cart.paymentToken,
    recipient: transfer.recipient,
    ...(requested.note !== undefined ? { note: requested.note } : {}),
    finalizationRequirement,
    executionMode: 'wallet_execute',
    finalizationSupport,
    metadata: {
      source: ACP_OUTBOUND_SOURCE,
      actionSource: ACP_OUTBOUND_SOURCE,
      acpCartId: cart.id,
      acpCartHash: cartHash,
      acpCart: cartJson,
      merchant: cartJson.merchant as JsonObject,
      totalAmount: cart.totalAmount,
      paymentAmount: transfer.amount,
      paymentToken: cart.paymentToken,
      resolvedTokenMint: validated.resolvedTokenMint,
      acpCluster: cart.cluster,
      totalFiat: validated.totalFiat,
      receivedAt: requested.receivedAt,
      devLocal: true,
    },
  };

  devApprovals.set(approval.id, approval);
  writeJson(res, 201, {
    approval,
    approvalId: approval.id,
    cartId: cart.id,
    cartHash,
    localOnly: true,
  });
}

async function handleReceipt(req: IncomingMessage, res: ServerResponse, approvalId: string): Promise<void> {
  const approval = devApprovals.get(approvalId);
  if (!approval) {
    writeJson(res, 404, {
      error: 'approval_not_found',
      message: `No local dev ACP approval found for id ${approvalId}.`,
    });
    return;
  }
  const cart = cartFromApproval(approval);
  if (!cart) {
    writeJson(res, 409, {
      error: 'not_an_acp_approval',
      message: 'This approval does not carry an ACP outbound cart.',
    });
    return;
  }

  const body = await readJsonBody(req);
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const txid = typeof record.txid === 'string' && record.txid.trim()
    ? record.txid.trim()
    : undefined;
  if (!txid) {
    writeJson(res, 400, { error: 'missing_txid', message: 'txid is required.' });
    return;
  }
  const settledAt = typeof record.settledAt === 'string' && !Number.isNaN(Date.parse(record.settledAt))
    ? record.settledAt
    : new Date().toISOString();
  const receipt = buildAcpOutboundReceipt({
    cart,
    txid,
    walletAddress: approval.walletAddress,
    settledAt,
  });

  writeJson(res, 201, {
    approvalId: approval.id,
    acp: receipt,
    receipt: {
      id: `browser-evidence-acp_${randomUUID()}`,
      walletAddress: approval.walletAddress,
      cluster: approval.cluster,
      kind: 'acp_outbound',
      status: 'approved',
      title: `ACP Outbound: ${cart.merchant.name}`,
      summary: `Paid ${cart.totalAmount} ${cart.currency} to ${cart.merchant.name} via ${cart.paymentToken}.`,
      payload: receipt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    localOnly: true,
  });
}

async function handleLocalSkillsApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'GET') {
    if (path === SKILLS_CATALOG_PATH) {
      handleListSkills(res, url);
      return true;
    }
    if (path === SKILLS_INSTALLS_PATH) {
      handleListSkillInstalls(req, res);
      return true;
    }
    const authorMatch = SKILLS_AUTHOR_EARNINGS_RE.exec(path);
    if (authorMatch?.[1]) {
      handleAuthorEarnings(res, authorMatch[1]);
      return true;
    }
    const skillStatsMatch = AGGREGATOR_SKILL_RE.exec(path);
    if (skillStatsMatch?.[1]) {
      handleSkillStats(res, skillStatsMatch[1]);
      return true;
    }
    const walletStatsMatch = AGGREGATOR_WALLET_RE.exec(path);
    if (walletStatsMatch?.[1]) {
      handleWalletStats(res, walletStatsMatch[1]);
      return true;
    }
    const detailMatch = SKILLS_DETAIL_RE.exec(path);
    if (detailMatch?.[1]) {
      handleSkillDetail(res, detailMatch[1]);
      return true;
    }
    return false;
  }

  if (method === 'POST') {
    if (path === SKILLS_MANIFESTS_PATH) {
      await handlePublishSkillManifest(req, res);
      return true;
    }
    if (path === SKILLS_INSTALLS_PATH) {
      await handleInstallSkill(req, res);
      return true;
    }
    const actionMatch = SKILLS_INSTALL_ACTION_RE.exec(path);
    if (actionMatch?.[1] && actionMatch[2]) {
      handleSkillInstallAction(res, actionMatch[1], actionMatch[2] as 'pause' | 'resume' | 'uninstall');
      return true;
    }
    return false;
  }

  if (path.startsWith(SKILLS_PREFIX) || path.startsWith('/api/aggregator/')) {
    writeJson(res, 405, { error: 'method_not_allowed', message: 'Use GET or POST for local Skills routes.' });
    return true;
  }
  return false;
}

function seedLocalSkillsCatalog(): void {
  if (localSkillCatalog.size > 0) return;
  const now = new Date().toISOString();
  for (const raw of LAUNCH_SKILLS) {
    const manifest = cloneJson(DevLayer1.skills.validateSkillManifest(raw));
    localSkillCatalog.set(manifest.id, {
      id: manifest.id,
      version: manifest.version,
      authorWallet: manifest.authorWallet,
      createdAt: now,
      updatedAt: now,
      manifest,
    });
  }
}

function handleListSkills(res: ServerResponse, url: URL): void {
  seedLocalSkillsCatalog();
  const author = url.searchParams.get('author')?.trim();
  const skills = [...localSkillCatalog.values()]
    .filter((record) => !author || record.authorWallet === author)
    .map((record) => cloneJson(record.manifest));
  writeJson(res, 200, { skills, localOnly: true });
}

function handleSkillDetail(res: ServerResponse, skillId: string): void {
  seedLocalSkillsCatalog();
  const record = localSkillCatalog.get(skillId);
  if (!record) {
    writeJson(res, 404, { error: 'skill_not_found', message: `No local skill found for ${skillId}.` });
    return;
  }
  writeJson(res, 200, {
    skill: cloneJson(record.manifest),
    stats: skillStatsSnapshot(skillId),
    localOnly: true,
  });
}

function handleListSkillInstalls(req: IncomingMessage, res: ServerResponse): void {
  seedLocalSkillsCatalog();
  const wallet = walletAddressFromRequest(req);
  const records = [...localSkillInstalls.values()]
    .filter((install) => install.walletAddress === wallet && install.status !== 'revoked');
  const installRows = records.map((install) => localInstallRow(install));
  writeJson(res, 200, {
    installs: records.map((install) => cloneJson(install)),
    installRows,
    localOnly: true,
  });
}

async function handlePublishSkillManifest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  seedLocalSkillsCatalog();
  const body = await readJsonBody(req);
  const manifest = cloneJson(DevLayer1.skills.validateSkillManifest(body));
  const now = new Date().toISOString();
  const existing = localSkillCatalog.get(manifest.id);
  const record: LocalSkillManifestRecord = {
    id: manifest.id,
    version: manifest.version,
    authorWallet: manifest.authorWallet,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    manifest,
  };
  localSkillCatalog.set(manifest.id, record);
  writeJson(res, existing ? 200 : 201, { manifest, record, localOnly: true });
}

async function handleInstallSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  seedLocalSkillsCatalog();
  const body = await readJsonBody(req);
  const wallet = walletAddressFromRequest(req);
  const installRequest = DevLayer1.skills.validateInstallSkillRequest(body);
  const record = localSkillCatalog.get(installRequest.skillId);
  if (!record) {
    writeJson(res, 404, {
      error: 'skill_not_found',
      message: `No local skill manifest found for id ${installRequest.skillId}.`,
    });
    return;
  }
  if (record.manifest.version !== installRequest.manifestVersion) {
    writeJson(res, 400, {
      error: 'manifest_version_mismatch',
      message: `Requested version ${installRequest.manifestVersion} does not match ${record.manifest.version}.`,
    });
    return;
  }
  if (record.manifest.monetization && !installRequest.acceptMonetization) {
    writeJson(res, 400, {
      error: 'monetization_required',
      message: 'Accept the skill monetization terms before install.',
    });
    return;
  }
  const existing = [...localSkillInstalls.values()].find(
    (install) =>
      install.walletAddress === wallet &&
      install.skillId === installRequest.skillId &&
      install.status !== 'revoked',
  );
  if (existing) {
    writeJson(res, 409, {
      error: 'already_installed',
      message: 'This skill is already installed locally. Uninstall it first to reinstall.',
    });
    return;
  }
  const now = new Date().toISOString();
  const install: SkillInstallRecord = {
    id: `browser-skill_${randomUUID()}`,
    walletAddress: wallet,
    skillId: record.manifest.id,
    manifestVersion: record.manifest.version,
    caps: cloneJson(installRequest.caps),
    installedAt: now,
    updatedAt: now,
    status: 'active',
    metadata: {
      localOnly: true,
      manifestSnapshot: cloneJson(record.manifest) as unknown as JsonObject,
      ...(installRequest.installParams ? { installParams: cloneJson(installRequest.installParams) } : {}),
    },
  };
  localSkillInstalls.set(install.id, install);
  writeJson(res, 201, {
    install: cloneJson(install),
    installId: install.id,
    localOnly: true,
  });
}

function handleSkillInstallAction(
  res: ServerResponse,
  installId: string,
  action: 'pause' | 'resume' | 'uninstall',
): void {
  const install = localSkillInstalls.get(installId);
  if (!install || install.status === 'revoked') {
    writeJson(res, 404, { error: 'install_not_found', message: `No local skill install found for ${installId}.` });
    return;
  }
  const nextStatus: SkillInstallStatus =
    action === 'pause' ? 'paused'
      : action === 'resume' ? 'active'
        : 'revoked';
  install.status = nextStatus;
  install.updatedAt = new Date().toISOString();
  localSkillInstalls.set(install.id, install);
  writeJson(res, 200, { install: cloneJson(install), localOnly: true });
}

function handleSkillStats(res: ServerResponse, skillId: string): void {
  seedLocalSkillsCatalog();
  if (!localSkillCatalog.has(skillId)) {
    writeJson(res, 404, { error: 'snapshot_not_found' });
    return;
  }
  const snapshot = skillStatsSnapshot(skillId);
  writeJson(res, 200, {
    snapshot,
    computedAt: snapshot.computedAt,
    kind: 'skill',
    key: `skill:${skillId}`,
    localOnly: true,
  });
}

function handleWalletStats(res: ServerResponse, walletAddress: string): void {
  const installs = [...localSkillInstalls.values()]
    .filter((install) => install.walletAddress === walletAddress && install.status !== 'revoked');
  const active = installs.filter((install) => install.status === 'active');
  const totalExecutions = active.length;
  const snapshot: DevLayer1.aggregator.WalletStatsSnapshot = {
    walletAddress,
    totalSkillsInstalled: installs.length,
    totalExecutions,
    successRate: totalExecutions > 0 ? 1 : 0,
    totalProfitUsd: totalExecutions > 0 ? '0.00' : undefined,
    totalGasUsd: totalExecutions > 0 ? '0.00' : undefined,
    installedSkillIds: installs.map((install) => install.skillId),
    computedAt: new Date().toISOString(),
  };
  writeJson(res, 200, {
    snapshot,
    computedAt: snapshot.computedAt,
    kind: 'wallet',
    key: `wallet:${walletAddress}`,
    localOnly: true,
  });
}

function handleAuthorEarnings(res: ServerResponse, authorWallet: string): void {
  const authoredSkillIds = [...localSkillCatalog.values()]
    .filter((record) => record.authorWallet === authorWallet)
    .map((record) => record.id);
  writeJson(res, 200, {
    authorWallet,
    currency: 'USDC',
    totalMonthlyUsdc: '0',
    skills: authoredSkillIds.map((skillId) => ({
      skillId,
      monthlyUsdc: '0',
      activeSubscriptions: activeInstallCount(skillId),
    })),
    localOnly: true,
  });
}

function localInstallRow(install: SkillInstallRecord): LocalSkillInstallRow {
  const record = localSkillCatalog.get(install.skillId);
  const row: LocalSkillInstallRow = {
    install: cloneJson(install),
    recentExecutionCount: install.status === 'active' ? 0 : 0,
    recurringScheduleStatus: 'local-only',
  };
  if (record) row.manifest = cloneJson(record.manifest);
  if (install.status === 'active') row.nextRunAt = nextRunAtForLocalInstall(install);
  return row;
}

function skillStatsSnapshot(skillId: string): DevLayer1.aggregator.SkillStatsSnapshot {
  const installs = activeInstallCount(skillId);
  const launchIndex = Math.max(0, [...localSkillCatalog.keys()].indexOf(skillId));
  const baseInstalls = 8 + launchIndex * 3;
  const totalInstalls = baseInstalls + installs;
  return {
    skillId,
    installs: totalInstalls,
    totalExecutions: totalInstalls * 4,
    successRate: 0.88 + Math.min(0.09, launchIndex * 0.015),
    computedAt: new Date().toISOString(),
  };
}

function activeInstallCount(skillId: string): number {
  return [...localSkillInstalls.values()]
    .filter((install) => install.skillId === skillId && install.status !== 'revoked')
    .length;
}

function nextRunAtForLocalInstall(install: SkillInstallRecord): string {
  const installed = Date.parse(install.installedAt);
  const base = Number.isFinite(installed) ? installed : Date.now();
  const next = Math.max(Date.now() + 60 * 60 * 1000, base + 24 * 60 * 60 * 1000);
  return new Date(next).toISOString();
}

function walletAddressFromRequest(req: IncomingMessage): string {
  const raw = req.headers[DEV_WALLET_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : LOCAL_WALLET_FALLBACK;
}

function walletAddressFromStreamingRequest(req: IncomingMessage, url: URL): string {
  const header = walletAddressFromRequest(req);
  if (BASE58_PUBKEY_RE.test(header)) return header;
  const query = url.searchParams.get('walletAddress')?.trim() ?? '';
  if (BASE58_PUBKEY_RE.test(query)) return query;
  return LOCAL_AGENT_CARD_WALLET_FALLBACK;
}

function walletAddressFromBody(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const walletAddress = (body as Record<string, unknown>).walletAddress;
  return typeof walletAddress === 'string' ? walletAddress.trim() : '';
}

function cartFromApproval(approval: ApprovalRequestRecord): AcpCart | null {
  const metadata = approval.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const cart = (metadata as Record<string, unknown>).acpCart;
  if (!cart || typeof cart !== 'object' || Array.isArray(cart)) return null;
  try {
    return DevLayer1.acp.validateCreateAcpCartRequest({ cart }).cart;
  } catch {
    return null;
  }
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError();
  }
}

function writeLocalDevError(res: ServerResponse, err: unknown): void {
  if (err instanceof BodyTooLargeError) {
    writeJson(res, 413, { error: 'body_too_large', message: err.message });
    return;
  }
  if (err instanceof InvalidJsonError) {
    writeJson(res, 400, { error: 'invalid_json', message: err.message });
    return;
  }
  if (err instanceof Error) {
    writeJson(res, 400, { error: err.name || 'invalid_local_dev_request', message: err.message });
    return;
  }
  writeJson(res, 500, { error: 'internal_error', message: 'Unexpected local dev route error.' });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}
