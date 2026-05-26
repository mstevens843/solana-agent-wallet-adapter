export interface DesktopQrConfigEnv {
  PROD?: boolean;
  VITE_AGENTIC_CLOUD_API_BASE_URL?: string;
  VITE_AGENTIC_QR_CONNECT_APP_URL?: string;
}

export const AGENTIC_PRODUCTION_ORIGIN = 'https://agentic-signer.com';

export function resolveDesktopPairingRelayBaseUrl(
  env: DesktopQrConfigEnv,
  locationOrigin: string,
): string {
  const configured = normalizeOriginLikeUrl(env.VITE_AGENTIC_CLOUD_API_BASE_URL);
  if (configured) return configured;
  return env.PROD ? AGENTIC_PRODUCTION_ORIGIN : normalizeOriginLikeUrl(locationOrigin) || '';
}

export function resolveQrConnectAppUrl(
  env: DesktopQrConfigEnv,
  locationOrigin: string,
): string {
  const configured = normalizeOriginLikeUrl(env.VITE_AGENTIC_QR_CONNECT_APP_URL);
  if (configured) return configured;
  return env.PROD ? AGENTIC_PRODUCTION_ORIGIN : normalizeOriginLikeUrl(locationOrigin) || AGENTIC_PRODUCTION_ORIGIN;
}

function normalizeOriginLikeUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}
