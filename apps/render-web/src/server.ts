import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BridgeAiPlanner,
  type AiApiFormat,
  type AiPlanRequest,
} from '@solana-agent-wallet-adapter/mcp-server';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3000;
const MAX_JSON_BYTES = 64 * 1024;
const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../browser-demo/dist', import.meta.url));

type HostedProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter';

interface HostedProviderPreset {
  id: HostedProviderId;
  label: string;
  apiFormat: AiApiFormat;
  baseUrl: string;
  defaultModel: string;
}

interface RenderWebServerOptions {
  staticDir?: string;
}

interface HostedAiBody {
  settings?: {
    apiKey?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  request?: unknown;
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

export function createRenderWebServer(options: RenderWebServerOptions = {}): Server {
  const staticDir = resolve(options.staticDir ?? process.env.AGENTIC_WEB_DIST ?? DEFAULT_STATIC_DIR);
  return createServer((req, res) => {
    void handleRequest(req, res, staticDir);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, staticDir: string): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  setCommonHeaders(res);

  try {
    if (url.pathname === '/api/ai/status') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
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
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      await handleHostedAiRequest(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    await serveStatic(req, res, staticDir, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? redactSecrets(err.message) : 'Unexpected server error.';
    writeJson(res, status, { error: message });
  }
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
    const message = err instanceof Error ? redactSecrets(err.message) : 'AI provider request failed.';
    writeJson(res, status, { error: message });
  }
}

function hostedSettings(input: HostedAiBody['settings']): {
  apiKey: string;
  provider: HostedProviderPreset;
  model: string;
} {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'Missing hosted AI settings.');
  }
  const apiKey = stringField(input.apiKey).trim();
  if (!apiKey) {
    throw new HttpError(400, 'Missing AI API key.');
  }
  const providerId = stringField(input.provider).trim() || 'openai';
  if (!isHostedProviderId(providerId)) {
    throw new HttpError(400, 'Hosted BYOK supports preset providers only. Select OpenAI, Claude / Anthropic, Gemini, or OpenRouter.');
  }
  const provider = HOSTED_PROVIDER_PRESETS[providerId];
  const model = stringField(input.model).trim() || provider.defaultModel;
  if (model.length > 160) {
    throw new HttpError(400, 'AI model name is too long.');
  }
  return { apiKey, provider, model };
}

function hostedPlanRequest(input: unknown): AiPlanRequest {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'Missing AI plan request.');
  }
  return input as AiPlanRequest;
}

function isHostedProviderId(value: string): value is HostedProviderId {
  return value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'openrouter';
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw new HttpError(413, 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string, pathname: string): Promise<void> {
  const indexFile = join(staticDir, 'index.html');
  const target = safeStaticTarget(staticDir, pathname);
  const file = await resolveExistingFile(target).catch(() => indexFile);
  const payload = await readFile(file);
  res.statusCode = 200;
  res.setHeader('content-type', contentType(file));
  res.setHeader('cache-control', file === indexFile ? 'no-cache' : 'public, max-age=31536000, immutable');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(payload);
}

function safeStaticTarget(staticDir: string, pathname: string): string {
  const decoded = decodeURIComponent(pathname);
  const normalizedPath = decoded === '/' ? '/index.html' : decoded;
  const target = resolve(staticDir, normalizedPath.replace(/^\/+/, ''));
  const rel = relative(staticDir, target);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.includes(`..${sepCompat()}`)) {
    throw new HttpError(403, 'Forbidden.');
  }
  return target;
}

async function resolveExistingFile(target: string): Promise<string> {
  const info = await stat(target);
  return info.isDirectory() ? join(target, 'index.html') : target;
}

function sepCompat(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

function contentType(file: string): string {
  switch (extname(file)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, '[redacted]')
    .replace(/(api[-_ ]?key|token|secret)(["':=\s]+)([^"',\s]{8,})/gi, '$1$2[redacted]');
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

async function start(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const server = createRenderWebServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`Agentic web server listening on http://${host}:${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
