import { describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

import { BridgePairingController } from '../bridgePairingClient.js';

// A faithful in-file double of apps/render-web bridgeAiRelayHandler.ts, scoped to
// the routes the desktop controller exercises (register/poll/respond/unpair) plus
// phone-side helpers (claim/forward/getResult) the test drives directly. The real
// relay's full behavior is covered by render-web's bridgeAiRelayHandler tests;
// here we prove the CONTROLLER speaks the contract correctly end to end.
class FakeRelay {
  sessions = new Map<
    string,
    {
      bridgeSecret: string;
      pairToken: string | null;
      paired: boolean;
      justPaired: boolean;
      deviceBearer: string | null;
      e2eeRequired: boolean;
      e2eeClaim?: { alg: string; phonePub: string; proof: string };
      inbox: Array<{ requestId: string; path: string; body: unknown; status: 'pending' | 'delivered' | 'resolved'; result?: unknown }>;
    }
  >();
  unpaired: string[] = [];
  forcePollStatus: number | null = null; // when set, /poll returns this status (for backoff/auth tests)
  private reqSeq = 0;

  fetch = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }> => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const secret = init?.headers?.['x-bridge-secret'];
    const m = /^\/api\/bridge-pair\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!m) return json(404, { error: 'not_found' });
    const [, uuid, action, trailing] = m;

    if (action === 'register' && method === 'POST') {
      this.sessions.set(uuid!, {
        bridgeSecret: String(body.bridgeSecret),
        pairToken: String(body.pairToken),
        paired: false,
        justPaired: false,
        deviceBearer: null,
        e2eeRequired: body.e2eeRequired === true,
        e2eeClaim: undefined,
        inbox: [],
      });
      return json(200, { ok: true });
    }
    const session = this.sessions.get(uuid!);
    if (!session) return json(404, { error: 'pairing_not_found' });

    if (action === 'poll' && method === 'GET' && this.forcePollStatus) {
      return json(this.forcePollStatus, { error: 'forced' });
    }
    if (action === 'poll' && method === 'GET') {
      if (secret !== session.bridgeSecret) return json(401, { error: 'bridge_auth_failed' });
      const ready = session.inbox.filter((e) => e.status === 'pending');
      for (const e of ready) e.status = 'delivered';
      const justPaired = session.justPaired;
      session.justPaired = false;
      return json(200, {
        paired: session.paired,
        justPaired,
        ...(session.e2eeClaim ? { e2eeClaim: session.e2eeClaim } : {}),
        requests: ready.map((e) => ({ requestId: e.requestId, path: e.path, body: e.body })),
      });
    }
    if (action === 'respond' && method === 'POST' && trailing) {
      if (secret !== session.bridgeSecret) return json(401, { error: 'bridge_auth_failed' });
      const entry = session.inbox.find((e) => e.requestId === trailing);
      if (!entry) return json(404, { error: 'request_not_found' });
      entry.status = 'resolved';
      entry.result = body;
      return json(200, { ok: true });
    }
    if (action === 'unpair' && method === 'POST') {
      if (secret !== session.bridgeSecret) return json(401, { error: 'bridge_auth_failed' });
      this.sessions.delete(uuid!);
      this.unpaired.push(uuid!);
      return json(200, { ok: true });
    }
    return json(405, { error: 'method_not_allowed' });
  };

  // --- phone-side simulation -------------------------------------------------
  claim(uuid: string, e2eeClaim?: { alg: string; phonePub: string; proof: string }): string {
    const session = this.sessions.get(uuid);
    if (!session) throw new Error('no session');
    if (session.e2eeRequired && !e2eeClaim) throw new Error('e2ee_required');
    session.paired = true;
    session.justPaired = true;
    session.e2eeClaim = e2eeClaim;
    session.deviceBearer = `bearer-${uuid}`;
    session.pairToken = null;
    return session.deviceBearer;
  }
  forward(uuid: string, path: string, requestBody: unknown): string {
    const session = this.sessions.get(uuid);
    if (!session) throw new Error('no session');
    const requestId = `req-${++this.reqSeq}`;
    session.inbox.push({ requestId, path, body: requestBody, status: 'pending' });
    return requestId;
  }
  result(uuid: string, requestId: string): { status: string; result?: unknown } {
    const session = this.sessions.get(uuid);
    const entry = session?.inbox.find((e) => e.requestId === requestId);
    if (!entry) return { status: 'not_found' };
    return entry.status === 'resolved' ? { status: 'resolved', result: entry.result } : { status: entry.status };
  }
  // Simulate a relay re-delivery (lease lapse / respond blip): the same requestId becomes pending again.
  redeliver(uuid: string, requestId: string): void {
    const entry = this.sessions.get(uuid)?.inbox.find((e) => e.requestId === requestId);
    if (entry) entry.status = 'pending';
  }
}

function json(status: number, payload: unknown) {
  return Promise.resolve({
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
}

const FIXED_IDS = { pairUuid: '11111111-2222-4333-8444-555555555555', pairToken: 'tok-'.padEnd(40, 'x'), bridgeSecret: 'sec-'.padEnd(40, 'y') };
const PAIRING_ALG = 'P256-HKDF-SHA256-A256GCM';
const ENVELOPE_ALG = 'A256GCM';

interface PhoneE2eeSession {
  requestKey: Buffer;
  responseKey: Buffer;
}

function makeController(relay: FakeRelay, dispatch = vi.fn(async (path: string, body: unknown) => ({ echoed: path, got: body }))) {
  const controller = new BridgePairingController({
    dispatch,
    relayBaseUrl: 'https://relay.test',
    fetchImpl: relay.fetch,
    generateIds: () => FIXED_IDS,
    sleep: () => Promise.resolve(),
  });
  return { controller, dispatch };
}

function phoneClaimFromQr(relay: FakeRelay, qr: Record<string, unknown>): PhoneE2eeSession {
  const e2ee = qr.e2ee as { alg: string; desktopPub: string; pairSecret: string };
  expect(e2ee.alg).toBe(PAIRING_ALG);
  const phone = createECDH('prime256v1');
  phone.generateKeys();
  const phonePub = b64url(phone.getPublicKey());
  const proof = b64url(
    createHmac('sha256', b64urlDecode(e2ee.pairSecret))
      .update(`agentic-bridge-e2ee-proof-v1\n${qr.uuid}\n${e2ee.desktopPub}\n${phonePub}`, 'utf8')
      .digest(),
  );
  relay.claim(String(qr.uuid), { alg: PAIRING_ALG, phonePub, proof });
  const shared = phone.computeSecret(b64urlDecode(e2ee.desktopPub));
  const salt = createHash('sha256')
    .update(`agentic-bridge-e2ee-salt-v1\n${qr.uuid}\n${e2ee.desktopPub}\n${phonePub}`, 'utf8')
    .digest();
  return {
    requestKey: Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('agentic-bridge-e2ee/request/v1', 'utf8'), 32)),
    responseKey: Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('agentic-bridge-e2ee/response/v1', 'utf8'), 32)),
  };
}

async function startAndClaim(controller: BridgePairingController, relay: FakeRelay): Promise<PhoneE2eeSession> {
  const state = await controller.start();
  return phoneClaimFromQr(relay, JSON.parse(state.qrPayload!) as Record<string, unknown>);
}

function encryptPhoneRequest(session: PhoneE2eeSession, path: string, body: unknown, clientNonce = 'client-nonce-test-1'): unknown {
  return encryptEnvelope(session.requestKey, { v: 2, path, clientNonce, body });
}

function decryptPhoneResult(
  session: PhoneE2eeSession,
  result: unknown,
): { v: number; path: string; requestId: string; clientNonce?: string; result: unknown } {
  return decryptEnvelope(session.responseKey, result) as {
    v: number;
    path: string;
    requestId: string;
    clientNonce?: string;
    result: unknown;
  };
}

function encryptEnvelope(key: Buffer, value: unknown): unknown {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final(), cipher.getAuthTag()]);
  return { e2ee: { v: 2, alg: ENVELOPE_ALG, nonce: b64url(nonce), ciphertext: b64url(ciphertext) } };
}

function decryptEnvelope(key: Buffer, value: unknown): unknown {
  const e2ee = (value as { e2ee: { nonce: string; ciphertext: string } }).e2ee;
  const nonce = b64urlDecode(e2ee.nonce);
  const ciphertextWithTag = b64urlDecode(e2ee.ciphertext);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(ciphertextWithTag.subarray(ciphertextWithTag.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16)),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as unknown;
}

function b64url(value: Buffer): string {
  return value.toString('base64url');
}

function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

describe('BridgePairingController', () => {
  it('registers and exposes a v2 QR payload with relay/uuid/token/e2ee setup', async () => {
    const relay = new FakeRelay();
    const { controller } = makeController(relay);
    const state = await controller.start();
    expect(state.active).toBe(true);
    expect(relay.sessions.has(FIXED_IDS.pairUuid)).toBe(true);
    expect(relay.sessions.get(FIXED_IDS.pairUuid)?.e2eeRequired).toBe(true);
    const qr = JSON.parse(state.qrPayload!);
    expect(qr).toMatchObject({ v: 2, relay: 'https://relay.test', uuid: FIXED_IDS.pairUuid, token: FIXED_IDS.pairToken });
    expect(qr.e2ee).toMatchObject({ alg: PAIRING_ALG });
    expect(typeof qr.e2ee.desktopPub).toBe('string');
    expect(typeof qr.e2ee.pairSecret).toBe('string');
    await controller.stop();
  });

  it('round-trips a forwarded request: poll -> dispatch -> respond', async () => {
    const relay = new FakeRelay();
    const { controller, dispatch } = makeController(relay);
    const phone = await startAndClaim(controller, relay);
    const reqId = relay.forward(
      FIXED_IDS.pairUuid,
      '/bridge/ai/generate-plan',
      encryptPhoneRequest(phone, '/bridge/ai/generate-plan', { prompt: 'swap 1 SOL' }),
    );

    const summary = await controller.pollOnce();
    expect(summary.paired).toBe(true);
    expect(summary.handled).toBe(1);
    expect(dispatch).toHaveBeenCalledWith('/bridge/ai/generate-plan', { prompt: 'swap 1 SOL' });

    const result = relay.result(FIXED_IDS.pairUuid, reqId);
    expect(result.status).toBe('resolved');
    expect(decryptPhoneResult(phone, result.result)).toMatchObject({
      v: 2,
      path: '/bridge/ai/generate-plan',
      requestId: reqId,
      clientNonce: 'client-nonce-test-1',
      result: { echoed: '/bridge/ai/generate-plan', got: { prompt: 'swap 1 SOL' } },
    });
    await controller.stop();
  });

  it('relays a dispatch failure as an { error } envelope, never throwing', async () => {
    const relay = new FakeRelay();
    const dispatch = vi.fn(async () => {
      throw new Error('codex CLI not found');
    });
    const { controller } = makeController(relay, dispatch);
    const phone = await startAndClaim(controller, relay);
    const reqId = relay.forward(FIXED_IDS.pairUuid, '/bridge/ai/review-plan', encryptPhoneRequest(phone, '/bridge/ai/review-plan', {}));
    await expect(controller.pollOnce()).resolves.toMatchObject({ handled: 1 });
    const result = relay.result(FIXED_IDS.pairUuid, reqId) as { status: string; result: unknown };
    expect(result.status).toBe('resolved');
    expect((decryptPhoneResult(phone, result.result).result as { error: string }).error).toContain('codex CLI not found');
    await controller.stop();
  });

  it('does not redeliver an already-delivered request on the next poll', async () => {
    const relay = new FakeRelay();
    const { controller, dispatch } = makeController(relay);
    const phone = await startAndClaim(controller, relay);
    relay.forward(FIXED_IDS.pairUuid, '/bridge/ai/ask-about-plan', encryptPhoneRequest(phone, '/bridge/ai/ask-about-plan', {}));
    expect((await controller.pollOnce()).handled).toBe(1);
    expect((await controller.pollOnce()).handled).toBe(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await controller.stop();
  });

  it('stop() revokes the relay session', async () => {
    const relay = new FakeRelay();
    const { controller } = makeController(relay);
    await controller.start();
    await controller.stop();
    expect(relay.unpaired).toContain(FIXED_IDS.pairUuid);
    expect(relay.sessions.has(FIXED_IDS.pairUuid)).toBe(false);
    expect(controller.state().active).toBe(false);
  });

  it('fully resets local state when the relay reports the session is gone (404)', async () => {
    const relay = new FakeRelay();
    const { controller } = makeController(relay);
    await startAndClaim(controller, relay);
    relay.sessions.delete(FIXED_IDS.pairUuid); // simulate sweep/revoke
    const summary = await controller.pollOnce();
    expect(summary.handled).toBe(0);
    const state = controller.state();
    expect(state.active).toBe(false);
    expect(state.paired).toBe(false);
    expect(state.pairUuid).toBeNull();
    expect(state.qrPayload).toBeNull(); // no phantom un-claimable QR
    await controller.stop();
  });

  it('dedupes a re-delivered request — re-posts the cached result without re-dispatching', async () => {
    const relay = new FakeRelay();
    const dispatch = vi.fn(async (path: string, body: unknown) => ({ echoed: path, got: body }));
    const { controller } = makeController(relay, dispatch);
    const phone = await startAndClaim(controller, relay);
    const reqId = relay.forward(FIXED_IDS.pairUuid, '/bridge/ai/generate-plan', encryptPhoneRequest(phone, '/bridge/ai/generate-plan', {}));
    expect((await controller.pollOnce()).handled).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(relay.result(FIXED_IDS.pairUuid, reqId).status).toBe('resolved');

    // Relay re-delivers the same requestId (e.g. a respond blip lapsed the lease).
    relay.redeliver(FIXED_IDS.pairUuid, reqId);
    await controller.pollOnce();
    expect(dispatch).toHaveBeenCalledTimes(1); // NOT re-run — the metered connector fired only once
    expect(decryptPhoneResult(phone, relay.result(FIXED_IDS.pairUuid, reqId).result)).toMatchObject({
      path: '/bridge/ai/generate-plan',
      requestId: reqId,
      result: { echoed: '/bridge/ai/generate-plan', got: {} },
    });
    await controller.stop();
  });

  it('dedupes a replayed encrypted body by client nonce and re-wraps for the current requestId', async () => {
    const relay = new FakeRelay();
    const dispatch = vi.fn(async (path: string, body: unknown) => ({ echoed: path, got: body }));
    const { controller } = makeController(relay, dispatch);
    const phone = await startAndClaim(controller, relay);
    const replayedBody = encryptPhoneRequest(phone, '/bridge/ai/generate-plan', { prompt: 'swap once' }, 'client-nonce-replay-1');

    const firstReqId = relay.forward(FIXED_IDS.pairUuid, '/bridge/ai/generate-plan', replayedBody);
    expect((await controller.pollOnce()).handled).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const secondReqId = relay.forward(FIXED_IDS.pairUuid, '/bridge/ai/generate-plan', replayedBody);
    expect((await controller.pollOnce()).handled).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);

    expect(decryptPhoneResult(phone, relay.result(FIXED_IDS.pairUuid, firstReqId).result)).toMatchObject({
      requestId: firstReqId,
      clientNonce: 'client-nonce-replay-1',
      result: { echoed: '/bridge/ai/generate-plan', got: { prompt: 'swap once' } },
    });
    expect(decryptPhoneResult(phone, relay.result(FIXED_IDS.pairUuid, secondReqId).result)).toMatchObject({
      requestId: secondReqId,
      clientNonce: 'client-nonce-replay-1',
      result: { echoed: '/bridge/ai/generate-plan', got: { prompt: 'swap once' } },
    });
    await controller.stop();
  });

  it('throws on a 5xx poll so the loop backs off (A5)', async () => {
    const relay = new FakeRelay();
    const { controller } = makeController(relay);
    await controller.start();
    relay.forcePollStatus = 503;
    await expect(controller.pollOnce()).rejects.toThrow(/poll_status_503/);
    await controller.stop();
  });

  it('tears down on a 401 poll — a dead session must not spin forever (C6)', async () => {
    const relay = new FakeRelay();
    const { controller } = makeController(relay);
    await startAndClaim(controller, relay);
    relay.forcePollStatus = 401;
    await controller.pollOnce();
    const state = controller.state();
    expect(state.active).toBe(false);
    expect(state.pairUuid).toBeNull();
    await controller.stop();
  });

  it('tears down + revokes an abandoned (never-claimed) pairing after the timeout (A2)', async () => {
    const relay = new FakeRelay();
    let clock = 0;
    const controller = new BridgePairingController({
      dispatch: vi.fn(async () => ({})),
      relayBaseUrl: 'https://relay.test',
      fetchImpl: relay.fetch,
      generateIds: () => FIXED_IDS,
      sleep: () => Promise.resolve(),
      now: () => clock,
    });
    await controller.start();
    await controller.pollOnce(); // no claim yet, within window → still active
    expect(controller.state().active).toBe(true);
    clock = 130_000; // past the 120s abandon window
    await controller.pollOnce();
    expect(controller.state().active).toBe(false);
    expect(controller.state().pairUuid).toBeNull();
    expect(relay.unpaired).toContain(FIXED_IDS.pairUuid); // session revoked, not left to leak
    await controller.stop();
  });
});
