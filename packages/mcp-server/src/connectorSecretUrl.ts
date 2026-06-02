export interface ConnectorSecretBaseUrlOptions {
  allowLocalHttp?: boolean;
}

export function normalizeConnectorSecretBaseUrl(
  raw: string,
  options: ConnectorSecretBaseUrlOptions = {},
): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('baseUrl must be a non-empty URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('baseUrl must be a valid URL.');
  }

  if (parsed.protocol === 'https:') return trimmed;
  if (parsed.protocol === 'http:' && options.allowLocalHttp === true && isLocalHttpHost(parsed.hostname)) {
    return trimmed;
  }

  throw new Error(options.allowLocalHttp === true
    ? 'baseUrl must be an https URL or a local http URL.'
    : 'baseUrl must be an https URL.');
}

export function isLocalHttpHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]';
}
