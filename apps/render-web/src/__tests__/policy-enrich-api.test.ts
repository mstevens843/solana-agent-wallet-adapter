import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

import { describe, expect, it } from 'vitest';

import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { createRenderWebServer } from '../server.js';

interface RawResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

describe('POST /api/policy/enrich', () => {
  it('returns an empty bundle when no instruction text is supplied', async () => {
    await withServer(async (port) => {
      const response = await postJson(port, '/api/policy/enrich', {});
      expect(response.status).toBe(200);
      const cacheControl = String(response.headers['cache-control'] ?? '');
      // no-store because policy resolution is stateful (live prices change).
      expect(cacheControl).toContain('no-store');
      const body = JSON.parse(response.body) as {
        ok: boolean;
        policyBundle: { atoms: unknown[]; evaluations: unknown[]; hasBlockingFailure: boolean };
      };
      expect(body.ok).toBe(true);
      expect(body.policyBundle.atoms.length).toBe(0);
      expect(body.policyBundle.evaluations.length).toBe(0);
      expect(body.policyBundle.hasBlockingFailure).toBe(false);
    });
  });

  it('extracts atoms from natural-language instructions', async () => {
    await withServer(async (port) => {
      // "BTC Fear & Greed must be above 20" is a known regex-extractable atom.
      // We don't assert the resolved value (depends on live alternative.me) —
      // only that the atom was extracted into the bundle.
      const response = await postJson(port, '/api/policy/enrich', {
        instruction: 'BTC Fear & Greed must be above 20',
      });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as {
        ok: boolean;
        policyBundle: {
          atoms: Array<{ id: string; type: string; rawText: string }>;
          evaluations: Array<{ atomId: string; finding: { label: string; value: string; tone: string } }>;
          hasBlockingFailure: boolean;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.policyBundle.atoms.length).toBeGreaterThanOrEqual(1);
      const types = body.policyBundle.atoms.map((a) => a.type);
      expect(types).toContain('market_regime');
      // Every atom should have a matching evaluation entry
      expect(body.policyBundle.evaluations.length).toBe(body.policyBundle.atoms.length);
    });
  });

  it('returns 400 on invalid JSON body', async () => {
    await withServer(async (port) => {
      const response = await postRaw(port, '/api/policy/enrich', '{this is: invalid');
      expect(response.status).toBe(400);
      const body = JSON.parse(response.body) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
    });
  });

  it('rejects non-POST methods', async () => {
    await withServer(async (port) => {
      const response = await getRaw(port, '/api/policy/enrich');
      // requireMethod returns 405 for the wrong method.
      expect(response.status).toBe(405);
    });
  });
});

async function withServer(callback: (port: number) => Promise<void>): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-policy-enrich-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(staticDir, 'app'));
  await writeFile(join(staticDir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');
  const store = new MemoryWorkflowStore();
  const fixedClock = { now: () => new Date('2026-05-21T18:00:00.000Z') };
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

function postJson(port: number, path: string, body: unknown): Promise<RawResponse> {
  return postRaw(port, path, JSON.stringify(body));
}

function postRaw(port: number, path: string, body: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body, 'utf8');
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': buf.length },
      },
      (res) => {
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
      },
    );
    req.on('error', reject);
    req.end(buf);
  });
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
