import { describe, expect, it } from 'vitest';

import {
  aiReviewSetupTabForMobileRailOpen,
  computeMobileRailViewportVars,
  decideChatAutoscroll,
  inferMobileRailFocusedKeyboardInset,
  mobileRailSheetRouteAllowed,
  resolveChatKeyboardInset,
  shouldApplyMobileRailBodyDataset,
  shouldClearActiveMobileRailSheet,
  shouldCloseWorkspaceStorageSheetAfterCloudSignIn,
  shouldResetAiReviewSetupTabOnMobileRailOpen,
  shouldRefreshDeviceAgentStatusForMobileRailOpen,
  shouldSuppressMobileRailSheetEnterAnimation,
  shouldWriteChatKeyboardInset,
} from '../mobileRailSheetPolicy.js';
import type { MobileRailViewportVars } from '../mobileRailSheetPolicy.js';

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

  it('keeps the chat-action sheet on the chat tab and clears it elsewhere', () => {
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-action',
    })).toBe(false);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-action',
    })).toBe(true);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/connect',
      sheet: 'chat-action',
    })).toBe(true);
  });

  it('keeps the chat-wallet-balances sheet on the chat tab and clears it elsewhere', () => {
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-wallet-balances',
    })).toBe(false);
    // Stays open even on a non-mobile viewport (it is native-shell gated at the open site, not by viewport).
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'chat',
      mobileViewport: false,
      route: '/app',
      sheet: 'chat-wallet-balances',
    })).toBe(false);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-wallet-balances',
    })).toBe(true);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/connect',
      sheet: 'chat-wallet-balances',
    })).toBe(true);
  });

  it('keeps the chat-research sheet on the chat tab and clears it elsewhere', () => {
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-research',
    })).toBe(false);
    // Native chat sheets are gated at the open site, not by viewport width.
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'chat',
      mobileViewport: false,
      route: '/app',
      sheet: 'chat-research',
    })).toBe(false);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-research',
    })).toBe(true);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/connect',
      sheet: 'chat-research',
    })).toBe(true);
  });

  it('keeps connector-connect sheets on the opener tab while mobile', () => {
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/app',
      sheet: 'connector-connect',
    })).toBe(false);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/app',
      sheet: 'connector-connect',
    })).toBe(false);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'recurring',
      mobileViewport: false,
      route: '/app',
      sheet: 'connector-connect',
    })).toBe(true);
    expect(shouldClearActiveMobileRailSheet({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/connect',
      sheet: 'connector-connect',
    })).toBe(true);
  });

  it('applies the body sheet dataset for the chat-wallet-balances sheet on the chat tab', () => {
    expect(shouldApplyMobileRailBodyDataset({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-wallet-balances',
    })).toBe(true);
    expect(shouldApplyMobileRailBodyDataset({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-wallet-balances',
    })).toBe(false);
  });

  it('applies the body sheet dataset for the chat-action sheet on the chat tab', () => {
    expect(shouldApplyMobileRailBodyDataset({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-action',
    })).toBe(true);
    expect(shouldApplyMobileRailBodyDataset({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-action',
    })).toBe(false);
  });

  it('applies the body sheet dataset for the chat-research sheet on the chat tab', () => {
    expect(shouldApplyMobileRailBodyDataset({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-research',
    })).toBe(true);
    expect(shouldApplyMobileRailBodyDataset({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/app',
      sheet: 'chat-research',
    })).toBe(false);
  });

  it('applies the body sheet dataset for connector-connect on any app tab while mobile', () => {
    expect(shouldApplyMobileRailBodyDataset({
      activeTab: 'overview',
      mobileViewport: true,
      route: '/app',
      sheet: 'connector-connect',
    })).toBe(true);
    expect(shouldApplyMobileRailBodyDataset({
      activeTab: 'chat',
      mobileViewport: true,
      route: '/app',
      sheet: 'connector-connect',
    })).toBe(true);
    expect(shouldApplyMobileRailBodyDataset({
      activeTab: 'chat',
      mobileViewport: false,
      route: '/app',
      sheet: 'connector-connect',
    })).toBe(false);
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
      .toEqual({ vvh: 800, keyboardInset: 0, keyboardOpen: false, source: 'none' });
  });

  it('derives the keyboard inset from the shrunken visual viewport', () => {
    expect(computeMobileRailViewportVars({ viewportHeight: 480, viewportOffsetTop: 0, innerHeight: 800 }))
      .toEqual({ vvh: 480, keyboardInset: 320, keyboardOpen: true, source: 'visual-viewport' });
  });

  it('accounts for a scrolled viewport offset (iOS) in the inset', () => {
    expect(computeMobileRailViewportVars({ viewportHeight: 480, viewportOffsetTop: 40, innerHeight: 800 }))
      .toEqual({ vvh: 480, keyboardInset: 280, keyboardOpen: true, source: 'visual-viewport' });
  });

  it('clamps the inset to zero when the window is briefly shorter than the viewport (collapsing URL bar)', () => {
    expect(computeMobileRailViewportVars({ viewportHeight: 820, viewportOffsetTop: 0, innerHeight: 800 }))
      .toEqual({ vvh: 820, keyboardInset: 0, keyboardOpen: false, source: 'none' });
  });

  it('floors the display height at 320px but keeps the true inset in short landscape', () => {
    // Landscape phone (innerHeight 375) with the keyboard open shrinking the viewport to 230.
    // vvh floors to 320 for sizing, but the inset must reflect the real 145px keyboard so the
    // sheet is not pushed under it.
    expect(computeMobileRailViewportVars({ viewportHeight: 230, viewportOffsetTop: 0, innerHeight: 375 }))
      .toEqual({ vvh: 320, keyboardInset: 145, keyboardOpen: true, source: 'visual-viewport' });
  });

  it('falls back to innerHeight when visualViewport is unavailable', () => {
    expect(computeMobileRailViewportVars({ innerHeight: 740 }))
      .toEqual({ vvh: 740, keyboardInset: 0, keyboardOpen: false, source: 'none' });
  });

  it('uses native keyboard inset when the WebView visual viewport does not resize', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 800,
      viewportOffsetTop: 0,
      innerHeight: 800,
      nativeKeyboardInset: 320,
      nativeKeyboardVisible: true,
    })).toEqual({ vvh: 480, keyboardInset: 320, keyboardOpen: true, source: 'native' });
  });

  it('does not double count native keyboard inset when visualViewport also shrinks', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 480,
      viewportOffsetTop: 0,
      innerHeight: 800,
      nativeKeyboardInset: 320,
      nativeKeyboardVisible: true,
    })).toEqual({ vvh: 480, keyboardInset: 320, keyboardOpen: true, source: 'native' });
  });

  it('does not add native inset when Android adjustResize already shrank the layout viewport', () => {
    expect(computeMobileRailViewportVars({
      baselineInnerHeight: 800,
      viewportHeight: 480,
      viewportOffsetTop: 0,
      innerHeight: 480,
      nativeKeyboardInset: 320,
      nativeKeyboardVisible: true,
    })).toEqual({ vvh: 480, keyboardInset: 0, keyboardOpen: true, source: 'layout-viewport-resize' });
  });

  it('uses layout viewport resize over the focused-control fallback', () => {
    expect(computeMobileRailViewportVars({
      baselineInnerHeight: 760,
      viewportHeight: 500,
      viewportOffsetTop: 0,
      innerHeight: 500,
      focusedControlFallbackInset: 319,
    })).toEqual({ vvh: 500, keyboardInset: 0, keyboardOpen: true, source: 'layout-viewport-resize' });
  });

  it('ignores stale native inset when native visibility is false', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 800,
      viewportOffsetTop: 0,
      innerHeight: 800,
      nativeKeyboardInset: 320,
      nativeKeyboardVisible: false,
    })).toEqual({ vvh: 800, keyboardInset: 0, keyboardOpen: false, source: 'none' });
  });

  it('uses a focused-control fallback only when no native or visual keyboard metric exists', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 760,
      viewportOffsetTop: 0,
      innerHeight: 760,
      focusedControlFallbackInset: 395,
    })).toEqual({ vvh: 365, keyboardInset: 395, keyboardOpen: true, source: 'focused-control-fallback' });
  });

  it('prefers visual viewport keyboard metrics over the focused-control fallback', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 500,
      viewportOffsetTop: 0,
      innerHeight: 760,
      focusedControlFallbackInset: 395,
    })).toEqual({ vvh: 500, keyboardInset: 260, keyboardOpen: true, source: 'visual-viewport' });
  });

  it('prefers native keyboard metrics over the focused-control fallback', () => {
    expect(computeMobileRailViewportVars({
      viewportHeight: 760,
      viewportOffsetTop: 0,
      innerHeight: 760,
      nativeKeyboardInset: 340,
      nativeKeyboardVisible: true,
      focusedControlFallbackInset: 395,
    })).toEqual({ vvh: 420, keyboardInset: 340, keyboardOpen: true, source: 'native' });
  });

  it('iOS native: never promotes a phantom visual-viewport delta to a keyboard (anti-jitter)', () => {
    // iOS overlay keyboard: window.innerHeight does NOT shrink, and ios.contentInset:'automatic'/
    // scroll makes a phantom 40px visual-viewport delta with the keyboard CLOSED. Suppression must
    // reject it — this is the primary fix for the iOS Chat-tab up/down oscillation.
    const vars = computeMobileRailViewportVars({
      viewportHeight: 760,
      viewportOffsetTop: 0,
      innerHeight: 800,
      suppressVisualViewportKeyboard: true,
    });
    expect(vars).toEqual({ vvh: 760, keyboardInset: 0, keyboardOpen: false, source: 'none' });
    // The write value (what reaches --chat-keyboard-inset) must be 0, so the surface never shrinks.
    expect(resolveChatKeyboardInset(vars)).toBe(0);
  });

  it('iOS native: the authoritative native inset still lifts the composer with suppression on', () => {
    const vars = computeMobileRailViewportVars({
      viewportHeight: 800,
      viewportOffsetTop: 0,
      innerHeight: 800,
      nativeKeyboardInset: 300,
      nativeKeyboardVisible: true,
      suppressVisualViewportKeyboard: true,
    });
    expect(vars.source).toBe('native');
    expect(resolveChatKeyboardInset(vars)).toBe(300);
  });

  it('mobile web: visual-viewport detection is unchanged without the suppression flag', () => {
    // No flag (web has no native bridge) → the geometric heuristic remains the sole detector.
    expect(computeMobileRailViewportVars({ viewportHeight: 480, viewportOffsetTop: 0, innerHeight: 800 }))
      .toEqual({ vvh: 480, keyboardInset: 320, keyboardOpen: true, source: 'visual-viewport' });
  });
});

describe('inferMobileRailFocusedKeyboardInset', () => {
  it('estimates a high mobile keyboard while leaving visible sheet space', () => {
    expect(inferMobileRailFocusedKeyboardInset(764)).toBe(321);
    expect(inferMobileRailFocusedKeyboardInset(740)).toBe(311);
  });

  it('caps tall screens and avoids impossible short viewports', () => {
    expect(inferMobileRailFocusedKeyboardInset(900)).toBe(378);
    expect(inferMobileRailFocusedKeyboardInset(375)).toBe(15);
    expect(inferMobileRailFocusedKeyboardInset(0)).toBe(0);
  });
});

// Regression guards for the iOS Chat-tab jitter fix. computeMobileRailViewportVars feeds
// resolveChatKeyboardInset, which feeds the idempotent --chat-keyboard-inset writer. If any of these
// drift, the iOS surface-height feedback loop can revive.
describe('computeMobileRailViewportVars is stable for identical input (idempotency)', () => {
  it('returns an identical result for the same iOS visual-viewport read called repeatedly', () => {
    const input = { viewportHeight: 480, viewportOffsetTop: 40, innerHeight: 800 };
    const first = computeMobileRailViewportVars({ ...input });
    for (let i = 0; i < 5; i += 1) {
      expect(computeMobileRailViewportVars({ ...input })).toEqual(first);
    }
    // The value the idempotent writer relies on: a settled read never drifts frame-to-frame.
    expect(first.keyboardInset).toBe(280);
    expect(first.source).toBe('visual-viewport');
  });
});

describe('resolveChatKeyboardInset', () => {
  const vars = (over: Partial<MobileRailViewportVars>): MobileRailViewportVars => ({
    vvh: 480, keyboardInset: 0, keyboardOpen: false, source: 'none', ...over,
  });

  it('passes through the visual-viewport / native inset that occludes the fixed composer', () => {
    expect(resolveChatKeyboardInset(vars({ keyboardOpen: true, source: 'visual-viewport', keyboardInset: 320 }))).toBe(320);
    expect(resolveChatKeyboardInset(vars({ keyboardOpen: true, source: 'native', keyboardInset: 300 }))).toBe(300);
    expect(resolveChatKeyboardInset(vars({ keyboardOpen: true, source: 'focused-control-fallback', keyboardInset: 260 }))).toBe(260);
  });

  it('forces 0 for the Android layout-viewport-resize branch even if an inset is present', () => {
    // The Android guard: adjustResize already shrank the layout viewport, so subtracting an inset
    // from a shrunken 100dvh would double-count. Must resolve to 0 regardless of keyboardInset.
    expect(resolveChatKeyboardInset(vars({ keyboardOpen: true, source: 'layout-viewport-resize', keyboardInset: 320 }))).toBe(0);
  });

  it('forces 0 when the keyboard is closed / idle', () => {
    expect(resolveChatKeyboardInset(vars({ keyboardOpen: false, source: 'none', keyboardInset: 0 }))).toBe(0);
  });
});

describe('shouldWriteChatKeyboardInset (idempotency gate — the primary jitter fuse)', () => {
  it('skips sub-epsilon jitter so an iOS resize storm cannot feed the write→layout→scroll loop', () => {
    expect(shouldWriteChatKeyboardInset(320, 321)).toBe(false);
    expect(shouldWriteChatKeyboardInset(320, 319)).toBe(false);
    expect(shouldWriteChatKeyboardInset(320, 320)).toBe(false);
  });

  it('commits a real change (>= epsilon) and always commits a full open/close (to/from 0)', () => {
    expect(shouldWriteChatKeyboardInset(320, 322)).toBe(true);
    expect(shouldWriteChatKeyboardInset(320, 0)).toBe(true);   // keyboard closed
    expect(shouldWriteChatKeyboardInset(0, 320)).toBe(true);   // keyboard opened
  });

  it('always commits the very first write (previous < 0)', () => {
    expect(shouldWriteChatKeyboardInset(-1, 0)).toBe(true);
    expect(shouldWriteChatKeyboardInset(-1, 320)).toBe(true);
  });

  it('honors a custom epsilon', () => {
    expect(shouldWriteChatKeyboardInset(300, 305, 10)).toBe(false);
    expect(shouldWriteChatKeyboardInset(300, 311, 10)).toBe(true);
  });
});

describe('decideChatAutoscroll (single source of truth for post-render chat snap)', () => {
  it('snaps on a brand-new message in the same session', () => {
    expect(decideChatAutoscroll({
      sessionId: 'a', messageCount: 4, lastRenderedSessionId: 'a', lastRenderedMessageCount: 3, forceScrollBottom: false,
    })).toEqual({ snapToBottom: true, nextSessionId: 'a', nextMessageCount: 4 });
  });

  it('snaps when the session changes (open a different chat / first open)', () => {
    expect(decideChatAutoscroll({
      sessionId: 'b', messageCount: 2, lastRenderedSessionId: 'a', lastRenderedMessageCount: 5, forceScrollBottom: false,
    })).toEqual({ snapToBottom: true, nextSessionId: 'b', nextMessageCount: 2 });
  });

  it('snaps on an explicit force even with no new message', () => {
    expect(decideChatAutoscroll({
      sessionId: 'a', messageCount: 3, lastRenderedSessionId: 'a', lastRenderedMessageCount: 3, forceScrollBottom: true,
    }).snapToBottom).toBe(true);
  });

  it('KEYSTONE: does NOT snap on an idle re-render (same session, same count, no force)', () => {
    // If this ever flips to true, the 5s relay-presence timer (and every other idle render) will
    // re-poke the transcript and the iOS chat jitter returns. Do not weaken.
    expect(decideChatAutoscroll({
      sessionId: 'a', messageCount: 3, lastRenderedSessionId: 'a', lastRenderedMessageCount: 3, forceScrollBottom: false,
    }).snapToBottom).toBe(false);
  });

  it('does not snap when the message count decreases (e.g. a session prune)', () => {
    expect(decideChatAutoscroll({
      sessionId: 'a', messageCount: 2, lastRenderedSessionId: 'a', lastRenderedMessageCount: 4, forceScrollBottom: false,
    }).snapToBottom).toBe(false);
  });

  it('treats a null session as no-snap and clears the bookkeeping id', () => {
    expect(decideChatAutoscroll({
      sessionId: null, messageCount: 0, lastRenderedSessionId: 'a', lastRenderedMessageCount: 3, forceScrollBottom: false,
    })).toEqual({ snapToBottom: false, nextSessionId: '', nextMessageCount: 0 });
  });

  it('always updates bookkeeping to the current input, snap or not', () => {
    const snap = decideChatAutoscroll({
      sessionId: 'x', messageCount: 7, lastRenderedSessionId: 'w', lastRenderedMessageCount: 1, forceScrollBottom: false,
    });
    expect(snap).toMatchObject({ nextSessionId: 'x', nextMessageCount: 7 });
    const idle = decideChatAutoscroll({
      sessionId: 'x', messageCount: 7, lastRenderedSessionId: 'x', lastRenderedMessageCount: 7, forceScrollBottom: false,
    });
    expect(idle).toMatchObject({ nextSessionId: 'x', nextMessageCount: 7, snapToBottom: false });
  });
});
