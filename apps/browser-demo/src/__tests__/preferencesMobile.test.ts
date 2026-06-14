import { describe, expect, it } from 'vitest';

import {
  MOBILE_PREFERENCES_VIEW_ORDER,
  groupedFailureRetryKinds,
  mobilePreferencesDefaultView,
} from '../preferencesMobile.js';

describe('mobile Preferences helpers', () => {
  it('orders the high-use mobile sections with connectors first and backup last', () => {
    expect(MOBILE_PREFERENCES_VIEW_ORDER).toEqual([
      'access',
      'rules',
      'ai',
      'tokens',
      'workspace',
    ]);
  });

  it('defaults native mobile shells to connectors while preserving persisted choices', () => {
    expect(mobilePreferencesDefaultView(undefined, true)).toBe('access');
    expect(mobilePreferencesDefaultView(undefined, false)).toBe('workspace');
    expect(mobilePreferencesDefaultView('tokens', true)).toBe('tokens');
  });

  it('groups retry failures by wallet/setup, network, and transaction classes', () => {
    const groups = groupedFailureRetryKinds([
      'wallet_rejected',
      'rpc_timeout',
      'rate_limited',
      'simulation_failed',
      'unknown_maybe_submitted',
    ]);

    expect(groups.map((group) => group.title)).toEqual([
      'Wallet & setup',
      'Network / RPC',
      'Transaction / quote',
    ]);
    expect(groups[1]?.kinds).toEqual(['rpc_timeout', 'rate_limited']);
  });
});
