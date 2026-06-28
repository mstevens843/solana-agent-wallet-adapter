import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  bindNativeAppBackControl,
  renderNativeAppBackControl,
} from '../nativeAppBackControl.js';

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const controlSource = readFileSync(new URL('../nativeAppBackControl.ts', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('native /app Back overlay', () => {
  it('renders a Back button, not the old Demo anchor pill', () => {
    const html = renderNativeAppBackControl({ ariaLabel: 'Back to demo', label: 'Back <now>' });
    expect(mainSource).toContain('renderNativeAppBackControl');
    expect(html).toContain('data-native-app-back-control');
    expect(html).toContain('Back &lt;now&gt;');
    expect(controlSource).toContain('class="native-app-back-control"');
    expect(mainSource).toContain("t('Back')");
    expect(controlSource).not.toContain('class="app-back-pill"');
    expect(controlSource).not.toContain("app-back-pill-label");
    expect(mainSource).not.toContain("t('Demo'))}</span>");
  });

  it('binds a dedicated click handler that navigates to /demo', () => {
    const button = new EventTarget();
    const root = {
      querySelector: (selector: string) => selector === '[data-native-app-back-control]' ? button : null,
    } as unknown as ParentNode;
    const navClicks: string[] = [];
    const navigations: string[] = [];

    const bound = bindNativeAppBackControl(root, {
      bindOnce: (element, type, handler) => element?.addEventListener(type, handler as EventListener),
      trackNavClick: (route, area) => navClicks.push(`${route}:${area}`),
      navigateTo: (route) => navigations.push(route),
    });
    const event = new Event('click', { cancelable: true });

    expect(bound).toBe(true);
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(navClicks).toEqual(['/demo:native_app_back']);
    expect(navigations).toEqual(['/demo']);
  });

  it('does not reserve a back-button height band in native app layout', () => {
    expect(stylesSource).toContain('--app-native-top-clear: var(--mobile-nav-safe-top);');
    expect(stylesSource).not.toContain('--app-native-top-clear: calc(var(--mobile-nav-safe-top) + 44px)');
    expect(stylesSource).toContain('.route-app.android-shell .native-app-back-control');
    expect(stylesSource).toContain('z-index: 260;');
    const controlBaseIndex = stylesSource.indexOf('.native-app-back-control {\n  display: none;');
    const overlayRuleIndex = stylesSource.indexOf('.route-app.android-shell .native-app-back-control', controlBaseIndex);
    const mobileBreakpointIndex = stylesSource.indexOf('@media (max-width: 899px)', controlBaseIndex);
    expect(controlBaseIndex).toBeGreaterThanOrEqual(0);
    expect(overlayRuleIndex).toBeGreaterThanOrEqual(0);
    expect(mobileBreakpointIndex).toBeGreaterThanOrEqual(0);
    expect(overlayRuleIndex).toBeLessThan(mobileBreakpointIndex);
  });
});
