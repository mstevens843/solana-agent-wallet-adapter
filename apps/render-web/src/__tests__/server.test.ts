import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRenderWebServer } from '../server.js';

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
}

const aiRequest = {
  prompt: 'review a SOL transfer',
  userNotes: 'test only',
  template: {
    id: 'custom-request',
    category: 'custom',
    title: 'Custom request',
    description: 'Turn request into a plan.',
    actionType: 'custom',
    risk: 'medium',
  },
  parameters: {
    amount: '0.01',
  },
};

describe('render web hosted BYOK API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes OpenAI hosted BYOK requests through the server-side chat completions API', async () => {
    const providerCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      providerCalls.push({ url: String(url), init });
      return jsonResponse({
        choices: [{
          message: {
            content: planJson('OpenAI intent'),
          },
        }],
      });
    }));

    await withServer(async (port) => {
      const response = await postJson(port, '/api/ai/generate-plan', {
        settings: {
          provider: 'openai',
          baseUrl: 'https://evil.example/v1',
          model: 'gpt-5',
          apiKey: 'sk-test-openai',
        },
        request: aiRequest,
      });

      expect(response.status).toBe(200);
      expect(response.body.intent).toBe('OpenAI intent');
      expect(providerCalls).toHaveLength(1);
      expect(providerCalls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
      expect((providerCalls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test-openai');
    });
  });

  it('routes Claude hosted BYOK requests through the Anthropic Messages API', async () => {
    const providerCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      providerCalls.push({ url: String(url), init });
      return jsonResponse({
        content: [{ text: planJson('Claude intent') }],
      });
    }));

    await withServer(async (port) => {
      const response = await postJson(port, '/api/ai/generate-plan', {
        settings: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          apiKey: 'sk-ant-api03-test',
        },
        request: aiRequest,
      });

      expect(response.status).toBe(200);
      expect(response.body.intent).toBe('Claude intent');
      expect(providerCalls).toHaveLength(1);
      expect(providerCalls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
      expect((providerCalls[0]?.init?.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-api03-test');
    });
  });

  it('rejects missing API keys and unsupported custom providers without calling a provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await withServer(async (port) => {
      const missingKey = await postJson(port, '/api/ai/generate-plan', {
        settings: { provider: 'openai', model: 'gpt-5' },
        request: aiRequest,
      });
      const customProvider = await postJson(port, '/api/ai/generate-plan', {
        settings: {
          provider: 'custom-openai-compatible',
          baseUrl: 'https://gateway.example/v1',
          model: 'custom-model',
          apiKey: 'sk-test-custom',
        },
        request: aiRequest,
      });

      expect(missingKey.status).toBe(400);
      expect(customProvider.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('redacts provider errors before returning them to the browser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: {
        message: 'Bad key sk-test-secret-value',
      },
    }, 401)));

    await withServer(async (port) => {
      const response = await postJson(port, '/api/ai/generate-plan', {
        settings: {
          provider: 'openai',
          model: 'gpt-5',
          apiKey: 'sk-test-secret-value',
        },
        request: aiRequest,
      });

      expect(response.status).toBe(502);
      expect(JSON.stringify(response.body)).not.toContain('sk-test-secret-value');
      expect(String(response.body.error)).toContain('[redacted]');
    });
  });
});

async function withServer(callback: (port: number) => Promise<void>): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-render-web-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
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

function postJson(port: number, path: string, body: unknown): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
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
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function planJson(intent: string): string {
  return JSON.stringify({
    intent,
    route: 'Review the route before signing.',
    risk: 'Medium risk.',
    approval: 'Wallet approval is separate.',
    safeguards: ['Check recipient.'],
  });
}
