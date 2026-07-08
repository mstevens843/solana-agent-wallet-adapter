import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function sourceBetween(start: string, end: string): string {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Source markers not found: ${start} -> ${end}`);
  }
  return mainSource.slice(startIndex, endIndex);
}

function cssBetween(start: string, end: string): string {
  const startIndex = stylesSource.indexOf(start);
  const endIndex = stylesSource.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`CSS markers not found: ${start} -> ${end}`);
  }
  return stylesSource.slice(startIndex, endIndex);
}

describe('native /app top navigation', () => {
  it('renders the standard app nav instead of the native Back overlay', () => {
    const homepageNav = sourceBetween('function homepageNav', 'function navLink');

    expect(homepageNav).toContain('<header class="homepage-nav"');
    expect(homepageNav).toContain('data-layout="app-nav"');
    expect(homepageNav).not.toContain('nativeAppBackControl');
    expect(mainSource).not.toContain('renderNativeAppBackControl');
    expect(mainSource).not.toContain('bindNativeAppBackControl');
  });

  it('uses the pre-overlay mobile /app top spacing with an iOS-pinned nav', () => {
    const mobileRouteApp = cssBetween('@media (max-width: 899px)', '.route-app .homepage-brand');

    // Base (web/Android) app-nav rule is untouched: pre-overlay 8px band + position:static.
    expect(mobileRouteApp).toContain('calc(var(--mobile-nav-safe-top) + var(--mobile-nav-top-gap))');
    expect(mobileRouteApp).toContain('.route-app .homepage-nav[data-layout="app-nav"]');
    expect(mobileRouteApp).toContain('position: static');
    expect(mobileRouteApp).not.toContain('--app-native-top-clear');
    // iOS /app pins the nav with position:sticky (in-flow, no padding band, no backdrop mask) so it
    // never drifts up on tall tabs — the proven fix (927a9f3), uniform on every tab. The base rule
    // above (static, for web/Android) is deliberately left in place; only iOS gets the sticky override.
    expect(mobileRouteApp).toContain('.route-app.ios-native-shell .homepage-nav[data-layout="app-nav"]');
    expect(mobileRouteApp).toContain('position: sticky');
    expect(mobileRouteApp).not.toContain('.native-app-back-control');
  });

  it('does not add an iOS-only /app safe-area offset above the standard nav', () => {
    expect(stylesSource).toContain('.shell.ios-native-shell {\n    --mobile-nav-safe-top: 0px;\n  }');
    expect(stylesSource).not.toContain('--mobile-nav-safe-top: max(62px, env(safe-area-inset-top, 0px));');
  });

  it('does not keep stale Back overlay CSS or chat height overrides', () => {
    expect(stylesSource).not.toContain('.native-app-back-control');
    expect(stylesSource).not.toContain('--app-native-top-clear');
    expect(stylesSource).not.toContain('overlay Back control');
    expect(stylesSource).not.toContain('.route-app.android-shell .chat-surface,\n  .route-app.ios-native-shell .chat-surface');
  });

  it('morphs the whole #workspace in place on iOS /app (no full-rebuild dock/nav flash)', () => {
    const canMorphActiveTab = sourceBetween('function canMorphActiveTab', 'function applyChatAutoscrollAfterRender');

    expect(canMorphActiveTab).toContain("currentRoute() !== '/app'");
    // The gate still short-circuits for non-chat/non-sheet EXCEPT on iOS native, where every /app tab
    // morphs so tab switches never rebuild the backdrop-filter dock/nav (the WKWebView blink).
    expect(canMorphActiveTab).toContain("state.activeTab !== 'chat'");
    expect(canMorphActiveTab).toContain('!isIosAppShellSurface()');
    expect(canMorphActiveTab).toContain("document.getElementById('workspace')");
  });

  it('keys the toggling #workspace children so morph never destroys .workspace or the dock', () => {
    // The intro <div> toggles in/out on the Home tab (and the tx-modal scrim at position 0), shifting
    // sibling positions. Without stable keys morphdom would remove+recreate .workspace and the
    // backdrop-filter dock on every Home transition — a worse blink than the bug.
    const renderWorkspace = sourceBetween('function renderWorkspace', 'function render(');
    expect(renderWorkspace).toContain("=== 'app-intro'");
    expect(renderWorkspace).toContain("=== 'app-shell'");
    expect(renderWorkspace).toContain("=== 'android-bottom-tab-dock'");
    // The dock is emitted INSIDE #workspace for all shells (no persistent re-parent hack).
    expect(mainSource).not.toContain('function syncPersistentBottomDock');
    expect(mainSource).not.toContain("isIosAppShellSurface() ? '' : androidBottomTabDock()");
  });
});
