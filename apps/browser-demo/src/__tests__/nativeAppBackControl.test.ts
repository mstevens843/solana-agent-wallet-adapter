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
  it('renders an icon-only /demo link, not the old Demo anchor pill', () => {
    const html = renderNativeAppBackControl({ ariaLabel: 'Back <demo>' });
    expect(mainSource).toContain('renderNativeAppBackControl');
    expect(html).toContain('<a class="native-app-back-control"');
    expect(html).toContain('href="/demo"');
    expect(html).toContain('data-native-app-back-control');
    expect(html).toContain('Back &lt;demo&gt;');
    expect(html).not.toContain('native-app-back-control-label');
    expect(html).not.toContain('>Back<');
    expect(controlSource).toContain('class="native-app-back-control"');
    expect(mainSource).not.toContain("t('Back')");
    expect(controlSource).not.toContain('class="app-back-pill"');
    expect(controlSource).not.toContain("app-back-pill-label");
    expect(mainSource).not.toContain("t('Demo'))}</span>");
  });

  it('binds capture handlers for pointer, touch, and click activation', () => {
    const harness = nativeBackHarness();

    const bound = bindNativeAppBackControl(harness.root, harness.deps);
    expect(bound).toBe(true);
    expect(Object.keys(harness.handlers).sort()).toEqual(['click', 'pointerup', 'touchend']);
    expect(harness.handlers.pointerup?.options).toMatchObject({ capture: true });
    expect(harness.handlers.touchend?.options).toMatchObject({ capture: true });
    expect(harness.handlers.click?.options).toMatchObject({ capture: true });
  });

  it.each(['pointerup', 'touchend', 'click'])('navigates to /demo on %s', (eventType) => {
    const harness = nativeBackHarness();
    bindNativeAppBackControl(harness.root, harness.deps);

    const event = nativeBackEvent(eventType, harness.target);
    harness.handlers[eventType]?.handler(event);

    expect(event.defaultPrevented).toBe(true);
    expect(harness.navClicks).toEqual(['/demo:native_app_back']);
    expect(harness.navigations).toEqual(['/demo']);
  });

  it('dedupes touch/pointer activation followed by a synthetic click', () => {
    const harness = nativeBackHarness();
    bindNativeAppBackControl(harness.root, harness.deps);

    harness.handlers.pointerup?.handler(nativeBackEvent('pointerup', harness.target));
    harness.advance(120);
    harness.handlers.click?.handler(nativeBackEvent('click', harness.target));

    expect(harness.navClicks).toEqual(['/demo:native_app_back']);
    expect(harness.navigations).toEqual(['/demo']);
  });

  it('forces /demo if the SPA route did not stick', () => {
    const harness = nativeBackHarness({ updatePathOnNavigate: false });
    bindNativeAppBackControl(harness.root, harness.deps);

    harness.handlers.touchend?.handler(nativeBackEvent('touchend', harness.target));
    expect(harness.forcedNavigations).toEqual([]);
    harness.runTimers();

    expect(harness.navigations).toEqual(['/demo']);
    expect(harness.forcedNavigations).toEqual(['/demo']);
  });

  it('does not reserve a back-button height band in native app layout', () => {
    expect(stylesSource).toContain('--app-native-top-clear: var(--mobile-nav-safe-top);');
    expect(stylesSource).not.toContain('--app-native-top-clear: calc(var(--mobile-nav-safe-top) + 44px)');
    expect(stylesSource).toContain('.route-app.android-shell .native-app-back-control');
    expect(stylesSource).toContain('z-index: 260;');
    expect(stylesSource).toContain('width: 34px;');
    expect(stylesSource).toContain('background: rgba(5, 8, 7, 0.5);');
    const controlBaseIndex = stylesSource.indexOf('.native-app-back-control {\n  display: none;');
    const overlayRuleIndex = stylesSource.indexOf('.route-app.android-shell .native-app-back-control', controlBaseIndex);
    const mobileBreakpointIndex = stylesSource.indexOf('@media (max-width: 899px)', controlBaseIndex);
    expect(controlBaseIndex).toBeGreaterThanOrEqual(0);
    expect(overlayRuleIndex).toBeGreaterThanOrEqual(0);
    expect(mobileBreakpointIndex).toBeGreaterThanOrEqual(0);
    expect(overlayRuleIndex).toBeLessThan(mobileBreakpointIndex);
  });
});

interface NativeBackHarness {
  root: ParentNode & EventTarget;
  target: { closest: (selector: string) => unknown };
  handlers: Record<string, { handler: (event: Event) => void; options?: boolean | AddEventListenerOptions }>;
  deps: Parameters<typeof bindNativeAppBackControl>[1];
  navClicks: string[];
  navigations: string[];
  forcedNavigations: string[];
  advance: (ms: number) => void;
  runTimers: () => void;
}

let harnessClock = 1_000;

function nativeBackHarness(options: { updatePathOnNavigate?: boolean } = {}): NativeBackHarness {
  harnessClock += 5_000;
  let now = harnessClock;
  let currentPath = '/app';
  const timers: Array<() => void> = [];
  const navClicks: string[] = [];
  const navigations: string[] = [];
  const forcedNavigations: string[] = [];
  const target = {
    closest: (selector: string) => selector === '[data-native-app-back-control]' ? target : null,
  };
  const handlers: NativeBackHarness['handlers'] = {};
  const root = {
    querySelector: (selector: string) => selector === '[data-native-app-back-control]' ? target : null,
  } as unknown as ParentNode & EventTarget;

  return {
    root,
    target,
    handlers,
    navClicks,
    navigations,
    forcedNavigations,
    deps: {
      bindOnce: (element, type, handler, bindOptions) => {
        expect(element).toBe(root);
        handlers[type] = { handler, options: bindOptions };
      },
      trackNavClick: (route, area) => navClicks.push(`${route}:${area}`),
      navigateTo: (route) => {
        navigations.push(route);
        if (options.updatePathOnNavigate !== false) currentPath = route;
      },
      currentPath: () => currentPath,
      forceNavigate: (route) => {
        forcedNavigations.push(route);
        currentPath = route;
      },
      now: () => now,
      setTimeout: (handler) => {
        timers.push(handler);
        return timers.length;
      },
    },
    advance: (ms) => {
      now += ms;
    },
    runTimers: () => {
      while (timers.length > 0) timers.shift()?.();
    },
  };
}

function nativeBackEvent(type: string, target: NativeBackHarness['target']): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}
