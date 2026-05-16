// Phase 5 — eligibility matrix for `isBrowserNativeRuntimeEligible`.
//
// Note on flag-positive cases: `VITE_AGENTIC_DEVICE_AGENT` is replaced at Vite
// build-time via `define` in apps/browser-demo/vite.config.ts. That means even
// `vi.stubEnv` + `vi.resetModules` cannot flip the value at runtime — by
// production design, the flag is locked at bundle time. Tests below therefore
// cover every observable branch reachable with flags=off (the test bundle
// default), and the flag-on integration is verified by Phase 6's main.ts
// wiring tests against a build that actually has the flag enabled.

import { describe, expect, it } from 'vitest';

import {
  DEVICE_AGENT_WALLET_ALLOWLIST,
  isBrowserNativeRuntimeEligible,
} from '../devGate.js';

const ALLOWLISTED_WALLET = DEVICE_AGENT_WALLET_ALLOWLIST[0] ?? '';
const NON_ALLOWLISTED_WALLET = 'WalletAddressDeliberatelyOutsideAllowlist';

describe('isBrowserNativeRuntimeEligible', () => {
  it('is a function exported from devGate', () => {
    expect(typeof isBrowserNativeRuntimeEligible).toBe('function');
  });

  it('returns false when isAndroidApp is true even with an allowlisted wallet', () => {
    expect(isBrowserNativeRuntimeEligible(ALLOWLISTED_WALLET, true)).toBe(false);
  });

  it('returns false when wallet is undefined', () => {
    expect(isBrowserNativeRuntimeEligible(undefined, false)).toBe(false);
  });

  it('returns false when wallet is null', () => {
    expect(isBrowserNativeRuntimeEligible(null, false)).toBe(false);
  });

  it('returns false when wallet is an empty string', () => {
    expect(isBrowserNativeRuntimeEligible('', false)).toBe(false);
  });

  it('returns false when wallet is not in the allowlist', () => {
    expect(isBrowserNativeRuntimeEligible(NON_ALLOWLISTED_WALLET, false)).toBe(false);
  });

  it('returns false when build flags are off even with an allowlisted wallet (test env default)', () => {
    // This is the production contract: with VITE_AGENTIC_DEVICE_AGENT and/or
    // VITE_AGENTIC_BROWSER_DEVICE_AGENT off, eligibility is never granted —
    // regardless of wallet membership. The default test bundle has both off.
    expect(isBrowserNativeRuntimeEligible(ALLOWLISTED_WALLET, false)).toBe(false);
  });
});
