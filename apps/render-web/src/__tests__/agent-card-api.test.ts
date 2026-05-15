import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DevApiHandler, DevApiHandlerContext } from '../cloud/devApiRegistry.js';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const OTHER_WALLET = 'So11111111111111111111111111111111111111112';
const OVERRIDE_WALLET = 'BvgrFr5Bcaa9NudH3DCxgMnHV1FT1nzD5JtMHsmpKnFB';

const ENV_KEYS = [
  'AGENTIC_DEV_AP2_ACP',
  'AGENTIC_DEV_WALLET_ALLOWLIST',
  'AGENTIC_AGENT_CARD_WALLET',
  'AGENTIC_PUBLIC_ORIGIN',
  'RENDER_GIT_COMMIT',
  'AGENTIC_BUILD_ID',
] as const;

interface TestResponse {
  status: number;
  body: Record<string, unknown> | null;
  rawBody: string;
  headers: IncomingHttpHeaders;
}

type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const key of ENV_KEYS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snap[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const [key, value] of Object.entries(env) as Array<[(typeof ENV_KEYS)[number], string | undefined]>) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

interface DevGateModule {
  DEV_WALLET_ALLOWLIST: readonly string[];
  isAllowedDevWallet: (walletAddress: string | undefined | null) => boolean;
  devLayer1Enabled: () => boolean;
}

interface RegistryModule {
  listDevApiHandlers: () => readonly DevApiHandler[];
  clearDevApiHandlersForTesting: () => void;
}

async function loadFreshRoutes(): Promise<{ handlers: readonly DevApiHandler[]; gate: DevGateModule }> {
  vi.resetModules();
  const registry = (await import('../cloud/devApiRegistry.js')) as RegistryModule;
  registry.clearDevApiHandlersForTesting();
  await import('../cloud/agentCardRoutes.js');
  const gate = (await import('../cloud/devGate.js')) as DevGateModule;
  return { handlers: registry.listDevApiHandlers(), gate };
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: readonly DevApiHandler[],
  gate: DevGateModule,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';
  const handler = handlers.find(
    (h) => url.pathname.startsWith(h.prefix) && h.methods.includes(method),
  );
  if (!handler) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  let walletAddress: string | undefined;
  if (!handler.publicRoute) {
    if (!gate.devLayer1Enabled()) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'dev_layer1_disabled' }));
      return;
    }
    const headerWallet = req.headers['x-test-wallet'];
    walletAddress = typeof headerWallet === 'string' ? headerWallet : undefined;
    if (!gate.isAllowedDevWallet(walletAddress)) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'dev_layer1_disabled' }));
      return;
    }
  }
  const context: DevApiHandlerContext = {
    walletAddress,
    workflowService: {} as DevApiHandlerContext['workflowService'],
    workflowStore: {} as DevApiHandlerContext['workflowStore'],
    evidenceStore: {} as DevApiHandlerContext['evidenceStore'],
    clock: { now: () => new Date() },
  };
  try {
    await handler.handle(req, res, url, context);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'internal_error', message: err instanceof Error ? err.message : 'unknown' }));
    }
  }
}

async function withRoutes(
  env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  callback: (server: { port: number }) => Promise<void>,
): Promise<void> {
  setEnv(env);
  const { handlers, gate } = await loadFreshRoutes();
  const server = createServer((req, res) => {
    void dispatch(req, res, handlers, gate);
  });
  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback({ port: address.port });
  } finally {
    await close(server);
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: Record<string, unknown> | null = null;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              body = null;
            }
          }
          resolve({
            status: res.statusCode ?? 0,
            body,
            rawBody: raw,
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('agent-card API (public + dev preview)', () => {
  let original: EnvSnapshot;

  beforeEach(() => {
    original = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(original);
  });

  describe('GET /.well-known/agent.json (public)', () => {
    it('returns 200 with a valid AgentCard for an anonymous request', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: '1',
          AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
          AGENTIC_AGENT_CARD_WALLET: undefined,
          AGENTIC_PUBLIC_ORIGIN: undefined,
          RENDER_GIT_COMMIT: 'abcdef1234567890',
          AGENTIC_BUILD_ID: undefined,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'GET', '/.well-known/agent.json');
          expect(response.status).toBe(200);
          expect(response.body).toMatchObject({
            schemaVersion: '1.0',
            name: 'Agentic Wallet',
            walletAddress: DEV_WALLET,
            supportedProtocols: ['ap2', 'acp'],
            supportedTokens: ['USDC', 'USDT', 'SOL'],
            capabilities: ['ap2.inbound', 'acp.outbound', 'bridge.quote'],
          });
          expect(response.body?.version).toBe('abcdef123456');
          expect(response.body?.serviceEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/agents$/);
          expect(response.body?.paymentMethods).toEqual([
            { network: 'solana-mainnet', settlement: 'spl-transfer' },
          ]);
        },
      );
    });

    it('prefers AGENTIC_AGENT_CARD_WALLET over the allowlist when set', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: '1',
          AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
          AGENTIC_AGENT_CARD_WALLET: OVERRIDE_WALLET,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'GET', '/.well-known/agent.json');
          expect(response.status).toBe(200);
          expect(response.body?.walletAddress).toBe(OVERRIDE_WALLET);
        },
      );
    });

    it('uses AGENTIC_PUBLIC_ORIGIN for serviceEndpoint when set', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: '1',
          AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
          AGENTIC_PUBLIC_ORIGIN: 'https://agentic-signer.com',
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'GET', '/.well-known/agent.json');
          expect(response.status).toBe(200);
          expect(response.body?.serviceEndpoint).toBe('https://agentic-signer.com/api/agents');
        },
      );
    });

    it('returns 503 when allowlist and override are both empty', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: '1',
          AGENTIC_DEV_WALLET_ALLOWLIST: '',
          AGENTIC_AGENT_CARD_WALLET: undefined,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'GET', '/.well-known/agent.json');
          expect(response.status).toBe(503);
          expect(response.body).toEqual({ error: 'no_dev_wallet_configured' });
        },
      );
    });

    it('sets Cache-Control: public, max-age=60 and CORS headers', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: '1',
          AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'GET', '/.well-known/agent.json');
          expect(response.status).toBe(200);
          expect(response.headers['cache-control']).toBe('public, max-age=60');
          expect(response.headers['access-control-allow-origin']).toBe('*');
          expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
          expect(response.headers['vary']).toBe('Origin');
          expect(response.headers['content-type']).toMatch(/application\/json/);
        },
      );
    });

    it('responds to HEAD with status 200, no body, but same headers', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: '1',
          AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'HEAD', '/.well-known/agent.json');
          expect(response.status).toBe(200);
          expect(response.rawBody).toBe('');
          expect(response.headers['cache-control']).toBe('public, max-age=60');
          expect(response.headers['access-control-allow-origin']).toBe('*');
        },
      );
    });

    it('responds to OPTIONS with 204 + CORS preflight headers', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: '1',
          AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'OPTIONS', '/.well-known/agent.json');
          expect(response.status).toBe(204);
          expect(response.rawBody).toBe('');
          expect(response.headers['access-control-allow-origin']).toBe('*');
          expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
          expect(response.headers['access-control-max-age']).toBe('600');
        },
      );
    });

    it('works even when AGENTIC_DEV_AP2_ACP is unset (public bypasses the gate)', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: undefined,
          AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'GET', '/.well-known/agent.json');
          expect(response.status).toBe(200);
          expect(response.body?.walletAddress).toBe(DEV_WALLET);
        },
      );
    });

    it('uses the first allowlist entry when multiple wallets are configured', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: '1',
          AGENTIC_DEV_WALLET_ALLOWLIST: `${DEV_WALLET},${OTHER_WALLET}`,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'GET', '/.well-known/agent.json');
          expect(response.status).toBe(200);
          expect(response.body?.walletAddress).toBe(DEV_WALLET);
        },
      );
    });
  });

  describe('GET /api/agents/card (dev-gated preview)', () => {
    it('returns 403 when AGENTIC_DEV_AP2_ACP is not set', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: undefined,
          AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'GET', '/api/agents/card', {
            'x-test-wallet': DEV_WALLET,
          });
          expect(response.status).toBe(403);
          expect(response.body).toEqual({ error: 'dev_layer1_disabled' });
        },
      );
    });

    it('returns 403 without a wallet header', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: '1',
          AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'GET', '/api/agents/card');
          expect(response.status).toBe(403);
          expect(response.body).toEqual({ error: 'dev_layer1_disabled' });
        },
      );
    });

    it('returns 403 with a wallet not in the allowlist', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: '1',
          AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'GET', '/api/agents/card', {
            'x-test-wallet': OTHER_WALLET,
          });
          expect(response.status).toBe(403);
          expect(response.body).toEqual({ error: 'dev_layer1_disabled' });
        },
      );
    });

    it('returns 200 with the AgentCard for an allowlisted wallet', async () => {
      await withRoutes(
        {
          AGENTIC_DEV_AP2_ACP: '1',
          AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
        },
        async ({ port }) => {
          const response = await rawRequest(port, 'GET', '/api/agents/card', {
            'x-test-wallet': DEV_WALLET,
          });
          expect(response.status).toBe(200);
          expect(response.body).toMatchObject({
            schemaVersion: '1.0',
            name: 'Agentic Wallet',
            walletAddress: DEV_WALLET,
            supportedProtocols: ['ap2', 'acp'],
          });
          expect(response.headers['cache-control']).toBe('no-store');
          expect(response.headers['access-control-allow-origin']).toBeUndefined();
        },
      );
    });
  });
});
