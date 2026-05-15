import { WorkflowValidationError } from './index.js';
import type { JsonObject, JsonValue } from './index.js';

export const DEVICE_AGENT_RUNTIME_STATES = ['unavailable', 'stopped', 'starting', 'running', 'error'] as const;
export type DeviceAgentRuntimeState = (typeof DEVICE_AGENT_RUNTIME_STATES)[number];

export const DEVICE_AGENT_RUNTIME_KINDS = ['android-native', 'render-gated', 'browser-dev'] as const;
export type DeviceAgentRuntimeKind = (typeof DEVICE_AGENT_RUNTIME_KINDS)[number];

export const DEVICE_AGENT_METHODS = [
  'status',
  'configure',
  'start',
  'stop',
  'generatePlan',
  'reviewPlan',
  'ask',
] as const;
export type DeviceAgentMethod = (typeof DEVICE_AGENT_METHODS)[number];

export interface DeviceAgentError {
  code: string;
  message: string;
  subcode?: string;
  details?: JsonObject;
}

export interface DeviceAgentStatus {
  available: boolean;
  enabled: boolean;
  configured: boolean;
  state: DeviceAgentRuntimeState;
  runtime: DeviceAgentRuntimeKind;
  provider?: string;
  apiFormat?: string;
  baseUrl?: string;
  model?: string;
  walletAddress?: string;
  message?: string;
  checkedAt?: string;
  updatedAt?: string;
  lastError?: DeviceAgentError | null;
}

export interface DeviceAgentConfig {
  provider: string;
  apiFormat: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  walletAddress?: string;
}

export interface DeviceAgentRequestEnvelope {
  requestId: string;
  method: DeviceAgentMethod;
  payload?: JsonObject;
}

export interface DeviceAgentSuccessEnvelope {
  ok: true;
  status: DeviceAgentStatus;
  result?: JsonValue;
}

export interface DeviceAgentErrorEnvelope {
  ok: false;
  status: DeviceAgentStatus;
  error: DeviceAgentError;
}

export type DeviceAgentResponseEnvelope = DeviceAgentSuccessEnvelope | DeviceAgentErrorEnvelope;

export function parseDeviceAgentStatus(input: unknown, path = '$'): DeviceAgentStatus {
  const record = requireRecord(input, path);
  return {
    available: requireBoolean(record.available, `${path}.available`),
    enabled: requireBoolean(record.enabled, `${path}.enabled`),
    configured: requireBoolean(record.configured, `${path}.configured`),
    state: requireEnum(record.state, DEVICE_AGENT_RUNTIME_STATES, `${path}.state`),
    runtime: requireEnum(record.runtime, DEVICE_AGENT_RUNTIME_KINDS, `${path}.runtime`),
    ...optionalString(record, 'provider', path),
    ...optionalString(record, 'apiFormat', path),
    ...optionalString(record, 'baseUrl', path),
    ...optionalString(record, 'model', path),
    ...optionalString(record, 'walletAddress', path),
    ...optionalString(record, 'message', path),
    ...optionalString(record, 'checkedAt', path),
    ...optionalString(record, 'updatedAt', path),
    ...optionalLastError(record, path),
  };
}

export function parseDeviceAgentConfig(input: unknown, path = '$'): DeviceAgentConfig {
  const record = requireRecord(input, path);
  return {
    provider: requireNonEmptyString(record.provider, `${path}.provider`),
    apiFormat: requireNonEmptyString(record.apiFormat, `${path}.apiFormat`),
    model: requireNonEmptyString(record.model, `${path}.model`),
    ...optionalTrimmedString(record, 'baseUrl', path),
    ...optionalString(record, 'apiKey', path),
    ...optionalTrimmedString(record, 'walletAddress', path),
  };
}

export function parseDeviceAgentRequestEnvelope(input: unknown, path = '$'): DeviceAgentRequestEnvelope {
  const record = requireRecord(input, path);
  return {
    requestId: requireNonEmptyString(record.requestId, `${path}.requestId`),
    method: requireEnum(record.method, DEVICE_AGENT_METHODS, `${path}.method`),
    ...optionalJsonObject(record, 'payload', path),
  };
}

export function parseDeviceAgentResponseEnvelope(input: unknown, path = '$'): DeviceAgentResponseEnvelope {
  const record = requireRecord(input, path);
  const ok = requireBoolean(record.ok, `${path}.ok`);
  const status = parseDeviceAgentStatus(record.status, `${path}.status`);
  if (ok) {
    return {
      ok,
      status,
      ...optionalJsonValue(record, 'result', path),
    };
  }
  return {
    ok,
    status,
    error: parseDeviceAgentError(record.error, `${path}.error`),
  };
}

export function parseDeviceAgentError(input: unknown, path = '$'): DeviceAgentError {
  const record = requireRecord(input, path);
  return {
    code: requireNonEmptyString(record.code, `${path}.code`),
    message: requireNonEmptyString(record.message, `${path}.message`),
    ...optionalTrimmedString(record, 'subcode', path),
    ...optionalJsonObject(record, 'details', path),
  };
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new WorkflowValidationError('invalid_object', 'Expected a JSON object.', path);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new WorkflowValidationError('invalid_boolean', 'Expected a boolean.', path);
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowValidationError('invalid_string', 'Expected a non-empty string.', path);
  }
  return value.trim();
}

function requireEnum<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value as T[number])) {
    throw new WorkflowValidationError('invalid_enum', `Expected one of: ${values.join(', ')}.`, path);
  }
  return value as T[number];
}

function optionalString<T extends string>(
  record: Record<string, unknown>,
  key: T,
  path: string,
): Partial<Record<T, string>> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', 'Expected a string.', `${path}.${key}`);
  }
  return { [key]: value } as Partial<Record<T, string>>;
}

function optionalTrimmedString<T extends string>(
  record: Record<string, unknown>,
  key: T,
  path: string,
): Partial<Record<T, string>> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', 'Expected a string.', `${path}.${key}`);
  }
  const trimmed = value.trim();
  return trimmed ? { [key]: trimmed } as Partial<Record<T, string>> : {};
}

function optionalJsonObject<T extends string>(
  record: Record<string, unknown>,
  key: T,
  path: string,
): Partial<Record<T, JsonObject>> {
  const value = record[key];
  if (value === undefined) return {};
  return { [key]: parseJsonObject(value, `${path}.${key}`) } as Partial<Record<T, JsonObject>>;
}

function optionalJsonValue<T extends string>(
  record: Record<string, unknown>,
  key: T,
  path: string,
): Partial<Record<T, JsonValue>> {
  const value = record[key];
  if (value === undefined) return {};
  return { [key]: parseJsonValue(value, `${path}.${key}`) } as Partial<Record<T, JsonValue>>;
}

function optionalLastError(record: Record<string, unknown>, path: string): Partial<Pick<DeviceAgentStatus, 'lastError'>> {
  const value = record.lastError;
  if (value === undefined) return {};
  if (value === null) return { lastError: null };
  return { lastError: parseDeviceAgentError(value, `${path}.lastError`) };
}

function parseJsonObject(value: unknown, path: string): JsonObject {
  const record = requireRecord(value, path);
  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(record)) {
    output[key] = parseJsonValue(entry, `${path}.${key}`);
  }
  return output;
}

function parseJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WorkflowValidationError('invalid_json', 'Expected a finite JSON number.', path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => parseJsonValue(entry, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    return parseJsonObject(value, path);
  }
  throw new WorkflowValidationError('invalid_json', 'Expected a JSON value.', path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
