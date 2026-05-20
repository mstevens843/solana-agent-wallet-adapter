import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';

import {
  MemoryAuthRateLimiter,
  authRateLimitedRoute,
  rateLimitKey,
  runWithHostedAiTimeout,
} from '../cloud/router.js';
import { redactSecrets } from '../cloud/redaction.js';

// ─── E1: MemoryAuthRateLimiter eviction ─────────────────────────────────────

describe('MemoryAuthRateLimiter', () => {
  // Use a route with a known short window. AUTH window is 5 min in router.ts.
  // We can't override the window directly, but we CAN walk time forward via
  // the input.now Date arg, which is the only clock source the limiter reads.
  const NONCE_ROUTE = '/api/auth/nonce';

  it('grants requests up to the per-route max, then rejects', () => {
    const limiter = new MemoryAuthRateLimiter();
    const start = new Date('2026-05-20T00:00:00Z');
    let grantCount = 0;
    for (let i = 0; i < 80; i += 1) {
      if (limiter.allow({ route: NONCE_ROUTE, key: '1.2.3.4', now: start })) {
        grantCount += 1;
      }
    }
    // AUTH_RATE_LIMIT_MAX_ATTEMPTS = 60 in router.ts.
    expect(grantCount).toBe(60);
  });

  it('resets the bucket once the window has elapsed', () => {
    const limiter = new MemoryAuthRateLimiter();
    const start = new Date('2026-05-20T00:00:00Z');
    // Fill the bucket.
    for (let i = 0; i < 60; i += 1) {
      limiter.allow({ route: NONCE_ROUTE, key: '1.2.3.4', now: start });
    }
    // Same instant: rejected.
    expect(limiter.allow({ route: NONCE_ROUTE, key: '1.2.3.4', now: start })).toBe(false);
    // 5 min later: fresh window, granted.
    const later = new Date(start.getTime() + 5 * 60_000 + 1);
    expect(limiter.allow({ route: NONCE_ROUTE, key: '1.2.3.4', now: later })).toBe(true);
  });

  it('evicts stale bucket keys to bound memory under high IP churn', () => {
    const limiter = new MemoryAuthRateLimiter();
    const start = new Date('2026-05-20T00:00:00Z');
    // 200 unique IPs each ping the limiter once.
    for (let i = 0; i < 200; i += 1) {
      limiter.allow({ route: NONCE_ROUTE, key: `10.0.0.${i}`, now: start });
    }
    // Bucket map size should be 200 right now.
    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(200);
    // Jump 11 minutes forward (> SWEEP_INTERVAL_MS=60_000 AND > 2 * 5min window
    // so every prior entry should be evicted on the next allow() call's sweep).
    const wayLater = new Date(start.getTime() + 11 * 60_000);
    limiter.allow({ route: NONCE_ROUTE, key: 'new.ip', now: wayLater });
    const sizeAfterSweep = (limiter as unknown as { buckets: Map<string, unknown> }).buckets.size;
    // Only the freshly-touched key survives.
    expect(sizeAfterSweep).toBe(1);
  });
});

// ─── F2: dev-API routes are rate-limited (regression guard) ────────────────

describe('authRateLimitedRoute', () => {
  // Without these clauses, sweep 4 would have shipped a rate-limit bypass on
  // every dev-API write endpoint. Each prefix below MUST return a non-undefined
  // route key so enforceAuthRateLimit doesn't short-circuit.
  it('rate-limits /api/skills/* under WRITE bucket', () => {
    expect(authRateLimitedRoute('/api/skills')).toBe('/api/skills:*');
    expect(authRateLimitedRoute('/api/skills/install')).toBe('/api/skills:*');
    expect(authRateLimitedRoute('/api/skills/abc/manifest')).toBe('/api/skills:*');
  });

  it('rate-limits /api/signals/*', () => {
    expect(authRateLimitedRoute('/api/signals')).toBe('/api/signals:*');
    expect(authRateLimitedRoute('/api/signals/subscriptions')).toBe('/api/signals:*');
  });

  it('rate-limits /api/spend/*', () => {
    expect(authRateLimitedRoute('/api/spend')).toBe('/api/spend:*');
    expect(authRateLimitedRoute('/api/spend/annotations')).toBe('/api/spend:*');
  });

  it('rate-limits /api/streaming/*', () => {
    expect(authRateLimitedRoute('/api/streaming')).toBe('/api/streaming:*');
    expect(authRateLimitedRoute('/api/streaming/sessions/abc')).toBe('/api/streaming:*');
  });

  it('keeps the original /api/auth/* + /api/ai/* + /api/plans/* prefixes', () => {
    expect(authRateLimitedRoute('/api/auth/nonce')).toBe('/api/auth/nonce');
    expect(authRateLimitedRoute('/api/ai/generate-plan')).toBe('/api/ai/generate-plan');
    expect(authRateLimitedRoute('/api/plans/abc')).toBe('/api/plans:*');
  });

  it('returns undefined for unhandled paths (no rate limit applied)', () => {
    expect(authRateLimitedRoute('/api/ai/status')).toBeUndefined();
    expect(authRateLimitedRoute('/health')).toBeUndefined();
    expect(authRateLimitedRoute('/some/random/path')).toBeUndefined();
  });
});

// ─── E2: rateLimitKey trusts the LAST x-forwarded-for entry ─────────────────

describe('rateLimitKey', () => {
  function reqWith(headers: Record<string, string>, socketAddr = '203.0.113.99'): IncomingMessage {
    return {
      headers: { ...headers },
      socket: { remoteAddress: socketAddr } as IncomingMessage['socket'],
    } as IncomingMessage;
  }

  it('takes the last entry of x-forwarded-for (edge-asserted client IP)', () => {
    const req = reqWith({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12' });
    // 9.10.11.12 is the entry the trusted edge appended; everything before it
    // is attacker-controllable.
    expect(rateLimitKey(req)).toBe('9.10.11.12');
  });

  it('rejects a spoofed x-forwarded-for prefix from the client', () => {
    // Attacker sets `X-Forwarded-For: 1.1.1.1` to try to reset their bucket;
    // Render's edge appends the real IP after. The last entry wins.
    const req = reqWith({ 'x-forwarded-for': '1.1.1.1, 198.51.100.7' });
    expect(rateLimitKey(req)).toBe('198.51.100.7');
  });

  it('falls back to socket.remoteAddress when x-forwarded-for is missing', () => {
    expect(rateLimitKey(reqWith({}, '198.51.100.55'))).toBe('198.51.100.55');
  });

  it('handles a single-hop x-forwarded-for', () => {
    expect(rateLimitKey(reqWith({ 'x-forwarded-for': '203.0.113.10' }))).toBe('203.0.113.10');
  });
});

// ─── E3: redactSecrets covers the major BYOK provider key shapes ────────────

describe('redactSecrets extended patterns', () => {
  it('redacts Anthropic ant-* keys', () => {
    const out = redactSecrets('error: bad ant-api03_aaaaaaaaaaaaaaaaaaaa key');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('ant-api03_aaaaaaaaaaaaaaaaaaaa');
  });

  it('redacts Google Gemini AIza* keys', () => {
    const out = redactSecrets('GOOGLE_API_KEY=AIzaSyAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa returned 401');
    expect(out).not.toContain('AIzaSyAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('redacts GitHub ghp_/ghs_ tokens', () => {
    const out = redactSecrets('Auth header ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa rejected');
    expect(out).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('redacts AWS AKIA access key IDs', () => {
    const out = redactSecrets('Caller AKIAIOSFODNN7EXAMPLE got 403');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts OpenRouter sk-or-* keys', () => {
    const out = redactSecrets('Provider key sk-or-v1-aaaaaaaaaaaa rejected');
    expect(out).not.toContain('sk-or-v1-aaaaaaaaaaaa');
  });

  it('keeps the existing Bearer / sk-proj-/ JWT patterns working', () => {
    const out = redactSecrets('Bearer abc.def.ghi - sk-proj-aaaaaaaaaaaa');
    expect(out).toContain('Bearer [redacted]');
    expect(out).not.toContain('sk-proj-aaaaaaaaaaaa');
  });
});

// ─── E4: runWithHostedAiTimeout 504 rejection path ──────────────────────────

describe('runWithHostedAiTimeout', () => {
  it('resolves with the inner value when the promise wins the race', async () => {
    const fast = Promise.resolve('ok');
    await expect(runWithHostedAiTimeout(fast, 200)).resolves.toBe('ok');
  });

  it('rejects with ApiError(504) when the timer fires first', async () => {
    const never = new Promise<string>(() => {
      /* hangs forever */
    });
    await expect(runWithHostedAiTimeout(never, 25)).rejects.toMatchObject({
      status: 504,
      name: 'ApiError',
      message: 'AI provider timed out.',
    });
  });

  it('propagates upstream errors instead of swallowing them as timeouts', async () => {
    const upstreamErr = new Error('provider returned 502');
    const rejecting = Promise.reject(upstreamErr);
    // Use a long timeout so the inner rejection definitely wins.
    await expect(runWithHostedAiTimeout(rejecting, 5_000)).rejects.toBe(upstreamErr);
  });
});
