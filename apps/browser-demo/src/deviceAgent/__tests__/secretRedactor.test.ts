// Ported from
// apps/android-twa/app/src/test/java/com/agentic/wallet/agent/provider/SecretRedactorTest.kt.
// Pins each redactor regex against the same inputs the Kotlin tests use so
// drift between android-native and browser-native error surfaces is impossible.

import { describe, expect, it } from 'vitest';

import { redactSecret } from '../provider/secretRedactor.js';

describe('redactSecret', () => {
  it('replaces the exact secret when provided', () => {
    const secret = 'sk-test-1234567890ABCDEF';
    const redacted = redactSecret(`Authorization failed for ${secret}`, secret);
    expect(redacted.includes(secret)).toBe(false);
    expect(redacted.includes('[redacted]')).toBe(true);
  });

  it('trims the secret before replacing', () => {
    expect(redactSecret('Failed: foo-secret', '  foo-secret  ')).toBe('Failed: [redacted]');
  });

  it('is a no-op when the secret is blank, null, or undefined', () => {
    expect(redactSecret('hello world', '')).toBe('hello world');
    expect(redactSecret('hello world', null)).toBe('hello world');
    expect(redactSecret('hello world', undefined)).toBe('hello world');
    expect(redactSecret('hello world', '   ')).toBe('hello world');
  });

  it('redacts the Bearer pattern', () => {
    const redacted = redactSecret('got Bearer abcDEF.123-456_xyz token', null);
    expect(redacted.includes('Bearer [redacted]')).toBe(true);
    expect(redacted.includes('abcDEF.123-456_xyz')).toBe(false);
  });

  it('redacts the sk-proj- pattern', () => {
    const redacted = redactSecret('error sk-proj-ABCDEF12345 occurred', null);
    expect(redacted.includes('sk-proj-[redacted]')).toBe(true);
    expect(redacted.includes('sk-proj-ABCDEF12345')).toBe(false);
  });

  it('redacts the bare sk- pattern', () => {
    const redacted = redactSecret('error with sk-ABCDEF1234567890XYZ occurred', null);
    expect(redacted.includes('sk-[redacted]')).toBe(true);
    expect(redacted.includes('ABCDEF1234567890XYZ')).toBe(false);
  });

  it('redacts a JWT-shaped token', () => {
    const jwt = 'eyJabcd1234567890abcd.eyJsubbing0987654321abc.signaturedeadbeefcafe1234';
    const redacted = redactSecret(`got token ${jwt} then proceeded`, null);
    expect(redacted.includes('[redacted-token]')).toBe(true);
    expect(redacted.includes(jwt)).toBe(false);
  });

  it('redacts api-key/token/secret key=value style', () => {
    const redacted = redactSecret('api-key=ABCDEFGHIJKLMNOP', null);
    expect(redacted.includes('[redacted]')).toBe(true);
    expect(redacted.includes('ABCDEFGHIJKLMNOP')).toBe(false);
  });

  it('redacts every occurrence when the secret appears multiple times', () => {
    const secret = 'sk-test-multi-EXAMPLEKEY';
    const redacted = redactSecret(`first ${secret} then again ${secret} done`, secret);
    expect(redacted.includes(secret)).toBe(false);
    const matches = redacted.match(/\[redacted\]/g);
    expect(matches?.length ?? 0).toBe(2);
  });

  it('applies the regex fallback when no exact secret is supplied', () => {
    const redacted = redactSecret('calling Bearer abc123XYZ_456.token-data more text', null);
    expect(redacted.includes('Bearer [redacted]')).toBe(true);
    expect(redacted.includes('abc123XYZ_456.token-data')).toBe(false);
  });

  it('uses the with-space KEY_VALUE form (api key=…, not just api-key=…)', () => {
    // Kotlin SecretRedactor.kt uses [-_ ]? (with space). A copy that loses the
    // space will let "api key=…" through. Pin both spellings.
    const redacted = redactSecret('api key=ABCDEFGHIJKLMNOP', null);
    expect(redacted.includes('[redacted]')).toBe(true);
    expect(redacted.includes('ABCDEFGHIJKLMNOP')).toBe(false);
  });
});
