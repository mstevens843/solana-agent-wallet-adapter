// FetchHttpExecutor — browser replacement for Kotlin's DefaultHttpExecutor.
// Enforces:
//   - HTTPS-only URLs (case-insensitive).
//   - Caller headers override built-in Content-Type / Accept defaults.
//   - Composed timeout (connect + read) shared with the caller's AbortSignal.
//     If the caller cancels, we re-throw AbortError verbatim; the queue maps
//     that to runtime_canceled. If our internal timeout fires first, we throw
//     ProviderHttpError(provider_timeout).
//   - 1 MiB response body cap. Stream when ReadableStream is available; fall
//     back to response.text() with a post-hoc length guard in degraded envs.
//   - Network failures (fetch's TypeError) → ProviderHttpError(provider_network).
//
// We do NOT remap non-2xx HTTP statuses here — that is the provider layer's
// job. The mirror in Kotlin lives in HttpExecutor.kt.

import { PROVIDER_ERROR_CODES, ProviderHttpError } from './errorCodes.js';

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface HttpExecutor {
  postJson(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal,
  ): Promise<HttpResponse>;
}

export interface FetchHttpExecutorOptions {
  readonly connectTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly maxBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_READ_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 1_048_576;

export class FetchHttpExecutor implements HttpExecutor {
  private readonly connectTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FetchHttpExecutorOptions = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.fetchImpl = options.fetchImpl ?? defaultFetch();
  }

  async postJson(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    if (!url.toLowerCase().startsWith('https://')) {
      throw new ProviderHttpError(
        PROVIDER_ERROR_CODES.INVALID_CONFIG,
        `Device Agent provider URL must use https://; got "${url}".`,
      );
    }

    if (signal?.aborted) {
      throw abortErrorFrom(signal);
    }

    const finalHeaders: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
    };
    for (const [name, value] of Object.entries(headers)) {
      finalHeaders[name] = value;
    }

    const internal = new AbortController();
    const totalTimeoutMs = this.connectTimeoutMs + this.readTimeoutMs;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      internal.abort();
    }, totalTimeoutMs);

    let onExternalAbort: (() => void) | undefined;
    if (signal) {
      onExternalAbort = () => internal.abort();
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: finalHeaders,
        body,
        signal: internal.signal,
      });
    } catch (err) {
      if (timedOut) {
        throw new ProviderHttpError(PROVIDER_ERROR_CODES.TIMEOUT, 'Provider request timed out.');
      }
      if (signal?.aborted) {
        throw abortErrorFrom(signal);
      }
      if (err instanceof TypeError) {
        const message = err.message && err.message.length > 0 ? err.message : 'Provider network error.';
        throw new ProviderHttpError(PROVIDER_ERROR_CODES.NETWORK, message);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (signal && onExternalAbort) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }

    const bodyText = await this.readBodyCapped(response);
    return { status: response.status, body: bodyText };
  }

  private async readBodyCapped(response: Response): Promise<string> {
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > this.maxBytes) {
            try {
              await reader.cancel();
            } catch {
              // ignore — best-effort during overflow teardown
            }
            throw new ProviderHttpError(
              PROVIDER_ERROR_CODES.INVALID_RESPONSE,
              `Provider response exceeded the ${Math.floor(this.maxBytes / 1024)} KiB cap.`,
            );
          }
          chunks.push(value);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder('utf-8').decode(merged);
    }

    const text = await response.text();
    if (text.length > this.maxBytes) {
      throw new ProviderHttpError(
        PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        `Provider response exceeded the ${Math.floor(this.maxBytes / 1024)} KiB cap.`,
      );
    }
    return text;
  }
}

function defaultFetch(): typeof fetch {
  if (typeof fetch !== 'function') {
    throw new Error('FetchHttpExecutor requires a global fetch implementation.');
  }
  return fetch.bind(globalThis);
}

function abortErrorFrom(signal: AbortSignal): unknown {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}
