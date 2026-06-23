import { generateKeyPairSync } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { encodeBase58 } from '../cloud/auth.js';
import { SESSION_COOKIE_NAME } from '../cloud/cookies.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { createWalletSession } from '../cloud/session.js';
import type { Clock } from '../cloud/store.js';
import { createRenderWebServer } from '../server.js';

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

function createWalletAddress(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return encodeBase58(Buffer.from(der).subarray(-32));
}

function fixedClock(value: string): Clock {
  return { now: () => new Date(value) };
}

const CLOCK = fixedClock('2026-06-22T12:00:00.000Z');
const LZ_BLOB_A = 'LZ1:fakecompressedblobAAAA';
const LZ_BLOB_B = 'LZ1:fakecompressedblobBBBB';

function putBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'What is my SOL balance?',
    cluster: 'mainnet-beta',
    messageCount: 2,
    schemaVersion: 1,
    createdAt: '2026-06-22T11:00:00.000Z',
    updatedAt: '2026-06-22T11:30:00.000Z',
    messagesLz: LZ_BLOB_A,
    ...overrides,
  };
}

describe('cloud chat history API', () => {
  it('stores, lists (metadata only), and reads a session for the signed-in wallet', async () => {
    const store = new MemoryWorkflowStore();
    const wallet = createWalletAddress();
    const session = await createWalletSession({ store, walletAddress: wallet, clock: CLOCK });

    await withServer(store, async (port) => {
      const cookie = cookieFor(session.token);

      const put = await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody(), cookie);
      expect(put.status).toBe(200);
      expect(put.body.sessionId).toBe('chat-1');
      expect(put.body.version).toBe(1);
      // The metadata response never echoes the opaque blob.
      expect(put.body.messagesLz).toBeUndefined();

      const list = await request(port, 'GET', '/api/chat/sessions', undefined, cookie);
      expect(list.status).toBe(200);
      const sessions = list.body.sessions as Array<Record<string, unknown>>;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe('chat-1');
      expect(sessions[0]?.messageCount).toBe(2);
      // List is metadata-only: no compressed message blob.
      expect(sessions[0]?.messagesLz).toBeUndefined();

      const detail = await request(port, 'GET', '/api/chat/sessions/chat-1', undefined, cookie);
      expect(detail.status).toBe(200);
      expect(detail.body.messagesLz).toBe(LZ_BLOB_A);
    });
  });

  it('bumps the version on re-upsert and overwrites the blob', async () => {
    const store = new MemoryWorkflowStore();
    const wallet = createWalletAddress();
    const session = await createWalletSession({ store, walletAddress: wallet, clock: CLOCK });

    await withServer(store, async (port) => {
      const cookie = cookieFor(session.token);
      const first = await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody(), cookie);
      expect(first.body.version).toBe(1);

      const second = await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody({ messagesLz: LZ_BLOB_B, messageCount: 4 }), cookie);
      expect(second.body.version).toBe(2);

      const detail = await request(port, 'GET', '/api/chat/sessions/chat-1', undefined, cookie);
      expect(detail.body.messagesLz).toBe(LZ_BLOB_B);
      expect(detail.body.messageCount).toBe(4);
    });
  });

  it('deletes one session and clears all', async () => {
    const store = new MemoryWorkflowStore();
    const wallet = createWalletAddress();
    const session = await createWalletSession({ store, walletAddress: wallet, clock: CLOCK });

    await withServer(store, async (port) => {
      const cookie = cookieFor(session.token);
      await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody(), cookie);
      await request(port, 'PUT', '/api/chat/sessions/chat-2', putBody(), cookie);

      const del = await request(port, 'DELETE', '/api/chat/sessions/chat-1', undefined, cookie);
      expect(del.status).toBe(200);
      expect(del.body.deleted).toBe(true);

      let list = await request(port, 'GET', '/api/chat/sessions', undefined, cookie);
      expect((list.body.sessions as unknown[]).length).toBe(1);

      const clear = await request(port, 'DELETE', '/api/chat/sessions', undefined, cookie);
      expect(clear.status).toBe(200);
      expect(clear.body.cleared).toBe(1);

      list = await request(port, 'GET', '/api/chat/sessions', undefined, cookie);
      expect((list.body.sessions as unknown[]).length).toBe(0);
    });
  });

  it('does not let a stale (older updatedAt) write overwrite a newer one', async () => {
    const store = new MemoryWorkflowStore();
    const wallet = createWalletAddress();
    const session = await createWalletSession({ store, walletAddress: wallet, clock: CLOCK });

    await withServer(store, async (port) => {
      const cookie = cookieFor(session.token);
      // Newer edit (11:30).
      await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody({ updatedAt: '2026-06-22T11:30:00.000Z', messagesLz: LZ_BLOB_A }), cookie);
      // Stale edit (11:00) — must be dropped by last-writer-wins.
      await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody({ updatedAt: '2026-06-22T11:00:00.000Z', messagesLz: LZ_BLOB_B }), cookie);

      const detail = await request(port, 'GET', '/api/chat/sessions/chat-1', undefined, cookie);
      expect(detail.body.messagesLz).toBe(LZ_BLOB_A);
      expect(detail.body.updatedAt).toBe('2026-06-22T11:30:00.000Z');
    });
  });

  it('requires a signed-in session', async () => {
    const store = new MemoryWorkflowStore();
    await withServer(store, async (port) => {
      const unauth = await request(port, 'GET', '/api/chat/sessions', undefined, '');
      expect(unauth.status).toBe(401);
      const put = await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody(), '');
      expect(put.status).toBe(401);
    });
  });

  it('isolates chat history per wallet', async () => {
    const store = new MemoryWorkflowStore();
    const walletA = createWalletAddress();
    const walletB = createWalletAddress();
    const sessionA = await createWalletSession({ store, walletAddress: walletA, clock: CLOCK });
    const sessionB = await createWalletSession({ store, walletAddress: walletB, clock: CLOCK });

    await withServer(store, async (port) => {
      await request(port, 'PUT', '/api/chat/sessions/chat-a', putBody(), cookieFor(sessionA.token));

      const listB = await request(port, 'GET', '/api/chat/sessions', undefined, cookieFor(sessionB.token));
      expect((listB.body.sessions as unknown[]).length).toBe(0);

      const detailB = await request(port, 'GET', '/api/chat/sessions/chat-a', undefined, cookieFor(sessionB.token));
      expect(detailB.status).toBe(404);
    });
  });

  it('rejects a payload without messagesLz', async () => {
    const store = new MemoryWorkflowStore();
    const wallet = createWalletAddress();
    const session = await createWalletSession({ store, walletAddress: wallet, clock: CLOCK });
    await withServer(store, async (port) => {
      const res = await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody({ messagesLz: undefined }), cookieFor(session.token));
      expect(res.status).toBe(400);
    });
  });

  it('409s a version-aware client that edits a stale version; blob unchanged', async () => {
    const store = new MemoryWorkflowStore();
    const wallet = createWalletAddress();
    const session = await createWalletSession({ store, walletAddress: wallet, clock: CLOCK });
    await withServer(store, async (port) => {
      const cookie = cookieFor(session.token);
      const first = await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody({ version: 0 }), cookie);
      expect(first.body.version).toBe(1);
      // Another device based its edit on version 0 while the server is at 1.
      const conflict = await request(port, 'PUT', '/api/chat/sessions/chat-1',
        putBody({ version: 0, messagesLz: LZ_BLOB_B, updatedAt: '2026-06-22T11:45:00.000Z' }), cookie);
      expect(conflict.status).toBe(409);
      expect((conflict.body.session as Record<string, unknown>).version).toBe(1);
      const detail = await request(port, 'GET', '/api/chat/sessions/chat-1', undefined, cookie);
      expect(detail.body.messagesLz).toBe(LZ_BLOB_A);
    });
  });

  it('accepts a version-aware client that is up to date', async () => {
    const store = new MemoryWorkflowStore();
    const wallet = createWalletAddress();
    const session = await createWalletSession({ store, walletAddress: wallet, clock: CLOCK });
    await withServer(store, async (port) => {
      const cookie = cookieFor(session.token);
      await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody({ version: 0 }), cookie);
      const ok = await request(port, 'PUT', '/api/chat/sessions/chat-1',
        putBody({ version: 1, messagesLz: LZ_BLOB_B, messageCount: 4, updatedAt: '2026-06-22T11:45:00.000Z' }), cookie);
      expect(ok.status).toBe(200);
      expect(ok.body.version).toBe(2);
    });
  });

  it('409s a version-aware client whose timestamp lost the LWW guard (clock skew)', async () => {
    const store = new MemoryWorkflowStore();
    const wallet = createWalletAddress();
    const session = await createWalletSession({ store, walletAddress: wallet, clock: CLOCK });
    await withServer(store, async (port) => {
      const cookie = cookieFor(session.token);
      // Current version 1 at 11:30.
      await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody({ version: 0, updatedAt: '2026-06-22T11:30:00.000Z' }), cookie);
      // Up to date on version, but an older timestamp → store skips the write.
      const skewed = await request(port, 'PUT', '/api/chat/sessions/chat-1',
        putBody({ version: 1, messagesLz: LZ_BLOB_B, updatedAt: '2026-06-22T11:00:00.000Z' }), cookie);
      expect(skewed.status).toBe(409);
      const detail = await request(port, 'GET', '/api/chat/sessions/chat-1', undefined, cookie);
      expect(detail.body.messagesLz).toBe(LZ_BLOB_A);
    });
  });

  it('classifies a store connection failure as a generic 503 (no driver text leaked)', async () => {
    const store = new ConnRefusedStore();
    const wallet = createWalletAddress();
    const session = await createWalletSession({ store, walletAddress: wallet, clock: CLOCK });
    await withServer(store, async (port) => {
      const res = await request(port, 'PUT', '/api/chat/sessions/chat-1', putBody(), cookieFor(session.token));
      expect(res.status).toBe(503);
      expect(String(res.body.error)).not.toMatch(/ECONNREFUSED/);
    });
  });

  it('caps sessions per wallet, evicting the oldest beyond the limit', async () => {
    const store = new MemoryWorkflowStore();
    const wallet = createWalletAddress();
    const session = await createWalletSession({ store, walletAddress: wallet, clock: CLOCK });
    await withServer(store, async (port) => {
      const cookie = cookieFor(session.token);
      for (let i = 0; i < 102; i += 1) {
        await request(port, 'PUT', `/api/chat/sessions/chat-${i}`, putBody(), cookie);
      }
      const list = await request(port, 'GET', '/api/chat/sessions', undefined, cookie);
      expect((list.body.sessions as unknown[]).length).toBe(100);
    });
  });
});

// A store whose chat save fails with a PG-connection-class error, to assert the
// router maps it to a sanitized 503 rather than a raw 500.
class ConnRefusedStore extends MemoryWorkflowStore {
  override async saveChatSession(): Promise<never> {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432') as Error & { code: string };
    err.code = 'ECONNREFUSED';
    throw err;
  }
}

function cookieFor(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

async function withServer(store: MemoryWorkflowStore, callback: (port: number) => Promise<void>): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-chat-api-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(staticDir, 'app'));
  await writeFile(join(staticDir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');
  const server = createRenderWebServer({ store, staticDir, clock: CLOCK });
  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback(address.port);
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

function request(port: number, method: string, path: string, body: unknown, cookie: string): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (cookie) headers.cookie = cookie;
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
