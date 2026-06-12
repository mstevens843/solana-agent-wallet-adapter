// Pure helpers for building the URL the CLI opens to drive the wallet UI. Kept in
// their own module so the security-critical token handling and host selection are
// unit-testable without importing the CLI entrypoint (index.ts runs main() on
// import). See resolveWalletHostLaunchBase / walletHostLaunchUrl in index.ts.

/**
 * Decide which origin actually serves the wallet UI we open:
 *  - an explicit `--wallet-host-url` / env value (source !== 'default') always
 *    wins and is served locally, exactly as before;
 *  - otherwise prefer the Render-hosted UI when reachable, so its pages
 *    auto-update on Render redeploy with no CLI republish;
 *  - fall back to the bundled local host when Render is unreachable (offline /
 *    air-gapped). The local *bridge* (signing) is unaffected either way.
 */
export function pickWalletHostLaunchBase(input: {
  source: 'default' | 'env' | 'flag';
  walletHostUrl: string;
  remote: string;
  remoteReachable: boolean;
}): string {
  if (input.source !== 'default') return input.walletHostUrl;
  return input.remoteReachable ? input.remote : input.walletHostUrl;
}

/**
 * Carry the bridge token in the URL fragment (`#token=…`) rather than the query
 * string, so a remote wallet-host origin (e.g. Render) never receives or logs the
 * local bridge token (fragments are never sent to the server). browser-demo reads
 * the token from the hash or the query, so this stays backward compatible.
 */
export function setWalletHostLaunchToken(url: URL, token: string): void {
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  hash.set('token', token);
  url.hash = hash.toString();
}

/** Redact the bridge token from a launch URL for logs/diagnostics (query OR fragment). */
export function redactWalletHostLaunchUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', 'redacted');
    }
    if (url.hash) {
      const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
      if (hash.has('token')) {
        hash.set('token', 'redacted');
        url.hash = hash.toString();
      }
    }
    return url.toString();
  } catch {
    return raw.replace(/([?&#]token=)[^&]+/i, '$1redacted');
  }
}
