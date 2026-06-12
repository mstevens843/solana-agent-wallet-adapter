// The bridge token a CLI/desktop launch URL carries. The CLI now passes it in the
// URL fragment (`#token=…`) so a remote wallet-host origin (e.g. Render) never
// receives or logs it — fragments are never sent to the server. Older launch URLs
// and other flows (QR pairing, mobile deeplinks) still use `?token=`, so we read
// the fragment first and fall back to the query. Kept standalone so it is unit-
// testable without importing main.ts.
export function readBridgeLaunchToken(search: string, hash: string): string | undefined {
  const fromFragment = new URLSearchParams((hash || '').replace(/^#/, '')).get('token');
  const fromQuery = new URLSearchParams(search || '').get('token');
  return (fromFragment ?? fromQuery)?.trim() || undefined;
}
