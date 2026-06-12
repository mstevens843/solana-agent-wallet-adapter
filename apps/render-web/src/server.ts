import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  bootstrapHostConnectorFactoriesFromConfig,
  loadConfig,
  loadDotEnv,
  resolveJupiterReferral,
} from '@solana-agent-wallet-adapter/mcp-server';

import { redactSecrets } from './cloud/redaction.js';
import { createCloudApiRouter, type CloudApiRouter, type CloudApiRouterOptions } from './cloud/router.js';
import { listPublicSsrHandlers, type PublicSsrContext } from './cloud/publicSsrRegistry.js';
// Side-effect import: each Layer 2 SSR module self-registers on load.
import './cloud/publicSsrHandlers.js';
import { assertProductionConfig, createRuntimeWorkflowStore } from './cloud/runtimeStore.js';
import { systemClock } from './cloud/store.js';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3000;
const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../browser-demo/dist', import.meta.url));

interface RenderWebServerOptions extends CloudApiRouterOptions {
  staticDir?: string;
}

let loggedSwapFeeStatus = false;

/** One-line startup signal so the operator can confirm the swap fee is live on Render. */
function logSwapFeeStatusOnce(): void {
  if (loggedSwapFeeStatus) return;
  loggedSwapFeeStatus = true;
  const referral = resolveJupiterReferral();
  if (referral) {
    console.info(`[swap-fee] active: ${referral.referralFee} bps → ${referral.referralAccount}`);
  } else if (process.env.JUPITER_REFERRAL_ACCOUNT?.trim()) {
    console.warn(
      '[swap-fee] JUPITER_REFERRAL_ACCOUNT is set but the swap fee is DISABLED — ' +
        'the account is not valid base58 or JUPITER_REFERRAL_FEE_BPS is below the 50 bps floor.',
    );
  } else {
    console.info('[swap-fee] disabled (set JUPITER_REFERRAL_ACCOUNT + JUPITER_REFERRAL_FEE_BPS to enable)');
  }
}

export function createRenderWebServer(options: RenderWebServerOptions = {}): Server {
  logSwapFeeStatusOnce();
  const staticDir = resolve(options.staticDir ?? process.env.AGENTIC_WEB_DIST ?? DEFAULT_STATIC_DIR);
  const apiRouter = createCloudApiRouter({
    store: options.store,
    clock: options.clock,
    authRateLimiter: options.authRateLimiter,
    recurringPolicy: options.recurringPolicy,
    ...(options.connectorPreparer ? { connectorPreparer: options.connectorPreparer } : {}),
    ...(options.statelessConnectorPreparer
      ? { statelessConnectorPreparer: options.statelessConnectorPreparer }
      : {}),
    ...(options.statelessConnectorReader
      ? { statelessConnectorReader: options.statelessConnectorReader }
      : {}),
  });
  return createServer((req, res) => {
    void handleRequest(req, res, staticDir, apiRouter);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  staticDir: string,
  apiRouter: CloudApiRouter,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  setCommonHeaders(req, res);

  try {
    // Layer 2 public SSR routes (e.g. /u/:wallet, /skills/:id) run before
    // /api/ dispatch and SPA fallback. Handlers enforce their own visibility.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const ssrCtx: PublicSsrContext = { store: apiRouter.store, clock: systemClock };
      for (const handler of listPublicSsrHandlers()) {
        const match = url.pathname.match(handler.pattern);
        if (match) {
          const handled = await handler.handle(req, res, match, ssrCtx);
          if (handled) return;
        }
      }
    }

    if (
      url.pathname.startsWith('/api/') ||
      // `/.well-known/assetlinks.json` is a static Digital Asset Links file (Android App Links
      // verification) shipped in the SPA's public/ dir. Let it fall through to serveStatic; the
      // API router only serves the other /.well-known/* JSON (e.g. agent.json) and would 404 it.
      (url.pathname.startsWith('/.well-known/') && url.pathname !== '/.well-known/assetlinks.json') ||
      url.pathname.startsWith('/agents/')
    ) {
      await apiRouter.handle(req, res, url);
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

async function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string, pathname: string): Promise<void> {
  const indexFile = join(staticDir, 'index.html');
  const target = safeStaticTarget(staticDir, pathname);
  const file = await resolveExistingFile(target).catch(() => indexFile);
  const payload = await readFile(file);
  res.statusCode = 200;
  res.setHeader('content-type', contentType(file));
  res.setHeader('cache-control', extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
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

function setCommonHeaders(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
  );
  res.setHeader(
    'content-security-policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data: https:",
      "font-src 'self' https://fonts.gstatic.com",
      "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
      // googletagmanager.com hosts the GA4 gtag.js loader (analytics.ts injects it). The
      // analytics collect beacons go to *.google-analytics.com over connect-src/img-src `https:`
      // (already allowed below), so only the script origin needs whitelisting here.
      "script-src 'self' https://www.googletagmanager.com",
      // `ipc:` + `http://ipc.localhost` let the Tauri 2 desktop shell — which
      // live-loads this page from Render — reach the native IPC bridge
      // (window.__TAURI_INTERNALS__.invoke) for wallet/ledger/bridge commands.
      // Harmless to browsers (the schemes are inert outside a Tauri webview).
      "connect-src 'self' https: wss: ipc: http://ipc.localhost http://127.0.0.1:* http://localhost:* http://[::1]:*",
    ].join('; '),
  );
  if (shouldSetStrictTransport(req)) {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  }
}

function shouldSetStrictTransport(req: IncomingMessage): boolean {
  return (
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.NODE_ENV === 'production' ||
    process.env.RENDER === 'true' ||
    publicOriginUsesHttps()
  );
}

function publicOriginUsesHttps(): boolean {
  if (!process.env.AGENTIC_PUBLIC_ORIGIN) return false;
  try {
    return new URL(process.env.AGENTIC_PUBLIC_ORIGIN).protocol === 'https:';
  } catch {
    return false;
  }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

async function start(): Promise<void> {
  loadDotEnv(process.env.AGENTIC_ENV_FILE ?? '.env');
  assertProductionConfig();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const store = await createRuntimeWorkflowStore();
  const config = await loadConfig(process.env.AGENTIC_CONFIG_FILE);
  bootstrapHostConnectorFactoriesFromConfig(config);
  const server = createRenderWebServer({ store });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const commit = process.env.RENDER_GIT_COMMIT?.slice(0, 12) ?? process.env.AGENTIC_BUILD_ID ?? 'unknown';
  console.log(`Agentic web server listening on http://${host}:${port}`);
  console.log(`Agentic build commit=${commit} workflow_routes=enabled`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
