import { generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseAuthNonceResponse,
  parseSessionResponse,
} from '@solana-agent-wallet-adapter/workflow';
import { afterEach, describe, expect, it } from 'vitest';

import { encodeBase58 } from '../cloud/auth.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import type { AuthRateLimiter } from '../cloud/router.js';
import { createWalletSession, sessionFromRequest } from '../cloud/session.js';
import type { Clock } from '../cloud/store.js';
import type {
  ApprovalRequestRecord,
  CompletedRecord,
  JsonObject,
  PlanDraftRecord,
  TransactionFinalizationRecord,
} from '../cloud/workflowValidation.js';
import { createRenderWebServer } from '../server.js';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

interface TestWallet {
  walletAddress: string;
  privateKey: KeyObject;
}

describe('render web cloud wallet auth', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('creates a sign-in nonce for a valid wallet address', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      });

      expect(response.status).toBe(200);
      expect(response.body.walletAddress).toBe(wallet.walletAddress);
      expect(response.body.nonce).toEqual(expect.any(String));
      expect(response.body.domain).toBe(`127.0.0.1:${port}`);
      expect(String(response.body.message)).toContain(`Wallet: ${wallet.walletAddress}`);
      expect(String(response.body.message)).toContain('does not grant spending authority');
      expect(parseAuthNonceResponse(response.body)).toMatchObject({
        walletAddress: wallet.walletAddress,
        domain: `127.0.0.1:${port}`,
      });
    });
  });

  it('creates an HTTP-only session from a valid wallet signature', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(200);
      expect(verify.body).toMatchObject({
        signedIn: true,
        user: {
          walletAddress: wallet.walletAddress,
        },
        capabilities: {
          mode: 'agentic_cloud',
          requiresWalletSession: true,
          requiresLocalhost: false,
        },
        session: {
          walletAddress: wallet.walletAddress,
        },
        expiresAt: expect.any(String),
      });
      expect(parseSessionResponse(verify.body)).toMatchObject({
        signedIn: true,
        session: {
          walletAddress: wallet.walletAddress,
        },
      });
      expect(firstSetCookie(verify)).toContain('agentic_session=');
      expect(firstSetCookie(verify)).toContain('HttpOnly');
      expect(firstSetCookie(verify)).toContain('SameSite=Lax');

      const session = await getJson(port, '/api/session', {
        cookie: sessionCookie(verify),
      });
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({
        signedIn: true,
        user: {
          walletAddress: wallet.walletAddress,
        },
      });
      expect(parseSessionResponse(session.body).signedIn).toBe(true);
    });
  });

  it('returns an Android bearer session for the bundled app origin', async () => {
    await withServer(async (port) => {
      const headers = {
        origin: 'https://agentic.local',
        'x-agentic-client': 'android-bundled',
      };
      const wallet = createTestWallet();
      const nonce = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      }, headers);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body), headers);

      expect(verify.status).toBe(200);
      expect(verify.body.sessionToken).toEqual(expect.any(String));
      expect(String(verify.headers['access-control-allow-origin'])).toBe('https://agentic.local');

      const session = await getJson(port, '/api/session', {
        origin: 'https://agentic.local',
        authorization: `Bearer ${String(verify.body.sessionToken)}`,
      });
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({
        signedIn: true,
        user: {
          walletAddress: wallet.walletAddress,
        },
      });
    });
  });

  it('returns an iOS bearer session for the Capacitor app origin', async () => {
    await withServer(async (port) => {
      const headers = {
        origin: 'capacitor://localhost',
        'x-agentic-client': 'ios-bundled',
      };
      const wallet = createTestWallet();
      const nonce = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      }, headers);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body), headers);

      expect(verify.status).toBe(200);
      expect(verify.body.sessionToken).toEqual(expect.any(String));
      expect(String(verify.headers['access-control-allow-origin'])).toBe('capacitor://localhost');
    });
  });

  it('returns a CLI bearer session without an Origin header', async () => {
    // The Solana Agent Wallet CLI runs as a local process — fetch() in Node
    // omits Origin, so shouldReturnBearerSession must accept `cli-bundled`
    // standalone. (See packages/cli/src/http/index.ts where this header is set.)
    await withServer(async (port) => {
      const headers = { 'x-agentic-client': 'cli-bundled' };
      const wallet = createTestWallet();
      const nonce = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      }, headers);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body), headers);

      expect(verify.status).toBe(200);
      expect(verify.body.sessionToken).toEqual(expect.any(String));

      const session = await getJson(port, '/api/session', {
        authorization: `Bearer ${String(verify.body.sessionToken)}`,
      });
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({
        signedIn: true,
        user: { walletAddress: wallet.walletAddress },
      });
    });
  });

  it('handles Android cloud CORS preflight without cookies', async () => {
    await withServer(async (port) => {
      const response = await requestRaw(port, '/api/session', 'OPTIONS', undefined, {
        origin: 'https://agentic.local',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, content-type, x-agentic-client',
      });

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('https://agentic.local');
      expect(String(response.headers['access-control-allow-headers'])).toContain('authorization');
    });
  });

  it('handles iOS Capacitor cloud CORS preflight without cookies', async () => {
    await withServer(async (port) => {
      const response = await requestRaw(port, '/api/solana/wallet-balance-summary', 'OPTIONS', undefined, {
        origin: 'capacitor://localhost',
        'x-agentic-client': 'ios-bundled',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, x-agentic-client',
      });

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('capacitor://localhost');
      expect(String(response.headers['access-control-allow-headers'])).toContain('authorization');
    });
  });

  it('advertises PATCH in CORS preflight so Android TWA can update plans', async () => {
    // Regression: missing PATCH in Access-Control-Allow-Methods caused the WebView
    // to fail PATCH /api/plans/:id preflight, surfacing as
    // "Agentic Cloud is not reachable from this page" after a successful MWA sign.
    await withServer(async (port) => {
      const response = await requestRaw(port, '/api/plans/test', 'OPTIONS', undefined, {
        origin: 'https://agentic.local',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization, content-type, x-agentic-client',
      });

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('https://agentic.local');
      expect(String(response.headers['access-control-allow-methods'])).toContain('PATCH');
    });
  });

  it('accepts the tauri://localhost prod webview origin for desktop preflight', async () => {
    // Regression: the Tauri 2 desktop shell on macOS / Linux loads from the
    // `tauri://localhost` custom scheme. Without this entry in the CORS
    // allowlist, /api/swap/order + /api/swap/execute preflight 403, the
    // browser blocks the POST, and `hostedSwapRequest` raises
    // "Swap execution is not reachable from this browser." for every QR
    // wallet (Phantom QR, Solflare QR, Reown Backpack, Reown Jupiter).
    await withServer(async (port) => {
      const response = await requestRaw(port, '/api/swap/execute', 'OPTIONS', undefined, {
        origin: 'tauri://localhost',
        'x-agentic-client': 'desktop-bundled',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, x-agentic-client',
      });

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('tauri://localhost');
    });
  });

  it('accepts the Tauri 2 Windows http://tauri.localhost prod origin', async () => {
    await withServer(async (port) => {
      const response = await requestRaw(port, '/api/swap/execute', 'OPTIONS', undefined, {
        origin: 'http://tauri.localhost',
        'x-agentic-client': 'desktop-bundled',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, x-agentic-client',
      });

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
    });
  });

  it('accepts the Tauri dev Vite origin outside production', async () => {
    // `pnpm --filter @solana-agent-wallet-adapter/desktop-shell tauri:dev`
    // loads http://127.0.0.1:5174 inside the webview (per
    // apps/desktop-shell/src-tauri/tauri.conf.json `devUrl`). Local dev must
    // be allowed against a local Render server.
    await withServer(async (port) => {
      const response = await requestRaw(port, '/api/swap/order', 'OPTIONS', undefined, {
        origin: 'http://127.0.0.1:5174',
        'x-agentic-client': 'desktop-bundled',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, x-agentic-client',
      });

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5174');
    });
  });

  it('rejects the Tauri dev Vite origin in production', async () => {
    // Defense in depth — the closed-allowlist invariant for prod Render must
    // not trust an arbitrary local server on port 5174.
    await withEnv({ RENDER: 'true' }, async () => {
      await withServer(async (port) => {
        const response = await requestRaw(port, '/api/swap/execute', 'OPTIONS', undefined, {
          origin: 'http://127.0.0.1:5174',
          'x-agentic-client': 'desktop-bundled',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type, x-agentic-client',
        });

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('cors_origin_not_allowed');
      });
    });
  });

  it('accepts Origin: null when the request is desktop-bundled', async () => {
    // Chromium emits `Origin: null` for some `tauri://` custom-scheme
    // requests; without this fallback the signed macOS bundle would 403 even
    // after the scheme itself is allowlisted.
    await withServer(async (port) => {
      const response = await requestRaw(port, '/api/swap/execute', 'OPTIONS', undefined, {
        origin: 'null',
        'x-agentic-client': 'desktop-bundled',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, x-agentic-client',
      });

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('null');
    });
  });

  it('rejects Origin: null without the desktop-bundled client header', async () => {
    await withServer(async (port) => {
      const response = await requestRaw(port, '/api/swap/execute', 'OPTIONS', undefined, {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('cors_origin_not_allowed');
    });
  });

  it('returns a desktop bearer session for the bundled Tauri origin', async () => {
    // Without this the Tauri shell can sign in cookie-style but never receives
    // a Bearer to authenticate subsequent cross-origin hosted calls (/api/plans,
    // /api/audit, BYOK connector keys). See router.ts shouldReturnBearerSession.
    await withServer(async (port) => {
      const headers = {
        origin: 'tauri://localhost',
        'x-agentic-client': 'desktop-bundled',
      };
      const wallet = createTestWallet();
      const nonce = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      }, headers);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body), headers);

      expect(verify.status).toBe(200);
      expect(verify.body.sessionToken).toEqual(expect.any(String));
      expect(String(verify.headers['access-control-allow-origin'])).toBe('tauri://localhost');

      const session = await getJson(port, '/api/session', {
        origin: 'tauri://localhost',
        'x-agentic-client': 'desktop-bundled',
        authorization: `Bearer ${String(verify.body.sessionToken)}`,
      });
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({
        signedIn: true,
        user: { walletAddress: wallet.walletAddress },
      });
    });
  });

  it('keeps legacy minimal verify payloads working for the current browser client', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const body = signedVerifyBody(wallet, nonce.body);
      delete body.domain;
      delete body.issuedAt;
      delete body.expiresAt;
      delete body.signatureEncoding;

      const verify = await postJson(port, '/api/auth/verify-wallet', body);

      expect(verify.status).toBe(200);
      expect(parseSessionResponse(verify.body).signedIn).toBe(true);
    });
  });

  it('rejects invalid wallet signatures', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const otherWallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const body = signedVerifyBody(wallet, nonce.body);
      body.signature = signMessage(String(nonce.body.message), otherWallet.privateKey);

      const verify = await postJson(port, '/api/auth/verify-wallet', body);

      expect(verify.status).toBe(401);
      expect(String(verify.body.error)).toContain('signature');
    });
  });

  it('rejects expired nonces', async () => {
    const clock = mutableClock('2026-05-08T18:00:00.000Z');
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      clock.set('2026-05-08T18:06:00.000Z');

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(String(verify.body.error)).toContain('expired');
    }, { clock });
  });

  it('rejects a nonce that expires before the atomic consume step', async () => {
    // Auth endpoints also read the clock for rate limiting before route handlers run.
    const clock = queuedClock([
      '2026-05-08T17:59:58.000Z',
      '2026-05-08T17:59:59.000Z',
      '2026-05-08T18:00:00.000Z',
      '2026-05-08T18:04:59.998Z',
      '2026-05-08T18:04:59.999Z',
      '2026-05-08T18:05:00.000Z',
    ]);
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(firstSetCookie(verify)).toBe('');
    }, { clock });
  });

  it('rejects replayed nonces', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const body = signedVerifyBody(wallet, nonce.body);

      const first = await postJson(port, '/api/auth/verify-wallet', body);
      const replay = await postJson(port, '/api/auth/verify-wallet', body);

      expect(first.status).toBe(200);
      expect(replay.status).toBe(401);
      expect(String(replay.body.error)).toContain('used');
    });
  });

  it('does not create a session if nonce consumption loses a replay race', async () => {
    const store = new ReplayRaceStore();
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(firstSetCookie(verify)).toBe('');
    }, { store });
  });

  it('binds auth messages to AGENTIC_PUBLIC_ORIGIN when configured', async () => {
    await withEnv({ AGENTIC_PUBLIC_ORIGIN: 'https://agentic.example' }, async () => {
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const nonce = await createNonce(port, wallet);

        expect(nonce.body.domain).toBe('agentic.example');
        const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

        expect(verify.status).toBe(200);
      });
    });
  });

  it('rejects a signed nonce on a different domain', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      }, {
        host: 'agentic.example',
      });

      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));

      expect(verify.status).toBe(401);
      expect(String(verify.body.error)).toContain('domain');
    });
  });

  it('rejects cross-origin state-changing API requests', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      }, {
        origin: 'https://evil.example',
      });

      expect(response.status).toBe(403);
      expect(String(response.body.error)).toContain('Cross-origin');
    });
  });

  it('sets browser hardening headers on app responses', async () => {
    await withServer(async (port) => {
      const response = await requestRaw(port, '/app/', 'GET');

      expect(response.status).toBe(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(String(response.headers['permissions-policy'])).toContain('camera=()');
      expect(String(response.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
      expect(String(response.headers['content-security-policy'])).toContain('wss:');
    });
  });

  it('rejects state-changing JSON APIs without a JSON content type', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await requestRaw(port, '/api/auth/nonce', 'POST', JSON.stringify({
        walletAddress: wallet.walletAddress,
      }), {
        'content-type': 'text/plain',
      });

      expect(response.status).toBe(415);
      expect(String(response.body.error)).toContain('application/json');
    });
  });

  it('requires same-origin referer for production state-changing requests without Origin', async () => {
    await withEnv({ RENDER: 'true' }, async () => {
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const missingReferer = await postJson(port, '/api/auth/nonce', {
          walletAddress: wallet.walletAddress,
        });
        expect(missingReferer.status).toBe(403);
        expect(String(missingReferer.body.error)).toContain('same-origin');

        const withReferer = await postJson(port, '/api/auth/nonce', {
          walletAddress: wallet.walletAddress,
        }, {
          referer: `http://127.0.0.1:${port}/app/`,
        });
        expect(withReferer.status).toBe(200);
      });
    });
  });

  it('rate limits wallet auth endpoints', async () => {
    const authRateLimiter: AuthRateLimiter = {
      allow: () => false,
    };
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      });

      expect(response.status).toBe(429);
      expect(String(response.body.error)).toContain('Too many');
    }, { authRateLimiter });
  });

  it('passes the injected clock to the wallet auth rate limiter', async () => {
    const clock = fixedClock('2026-05-08T19:00:00.000Z');
    const seen: string[] = [];
    const authRateLimiter: AuthRateLimiter = {
      allow: (input) => {
        seen.push(input.now.toISOString());
        return true;
      },
    };

    await withServer(async (port) => {
      const wallet = createTestWallet();
      const response = await postJson(port, '/api/auth/nonce', {
        walletAddress: wallet.walletAddress,
      });

      expect(response.status).toBe(200);
    }, { authRateLimiter, clock });

    expect(seen).toEqual(['2026-05-08T19:00:00.000Z']);
  });

  it('clears the session on logout', async () => {
    await withServer(async (port) => {
      const wallet = createTestWallet();
      const nonce = await createNonce(port, wallet);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));
      const cookie = sessionCookie(verify);

      const logout = await postJson(port, '/api/auth/logout', {}, { cookie });
      const session = await getJson(port, '/api/session', { cookie });

      expect(logout.status).toBe(200);
      expect(parseSessionResponse(logout.body)).toMatchObject({
        signedIn: false,
        capabilities: {
          mode: 'agentic_cloud',
        },
      });
      expect(firstSetCookie(logout)).toContain('Max-Age=0');
      expect(session.status).toBe(200);
      expect(parseSessionResponse(session.body)).toMatchObject({
        signedIn: false,
        capabilities: {
          mode: 'agentic_cloud',
        },
      });
    });
  });

  it('deletes signed-in cloud workspace data after a wallet-signed deletion intent', async () => {
    const store = new MemoryWorkflowStore();
    const wallet = createTestWallet();
    const recipient = createTestWallet();
    await withServer(async (port) => {
      // Match the fixed clock used when creating sessions below so server-side
      // session expiry checks don't trip the 7-day TTL relative to real wall
      // clock.
      const nonce = await createNonce(port, wallet);
      const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));
      const cookie = sessionCookie(verify);
      await seedCloudWorkspace(store, wallet.walletAddress, recipient.walletAddress);

      const recurring = await postJson(port, '/api/recurring', validRecurringBody(recipient.walletAddress), { cookie });
      expect(recurring.status).toBe(201);

      const evidenceMessage = [
        'Evidence receipt: Cloud delete test',
        `Wallet: ${wallet.walletAddress}`,
        'Approval: approval_delete',
      ].join('\n');
      const evidence = await postJson(port, '/api/evidence', {
        title: 'Cloud delete test',
        kind: 'intent_receipt',
        status: 'approved',
        cluster: 'devnet',
        payload: { summary: 'Delete this cloud receipt' },
        preSignatureHash: '0x' + 'a'.repeat(64),
        signingMessage: evidenceMessage,
        signature: signMessage(evidenceMessage, wallet.privateKey),
      }, { cookie });
      expect(evidence.status).toBe(201);

      const intent = await postJson(port, '/api/cloud-workspace/delete-intent', {}, { cookie });
      expect(intent.status).toBe(200);
      expect(String(intent.body.message)).toContain('permanently deletes Agentic Cloud workspace data');

      const deleted = await postJson(
        port,
        '/api/cloud-workspace/delete',
        signedDeleteBody(wallet, intent.body),
        { cookie },
      );
      expect(deleted.status).toBe(200);
      expect(deleted.body).toMatchObject({
        ok: true,
        signedOut: true,
        deleted: {
          plans: 1,
          approvals: 1,
          transactionFinalizations: 1,
          completedRecords: 1,
          recurringSchedules: 1,
          evidenceReceipts: 1,
          skillManifests: 1,
          skillInstalls: 1,
          skillExecutions: 1,
          signalFeeds: 1,
          signalSubscriptions: 1,
          signalEmissions: 1,
          aggregatorSnapshots: 2,
        },
      });
      expect(firstSetCookie(deleted)).toContain('Max-Age=0');

      const oldSession = await getJson(port, '/api/session', { cookie });
      expect(parseSessionResponse(oldSession.body).signedIn).toBe(false);

      const nextSession = await createWalletSession({
        store,
        walletAddress: wallet.walletAddress,
        clock: fixedClock('2026-05-08T18:10:00.000Z'),
      });
      const nextCookie = `agentic_session=${nextSession.token}`;
      expect((await getJson(port, '/api/plans', { cookie: nextCookie })).body.plans).toEqual([]);
      expect((await getJson(port, '/api/approvals', { cookie: nextCookie })).body.approvals).toEqual([]);
      expect((await getJson(port, '/api/completed', { cookie: nextCookie })).body.completed).toEqual([]);
      expect((await getJson(port, '/api/evidence', { cookie: nextCookie })).body.receipts).toEqual([]);
      expect((await getJson(port, '/api/recurring', { cookie: nextCookie })).body.schedules).toEqual([]);
      expect((await getJson(port, '/api/audit', { cookie: nextCookie })).body.events).toEqual([]);
      expect(await store.getSkillManifest('delete-skill')).toBeUndefined();
      expect(await store.getSkillManifest('kept-skill')).toMatchObject({ id: 'kept-skill' });
      expect(await store.listSkillInstallsForWallet(wallet.walletAddress)).toEqual([]);
      expect(await store.listSkillExecutionsByInstall('skill_install_delete')).toEqual([]);
      expect(await store.listSignalFeedsByPublisher(wallet.walletAddress)).toEqual([]);
      expect(await store.listSignalSubscriptionsForFollower(wallet.walletAddress)).toEqual([]);
      expect(await store.listUndeliveredSignalEmissions()).toEqual([]);
      expect(await store.getAggregatorSnapshot(`wallet:${wallet.walletAddress}`)).toBeUndefined();
      expect(await store.getAggregatorSnapshot('skill:delete-skill')).toBeUndefined();
      expect(await store.getAggregatorSnapshot('skill:kept-skill')).toMatchObject({ key: 'skill:kept-skill' });
    }, { store, clock: fixedClock('2026-05-08T18:10:00.000Z') });
  });

  it('marks session cookies secure in Render production', async () => {
    await withEnv({ RENDER: 'true' }, async () => {
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const headers = { referer: `http://127.0.0.1:${port}/app/` };
        const nonce = await postJson(port, '/api/auth/nonce', {
          walletAddress: wallet.walletAddress,
        }, headers);
        expect(nonce.status).toBe(200);
        const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body), headers);

        expect(verify.status).toBe(200);
        expect(firstSetCookie(verify)).toContain('Secure');
      });
    });
  });

  it('uses SESSION_SECRET when hashing session cookies', async () => {
    const store = new MemoryWorkflowStore();
    const clock = fixedClock('2026-05-08T18:00:00.000Z');
    const wallet = createTestWallet();

    await withEnv({ SESSION_SECRET: 'alpha-secret' }, async () => {
      const created = await createWalletSession({ store, walletAddress: wallet.walletAddress, clock });
      const req = requestWithCookie(`agentic_session=${created.token}`);

      expect(await sessionFromRequest({ req, store, clock })).toMatchObject({
        walletAddress: wallet.walletAddress,
      });

      await withEnv({ SESSION_SECRET: 'beta-secret' }, async () => {
        expect(await sessionFromRequest({ req, store, clock })).toBeUndefined();
      });
    });
  });

  it('keeps audit events scoped by wallet address', async () => {
    const store = new MemoryWorkflowStore();
    const walletA = createTestWallet().walletAddress;
    const walletB = createTestWallet().walletAddress;

    await store.forWallet(walletA).insertAuditEvent({
      id: 'audit_1',
      type: 'test.audit',
      createdAt: '2026-05-08T18:00:00.000Z',
    });

    expect(await store.forWallet(walletA).listAuditEvents()).toHaveLength(1);
    expect(await store.forWallet(walletB).listAuditEvents()).toEqual([]);
  });

  it('lists audit events by related source record metadata', async () => {
    const store = new MemoryWorkflowStore();
    const clock = fixedClock('2026-05-08T18:00:00.000Z');
    const wallet = createTestWallet();
    const session = await createWalletSession({ store, walletAddress: wallet.walletAddress, clock });
    await store.forWallet(wallet.walletAddress).insertAuditEvent({
      id: 'audit_evidence_1',
      type: 'evidence.created',
      createdAt: '2026-05-08T18:00:01.000Z',
      metadata: {
        recordType: 'evidence',
        recordId: 'evidence_1',
        sourceRecordType: 'approval',
        sourceRecordId: 'approval_1',
        approvalId: 'approval_1',
      },
    });
    await store.forWallet(wallet.walletAddress).insertAuditEvent({
      id: 'audit_evidence_2',
      type: 'evidence.created',
      createdAt: '2026-05-08T18:00:02.000Z',
      metadata: {
        recordType: 'evidence',
        recordId: 'evidence_2',
        sourceRecordType: 'approval',
        sourceRecordId: 'approval_2',
        approvalId: 'approval_2',
      },
    });

    await withServer(async (port) => {
      const response = await getJson(port, '/api/audit?recordType=approval&recordId=approval_1', {
        cookie: `agentic_session=${session.token}`,
      });

      expect(response.status).toBe(200);
      expect((response.body.events as Array<Record<string, unknown>>).map((event) => event.id)).toEqual(['audit_evidence_1']);
    }, { store, clock });
  });

  it('lists real evidence-created audit events by related approval metadata', async () => {
    const store = new MemoryWorkflowStore();
    const clock = fixedClock('2026-05-08T18:00:00.000Z');
    const wallet = createTestWallet();
    const session = await createWalletSession({ store, walletAddress: wallet.walletAddress, clock });
    const signingMessage = [
      'Evidence receipt: Proof of Intent',
      `Wallet: ${wallet.walletAddress}`,
      'Approval: approval_1',
    ].join('\n');

    await withServer(async (port) => {
      const cookie = `agentic_session=${session.token}`;
      const created = await postJson(port, '/api/evidence', {
        title: 'Proof of Intent',
        kind: 'intent_receipt',
        status: 'approved',
        cluster: 'devnet',
        payload: { status: 'approved', summary: 'Intent proof for approval_1' },
        preSignatureHash: '0x' + 'a'.repeat(64),
        signingMessage,
        signature: signMessage(signingMessage, wallet.privateKey),
        metadata: {
          recordType: 'approval',
          recordId: 'approval_1',
          sourceRecordType: 'approval',
          sourceRecordId: 'approval_1',
          approvalId: 'approval_1',
          proofUseCase: 'intent',
          labId: 'intent-receipt',
        },
      }, { cookie });
      expect(created.status).toBe(201);

      const response = await getJson(port, '/api/audit?recordType=approval&recordId=approval_1', { cookie });
      expect(response.status).toBe(200);
      const events = response.body.events as Array<Record<string, unknown>>;
      expect(events.map((event) => event.type)).toEqual(['evidence.created']);
      expect(events[0]?.metadata).toMatchObject({
        recordType: 'evidence',
        recordId: (created.body.receipt as Record<string, unknown>).id,
        sourceRecordType: 'approval',
        sourceRecordId: 'approval_1',
        approvalId: 'approval_1',
        proofUseCase: 'intent',
      });
    }, { store, clock });
  });

  describe('per-wallet agent payment profile', () => {
    const VALID_PAYLOAD = {
      version: 1,
      discoverable: true,
      displayName: "Mathew's Wallet",
      acceptedTokens: ['USDC', 'USDT', 'SOL'],
      protocols: ['ap2', 'acp', 'a2a'],
    };

    function signedProfileBody(wallet: TestWallet, intent: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        walletAddress: wallet.walletAddress,
        nonce: intent.nonce,
        message: intent.message,
        signature: signMessage(String(intent.message), wallet.privateKey),
        domain: intent.domain,
        issuedAt: intent.issuedAt,
        expiresAt: intent.expiresAt,
        signatureEncoding: 'base58',
        ...extra,
      };
    }

    it('publish flow: intent → sign → PUT → GET per-wallet card resolves; takedown 404s the URL', async () => {
      const store = new MemoryWorkflowStore();
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const nonce = await createNonce(port, wallet);
        const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));
        const cookie = sessionCookie(verify);

        const intent = await postJson(port, '/api/agents/profile-intent', {
          action: 'publish',
          payload: VALID_PAYLOAD,
        }, { cookie });
        expect(intent.status).toBe(200);
        expect(String(intent.body.message)).toContain('publish your agent payment profile');
        expect(String(intent.body.message)).toMatch(/Payload SHA-256: [0-9a-f]{64}/);

        const published = await requestJson(
          port,
          '/api/agents/profile',
          'PUT',
          { ...signedProfileBody(wallet, intent.body), payload: VALID_PAYLOAD },
          { cookie },
        );
        expect(published.status).toBe(200);
        expect((published.body as { profile: { payload: { discoverable: boolean } } }).profile.payload.discoverable).toBe(true);

        const card = await requestJson(port, `/agents/${wallet.walletAddress}/card.json`, 'GET', undefined, {});
        expect(card.status).toBe(200);
        expect((card.body as { walletAddress: string; name: string }).walletAddress).toBe(wallet.walletAddress);
        expect((card.body as { walletAddress: string; name: string }).name).toBe("Mathew's Wallet");

        const takeIntent = await postJson(port, '/api/agents/profile-intent', { action: 'takedown' }, { cookie });
        expect(takeIntent.status).toBe(200);
        expect(String(takeIntent.body.message)).toContain('take down your agent payment profile');

        const takendown = await requestJson(
          port,
          '/api/agents/profile',
          'DELETE',
          signedProfileBody(wallet, takeIntent.body),
          { cookie },
        );
        expect(takendown.status).toBe(200);

        const after = await requestJson(port, `/agents/${wallet.walletAddress}/card.json`, 'GET', undefined, {});
        expect(after.status).toBe(404);
      }, { store });
    });

    it('rejects publish when the payload differs from the hash embedded in the signed message', async () => {
      const store = new MemoryWorkflowStore();
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const nonce = await createNonce(port, wallet);
        const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));
        const cookie = sessionCookie(verify);

        const intent = await postJson(port, '/api/agents/profile-intent', {
          action: 'publish',
          payload: VALID_PAYLOAD,
        }, { cookie });
        expect(intent.status).toBe(200);

        const tamperedPayload = { ...VALID_PAYLOAD, displayName: 'Substituted Wallet' };
        const tampered = await requestJson(
          port,
          '/api/agents/profile',
          'PUT',
          { ...signedProfileBody(wallet, intent.body), payload: tamperedPayload },
          { cookie },
        );
        expect(tampered.status).toBe(401);
        expect(String((tampered.body as { error: string }).error)).toContain('Signed message');
      }, { store });
    });

    it('rejects publish signed by the wrong wallet', async () => {
      const store = new MemoryWorkflowStore();
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const attacker = createTestWallet();
        const nonce = await createNonce(port, wallet);
        const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));
        const cookie = sessionCookie(verify);

        const intent = await postJson(port, '/api/agents/profile-intent', {
          action: 'publish',
          payload: VALID_PAYLOAD,
        }, { cookie });
        expect(intent.status).toBe(200);

        const body = signedProfileBody(wallet, intent.body);
        body.signature = signMessage(String(intent.body.message), attacker.privateKey);
        const response = await requestJson(
          port,
          '/api/agents/profile',
          'PUT',
          { ...body, payload: VALID_PAYLOAD },
          { cookie },
        );
        expect(response.status).toBe(401);
      }, { store });
    });

    it('rejects re-using a consumed nonce', async () => {
      const store = new MemoryWorkflowStore();
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const nonce = await createNonce(port, wallet);
        const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));
        const cookie = sessionCookie(verify);

        const intent = await postJson(port, '/api/agents/profile-intent', {
          action: 'publish',
          payload: VALID_PAYLOAD,
        }, { cookie });
        const body = { ...signedProfileBody(wallet, intent.body), payload: VALID_PAYLOAD };

        const first = await requestJson(port, '/api/agents/profile', 'PUT', body, { cookie });
        expect(first.status).toBe(200);

        const second = await requestJson(port, '/api/agents/profile', 'PUT', body, { cookie });
        expect(second.status).toBe(401);
      }, { store });
    });

    it('rejects unauthenticated callers on the generic PUT preferences route for this namespace', async () => {
      const store = new MemoryWorkflowStore();
      await withServer(async (port) => {
        const wallet = createTestWallet();
        const nonce = await createNonce(port, wallet);
        const verify = await postJson(port, '/api/auth/verify-wallet', signedVerifyBody(wallet, nonce.body));
        const cookie = sessionCookie(verify);

        const response = await requestJson(
          port,
          '/api/preferences/agent-payment-profile',
          'PUT',
          { payload: VALID_PAYLOAD },
          { cookie },
        );
        expect(response.status).toBe(405);
      }, { store });
    });
  });
});

async function withServer(
  callback: (port: number) => Promise<void>,
  options: { authRateLimiter?: AuthRateLimiter | false; clock?: Clock; store?: MemoryWorkflowStore } = {},
): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-render-web-auth-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(staticDir, 'app'));
  await writeFile(join(staticDir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');
  const server = createRenderWebServer({
    staticDir,
    clock: options.clock,
    authRateLimiter: options.authRateLimiter,
    store: options.store,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function createNonce(port: number, wallet: TestWallet): Promise<JsonResponse> {
  const response = await postJson(port, '/api/auth/nonce', {
    walletAddress: wallet.walletAddress,
  });
  expect(response.status).toBe(200);
  return response;
}

function signedVerifyBody(wallet: TestWallet, nonce: Record<string, unknown>): Record<string, unknown> {
  return {
    walletAddress: wallet.walletAddress,
    nonce: nonce.nonce,
    message: nonce.message,
    signature: signMessage(String(nonce.message), wallet.privateKey),
    domain: nonce.domain,
    issuedAt: nonce.issuedAt,
    expiresAt: nonce.expiresAt,
    signatureEncoding: 'base58',
  };
}

function signedDeleteBody(wallet: TestWallet, intent: Record<string, unknown>): Record<string, unknown> {
  return {
    walletAddress: wallet.walletAddress,
    nonce: intent.nonce,
    message: intent.message,
    signature: signMessage(String(intent.message), wallet.privateKey),
    domain: intent.domain,
    issuedAt: intent.issuedAt,
    expiresAt: intent.expiresAt,
    signatureEncoding: 'base58',
  };
}

async function seedCloudWorkspace(
  store: MemoryWorkflowStore,
  walletAddress: string,
  recipient: string,
): Promise<void> {
  const now = '2026-05-08T18:00:00.000Z';
  const plan = samplePlan(walletAddress, recipient, now);
  const approval = sampleApproval(walletAddress, recipient, now, plan.id);
  await store.savePlan(walletAddress, plan);
  await store.saveApproval(walletAddress, approval);
  await store.saveFinalization(walletAddress, sampleFinalization(walletAddress, recipient, now, approval.id, plan.id));
  await store.saveCompleted(walletAddress, sampleCompleted(walletAddress, recipient, now, approval.id, plan.id));
  await store.forWallet(walletAddress).insertAuditEvent({
    id: 'audit_delete',
    type: 'test.delete_seeded',
    createdAt: now,
    metadata: {
      recordType: 'approval',
      recordId: approval.id,
    },
  });
  await store.saveSkillManifest({
    id: 'delete-skill',
    version: '1.0.0',
    authorWallet: walletAddress,
    createdAt: now,
    updatedAt: now,
    manifest: {
      id: 'delete-skill',
      name: 'Delete Skill',
      version: '1.0.0',
      authorWallet: walletAddress,
      description: 'Skill slated for workspace deletion',
      category: 'custom',
      schedule: { kind: 'interval', spec: '7d' },
      action: { connectorAction: 'prepare_swap', paramsTemplate: { inputToken: 'USDC', amount: '1' } },
      caps: {
        perRunMaxAmount: '1',
        lifetimeMaxAmount: '10',
        allowlistedTokens: ['USDC'],
      },
    },
  });
  await store.saveSkillManifest({
    id: 'kept-skill',
    version: '1.0.0',
    authorWallet: recipient,
    createdAt: now,
    updatedAt: now,
    manifest: {
      id: 'kept-skill',
      name: 'Kept Skill',
      version: '1.0.0',
      authorWallet: recipient,
      description: 'Skill owned by another wallet',
      category: 'custom',
      schedule: { kind: 'interval', spec: '7d' },
      action: { connectorAction: 'prepare_swap', paramsTemplate: { inputToken: 'USDC', amount: '1' } },
      caps: {
        perRunMaxAmount: '1',
        lifetimeMaxAmount: '10',
        allowlistedTokens: ['USDC'],
      },
    },
  });
  await store.saveSkillInstall({
    id: 'skill_install_delete',
    walletAddress,
    skillId: 'delete-skill',
    status: 'active',
    installedAt: now,
    updatedAt: now,
    install: {
      id: 'skill_install_delete',
      walletAddress,
      skillId: 'delete-skill',
      manifestVersion: '1.0.0',
      caps: {
        perRunMaxAmount: '1',
        lifetimeMaxAmount: '10',
        allowlistedTokens: ['USDC'],
      },
      installedAt: now,
      updatedAt: now,
      status: 'active',
    },
  });
  await store.saveSkillExecution({
    id: 'skill_exec_delete',
    installId: 'skill_install_delete',
    walletAddress,
    skillId: 'delete-skill',
    proposedAt: now,
    result: 'success',
    execution: {
      id: 'skill_exec_delete',
      installId: 'skill_install_delete',
      walletAddress,
      skillId: 'delete-skill',
      proposedAt: now,
      result: 'success',
    },
  });
  await store.saveSignalFeed({
    id: 'feed_delete',
    publisherWallet: walletAddress,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    feed: {
      id: 'feed_delete',
      publisherWallet: walletAddress,
      name: 'Delete feed',
      description: 'Feed slated for deletion',
      createdAt: now,
      updatedAt: now,
      status: 'active',
    },
  });
  await store.saveSignalFeed({
    id: 'feed_keep',
    publisherWallet: recipient,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    feed: {
      id: 'feed_keep',
      publisherWallet: recipient,
      name: 'Kept feed',
      description: 'Feed owned by another wallet',
      createdAt: now,
      updatedAt: now,
      status: 'active',
    },
  });
  await store.saveSignalSubscription({
    id: 'sub_delete',
    followerWallet: walletAddress,
    feedId: 'feed_keep',
    status: 'active',
    subscribedAt: now,
    updatedAt: now,
    subscription: {
      id: 'sub_delete',
      followerWallet: walletAddress,
      feedId: 'feed_keep',
      status: 'active',
      subscribedAt: now,
      updatedAt: now,
      caps: {
        perRunMaxAmount: '1',
        lifetimeMaxAmount: '10',
        allowlistedTokens: ['USDC'],
      },
    },
  });
  await store.saveSignalEmission({
    id: 'emission_delete',
    feedId: 'feed_delete',
    publisherWallet: walletAddress,
    emittedAt: now,
    delivered: 0,
    emission: {
      id: 'emission_delete',
      feedId: 'feed_delete',
      publisherWallet: walletAddress,
      emittedAt: now,
      sourceTxid: '5'.repeat(64),
      actionTemplate: { connectorAction: 'prepare_swap', inputToken: 'USDC', amount: '1' },
      delivered: 0,
    },
  });
  await store.saveAggregatorSnapshot({
    key: `wallet:${walletAddress}`,
    kind: 'wallet',
    computedAt: now,
    snapshot: { walletAddress, totalExecutions: 1 },
  });
  await store.saveAggregatorSnapshot({
    key: 'skill:delete-skill',
    kind: 'skill',
    computedAt: now,
    snapshot: { skillId: 'delete-skill', totalExecutions: 1 },
  });
  await store.saveAggregatorSnapshot({
    key: 'skill:kept-skill',
    kind: 'skill',
    computedAt: now,
    snapshot: { skillId: 'kept-skill', totalExecutions: 1 },
  });
}

function samplePlan(walletAddress: string, recipient: string, now: string): PlanDraftRecord {
  return {
    id: 'plan_delete',
    walletAddress,
    plan: samplePlanPayload(recipient),
    title: 'Delete test plan',
    intent: 'Send 0.25 SOL to recipient',
    route: 'Wallet approval required.',
    risk: 'Medium risk.',
    approval: 'Review in wallet before signing.',
    source: 'template',
    category: 'payments',
    actionType: 'transfer_sol',
    parameters: {
      recipient,
      amount: '0.25',
    },
    fields: [
      { label: 'Recipient address', value: recipient },
      { label: 'Amount SOL', value: '0.25' },
    ],
    safeguards: ['Wallet approval is required.'],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    templateId: 'transfer-sol',
    templateTitle: 'Send SOL',
    prompt: 'Send 0.25 SOL',
    cluster: 'devnet',
  };
}

function sampleApproval(
  walletAddress: string,
  recipient: string,
  now: string,
  planDraftId: string,
): ApprovalRequestRecord {
  return {
    id: 'approval_delete',
    walletAddress,
    planDraftId,
    kind: 'transfer_sol',
    status: 'ready',
    summary: 'Delete test approval',
    params: {
      recipient,
      amount: '0.25',
    },
    cluster: 'devnet',
    dueAt: now,
    createdAt: now,
    updatedAt: now,
    finalizationRequirement: 'transaction_preview',
  };
}

function sampleCompleted(
  walletAddress: string,
  recipient: string,
  now: string,
  approvalRequestId: string,
  planDraftId: string,
): CompletedRecord {
  return {
    id: 'completed_delete',
    kind: 'one_time',
    status: 'approved',
    title: 'Delete test completed',
    summary: 'Completed record slated for deletion',
    walletAddress,
    createdAt: now,
    completedAt: now,
    cluster: 'devnet',
    amount: '0.25',
    token: 'SOL',
    recipient,
    approvalRequestId,
    planDraftId,
    copyPayload: { approvalRequestId },
    detailRows: [['Status', 'approved']],
  };
}

function sampleFinalization(
  walletAddress: string,
  recipient: string,
  now: string,
  approvalRequestId: string,
  planDraftId: string,
): TransactionFinalizationRecord {
  return {
    id: 'finalization_delete',
    walletAddress,
    approvalRequestId,
    planDraftId,
    kind: 'transfer_sol',
    status: 'prepared',
    cluster: 'devnet',
    walletAction: {
      kind: 'transfer_sol',
      walletAddress,
      cluster: 'devnet',
      summary: 'Delete test finalization',
      sender: walletAddress,
      recipient,
      amount: '0.25',
      token: 'SOL',
      instructionSummary: ['Transfer 0.25 SOL'],
      touchedPrograms: ['11111111111111111111111111111111'],
    },
    transactionHash: '0x' + 'b'.repeat(64),
    createdAt: now,
    updatedAt: now,
    expiresAt: '2026-05-08T18:10:00.000Z',
  };
}

function samplePlanPayload(recipient: string): JsonObject {
  return {
    intent: 'Send 0.25 SOL to recipient',
    route: 'Wallet approval required.',
    risk: 'Medium risk.',
    approval: 'Review in wallet before signing.',
    source: 'template',
    category: 'payments',
    actionType: 'transfer_sol',
    templateTitle: 'Send SOL',
    parameters: {
      recipient,
      amount: '0.25',
    },
    fields: [
      { label: 'Recipient address', value: recipient },
      { label: 'Amount SOL', value: '0.25' },
    ],
    safeguards: ['Wallet approval is required.'],
  };
}

function validRecurringBody(recipient: string): Record<string, unknown> {
  return {
    cluster: 'devnet',
    token: 'SOL',
    recipient,
    amount: '0.10',
    cadence: 'interval_minutes',
    intervalMinutes: 10,
  };
}

function createTestWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBytes = Buffer.from(publicKeyDer).subarray(-32);
  return {
    walletAddress: encodeBase58(publicKeyBytes),
    privateKey,
  };
}

function signMessage(message: string, privateKey: KeyObject): string {
  return encodeBase58(signDetached(null, Buffer.from(message, 'utf8'), privateKey));
}

function sessionCookie(response: JsonResponse): string {
  const cookie = firstSetCookie(response);
  return cookie.split(';')[0] ?? '';
}

function firstSetCookie(response: JsonResponse): string {
  const header = response.headers['set-cookie'];
  if (Array.isArray(header)) return header[0] ?? '';
  return header ?? '';
}

function mutableClock(initial: string): Clock & { set(value: string): void } {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    set: (value: string) => {
      current = new Date(value);
    },
  };
}

function fixedClock(value: string): Clock {
  return {
    now: () => new Date(value),
  };
}

function queuedClock(values: string[]): Clock {
  if (values.length === 0) {
    throw new Error('queuedClock requires at least one timestamp.');
  }
  let index = 0;
  return {
    now: () => {
      const value = values[Math.min(index, values.length - 1)]!;
      index += 1;
      return new Date(value);
    },
  };
}

class ReplayRaceStore extends MemoryWorkflowStore {
  override async consumeAuthNonce(): Promise<undefined> {
    return undefined;
  }
}

function requestWithCookie(cookie: string): IncomingMessage {
  return {
    headers: {
      cookie,
    },
  } as IncomingMessage;
}

const envStack: Array<Map<string, string | undefined>> = [];

async function withEnv<T>(env: Record<string, string>, callback: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  envStack.push(previous);
  try {
    return await callback();
  } finally {
    restoreEnv();
  }
}

function restoreEnv(): void {
  const previous = envStack.pop();
  if (!previous) return;
  for (const [key, value] of previous) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  return requestJson(port, path, 'POST', body, headers);
}

function getJson(port: number, path: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  return requestJson(port, path, 'GET', undefined, headers);
}

function requestRaw(
  port: number,
  path: string,
  method: 'GET' | 'POST' | 'OPTIONS',
  body?: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(body === undefined
          ? {}
          : {
              'content-length': Buffer.byteLength(body),
            }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: Record<string, unknown> = {};
        try {
          parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        } catch {
          parsed = { raw };
        }
        resolve({
          status: res.statusCode ?? 0,
          body: parsed,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function requestJson(
  port: number,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body: unknown,
  headers: Record<string, string>,
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(payload === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
