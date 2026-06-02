import { createServer as createHttpListener, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { WalletBackend } from '@solana-agent-wallet-adapter/core';

import { createServer as createMcpServer } from './server.js';
import type { AgentWalletConfig } from './config.js';
import type { PreparedActionStore } from './preparedActions.js';

const MAX_MCP_HTTP_JSON_BYTES = 1024 * 1024;

export interface CreateHttpServerOptions {
  backend: WalletBackend;
  port?: number;
  host?: string;
  path?: string;
  serverName?: string;
  serverVersion?: string;
  actionConfig?: AgentWalletConfig;
  preparedActions?: PreparedActionStore;
  /**
   * If true, generate a session ID per client and require it on subsequent requests.
   * If false (default), run statelessly: every request is independent.
   */
  stateful?: boolean;
  /**
   * Bearer token required on every MCP HTTP request (Authorization: Bearer <token>
   * or x-agent-wallet-token). Mandatory when binding a non-loopback host.
   */
  requireToken?: string;
  /** Explicit opt-in to bind a non-loopback host. Requires a strong requireToken. */
  allowNonLoopbackBind?: boolean;
}

const MIN_MCP_HTTP_TOKEN_LENGTH = 24;

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.startsWith('127.');
}

function isStrongMcpHttpToken(token: string | undefined): token is string {
  return typeof token === 'string' && token.trim().length >= MIN_MCP_HTTP_TOKEN_LENGTH;
}

function readBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const alt = req.headers['x-agent-wallet-token'];
  if (typeof alt === 'string' && alt.trim()) return alt.trim();
  return undefined;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function assertMcpHttpBindAllowed(host: string, options: CreateHttpServerOptions): void {
  if (isLoopbackHost(host)) return;
  if (!options.allowNonLoopbackBind) {
    throw new Error(
      `Refusing to bind the MCP HTTP server to non-loopback host "${host}". Set MCP_HTTP_ALLOW_NON_LOOPBACK=1 and a strong MCP_HTTP_TOKEN to expose it deliberately. Never expose the MCP HTTP port to the public internet.`,
    );
  }
  if (!isStrongMcpHttpToken(options.requireToken)) {
    throw new Error(
      `Refusing to bind the MCP HTTP server to non-loopback host "${host}" without a strong MCP_HTTP_TOKEN (>= ${MIN_MCP_HTTP_TOKEN_LENGTH} chars).`,
    );
  }
}

export interface HttpServerHandle {
  url: string;
  port: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createHttpServer(options: CreateHttpServerOptions): HttpServerHandle {
  const port = options.port ?? 8723;
  const host = options.host ?? '127.0.0.1';
  const path = options.path ?? '/mcp';

  const mcpServer = createMcpServer({
    backend: options.backend,
    ...(options.serverName !== undefined && { serverName: options.serverName }),
    ...(options.serverVersion !== undefined && { serverVersion: options.serverVersion }),
    ...(options.actionConfig !== undefined && { actionConfig: options.actionConfig }),
    ...(options.preparedActions !== undefined && { preparedActions: options.preparedActions }),
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: options.stateful ? () => randomUUID() : undefined,
  });

  let httpServer: HttpServer | null = null;
  let connected = false;

  return {
    url: `http://${host}:${port}${path}`,
    port,
    async start() {
      assertMcpHttpBindAllowed(host, options);
      if (!connected) {
        await mcpServer.connect(transport);
        connected = true;
      }
      await new Promise<void>((resolve, reject) => {
        httpServer = createHttpListener(async (req, res) => {
          if (!req.url) {
            res.statusCode = 400;
            res.end();
            return;
          }
          const url = new URL(req.url, `http://${req.headers.host ?? host}`);
          if (url.pathname !== path) {
            res.statusCode = 404;
            res.end();
            return;
          }
          if (options.requireToken) {
            const provided = readBearerToken(req);
            if (!provided || !tokensMatch(provided, options.requireToken)) {
              res.statusCode = 401;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: 'unauthorized' }));
              return;
            }
          }
          try {
            const body = await readJsonBody(req);
            await transport.handleRequest(req, res, body);
          } catch (err) {
            if (!res.headersSent) {
              res.statusCode = err instanceof Error && err.message.includes('too large') ? 413 : 500;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'unknown' }));
            } else {
              res.end();
            }
          }
        });
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => resolve());
      });
    },
    async stop() {
      if (!httpServer) return;
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
      httpServer = null;
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    totalBytes += buffer.length;
    if (totalBytes > MAX_MCP_HTTP_JSON_BYTES) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err instanceof Error ? err.message : 'parse error'}`);
  }
}
