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

  it('uses the pre-overlay mobile /app top spacing', () => {
    const mobileRouteApp = cssBetween('@media (max-width: 899px)', '.route-app .homepage-brand');

    expect(mobileRouteApp).toContain('calc(var(--mobile-nav-safe-top) + var(--mobile-nav-top-gap))');
    expect(mobileRouteApp).toContain('.route-app .homepage-nav[data-layout="app-nav"]');
    expect(mobileRouteApp).toContain('position: static');
    expect(mobileRouteApp).not.toContain('--app-native-top-clear');
    expect(mobileRouteApp).not.toContain('ios-native-shell .homepage-nav[data-layout="app-nav"]');
  });

  it('does not keep stale Back overlay CSS or chat height overrides', () => {
    expect(stylesSource).not.toContain('.native-app-back-control');
    expect(stylesSource).not.toContain('--app-native-top-clear');
    expect(stylesSource).not.toContain('overlay Back control');
    expect(stylesSource).not.toContain('.route-app.android-shell .chat-surface,\n  .route-app.ios-native-shell .chat-surface');
  });
});
