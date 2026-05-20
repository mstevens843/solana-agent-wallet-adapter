import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

import { describe, expect, it } from 'vitest';

import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { ACCEPTED_ENVELOPE_PREFIXES } from '../cloud/auth.js';
import { ANDROID_REMOTE_CONFIG } from '../cloud/androidConfig.js';
import { createRenderWebServer } from '../server.js';

interface RawResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

describe('GET /api/android-config', () => {
  it('serves the canonical Android remote config as JSON with a public cache header', async () => {
    await withServer(async (port) => {
      const response = await getRaw(port, '/api/android-config');
      expect(response.status).toBe(200);
      expect(String(response.headers['content-type'])).toContain('application/json');
      const cacheControl = String(response.headers['cache-control'] ?? '');
      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('max-age=300');
      expect(cacheControl).toContain('stale-while-revalidate=3600');

      const parsed = JSON.parse(response.body) as typeof ANDROID_REMOTE_CONFIG;
      expect(parsed.version).toBe(ANDROID_REMOTE_CONFIG.version);
      expect(parsed.walletRegistry.length).toBe(ANDROID_REMOTE_CONFIG.walletRegistry.length);
      expect(parsed.memoProofRouter.proofMemoPrefix).toBe(
        ANDROID_REMOTE_CONFIG.memoProofRouter.proofMemoPrefix,
      );
    });
  });

  it('publishes a memo-proof prefix that the verifier accepts', async () => {
    // CRITICAL invariant: every prefix the APK might send via this config must be
    // in the verifier's accepted list. Otherwise we'd push a config that breaks
    // proof signing for every APK that picks it up.
    await withServer(async (port) => {
      const response = await getRaw(port, '/api/android-config');
      const parsed = JSON.parse(response.body) as typeof ANDROID_REMOTE_CONFIG;
      expect(ACCEPTED_ENVELOPE_PREFIXES).toContain(parsed.memoProofRouter.proofMemoPrefix);
    });
  });

  it('rejects non-GET methods with 405', async () => {
    await withServer(async (port) => {
      const response = await postEmpty(port, '/api/android-config');
      expect(response.status).toBe(405);
    });
  });

  it('lists the route in /api/ai/status build metadata', async () => {
    await withServer(async (port) => {
      const response = await getRaw(port, '/api/ai/status');
      expect(response.status).toBe(200);
      const parsed = JSON.parse(response.body) as { build: { routes: string[] } };
      expect(parsed.build.routes).toContain('GET /api/android-config');
    });
  });

  it('returns wallet entries with the schema the APK expects', async () => {
    await withServer(async (port) => {
      const response = await getRaw(port, '/api/android-config');
      const parsed = JSON.parse(response.body) as typeof ANDROID_REMOTE_CONFIG;
      for (const entry of parsed.walletRegistry) {
        expect(typeof entry.id).toBe('number');
        expect(typeof entry.name).toBe('string');
        expect(Array.isArray(entry.packageNames)).toBe(true);
        expect(typeof entry.supportsSignMessages).toBe('boolean');
        expect(typeof entry.supportsSiws).toBe('boolean');
        expect(typeof entry.forceSignThenRpc).toBe('boolean');
      }
      // Sanity: Phantom is present and matches the bundled default routing for
      // 'memo-tx fallback' (supportsSignMessages = false).
      const phantom = parsed.walletRegistry.find((e) => e.name === 'phantom');
      expect(phantom).toBeDefined();
      expect(phantom?.supportsSignMessages).toBe(false);
    });
  });
});

async function withServer(callback: (port: number) => Promise<void>): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-android-config-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(staticDir, 'app'));
  await writeFile(join(staticDir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');
  const store = new MemoryWorkflowStore();
  const fixedClock = { now: () => new Date('2026-05-08T18:00:00.000Z') };
  const server = createRenderWebServer({ staticDir, store, clock: fixedClock });
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

function getRaw(port: number, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function postEmpty(port: number, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': 2 },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end('{}');
  });
}
