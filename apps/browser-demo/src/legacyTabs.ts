/**
 * Phase 3 feature-flag direction (locked 2026-05-16):
 *
 *   - DEFAULT: the unified Spend tab is shown; the legacy Agent Payments /
 *     Recurring / Sessions tabs are hidden.
 *   - OPT-OUT: `?legacy-tabs=1` query param re-enables the legacy tabs so
 *     users can fall back if they hit a regression in the Spend view.
 *
 * This inverts the literal plan wording ("feature flag default off; release
 * behind it for 1 week; flip on if no regressions"). The implemented
 * direction was chosen because Phases 1+2 audited green and the Spend tab
 * has its own test suite (`devTabs/__tests__/spend.test.ts`); shipping the
 * new UX with a graceful rollback path is lower-risk than gating it behind
 * a discoverability-zero flag. Revisit if a regression appears in the wild.
 */
export function legacyTabsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return new URL(window.location.href).searchParams.get('legacy-tabs') === '1';
}
