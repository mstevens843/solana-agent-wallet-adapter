export function redactSecrets(value: string, exactSecret = ''): string {
  const secret = exactSecret.trim();
  const exactRedacted = secret ? value.split(secret).join('[redacted]') : value;
  // The exactSecret substring-replace above is the primary defense for the
  // session's known key. The patterns below are defense-in-depth backups for
  // cases where the key arrives in an error message with mangled spacing or
  // partial corruption, or where a key from a DIFFERENT provider appears in
  // an upstream stack trace. Covers OpenAI (sk-, sk-proj-), Anthropic (ant-),
  // Google Gemini (AIza), GitHub (ghp_/ghs_), AWS (AKIA), and generic JWT /
  // api_key=value shapes. Each prefix has its own line to keep the regex
  // simple — no nested quantifiers means no ReDoS exposure.
  return exactRedacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-proj-[A-Za-z0-9._-]{8,}/g, '[redacted]')
    .replace(/sk-or-[A-Za-z0-9._-]{8,}/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, '[redacted]')
    .replace(/\bant-[A-Za-z0-9._-]{16,}/g, '[redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .replace(/\bgh[ps]_[A-Za-z0-9]{20,}/g, '[redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/(api[-_ ]?key|token|secret)(["':=\s]+)([^"',\s]{8,})/gi, '$1$2[redacted]');
}
