import type { IncomingMessage, ServerResponse } from 'node:http';

import { registerDevApiHandler, type DevApiHandler } from './devApiRegistry.js';
import { DEV_WALLET_ALLOWLIST } from './devGate.js';

// TODO: Replace with import from `@solana-agent-wallet-adapter/a2a-agent-card`
// once Agent 3 ships builder.ts. At that point also add the workspace dep
// to apps/render-web/package.json.
interface AgentCardBuildInput {
  walletAddress: string;
  baseUrl: string;
  buildVersion: string;
}

interface AgenticAgentCard {
  schemaVersion: '1.0';
  name: string;
  description: string;
  version: string;
  serviceEndpoint: string;
  walletAddress: string;
  supportedProtocols: readonly ['ap2', 'acp'];
  supportedTokens: readonly string[];
  paymentMethods: ReadonlyArray<{ network: string; settlement: string }>;
  capabilities: readonly string[];
}

function buildAgenticAgentCard(input: AgentCardBuildInput): AgenticAgentCard {
  return {
    schemaVersion: '1.0',
    name: 'Agentic Wallet',
    description: 'AP2/ACP-compatible Solana settlement agent.',
    version: input.buildVersion,
    serviceEndpoint: `${input.baseUrl}/api/agents`,
    walletAddress: input.walletAddress,
    supportedProtocols: ['ap2', 'acp'],
    supportedTokens: ['USDC', 'USDT', 'SOL'],
    paymentMethods: [{ network: 'solana-mainnet', settlement: 'spl-transfer' }],
    capabilities: ['ap2.inbound', 'acp.outbound', 'bridge.quote'],
  };
}

const WELL_KNOWN_PREFIX = '/.well-known/agent.json';
const DEV_PREVIEW_PREFIX = '/api/agents/card';

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
    const card = buildAgenticAgentCard({
      walletAddress,
      baseUrl: resolveBaseUrl(req, url),
      buildVersion: resolveBuildVersion(),
    });
    const headOnly = req.method === 'HEAD';
    writeJsonCached(res, 200, card, 'public, max-age=60', headOnly);
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
    const card = buildAgenticAgentCard({
      walletAddress: context.walletAddress,
      baseUrl: resolveBaseUrl(req, url),
      buildVersion: resolveBuildVersion(),
    });
    writeJsonNoStore(res, 200, card);
    return true;
  },
};

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

function writeJsonCached(
  res: ServerResponse,
  status: number,
  payload: unknown,
  cacheControl: string,
  headOnly: boolean,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheControl);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  res.setHeader('vary', 'Origin');
  if (headOnly) {
    res.end();
    return;
  }
  res.end(JSON.stringify(payload));
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
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

registerDevApiHandler(publicHandler);
registerDevApiHandler(devPreviewHandler);
