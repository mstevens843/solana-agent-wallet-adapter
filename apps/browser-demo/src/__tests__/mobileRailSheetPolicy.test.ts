import { describe, expect, it } from 'vitest';

import {
  aiReviewSetupTabForMobileRailOpen,
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
