// Resolves the URLs used by the desktop QR cloud-pairing flow.
//
// QR pairing is inherently cross-device: the user's phone scans the QR, opens
// the wallet, and (after approval) gets redirected to a page that must be
// publicly reachable. That rules out `window.location.origin` in local dev
// (a phone can't reach `http://127.0.0.1:5174`), and the relay's own HTTPS
// gate (`apps/render-web/src/cloud/pairingHandler.ts` `isHttpsUrl`) also
// rejects http URLs. So both URLs default to the production cloud relay even
// when running `pnpm desktop:tauri:dev`. Env-var overrides are kept as an
// escape hatch for self-hosted relays / ngrok tunnels.

export interface DesktopQrConfigEnv {
  PROD?: boolean;
  VITE_AGENTIC_CLOUD_API_BASE_URL?: string;
  VITE_AGENTIC_QR_CONNECT_APP_URL?: string;
}

export const AGENTIC_PRODUCTION_ORIGIN = 'https://agentic-signer.com';

export function resolveDesktopPairingRelayBaseUrl(env: DesktopQrConfigEnv): string {
  return normalizeOriginLikeUrl(env.VITE_AGENTIC_CLOUD_API_BASE_URL) || AGENTIC_PRODUCTION_ORIGIN;
}

export function resolveQrConnectAppUrl(env: DesktopQrConfigEnv): string {
  return normalizeOriginLikeUrl(env.VITE_AGENTIC_QR_CONNECT_APP_URL) || AGENTIC_PRODUCTION_ORIGIN;
}

function normalizeOriginLikeUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}
