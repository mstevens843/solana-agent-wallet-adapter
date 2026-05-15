import { describe, expect, it } from 'vitest';

import {
  ALLOWED_PROFILE_PROTOCOLS,
  ALLOWED_PROFILE_TOKENS,
  PROFILE_PAYLOAD_VERSION,
  canonicalizeProfilePayload,
  hashProfilePayload,
  validateProfilePayload,
  type AgentPaymentProfilePayload,
} from '../profilePayload.js';

function basePayload(): AgentPaymentProfilePayload {
  return {
    version: PROFILE_PAYLOAD_VERSION,
    discoverable: true,
    displayName: "Mathew's Wallet",
    acceptedTokens: ['USDC', 'USDT', 'SOL'],
    protocols: ['ap2', 'acp', 'a2a'],
  };
}

describe('canonicalizeProfilePayload', () => {
  it('produces a deterministic byte-identical string regardless of input order', () => {
    const a = canonicalizeProfilePayload(basePayload());
    const b = canonicalizeProfilePayload({
      ...basePayload(),
      acceptedTokens: ['SOL', 'USDT', 'USDC'],
      protocols: ['a2a', 'ap2', 'acp'],
    });
    expect(a).toBe(b);
  });

  it('omits empty optional fields and includes trimmed populated ones', () => {
    const withEmail = canonicalizeProfilePayload({ ...basePayload(), contactEmail: '  ops@example.com  ' });
    const withoutEmail = canonicalizeProfilePayload({ ...basePayload(), contactEmail: '   ' });
    expect(withEmail).toContain('"contactEmail":"ops@example.com"');
    expect(withoutEmail).not.toContain('contactEmail');
  });

  it('drops unknown tokens and protocols silently (cleaned by validation, defense in depth)', () => {
    const canonical = canonicalizeProfilePayload({
      ...basePayload(),
      acceptedTokens: ['USDC', 'JUNK' as never, 'USDT'],
      protocols: ['ap2', 'unknown' as never],
    });
    expect(canonical).toContain('"acceptedTokens":["USDC","USDT"]');
    expect(canonical).toContain('"protocols":["ap2"]');
  });

  it('matches a golden fixture so future canonicalization changes are caught', () => {
    expect(canonicalizeProfilePayload(basePayload())).toBe(
      '{"acceptedTokens":["SOL","USDC","USDT"],"discoverable":true,"displayName":"Mathew\'s Wallet","protocols":["a2a","acp","ap2"],"version":1}',
    );
  });
});

describe('hashProfilePayload', () => {
  it('returns a stable 64-char lowercase hex digest', async () => {
    const hash = await hashProfilePayload(basePayload());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash is identical when the payload is canonically identical', async () => {
    const a = await hashProfilePayload(basePayload());
    const b = await hashProfilePayload({
      ...basePayload(),
      acceptedTokens: ['SOL', 'USDT', 'USDC'],
    });
    expect(a).toBe(b);
  });

  it('hash matches the documented golden fixture (locks server/client byte agreement)', async () => {
    expect(await hashProfilePayload(basePayload())).toBe(
      '65af41adc24e4c15199aa2a752f65ed40a501155be758993abc80503877f4f2c',
    );
  });
});

describe('validateProfilePayload', () => {
  it('accepts a well-formed payload and returns the normalized copy', () => {
    const result = validateProfilePayload(basePayload());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.displayName).toBe("Mathew's Wallet");
      expect(result.payload.acceptedTokens).toEqual(['SOL', 'USDC', 'USDT']);
      expect(result.payload.protocols).toEqual(['a2a', 'acp', 'ap2']);
    }
  });

  it('requires display name when discoverable', () => {
    const result = validateProfilePayload({ ...basePayload(), displayName: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.field === 'displayName')).toBe(true);
    }
  });

  it('requires at least one token + protocol when discoverable', () => {
    const result = validateProfilePayload({ ...basePayload(), acceptedTokens: [], protocols: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.field).sort()).toEqual(['acceptedTokens', 'protocols']);
    }
  });

  it('allows empty tokens/protocols when discoverable=false (saving a hidden draft)', () => {
    const result = validateProfilePayload({
      ...basePayload(),
      discoverable: false,
      acceptedTokens: [],
      protocols: [],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects non-allowlist tokens and protocols', () => {
    const result = validateProfilePayload({
      ...basePayload(),
      acceptedTokens: ['JUNK', 'USDC'],
      protocols: ['ap2', 'unknown'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.acceptedTokens).toEqual(['USDC']);
      expect(result.payload.protocols).toEqual(['ap2']);
    }
  });

  it('rejects malformed email', () => {
    const result = validateProfilePayload({ ...basePayload(), contactEmail: 'not-an-email' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.field === 'contactEmail')).toBe(true);
    }
  });

  it('rejects payloads larger than the serialized size cap', () => {
    const huge = 'x'.repeat(5000);
    const result = validateProfilePayload({ ...basePayload(), displayName: huge });
    expect(result.ok).toBe(false);
  });

  it('exposes the allowlists for UI use', () => {
    expect(ALLOWED_PROFILE_TOKENS).toContain('USDC');
    expect(ALLOWED_PROFILE_PROTOCOLS).toContain('ap2');
  });
});
