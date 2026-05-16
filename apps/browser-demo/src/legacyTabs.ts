export function legacyTabsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return new URL(window.location.href).searchParams.get('legacy-tabs') === '1';
}
