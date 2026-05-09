import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { readSessionCookie } from './cookies.js';
import type { Clock, WalletSessionRecord, WorkflowStore } from './store.js';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreatedWalletSession {
  token: string;
  record: WalletSessionRecord;
}

export async function createWalletSession(input: {
  store: WorkflowStore;
  walletAddress: string;
  clock: Clock;
}): Promise<CreatedWalletSession> {
  const token = randomBytes(32).toString('base64url');
  const now = input.clock.now();
  await input.store.cleanupExpired(now.toISOString());
  const record: WalletSessionRecord = {
    tokenHash: hashSessionToken(token),
    walletAddress: input.walletAddress,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    lastSeenAt: now.toISOString(),
  };
  await input.store.createSession(record);
  return { token, record };
}

export async function sessionFromRequest(input: {
  req: IncomingMessage;
  store: WorkflowStore;
  clock: Clock;
}): Promise<WalletSessionRecord | undefined> {
  const token = readSessionCookie(input.req);
  if (!token) return undefined;
  const tokenHash = hashSessionToken(token);
  const now = input.clock.now();
  await input.store.cleanupExpired(now.toISOString());
  const session = await input.store.getSession(tokenHash);
  if (!session || session.revokedAt) return undefined;
  if (Date.parse(session.expiresAt) <= now.getTime()) {
    await input.store.deleteSession(tokenHash, now.toISOString());
    return undefined;
  }
  await input.store.touchSession(tokenHash, now.toISOString());
  return { ...session, lastSeenAt: now.toISOString() };
}

export async function deleteSessionFromRequest(input: {
  req: IncomingMessage;
  store: WorkflowStore;
  clock: Clock;
}): Promise<WalletSessionRecord | undefined> {
  const token = readSessionCookie(input.req);
  if (!token) return undefined;
  const tokenHash = hashSessionToken(token);
  const session = await input.store.getSession(tokenHash);
  await input.store.deleteSession(tokenHash, input.clock.now().toISOString());
  return session;
}

export function hashSessionToken(token: string): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) {
    return createHmac('sha256', secret).update(token).digest('base64url');
  }
  return createHash('sha256').update(token).digest('base64url');
}
