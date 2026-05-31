import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { randomBytes } from 'node:crypto';

import type { GlobalOptions } from '../shared/types.js';
import { renderWebRequest } from '../http/index.js';
import { saveSession } from './sessionStore.js';
import { errorMessage, isRecord } from '../shared/util.js';

interface NonceResponse {
  nonce: string;
  message: string;
  domain?: string;
  issuedAt?: string;
  expiresAt?: string;
  walletAddress?: string;
}

interface VerifyWalletResponse {
  sessionToken?: string;
  expiresAt?: string;
  walletAddress?: string;
  session?: { token?: string; expiresAt?: string; walletAddress?: string };
}

export interface LoginOptions {
  /** Wallet address to bind. If omitted, falls back to AGENTIC_WALLET_ADDRESS env. */
  walletAddress?: string;
  /** When true, do not auto-open the browser; print URL instead. */
  noOpen?: boolean;
  /** Override default 5-minute timeout. */
  timeoutMs?: number;
  /** Abort an in-flight wallet signature wait, typically from Ctrl+C. */
  signal?: AbortSignal;
}

export type WalletHostSigningPath = '/agentic-login' | '/sign-in' | '/delete-storage';

interface CallbackPayload {
  signature?: string;
  walletAddress?: string;
  /** 'utf8-message' (standard SIWS) or 'tx-memo-proof' (Android wallet fallback) */
  proofEncoding?: string;
  /** Base64-encoded transaction bytes used as the proof envelope for memo-tx fallback. */
  proofTxBase64?: string;
  /** Signature encoding — 'base58' (default) or 'base64'. */
  signatureEncoding?: string;
  error?: string;
}

export interface SignedProof {
  walletAddress: string;
  nonce: string;
  message: string;
  signature: string;
  domain?: string;
  issuedAt?: string;
  expiresAt?: string;
  signatureEncoding: 'base58' | 'base64';
  proofEncoding?: 'utf8-message' | 'tx-memo-proof';
  proofTxBase64?: string;
}

/**
 * High-level wallet-host signing primitive. Used by login + any other command
 * that needs the user to sign a server-issued message (profile publish, cloud
 * workspace delete, etc.).
 *
 *   1. Opens /agentic-login on the wallet host with the message embedded in the
 *      query string + a loopback callback URL.
 *   2. Waits for the wallet host to POST {signature, walletAddress, ...} back
 *      to the loopback receiver.
 *   3. Returns a fully-populated SignedProof envelope ready to attach to the
 *      next server request body.
 *
 * The wallet host page (apps/browser-demo/src/main.ts:agenticLoginPage) is
 * intent-agnostic — it signs whatever message it receives.
 */
export async function signMessageViaWalletHost(
  options: GlobalOptions,
  intent: {
    nonce: string;
    message: string;
    walletAddress?: string;
    domain?: string;
    issuedAt?: string;
    expiresAt?: string;
    summary?: string;
  },
  ctlOpts: { noOpen?: boolean; timeoutMs?: number; path?: WalletHostSigningPath; openLabel?: string; signal?: AbortSignal } = {},
): Promise<SignedProof> {
  if (ctlOpts.signal?.aborted) {
    throw abortErrorFromSignal(ctlOpts.signal);
  }
  const timeoutMs = ctlOpts.timeoutMs ?? 5 * 60 * 1000;
  const stateToken = randomBytes(16).toString('base64url');
  const { callback, waitForPayload } = await createCallbackReceiver({
    timeoutMs,
    state: stateToken,
    port: 0,
    signal: ctlOpts.signal,
  });

  const loginUrl = buildWalletHostLoginUrl(options, {
    nonce: intent.nonce,
    message: intent.message,
    walletAddress: intent.walletAddress ?? '',
    summary: intent.summary ?? 'Agentic CLI signed request',
  }, callback.url, stateToken, ctlOpts.path ?? '/agentic-login');

  const canAutoOpen = !ctlOpts.noOpen && process.env.AGENT_WALLET_SKIP_OPEN !== '1';
  if (canAutoOpen) {
    spawnOpener(loginUrl);
    console.error(`\nOpened: ${ctlOpts.openLabel ?? 'Agentic Wallet Signature'}\n`);
  } else {
    console.error(`\nOpen manually: ${loginUrl}\n`);
  }

  // Print the URL + wait notice to STDERR so it works in --json mode (where
  // stdout is reserved for the parseable result).
  console.error('Waiting for wallet signature (Ctrl+C to abort)...');

  let payload: CallbackPayload;
  try {
    payload = await waitForPayload;
  } finally {
    callback.close();
  }

  if (payload.error) {
    throw new Error(`Wallet signing was canceled or failed: ${payload.error}`);
  }
  if (!payload.signature || !payload.walletAddress) {
    throw new Error('Wallet host did not return a signature and wallet address.');
  }
  if (intent.walletAddress && intent.walletAddress !== payload.walletAddress) {
    throw new Error(`Connected wallet ${payload.walletAddress} does not match intent ${intent.walletAddress}.`);
  }

  return {
    walletAddress: payload.walletAddress,
    nonce: intent.nonce,
    message: intent.message,
    signature: payload.signature,
    ...(intent.domain ? { domain: intent.domain } : {}),
    ...(intent.issuedAt ? { issuedAt: intent.issuedAt } : {}),
    ...(intent.expiresAt ? { expiresAt: intent.expiresAt } : {}),
    signatureEncoding: payload.signatureEncoding === 'base64' ? 'base64' : 'base58',
    ...(payload.proofEncoding === 'tx-memo-proof' || payload.proofEncoding === 'utf8-message'
      ? { proofEncoding: payload.proofEncoding }
      : {}),
    ...(payload.proofTxBase64 ? { proofTxBase64: payload.proofTxBase64 } : {}),
  };
}

/**
 * `auth login` — fetches /api/auth/nonce, opens wallet host for signing, posts
 * the signed envelope to /api/auth/verify-wallet, persists the sessionToken at
 * ~/.solana-agent-wallet/session.json.
 */
export async function runLogin(options: GlobalOptions, loginOptions: LoginOptions = {}): Promise<{
  walletAddress: string;
  expiresAt?: string;
}> {
  const walletAddress = loginOptions.walletAddress ?? process.env.AGENTIC_WALLET_ADDRESS;
  if (!walletAddress) {
    throw new Error('auth login requires --wallet <address> (or set AGENTIC_WALLET_ADDRESS).');
  }
  const nonce = await renderWebRequest<NonceResponse>(options, '/api/auth/nonce', {
    method: 'POST',
    body: JSON.stringify({ walletAddress }),
  }, { useBearer: false, label: 'Render-web auth' });
  if (!nonce.nonce || !nonce.message) {
    throw new Error('Render-web /api/auth/nonce did not return nonce/message.');
  }

  const proof = await signMessageViaWalletHost(options, {
    nonce: nonce.nonce,
    message: nonce.message,
    walletAddress,
    domain: nonce.domain,
    issuedAt: nonce.issuedAt,
    expiresAt: nonce.expiresAt,
    summary: 'Agentic CLI login',
  }, {
    ...(loginOptions.noOpen !== undefined ? { noOpen: loginOptions.noOpen } : {}),
    ...(loginOptions.timeoutMs !== undefined ? { timeoutMs: loginOptions.timeoutMs } : {}),
    ...(loginOptions.signal ? { signal: loginOptions.signal } : {}),
    path: '/sign-in',
    openLabel: 'Agentic Cloud Sign In',
  });

  const verify = await renderWebRequest<VerifyWalletResponse>(options, '/api/auth/verify-wallet', {
    method: 'POST',
    body: JSON.stringify(proof),
  }, { useBearer: false, label: 'Render-web auth' });

  const token = verify.sessionToken ?? verify.session?.token;
  if (!token) {
    throw new Error('Render-web did not issue a session token. Ensure the server build includes bearer-mode SIWS.');
  }
  const expiresAt = verify.expiresAt ?? verify.session?.expiresAt;
  const sessionWallet = verify.walletAddress ?? verify.session?.walletAddress ?? proof.walletAddress;

  await saveSession(options, {
    token,
    walletAddress: sessionWallet,
    ...(expiresAt ? { expiresAt } : {}),
    renderWebOrigin: options.renderWebUrl,
    issuedAt: new Date().toISOString(),
  });

  return { walletAddress: sessionWallet, ...(expiresAt ? { expiresAt } : {}) };
}

function buildWalletHostLoginUrl(
  options: GlobalOptions,
  intent: { nonce: string; message: string; walletAddress: string; summary: string },
  callback: string,
  stateToken: string,
  path: WalletHostSigningPath,
): string {
  // Route directly to a wallet-host signing page so the SPA serves the dedicated
  // focused surface (Cloud Storage sign-in or generic signed request).
  const baseUrl = new URL(options.walletHostUrl);
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '') + path;
  baseUrl.searchParams.set('bridgeUrl', options.bridgeUrl);
  baseUrl.searchParams.set('token', options.token);
  if (path === '/sign-in' || path === '/delete-storage') {
    baseUrl.searchParams.set('mode', 'cli');
    baseUrl.searchParams.set('intent', path === '/sign-in' ? 'sign-in' : 'delete-storage');
  }
  baseUrl.searchParams.set('nonce', intent.nonce);
  baseUrl.searchParams.set('message', intent.message);
  baseUrl.searchParams.set('callback', callback);
  baseUrl.searchParams.set('state', stateToken);
  baseUrl.searchParams.set('summary', intent.summary);
  if (intent.walletAddress) {
    baseUrl.searchParams.set('walletAddress', intent.walletAddress);
  }
  return baseUrl.toString();
}

async function createCallbackReceiver(opts: {
  port: number;
  state: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{
  callback: { url: string; close: () => void };
  waitForPayload: Promise<CallbackPayload>;
}> {
  return new Promise((resolveOuter, rejectOuter) => {
    let resolveInner!: (payload: CallbackPayload) => void;
    let rejectInner!: (err: Error) => void;
    let outerSettled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Mutable ref so handleCallbackRequest sees the LIVE value of `settled`
    // at the moment it decides whether to respond 410 vs accept the payload.
    // A snapshot boolean would let a second concurrent request race past the
    // first one before it flips `settled = true`.
    const settledRef = { value: false };

    const waitForPayload: Promise<CallbackPayload> = new Promise((res, rej) => {
      resolveInner = (payload) => {
        if (settledRef.value) return;
        settledRef.value = true;
        cleanup();
        res(payload);
      };
      rejectInner = (err) => {
        if (settledRef.value) return;
        settledRef.value = true;
        cleanup();
        rej(err);
        if (!outerSettled) {
          outerSettled = true;
          rejectOuter(err);
        }
      };
    });
    void waitForPayload.catch(() => undefined);

    const server = createServer((req, res) => {
      handleCallbackRequest(req, res, opts.state, settledRef).then((maybe) => {
        // null = ignore this request (state mismatch, idempotency guard); only
        // resolve the outer promise on a real callback payload.
        if (maybe) {
          resolveInner(maybe);
        }
      }).catch((err) => {
        rejectInner(err instanceof Error ? err : new Error(String(err)));
      });
    });

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      process.removeListener('SIGINT', onSigint);
      opts.signal?.removeEventListener('abort', onAbort);
      try { server.close(); } catch { /* ignore */ }
    };

    timer = setTimeout(() => {
      rejectInner(new Error('Login timed out waiting for browser callback.'));
    }, opts.timeoutMs);

    server.once('error', (err) => {
      // Once the listen callback fires, an error here means an accept-time
      // failure (EMFILE etc.); surface it via the inner reject if we haven't
      // settled yet, otherwise swallow it.
      if (!settledRef.value) {
        rejectInner(err);
      }
    });

    // Reject the pending signature wait on Ctrl+C. In the interactive app this
    // returns control to the REPL; in one-shot commands it exits promptly.
    const onSigint = () => {
      rejectInner(abortPromptError());
    };
    process.once('SIGINT', onSigint);
    const onAbort = () => {
      rejectInner(abortErrorFromSignal(opts.signal));
    };
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    server.listen(opts.port, '127.0.0.1', () => {
      if (settledRef.value) {
        return;
      }
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectInner(new Error('Failed to bind loopback callback receiver.'));
        return;
      }
      const url = `http://127.0.0.1:${address.port}/agentic-login-callback`;
      outerSettled = true;
      resolveOuter({
        callback: { url, close: cleanup },
        waitForPayload,
      });
    });
  });
}

function abortPromptError(): Error {
  const err = new Error('Prompt aborted.');
  err.name = 'AbortPromptError';
  return err;
}

function abortErrorFromSignal(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : abortPromptError();
}

async function handleCallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedState: string,
  settledRef: { value: boolean },
): Promise<CallbackPayload | null> {
  if (!req.url) {
    res.statusCode = 400;
    res.end('Bad request');
    return null;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/agentic-login-callback') {
    res.statusCode = 404;
    res.end('Not found');
    return null;
  }
  // CORS preflight from wallet host
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    setCorsHeaders(res);
    res.end();
    return null;
  }
  setCorsHeaders(res);

  // Idempotency: once the outer promise has resolved with a valid payload,
  // subsequent requests (browser tab reload, retry, listener dup) get 410 Gone
  // and never trigger another resolveInner. The mutable settledRef means we
  // see the LIVE value at response-write time, not a stale snapshot.
  if (settledRef.value) {
    res.statusCode = 410;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body style="font-family:system-ui;padding:2rem"><p>This login flow already completed. You can close this tab.</p></body></html>');
    return null;
  }

  let payload: CallbackPayload;
  if (req.method === 'GET') {
    payload = {
      signature: url.searchParams.get('signature') ?? undefined,
      walletAddress: url.searchParams.get('walletAddress') ?? undefined,
      proofEncoding: url.searchParams.get('proofEncoding') ?? url.searchParams.get('encoding') ?? undefined,
      proofTxBase64: url.searchParams.get('proofTxBase64') ?? url.searchParams.get('transactionBase64') ?? undefined,
      signatureEncoding: url.searchParams.get('signatureEncoding') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
    };
    const stateParam = url.searchParams.get('state');
    if (stateParam !== expectedState) {
      // Stray request (browser prefetch, attacker probe). Return 400 BUT do not
      // resolve the outer promise — keep listening for the legitimate callback.
      res.statusCode = 400;
      res.end('State mismatch');
      return null;
    }
  } else if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.statusCode = 400;
      res.end('Invalid JSON');
      return null;
    }
    if (!isRecord(body) || body.state !== expectedState) {
      res.statusCode = 400;
      res.end('State mismatch');
      return null;
    }
    payload = {
      signature: typeof body.signature === 'string' ? body.signature : undefined,
      walletAddress: typeof body.walletAddress === 'string' ? body.walletAddress : undefined,
      proofEncoding: typeof body.proofEncoding === 'string'
        ? body.proofEncoding
        : typeof body.encoding === 'string' ? body.encoding : undefined,
      proofTxBase64: typeof body.proofTxBase64 === 'string'
        ? body.proofTxBase64
        : typeof body.transactionBase64 === 'string' ? body.transactionBase64 : undefined,
      signatureEncoding: typeof body.signatureEncoding === 'string' ? body.signatureEncoding : undefined,
      error: typeof body.error === 'string' ? body.error : undefined,
    };
  } else {
    res.statusCode = 405;
    res.end('Method not allowed');
    return null;
  }

  // Re-check settled — between handler entry and now another concurrent
  // request may have already resolved the outer promise. If so, return 410
  // instead of a misleading "Signed" page.
  if (settledRef.value) {
    res.statusCode = 410;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body style="font-family:system-ui;padding:2rem"><p>This login flow already completed. You can close this tab.</p></body></html>');
    return null;
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(
    payload.error
      ? `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>Signing failed</h2><pre>${escapeHtml(
          payload.error,
        )}</pre><p>You can close this tab.</p></body></html>`
      : `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>Signed</h2><p>You can close this tab and return to the terminal.</p></body></html>`,
  );
  return payload;
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

function spawnOpener(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/C', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.unref();
}

// Suppress lint warning about unused export from imported file (kept for parity).
void errorMessage;
