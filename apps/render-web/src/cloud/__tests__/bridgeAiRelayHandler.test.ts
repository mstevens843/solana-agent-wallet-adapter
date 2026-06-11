import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createBridgeAiRelayHandler,
  type BridgeAiRelayHandler,
  type RelayClock,
} from '../bridgeAiRelayHandler.js';

const UUID = '01234567-89ab-4def-8123-456789abcdef';
const PAIR_TOKEN = 'pairtoken-aaaaaaaaaaaaaaaaaaaa';
const BRIDGE_SECRET = 'bridgesecret-bbbbbbbbbbbbbbbbbbbb';

function fakeRequest(opts: {
  method: string;
  pathname: string;
  body?: unknown;
  headers?: Record<string, string>;
}): IncomingMessage {
  const bodyBuffer =
    opts.body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
  const stream = Readable.from(bodyBuffer.length > 0 ? [bodyBuffer] : []);
  const req = stream as unknown as IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = opts.method;
  req.url = opts.pathname;
  req.headers = opts.headers ?? {};
  return req;
}

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function fakeResponse(): { res: ServerResponse; captured: FakeResponse } {
  const captured: FakeResponse = { statusCode: 200, headers: {}, body: '', ended: false };
  const res = {
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    get statusCode() {
      return captured.statusCode;
    },
    setHeader(name: string, value: string): void {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string): void {
      if (chunk) captured.body += chunk;
      captured.ended = true;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function call(
  handler: BridgeAiRelayHandler,
  method: string,
  pathname: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
  const req = fakeRequest({ method, pathname, body: opts.body, headers: opts.headers });
  const { res, captured } = fakeResponse();
  const url = new URL(pathname, 'https://agentic-signer.com');
  const handled = await handler.handle(req, res, url);
  expect(handled).toBe(true);
  const body = captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : {};
  return { status: captured.statusCode, headers: captured.headers, body };
}

class MutableClock implements RelayClock {
  current = 1_000_000;
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

const bridgeAuth = { 'x-bridge-secret': BRIDGE_SECRET };
const deviceAuth = (bearer: string) => ({ authorization: `Bearer ${bearer}` });

async function register(handler: BridgeAiRelayHandler) {
  return call(handler, 'POST', `/api/bridge-pair/${UUID}/register`, {
    body: { pairToken: PAIR_TOKEN, bridgeSecret: BRIDGE_SECRET },
  });
}

async function claim(handler: BridgeAiRelayHandler): Promise<string> {
  const r = await call(handler, 'POST', `/api/bridge-pair/${UUID}/claim`, { body: { pairToken: PAIR_TOKEN } });
  expect(r.status).toBe(200);
  return r.body.deviceBearer as string;
}

describe('bridgeAiRelayHandler — routing', () => {
  let handler: BridgeAiRelayHandler;
  beforeEach(() => {
    handler = createBridgeAiRelayHandler();
  });
  afterEach(() => {
    handler.shutdown();
  });

  it('returns false for unrelated paths', async () => {
    const req = fakeRequest({ method: 'GET', pathname: '/api/session' });
    const { res, captured } = fakeResponse();
    const handled = await handler.handle(req, res, new URL('https://x/api/session'));
    expect(handled).toBe(false);
    expect(captured.ended).toBe(false);
  });

  it('rejects malformed UUIDs on both prefixes', async () => {
    expect((await call(handler, 'POST', '/api/bridge-pair/not-a-uuid/claim')).status).toBe(400);
    expect((await call(handler, 'GET', '/api/bridge-ai/not-a-uuid/status')).status).toBe(400);
  });

  it('answers CORS preflight', async () => {
    const req = fakeRequest({ method: 'OPTIONS', pathname: `/api/bridge-pair/${UUID}/claim` });
    const { res, captured } = fakeResponse();
    await handler.handle(req, res, new URL(`https://x/api/bridge-pair/${UUID}/claim`));
    expect(captured.statusCode).toBe(204);
    expect(captured.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('404s AI/pair actions on an unregistered session', async () => {
    expect((await call(handler, 'POST', `/api/bridge-pair/${UUID}/claim`)).status).toBe(404);
    expect((await call(handler, 'GET', `/api/bridge-ai/${UUID}/status`)).status).toBe(404);
  });
});

describe('bridgeAiRelayHandler — pairing lifecycle', () => {
  let handler: BridgeAiRelayHandler;
  beforeEach(() => {
    handler = createBridgeAiRelayHandler();
  });
  afterEach(() => {
    handler.shutdown();
  });

  it('registers, claims once, and burns the pair token', async () => {
    expect((await register(handler)).status).toBe(200);
    const bearer = await claim(handler);
    expect(typeof bearer).toBe('string');
    expect(bearer.length).toBeGreaterThan(20);
    // Second claim with the same (now-burned) token is rejected.
    const second = await call(handler, 'POST', `/api/bridge-pair/${UUID}/claim`, { body: { pairToken: PAIR_TOKEN } });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already_paired');
  });

  it('rejects a wrong pair token', async () => {
    await register(handler);
    const r = await call(handler, 'POST', `/api/bridge-pair/${UUID}/claim`, { body: { pairToken: 'wrong-token-zzzzzzzzzzzzzzzz' } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('invalid_pair_token');
  });

  it('expires the pair token after its TTL', async () => {
    const clock = new MutableClock();
    const h = createBridgeAiRelayHandler({ clock, pairTokenTtlMs: 1000 });
    await call(h, 'POST', `/api/bridge-pair/${UUID}/register`, { body: { pairToken: PAIR_TOKEN, bridgeSecret: BRIDGE_SECRET } });
    clock.advance(1500);
    const r = await call(h, 'POST', `/api/bridge-pair/${UUID}/claim`, { body: { pairToken: PAIR_TOKEN } });
    expect(r.status).toBe(410);
    expect(r.body.error).toBe('pairing_expired');
    h.shutdown();
  });

  it('refuses re-registration from a different bridge secret', async () => {
    await register(handler);
    const r = await call(handler, 'POST', `/api/bridge-pair/${UUID}/register`, {
      body: { pairToken: 'newtoken-cccccccccccccccccccc', bridgeSecret: 'imposter-dddddddddddddddddddd' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('pairing_id_in_use');
  });

  it('lets the same desktop re-register a fresh pair token', async () => {
    await register(handler);
    const reRegister = await call(handler, 'POST', `/api/bridge-pair/${UUID}/register`, {
      body: { pairToken: 'rotated-eeeeeeeeeeeeeeeeeeeeee', bridgeSecret: BRIDGE_SECRET },
    });
    expect(reRegister.status).toBe(200);
    const r = await call(handler, 'POST', `/api/bridge-pair/${UUID}/claim`, { body: { pairToken: 'rotated-eeeeeeeeeeeeeeeeeeeeee' } });
    expect(r.status).toBe(200);
  });

  it('rejects short/empty register payloads', async () => {
    const r = await call(handler, 'POST', `/api/bridge-pair/${UUID}/register`, { body: { pairToken: 'x', bridgeSecret: 'y' } });
    expect(r.status).toBe(400);
  });
});

describe('bridgeAiRelayHandler — desktop poll auth', () => {
  let handler: BridgeAiRelayHandler;
  beforeEach(async () => {
    handler = createBridgeAiRelayHandler();
    await register(handler);
  });
  afterEach(() => handler.shutdown());

  it('rejects a poll without the bridge secret', async () => {
    const r = await call(handler, 'GET', `/api/bridge-pair/${UUID}/poll`);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('bridge_auth_failed');
  });

  it('signals justPaired exactly once after a claim', async () => {
    await claim(handler);
    const first = await call(handler, 'GET', `/api/bridge-pair/${UUID}/poll`, { headers: bridgeAuth });
    expect(first.body.paired).toBe(true);
    expect(first.body.justPaired).toBe(true);
    const second = await call(handler, 'GET', `/api/bridge-pair/${UUID}/poll`, { headers: bridgeAuth });
    expect(second.body.justPaired).toBe(false);
  });
});

describe('bridgeAiRelayHandler — AI forward end-to-end', () => {
  let handler: BridgeAiRelayHandler;
  let bearer: string;
  beforeEach(async () => {
    handler = createBridgeAiRelayHandler();
    await register(handler);
    bearer = await claim(handler);
  });
  afterEach(() => handler.shutdown());

  it('round-trips a generate-plan request phone -> relay -> desktop -> phone', async () => {
    // Phone forwards an allowlisted AI request.
    const forward = await call(handler, 'POST', `/api/bridge-ai/${UUID}/forward`, {
      headers: deviceAuth(bearer),
      body: { path: '/bridge/ai/generate-plan', body: { prompt: 'swap 1 SOL to USDC' } },
    });
    expect(forward.status).toBe(200);
    const requestId = forward.body.requestId as string;
    expect(requestId).toBeTruthy();

    // Phone polls — still pending before the desktop picks it up.
    const pending = await call(handler, 'GET', `/api/bridge-ai/${UUID}/result/${requestId}`, { headers: deviceAuth(bearer) });
    expect(pending.body.status).toBe('pending');

    // Desktop polls its inbox and sees the request with the original body.
    const poll = await call(handler, 'GET', `/api/bridge-pair/${UUID}/poll`, { headers: bridgeAuth });
    const requests = poll.body.requests as Array<Record<string, unknown>>;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe('/bridge/ai/generate-plan');
    expect((requests[0]!.body as Record<string, unknown>).prompt).toBe('swap 1 SOL to USDC');

    // A second desktop poll does NOT re-deliver the in-flight request.
    const poll2 = await call(handler, 'GET', `/api/bridge-pair/${UUID}/poll`, { headers: bridgeAuth });
    expect((poll2.body.requests as unknown[]).length).toBe(0);

    // Desktop posts the result.
    const respond = await call(handler, 'POST', `/api/bridge-pair/${UUID}/respond/${requestId}`, {
      headers: bridgeAuth,
      body: { plan: { steps: ['swap'] }, source: 'codex' },
    });
    expect(respond.status).toBe(200);

    // Phone polls and gets the resolved result.
    const resolved = await call(handler, 'GET', `/api/bridge-ai/${UUID}/result/${requestId}`, { headers: deviceAuth(bearer) });
    expect(resolved.body.status).toBe('resolved');
    expect((resolved.body.result as Record<string, unknown>).source).toBe('codex');
  });

  it('rejects a forward with a wrong/absent device bearer', async () => {
    expect(
      (await call(handler, 'POST', `/api/bridge-ai/${UUID}/forward`, {
        body: { path: '/bridge/ai/generate-plan', body: {} },
      })).status,
    ).toBe(401);
    expect(
      (await call(handler, 'POST', `/api/bridge-ai/${UUID}/forward`, {
        headers: deviceAuth('not-the-bearer'),
        body: { path: '/bridge/ai/generate-plan', body: {} },
      })).status,
    ).toBe(401);
  });

  it('rejects a non-allowlisted forward path', async () => {
    const r = await call(handler, 'POST', `/api/bridge-ai/${UUID}/forward`, {
      headers: deviceAuth(bearer),
      body: { path: '/bridge/action/sign-and-send', body: {} },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('path_not_allowed');
  });

  it('re-delivers a stale in-flight request after the lease expires', async () => {
    const clock = new MutableClock();
    const h = createBridgeAiRelayHandler({ clock, inFlightLeaseMs: 1000 });
    await call(h, 'POST', `/api/bridge-pair/${UUID}/register`, { body: { pairToken: PAIR_TOKEN, bridgeSecret: BRIDGE_SECRET } });
    const b = (await call(h, 'POST', `/api/bridge-pair/${UUID}/claim`, { body: { pairToken: PAIR_TOKEN } })).body.deviceBearer as string;
    const reqId = (await call(h, 'POST', `/api/bridge-ai/${UUID}/forward`, {
      headers: deviceAuth(b),
      body: { path: '/bridge/ai/review-plan', body: {} },
    })).body.requestId as string;
    expect((await call(h, 'GET', `/api/bridge-pair/${UUID}/poll`, { headers: bridgeAuth })).body.requests).toHaveLength(1);
    // Within the lease: hidden.
    expect((await call(h, 'GET', `/api/bridge-pair/${UUID}/poll`, { headers: bridgeAuth })).body.requests).toHaveLength(0);
    clock.advance(1500);
    // Lease expired: redelivered.
    const redo = await call(h, 'GET', `/api/bridge-pair/${UUID}/poll`, { headers: bridgeAuth });
    expect((redo.body.requests as unknown[]).length).toBe(1);
    void reqId;
    h.shutdown();
  });
});

describe('bridgeAiRelayHandler — revocation & status', () => {
  let handler: BridgeAiRelayHandler;
  let bearer: string;
  beforeEach(async () => {
    handler = createBridgeAiRelayHandler();
    await register(handler);
    bearer = await claim(handler);
  });
  afterEach(() => handler.shutdown());

  it('reports desktopOnline only within the online window', async () => {
    const before = await call(handler, 'GET', `/api/bridge-ai/${UUID}/status`, { headers: deviceAuth(bearer) });
    expect(before.body.desktopOnline).toBe(false);
    await call(handler, 'GET', `/api/bridge-pair/${UUID}/poll`, { headers: bridgeAuth });
    const after = await call(handler, 'GET', `/api/bridge-ai/${UUID}/status`, { headers: deviceAuth(bearer) });
    expect(after.body.desktopOnline).toBe(true);
  });

  it('unpair drops the session so the phone can no longer reach it', async () => {
    expect((await call(handler, 'POST', `/api/bridge-pair/${UUID}/unpair`, { headers: bridgeAuth })).status).toBe(200);
    const r = await call(handler, 'GET', `/api/bridge-ai/${UUID}/status`, { headers: deviceAuth(bearer) });
    expect(r.status).toBe(404);
  });

  it('rejects unpair without the bridge secret', async () => {
    expect((await call(handler, 'POST', `/api/bridge-pair/${UUID}/unpair`)).status).toBe(401);
  });
});

describe('bridgeAiRelayHandler — duplicate-run + one-shot hardening', () => {
  let handler: BridgeAiRelayHandler;
  let bearer: string;
  beforeEach(async () => {
    handler = createBridgeAiRelayHandler();
    await register(handler);
    bearer = await claim(handler);
  });
  afterEach(() => handler.shutdown());

  async function forwardOne(): Promise<string> {
    const r = await call(handler, 'POST', `/api/bridge-ai/${UUID}/forward`, {
      headers: deviceAuth(bearer),
      body: { path: '/bridge/ai/generate-plan', body: { prompt: 'x' } },
    });
    return r.body.requestId as string;
  }

  it('poll hands out at most ONE request even when several are queued (lease-of-one)', async () => {
    await forwardOne();
    await forwardOne();
    await forwardOne();
    const poll = await call(handler, 'GET', `/api/bridge-pair/${UUID}/poll`, { headers: bridgeAuth });
    expect((poll.body.requests as unknown[]).length).toBe(1);
  });

  it('respond is idempotent — a duplicate late result does not overwrite the first', async () => {
    const reqId = await forwardOne();
    await call(handler, 'GET', `/api/bridge-pair/${UUID}/poll`, { headers: bridgeAuth });
    expect((await call(handler, 'POST', `/api/bridge-pair/${UUID}/respond/${reqId}`, { headers: bridgeAuth, body: { plan: 'first' } })).status).toBe(200);
    const dup = await call(handler, 'POST', `/api/bridge-pair/${UUID}/respond/${reqId}`, { headers: bridgeAuth, body: { plan: 'second' } });
    expect(dup.body.duplicate).toBe(true);
    const result = await call(handler, 'GET', `/api/bridge-ai/${UUID}/result/${reqId}`, { headers: deviceAuth(bearer) });
    expect((result.body.result as Record<string, unknown>).plan).toBe('first');
  });

  it('result survives a re-read within the grace window (consumed-on-read, not deleted)', async () => {
    const reqId = await forwardOne();
    await call(handler, 'GET', `/api/bridge-pair/${UUID}/poll`, { headers: bridgeAuth });
    await call(handler, 'POST', `/api/bridge-pair/${UUID}/respond/${reqId}`, { headers: bridgeAuth, body: { plan: 'done' } });
    const first = await call(handler, 'GET', `/api/bridge-ai/${UUID}/result/${reqId}`, { headers: deviceAuth(bearer) });
    expect(first.body.status).toBe('resolved');
    // A dropped 200 body would make the phone re-GET — it must still get the completed result.
    const second = await call(handler, 'GET', `/api/bridge-ai/${UUID}/result/${reqId}`, { headers: deviceAuth(bearer) });
    expect(second.body.status).toBe('resolved');
    expect((second.body.result as Record<string, unknown>).plan).toBe('done');
  });

  it('rejects the now-removed session-key / connector-login / chat / status forward paths', async () => {
    for (const path of ['/bridge/ai/session-key', '/bridge/ai/connector/login', '/bridge/ai/chat', '/bridge/ai/status', '/bridge/ai/connector/detect']) {
      const r = await call(handler, 'POST', `/api/bridge-ai/${UUID}/forward`, { headers: deviceAuth(bearer), body: { path, body: {} } });
      expect(r.body.error).toBe('path_not_allowed');
    }
  });
});

describe('bridgeAiRelayHandler — per-IP register limit', () => {
  it('rate-limits new registers per IP (9th from the same IP is 429)', async () => {
    const handler = createBridgeAiRelayHandler();
    for (let i = 0; i < 8; i += 1) {
      const uuid = `0000000${i}-89ab-4def-8123-456789abcdef`;
      const r = await call(handler, 'POST', `/api/bridge-pair/${uuid}/register`, { body: { pairToken: PAIR_TOKEN, bridgeSecret: BRIDGE_SECRET } });
      expect(r.status).toBe(200);
    }
    const ninth = await call(handler, 'POST', `/api/bridge-pair/00000008-89ab-4def-8123-456789abcdef/register`, { body: { pairToken: PAIR_TOKEN, bridgeSecret: BRIDGE_SECRET } });
    expect(ninth.status).toBe(429);
    handler.shutdown();
  });
});
