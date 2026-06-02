import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  buildAgenticAgentCard,
  defaultAgenticCapabilities,
  validateAgentCard,
  type AgentCard,
  type AgenticProtocol,
  type AllowedProfileProtocol,
  type AllowedProfileToken,
  type AgentPaymentProfilePayload,
} from '@solana-agent-wallet-adapter/a2a-agent-card';

import { normalizeWalletAddress } from './auth.js';
import { registerDevApiHandler, type DevApiHandler } from './devApiRegistry.js';
import { devWalletAllowlist } from './devGate.js';
import type { CloudPreferencesStore } from './store.js';

const DEFAULT_SUPPORTED_TOKENS = ['USDC', 'USDT', 'SOL'];
const WELL_KNOWN_PREFIX = '/.well-known/agent.json';
const DEV_PREVIEW_PREFIX = '/api/agents/card';
const PER_WALLET_PREFIX = '/agents/';
const PER_WALLET_SUFFIX = '/card.json';
const PUBLIC_CACHE_CONTROL = 'public, max-age=60';
const PER_WALLET_CACHE_CONTROL = 'public, max-age=60, must-revalidate';
const NO_STORE_CACHE_CONTROL = 'no-store';

interface RenderedCard {
  serialized: string;
  etag: string;
}

const publicHandler: DevApiHandler = {
  prefix: WELL_KNOWN_PREFIX,
  methods: ['GET', 'HEAD', 'OPTIONS'],
  publicRoute: true,
  async handle(req, res, url, _context) {
    if (req.method === 'OPTIONS') {
      writeCorsNoBody(res, 204);
      return true;
    }
    const walletAddress = resolvePublicAgentWallet();
    if (!walletAddress) {
      writeJsonNoStore(res, 503, { error: 'no_dev_wallet_configured' });
      return true;
    }
    const rendered = renderAgentCard(req, url, walletAddress);
    if (rendered === 'invalid') {
      writeJsonNoStore(res, 500, { error: 'agent_card_invalid' });
      return true;
    }
    if (ifNoneMatchHits(req, rendered.etag)) {
      writeNotModifiedPublic(res, rendered.etag, PUBLIC_CACHE_CONTROL);
      return true;
    }
    const headOnly = req.method === 'HEAD';
    writeCardWithCors(res, 200, rendered, PUBLIC_CACHE_CONTROL, headOnly);
    return true;
  },
};

const devPreviewHandler: DevApiHandler = {
  prefix: DEV_PREVIEW_PREFIX,
  methods: ['GET'],
  async handle(req, res, url, context) {
    if (!context.walletAddress) {
      // Router gate guarantees a wallet for non-public routes; defensive guard.
      writeJsonNoStore(res, 401, {
        error: 'auth_required',
        message: 'Sign in to Agentic Cloud with your wallet to preview your Agent Card.',
      });
      return true;
    }
    const rendered = renderAgentCard(req, url, context.walletAddress);
    if (rendered === 'invalid') {
      writeJsonNoStore(res, 500, { error: 'agent_card_invalid' });
      return true;
    }
    if (ifNoneMatchHits(req, rendered.etag)) {
      writeNotModifiedPrivate(res, rendered.etag);
      return true;
    }
    writeCardNoStore(res, 200, rendered);
    return true;
  },
};

function renderAgentCard(req: IncomingMessage, url: URL, walletAddress: string): RenderedCard | 'invalid' {
  const card: AgentCard = buildAgenticAgentCard({
    walletAddress,
    baseUrl: resolveBaseUrl(req, url),
    supportedTokens: DEFAULT_SUPPORTED_TOKENS,
    capabilities: defaultAgenticCapabilities,
    version: resolveBuildVersion(),
  });
  const validation = validateAgentCard(card);
  if (!validation.valid) return 'invalid';
  const serialized = JSON.stringify(card);
  const etag = `"${createHash('sha256').update(serialized).digest('base64url').slice(0, 27)}"`;
  return { serialized, etag };
}

function ifNoneMatchHits(req: IncomingMessage, etag: string): boolean {
  const header = req.headers['if-none-match'];
  if (typeof header !== 'string' || header.length === 0) return false;
  // RFC 7232 permits a comma-separated list and the special "*" wildcard.
  if (header.trim() === '*') return true;
  for (const candidate of header.split(',')) {
    const trimmed = candidate.trim();
    if (trimmed === etag) return true;
    // Honor weak validator prefix "W/" — match the bare etag value.
    if (trimmed.startsWith('W/') && trimmed.slice(2) === etag) return true;
  }
  return false;
}

function resolvePublicAgentWallet(): string | undefined {
  const override = process.env.AGENTIC_AGENT_CARD_WALLET?.trim();
  if (override) return override;
  const first = devWalletAllowlist()[0];
  return first && first.length > 0 ? first : undefined;
}

function resolveBaseUrl(req: IncomingMessage, url: URL): string {
  const configured = process.env.AGENTIC_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to header-derived
    }
  }
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = req.headers.host ?? url.host ?? 'localhost';
  return `${proto}://${host}`;
}

function resolveBuildVersion(): string {
  return (
    process.env.RENDER_GIT_COMMIT?.slice(0, 12) ??
    process.env.AGENTIC_BUILD_ID ??
    '0.0.1-dev'
  );
}

function writeCardWithCors(
  res: ServerResponse,
  status: number,
  rendered: RenderedCard,
  cacheControl: string,
  headOnly: boolean,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheControl);
  res.setHeader('etag', rendered.etag);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  res.setHeader('vary', 'Origin');
  if (headOnly) {
    res.end();
    return;
  }
  res.end(rendered.serialized);
}

function writeCardNoStore(res: ServerResponse, status: number, rendered: RenderedCard): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', NO_STORE_CACHE_CONTROL);
  res.setHeader('etag', rendered.etag);
  res.end(rendered.serialized);
}

function writeNotModifiedPublic(res: ServerResponse, etag: string, cacheControl: string): void {
  res.statusCode = 304;
  res.setHeader('cache-control', cacheControl);
  res.setHeader('etag', etag);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  res.setHeader('vary', 'Origin');
  res.end();
}

function writeNotModifiedPrivate(res: ServerResponse, etag: string): void {
  res.statusCode = 304;
  res.setHeader('cache-control', NO_STORE_CACHE_CONTROL);
  res.setHeader('etag', etag);
  res.end();
}

function writeCorsNoBody(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  res.setHeader('access-control-max-age', '600');
  res.setHeader('vary', 'Origin');
  res.end();
}

function writeJsonNoStore(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', NO_STORE_CACHE_CONTROL);
  res.end(JSON.stringify(payload));
}

const perWalletHandler: DevApiHandler = {
  prefix: PER_WALLET_PREFIX,
  methods: ['GET', 'HEAD', 'OPTIONS'],
  publicRoute: true,
  async handle(req, res, url, context) {
    if (req.method === 'OPTIONS') {
      writeCorsNoBody(res, 204);
      return true;
    }
    const walletFromPath = walletAddressFromPerWalletPath(url.pathname);
    if (!walletFromPath) return false;
    let walletAddress: string;
    try {
      walletAddress = normalizeWalletAddress(walletFromPath);
    } catch {
      writeJsonPublic(res, 404, { error: 'profile_not_found' });
      return true;
    }
    const preferenceStore = isCloudPreferencesStore(context.workflowStore) ? context.workflowStore : undefined;
    if (!preferenceStore) {
      writeJsonPublic(res, 404, { error: 'profile_not_found' });
      return true;
    }
    const record = await preferenceStore.getPreference(walletAddress, 'agent-payment-profile');
    const payload = extractDiscoverableProfilePayload(record?.payload);
    if (!payload) {
      writeJsonPublic(res, 404, { error: 'profile_not_found' });
      return true;
    }
    const rendered = renderPerWalletAgentCard(req, url, walletAddress, payload, record?.updatedAt);
    if (rendered === 'invalid') {
      writeJsonNoStore(res, 500, { error: 'agent_card_invalid' });
      return true;
    }
    if (ifNoneMatchHits(req, rendered.etag)) {
      writeNotModifiedPublic(res, rendered.etag, PER_WALLET_CACHE_CONTROL);
      return true;
    }
    const headOnly = req.method === 'HEAD';
    writeCardWithCors(res, 200, rendered, PER_WALLET_CACHE_CONTROL, headOnly);
    return true;
  },
};

function walletAddressFromPerWalletPath(pathname: string): string | undefined {
  if (!pathname.startsWith(PER_WALLET_PREFIX)) return undefined;
  const after = pathname.slice(PER_WALLET_PREFIX.length);
  if (!after.endsWith(PER_WALLET_SUFFIX)) return undefined;
  const candidate = after.slice(0, -PER_WALLET_SUFFIX.length);
  if (!candidate || candidate.includes('/')) return undefined;
  return candidate;
}

function isCloudPreferencesStore(store: unknown): store is CloudPreferencesStore {
  if (!store || typeof store !== 'object') return false;
  const record = store as Record<string, unknown>;
  return typeof record.getPreference === 'function' && typeof record.savePreference === 'function';
}

function extractDiscoverableProfilePayload(payload: unknown): AgentPaymentProfilePayload | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (record.discoverable !== true) return undefined;
  if (record.version !== 1) return undefined;
  const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : '';
  if (displayName.length === 0) return undefined;
  const acceptedTokens = Array.isArray(record.acceptedTokens)
    ? record.acceptedTokens.filter((value): value is AllowedProfileToken => typeof value === 'string')
    : [];
  const protocols = Array.isArray(record.protocols)
    ? record.protocols.filter((value): value is AllowedProfileProtocol => typeof value === 'string')
    : [];
  if (acceptedTokens.length === 0 || protocols.length === 0) return undefined;
  const result: AgentPaymentProfilePayload = {
    version: 1,
    discoverable: true,
    displayName,
    acceptedTokens,
    protocols,
  };
  if (typeof record.contactEmail === 'string' && record.contactEmail.trim().length > 0) {
    result.contactEmail = record.contactEmail.trim();
  }
  return result;
}

function renderPerWalletAgentCard(
  req: IncomingMessage,
  url: URL,
  walletAddress: string,
  payload: AgentPaymentProfilePayload,
  updatedAt: string | undefined,
): RenderedCard | 'invalid' {
  const card: AgentCard = buildAgenticAgentCard({
    walletAddress,
    baseUrl: resolveBaseUrl(req, url),
    supportedTokens: payload.acceptedTokens,
    capabilities: defaultAgenticCapabilities,
    name: payload.displayName,
    supportedProtocols: payload.protocols as AgenticProtocol[],
    version: resolveBuildVersion(),
    ...(payload.contactEmail ? { contactEmail: payload.contactEmail } : {}),
  });
  const validation = validateAgentCard(card);
  if (!validation.valid) return 'invalid';
  const serialized = JSON.stringify(card);
  const hash = createHash('sha256');
  hash.update(serialized);
  if (updatedAt) hash.update(updatedAt);
  const etag = `"${hash.digest('base64url').slice(0, 27)}"`;
  return { serialized, etag };
}

function writeJsonPublic(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', NO_STORE_CACHE_CONTROL);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  res.setHeader('vary', 'Origin');
  res.end(JSON.stringify(payload));
}

registerDevApiHandler(publicHandler);
registerDevApiHandler(devPreviewHandler);
registerDevApiHandler(perWalletHandler);
