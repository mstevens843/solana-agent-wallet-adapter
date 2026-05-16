/**
 * The legacy tabs (Repeat Payments, Needs Approval, Agent Payments, Sessions)
 * are always shown alongside the unified Spend tab. The earlier Phase 3 plan
 * hid them behind `?legacy-tabs=1`; that was reverted on 2026-05-16 because
 * the consolidation removed surfaces users actually rely on.
 */
export function legacyTabsEnabled(): boolean {
  return true;
}
