type AnalyticsEventParams = Record<string, string | number | boolean | undefined>;
type Gtag = (command: 'js' | 'event' | 'config' | 'consent' | 'set', ...args: unknown[]) => void;

type AnalyticsWindow = Window & {
  dataLayer?: unknown[];
  gtag?: Gtag;
};

const GA_SCRIPT_ID = 'agentic-ga4';
const MEASUREMENT_ID = resolveMeasurementId();

let initialized = false;
let lastTrackedPagePath = '';

export function initializeAnalytics(surface?: string): void {
  if (!MEASUREMENT_ID || initialized || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const analyticsWindow = window as AnalyticsWindow;
  analyticsWindow.dataLayer = analyticsWindow.dataLayer ?? [];
  analyticsWindow.gtag = analyticsWindow.gtag ?? function gtag() {
    analyticsWindow.dataLayer?.push(arguments);
  };

  analyticsWindow.gtag('consent', 'default', {
    analytics_storage: 'granted',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    personalization_storage: 'denied',
    security_storage: 'granted',
    functionality_storage: 'granted',
  });
  analyticsWindow.gtag('set', {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  analyticsWindow.gtag('js', new Date());
  analyticsWindow.gtag('config', MEASUREMENT_ID, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  if (surface) {
    // User-scoped dimension so the single Web stream can split web vs android/ios in-app vs
    // desktop traffic. Register `app_surface` as a custom dimension in the GA4 UI to report on it.
    analyticsWindow.gtag('set', 'user_properties', { app_surface: safeDimension(surface) });
  }

  if (!document.getElementById(GA_SCRIPT_ID)) {
    const script = document.createElement('script');
    script.id = GA_SCRIPT_ID;
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`;
    document.head.appendChild(script);
  }

  initialized = true;
}

export function trackPageView(pathname: string, pageTitle: string): void {
  const pagePath = sanitizePath(pathname);
  if (pagePath === lastTrackedPagePath) return;
  lastTrackedPagePath = pagePath;
  trackEvent('page_view', {
    page_title: pageTitle,
    page_location: `${window.location.origin}${pagePath}`,
    page_path: pagePath,
  });
}

export function trackNavClick(targetRoute: string, navArea: string): void {
  trackEvent('nav_click', {
    target_route: sanitizeRouteDimension(targetRoute),
    nav_area: safeDimension(navArea),
  });
}

export function trackDownloadClick(downloadKind: string, platform: string, assetName: string): void {
  trackEvent('download_click', {
    download_kind: safeDimension(downloadKind),
    platform: safeDimension(platform),
    asset_name: safeDimension(assetName),
  });
}

export function trackCliCommandCopy(commandKind: string): void {
  trackEvent('cli_command_copy', {
    command_kind: safeDimension(commandKind),
  });
}

export function trackGenerateTemplatePlan(templateId: string): void {
  trackEvent('generate_template_plan', {
    template_id: safeDimension(templateId),
  });
}

export function trackGenerateAiPlan(templateId: string, mode: string, provider: string): void {
  trackEvent('generate_ai_plan', {
    template_id: safeDimension(templateId),
    ai_mode: safeDimension(mode),
    ai_provider: safeDimension(provider),
  });
}

export function trackWalletConnectClick(walletSurface: string, connectSource: string): void {
  trackEvent('connect_wallet_click', {
    wallet_surface: safeDimension(walletSurface),
    connect_source: safeDimension(connectSource),
  });
}

export function trackWalletConnectSuccess(walletSurface: string, cluster: string, connectSource: string): void {
  trackEvent('wallet_connect_success', {
    wallet_surface: safeDimension(walletSurface),
    cluster: safeDimension(cluster),
    connect_source: safeDimension(connectSource),
  });
}

function trackEvent(name: string, params: AnalyticsEventParams = {}): void {
  if (!MEASUREMENT_ID) return;
  initializeAnalytics();
  const gtag = (window as AnalyticsWindow).gtag;
  if (!gtag) return;
  gtag('event', name, removeUndefined(params));
}

function removeUndefined(params: AnalyticsEventParams): AnalyticsEventParams {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

function sanitizePath(value: string): string {
  const raw = value.trim() || '/';
  const pathname = raw.startsWith('http') ? new URL(raw).pathname : raw.split(/[?#]/, 1)[0] ?? '/';
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return normalized.replace(/\/+$/, '') || '/';
}

function sanitizeRouteDimension(value: string): string {
  const raw = value.trim() || '/';
  const parsed = raw.startsWith('http') ? new URL(raw) : null;
  const pathWithHash = parsed ? `${parsed.pathname}${parsed.hash}` : raw.split('?', 1)[0] ?? '/';
  const [path = '/', hash = ''] = pathWithHash.split('#', 2);
  const normalizedPath = (path.startsWith('/') ? path : `/${path}`).replace(/\/+$/, '') || '/';
  const normalizedHash = hash ? `#${safeDimension(hash)}` : '';
  return `${normalizedPath}${normalizedHash}`.slice(0, 80);
}

function safeDimension(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_./-]+/g, '_').slice(0, 80) || 'unknown';
}

function resolveMeasurementId(): string {
  const viteEnv = (import.meta as ImportMeta & {
    env?: {
      VITE_AGENTIC_GA_MEASUREMENT_ID?: string;
    };
  }).env;
  return String(viteEnv?.VITE_AGENTIC_GA_MEASUREMENT_ID ?? '').trim();
}
