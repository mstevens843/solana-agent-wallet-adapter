import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRenderWebServer } from '../server.js';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

describe('mobile wallet debug telemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts bounded iOS wallet debug breadcrumbs and writes a Render log line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await withServer(async (port) => {
      const response = await postJson(port, '/api/mobile-wallet-debug', {
        wallet: 'backpack',
        method: 'connect',
        step: 'webview_location',
        requestId: 'req_123',
        strategy: 'webview-location',
        walletUrl: 'scheme=https host=backpack.app path=/ul/v1/connect query_keys=app_url,cluster,dapp_encryption_public_key,redirect_link',
        callback: 'scheme=agenticwallet host=callback path=/connect query_keys=',
      }, iosHeaders());

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
      expect(response.headers['access-control-allow-origin']).toBe('capacitor://localhost');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('mobile_wallet_debug status=200'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('wallet="backpack"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('strategy="webview-location"'));
    });
  });

  it('accepts redacted Jupiter WalletConnect debug breadcrumbs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await withServer(async (port) => {
      const response = await postJson(port, '/api/mobile-wallet-debug', {
        wallet: 'jupiter',
        method: 'sign',
        step: 'wc_sign_result',
        requestId: 'sar_123',
        strategy: 'walletconnect',
        topic: 'abc123...def4',
        pubkey: 'JUP111...222',
        kind: 'sign_message',
        resultKeys: 'signature',
        relayHost: 'relay.walletconnect.com',
        originHost: 'agentic-signer.com',
        projectIdPrefix: '7c5434a4',
        socketStatus: 'disconnected',
        code: 'signature',
      }, iosHeaders());

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('wallet="jupiter"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('kind="sign_message"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('resultKeys="signature"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('relayHost="relay.walletconnect.com"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('projectIdPrefix="7c5434a4"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('socketStatus="disconnected"'));
    });
  });

  it('rejects malformed or oversized wallet debug payloads', async () => {
    await withServer(async (port) => {
      const malformed = await postJson(port, '/api/mobile-wallet-debug', {
        method: 'connect',
        step: 'webview_location',
      }, iosHeaders());
      const oversized = await postJson(port, '/api/mobile-wallet-debug', {
        wallet: 'backpack',
        step: 'webview_location',
        message: 'x'.repeat(241),
      }, iosHeaders());

      expect(malformed.status).toBe(400);
      expect(oversized.status).toBe(400);
    });
  });
});

async function withServer(callback: (port: number) => Promise<void>): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-render-web-wallet-debug-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(staticDir, 'app'));
  await writeFile(join(staticDir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');
  const server = createRenderWebServer({ staticDir });
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

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
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

function iosHeaders(): Record<string, string> {
  return {
    origin: 'capacitor://localhost',
    'x-agentic-client': 'ios-bundled',
  };
}
