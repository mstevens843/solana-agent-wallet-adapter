import { WorkflowValidationError, type JsonObject } from '../index.js';
import type { SkillCaps } from './skills.js';

export type SignalFeedStatus = 'active' | 'paused' | 'archived';

export interface SignalFeedRecord {
  id: string;
  publisherWallet: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  status: SignalFeedStatus;
  metadata?: JsonObject;
}

export interface SignalEmissionRecord {
  id: string;
  feedId: string;
  publisherWallet: string;
  emittedAt: string;
  sourceTxid: string;
  actionTemplate: JsonObject;
  delivered: number;
  fanoutProcessedAt?: string;
  metadata?: JsonObject;
}

export type SignalSubscriptionStatus = 'active' | 'paused' | 'revoked';

export interface SignalSubscriptionRecord {
  id: string;
  followerWallet: string;
  feedId: string;
  caps: SkillCaps;
  subscribedAt: string;
  updatedAt: string;
  status: SignalSubscriptionStatus;
  metadata?: JsonObject;
}

export interface CreateSignalSubscriptionRequest {
  feedId: string;
  caps: SkillCaps;
}

export interface CreateSignalEmissionRequest {
  feedId: string;
  sourceTxid: string;
  actionTemplate: JsonObject;
}

export function validateCreateSignalSubscriptionRequest(
  input: unknown,
  path = '$',
): CreateSignalSubscriptionRequest {
  const obj = requireObject(input, path);
  rejectForbiddenAuthorityKeys(obj, path);
  const feedId = requireNonEmptyString(obj.feedId, `${path}.feedId`, 'invalid_feed_id');
  const caps = validateSkillCaps(requireObject(obj.caps, `${path}.caps`), `${path}.caps`);
  return { feedId, caps };
}

export function validateCreateSignalEmissionRequest(
  input: unknown,
  path = '$',
): CreateSignalEmissionRequest {
  const obj = requireObject(input, path);
  rejectForbiddenAuthorityKeys(obj, path);
  const feedId = requireNonEmptyString(obj.feedId, `${path}.feedId`, 'invalid_feed_id');
  const sourceTxid = requireNonEmptyString(obj.sourceTxid, `${path}.sourceTxid`, 'invalid_source_txid');
  if (sourceTxid.length < 32) {
    throw new WorkflowValidationError(
      'invalid_source_txid',
      'sourceTxid must be at least 32 characters.',
      `${path}.sourceTxid`,
    );
  }
  const actionTemplate = requireObject(obj.actionTemplate, `${path}.actionTemplate`);
  rejectForbiddenAuthorityKeys(actionTemplate, `${path}.actionTemplate`);
  return { feedId, sourceTxid, actionTemplate };
}

function validateSkillCaps(raw: Record<string, unknown>, path: string): SkillCaps {
  rejectForbiddenAuthorityKeys(raw, path);
  const perRunMaxAmount = requireDecimalString(raw.perRunMaxAmount, `${path}.perRunMaxAmount`);
  const lifetimeMaxAmount = requireDecimalString(raw.lifetimeMaxAmount, `${path}.lifetimeMaxAmount`);
  const allowlistedTokens = requireStringArray(raw.allowlistedTokens, `${path}.allowlistedTokens`, true);
  const caps: SkillCaps = {
    perRunMaxAmount,
    lifetimeMaxAmount,
    allowlistedTokens,
  };

  if (raw.allowlistedRecipients !== undefined) {
    caps.allowlistedRecipients = requireStringArray(
      raw.allowlistedRecipients,
      `${path}.allowlistedRecipients`,
      false,
    );
  }

  if (raw.expiresAt !== undefined) {
    if (typeof raw.expiresAt !== 'string' || Number.isNaN(Date.parse(raw.expiresAt))) {
      throw new WorkflowValidationError(
        'invalid_caps',
        'caps.expiresAt must be an ISO-8601 timestamp.',
        `${path}.expiresAt`,
      );
    }
    caps.expiresAt = raw.expiresAt;
  }

  if (raw.maxExecutions !== undefined) {
    if (typeof raw.maxExecutions !== 'number' || !Number.isInteger(raw.maxExecutions) || raw.maxExecutions <= 0) {
      throw new WorkflowValidationError(
        'invalid_caps',
        'caps.maxExecutions must be a positive integer.',
        `${path}.maxExecutions`,
      );
    }
    caps.maxExecutions = raw.maxExecutions;
  }

  return caps;
}

const FORBIDDEN_AUTHORITY_KEYS = new Set(['delegatedSigner', 'privateKey', 'seedPhrase', 'approvalAuthority']);

function requireObject(input: unknown, path: string): JsonObject {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkflowValidationError('invalid_object', `${path} must be a JSON object.`, path);
  }
  return input as JsonObject;
}

function requireNonEmptyString(input: unknown, path: string, code = 'invalid_string'): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new WorkflowValidationError(code, `${path} must be a non-empty string.`, path);
  }
  return input.trim();
}

function requireDecimalString(input: unknown, path: string): string {
  const value = requireNonEmptyString(input, path, 'invalid_caps');
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) {
    throw new WorkflowValidationError('invalid_caps', `${path} must be a decimal string.`, path);
  }
  return value;
}

function requireStringArray(input: unknown, path: string, requireNonEmpty: boolean): string[] {
  if (!Array.isArray(input) || (requireNonEmpty && input.length === 0)) {
    throw new WorkflowValidationError('invalid_caps', `${path} must be an array of strings.`, path);
  }
  return input.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new WorkflowValidationError(
        'invalid_caps',
        `${path}[${index}] must be a non-empty string.`,
        `${path}[${index}]`,
      );
    }
    return entry.trim();
  });
}

function rejectForbiddenAuthorityKeys(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectForbiddenAuthorityKeys(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(key)) {
      throw new WorkflowValidationError(
        'forbidden_authority_field',
        `Field "${key}" is not permitted on signal payloads.`,
        `${path}.${key}`,
      );
    }
    if (key === 'authority' && entry === 'unlimited') {
      throw new WorkflowValidationError(
        'forbidden_authority_field',
        'authority "unlimited" is not permitted.',
        `${path}.${key}`,
      );
    }
    rejectForbiddenAuthorityKeys(entry, `${path}.${key}`);
  }
}
