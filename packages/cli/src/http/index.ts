import type { GlobalOptions } from '../shared/types.js';
import { REQUEST_TIMEOUT_MS } from '../shared/types.js';
import { errorMessage, parseJsonBody, responseError } from '../shared/util.js';
import { loadBearerToken } from '../auth/sessionStore.js';

export function bridgeUrl(options: GlobalOptions, path: string): URL {
  const base = options.bridgeUrl.endsWith('/') ? options.bridgeUrl : `${options.bridgeUrl}/`;
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, base);
  url.searchParams.set('token', options.token);
  return url;
}

export function renderWebUrl(options: GlobalOptions, path: string): URL {
  const base = options.renderWebUrl.endsWith('/') ? options.renderWebUrl : `${options.renderWebUrl}/`;
  return new URL(path.startsWith('/') ? path.slice(1) : path, base);
}

export async function fetchWithTimeout(
  input: URL | string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function bridgeRequest<T = unknown>(
  options: GlobalOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = bridgeUrl(options, path);
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      ...init,
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    }, REQUEST_TIMEOUT_MS + 5_000);
  } catch (err) {
    throw new Error(`Local wallet bridge is not reachable at ${options.bridgeUrl}. Run solana-agent-wallet app or bridge start. ${errorMessage(err)}`);
  }

  const text = await response.text();
  const body = parseJsonBody(text);
  if (!response.ok) {
    const error = responseError(body);
    throw new Error(error ?? `Local wallet bridge returned HTTP ${response.status}.`);
  }
  return body as T;
}

export async function tryBridgeRequest<T>(
  options: GlobalOptions,
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await bridgeRequest<T>(options, path, init) };
  } catch (error) {
    return { ok: false, error };
  }
}

export interface RenderWebRequestOptions {
  /** When true, attach Authorization: Bearer from session store. Defaults to true. */
  useBearer?: boolean;
  /** When true, fail explicitly with an auth-required error if no token is present. */
  requireAuth?: boolean;
  /** Override label used in error messages (e.g. "MPP API"). */
  label?: string;
}

/**
 * Unified render-web client. Adds:
 *  - Bearer token from ~/.solana-agent-wallet/session.json when present
 *  - Falls back to cookie env vars (legacy: AGENTIC_RENDER_WEB_COOKIE et al.)
 *  - Accept: application/json + content-type when body present
 */
export async function renderWebRequest<T = unknown>(
  options: GlobalOptions,
  path: string,
  init: RequestInit = {},
  reqOptions: RenderWebRequestOptions = {},
): Promise<T> {
  const url = renderWebUrl(options, path);
  const useBearer = reqOptions.useBearer !== false;
  const bearer = useBearer ? await loadBearerToken(options) : null;
  const cookie = process.env.AGENTIC_RENDER_WEB_COOKIE
    ?? process.env.AGENTIC_CLOUD_COOKIE
    ?? process.env.AGENTIC_SESSION_COOKIE;
  if (reqOptions.requireAuth && !bearer && !cookie) {
    throw new Error('Not signed in to Agentic cloud. Run: solana-agent-wallet auth login');
  }
  const label = reqOptions.label ?? 'Render-web API';
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        // x-agentic-client identifies us to /api/auth/verify-wallet's
        // shouldReturnBearerSession check so login responses include a
        // sessionToken. Sent unconditionally — render-web ignores it for routes
        // that don't care.
        'x-agentic-client': 'cli-bundled',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(cookie ? { cookie } : {}),
        ...(init.headers ?? {}),
      },
    }, REQUEST_TIMEOUT_MS);
  } catch (err) {
    throw new Error(`${label} is not reachable at ${options.renderWebUrl}. ${errorMessage(err)}`);
  }

  const text = await response.text();
  const body = parseJsonBody(text);
  if (!response.ok) {
    const error = responseError(body);
    if ((response.status === 401 || response.status === 403) && useBearer) {
      // Only surface the auth-login hint for routes that opted in to bearer
      // auth; public/anon routes (e.g. `profile show` reading /.well-known)
      // should print the server's own message verbatim.
      throw new Error(`${label} returned ${response.status}. ${error ?? ''} Run: solana-agent-wallet auth login`.trim());
    }
    throw new Error(error ?? `${label} returned HTTP ${response.status}.`);
  }
  return body as T;
}

// Legacy aliases preserved so existing call sites in index.ts keep working.
export async function mppRenderWebRequest<T = unknown>(
  options: GlobalOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return renderWebRequest<T>(options, path, init, { label: 'Render-web MPP API' });
}

export async function streamingRenderWebRequest<T = unknown>(
  options: GlobalOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return renderWebRequest<T>(options, path, init, { label: 'Render-web streaming API' });
}
