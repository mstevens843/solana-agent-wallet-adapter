import { randomUUID } from 'node:crypto';

export type TracePayload = Record<string, unknown>;

const SECRET_QUERY_KEYS = new Set(['api-key', 'apikey', 'key', 'token']);

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
  if (!value.includes('://')) {
    return value;
  }
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.toString();
  } catch {
    return value.replace(/([?&](?:api-key|apikey|key|token)=)[^&\s]+/gi, '$1[redacted]');
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
