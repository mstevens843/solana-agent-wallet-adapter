import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { USDC_MINT_MAINNET } from '@solana-agent-wallet-adapter/bridge-router';
import { PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DevApiHandler, DevApiHandlerContext } from '../cloud/devApiRegistry.js';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const OTHER_WALLET = 'So11111111111111111111111111111111111111112';
const USDC_MINT = USDC_MINT_MAINNET;
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const [OFF_CURVE_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from('agent-bridge-test')],
  new PublicKey('11111111111111111111111111111111'),
);
const OFF_CURVE_RECIPIENT = OFF_CURVE_PDA.toBase58();

const ENV_KEYS = ['AGENTIC_DEV_AP2_ACP', 'AGENTIC_DEV_WALLET_ALLOWLIST'] as const;

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
  await import('../cloud/bridgeRoutes.js');
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

function postRaw(
  port: number,
  path: string,
  rawBody: string,
  headers: Record<string, string> = {},
  walletAddress: string | null = DEV_WALLET,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string | number> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(rawBody),
      ...headers,
    };
    if (walletAddress) reqHeaders['x-test-wallet'] = walletAddress;
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: reqHeaders,
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
    req.write(rawBody);
    req.end();
  });
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  walletAddress: string | null = DEV_WALLET,
): Promise<TestResponse> {
  return postRaw(port, path, JSON.stringify(body), {}, walletAddress);
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
  amountUsd: 50,
  recipient: DEV_WALLET,
  ...overrides,
});

describe('bridge settlement quote API (POST /api/agents/settlement/quote)', () => {
  let original: EnvSnapshot;

  beforeEach(() => {
    original = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(original);
  });

  describe('dev gate', () => {
    it('returns 403 when AGENTIC_DEV_AP2_ACP is not set', async () => {
      await withRoutes(
        { AGENTIC_DEV_AP2_ACP: undefined, AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
        async ({ port }) => {
          const response = await postJson(port, '/api/agents/settlement/quote', validBody());
          expect(response.status).toBe(403);
          expect(response.body).toEqual({ error: 'dev_layer1_disabled' });
        },
      );
    });

    it('returns 403 without a wallet header', async () => {
      await withRoutes(
        { AGENTIC_DEV_AP2_ACP: '1', AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
        async ({ port }) => {
          const response = await postJson(port, '/api/agents/settlement/quote', validBody(), null);
          expect(response.status).toBe(403);
        },
      );
    });

    it('returns 403 for a wallet not in the allowlist', async () => {
      await withRoutes(
        { AGENTIC_DEV_AP2_ACP: '1', AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
        async ({ port }) => {
          const response = await postJson(port, '/api/agents/settlement/quote', validBody(), OTHER_WALLET);
          expect(response.status).toBe(403);
        },
      );
    });
  });

  describe('valid requests', () => {
    const baseEnv = { AGENTIC_DEV_AP2_ACP: '1', AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET };

    it('returns an empty result with a no_route diagnostic when no payer holdings are supplied', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(port, '/api/agents/settlement/quote', validBody());
        expect(response.status).toBe(200);
        const result = response.body?.result as Record<string, unknown>;
        expect(result.best).toBeUndefined();
        expect(result.candidates).toEqual([]);
        const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.sourceId).toBe('direct-usdc');
        expect(diagnostics[0]?.status).toBe('no_route');
        expect(typeof diagnostics[0]?.latencyMs).toBe('number');
        expect(response.headers['cache-control']).toBe('no-store');
      });
    });

    it('returns a direct route as best when payerHoldings cover the amount', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({
            payerHoldings: [{ mint: USDC_MINT, amountRaw: '100000000', decimals: 6 }],
          }),
        );
        expect(response.status).toBe(200);
        const result = response.body?.result as Record<string, unknown>;
        const best = result.best as Record<string, unknown>;
        expect(best?.sourceId).toBe('direct-usdc');
        expect(best?.slippageBps).toBe(0);
        expect(best?.expectedUsdOut).toBe('50');
        expect(best?.estimatedCostUsd).toBe('50');
        const hops = best?.hops as Array<Record<string, unknown>>;
        expect(hops).toHaveLength(1);
        expect(hops[0]).toMatchObject({
          kind: 'direct',
          mint: USDC_MINT,
          amountRaw: '50000000',
          decimals: 6,
        });
        const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
        expect(diagnostics[0]?.status).toBe('ok');
      });
    });

    it('returns no_route when payerHoldings cannot cover the amount', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({
            payerHoldings: [{ mint: USDC_MINT, amountRaw: '1000000', decimals: 6 }],
          }),
        );
        expect(response.status).toBe(200);
        const result = response.body?.result as Record<string, unknown>;
        expect(result.best).toBeUndefined();
        const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
        expect(diagnostics[0]?.status).toBe('no_route');
      });
    });

    it('returns no_route when targetMint is not USDC (direct source declines)', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({
            targetMint: USDT_MINT,
            payerHoldings: [{ mint: USDC_MINT, amountRaw: '100000000', decimals: 6 }],
          }),
        );
        expect(response.status).toBe(200);
        const result = response.body?.result as Record<string, unknown>;
        expect(result.best).toBeUndefined();
        const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
        expect(diagnostics[0]?.status).toBe('no_route');
      });
    });

    it('routes the upper boundary amountUsd (100000) when holdings cover', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({
            amountUsd: 100_000,
            payerHoldings: [{ mint: USDC_MINT, amountRaw: '200000000000', decimals: 6 }],
          }),
        );
        expect(response.status).toBe(200);
        const best = (response.body?.result as Record<string, unknown>).best as Record<string, unknown>;
        const hops = best?.hops as Array<Record<string, unknown>>;
        expect(hops[0]?.amountRaw).toBe('100000000000');
      });
    });

    it('accepts an off-curve recipient when allowOffCurveRecipient is true', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ recipient: OFF_CURVE_RECIPIENT, allowOffCurveRecipient: true }),
        );
        expect(response.status).toBe(200);
        expect(response.body?.result).toBeDefined();
      });
    });

    it('accepts an explicit cluster value', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ cluster: 'devnet' }),
        );
        expect(response.status).toBe(200);
        expect(response.body?.result).toBeDefined();
      });
    });

    it('accepts a valid maxSlippageBps', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ maxSlippageBps: 100 }),
        );
        expect(response.status).toBe(200);
        expect(response.body?.result).toBeDefined();
      });
    });
  });

  describe('validation errors', () => {
    const baseEnv = { AGENTIC_DEV_AP2_ACP: '1', AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET };

    it('returns 400 for a missing body', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postRaw(port, '/api/agents/settlement/quote', '');
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_input');
      });
    });

    it('returns 400 for malformed JSON', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postRaw(port, '/api/agents/settlement/quote', '{ this is not json');
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_json');
      });
    });

    it('returns 400 for a non-object body (array)', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postRaw(port, '/api/agents/settlement/quote', '[1,2,3]');
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_input');
      });
    });

    it('returns 400 when amountUsd is missing', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(port, '/api/agents/settlement/quote', { recipient: DEV_WALLET });
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_amount');
      });
    });

    it('returns 400 when amountUsd is zero', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(port, '/api/agents/settlement/quote', validBody({ amountUsd: 0 }));
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_amount');
      });
    });

    it('returns 400 when amountUsd is negative', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(port, '/api/agents/settlement/quote', validBody({ amountUsd: -10 }));
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_amount');
      });
    });

    it('returns 400 when amountUsd exceeds the maximum', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(port, '/api/agents/settlement/quote', validBody({ amountUsd: 100_001 }));
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_amount');
      });
    });

    it('returns 400 when amountUsd is a string', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(port, '/api/agents/settlement/quote', validBody({ amountUsd: '50' }));
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_amount');
      });
    });

    it('returns 400 when amountUsd is NaN', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        // JSON.stringify(NaN) is 'null', so send raw to preserve NaN-like semantics.
        const response = await postRaw(
          port,
          '/api/agents/settlement/quote',
          '{"amountUsd":null,"recipient":"' + DEV_WALLET + '"}',
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_amount');
      });
    });

    it('returns 400 when recipient is missing', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(port, '/api/agents/settlement/quote', { amountUsd: 50 });
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_recipient');
      });
    });

    it('returns 400 when recipient is an empty string', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(port, '/api/agents/settlement/quote', validBody({ recipient: '' }));
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_recipient');
      });
    });

    it('returns 400 when recipient is not a valid base58 pubkey', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ recipient: 'not-a-valid-pubkey!!!' }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_recipient');
      });
    });

    it('returns 400 when recipient is off-curve and allowOffCurveRecipient is not set', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ recipient: OFF_CURVE_RECIPIENT }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_recipient');
      });
    });

    it('returns 400 when targetMint is not a string', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ targetMint: 12345 }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_target_mint');
      });
    });

    it('returns 400 when targetMint is not a valid base58 address', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ targetMint: 'invalid-mint!!!' }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_target_mint');
      });
    });

    it('returns 413 when the body exceeds the size limit', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const filler = 'a'.repeat(20_000);
        const body = JSON.stringify({ amountUsd: 50, recipient: DEV_WALLET, filler });
        const response = await postRaw(port, '/api/agents/settlement/quote', body);
        expect(response.status).toBe(413);
        expect(response.body?.error).toBe('body_too_large');
      });
    });

    it('returns 400 invalid_cluster when cluster is not a supported value', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ cluster: 'testnet' }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_cluster');
      });
    });

    it('returns 400 invalid_payer_holdings when payerHoldings is not an array', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ payerHoldings: { mint: USDC_MINT } }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_payer_holdings');
      });
    });

    it('returns 400 invalid_payer_holdings when a holding mint is invalid', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({
            payerHoldings: [{ mint: 'not-base58!!!', amountRaw: '100', decimals: 6 }],
          }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_payer_holdings');
      });
    });

    it('returns 400 invalid_payer_holdings when amountRaw is not digit-only', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({
            payerHoldings: [{ mint: USDC_MINT, amountRaw: '100.5', decimals: 6 }],
          }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_payer_holdings');
      });
    });

    it('returns 400 invalid_payer_holdings when decimals is out of range', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({
            payerHoldings: [{ mint: USDC_MINT, amountRaw: '100', decimals: 25 }],
          }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_payer_holdings');
      });
    });

    it('returns 400 invalid_max_slippage when maxSlippageBps is negative', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ maxSlippageBps: -10 }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_max_slippage');
      });
    });

    it('returns 400 invalid_max_slippage when maxSlippageBps exceeds 10000', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ maxSlippageBps: 10_001 }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_max_slippage');
      });
    });

    it('returns 400 invalid_max_slippage when maxSlippageBps is non-integer', async () => {
      await withRoutes(baseEnv, async ({ port }) => {
        const response = await postJson(
          port,
          '/api/agents/settlement/quote',
          validBody({ maxSlippageBps: 12.5 }),
        );
        expect(response.status).toBe(400);
        expect(response.body?.error).toBe('invalid_max_slippage');
      });
    });
  });
});
