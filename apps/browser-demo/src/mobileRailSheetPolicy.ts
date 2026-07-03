export function mobileRailSheetRouteAllowed(route: string | null | undefined): boolean {
  return route === '/app' || route === '/demo';
}

const CHAT_TAB_MOBILE_RAIL_SHEETS = new Set(['chat-action', 'chat-wallet-balances', 'chat-research']);
const ANY_TAB_MOBILE_RAIL_SHEETS = new Set(['connector-connect']);

function isChatTabMobileRailSheet(sheet: string | null | undefined): boolean {
  return Boolean(sheet && CHAT_TAB_MOBILE_RAIL_SHEETS.has(sheet));
}

function isAnyTabMobileRailSheet(sheet: string | null | undefined): boolean {
  return Boolean(sheet && ANY_TAB_MOBILE_RAIL_SHEETS.has(sheet));
}

export function shouldClearActiveMobileRailSheet(options: {
  activeTab: string;
  mobileViewport: boolean;
  route: string | null | undefined;
  sheet: string | null | undefined;
}): boolean {
  if (!options.sheet) return false;
  if (!mobileRailSheetRouteAllowed(options.route)) return true;
  if (isAnyTabMobileRailSheet(options.sheet)) return !options.mobileViewport;
  // Chat-tab sheets are opened only on native mobile (gated at the
  // open site) and live on the Chat tab; clear them whenever we leave that tab.
  if (isChatTabMobileRailSheet(options.sheet)) return options.activeTab !== 'chat';
  return !options.mobileViewport || options.activeTab !== 'overview';
}

export function shouldApplyMobileRailBodyDataset(options: {
  activeTab: string;
  mobileViewport: boolean;
  route: string | null | undefined;
  sheet: string | null | undefined;
}): boolean {
  if (!options.sheet || !mobileRailSheetRouteAllowed(options.route)) return false;
  if (isAnyTabMobileRailSheet(options.sheet)) return options.mobileViewport;
  if (isChatTabMobileRailSheet(options.sheet)) return options.activeTab === 'chat';
  return options.mobileViewport && options.activeTab === 'overview';
}

export function shouldRefreshDeviceAgentStatusForMobileRailOpen(options: {
  aiMode: string;
  deviceAgentConfigured?: boolean;
  refreshInFlight: boolean;
  setupTab: string;
  sheet: string;
}): boolean {
  return options.sheet === 'ai-drafting' &&
    options.aiMode === 'device-agent' &&
    options.setupTab !== 'plan-connector' &&
    !options.deviceAgentConfigured &&
    !options.refreshInFlight;
}

export function shouldResetAiReviewSetupTabOnMobileRailOpen(options: {
  currentSheet: string | null | undefined;
  nextSheet: string;
}): boolean {
  return options.nextSheet === 'ai-drafting' && options.currentSheet !== 'ai-drafting';
}

export function aiReviewSetupTabForMobileRailOpen(options: {
  currentSheet: string | null | undefined;
  nextSheet: string;
  currentSetupTab: string;
  planConnectorConfigured: boolean;
  apiKeyConfigured: boolean;
}): 'api-key' | 'plan-connector' {
  if (!shouldResetAiReviewSetupTabOnMobileRailOpen(options)) {
    return options.currentSetupTab === 'plan-connector' ? 'plan-connector' : 'api-key';
  }
  if (options.planConnectorConfigured) return 'plan-connector';
  if (options.apiKeyConfigured) return 'api-key';
  return options.currentSetupTab === 'plan-connector' ? 'plan-connector' : 'api-key';
}

export function shouldCloseWorkspaceStorageSheetAfterCloudSignIn(sheet: string | null | undefined): boolean {
  void sheet;
  return false;
}

export function shouldSuppressMobileRailSheetEnterAnimation(options: {
  currentSheet: string | null | undefined;
  previousSheet: string | null | undefined;
  forceSuppress: boolean;
}): boolean {
  return Boolean(
    options.currentSheet &&
      (options.forceSuppress || options.currentSheet === options.previousSheet),
  );
}

export interface MobileRailViewportInput {
  /** window.visualViewport.height (undefined when visualViewport is unavailable). */
  viewportHeight?: number;
  /** window.visualViewport.offsetTop (undefined when visualViewport is unavailable). */
  viewportOffsetTop?: number;
  /** window.innerHeight (the layout viewport height). */
  innerHeight: number;
  /** Last stable window.innerHeight captured while no mobile rail text control was focused. */
  baselineInnerHeight?: number;
  /** Native keyboard occlusion in CSS px. Used when WebView visualViewport does not resize. */
  nativeKeyboardInset?: number;
  /** Native keyboard visibility. false ignores nativeKeyboardInset during keyboard-close races. */
  nativeKeyboardVisible?: boolean;
  /** Last-resort CSS px estimate while a text control is focused and no keyboard metric is available. */
  focusedControlFallbackInset?: number;
}

export type MobileRailViewportMetricSource =
  | 'none'
  | 'native'
  | 'visual-viewport'
  | 'layout-viewport-resize'
  | 'focused-control-fallback';

export interface MobileRailViewportVars {
  /** --mobile-rail-vvh: visible viewport height, floored at 320px for sheet sizing. */
  vvh: number;
  /** --mobile-rail-keyboard-inset: px the fixed sheet must lift to clear the keyboard. */
  keyboardInset: number;
  /** True when any keyboard path is active, including layout-resize where keyboardInset stays 0. */
  keyboardOpen: boolean;
  /** Which metric path won. Useful for diagnostics and native bridge regressions. */
  source: MobileRailViewportMetricSource;
}

/**
 * Pure viewport math for the keyboard-aware mobile rail sheet. Kept here (not inline in
 * main.ts) so the clamps are unit-testable. Android WebView can either overlay the keyboard
 * or shrink the layout viewport via adjustResize; layout-resize mode deliberately returns a
 * 0px bottom inset because fixed-position UI is already above the keyboard in that viewport.
 * The 320px floor applies only to display height, not the detected keyboard metric.
 */
export function computeMobileRailViewportVars(input: MobileRailViewportInput): MobileRailViewportVars {
  const innerHeight = input.innerHeight;
  const viewportRawHeight = Math.floor(input.viewportHeight ?? innerHeight);
  const offsetTop = Math.max(0, Math.floor(input.viewportOffsetTop ?? 0));
  const nativeKeyboardInset = Math.max(0, Math.floor(input.nativeKeyboardInset ?? 0));
  const visualKeyboardInset = Math.max(0, Math.floor(innerHeight - viewportRawHeight - offsetTop));
  const focusedControlFallbackInset = Math.max(0, Math.floor(input.focusedControlFallbackInset ?? 0));
  const layoutViewportResizeInset = mobileRailLayoutViewportResizeInset(input.baselineInnerHeight, innerHeight);
  const useLayoutViewportResize =
    layoutViewportResizeInset > 0 &&
    (input.nativeKeyboardVisible === true || focusedControlFallbackInset > 0);
  const useNativeKeyboardInset =
    !useLayoutViewportResize &&
    nativeKeyboardInset > 0 &&
    input.nativeKeyboardVisible !== false;
  const useVisualKeyboardInset = !useLayoutViewportResize && !useNativeKeyboardInset && visualKeyboardInset > 0;
  const useFocusedControlFallback =
    !useLayoutViewportResize &&
    !useNativeKeyboardInset &&
    !useVisualKeyboardInset &&
    visualKeyboardInset === 0 &&
    focusedControlFallbackInset > 0;
  let rawHeight = viewportRawHeight;
  let keyboardInset = 0;
  let source: MobileRailViewportMetricSource = 'none';
  if (useLayoutViewportResize) {
    source = 'layout-viewport-resize';
  } else if (useNativeKeyboardInset) {
    rawHeight = Math.max(0, Math.min(viewportRawHeight, innerHeight - nativeKeyboardInset));
    keyboardInset = nativeKeyboardInset;
    source = 'native';
  } else if (useVisualKeyboardInset) {
    keyboardInset = visualKeyboardInset;
    source = 'visual-viewport';
  } else if (useFocusedControlFallback) {
    rawHeight = Math.max(0, Math.min(viewportRawHeight, innerHeight - focusedControlFallbackInset));
    keyboardInset = focusedControlFallbackInset;
    source = 'focused-control-fallback';
  }
  const vvh = Math.max(320, rawHeight);
  return { vvh, keyboardInset, keyboardOpen: source !== 'none', source };
}

/**
 * The px the Chat surface should subtract from 100dvh for the keyboard, given resolved viewport
 * vars. Only `native` / `visual-viewport` sources actually occlude the fixed composer; the Android
 * `layout-viewport-resize` branch (adjustResize) already shrank the layout viewport, and `none`
 * (idle, keyboard closed) has nothing to subtract — both resolve to 0 so the surface never shrinks
 * spuriously. Keeping this pure (not inline in main.ts) makes the Android/idle=0 guarantee testable.
 */
export function resolveChatKeyboardInset(vars: MobileRailViewportVars): number {
  if (!vars.keyboardOpen) return 0;
  if (vars.source === 'layout-viewport-resize') return 0;
  return vars.keyboardInset;
}

/**
 * Idempotency gate for the `--chat-keyboard-inset` writer. Returns false (skip the write) when the
 * new inset is unchanged or within `epsilon` px of the last written value, so an iOS visualViewport
 * resize/scroll storm can't feed a write→layout→scroll→write feedback loop (the historic chat
 * jitter). A first write (`previous < 0`) and any transition to/from an exact 0 (keyboard fully
 * open/close) always commit so the composer still snaps above the keyboard and settles on close.
 */
export function shouldWriteChatKeyboardInset(previous: number, next: number, epsilon = 2): boolean {
  if (previous < 0) return true;
  if (next === previous) return false;
  if (next === 0 || previous === 0) return true;
  return Math.abs(next - previous) >= epsilon;
}

export interface ChatAutoscrollInput {
  sessionId: string | null;
  messageCount: number;
  lastRenderedSessionId: string;
  lastRenderedMessageCount: number;
  forceScrollBottom: boolean;
}

export interface ChatAutoscrollDecision {
  snapToBottom: boolean;
  nextSessionId: string;
  nextMessageCount: number;
}

/**
 * SINGLE source of truth for "should a post-render chat re-render pull the transcript to the
 * bottom?". Both render paths (the morph fast-path and the full-render path) derive their decision
 * here so they can never again diverge into the sync+rAF double-snap that thrashed iOS. Snap only
 * on an explicit force, a brand-new message in the SAME session, or a session switch. An idle
 * re-render (same session, same count, no force) must NOT snap — that is the property that keeps the
 * 5s relay-presence timer and every other idle render from re-poking the transcript.
 */
export function decideChatAutoscroll(input: ChatAutoscrollInput): ChatAutoscrollDecision {
  const sameSession = input.sessionId ? input.sessionId === input.lastRenderedSessionId : false;
  const hasNewMessage = sameSession && input.messageCount > input.lastRenderedMessageCount;
  const sessionChanged = Boolean(input.sessionId) && !sameSession;
  return {
    snapToBottom: input.forceScrollBottom || hasNewMessage || sessionChanged,
    nextSessionId: input.sessionId ?? '',
    nextMessageCount: input.messageCount,
  };
}

export function inferMobileRailFocusedKeyboardInset(innerHeight: number): number {
  if (!Number.isFinite(innerHeight) || innerHeight <= 0) return 0;
  const height = Math.floor(innerHeight);
  const maxInset = Math.max(0, Math.min(420, height - 360));
  if (maxInset <= 0) return 0;
  const minInset = Math.min(240, maxInset);
  const preferredInset = Math.round(height * 0.42);
  return Math.min(maxInset, Math.max(minInset, preferredInset));
}

function mobileRailLayoutViewportResizeInset(
  baselineInnerHeight: number | undefined,
  currentInnerHeight: number,
): number {
  if (!Number.isFinite(currentInnerHeight) || currentInnerHeight <= 0) return 0;
  if (!Number.isFinite(baselineInnerHeight) || !baselineInnerHeight) return 0;
  const baseline = Math.floor(baselineInnerHeight);
  const current = Math.floor(currentInnerHeight);
  const inset = baseline - current;
  if (inset <= 0) return 0;
  const threshold = Math.min(140, Math.max(80, Math.round(baseline * 0.14)));
  return inset >= threshold ? inset : 0;
}
