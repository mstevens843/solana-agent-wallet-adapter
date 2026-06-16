export function mobileRailSheetRouteAllowed(route: string | null | undefined): boolean {
  return route === '/app' || route === '/demo';
}

export function shouldClearActiveMobileRailSheet(options: {
  activeTab: string;
  mobileViewport: boolean;
  route: string | null | undefined;
  sheet: string | null | undefined;
}): boolean {
  return Boolean(
    options.sheet &&
      (!mobileRailSheetRouteAllowed(options.route) ||
        !options.mobileViewport ||
        options.activeTab !== 'overview'),
  );
}

export function shouldApplyMobileRailBodyDataset(options: {
  activeTab: string;
  mobileViewport: boolean;
  route: string | null | undefined;
  sheet: string | null | undefined;
}): boolean {
  return Boolean(
    options.sheet &&
      mobileRailSheetRouteAllowed(options.route) &&
      options.mobileViewport &&
      options.activeTab === 'overview',
  );
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
  /** Native keyboard occlusion in CSS px. Used when WebView visualViewport does not resize. */
  nativeKeyboardInset?: number;
  /** Native keyboard visibility. false ignores nativeKeyboardInset during keyboard-close races. */
  nativeKeyboardVisible?: boolean;
}

export interface MobileRailViewportVars {
  /** --mobile-rail-vvh: visible viewport height, floored at 320px for sheet sizing. */
  vvh: number;
  /** --mobile-rail-keyboard-inset: px the fixed sheet must lift to clear the keyboard. */
  keyboardInset: number;
}

/**
 * Pure viewport math for the keyboard-aware mobile rail sheet. Kept here (not inline in
 * main.ts) so the clamps are unit-testable. The keyboard inset is derived from the RAW
 * (un-floored) visual-viewport height so a small landscape viewport (vv.height < 320) still
 * lifts the sheet fully above the keyboard; the 320px floor applies only to the display height.
 */
export function computeMobileRailViewportVars(input: MobileRailViewportInput): MobileRailViewportVars {
  const innerHeight = input.innerHeight;
  const viewportRawHeight = Math.floor(input.viewportHeight ?? innerHeight);
  const offsetTop = Math.max(0, Math.floor(input.viewportOffsetTop ?? 0));
  const nativeKeyboardInset = Math.max(0, Math.floor(input.nativeKeyboardInset ?? 0));
  const useNativeKeyboardInset = nativeKeyboardInset > 0 && input.nativeKeyboardVisible !== false;
  const rawHeight = useNativeKeyboardInset
    ? Math.max(0, Math.min(viewportRawHeight, innerHeight - nativeKeyboardInset))
    : viewportRawHeight;
  const keyboardInset = useNativeKeyboardInset
    ? nativeKeyboardInset
    : Math.max(0, Math.floor(innerHeight - rawHeight - offsetTop));
  const vvh = Math.max(320, rawHeight);
  return { vvh, keyboardInset };
}
