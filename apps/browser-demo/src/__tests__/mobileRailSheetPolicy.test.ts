import { describe, expect, it } from 'vitest';

import {
  mobileRailSheetRouteAllowed,
  shouldApplyMobileRailBodyDataset,
  shouldClearActiveMobileRailSheet,
  shouldResetAiReviewSetupTabOnMobileRailOpen,
  shouldRefreshDeviceAgentStatusForMobileRailOpen,
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
      refreshInFlight: false,
      setupTab: 'api-key',
      sheet: 'ai-drafting',
    })).toBe(true);
    expect(shouldRefreshDeviceAgentStatusForMobileRailOpen({
      aiMode: 'device-agent',
      refreshInFlight: true,
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
});
