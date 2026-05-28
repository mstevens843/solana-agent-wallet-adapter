export interface ExternalLinkOpenEnvironment {
  isTauriNative?: boolean;
  isAndroidNative?: boolean;
  tauriOpenExternalUrl?: (url: string) => boolean | Promise<boolean>;
  androidOpenExternalUrl?: (url: string) => boolean;
}

export interface ExternalLinkOpenResult {
  ok: boolean;
  surface: 'tauri' | 'android' | 'none';
  error?: string;
}

export function shouldInterceptExternalLink(href: string, currentHref: string): boolean {
  const target = parseHttpUrl(href, currentHref);
  const current = parseHttpUrl(currentHref, currentHref);
  if (!target || !current) return false;
  return target.origin !== current.origin;
}

export async function openExternalUrlForSurface(
  url: string,
  env: ExternalLinkOpenEnvironment,
): Promise<ExternalLinkOpenResult> {
  const target = url.trim();
  if (!target) {
    return { ok: false, surface: 'none', error: 'Missing URL.' };
  }

  if (env.isTauriNative && env.tauriOpenExternalUrl) {
    try {
      const ok = await env.tauriOpenExternalUrl(target);
      if (ok) return { ok: true, surface: 'tauri' };
      return { ok: false, surface: 'tauri', error: 'Desktop could not open the link.' };
    } catch (err) {
      return { ok: false, surface: 'tauri', error: errorMessage(err) };
    }
  }

  if (env.isAndroidNative && env.androidOpenExternalUrl) {
    try {
      const ok = env.androidOpenExternalUrl(target);
      if (ok) return { ok: true, surface: 'android' };
      return { ok: false, surface: 'android', error: 'Android could not open the link.' };
    } catch (err) {
      return { ok: false, surface: 'android', error: errorMessage(err) };
    }
  }

  return { ok: false, surface: 'none', error: 'No native external link opener is available.' };
}

function parseHttpUrl(href: string, base: string): URL | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
