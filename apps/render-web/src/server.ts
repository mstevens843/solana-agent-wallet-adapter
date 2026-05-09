import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { redactSecrets } from './cloud/redaction.js';
import { createCloudApiRouter, type CloudApiRouter, type CloudApiRouterOptions } from './cloud/router.js';
import { assertProductionConfig, createRuntimeWorkflowStore } from './cloud/runtimeStore.js';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3000;
const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../browser-demo/dist', import.meta.url));

interface RenderWebServerOptions extends CloudApiRouterOptions {
  staticDir?: string;
}

export function createRenderWebServer(options: RenderWebServerOptions = {}): Server {
  const staticDir = resolve(options.staticDir ?? process.env.AGENTIC_WEB_DIST ?? DEFAULT_STATIC_DIR);
  const apiRouter = createCloudApiRouter({
    store: options.store,
    clock: options.clock,
    authRateLimiter: options.authRateLimiter,
    recurringPolicy: options.recurringPolicy,
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
  setCommonHeaders(res);

  try {
    if (url.pathname.startsWith('/api/')) {
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

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
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
  assertProductionConfig();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const store = await createRuntimeWorkflowStore();
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
