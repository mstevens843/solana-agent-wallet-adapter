// TypeScript port of SecretRedactor.kt. Patterns and replacement order are
// byte-for-byte identical with the Kotlin runtime so the same error message,
// passed through either redactor, produces the same redacted string.
//
// KEY_VALUE_PATTERN uses `[-_ ]?` (with a literal space) per Kotlin —
// "When in doubt, Kotlin wins."

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SK_PROJ_PATTERN = /\bsk-proj-[A-Za-z0-9_-]{8,}\b/g;
const SK_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g;
const KEY_VALUE_PATTERN = /(api[-_ ]?key|token|secret)(["':=\s]+)([^"',\s[]{8,})/gi;

export function redactSecret(value: string, secret?: string | null): string {
  let current = value;
  const trimmed = (secret ?? '').trim();
  if (trimmed.length > 0) {
    // split/join avoids regex-escaping the secret.
    current = current.split(trimmed).join('[redacted]');
  }
  current = current.replace(BEARER_PATTERN, 'Bearer [redacted]');
  current = current.replace(SK_PROJ_PATTERN, 'sk-proj-[redacted]');
  current = current.replace(SK_PATTERN, 'sk-[redacted]');
  current = current.replace(JWT_PATTERN, '[redacted-token]');
  current = current.replace(KEY_VALUE_PATTERN, (_match, label: string, sep: string) => `${label}${sep}[redacted]`);
  return current;
}
