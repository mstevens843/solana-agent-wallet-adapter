import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';

import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STREAMING_VOUCHER_SCHEMA,
  generateEphemeralKeypair,
  signVoucher,
  type EphemeralKeypair,
} from '@solana-agent-wallet-adapter/streaming-sessions';

import { listDevApiHandlers, type DevApiHandlerContext } from '../cloud/devApiRegistry.js';
import { MemoryEvidenceStore } from '../cloud/evidenceService.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import {
  StreamingService,
  streamingStoreFor,
  type StreamingStore,
} from '../cloud/streamingService.js';
import '../cloud/streamingRoutes.js';

const WALLET = Keypair.generate().publicKey.toBase58();
const OTHER_WALLET = Keypair.generate().publicKey.toBase58();
const TOKEN_MINT = Keypair.generate().publicKey.toBase58();
const RECENT_BLOCKHASH = Keypair.generate().publicKey.toBase58();
const NOW = '2026-05-16T12:00:00.000Z';

describe('streaming session routes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts server-relayed voucher signing and pre-signed voucher submissions', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createRouteContext();
    const sessionId = await createActiveSession(ctx);

    await withStreamingServer(ctx, async (port) => {
      const relayed = await requestJson(port, `/api/streaming/sessions/${sessionId}/voucher-relay`, 'POST', {
        amount: '0.05',
        recipient,
        nonce: 'nonce_route_relayed',
        issuedAt: '2026-05-16T12:00:01.000Z',
      });

      expect(relayed.status).toBe(200);
      expect(relayed.body).toMatchObject({
        accepted: true,
        remaining: '0.95',
        voucherHash: expect.any(String),
      });
      expect(asRecord(relayed.body.voucher, 'voucher')).toMatchObject({
        id: expect.any(String),
        sessionId,
        nonce: 'nonce_route_relayed',
        amount: '0.05',
        recipient,
        voucherHash: expect.any(String),
      });
      expect(asRecord(relayed.body.signedVoucher, 'signedVoucher')).toMatchObject({
        schema: STREAMING_VOUCHER_SCHEMA,
        sessionId,
        nonce: 'nonce_route_relayed',
        amount: '0.05',
        recipient,
        issuedAt: '2026-05-16T12:00:01.000Z',
        signature: expect.any(String),
      });

      const signed = signVoucher(ctx.keypair, {
        sessionId,
        nonce: 'nonce_route_presigned',
        amount: '0.05',
        recipient,
        issuedAt: '2026-05-16T12:00:02.000Z',
      });
      const submitted = await requestJson(port, `/api/streaming/sessions/${sessionId}/voucher`, 'POST', {
        voucher: signed,
      });

      expect(submitted.status).toBe(200);
      expect(asRecord(submitted.body.signedVoucher, 'signedVoucher')).toMatchObject({
        sessionId,
        nonce: 'nonce_route_presigned',
        signature: signed.signature,
      });

      const mismatch = await requestJson(port, `/api/streaming/sessions?walletAddress=${OTHER_WALLET}`);
      expect(mismatch.status).toBe(403);
      expect(mismatch.body).toMatchObject({ error: 'wallet_mismatch' });
    });
  });

  it('force-settles the requested authenticated-wallet session through the route', async () => {
    vi.stubEnv('STREAMING_TEST_RECENT_BLOCKHASH', RECENT_BLOCKHASH);
    vi.stubEnv('STREAMING_TEST_SETTLEMENT_TXID', 'STREAM_TX_ROUTE');
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createRouteContext();
    const sessionId = await createActiveSession(ctx);
    await ctx.service.acceptVoucher({
      walletAddress: WALLET,
      sessionId,
      voucher: signVoucher(ctx.keypair, {
        sessionId,
        nonce: 'nonce_route_settle',
        amount: '0.05',
        recipient,
        issuedAt: '2026-05-16T12:00:01.000Z',
      }),
    });

    await withStreamingServer(ctx, async (port) => {
      const settled = await requestJson(port, `/api/streaming/sessions/${sessionId}/settle`, 'POST', {});

      expect(settled.status).toBe(200);
      expect(settled.body).toMatchObject({
        sessionId,
        settled: 1,
        failed: 0,
        skipped: 0,
        receipts: [expect.objectContaining({
          kind: 'streaming_settlement',
          metadata: expect.objectContaining({
            sessionId,
            txid: 'STREAM_TX_ROUTE',
          }),
        })],
      });
    });

    const receipts = await ctx.evidenceStore.listEvidence(WALLET);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.metadata?.sessionId).toBe(sessionId);
  });

  it('rejects native SOL pseudo-mint at createSession (P4.2 server-layer guard)', async () => {
    const ctx = createRouteContext();
    await expect(
      ctx.service.createSession({
        walletAddress: WALLET,
        tokenMint: '11111111111111111111111111111111',
        capAmount: '1',
        expiresAt: '2026-05-16T13:00:00.000Z',
        cluster: 'devnet',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'unsupported_native_sol',
    });
  });

  // ─── $SKR Android-only session token default ────────────────────────────
  //
  // When the client identifies as `android-bundled` AND `SKR_TOKEN_MINT` is
  // set AND `SKR_SESSION_DEFAULT=true`, a streaming-session create request
  // that omits `tokenMint` should default to the configured SKR mint. Any
  // single gating signal missing should preserve the historical behavior
  // (tokenMint stays required, missing → 400). This is the only place where
  // a streaming session can be created without an explicit mint, so the
  // gating logic carries weight.
  describe('$SKR Android session default', () => {
    const SKR_MINT_FIXTURE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    // The Android default body intentionally omits `tokenMint` to exercise
    // the server-side default. Everything else mirrors a real session.
    const ANDROID_DEFAULT_BODY = {
      capAmount: '1',
      expiresAt: '2026-05-16T13:00:00.000Z',
      cluster: 'devnet' as const,
    };

    it('defaults tokenMint to $SKR when android-bundled + SKR_TOKEN_MINT set + SKR_SESSION_DEFAULT=true', async () => {
      const ctx = createRouteContext();
      vi.stubEnv('SKR_TOKEN_MINT', SKR_MINT_FIXTURE);
      vi.stubEnv('SKR_SESSION_DEFAULT', 'true');
      await withStreamingServer(ctx, async (port) => {
        const res = await requestJson(
          port,
          '/api/streaming/sessions',
          'POST',
          ANDROID_DEFAULT_BODY,
          { 'x-agentic-client': 'android-bundled' },
        );
        expect(res.status).toBe(201);
        const session = asRecord(res.body.session, 'session');
        expect(session.tokenMint).toBe(SKR_MINT_FIXTURE);
      });
    });

    it('honors SKR_TOKEN_DECIMALS when defaulting the session mint', async () => {
      const ctx = createRouteContext();
      vi.stubEnv('SKR_TOKEN_MINT', SKR_MINT_FIXTURE);
      vi.stubEnv('SKR_TOKEN_DECIMALS', '9');
      vi.stubEnv('SKR_SESSION_DEFAULT', 'true');
      await withStreamingServer(ctx, async (port) => {
        const res = await requestJson(
          port,
          '/api/streaming/sessions',
          'POST',
          ANDROID_DEFAULT_BODY,
          { 'x-agentic-client': 'android-bundled' },
        );
        expect(res.status).toBe(201);
        const session = asRecord(res.body.session, 'session');
        expect(session.tokenMint).toBe(SKR_MINT_FIXTURE);
        expect(session.tokenDecimals).toBe(9);
      });
    });

    it('does NOT default tokenMint for web clients (no x-agentic-client header)', async () => {
      const ctx = createRouteContext();
      vi.stubEnv('SKR_TOKEN_MINT', SKR_MINT_FIXTURE);
      vi.stubEnv('SKR_SESSION_DEFAULT', 'true');
      await withStreamingServer(ctx, async (port) => {
        const res = await requestJson(
          port,
          '/api/streaming/sessions',
          'POST',
          ANDROID_DEFAULT_BODY,
          // No x-agentic-client header — historical web client.
        );
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('missing_field');
        expect(String(res.body.message ?? '')).toContain('tokenMint');
      });
    });

    it('does NOT default tokenMint when SKR_TOKEN_MINT is unset', async () => {
      const ctx = createRouteContext();
      vi.stubEnv('SKR_SESSION_DEFAULT', 'true');
      // SKR_TOKEN_MINT intentionally not stubbed — should disable the default.
      await withStreamingServer(ctx, async (port) => {
        const res = await requestJson(
          port,
          '/api/streaming/sessions',
          'POST',
          ANDROID_DEFAULT_BODY,
          { 'x-agentic-client': 'android-bundled' },
        );
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('missing_field');
      });
    });

    it('does NOT default tokenMint when SKR_SESSION_DEFAULT is not "true"', async () => {
      const ctx = createRouteContext();
      vi.stubEnv('SKR_TOKEN_MINT', SKR_MINT_FIXTURE);
      // Common operator typos that mean "yes" but are not the literal "true"
      // string — these MUST NOT enable the default (defense in depth against
      // accidental rollout).
      vi.stubEnv('SKR_SESSION_DEFAULT', '1');
      await withStreamingServer(ctx, async (port) => {
        const res = await requestJson(
          port,
          '/api/streaming/sessions',
          'POST',
          ANDROID_DEFAULT_BODY,
          { 'x-agentic-client': 'android-bundled' },
        );
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('missing_field');
      });
    });

    it('respects an explicit tokenMint from the Android client (default is only a fallback)', async () => {
      // The default kicks in ONLY when tokenMint is omitted. If the Android
      // client sends a different mint explicitly, the request uses that mint
      // — preserving the user's stated intent over a deployment default.
      const explicitMint = Keypair.generate().publicKey.toBase58();
      const ctx = createRouteContext();
      vi.stubEnv('SKR_TOKEN_MINT', SKR_MINT_FIXTURE);
      vi.stubEnv('SKR_SESSION_DEFAULT', 'true');
      await withStreamingServer(ctx, async (port) => {
        const res = await requestJson(
          port,
          '/api/streaming/sessions',
          'POST',
          { ...ANDROID_DEFAULT_BODY, tokenMint: explicitMint },
          { 'x-agentic-client': 'android-bundled' },
        );
        expect(res.status).toBe(201);
        const session = asRecord(res.body.session, 'session');
        expect(session.tokenMint).toBe(explicitMint);
      });
    });
  });
});

interface RouteTestContext {
  keypair: EphemeralKeypair;
  store: StreamingStore;
  service: StreamingService;
  evidenceStore: MemoryEvidenceStore;
  context: DevApiHandlerContext;
}

function createRouteContext(): RouteTestContext {
  let nextId = 0;
  const keypair = generateEphemeralKeypair();
  const workflowStore = new MemoryWorkflowStore();
  const evidenceStore = new MemoryEvidenceStore();
  const clock = { now: () => new Date(NOW) };
  const store = streamingStoreFor(workflowStore);
  const service = new StreamingService(store, {
    clock,
    keypairFactory: () => keypair,
    idFactory: () => `route_${++nextId}`,
    latestBlockhash: async () => RECENT_BLOCKHASH,
  });
  return {
    keypair,
    store,
    service,
    evidenceStore,
    context: {
      walletAddress: WALLET,
      workflowStore,
      evidenceStore,
      clock,
      workflowService: {} as DevApiHandlerContext['workflowService'],
    },
  };
}

async function createActiveSession(ctx: RouteTestContext): Promise<string> {
  const created = await ctx.service.createSession({
    walletAddress: WALLET,
    tokenMint: TOKEN_MINT,
    capAmount: '1',
    expiresAt: '2026-05-16T13:00:00.000Z',
    cluster: 'devnet',
  });
  await ctx.service.recordGrantSigned({
    walletAddress: WALLET,
    sessionId: created.session.sessionId,
    approveTxid: `APPROVE_${created.session.sessionId}`,
  });
  return created.session.sessionId;
}

async function withStreamingServer<T>(
  ctx: RouteTestContext,
  callback: (port: number) => Promise<T>,
): Promise<T> {
  const handler = listDevApiHandlers().find((candidate) => candidate.prefix === '/api/streaming/');
  if (!handler) throw new Error('Streaming handler was not registered.');
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    void handler.handle(req, res, url, ctx.context).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    }).catch((err) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    return await callback(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function requestJson(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const baseHeaders: Record<string, string | number> = raw
      ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(raw),
        }
      : {};
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { ...baseHeaders, ...(extraHeaders ?? {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          body: text ? JSON.parse(text) as Record<string, unknown> : {},
        });
      });
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}
