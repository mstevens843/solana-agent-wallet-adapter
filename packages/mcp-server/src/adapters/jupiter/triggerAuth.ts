import { ProtocolError, type Cluster } from '@solana-agent-wallet-adapter/core';

import type { AgentWalletConfig } from '../../config.js';
import { getJupiterTriggerPolicy } from '../../config.js';

import { jupiterApiHost, jupiterFetchJson } from './client.js';
import {
  JUPITER_TRIGGER_CHALLENGE_MAX_TTL_MS,
  JUPITER_TRIGGER_JWT_MAX_TTL_MS,
  JUPITER_TRIGGER_JWT_SAFETY_MS,
  type JupiterTriggerChallengeType,
} from './triggerConstants.js';

export interface TriggerJwtEntry {
  walletAddress: string;
  cluster: Cluster;
  apiHost: string;
  jwt: string;
  expiresAt: number;
}

export interface TriggerChallenge {
  walletAddress: string;
  challengeType: JupiterTriggerChallengeType;
  challenge: string;
  transaction?: string;
  expiresAt: number;
  apiHost: string;
}

export interface TriggerAuthStatus {
  authenticated: boolean;
  walletAddress: string;
  cluster: Cluster;
  apiHost: string;
  expiresAt?: string;
}

const jwtCache = new Map<string, TriggerJwtEntry>();

export function jwtCacheKey(walletAddress: string, cluster: Cluster, apiHost: string): string {
  return `${walletAddress}|${cluster}|${apiHost}`;
}

export function getCachedJwt(walletAddress: string, cluster: Cluster, apiHost: string): TriggerJwtEntry | undefined {
  const entry = jwtCache.get(jwtCacheKey(walletAddress, cluster, apiHost));
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    jwtCache.delete(jwtCacheKey(walletAddress, cluster, apiHost));
    return undefined;
  }
  return entry;
}

export function storeJwt(entry: TriggerJwtEntry): void {
  jwtCache.set(jwtCacheKey(entry.walletAddress, entry.cluster, entry.apiHost), entry);
}

export function clearJwt(walletAddress: string, cluster: Cluster, apiHost: string): void {
  jwtCache.delete(jwtCacheKey(walletAddress, cluster, apiHost));
}

export function resetTriggerAuthCache(): void {
  jwtCache.clear();
}

export function requireTriggerEnabled(config: AgentWalletConfig): void {
  const policy = getJupiterTriggerPolicy(config);
  if (!policy.enabled) {
    throw new ProtocolError(
      'unsupported_method',
      'Jupiter Trigger is disabled. Set connectors.jupiter.trigger.enabled=true or CONNECTORS_JUPITER_TRIGGER_ENABLED=true to opt in.',
    );
  }
}

export function requireValidJwt(
  walletAddress: string,
  config: AgentWalletConfig,
): TriggerJwtEntry {
  const apiHost = jupiterApiHost(config, 'trigger');
  const entry = getCachedJwt(walletAddress, config.cluster, apiHost);
  if (!entry) {
    throw new ProtocolError(
      'unauthorized',
      'Sign in to Jupiter Trigger first via solana_jupiter_trigger_auth_challenge then solana_jupiter_trigger_auth_verify.',
    );
  }
  if (entry.walletAddress !== walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Jupiter Trigger JWT belongs to ${entry.walletAddress}, not ${walletAddress}. Re-authenticate.`,
    );
  }
  return entry;
}

export interface RequestChallengeInput {
  walletAddress: string;
  challengeType: JupiterTriggerChallengeType;
}

export async function requestChallenge(
  config: AgentWalletConfig,
  input: RequestChallengeInput,
): Promise<TriggerChallenge> {
  const body = await jupiterFetchJson(config, 'trigger', '/auth/challenge', {
    method: 'POST',
    body: {
      walletPubkey: input.walletAddress,
      type: input.challengeType,
    },
  });
  const transaction = readOptionalString(body, 'transaction');
  const challenge =
    readOptionalString(body, 'challenge') ??
    transaction ??
    (() => {
      throw new ProtocolError('wallet_unreachable', 'Jupiter Trigger auth challenge response is missing challenge or transaction.');
    })();
  const expiresAtRaw = body.expiresAt ?? body.expires_at ?? body.expires;
  const expiresAt = parseExpiresAt(expiresAtRaw, JUPITER_TRIGGER_CHALLENGE_MAX_TTL_MS);
  return {
    walletAddress: input.walletAddress,
    challengeType: input.challengeType,
    challenge,
    ...(transaction !== undefined && { transaction }),
    expiresAt,
    apiHost: jupiterApiHost(config, 'trigger'),
  };
}

export interface VerifyChallengeInput {
  walletAddress: string;
  challengeType: JupiterTriggerChallengeType;
  signature?: string;
  signedTransaction?: string;
}

export async function verifyChallenge(
  config: AgentWalletConfig,
  input: VerifyChallengeInput,
): Promise<TriggerAuthStatus> {
  if (input.challengeType === 'message' && !input.signature) {
    throw new ProtocolError('invalid_request', 'Message challenge requires a signature.');
  }
  if (input.challengeType === 'transaction' && !input.signedTransaction) {
    throw new ProtocolError('invalid_request', 'Transaction challenge requires a signedTransaction.');
  }
  const requestBody: Record<string, unknown> = {
    walletPubkey: input.walletAddress,
    type: input.challengeType,
  };
  if (input.signature) requestBody.signature = input.signature;
  if (input.signedTransaction) requestBody.signedTransaction = input.signedTransaction;
  const body = await jupiterFetchJson(config, 'trigger', '/auth/verify', {
    method: 'POST',
    body: requestBody,
  });
  const jwt =
    readOptionalString(body, 'token') ??
    readOptionalString(body, 'jwt') ??
    (() => {
      throw new ProtocolError('wallet_unreachable', 'Jupiter Trigger auth verify response is missing token.');
    })();
  const expiresAtRaw = body.expiresAt ?? body.expires_at ?? body.expires;
  const apiHost = jupiterApiHost(config, 'trigger');
  const officialExpiresAt = parseExpiresAt(expiresAtRaw, JUPITER_TRIGGER_JWT_MAX_TTL_MS + JUPITER_TRIGGER_JWT_SAFETY_MS);
  const clampedExpiresAt = Math.min(officialExpiresAt - JUPITER_TRIGGER_JWT_SAFETY_MS, Date.now() + JUPITER_TRIGGER_JWT_MAX_TTL_MS);
  storeJwt({
    walletAddress: input.walletAddress,
    cluster: config.cluster,
    apiHost,
    jwt,
    expiresAt: clampedExpiresAt,
  });
  return {
    authenticated: true,
    walletAddress: input.walletAddress,
    cluster: config.cluster,
    apiHost,
    expiresAt: new Date(clampedExpiresAt).toISOString(),
  };
}

export function readAuthStatus(walletAddress: string, config: AgentWalletConfig): TriggerAuthStatus {
  const apiHost = jupiterApiHost(config, 'trigger');
  const entry = getCachedJwt(walletAddress, config.cluster, apiHost);
  if (!entry) {
    return { authenticated: false, walletAddress, cluster: config.cluster, apiHost };
  }
  return {
    authenticated: true,
    walletAddress,
    cluster: config.cluster,
    apiHost,
    expiresAt: new Date(entry.expiresAt).toISOString(),
  };
}

function parseExpiresAt(raw: unknown, fallbackTtlMs: number): number {
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  return Date.now() + fallbackTtlMs;
}

function readOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
