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
  refreshInFlight: boolean;
  setupTab: string;
  sheet: string;
}): boolean {
  return options.sheet === 'ai-drafting' &&
    options.aiMode === 'device-agent' &&
    options.setupTab !== 'plan-connector' &&
    !options.refreshInFlight;
}

export function shouldResetAiReviewSetupTabOnMobileRailOpen(options: {
  currentSheet: string | null | undefined;
  nextSheet: string;
}): boolean {
  return options.nextSheet === 'ai-drafting' && options.currentSheet !== 'ai-drafting';
}
