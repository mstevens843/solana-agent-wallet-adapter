import { generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseAuthNonceResponse,
  parseSessionResponse,
} from '@solana-agent-wallet-adapter/workflow';
import { afterEach, describe, expect, it } from 'vitest';

import { encodeBase58 } from '../cloud/auth.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import type { AuthRateLimiter } from '../cloud/router.js';
import { createWalletSession, sessionFromRequest } from '../cloud/session.js';
import type { Clock } from '../cloud/store.js';
import { createRenderWebServer } from '../server.js';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

interface TestWallet {
  walletAddress: string;
  privateKey: KeyObject;
}

describe('render web cloud wallet auth', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('creates a sign-in nonce for a valid wallet address', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      });

      expect(response.status).toBe(200);
      expect(response.body.walletAddress).toBe(wallet.walletAddress);
      expect(response.body.nonce).toEqual(expect.any(String));
      expect(response.body.domain).toBe(`127.0.0.1:${port}`);
      expect(String(response.body.message)).toContain(`Wallet: ${wallet.walletAddress}`);
      expect(String(response.body.message)).toContain('does not grant spending authority');
      expect(parseAuthNonceResponse(response.body)).toMatchObject({
        walletAddress: wallet.walletAddress,
        domain: `127.0.0.1:${port}`,
      });
    });
  });

  it('creates an HTTP-only session from a valid wallet signature', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(200);
      expect(verify.body).toMatchObject({
        signedIn: true,
        user: {
          walletAddress: wallet.walletAddress,
        },
        capabilities: {
          mode: 'agentic_cloud',
          requiresWalletSession: true,
          requiresLocalhost: false,
        },
        session: {
          walletAddress: wallet.walletAddress,
        },
        expiresAt: expect.any(String),
      });
      expect(parseSessionResponse(verify.body)).toMatchObject({
        signedIn: true,
        session: {
          walletAddress: wallet.walletAddress,
        },
      });
      expect(firstSetCookie(verify)).toContain('agentic_session=');
      expect(firstSetCookie(verify)).toContain('HttpOnly');
      expect(firstSetCookie(verify)).toContain('SameSite=Lax');

      const session = await getJson(port, '/api/session', {
        cookie: sessionCookie(verify),
      });
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({
        signedIn: true,
        user: {
          walletAddress: wallet.walletAddress,
        },
      });
      expect(parseSessionResponse(session.body).signedIn).toBe(true);
    });
  });

  it('keeps legacy minimal verify payloads working for the current browser client', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const body = signedVerifyBody(wallet, nonce.body);
      delete body.domain;
      delete body.issuedAt;
      delete body.expiresAt;
      delete body.signatureEncoding;

      const verify = await postJson(port, '/api/auth/verify-wallet', body);

      expect(verify.status).toBe(200);
      expect(parseSessionResponse(verify.body).signedIn).toBe(true);
    });
  });

  it('rejects invalid wallet signatures', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const otherWallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const body = signedVerifyBody(wallet, nonce.body);
      body.signature = signMessage(String(nonce.body.message), otherWallet.privateKey);

      const verify = await postJson(port, '/api/auth/verify-wallet', body);

      expect(verify.status).toBe(401);
      expect(String(verify.body.error)).toContain('signature');
    });
  });

  it('rejects expired nonces', async () => {
    const clock = mutableClock('2026-05-08T18:00:00.000Z');
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      clock.set('2026-05-08T18:06:00.000Z');

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(String(verify.body.error)).toContain('expired');
    }, { clock });
  });

  it('rejects a nonce that expires before the atomic consume step', async () => {
    // Auth endpoints also read the clock for rate limiting before route handlers run.
    const clock = queuedClock([
      '2026-05-08T17:59:58.000Z',
      '2026-05-08T17:59:59.000Z',
      '2026-05-08T18:00:00.000Z',
      '2026-05-08T18:04:59.998Z',
      '2026-05-08T18:04:59.999Z',
      '2026-05-08T18:05:00.000Z',
    ]);
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(firstSetCookie(verify)).toBe('');
    }, { clock });
  });

  it('rejects replayed nonces', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const body = signedVerifyBody(wallet, nonce.body);

      const first = await postJson(port, '/api/auth/verify-wallet', body);
      const replay = await postJson(port, '/api/auth/verify-wallet', body);

      expect(first.status).toBe(200);
      expect(replay.status).toBe(401);
      expect(String(replay.body.error)).toContain('used');
    });
  });

  it('does not create a session if nonce consumption loses a replay race', async () => {
    const store = new ReplayRaceStore();
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(firstSetCookie(verify)).toBe('');
    }, { store });
  });

  it('binds auth messages to AGENTIC_PUBLIC_ORIGIN when configured', async () => {
    await withEnv({ AGENTIC_PUBLIC_ORIGIN: 'https://agentic.example' }, async () => {
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const nonce = await createNonce(port, wallet);

        expect(nonce.body.domain).toBe('agentic.example');
        const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

        expect(verify.status).toBe(200);
      });
    });
  });

  it('rejects a signed nonce on a different domain', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      }, {
        host: 'agentic.example',
      });

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(String(verify.body.error)).toContain('domain');
    });
  });

  it('rejects cross-origin state-changing API requests', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      }, {
        origin: 'https://evil.example',
      });

      expect(response.status).toBe(403);
      expect(String(response.body.error)).toContain('Cross-origin');
    });
  });

  it('rate limits wallet auth endpoints', async () => {
    const authRateLimiter: AuthRateLimiter = {
      allow: () => false,
    };
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      });

      expect(response.status).toBe(429);
      expect(String(response.body.error)).toContain('Too many');
    }, { authRateLimiter });
  });

  it('passes the injected clock to the wallet auth rate limiter', async () => {
    const clock = fixedClock('2026-05-08T19:00:00.000Z');
    const seen: string[] = [];
    const authRateLimiter: AuthRateLimiter = {
      allow: (input) => {
        seen.push(input.now.toISOString());
        return true;
      },
    };

    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      });

      expect(response.status).toBe(200);
    }, { authRateLimiter, clock });

    expect(seen).toEqual(['2026-05-08T19:00:00.000Z']);
  });

  it('clears the session on logout', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));
      const cookie = sessionCookie(verify);

      const logout = await postJson(port, '/api/auth/logout', {}, { cookie });
      const session = await getJson(port, '/api/session', { cookie });

      expect(logout.status).toBe(200);
      expect(parseSessionResponse(logout.body)).toMatchObject({
        signedIn: false,
        capabilities: {
          mode: 'agentic_cloud',
        },
      });
      expect(firstSetCookie(logout)).toContain('Max-Age=0');
      expect(session.status).toBe(200);
      expect(parseSessionResponse(session.body)).toMatchObject({
        signedIn: false,
        capabilities: {
          mode: 'agentic_cloud',
        },
      });
    });
  });

  it('marks session cookies secure in Render production', async () => {
    await withEnv({ RENDER: 'true' }, async () => {
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const nonce = await createNonce(port, wallet);
        const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

        expect(verify.status).toBe(200);
        expect(firstSetCookie(verify)).toContain('Secure');
      });
    });
  });

  it('uses SESSION_SECRET when hashing session cookies', async () => {
    const store = new MemoryWorkflowStore();
    const clock = fixedClock('2026-05-08T18:00:00.000Z');
    const wallet = createTestWallet();

    await withEnv({ SESSION_SECRET: 'alpha-secret' }, async () => {
      const created = await createWalletSession({ store, walletAddress: wallet.walletAddress, clock });
      const req = requestWithCookie(`agentic_session=${created.token}`);

      expect(await sessionFromRequest({ req, store, clock })).toMatchObject({
        walletAddress: wallet.walletAddress,
      });

      await withEnv({ SESSION_SECRET: 'beta-secret' }, async () => {
        expect(await sessionFromRequest({ req, store, clock })).toBeUndefined();
      });
    });
  });

  it('keeps audit events scoped by wallet address', async () => {
    const store = new MemoryWorkflowStore();
    const walletA = createTestWallet().walletAddress;
    const walletB = createTestWallet().walletAddress;

    await store.forWallet(walletA).insertAuditEvent({
      id: 'audit_1',
      type: 'test.audit',
      createdAt: '2026-05-08T18:00:00.000Z',
    });

    expect(await store.forWallet(walletA).listAuditEvents()).toHaveLength(1);
    expect(await store.forWallet(walletB).listAuditEvents()).toEqual([]);
  });

  it('lists audit events by related source record metadata', async () => {
    const store = new MemoryWorkflowStore();
    const clock = fixedClock('2026-05-08T18:00:00.000Z');
    const wallet = createTestWallet();
    const session = await createWalletSession({ store, walletAddress: wallet.walletAddress, clock });
    await store.forWallet(wallet.walletAddress).insertAuditEvent({
      id: 'audit_evidence_1',
      type: 'evidence.created',
      createdAt: '2026-05-08T18:00:01.000Z',
      metadata: {
        recordType: 'evidence',
        recordId: 'evidence_1',
        sourceRecordType: 'approval',
        sourceRecordId: 'approval_1',
        approvalId: 'approval_1',
      },
    });
    await store.forWallet(wallet.walletAddress).insertAuditEvent({
      id: 'audit_evidence_2',
      type: 'evidence.created',
      createdAt: '2026-05-08T18:00:02.000Z',
      metadata: {
        recordType: 'evidence',
        recordId: 'evidence_2',
        sourceRecordType: 'approval',
        sourceRecordId: 'approval_2',
        approvalId: 'approval_2',
      },
    });

    await withServer(async (port) => {
      const response = await getJson(port, '/api/audit?recordType=approval&recordId=approval_1', {
        cookie: `agentic_session=${session.token}`,
      });

      expect(response.status).toBe(200);
      expect((response.body.events as Array<Record<string, unknown>>).map((event) => event.id)).toEqual(['audit_evidence_1']);
    }, { store, clock });
  });
});

async function withServer(
  callback: (port: number) => Promise<void>,
  options: { authRateLimiter?: AuthRateLimiter | false; clock?: Clock; store?: MemoryWorkflowStore } = {},
): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-render-web-auth-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(staticDir, 'app'));
  await writeFile(join(staticDir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');
  const server = createRenderWebServer({
    staticDir,
    clock: options.clock,
    authRateLimiter: options.authRateLimiter,
    store: options.store,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function createNonce(port: number, wallet: TestWallet): Promise<JsonResponse> {
  const response = await postJson(port, '/api/auth/nonce', {
    walletAddress: wallet.walletAddress,
  });
  expect(response.status).toBe(200);
  return response;
}

function signedVerifyBody(wallet: TestWallet, nonce: Record<string, unknown>): Record<string, unknown> {
  return {
    walletAddress: wallet.walletAddress,
    nonce: nonce.nonce,
    message: nonce.message,
    signature: signMessage(String(nonce.message), wallet.privateKey),
    domain: nonce.domain,
    issuedAt: nonce.issuedAt,
    expiresAt: nonce.expiresAt,
    signatureEncoding: 'base58',
  };
}

function createTestWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBytes = Buffer.from(publicKeyDer).subarray(-32);
  return {
    walletAddress: encodeBase58(publicKeyBytes),
    privateKey,
  };
}

function signMessage(message: string, privateKey: KeyObject): string {
  return encodeBase58(signDetached(null, Buffer.from(message, 'utf8'), privateKey));
}

function sessionCookie(response: JsonResponse): string {
  const cookie = firstSetCookie(response);
  return cookie.split(';')[0] ?? '';
}

function firstSetCookie(response: JsonResponse): string {
  const header = response.headers['set-cookie'];
  if (Array.isArray(header)) return header[0] ?? '';
  return header ?? '';
}

function mutableClock(initial: string): Clock & { set(value: string): void } {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    set: (value: string) => {
      current = new Date(value);
    },
  };
}

function fixedClock(value: string): Clock {
  return {
    now: () => new Date(value),
  };
}

function queuedClock(values: string[]): Clock {
  if (values.length === 0) {
    throw new Error('queuedClock requires at least one timestamp.');
  }
  let index = 0;
  return {
    now: () => {
      const value = values[Math.min(index, values.length - 1)]!;
      index += 1;
      return new Date(value);
    },
  };
}

class ReplayRaceStore extends MemoryWorkflowStore {
  override async consumeAuthNonce(): Promise<undefined> {
    return undefined;
  }
}

function requestWithCookie(cookie: string): IncomingMessage {
  return {
    headers: {
      cookie,
    },
  } as IncomingMessage;
}

const envStack: Array<Map<string, string | undefined>> = [];

async function withEnv<T>(env: Record<string, string>, callback: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  envStack.push(previous);
  try {
    return await callback();
  } finally {
    restoreEnv();
  }
}

function restoreEnv(): void {
  const previous = envStack.pop();
  if (!previous) return;
  for (const [key, value] of previous) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  return requestJson(port, path, 'POST', body, headers);
}

function getJson(port: number, path: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  return requestJson(port, path, 'GET', undefined, headers);
}

function requestJson(
  port: number,
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  headers: Record<string, string>,
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(payload === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
