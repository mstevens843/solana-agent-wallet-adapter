import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  buildAgenticAgentCard,
  defaultAgenticCapabilities,
  validateAgentCard,
  type AgentCard,
} from '@solana-agent-wallet-adapter/a2a-agent-card';

import { registerDevApiHandler, type DevApiHandler } from './devApiRegistry.js';
import { DEV_WALLET_ALLOWLIST } from './devGate.js';

const DEFAULT_SUPPORTED_TOKENS = ['USDC', 'USDT', 'SOL'];
const WELL_KNOWN_PREFIX = '/.well-known/agent.json';
const DEV_PREVIEW_PREFIX = '/api/agents/card';
const PUBLIC_CACHE_CONTROL = 'public, max-age=60';
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
      writeJsonNoStore(res, 403, { error: 'dev_layer1_disabled' });
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
  const first = DEV_WALLET_ALLOWLIST[0];
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

registerDevApiHandler(publicHandler);
registerDevApiHandler(devPreviewHandler);
