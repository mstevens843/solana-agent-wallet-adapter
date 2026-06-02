import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class WebhookSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSecurityError';
  }
}

export function assertWebhookUrlAllowed(rawUrl: string, env: NodeJS.ProcessEnv = process.env): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookSecurityError('Webhook URL must be a valid URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebhookSecurityError('Webhook URL must use http or https.');
  }
  if (isProductionRuntime(env) && url.protocol !== 'https:') {
    throw new WebhookSecurityError('Webhook URL must use https in production.');
  }
  if (url.username || url.password) {
    throw new WebhookSecurityError('Webhook URL must not include credentials.');
  }
  if (isBlockedHostname(url.hostname)) {
    throw new WebhookSecurityError('Webhook URL cannot target local, private, or metadata network addresses.');
  }

  return url;
}

export async function assertWebhookDestinationAllowed(rawUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const url = assertWebhookUrlAllowed(rawUrl, env);
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new WebhookSecurityError('Webhook URL cannot target local, private, or metadata network addresses.');
    }
    return;
  }

  const resolved = await lookup(host, { all: true, verbatim: true });
  if (resolved.some((entry) => isBlockedIp(entry.address))) {
    throw new WebhookSecurityError('Webhook destination resolves to a local, private, or metadata network address.');
  }
}

function isProductionRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production' || env.RENDER === 'true';
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) return true;
  return isIP(host) ? isBlockedIp(host) : false;
}

function isBlockedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 ||
    a === 100 && b >= 64 && b <= 127 ||
    a >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('ff')
  ) {
    return true;
  }
  // Unwrap IPv4-mapped (::ffff:a.b.c.d or ::ffff:wwww:xxxx) and IPv4-compatible
  // (::a.b.c.d) addresses and evaluate the embedded IPv4 through the v4 blocklist.
  // Without this, http://[::ffff:169.254.169.254]/ (cloud metadata), ::ffff:127.0.0.1
  // (loopback), and private ranges slip past the prefix checks above. isIP() treats
  // these as family 6, so they route here.
  const embeddedIpv4 = extractEmbeddedIpv4(normalized);
  if (embeddedIpv4) {
    return isBlockedIpv4(embeddedIpv4);
  }
  return false;
}

function extractEmbeddedIpv4(normalized: string): string | null {
  const dotted = normalized.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1]!;
  const hexMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1]!, 16);
    const lo = Number.parseInt(hexMapped[2]!, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}
