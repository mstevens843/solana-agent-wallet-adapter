import { describe, expect, it } from 'vitest';

import {
  aiReviewSetupTabForMobileRailOpen,
  computeMobileRailViewportVars,
  inferMobileRailFocusedKeyboardInset,
  mobileRailSheetRouteAllowed,
  shouldApplyMobileRailBodyDataset,
  shouldClearActiveMobileRailSheet,
  shouldCloseWorkspaceStorageSheetAfterCloudSignIn,
  shouldResetAiReviewSetupTabOnMobileRailOpen,
  shouldRefreshDeviceAgentStatusForMobileRailOpen,
  shouldSuppressMobileRailSheetEnterAnimation,
} from '../mobileRailSheetPolicy.js';

describe('mobile rail sheet policy', () => {
  it('allows workspace mobile sheets on app and demo routes', () => {
    expect(mobileRailSheetRouteAllowed('/app')).toBe(true);
    expect(mobileRailSheetRouteAllowed('/demo')).toBe(true);
    expect(mobileRailSheetRouteAllowed('/aiconnectors')).toBe(false);
    expect(mobileRailSheetRouteAllowed(null)).toBe(false);
  });

  it('keeps an active mobile sheet on workspace overview routes', () => {
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/app',
      sheet: 'ai-drafting',
    })).toBe(false);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/demo',
      sheet: 'ai-drafting',
    })).toBe(false);
  });

  it('clears active mobile sheets outside workspace overview', () => {
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/aiconnectors',
      sheet: 'ai-drafting',
    })).toBe(true);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'agent',
      mobileViewport: true,
      route: '/app',
      sheet: 'ai-drafting',
    })).toBe(true);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'overview',
      mobileViewport: false,
      route: '/app',
      sheet: 'ai-drafting',
    })).toBe(true);
  });

  it('applies the body sheet dataset only while a workspace sheet is valid', () => {
    expect(shouldApplyMobileRailBodyDataset({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/demo',
      sheet: 'ai-drafting',
    })).toBe(true);
    expect(shouldApplyMobileRailBodyDataset({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/connect',
      sheet: 'ai-drafting',
    })).toBe(false);
  });

  it('does not refresh Device Agent status for Plan Connector opens', () => {
    expect(shouldRefreshDeviceAgentStatusForMobileRailOpen({
      aiMode: 'device-agent',
      refreshInFlight: false,
      setupTab: 'plan-connector',
      sheet: 'ai-drafting',
    })).toBe(false);
  });

  it('refreshes Device Agent status once for API key Device Agent opens', () => {
    expect(shouldRefreshDeviceAgentStatusForMobileRailOpen({
      aiMode: 'device-agent',
      deviceAgentConfigured: false,
      refreshInFlight: false,
      setupTab: 'api-key',
      sheet: 'ai-drafting',
    })).toBe(true);
    expect(shouldRefreshDeviceAgentStatusForMobileRailOpen({
      aiMode: 'device-agent',
      deviceAgentConfigured: false,
      refreshInFlight: true,
      setupTab: 'api-key',
      sheet: 'ai-drafting',
    })).toBe(false);
  });

  it('does not refresh Device Agent status on open when native config is already confirmed', () => {
    expect(shouldRefreshDeviceAgentStatusForMobileRailOpen({
      aiMode: 'device-agent',
      deviceAgentConfigured: true,
      refreshInFlight: false,
      setupTab: 'api-key',
      sheet: 'ai-drafting',
    })).toBe(false);
  });

  it('resets AI Review setup tabs only when opening the sheet from outside', () => {
    expect(shouldResetAiReviewSetupTabOnMobileRailOpen({
      currentSheet: null,
      nextSheet: 'ai-drafting',
    })).toBe(true);
    expect(shouldResetAiReviewSetupTabOnMobileRailOpen({
      currentSheet: 'wallet-balances',
      nextSheet: 'ai-drafting',
    })).toBe(true);
    expect(shouldResetAiReviewSetupTabOnMobileRailOpen({
      currentSheet: 'ai-drafting',
      nextSheet: 'ai-drafting',
    })).toBe(false);
    expect(shouldResetAiReviewSetupTabOnMobileRailOpen({
      currentSheet: 'ai-drafting',
      nextSheet: 'wallet-balances',
    })).toBe(false);
  });

  it('chooses the connected AI Review setup tab when opening from outside', () => {
    expect(aiReviewSetupTabForMobileRailOpen({
      currentSheet: null,
      nextSheet: 'ai-drafting',
      currentSetupTab: 'api-key',
      planConnectorConfigured: true,
      apiKeyConfigured: true,
    })).toBe('plan-connector');
    expect(aiReviewSetupTabForMobileRailOpen({
      currentSheet: null,
      nextSheet: 'ai-drafting',
      currentSetupTab: 'plan-connector',
      planConnectorConfigured: false,
      apiKeyConfigured: true,
    })).toBe('api-key');
  });

  it('preserves the AI Review setup tab while the sheet is already open', () => {
    expect(aiReviewSetupTabForMobileRailOpen({
      currentSheet: 'ai-drafting',
      nextSheet: 'ai-drafting',
      currentSetupTab: 'plan-connector',
      planConnectorConfigured: false,
      apiKeyConfigured: true,
    })).toBe('plan-connector');
  });

  it('does not auto-close mobile Workspace Storage after cloud actions', () => {
    expect(shouldCloseWorkspaceStorageSheetAfterCloudSignIn('workspace-storage')).toBe(false);
    expect(shouldCloseWorkspaceStorageSheetAfterCloudSignIn('ai-drafting')).toBe(false);
    expect(shouldCloseWorkspaceStorageSheetAfterCloudSignIn('wallet-balances')).toBe(false);
    expect(shouldCloseWorkspaceStorageSheetAfterCloudSignIn(null)).toBe(false);
  });

  it('suppresses enter animation on same-sheet re-renders only', () => {
    expect(shouldSuppressMobileRailSheetEnterAnimation({
      currentSheet: 'ai-drafting',
      previousSheet: null,
      forceSuppress: false,
    })).toBe(false);
    expect(shouldSuppressMobileRailSheetEnterAnimation({
      currentSheet: 'ai-drafting',
      previousSheet: 'ai-drafting',
      forceSuppress: false,
    })).toBe(true);
    expect(shouldSuppressMobileRailSheetEnterAnimation({
      currentSheet: 'ai-drafting',
      previousSheet: 'workspace-storage',
      forceSuppress: false,
    })).toBe(false);
    expect(shouldSuppressMobileRailSheetEnterAnimation({
      currentSheet: 'wallet-balances',
      previousSheet: null,
      forceSuppress: true,
    })).toBe(true);
    expect(shouldSuppressMobileRailSheetEnterAnimation({
      currentSheet: null,
      previousSheet: 'wallet-balances',
      forceSuppress: true,
    })).toBe(false);
  });
});

describe('computeMobileRailViewportVars', () => {
  it('reports no keyboard inset when the visual viewport fills the window', () => {
    expect(computeMobileRailViewportVars({ viewportHeight: 800, viewportOffsetTop: 0, innerHeight: 800 }))
      .toEqual({ vvh: 800, keyboardInset: 0 });
  });

  it('derives the keyboard inset from the shrunken visual viewport', () => {
    expect(computeMobileRailViewportVars({ viewportHeight: 480, viewportOffsetTop: 0, innerHeight: 800 }))
      .toEqual({ vvh: 480, keyboardInset: 320 });
  });

  it('accounts for a scrolled viewport offset (iOS) in the inset', () => {
    expect(computeMobileRailViewportVars({ viewportHeight: 480, viewportOffsetTop: 40, innerHeight: 800 }))
      .toEqual({ vvh: 480, keyboardInset: 280 });
  });

  it('clamps the inset to zero when the window is briefly shorter than the viewport (collapsing URL bar)', () => {
    expect(computeMobileRailViewportVars({ viewportHeight: 820, viewportOffsetTop: 0, innerHeight: 800 }))
      .toEqual({ vvh: 820, keyboardInset: 0 });
  });

  it('floors the display height at 320px but keeps the true inset in short landscape', () => {
    // Landscape phone (innerHeight 375) with the keyboard open shrinking the viewport to 230.
    // vvh floors to 320 for sizing, but the inset must reflect the real 145px keyboard so the
    // sheet is not pushed under it.
    expect(computeMobileRailViewportVars({ viewportHeight: 230, viewportOffsetTop: 0, innerHeight: 375 }))
      .toEqual({ vvh: 320, keyboardInset: 145 });
  });

  it('falls back to innerHeight when visualViewport is unavailable', () => {
    expect(computeMobileRailViewportVars({ innerHeight: 740 }))
      .toEqual({ vvh: 740, keyboardInset: 0 });
  });

  it('uses native keyboard inset when the WebView visual viewport does not resize', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 800,
      viewportOffsetTop: 0,
      innerHeight: 800,
      nativeKeyboardInset: 320,
      nativeKeyboardVisible: true,
    })).toEqual({ vvh: 480, keyboardInset: 320 });
  });

  it('does not double count native keyboard inset when visualViewport also shrinks', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 480,
      viewportOffsetTop: 0,
      innerHeight: 800,
      nativeKeyboardInset: 320,
      nativeKeyboardVisible: true,
    })).toEqual({ vvh: 480, keyboardInset: 320 });
  });

  it('ignores stale native inset when native visibility is false', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 800,
      viewportOffsetTop: 0,
      innerHeight: 800,
      nativeKeyboardInset: 320,
      nativeKeyboardVisible: false,
    })).toEqual({ vvh: 800, keyboardInset: 0 });
  });

  it('uses a focused-control fallback only when no native or visual keyboard metric exists', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 760,
      viewportOffsetTop: 0,
      innerHeight: 760,
      focusedControlFallbackInset: 395,
    })).toEqual({ vvh: 365, keyboardInset: 395 });
  });

  it('prefers visual viewport keyboard metrics over the focused-control fallback', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 500,
      viewportOffsetTop: 0,
      innerHeight: 760,
      focusedControlFallbackInset: 395,
    })).toEqual({ vvh: 500, keyboardInset: 260 });
  });

  it('prefers native keyboard metrics over the focused-control fallback', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 760,
      viewportOffsetTop: 0,
      innerHeight: 760,
      nativeKeyboardInset: 340,
      nativeKeyboardVisible: true,
      focusedControlFallbackInset: 395,
    })).toEqual({ vvh: 420, keyboardInset: 340 });
  });
});

describe('inferMobileRailFocusedKeyboardInset', () => {
  it('estimates a high mobile keyboard while leaving visible sheet space', () => {
    expect(inferMobileRailFocusedKeyboardInset(764)).toBe(397);
    expect(inferMobileRailFocusedKeyboardInset(740)).toBe(380);
  });

  it('caps tall screens and avoids impossible short viewports', () => {
    expect(inferMobileRailFocusedKeyboardInset(900)).toBe(460);
    expect(inferMobileRailFocusedKeyboardInset(375)).toBe(15);
    expect(inferMobileRailFocusedKeyboardInset(0)).toBe(0);
  });
});
