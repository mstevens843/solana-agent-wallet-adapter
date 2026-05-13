import { ProtocolError } from '@solana-agent-wallet-adapter/core';

export interface BlinkActionParameter {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  pattern?: string;
  patternDescription?: string;
  min?: string | number;
  max?: string | number;
  options?: Array<{ label: string; value: string }>;
}

export interface BlinkLinkedAction {
  href: string;
  label: string;
  parameters?: BlinkActionParameter[];
}

export interface BlinkActionMetadata {
  url: string;
  title: string;
  description: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  error?: string;
  actions: BlinkLinkedAction[];
}

export interface BlinkPrepareInput {
  url: string;
  account: string;
  parameters?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface BlinkPreparedAction {
  actionUrl: string;
  title?: string;
  label?: string;
  transactionBase64: string;
  message?: string;
  raw: unknown;
}

export function normalizeBlinkUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ProtocolError('invalid_request', 'Blink/Solana Action URL is required.');
  }
  const withoutBlink = trimmed.startsWith('blink:') ? trimmed.slice('blink:'.length) : trimmed;
  const withoutAction = withoutBlink.startsWith('solana-action:')
    ? withoutBlink.slice('solana-action:'.length)
    : withoutBlink;
  let decoded = withoutAction;
  try {
    decoded = decodeURIComponent(withoutAction);
  } catch {
    decoded = withoutAction;
  }
  const parsed = new URL(decoded);
  if (parsed.protocol !== 'https:') {
    throw new ProtocolError('invalid_request', 'Blink/Solana Action URL must use https.');
  }
  return parsed.toString();
}

export async function fetchBlinkMetadata(input: {
  url: string;
  fetchImpl?: typeof fetch;
}): Promise<BlinkActionMetadata> {
  const actionUrl = normalizeBlinkUrl(input.url);
  const response = await (input.fetchImpl ?? fetch)(actionUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new ProtocolError(
      'invalid_request',
      extractActionError(payload) || `Blink metadata returned HTTP ${response.status}.`,
    );
  }
  return normalizeBlinkMetadata(actionUrl, payload);
}

export async function prepareBlinkAction(input: BlinkPrepareInput): Promise<BlinkPreparedAction> {
  const actionUrl = normalizeBlinkUrl(input.url);
  const account = input.account.trim();
  if (!account) {
    throw new ProtocolError('invalid_request', 'Wallet account is required before preparing this Blink action.');
  }
  const response = await (input.fetchImpl ?? fetch)(actionUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      account,
      ...(input.parameters ?? {}),
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new ProtocolError(
      'invalid_request',
      extractActionError(payload) || `Blink action returned HTTP ${response.status}.`,
    );
  }
  return normalizeBlinkPreparedAction(actionUrl, payload);
}

function normalizeBlinkMetadata(actionUrl: string, payload: unknown): BlinkActionMetadata {
  const record = objectRecord(payload);
  const links = objectRecord(record.links);
  const rawActions = Array.isArray(links.actions) ? links.actions : [];
  const actions = rawActions
    .map(normalizeLinkedAction)
    .filter((action): action is BlinkLinkedAction => Boolean(action));
  const error = extractActionError(record);
  return {
    url: actionUrl,
    title: stringValue(record.title) || new URL(actionUrl).hostname,
    description: stringValue(record.description) || '',
    label: stringValue(record.label) || actions[0]?.label || 'Continue',
    ...(stringValue(record.icon) ? { icon: stringValue(record.icon) } : {}),
    ...(typeof record.disabled === 'boolean' ? { disabled: record.disabled } : {}),
    ...(error ? { error } : {}),
    actions,
  };
}

function normalizeLinkedAction(value: unknown): BlinkLinkedAction | undefined {
  const record = objectRecord(value);
  const href = stringValue(record.href);
  const label = stringValue(record.label);
  if (!href || !label) return undefined;
  return {
    href,
    label,
    ...(Array.isArray(record.parameters)
      ? {
          parameters: record.parameters
            .map(normalizeActionParameter)
            .filter((param): param is BlinkActionParameter => Boolean(param)),
        }
      : {}),
  };
}

function normalizeActionParameter(value: unknown): BlinkActionParameter | undefined {
  const record = objectRecord(value);
  const name = stringValue(record.name);
  if (!name) return undefined;
  const options = Array.isArray(record.options)
    ? record.options
        .map((option) => {
          const raw = objectRecord(option);
          const label = stringValue(raw.label);
          const value = stringValue(raw.value);
          return label && value ? { label, value } : undefined;
        })
        .filter((option): option is { label: string; value: string } => Boolean(option))
    : undefined;
  return {
    name,
    ...(stringValue(record.label) ? { label: stringValue(record.label) } : {}),
    ...(stringValue(record.type) ? { type: stringValue(record.type) } : {}),
    ...(typeof record.required === 'boolean' ? { required: record.required } : {}),
    ...(stringValue(record.pattern) ? { pattern: stringValue(record.pattern) } : {}),
    ...(stringValue(record.patternDescription) ? { patternDescription: stringValue(record.patternDescription) } : {}),
    ...(typeof record.min === 'string' || typeof record.min === 'number' ? { min: record.min } : {}),
    ...(typeof record.max === 'string' || typeof record.max === 'number' ? { max: record.max } : {}),
    ...(options?.length ? { options } : {}),
  };
}

function normalizeBlinkPreparedAction(actionUrl: string, payload: unknown): BlinkPreparedAction {
  const record = objectRecord(payload);
  const transaction = stringValue(record.transaction);
  const transactions = Array.isArray(record.transactions)
    ? record.transactions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (transactions.length) {
    throw new ProtocolError(
      'unsupported_method',
      'This Blink returned multiple transactions. V1 supports one transaction at a time.',
    );
  }
  if (!transaction) {
    throw new ProtocolError(
      'invalid_request',
      extractActionError(record) || 'Blink action did not return transaction bytes.',
    );
  }
  return {
    actionUrl,
    transactionBase64: transaction,
    ...(stringValue(record.title) ? { title: stringValue(record.title) } : {}),
    ...(stringValue(record.label) ? { label: stringValue(record.label) } : {}),
    ...(stringValue(record.message) ? { message: stringValue(record.message) } : {}),
    raw: payload,
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ProtocolError('invalid_request', 'Connector returned a non-JSON response.');
  }
}

function extractActionError(payload: unknown): string {
  const record = objectRecord(payload);
  const error = record.error;
  if (typeof error === 'string') return error;
  const errorRecord = objectRecord(error);
  return stringValue(errorRecord.message) || stringValue(record.message) || '';
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
