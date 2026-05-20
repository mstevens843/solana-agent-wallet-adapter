import { WorkflowValidationError, type JsonObject } from '../index.js';

export type SkillCategory = 'dca' | 'yield' | 'stops' | 'bridge' | 'donation' | 'custom';

export type SkillScheduleKind = 'cron' | 'interval' | 'price-trigger';

export interface SkillSchedule {
  kind: SkillScheduleKind;
  spec: string;
}

export interface SkillActionTemplate {
  connectorAction: string;
  paramsTemplate: JsonObject;
}

export interface SkillCaps {
  perRunMaxAmount: string;
  lifetimeMaxAmount: string;
  allowlistedTokens: string[];
  allowlistedRecipients?: string[];
  expiresAt?: string;
  maxExecutions?: number;
}

export type SkillMonetizationKind = 'one-time' | 'monthly' | 'performance-fee';

/**
 * Currency the author chooses to be paid in. Defaults to USDC (the historical
 * monetization currency) when omitted. SKR is supported only on deployments
 * that have configured Solana Mobile Seeker support; the cloud install handler
 * resolves decimals from the SKR_TOKEN_DECIMALS env var when this is 'SKR'.
 */
export type SkillMonetizationToken = 'USDC' | 'SKR';

export interface SkillMonetization {
  kind: SkillMonetizationKind;
  amount?: string;
  feePercent?: number;
  payoutWallet: string;
  token?: SkillMonetizationToken;
}

export interface SkillDependency {
  skillId: string;
  version: string;
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  authorWallet: string;
  description: string;
  category: SkillCategory;
  schedule: SkillSchedule;
  action: SkillActionTemplate;
  caps: SkillCaps;
  monetization?: SkillMonetization;
  dependencies?: SkillDependency[];
}

export type SkillInstallStatus = 'active' | 'paused' | 'expired' | 'revoked';

export interface SkillInstallRecord {
  id: string;
  walletAddress: string;
  skillId: string;
  manifestVersion: string;
  caps: SkillCaps;
  installedAt: string;
  updatedAt: string;
  status: SkillInstallStatus;
  monetizationScheduleId?: string;
  metadata?: JsonObject;
}

export type SkillExecutionResult = 'pending' | 'success' | 'failed' | 'rejected';

export interface SkillExecutionRecord {
  id: string;
  installId: string;
  walletAddress: string;
  skillId: string;
  proposedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  approvalRequestId?: string;
  evidenceReceiptId?: string;
  txid?: string;
  result?: SkillExecutionResult;
  metadata?: JsonObject;
}

export interface SkillManifestRecord {
  id: string;
  version: string;
  authorWallet: string;
  createdAt: string;
  updatedAt: string;
  manifest: SkillManifest;
}

export interface InstallSkillRequest {
  skillId: string;
  manifestVersion: string;
  caps: SkillCaps;
  acceptMonetization: boolean;
  installParams?: JsonObject;
}

const SKILL_CATEGORIES = ['dca', 'yield', 'stops', 'bridge', 'donation', 'custom'] as const;
const SCHEDULE_KINDS = ['cron', 'interval', 'price-trigger'] as const;
const MONETIZATION_KINDS = ['one-time', 'monthly', 'performance-fee'] as const;
const MONETIZATION_TOKENS = ['USDC', 'SKR'] as const;
const FORBIDDEN_SECRET_KEYS = new Set(['delegatedSigner', 'privateKey', 'seedPhrase']);

export function validateSkillManifest(input: unknown, path = '$'): SkillManifest {
  const record = requireObject(input, path);
  rejectForbiddenAuthorityFields(record, path);
  const category = requireEnum(requireString(record.category, `${path}.category`), SKILL_CATEGORIES, `${path}.category`);
  const schedule = validateSchedule(record.schedule, `${path}.schedule`);
  const action = validateAction(record.action, `${path}.action`);
  const caps = validateSkillCaps(record.caps, `${path}.caps`);

  const manifest: SkillManifest = {
    id: requireSkillId(record.id, `${path}.id`),
    name: requireString(record.name, `${path}.name`),
    version: requireString(record.version, `${path}.version`),
    authorWallet: requireString(record.authorWallet, `${path}.authorWallet`),
    description: requireString(record.description, `${path}.description`),
    category,
    schedule,
    action,
    caps,
  };

  if (record.monetization !== undefined) {
    manifest.monetization = validateMonetization(record.monetization, `${path}.monetization`);
  }
  if (record.dependencies !== undefined) {
    if (!Array.isArray(record.dependencies)) {
      throw invalid('invalid_dependencies', 'dependencies must be an array.', `${path}.dependencies`);
    }
    manifest.dependencies = record.dependencies.map((dependency, index) =>
      validateDependency(dependency, `${path}.dependencies[${index}]`));
  }
  return manifest;
}

export function validateInstallSkillRequest(input: unknown, path = '$'): InstallSkillRequest {
  const record = requireObject(input, path);
  rejectForbiddenAuthorityFields(record, path);
  if (typeof record.acceptMonetization !== 'boolean') {
    throw invalid('invalid_accept_monetization', 'acceptMonetization must be a boolean.', `${path}.acceptMonetization`);
  }
  const request: InstallSkillRequest = {
    skillId: requireSkillId(record.skillId, `${path}.skillId`),
    manifestVersion: requireString(record.manifestVersion, `${path}.manifestVersion`),
    caps: validateSkillCaps(record.caps, `${path}.caps`),
    acceptMonetization: record.acceptMonetization,
  };
  if (record.installParams !== undefined) {
    request.installParams = requireObject(record.installParams, `${path}.installParams`);
    rejectForbiddenAuthorityFields(request.installParams, `${path}.installParams`);
  }
  return request;
}

function validateSchedule(input: unknown, path: string): SkillSchedule {
  const record = requireObject(input, path);
  rejectForbiddenAuthorityFields(record, path);
  return {
    kind: requireEnum(requireString(record.kind, `${path}.kind`), SCHEDULE_KINDS, `${path}.kind`),
    spec: requireString(record.spec, `${path}.spec`),
  };
}

function validateAction(input: unknown, path: string): SkillActionTemplate {
  const record = requireObject(input, path);
  rejectForbiddenAuthorityFields(record, path);
  const paramsTemplate = requireObject(record.paramsTemplate, `${path}.paramsTemplate`);
  rejectForbiddenAuthorityFields(paramsTemplate, `${path}.paramsTemplate`);
  return {
    connectorAction: requireString(record.connectorAction, `${path}.connectorAction`),
    paramsTemplate,
  };
}

function validateSkillCaps(input: unknown, path: string): SkillCaps {
  const record = requireObject(input, path);
  rejectForbiddenAuthorityFields(record, path);
  const caps: SkillCaps = {
    perRunMaxAmount: requireDecimalString(record.perRunMaxAmount, `${path}.perRunMaxAmount`),
    lifetimeMaxAmount: requireDecimalString(record.lifetimeMaxAmount, `${path}.lifetimeMaxAmount`),
    allowlistedTokens: requireStringArray(record.allowlistedTokens, `${path}.allowlistedTokens`, true),
  };
  if (record.allowlistedRecipients !== undefined) {
    caps.allowlistedRecipients = requireStringArray(record.allowlistedRecipients, `${path}.allowlistedRecipients`, false);
  }
  if (record.expiresAt !== undefined) {
    const expiresAt = requireString(record.expiresAt, `${path}.expiresAt`);
    if (Number.isNaN(Date.parse(expiresAt))) {
      throw invalid('invalid_caps', 'caps.expiresAt must be an ISO-8601 timestamp.', `${path}.expiresAt`);
    }
    caps.expiresAt = expiresAt;
  }
  if (record.maxExecutions !== undefined) {
    if (typeof record.maxExecutions !== 'number' || !Number.isInteger(record.maxExecutions) || record.maxExecutions <= 0) {
      throw invalid('invalid_caps', 'caps.maxExecutions must be a positive integer.', `${path}.maxExecutions`);
    }
    caps.maxExecutions = record.maxExecutions;
  }
  return caps;
}

function validateMonetization(input: unknown, path: string): SkillMonetization {
  const record = requireObject(input, path);
  rejectForbiddenAuthorityFields(record, path);
  const kind = requireEnum(requireString(record.kind, `${path}.kind`), MONETIZATION_KINDS, `${path}.kind`);
  const monetization: SkillMonetization = {
    kind,
    payoutWallet: requireString(record.payoutWallet, `${path}.payoutWallet`),
  };
  if (kind === 'one-time' || kind === 'monthly') {
    monetization.amount = requireDecimalString(record.amount, `${path}.amount`);
  }
  if (kind === 'performance-fee') {
    if (typeof record.feePercent !== 'number' || !Number.isFinite(record.feePercent) || record.feePercent < 0 || record.feePercent > 100) {
      throw invalid('invalid_monetization', 'feePercent must be a number between 0 and 100.', `${path}.feePercent`);
    }
    monetization.feePercent = record.feePercent;
  }
  if (record.token !== undefined) {
    monetization.token = requireEnum(
      requireString(record.token, `${path}.token`),
      MONETIZATION_TOKENS,
      `${path}.token`,
    );
  }
  return monetization;
}

function validateDependency(input: unknown, path: string): SkillDependency {
  const record = requireObject(input, path);
  rejectForbiddenAuthorityFields(record, path);
  return {
    skillId: requireSkillId(record.skillId, `${path}.skillId`),
    version: requireString(record.version, `${path}.version`),
  };
}

function requireObject(input: unknown, path: string): JsonObject {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('invalid_object', `${path} must be a JSON object.`, path);
  }
  return input as JsonObject;
}

function requireString(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw invalid('invalid_string', `${path} must be a non-empty string.`, path);
  }
  return input.trim();
}

function requireSkillId(input: unknown, path: string): string {
  const value = requireString(input, path);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw invalid('invalid_skill_id', `${path} must be lowercase kebab-case, 1-64 chars.`, path);
  }
  return value;
}

function requireDecimalString(input: unknown, path: string): string {
  const value = requireString(input, path);
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw invalid('invalid_caps', `${path} must be a non-negative decimal string.`, path);
  }
  return value;
}

function requireStringArray(input: unknown, path: string, requireNonEmpty: boolean): string[] {
  if (!Array.isArray(input) || (requireNonEmpty && input.length === 0)) {
    throw invalid('invalid_caps', `${path} must be an array of strings.`, path);
  }
  return input.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw invalid('invalid_caps', `${path}[${index}] must be a non-empty string.`, `${path}[${index}]`);
    }
    return entry.trim();
  });
}

function requireEnum<const T extends readonly string[]>(value: string, allowed: T, path: string): T[number] {
  if (!allowed.includes(value)) {
    throw invalid('invalid_enum', `${path} must be one of: ${allowed.join(', ')}.`, path);
  }
  return value as T[number];
}

function rejectForbiddenAuthorityFields(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectForbiddenAuthorityFields(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEYS.has(key)) {
      throw invalid('forbidden_authority', `Field "${key}" is not permitted on skill payloads.`, `${path}.${key}`);
    }
    if (key === 'approvalAuthority' && typeof entry === 'string' && entry.trim().toLowerCase() === 'unlimited') {
      throw invalid('forbidden_authority', 'approvalAuthority "unlimited" is not permitted.', `${path}.${key}`);
    }
    rejectForbiddenAuthorityFields(entry, `${path}.${key}`);
  }
}

function invalid(code: string, message: string, path: string): WorkflowValidationError {
  return new WorkflowValidationError(code, message, path);
}
