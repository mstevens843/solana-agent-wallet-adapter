import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../cloud/cookies.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { createWalletSession } from '../cloud/session.js';
import { createRenderWebServer } from '../server.js';

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
}

interface TextResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

interface ServerCtx {
  cookie: string;
  store: MemoryWorkflowStore;
  walletAddress: string;
}

const DEVICE_AGENT_WALLET_A = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const DEVICE_AGENT_WALLET_B = '7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w';
const DEVICE_AGENT_OTHER_WALLET = '11111111111111111111111111111111';

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
    vi.unstubAllEnvs();
  });

  it('serves hosted BYOK status as JSON instead of the SPA shell', async () => {
    await withServer(async (port) => {
      const response = await getText(port, '/api/ai/status');

      expect(response.status).toBe(200);
      expect(String(response.headers['content-type'])).toContain('application/json');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(response.body)).toMatchObject({
        available: true,
        mode: 'hosted-byok',
        build: {
          routes: expect.arrayContaining([
            'POST /api/ai/review-plan',
            'POST /api/solana/latest-blockhash',
            'POST /api/solana/send-transaction',
            'POST /api/solana/signature-status',
            'POST /api/swap/order',
            'POST /api/swap/execute',
          ]),
        },
        providers: expect.arrayContaining([
          expect.objectContaining({ id: 'openai', apiFormat: 'openai-compatible' }),
          expect.objectContaining({ id: 'anthropic', apiFormat: 'anthropic' }),
        ]),
      });
    });
  });

  it('rejects Device Agent status when the env gate is off', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '0');
    await withServer(async (port, ctx) => {
      const response = await getJson(port, '/api/device-agent/status', { cookie: ctx.cookie });
      expect(response.status).toBe(403);
      expect(String(response.body.error)).toContain('Device Agent is not enabled');
    }, { walletAddress: DEVICE_AGENT_WALLET_A });
  });

  it('rejects Device Agent status for non-allowlisted wallets', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    await withServer(async (port, ctx) => {
      const response = await getJson(port, '/api/device-agent/status', { cookie: ctx.cookie });
      expect(response.status).toBe(403);
      expect(String(response.body.error)).toContain('not enabled for this wallet');
    }, { walletAddress: DEVICE_AGENT_OTHER_WALLET });
  });

  it.each([DEVICE_AGENT_WALLET_A, DEVICE_AGENT_WALLET_B])('serves Device Agent status for allowlisted wallet %s', async (walletAddress) => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    await withServer(async (port, ctx) => {
      const response = await getJson(port, '/api/device-agent/status', { cookie: ctx.cookie });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        available: true,
        enabled: true,
        configured: false,
        state: 'stopped',
        runtime: 'render-gated',
        runtimes: { android: true, browserNative: false },
        walletAddress,
      });
    }, { walletAddress });
  });

  it('reports browser-native availability when AGENTIC_BROWSER_DEVICE_AGENT is set', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    vi.stubEnv('AGENTIC_BROWSER_DEVICE_AGENT', '1');
    await withServer(async (port, ctx) => {
      const response = await getJson(port, '/api/device-agent/status', { cookie: ctx.cookie });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        runtime: 'render-gated',
        runtimes: { android: true, browserNative: true },
      });
    }, { walletAddress: DEVICE_AGENT_WALLET_A });
  });

  it('stages Device Agent config without starting a cloud daemon', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    await withServer(async (port, ctx) => {
      const configured = await postJson(port, '/api/device-agent/control', {
        action: 'configure',
        settings: { provider: 'openai', apiFormat: 'openai-compatible', model: 'gpt-5.5' },
      }, { cookie: ctx.cookie });
      expect(configured.status).toBe(200);
      expect(configured.body).toMatchObject({
        configured: true,
        state: 'stopped',
        runtime: 'render-gated',
        runtimes: { android: true, browserNative: false },
        provider: 'openai',
        model: 'gpt-5.5',
      });

      const started = await postJson(port, '/api/device-agent/control', {
        action: 'start',
        settings: { provider: 'openai', apiFormat: 'openai-compatible', model: 'gpt-5.5' },
      }, { cookie: ctx.cookie });
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({
        configured: true,
        state: 'running',
        runtimes: { android: true, browserNative: false },
        message: 'Device Agent runtime is gated on Render; no cloud daemon is started.',
      });
    }, { walletAddress: DEVICE_AGENT_WALLET_A });
  });

  it('records a structured audit event for Device Agent status reads', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    await withServer(async (port, ctx) => {
      // Reset module-scoped session state for this wallet to start from a known baseline.
      await postJson(port, '/api/device-agent/control', { action: 'clear' }, { cookie: ctx.cookie });
      const before = (await ctx.store.forWallet(ctx.walletAddress).listAuditEvents()).length;

      const response = await getJson(port, '/api/device-agent/status', { cookie: ctx.cookie });
      expect(response.status).toBe(200);

      const after = await ctx.store.forWallet(ctx.walletAddress).listAuditEvents();
      const newEvents = after.slice(before);
      expect(newEvents).toHaveLength(1);
      expect(newEvents[0]).toMatchObject({
        type: 'device-agent.status.read',
        metadata: { runtime: 'render-gated', state: 'stopped' },
      });
      const metadataKeys = Object.keys(newEvents[0]?.metadata ?? {});
      expect(metadataKeys).not.toContain('apiKey');
      expect(metadataKeys).not.toContain('provider');
      expect(metadataKeys).not.toContain('model');
      expect(metadataKeys).not.toContain('baseUrl');
      expect(metadataKeys).not.toContain('apiFormat');
      expect(metadataKeys).not.toContain('runtimes');
    }, { walletAddress: DEVICE_AGENT_WALLET_A });
  });

  it('records one audit event per Device Agent control action', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    await withServer(async (port, ctx) => {
      // Reset module-scoped session state for this wallet to start from a known baseline.
      await postJson(port, '/api/device-agent/control', { action: 'clear' }, { cookie: ctx.cookie });
      const before = (await ctx.store.forWallet(ctx.walletAddress).listAuditEvents()).length;

      const sequence: Array<'configure' | 'start' | 'stop' | 'clear'> = ['configure', 'start', 'stop', 'clear'];
      for (const action of sequence) {
        const response = await postJson(port, '/api/device-agent/control', {
          action,
          settings: action === 'configure' || action === 'start'
            ? { provider: 'openai', apiFormat: 'openai-compatible', model: 'gpt-5.5' }
            : undefined,
        }, { cookie: ctx.cookie });
        expect(response.status).toBe(200);
      }

      const after = await ctx.store.forWallet(ctx.walletAddress).listAuditEvents();
      const newEvents = after.slice(before);
      expect(newEvents.map((event) => event.type)).toEqual([
        'device-agent.control.configure',
        'device-agent.control.start',
        'device-agent.control.stop',
        'device-agent.control.clear',
      ]);
      expect(newEvents[0]?.metadata).toMatchObject({ runtime: 'render-gated', action: 'configure', state: 'stopped' });
      expect(newEvents[1]?.metadata).toMatchObject({ runtime: 'render-gated', action: 'start', state: 'running' });
      expect(newEvents[2]?.metadata).toMatchObject({ runtime: 'render-gated', action: 'stop', state: 'stopped' });
      expect(newEvents[3]?.metadata).toMatchObject({ runtime: 'render-gated', action: 'clear', state: 'stopped' });
    }, { walletAddress: DEVICE_AGENT_WALLET_A });
  });

  it('never persists provider key material or unrecognized secret-shaped fields in Device Agent state or audit metadata', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    const secretFields = {
      apiKey: 'sk-redacted-test-key',
      secret: 'shhh-do-not-leak',
      accessToken: 'access-token-leak-canary',
      authorization: 'Bearer leak-canary',
      privateKey: 'priv-leak-canary',
    } as const;
    const secretFieldNames = Object.keys(secretFields);
    const secretValues = Object.values(secretFields);
    await withServer(async (port, ctx) => {
      const configured = await postJson(port, '/api/device-agent/control', {
        action: 'configure',
        settings: {
          provider: 'openai',
          apiFormat: 'openai-compatible',
          model: 'gpt-5.5',
          ...secretFields,
        },
      }, { cookie: ctx.cookie });
      expect(configured.status).toBe(200);
      const configuredSerialized = JSON.stringify(configured.body);
      for (const name of secretFieldNames) expect(configuredSerialized).not.toContain(name);
      for (const value of secretValues) expect(configuredSerialized).not.toContain(value);

      const status = await getJson(port, '/api/device-agent/status', { cookie: ctx.cookie });
      expect(status.status).toBe(200);
      const statusSerialized = JSON.stringify(status.body);
      for (const name of secretFieldNames) expect(statusSerialized).not.toContain(name);
      for (const value of secretValues) expect(statusSerialized).not.toContain(value);

      const events = await ctx.store.forWallet(ctx.walletAddress).listAuditEvents();
      const serializedEvents = JSON.stringify(events);
      for (const name of secretFieldNames) expect(serializedEvents).not.toContain(name);
      for (const value of secretValues) expect(serializedEvents).not.toContain(value);
    }, { walletAddress: DEVICE_AGENT_WALLET_A });
  });

  it('logs a structured access-denied warning when the Device Agent env gate is off', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '0');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withServer(async (port, ctx) => {
        const response = await getJson(port, '/api/device-agent/status', { cookie: ctx.cookie });
        expect(response.status).toBe(403);
      }, { walletAddress: DEVICE_AGENT_WALLET_A });
      const denialCalls = warn.mock.calls.filter((args) => args[0] === '[device-agent] access denied');
      expect(denialCalls).toHaveLength(1);
      expect(denialCalls[0]?.[1]).toEqual({ reason: 'feature_disabled' });
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a structured access-denied warning with a wallet short ID when the wallet is not allowlisted', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withServer(async (port, ctx) => {
        const response = await getJson(port, '/api/device-agent/status', { cookie: ctx.cookie });
        expect(response.status).toBe(403);
      }, { walletAddress: DEVICE_AGENT_OTHER_WALLET });
      const denialCalls = warn.mock.calls.filter((args) => args[0] === '[device-agent] access denied');
      expect(denialCalls).toHaveLength(1);
      expect(denialCalls[0]?.[1]).toEqual({
        reason: 'wallet_not_allowlisted',
        walletShort: '1111…1111',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a structured access-denied warning when there is no signed-in session', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withServer(async (port) => {
        const response = await getJson(port, '/api/device-agent/status');
        expect(response.status).toBe(401);
      }, { walletAddress: DEVICE_AGENT_WALLET_A });
      const denialCalls = warn.mock.calls.filter((args) => args[0] === '[device-agent] access denied');
      expect(denialCalls).toHaveLength(1);
      expect(denialCalls[0]?.[1]).toEqual({ reason: 'no_session' });
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects POST /api/device-agent/status with 405 method_not_allowed', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    await withServer(async (port, ctx) => {
      const response = await postJson(port, '/api/device-agent/status', {}, { cookie: ctx.cookie });
      expect(response.status).toBe(405);
      expect(String(response.body.error)).toContain('method_not_allowed');
    }, { walletAddress: DEVICE_AGENT_WALLET_A });
  });

  it('rejects GET /api/device-agent/control with 405 method_not_allowed', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    await withServer(async (port, ctx) => {
      const response = await getJson(port, '/api/device-agent/control', { cookie: ctx.cookie });
      expect(response.status).toBe(405);
      expect(String(response.body.error)).toContain('method_not_allowed');
    }, { walletAddress: DEVICE_AGENT_WALLET_A });
  });

  it('returns 400 with a structured warning for an unsupported Device Agent control action', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withServer(async (port, ctx) => {
        const before = (await ctx.store.forWallet(ctx.walletAddress).listAuditEvents()).length;
        const response = await postJson(port, '/api/device-agent/control', { action: 'reboot' }, { cookie: ctx.cookie });
        expect(response.status).toBe(400);
        expect(String(response.body.error)).toContain('Unsupported Device Agent control action');
        const after = await ctx.store.forWallet(ctx.walletAddress).listAuditEvents();
        expect(after.length - before).toBe(0);
      }, { walletAddress: DEVICE_AGENT_WALLET_A });
      const invalidCalls = warn.mock.calls.filter((args) => args[0] === '[device-agent] invalid request');
      expect(invalidCalls).toHaveLength(1);
      expect(invalidCalls[0]?.[1]).toEqual({
        reason: 'unsupported_action',
        action: 'reboot',
        walletShort: '4fTq…MoHd',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('returns 400 with a structured warning when the Device Agent control body omits an action', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withServer(async (port, ctx) => {
        const response = await postJson(port, '/api/device-agent/control', {}, { cookie: ctx.cookie });
        expect(response.status).toBe(400);
        expect(String(response.body.error)).toContain('Unsupported Device Agent control action');
      }, { walletAddress: DEVICE_AGENT_WALLET_A });
      const invalidCalls = warn.mock.calls.filter((args) => args[0] === '[device-agent] invalid request');
      expect(invalidCalls).toHaveLength(1);
      expect(invalidCalls[0]?.[1]).toEqual({
        reason: 'unsupported_action',
        action: '',
        walletShort: '4fTq…MoHd',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects POST /api/device-agent/control without a session and logs a structured no_session warning', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withServer(async (port) => {
        const response = await postJson(port, '/api/device-agent/control', { action: 'configure' });
        expect(response.status).toBe(401);
      }, { walletAddress: DEVICE_AGENT_WALLET_A });
      const denialCalls = warn.mock.calls.filter((args) => args[0] === '[device-agent] access denied');
      expect(denialCalls).toHaveLength(1);
      expect(denialCalls[0]?.[1]).toEqual({ reason: 'no_session' });
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves running state when configure is called while the Device Agent is running', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    await withServer(async (port, ctx) => {
      await postJson(port, '/api/device-agent/control', { action: 'clear' }, { cookie: ctx.cookie });
      const before = (await ctx.store.forWallet(ctx.walletAddress).listAuditEvents()).length;

      const started = await postJson(port, '/api/device-agent/control', {
        action: 'start',
        settings: { provider: 'openai', apiFormat: 'openai-compatible', model: 'gpt-5.5' },
      }, { cookie: ctx.cookie });
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({ state: 'running' });

      const reconfigured = await postJson(port, '/api/device-agent/control', {
        action: 'configure',
        settings: { provider: 'anthropic', apiFormat: 'anthropic', model: 'claude-opus-4-7' },
      }, { cookie: ctx.cookie });
      expect(reconfigured.status).toBe(200);
      expect(reconfigured.body).toMatchObject({
        state: 'running',
        configured: true,
        provider: 'anthropic',
        model: 'claude-opus-4-7',
      });

      const status = await getJson(port, '/api/device-agent/status', { cookie: ctx.cookie });
      expect(status.body).toMatchObject({ state: 'running', provider: 'anthropic' });

      const after = await ctx.store.forWallet(ctx.walletAddress).listAuditEvents();
      const newEvents = after.slice(before);
      const controlEvents = newEvents.filter((event) => event.type.startsWith('device-agent.control.'));
      expect(controlEvents.map((event) => event.type)).toEqual([
        'device-agent.control.start',
        'device-agent.control.configure',
      ]);
      expect(controlEvents[0]?.metadata).toMatchObject({ action: 'start', state: 'running' });
      expect(controlEvents[1]?.metadata).toMatchObject({ action: 'configure', state: 'running' });
    }, { walletAddress: DEVICE_AGENT_WALLET_A });
  });

  it('drops optional provider fields from the status response after a clear action', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    await withServer(async (port, ctx) => {
      const configured = await postJson(port, '/api/device-agent/control', {
        action: 'configure',
        settings: {
          provider: 'openai',
          apiFormat: 'openai-compatible',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.5',
        },
      }, { cookie: ctx.cookie });
      expect(configured.body).toMatchObject({
        configured: true,
        provider: 'openai',
        apiFormat: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.5',
      });

      const cleared = await postJson(port, '/api/device-agent/control', { action: 'clear' }, { cookie: ctx.cookie });
      expect(cleared.status).toBe(200);

      const status = await getJson(port, '/api/device-agent/status', { cookie: ctx.cookie });
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        configured: false,
        state: 'stopped',
        runtime: 'render-gated',
      });
      expect(status.body).not.toHaveProperty('provider');
      expect(status.body).not.toHaveProperty('apiFormat');
      expect(status.body).not.toHaveProperty('baseUrl');
      expect(status.body).not.toHaveProperty('model');
    }, { walletAddress: DEVICE_AGENT_WALLET_A });
  });

  it('still returns a successful status response when the audit store fails, and logs an audit-failure warning', async () => {
    vi.stubEnv('AGENTIC_DEVICE_AGENT', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withServer(async (port, ctx) => {
        const originalForWallet = MemoryWorkflowStore.prototype.forWallet;
        const spy = vi.spyOn(MemoryWorkflowStore.prototype, 'forWallet').mockImplementation(function (
          this: MemoryWorkflowStore,
          walletAddress: string,
        ) {
          const scoped = originalForWallet.call(this, walletAddress);
          return new Proxy(scoped, {
            get(target, prop, recv) {
              if (prop === 'insertAuditEvent') {
                return async () => {
                  throw new Error('audit_store_unavailable_test');
                };
              }
              return Reflect.get(target, prop, recv);
            },
          });
        });
        try {
          const response = await getJson(port, '/api/device-agent/status', { cookie: ctx.cookie });
          expect(response.status).toBe(200);
          expect(response.body).toMatchObject({
            available: true,
            enabled: true,
            runtime: 'render-gated',
            walletAddress: ctx.walletAddress,
          });
        } finally {
          spy.mockRestore();
        }
      }, { walletAddress: DEVICE_AGENT_WALLET_A });
      const failureCalls = warn.mock.calls.filter((args) => args[0] === '[device-agent] audit failure');
      expect(failureCalls).toHaveLength(1);
      expect(failureCalls[0]?.[1]).toMatchObject({
        type: 'device-agent.status.read',
        walletShort: '4fTq…MoHd',
        error: 'audit_store_unavailable_test',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('proxies BirdEye market data through the hosted API', async () => {
    const upstreamCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubEnv('BIRDEYE_API_KEY', 'birdeye-test-key');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      upstreamCalls.push({ url: String(url), init });
      return jsonResponse({
        data: {
          So11111111111111111111111111111111111111112: {
            value: 142.25,
          },
        },
      });
    }));

    await withServer(async (port) => {
      const response = await postJson(port, '/api/birdeye/price-multi', {
        addresses: ['So11111111111111111111111111111111111111112'],
        includeLiquidity: false,
      });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('So11111111111111111111111111111111111111112');
      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]?.url).toContain('/defi/multi_price');
      expect(upstreamCalls[0]?.url).toContain('include_liquidity=false');
      expect(new Headers(upstreamCalls[0]?.init?.headers).get('x-api-key')).toBe('birdeye-test-key');
      expect(JSON.parse(String(upstreamCalls[0]?.init?.body))).toEqual({
        list_address: 'So11111111111111111111111111111111111111112',
      });
    });
  });

  it('reports BirdEye setup errors without calling upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await withServer(async (port) => {
      const response = await postJson(port, '/api/birdeye/search', {
        keyword: 'popcat',
      });

      expect(response.status).toBe(501);
      expect(String(response.body.error)).toContain('Missing BirdEye API key');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('requires a wallet session before relaying Hosted BYOK drafting', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await withServer(async (port) => {
      const response = await postJson(port, '/api/ai/generate-plan', {
        settings: {
          provider: 'openai',
          model: 'gpt-5',
          apiKey: 'sk-test-openai',
        },
        request: aiRequest,
      });

      expect(response.status).toBe(401);
      expect(String(response.body.error)).toContain('Sign in required');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('routes OpenAI hosted BYOK requests through the server-side Responses API', async () => {
    const providerCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      providerCalls.push({ url: String(url), init });
      return jsonResponse({ output_text: planJson('OpenAI intent') });
    }));

    await withServer(async (port, ctx) => {
      const response = await postJson(port, '/api/ai/generate-plan', {
        settings: {
          provider: 'openai',
          baseUrl: 'https://evil.example/v1',
          model: 'gpt-5',
          apiKey: 'sk-test-openai',
        },
        request: aiRequest,
      }, { cookie: ctx.cookie });

      expect(response.status).toBe(200);
      expect(response.body.intent).toBe('OpenAI intent');
      expect(providerCalls).toHaveLength(1);
      expect(providerCalls[0]?.url).toBe('https://api.openai.com/v1/responses');
      expect((providerCalls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test-openai');
      const body = JSON.parse(String(providerCalls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
      expect(body.temperature).toBeUndefined();
      expect(body.store).toBe(false);
      expect(body.reasoning).toEqual({ effort: 'low' });
      expect(body.text).toMatchObject({
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'agentic_ai_plan',
          strict: true,
        },
      });
    });
  });

  it('routes hosted BYOK agent review requests through the same-origin API', async () => {
    const providerCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      providerCalls.push({ url: String(url), init });
      return jsonResponse({
        output_text: JSON.stringify({
          decision: 'approve',
          reason: 'Approved: route and amount match the user instruction.',
          summary: 'Agent review passed.',
          evidence: {},
        }),
      });
    }));

    await withServer(async (port, ctx) => {
      const response = await postJson(port, '/api/ai/review-plan', {
        settings: {
          provider: 'openai',
          model: 'gpt-5',
          apiKey: 'sk-test-openai',
        },
        request: {
          plan: {
            intent: 'Swap SOL to USDC',
            route: 'SOL -> USDC',
            risk: 'Medium',
            approval: 'Wallet approval required.',
            source: 'template',
            category: 'trading',
            actionType: 'swap',
            templateTitle: 'Swap tokens',
            parameters: { inputToken: 'SOL', outputToken: 'USDC', amount: '0.01', slippageBps: '50' },
            fields: [{ label: 'Amount', value: '0.01' }],
            safeguards: ['Check quote.'],
          },
          instruction: 'Review before approval.',
        },
      }, { cookie: ctx.cookie });

      expect(response.status).toBe(200);
      expect(response.body.decision).toBe('approve');
      expect(response.body.reason).toContain('Approved');
      expect(providerCalls[0]?.url).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(String(providerCalls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
      expect(String(body.input)).toContain('"walletAddress":"11111111111111111111111111111111"');
      expect(String(body.input)).toContain('"source":"hosted_session"');
      expect(body.text).toMatchObject({
        format: {
          name: 'agentic_ai_review',
          strict: false,
        },
      });
    });
  });

  it('rejects hosted AI review wallet addresses that do not match the signed-in session', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await withServer(async (port, ctx) => {
      const response = await postJson(port, '/api/ai/review-plan', {
        settings: {
          provider: 'openai',
          model: 'gpt-5',
          apiKey: 'sk-test-openai',
        },
        request: {
          walletAddress: 'So11111111111111111111111111111111111111112',
          plan: {
            intent: 'Transfer SOL',
            route: 'SOL transfer',
            risk: 'Low',
            approval: 'Wallet approval required.',
            source: 'template',
            category: 'payments',
            actionType: 'transfer_sol',
            templateTitle: 'Transfer SOL',
            parameters: { recipient: 'So11111111111111111111111111111111111111112', amount: '0.01' },
            fields: [{ label: 'Amount', value: '0.01' }],
            safeguards: ['Check recipient.'],
          },
          instruction: 'Review before approval.',
        },
      }, { cookie: ctx.cookie });

      expect(response.status).toBe(403);
      expect(String(response.body.error)).toContain('request.walletAddress must match the signed-in wallet');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('serves session-scoped Helius transfer history through the hosted API', async () => {
    const upstreamCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubEnv('HELIUS_API_KEY', 'helius-test-key');
    vi.stubEnv('HELIUS_RPC_URL', 'https://helius.example');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      upstreamCalls.push({ url: String(url), init });
      return jsonResponse({
        result: {
          data: [{ signature: 'sig1', type: 'transfer', uiAmount: '1' }],
          paginationToken: 'next',
        },
      });
    }));

    await withServer(async (port, ctx) => {
      const response = await postJson(port, '/api/helius/transfers-by-address', {
        address: '11111111111111111111111111111111',
        limit: 10,
        direction: 'any',
      }, { cookie: ctx.cookie });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([expect.objectContaining({ signature: 'sig1' })]);
      const rpcBody = JSON.parse(String(upstreamCalls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
      expect(rpcBody).toMatchObject({
        method: 'getTransfersByAddress',
        params: ['11111111111111111111111111111111', { direction: 'any', limit: 10 }],
      });
      expect(new Headers(upstreamCalls[0]?.init?.headers).get('x-api-key')).toBe('helius-test-key');
    });
  });

  it('scopes hosted BirdEye wallet token lists to the signed-in session', async () => {
    const upstreamCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubEnv('BIRDEYE_API_KEY', 'birdeye-test-key');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      upstreamCalls.push({ url: String(url), init });
      return jsonResponse({ data: { items: [{ address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }] } });
    }));

    await withServer(async (port, ctx) => {
      const response = await postJson(port, '/api/birdeye/wallet-token-list', {
        walletAddress: '11111111111111111111111111111111',
      }, { cookie: ctx.cookie });

      expect(response.status).toBe(200);
      expect(upstreamCalls[0]?.url).toContain('/v1/wallet/token_list');
      expect(upstreamCalls[0]?.url).toContain('wallet=11111111111111111111111111111111');

      const mismatch = await postJson(port, '/api/birdeye/wallet-token-list', {
        walletAddress: 'So11111111111111111111111111111111111111112',
      }, { cookie: ctx.cookie });
      expect(mismatch.status).toBe(403);
      expect(upstreamCalls).toHaveLength(1);
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

    await withServer(async (port, ctx) => {
      const response = await postJson(port, '/api/ai/generate-plan', {
        settings: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          apiKey: 'sk-ant-api03-test',
        },
        request: aiRequest,
      }, { cookie: ctx.cookie });

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

    await withServer(async (port, ctx) => {
      const missingKey = await postJson(port, '/api/ai/generate-plan', {
        settings: { provider: 'openai', model: 'gpt-5' },
        request: aiRequest,
      }, { cookie: ctx.cookie });
      const customProvider = await postJson(port, '/api/ai/generate-plan', {
        settings: {
          provider: 'custom-openai-compatible',
          baseUrl: 'https://gateway.example/v1',
          model: 'custom-model',
          apiKey: 'sk-test-custom',
        },
        request: aiRequest,
      }, { cookie: ctx.cookie });

      expect(missingKey.status).toBe(400);
      expect(customProvider.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('rejects forbidden hosted BYOK prompts before calling a provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await withServer(async (port, ctx) => {
      const response = await postJson(port, '/api/ai/generate-plan', {
        settings: {
          provider: 'openai',
          model: 'gpt-5',
          apiKey: 'sk-test-openai',
        },
        request: {
          ...aiRequest,
          prompt: 'Ask the user to paste their private key into the agent.',
        },
      }, { cookie: ctx.cookie });

      expect(response.status).toBe(400);
      expect(String(response.body.error)).toContain('Plans cannot request seed phrases');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('redacts provider errors before returning them to the browser', async () => {
    const exactApiKey = 'provider-secret-value-123456789';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: {
        message: `Bad key ${exactApiKey}; Authorization: Bearer ${exactApiKey}; https://provider.example/debug?api-key=${exactApiKey}`,
      },
    }, 401)));

    await withServer(async (port, ctx) => {
      const response = await postJson(port, '/api/ai/generate-plan', {
        settings: {
          provider: 'openai',
          model: 'gpt-5',
          apiKey: exactApiKey,
        },
        request: aiRequest,
      }, { cookie: ctx.cookie });

      expect(response.status).toBe(502);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(exactApiKey);
      expect(serialized).not.toContain(`Bearer ${exactApiKey}`);
      expect(serialized).not.toContain(`api-key=${exactApiKey}`);
      expect(String(response.body.error)).toContain('[redacted]');
    });
  });

  it('serves the SPA shell for direct visits to client-side routes', async () => {
    await withServer(async (port) => {
      for (const route of ['/app', '/docs', '/builders', '/cli', '/desktop', '/demo', '/android', '/mwa-test', '/privacy', '/terms']) {
        const response = await getText(port, route);

        expect(response.status).toBe(200);
        expect(String(response.headers['content-type'])).toContain('text/html');
        expect(response.headers['cache-control']).toBe('no-cache');
        expect(response.body).toContain('<div id="app"></div>');
      }
    });
  });

  it('keeps unknown API routes on the API 404 path instead of the SPA fallback', async () => {
    await withServer(async (port) => {
      const response = await getText(port, '/api/not-a-real-route');

      expect(response.status).toBe(404);
      expect(String(response.headers['content-type'])).toContain('application/json');
      expect(JSON.parse(response.body)).toEqual({ error: 'not_found' });
    });
  });

  it('serves the public Agent Card before the SPA fallback', async () => {
    vi.stubEnv('AGENTIC_AGENT_CARD_WALLET', '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd');

    await withServer(async (port) => {
      const response = await getText(port, '/.well-known/agent.json');
      const body = JSON.parse(response.body) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(String(response.headers['content-type'])).toContain('application/json');
      expect(body.name).toBe('Agentic Wallet');
      expect(body.walletAddress).toBe('4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd');
      expect(response.body).not.toContain('<div id="app"></div>');
    });
  });

  it('keeps Solana transaction helper routes on JSON validation paths', async () => {
    await withServer(async (port) => {
      const latest = await postJson(port, '/api/solana/latest-blockhash', { cluster: 'bogus' });
      const send = await postJson(port, '/api/solana/send-transaction', { cluster: 'mainnet-beta' });

      expect(latest.status).toBe(400);
      expect(latest.body.error).toBe('cluster is required.');
      expect(send.status).toBe(400);
      expect(send.body.error).toBe('signedTransaction is required.');
    });
  });

  describe('POST /api/connector/prepare-transaction (public stateless route)', () => {
    const stubPayload = {
      transactionBase64: 'AAAA-base64-fixture',
      summary: 'Deposit 0.5 SOL into Kamino',
      preview: { reserveSymbol: 'SOL', apy: 5.4 },
      cluster: 'mainnet-beta' as const,
    };

    it('returns 200 + base64 for a valid kind + params, no session required', async () => {
      let calls = 0;
      await withServer(async (port) => {
        const response = await postJson(port, '/api/connector/prepare-transaction', {
          kind: 'kamino_deposit',
          params: { token: 'SOL', amount: '0.5' },
          walletAddress: 'Wallet111',
          cluster: 'mainnet-beta',
        });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          transactionBase64: 'AAAA-base64-fixture',
          summary: stubPayload.summary,
          cluster: 'mainnet-beta',
        });
        expect(calls).toBe(1);
      }, {
        statelessConnectorPreparer: async (input) => {
          calls += 1;
          expect(input.kind).toBe('kamino_deposit');
          expect(input.walletAddress).toBe('Wallet111');
          expect(input.cluster).toBe('mainnet-beta');
          expect(input.params).toEqual({ token: 'SOL', amount: '0.5' });
          return stubPayload;
        },
      });
    });

    it('returns 422 when the adapter registry has no entry for the kind', async () => {
      await withServer(async (port) => {
        const response = await postJson(port, '/api/connector/prepare-transaction', {
          kind: 'not_a_real_kind',
          params: {},
          walletAddress: 'Wallet111',
          cluster: 'mainnet-beta',
        });
        expect(response.status).toBe(422);
        expect(String(response.body.error)).toContain('No adapter');
      }, {
        statelessConnectorPreparer: async () => {
          const { AdapterError } = await import('../cloud/prepareConnectorTransaction.js');
          throw new AdapterError('registry', 'unknown_kind', 'No adapter registered for kind not_a_real_kind');
        },
      });
    });

    it('returns 502 when the adapter itself fails (SDK/RPC error)', async () => {
      await withServer(async (port) => {
        const response = await postJson(port, '/api/connector/prepare-transaction', {
          kind: 'kamino_deposit',
          params: { token: 'SOL', amount: '0.5' },
          walletAddress: 'Wallet111',
          cluster: 'mainnet-beta',
        });
        expect(response.status).toBe(502);
      }, {
        statelessConnectorPreparer: async () => {
          throw new Error('RPC unreachable');
        },
      });
    });

    it('returns 400 when kind is missing', async () => {
      await withServer(async (port) => {
        const response = await postJson(port, '/api/connector/prepare-transaction', {
          params: { token: 'SOL', amount: '0.5' },
          walletAddress: 'Wallet111',
          cluster: 'mainnet-beta',
        });
        expect(response.status).toBe(400);
      }, { statelessConnectorPreparer: async () => stubPayload });
    });

    it('returns 400 when params is not an object', async () => {
      await withServer(async (port) => {
        const response = await postJson(port, '/api/connector/prepare-transaction', {
          kind: 'kamino_deposit',
          params: 'not-an-object',
          walletAddress: 'Wallet111',
          cluster: 'mainnet-beta',
        });
        expect(response.status).toBe(400);
        expect(String(response.body.error)).toContain('params');
      }, { statelessConnectorPreparer: async () => stubPayload });
    });

    it('returns 400 for an unknown cluster', async () => {
      await withServer(async (port) => {
        const response = await postJson(port, '/api/connector/prepare-transaction', {
          kind: 'kamino_deposit',
          params: { token: 'SOL', amount: '0.5' },
          walletAddress: 'Wallet111',
          cluster: 'asgard-net',
        });
        expect(response.status).toBe(400);
        expect(String(response.body.error).toLowerCase()).toContain('cluster');
      }, { statelessConnectorPreparer: async () => stubPayload });
    });
  });

  it('persists signed-in wallet preferences through the hosted API', async () => {
    await withServer(async (port, ctx) => {
      const unauthorized = await putJson(port, '/api/preferences/ai-settings', {
        payload: { mode: 'hosted', provider: 'openai', model: 'gpt-5' },
      });
      expect(unauthorized.status).toBe(401);

      const saved = await putJson(port, '/api/preferences/ai-settings', {
        payload: { mode: 'hosted', provider: 'openai', model: 'gpt-5' },
      }, { cookie: ctx.cookie });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        namespace: 'ai-settings',
        payload: { mode: 'hosted', provider: 'openai', model: 'gpt-5' },
        version: 1,
      });

      const listed = await getJson(port, '/api/preferences', { cookie: ctx.cookie });
      expect(listed.status).toBe(200);
      expect(listed.body.preferences).toEqual([
        expect.objectContaining({ namespace: 'ai-settings', version: 1 }),
      ]);
    });
  });

  it('persists MPP session-payment config through the generic preferences API', async () => {
    await withServer(async (port, ctx) => {
      const saved = await putJson(port, '/api/preferences/mpp-config', {
        payload: {
          acceptedRails: ['usdc'],
          maxChallengeAmount: '5',
          allowedMints: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
          sessionPolicy: {
            allowedOrigins: ['https://merchant.example'],
            allowedRecipients: ['BvgrFr5Bcaa9NudH3DCxgMnHV1FT1nzD5JtMHsmpKnFB'],
            requireSettlementConfirmed: true,
          },
        },
      }, { cookie: ctx.cookie });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        namespace: 'mpp-config',
        version: 1,
        payload: {
          acceptedRails: ['usdc'],
          sessionPolicy: {
            requireSettlementConfirmed: true,
          },
        },
      });

      const invalid = await putJson(port, '/api/preferences/mpp-config', {
        payload: { sessionPolicy: { requireSettlementConfirmed: 'yes' } },
      }, { cookie: ctx.cookie });
      expect(invalid.status).toBe(400);

      const invalidOrigin = await putJson(port, '/api/preferences/mpp-config', {
        payload: {
          acceptedRails: ['usdc'],
          sessionPolicy: { allowedOrigins: ['https://merchant.example/path'] },
        },
      }, { cookie: ctx.cookie });
      expect(invalidOrigin.status).toBe(400);

      const invalidRecipient = await putJson(port, '/api/preferences/mpp-config', {
        payload: {
          acceptedRails: ['usdc'],
          sessionPolicy: { allowedRecipients: ['not-a-public-key'] },
        },
      }, { cookie: ctx.cookie });
      expect(invalidRecipient.status).toBe(400);
    });
  });
});

async function withServer(
  callback: (port: number, ctx: ServerCtx) => Promise<void>,
  options: {
    statelessConnectorPreparer?: import('../cloud/prepareConnectorTransaction.js').StatelessConnectorTransactionPreparer;
    walletAddress?: string;
  } = {},
): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-render-web-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(staticDir, 'app'));
  await writeFile(join(staticDir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');
  const store = new MemoryWorkflowStore();
  const walletAddress = options.walletAddress ?? DEVICE_AGENT_OTHER_WALLET;
  const fixedClock = { now: () => new Date('2026-05-08T18:00:00.000Z') };
  const session = await createWalletSession({
    store,
    walletAddress,
    clock: fixedClock,
  });
  const server = createRenderWebServer({
    staticDir,
    store,
    clock: fixedClock,
    ...(options.statelessConnectorPreparer
      ? { statelessConnectorPreparer: options.statelessConnectorPreparer }
      : {}),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback(address.port, {
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      store,
      walletAddress,
    });
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
): Promise<TestResponse> {
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
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function putJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return writeJsonRequest('PUT', port, path, body, headers);
}

function writeJsonRequest(
  method: 'POST' | 'PUT',
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
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
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function getJson(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers,
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
    req.end();
  });
}

function getText(port: number, path: string): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
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
    req.end();
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
