import { chmod, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { GlobalOptions } from '../shared/types.js';
import { errorMessage, isRecord } from '../shared/util.js';

export interface CliSession {
  /** Bearer token returned by /api/auth/verify-wallet when `x-agentic-bearer: 1` is sent. */
  token: string;
  walletAddress: string;
  /** ISO8601 timestamp; undefined treated as "never expires" (server has its own TTL). */
  expiresAt?: string;
  /** Origin the token was issued for; used to invalidate when --render-web-url changes. */
  renderWebOrigin: string;
  /** ISO8601 timestamp the token was minted. */
  issuedAt: string;
}

const SESSION_FILE_NAME = 'session.json';
const EXPIRY_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

function sessionPath(options: GlobalOptions): string {
  return join(options.runtimeDir, SESSION_FILE_NAME);
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

export async function loadSession(options: GlobalOptions): Promise<CliSession | null> {
  // Honor an explicit env-var override for CI and headless contexts.
  const envToken = process.env.AGENTIC_SESSION_TOKEN ?? process.env.AGENTIC_BEARER_TOKEN;
  if (envToken) {
    return {
      token: envToken,
      walletAddress: process.env.AGENTIC_SESSION_WALLET ?? '',
      renderWebOrigin: normalizeOrigin(options.renderWebUrl),
      issuedAt: new Date().toISOString(),
    };
  }
  const path = sessionPath(options);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.token !== 'string' || !parsed.token) {
      return null;
    }
    const expected = normalizeOrigin(options.renderWebUrl);
    const stored = typeof parsed.renderWebOrigin === 'string' ? normalizeOrigin(parsed.renderWebOrigin) : '';
    if (stored && stored !== expected) {
      // Token belongs to a different deployment. Surface a stderr hint so the
      // user knows why their cached session was ignored — silent rejection
      // looks like a broken login flow.
      if (!options.json) {
        console.error(`[agentic-cli] Ignoring cached session at ${path}: stored origin ${stored} does not match --render-web-url ${expected}. Run \`auth login\` to mint a fresh token for this origin.`);
      }
      return null;
    }
    return {
      token: parsed.token,
      walletAddress: typeof parsed.walletAddress === 'string' ? parsed.walletAddress : '',
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : undefined,
      renderWebOrigin: stored || expected,
      issuedAt: typeof parsed.issuedAt === 'string' ? parsed.issuedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function loadBearerToken(options: GlobalOptions): Promise<string | null> {
  const session = await loadSession(options);
  if (!session) return null;
  if (sessionExpired(session)) return null;
  return session.token;
}

export function sessionExpired(session: CliSession): boolean {
  if (!session.expiresAt) return false;
  const ts = Date.parse(session.expiresAt);
  if (!Number.isFinite(ts)) return false;
  return ts <= Date.now();
}

export function sessionStaleSoon(session: CliSession): boolean {
  if (!session.expiresAt) return false;
  const ts = Date.parse(session.expiresAt);
  if (!Number.isFinite(ts)) return false;
  return ts - Date.now() < EXPIRY_REFRESH_THRESHOLD_MS;
}

export async function saveSession(options: GlobalOptions, session: CliSession): Promise<void> {
  const path = sessionPath(options);
  await mkdir(dirname(path), { recursive: true });
  const payload: CliSession = {
    ...session,
    renderWebOrigin: normalizeOrigin(session.renderWebOrigin || options.renderWebUrl),
    issuedAt: session.issuedAt || new Date().toISOString(),
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    // Best-effort permission tightening; Windows ignores silently.
    await chmod(path, 0o600);
  } catch (err) {
    // Ignore — Windows or filesystem that doesn't support chmod.
    void errorMessage(err);
  }
}

export async function clearSession(options: GlobalOptions): Promise<boolean> {
  const path = sessionPath(options);
  if (!existsSync(path)) {
    return false;
  }
  await unlink(path);
  return true;
}

export function sessionStatusSummary(session: CliSession | null): {
  authenticated: boolean;
  walletAddress: string | null;
  expiresAt: string | null;
  staleSoon: boolean;
  renderWebOrigin: string | null;
} {
  if (!session) {
    return {
      authenticated: false,
      walletAddress: null,
      expiresAt: null,
      staleSoon: false,
      renderWebOrigin: null,
    };
  }
  return {
    authenticated: !sessionExpired(session),
    walletAddress: session.walletAddress || null,
    expiresAt: session.expiresAt ?? null,
    staleSoon: sessionStaleSoon(session),
    renderWebOrigin: session.renderWebOrigin ?? null,
  };
}
