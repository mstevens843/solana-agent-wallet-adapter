import type { IncomingMessage } from 'node:http';

export const SESSION_COOKIE_NAME = 'agentic_session';

export interface SessionCookieOptions {
  maxAgeSeconds: number;
  expires: Date;
  secure: boolean;
}

export function readSessionCookie(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
}

export function serializeSessionCookie(value: string, options: SessionCookieOptions): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `Expires=${options.expires.toUTCString()}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

export function serializeClearSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function isSecureRequest(req: IncomingMessage): boolean {
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase();
  if (forwardedProto.split(',').map((part) => part.trim()).includes('https')) {
    return true;
  }
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName || rawValue.length === 0) continue;
    const value = rawValue.join('=');
    try {
      cookies[rawName] = decodeURIComponent(value);
    } catch {
      cookies[rawName] = value;
    }
  }
  return cookies;
}
