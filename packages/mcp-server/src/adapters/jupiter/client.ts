import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import {
  DEFAULT_JUPITER_LEND_BASE_URL,
  DEFAULT_JUPITER_PREDICTION_BASE_URL,
  DEFAULT_JUPITER_PRICE_BASE_URL,
  DEFAULT_JUPITER_RECURRING_BASE_URL,
  DEFAULT_JUPITER_SWAP_BASE_URL,
  DEFAULT_JUPITER_TOKENS_BASE_URL,
  DEFAULT_JUPITER_TRIGGER_BASE_URL,
  type AgentWalletConfig,
} from '../../config.js';

export type JupiterProduct =
  | 'swap'
  | 'lend'
  | 'trigger'
  | 'recurring'
  | 'tokens'
  | 'price'
  | 'prediction';

export const JUPITER_RESPONSE_BYTE_LIMIT = 512_000;

export interface JupiterFetchOptions {
  method?: 'GET' | 'POST';
  searchParams?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
}

export function getJupiterApiKey(config: AgentWalletConfig): { apiKey?: string; envName: string } {
  const candidates = uniqueStrings([config.jupiter.apiKeyEnv, 'JUPITER_API_KEY', 'JUP_API_KEY']);
  for (const envName of candidates) {
    const apiKey = process.env[envName]?.trim();
    if (apiKey) return { apiKey, envName };
  }
  return { envName: config.jupiter.apiKeyEnv };
}

export function jupiterBaseUrl(config: AgentWalletConfig, product: JupiterProduct): string {
  const jupiter = config.jupiter;
  switch (product) {
    case 'swap':
      return stripTrailingSlashes(jupiter.swapBaseUrl ?? jupiter.baseUrl ?? DEFAULT_JUPITER_SWAP_BASE_URL);
    case 'lend':
      return stripTrailingSlashes(jupiter.lendBaseUrl ?? DEFAULT_JUPITER_LEND_BASE_URL);
    case 'trigger':
      return stripTrailingSlashes(jupiter.triggerBaseUrl ?? DEFAULT_JUPITER_TRIGGER_BASE_URL);
    case 'recurring':
      return stripTrailingSlashes(jupiter.recurringBaseUrl ?? DEFAULT_JUPITER_RECURRING_BASE_URL);
    case 'tokens':
      return stripTrailingSlashes(jupiter.tokensBaseUrl ?? DEFAULT_JUPITER_TOKENS_BASE_URL);
    case 'price':
      return stripTrailingSlashes(jupiter.priceBaseUrl ?? DEFAULT_JUPITER_PRICE_BASE_URL);
    case 'prediction':
      return stripTrailingSlashes(jupiter.predictionBaseUrl ?? DEFAULT_JUPITER_PREDICTION_BASE_URL);
  }
}

export function jupiterApiHost(config: AgentWalletConfig, product: JupiterProduct): string {
  try {
    return new URL(jupiterBaseUrl(config, product)).host;
  } catch {
    return jupiterBaseUrl(config, product);
  }
}

export async function jupiterFetchJson(
  config: AgentWalletConfig,
  product: JupiterProduct,
  path: string,
  options: JupiterFetchOptions = {},
): Promise<Record<string, unknown>> {
  const { apiKey, envName } = getJupiterApiKey(config);
  if (!apiKey) {
    throw new ProtocolError(
      'unauthorized',
      `Missing Jupiter API key. Set ${envName} or JUP_API_KEY before using Jupiter ${product} tools.`,
    );
  }

  const url = buildJupiterUrl(config, product, path, options.searchParams);
  const headers: Record<string, string> = { 'x-api-key': apiKey };
  if (options.bearerToken) headers.authorization = `Bearer ${options.bearerToken}`;
  if (options.body) headers['content-type'] = 'application/json';

  const response = await (options.fetchImpl ?? fetch)(url, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const body = await readJupiterJson(response);
  if (!response.ok) {
    throw new ProtocolError(
      'wallet_unreachable',
      `Jupiter ${product} request failed with HTTP ${response.status}: ${JSON.stringify(redactJupiterSecrets(body))}`,
    );
  }
  return body;
}

export function redactJupiterSecrets<T>(value: T): T {
  return redactValue(value) as T;
}

async function readJupiterJson(response: Response): Promise<Record<string, unknown>> {
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > JUPITER_RESPONSE_BYTE_LIMIT) {
    throw new ProtocolError(
      'wallet_unreachable',
      `Jupiter API response exceeded ${JUPITER_RESPONSE_BYTE_LIMIT} bytes; refusing to read further.`,
    );
  }
  const text = await response.text();
  if (text.length > JUPITER_RESPONSE_BYTE_LIMIT) {
    throw new ProtocolError(
      'wallet_unreachable',
      `Jupiter API response exceeded ${JUPITER_RESPONSE_BYTE_LIMIT} bytes; refusing to read further.`,
    );
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return { error: 'Jupiter API returned non-JSON response.' };
  }
}

function buildJupiterUrl(
  config: AgentWalletConfig,
  product: JupiterProduct,
  path: string,
  searchParams: JupiterFetchOptions['searchParams'],
): URL {
  const url = new URL(path.startsWith('http') ? path : `${jupiterBaseUrl(config, product)}${path}`);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { data: value };
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      const normalized = key.toLowerCase();
      if (
        normalized.includes('apikey') ||
        normalized.includes('api_key') ||
        normalized.includes('authorization') ||
        normalized.includes('bearer') ||
        normalized.includes('jwt') ||
        normalized.includes('challenge') ||
        normalized.includes('signedtransaction') ||
        normalized.includes('signed_transaction') ||
        normalized.includes('transaction')
      ) {
        return [key, '[redacted]'];
      }
      return [key, redactValue(entryValue)];
    }),
  );
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(JUPITER_API_KEY|JUP_API_KEY|x-api-key)(["'=:\s]+)[A-Za-z0-9._~+/=-]+/gi, '$1$2[redacted]')
    .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, '[redacted]');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
