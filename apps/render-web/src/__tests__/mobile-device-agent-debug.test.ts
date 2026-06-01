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

describe('mobile Device Agent debug telemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts bounded iOS Device Agent breadcrumbs and writes a Render log line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await withServer(async (port) => {
      const response = await postJson(port, '/api/mobile-device-agent-debug', {
        method: 'reviewPlan',
        step: 'start',
        requestId: 'device-agent-abc-1',
        runtime: 'ios-native',
        provider: 'anthropic',
        model: 'claude-opus-4-1',
        phase: 'native',
        source: 'ios-device-agent',
        appBuild: '1.2.3(45)',
        eventIndex: 7,
        payloadChars: 1234,
        httpHost: 'api.anthropic.com',
        responseBytes: 456,
        guardrailVerdict: 'block',
        guardrailCodes: 'ai_bypasses_wallet',
        repairApplied: true,
      }, iosHeaders());

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
      expect(response.headers['access-control-allow-origin']).toBe('capacitor://localhost');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('mobile_device_agent_debug status=200'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('method="reviewPlan"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('requestId="device-agent-abc-1"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('eventIndex="7"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('httpHost="api.anthropic.com"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('guardrailCodes="ai_bypasses_wallet"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('repairApplied="true"'));
    });
  });

  it('rejects malformed or oversized Device Agent debug payloads', async () => {
    await withServer(async (port) => {
      const malformed = await postJson(port, '/api/mobile-device-agent-debug', {
        step: 'start',
      }, iosHeaders());
      const oversized = await postJson(port, '/api/mobile-device-agent-debug', {
        method: 'reviewPlan',
        step: 'fail',
        message: 'x'.repeat(241),
      }, iosHeaders());

      expect(malformed.status).toBe(400);
      expect(oversized.status).toBe(400);
    });
  });

  it('redacts sensitive scalar fields before logging', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await withServer(async (port) => {
      const response = await postJson(port, '/api/mobile-device-agent-debug', {
        method: 'reviewPlan',
        step: 'fail',
        requestId: 'device-agent-redact',
        message: 'provider returned token=sk-secret and Bearer sk-live-secret-1234567890 with jwt eyJabc1234567890.eyJdef1234567890.eyJghi1234567890',
        errorDomain: 'apiKey=sk-proj-secret-1234567890',
      }, iosHeaders());

      expect(response.status).toBe(200);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('message="provider returned token=[redacted]'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Bearer [redacted]'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[redacted-jwt]'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('errorDomain="apiKey=[redacted]"'));
    });
  });
});

async function withServer(callback: (port: number) => Promise<void>): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-render-web-device-agent-debug-'));
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
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function iosHeaders(): Record<string, string> {
  return {
    origin: 'capacitor://localhost',
    'x-agentic-client': 'ios-bundled',
  };
}
