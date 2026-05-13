import { randomUUID } from 'node:crypto';

export type TracePayload = Record<string, unknown>;

const SECRET_QUERY_KEYS = new Set(['api-key', 'apikey', 'x-api-key', 'key', 'token']);

export function newTraceId(prefix = 'trace'): string {
  return `${prefix}_${randomUUID()}`;
}

export function trace(event: string, payload: TracePayload = {}): void {
  if (process.env.AGENT_WALLET_TRACE !== '1') {
    return;
  }
  const redacted = redactSecrets(payload) as TracePayload;
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...redacted,
  };
  console.error(JSON.stringify(entry));
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSecretKey(key) ? '[redacted]' : redactSecrets(entry),
      ]),
    );
  }
  return value;
}

function redactString(value: string): string {
  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-proj-[A-Za-z0-9_-]{8,}\b/g, 'sk-proj-[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]');
  if (!redacted.includes('://')) {
    return redacted;
  }
  try {
    const url = new URL(redacted);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.toString();
  } catch {
    return redacted.replace(/([?&](?:api-key|apikey|key|token)=)[^&\s]+/gi, '$1[redacted]');
  }
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes('private') ||
    normalized.includes('secret') ||
    normalized.includes('apikey') ||
    normalized.includes('api_key') ||
    normalized === 'api-key' ||
    normalized === 'token'
  );
}
