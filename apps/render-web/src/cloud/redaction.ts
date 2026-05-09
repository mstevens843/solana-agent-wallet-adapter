export function redactSecrets(value: string, exactSecret = ''): string {
  const secret = exactSecret.trim();
  const exactRedacted = secret ? value.split(secret).join('[redacted]') : value;
  return exactRedacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-proj-[A-Za-z0-9._-]{8,}/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/(api[-_ ]?key|token|secret)(["':=\s]+)([^"',\s]{8,})/gi, '$1$2[redacted]');
}
