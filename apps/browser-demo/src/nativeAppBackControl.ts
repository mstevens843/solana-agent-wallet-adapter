export interface NativeAppBackControlLabels {
  ariaLabel: string;
}

export interface NativeAppBackControlDeps {
  bindOnce: (
    element: EventTarget | null | undefined,
    type: string,
    handler: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  trackNavClick: (route: '/demo', area: 'native_app_back') => void;
  navigateTo: (route: '/demo') => void;
  currentPath?: () => string;
  forceNavigate?: (route: '/demo') => void;
  now?: () => number;
  setTimeout?: (handler: () => void, delayMs: number) => unknown;
}

const NATIVE_APP_BACK_SELECTOR = '[data-native-app-back-control]';
const NATIVE_APP_BACK_DEDUPE_MS = 750;
const NATIVE_APP_BACK_FALLBACK_MS = 90;

let lastNativeAppBackActivationAt: number | null = null;

export function renderNativeAppBackControl(labels: NativeAppBackControlLabels): string {
  return `
    <a class="native-app-back-control" href="/demo" data-native-app-back-control aria-label="${escapeHtml(labels.ariaLabel)}">
      <span class="native-app-back-control-chevron" aria-hidden="true">&#8249;</span>
    </a>
  `;
}

export function bindNativeAppBackControl(root: ParentNode & EventTarget, deps: NativeAppBackControlDeps): boolean {
  const control = root.querySelector<HTMLElement>(NATIVE_APP_BACK_SELECTOR);
  if (!control) return false;
  const activate = (event: Event): void => activateNativeAppBackControl(event, deps);
  const options: AddEventListenerOptions = { capture: true };
  deps.bindOnce(root, 'pointerup', activate, options);
  deps.bindOnce(root, 'touchend', activate, options);
  deps.bindOnce(root, 'click', activate, options);
  return true;
}

function activateNativeAppBackControl(event: Event, deps: NativeAppBackControlDeps): void {
  if (!eventTargetsNativeAppBackControl(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const now = deps.now?.() ?? Date.now();
  if (
    lastNativeAppBackActivationAt !== null &&
    now - lastNativeAppBackActivationAt >= 0 &&
    now - lastNativeAppBackActivationAt < NATIVE_APP_BACK_DEDUPE_MS
  ) {
    return;
  }
  lastNativeAppBackActivationAt = now;

  deps.trackNavClick('/demo', 'native_app_back');
  deps.navigateTo('/demo');
  scheduleNativeAppBackFallback(deps);
}

function eventTargetsNativeAppBackControl(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  return typeof closest === 'function' && Boolean(closest.call(target, NATIVE_APP_BACK_SELECTOR));
}

function scheduleNativeAppBackFallback(deps: NativeAppBackControlDeps): void {
  const schedule = deps.setTimeout ?? ((handler: () => void, delayMs: number) => {
    if (typeof window === 'undefined') return undefined;
    return window.setTimeout(handler, delayMs);
  });
  schedule(() => {
    if (currentPath(deps) === '/demo') return;
    if (deps.forceNavigate) {
      deps.forceNavigate('/demo');
      return;
    }
    if (typeof window !== 'undefined') window.location.assign('/demo');
  }, NATIVE_APP_BACK_FALLBACK_MS);
}

function currentPath(deps: NativeAppBackControlDeps): string {
  const path = deps.currentPath?.() ?? (typeof window !== 'undefined' ? window.location.pathname : '/demo');
  if (path === '/') return '/';
  return path.split(/[?#]/u, 1)[0]?.replace(/\/+$/u, '') || '/';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] ?? ch));
}
