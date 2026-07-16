import { createSign } from 'node:crypto';

import type { JsonObject } from '@solana-agent-wallet-adapter/workflow';

import type { PushDeviceRecord, PushDeliveryRecord } from './pushTypes.js';

/**
 * FCM (Android) + APNs (iOS) delivery.
 *
 * Both transports are OPTIONAL: with their credentials unset the sender reports `unconfigured` and
 * the caller leaves the delivery pending rather than burning its retry budget. That keeps the whole
 * push stack inert until an operator provisions keys — the code can ship before the Apple key exists.
 *
 * The important contract is `outcome`:
 *  - 'sent'         → done.
 *  - 'invalid-token'→ the token is permanently dead (APNs 410 Gone / BadDeviceToken, FCM UNREGISTERED).
 *                     The device row gets disabled; retrying can never succeed.
 *  - 'retry'        → transient (5xx, network, throttle). Backoff applies.
 *  - 'unconfigured' → no creds for this platform.
 */
export type PushSendOutcome = 'sent' | 'invalid-token' | 'retry' | 'unconfigured';

export interface PushSendResult {
  outcome: PushSendOutcome;
  detail?: string;
}

export interface PushSender {
  send(device: PushDeviceRecord, delivery: PushDeliveryRecord): Promise<PushSendResult>;
}

export interface CreatePushSenderOptions {
  fetchFn?: typeof fetch;
  clock?: () => Date;
  env?: NodeJS.ProcessEnv;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_TIMEOUT_MS = 10_000;
// Google/Apple access tokens last an hour; refresh a minute early so a long cron tick can't straddle
// the expiry and fail mid-batch.
const TOKEN_SKEW_MS = 60_000;

export function createPushSender(options: CreatePushSenderOptions = {}): PushSender {
  const fetchFn = options.fetchFn ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const env = options.env ?? process.env;
  const fcm = new FcmTransport(fetchFn, clock, env);
  const apns = new ApnsTransport(fetchFn, clock, env);
  return {
    async send(device, delivery) {
      return device.platform === 'ios' ? apns.send(device, delivery) : fcm.send(device, delivery);
    },
  };
}

// ---------------------------------------------------------------------------- FCM (HTTP v1)

interface FcmServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

class FcmTransport {
  private accessToken?: { value: string; expiresAtMs: number };

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly clock: () => Date,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  private serviceAccount(): FcmServiceAccount | undefined {
    const raw = this.env.FCM_SERVICE_ACCOUNT_JSON?.trim();
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<FcmServiceAccount>;
      if (!parsed.client_email || !parsed.private_key || !parsed.project_id) return undefined;
      return parsed as FcmServiceAccount;
    } catch {
      return undefined;
    }
  }

  async send(device: PushDeviceRecord, delivery: PushDeliveryRecord): Promise<PushSendResult> {
    const account = this.serviceAccount();
    if (!account) return { outcome: 'unconfigured', detail: 'FCM_SERVICE_ACCOUNT_JSON is not set.' };

    let token: string;
    try {
      token = await this.authorize(account);
    } catch (err) {
      return { outcome: 'retry', detail: errorMessage(err, 'FCM auth failed.') };
    }

    const body = JSON.stringify({
      message: {
        token: device.token,
        notification: { title: delivery.title, body: delivery.body },
        data: stringifyData({ ...delivery.data, type: delivery.type, dedupeKey: delivery.dedupeKey }),
        android: {
          priority: 'high',
          notification: {
            // Collapse repeats of the same event onto one shade entry rather than stacking.
            tag: `${delivery.type}:${delivery.dedupeKey}`,
            channel_id: 'agentic.alerts',
          },
        },
      },
    });

    try {
      const response = await this.fetchFn(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body,
          signal: timeoutSignal(SEND_TIMEOUT_MS),
        },
      );
      if (response.ok) return { outcome: 'sent' };
      const detail = await safeText(response);
      // UNREGISTERED / INVALID_ARGUMENT on the token mean the install is gone — reap, never retry.
      if (response.status === 404 || /UNREGISTERED|NOT_FOUND/i.test(detail)) {
        return { outcome: 'invalid-token', detail: `FCM ${response.status}: ${detail}` };
      }
      if (response.status === 400 && /registration token|InvalidRegistration/i.test(detail)) {
        return { outcome: 'invalid-token', detail: `FCM 400: ${detail}` };
      }
      // 401/403 usually mean bad creds, not a bad device — retry so a fixed key self-heals.
      return { outcome: 'retry', detail: `FCM ${response.status}: ${detail}` };
    } catch (err) {
      return { outcome: 'retry', detail: errorMessage(err, 'FCM request failed.') };
    }
  }

  private async authorize(account: FcmServiceAccount): Promise<string> {
    const nowMs = this.clock().getTime();
    if (this.accessToken && this.accessToken.expiresAtMs - TOKEN_SKEW_MS > nowMs) return this.accessToken.value;

    const iat = Math.floor(nowMs / 1000);
    const assertion = signJwtRs256(
      { alg: 'RS256', typ: 'JWT' },
      { iss: account.client_email, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 },
      account.private_key,
    );
    const response = await this.fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: timeoutSignal(SEND_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Google token endpoint returned HTTP ${response.status}.`);
    const parsed = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new Error('Google token endpoint returned no access_token.');
    this.accessToken = {
      value: parsed.access_token,
      expiresAtMs: nowMs + (parsed.expires_in ?? 3600) * 1000,
    };
    return parsed.access_token;
  }
}

// ---------------------------------------------------------------------------- APNs (HTTP/2 via fetch)

class ApnsTransport {
  private providerToken?: { value: string; issuedAtMs: number };

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly clock: () => Date,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async send(device: PushDeviceRecord, delivery: PushDeliveryRecord): Promise<PushSendResult> {
    const keyP8 = this.env.APNS_KEY_P8?.trim();
    const keyId = this.env.APNS_KEY_ID?.trim();
    const teamId = this.env.APNS_TEAM_ID?.trim();
    const bundleId = this.env.APNS_BUNDLE_ID?.trim();
    if (!keyP8 || !keyId || !teamId || !bundleId) {
      return { outcome: 'unconfigured', detail: 'APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID/APNS_BUNDLE_ID are not all set.' };
    }

    let jwt: string;
    try {
      jwt = this.authorize(keyP8, keyId, teamId);
    } catch (err) {
      return { outcome: 'retry', detail: errorMessage(err, 'APNs auth failed.') };
    }

    const host = this.env.APNS_ENV?.trim() === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
    const body = JSON.stringify({
      aps: {
        alert: { title: delivery.title, body: delivery.body },
        sound: 'default',
        'thread-id': delivery.type,
      },
      ...delivery.data,
      type: delivery.type,
      dedupeKey: delivery.dedupeKey,
    });

    try {
      const response = await this.fetchFn(`https://${host}/3/device/${encodeURIComponent(device.token)}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          // Same event twice → APNs replaces the existing banner instead of stacking.
          'apns-collapse-id': collapseId(`${delivery.type}:${delivery.dedupeKey}`),
          'content-type': 'application/json',
        },
        body,
        signal: timeoutSignal(SEND_TIMEOUT_MS),
      });
      if (response.ok) return { outcome: 'sent' };
      const detail = await safeText(response);
      // 410 Gone is APNs' explicit "this token is dead"; BadDeviceToken is the 400 flavour.
      if (response.status === 410 || /BadDeviceToken|Unregistered/i.test(detail)) {
        return { outcome: 'invalid-token', detail: `APNs ${response.status}: ${detail}` };
      }
      return { outcome: 'retry', detail: `APNs ${response.status}: ${detail}` };
    } catch (err) {
      return { outcome: 'retry', detail: errorMessage(err, 'APNs request failed.') };
    }
  }

  private authorize(keyP8: string, keyId: string, teamId: string): string {
    const nowMs = this.clock().getTime();
    // Apple rejects provider tokens older than 1h and throttles refreshes under ~20min; 45min sits
    // safely inside both.
    if (this.providerToken && nowMs - this.providerToken.issuedAtMs < 45 * 60_000) return this.providerToken.value;
    const iat = Math.floor(nowMs / 1000);
    const value = signJwtEs256({ alg: 'ES256', kid: keyId }, { iss: teamId, iat }, normalizePem(keyP8));
    this.providerToken = { value, issuedAtMs: nowMs };
    return value;
  }
}

// ---------------------------------------------------------------------------- helpers

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signJwtRs256(header: JsonObject, payload: JsonObject, privateKey: string): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(normalizePem(privateKey)).toString('base64url')}`;
}

function signJwtEs256(header: JsonObject, payload: JsonObject, privateKey: string): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  // APNs requires the raw 64-byte r||s pair, NOT the DER envelope Node emits by default.
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** Render env vars collapse real newlines to `\n`; PEM parsers need them back. */
function normalizePem(key: string): string {
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
}

/** FCM data values must all be strings. */
function stringifyData(data: JsonObject): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}

/** apns-collapse-id is capped at 64 bytes. */
function collapseId(value: string): string {
  return Buffer.byteLength(value) <= 64 ? value : Buffer.from(value).subarray(0, 64).toString();
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined') return undefined;
  const maybeTimeout = AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal };
  if (typeof maybeTimeout.timeout === 'function') return maybeTimeout.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}
