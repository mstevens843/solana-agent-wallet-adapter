import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveAndroidAppSurface } from '../androidNative.js';

// Regression guard for the "some Android UI doesn't update from Render" bug.
//
// The release Android app live-loads the SAME bundle Render serves to the public
// website, which has NO build-time `VITE_AGENTIC_ANDROID_APP` flag. Shell
// identity must therefore be detected at RUNTIME via the injected `AgenticAndroid`
// bridge — otherwise Android-only UI (AI Review tabs, Connect AI subtab) stays
// hidden in the live bundle and only a new APK could surface it. These tests lock
// in that the same flagless bundle adapts at runtime and that the public website
// (no bridge) is unaffected.
// NOTE: `VITE_AGENTIC_ANDROID_APP` is statically replaced at build time by
// vite.config.ts `define` (defaults to 'false'), so it is hard-`false` in this
// test bundle and cannot be stubbed — which is precisely the production-website
// reality. That makes these tests assert the load-bearing invariant directly:
// with the build flag off (website + live Render bundle), shell identity is
// driven ENTIRELY by the runtime `AgenticAndroid` bridge. The build-flag wiring
// itself is covered by the vite `define` config tests.
describe('resolveAndroidAppSurface (flagless / live-Render bundle)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false on the public website: no build flag, no native bridge', () => {
    expect(resolveAndroidAppSurface()).toBe(false);
  });

  it('is true inside the Android WebView shell once the bridge is injected', () => {
    vi.stubGlobal('AgenticAndroid', { mwaRequest: vi.fn() });
    expect(resolveAndroidAppSurface()).toBe(true);
  });
});
