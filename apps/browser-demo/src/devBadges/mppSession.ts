import { registerApprovalBadge } from '../approvalBadges.js';

// Phase 0 scaffolding. Phase 1 implements match() = action.metadata?.connectorId === 'mpp'
// and renders an "MPP" pill alongside the existing AP2 / ACP badges in the
// Incoming Requests row. Until then this badge is registered (so the registry
// is wired) but never matches.

interface ActionWithMppMeta {
  metadata?: { connectorId?: string } | null;
}

export function matchMppSession(_action: ActionWithMppMeta | null | undefined): boolean {
  return false; // Phase 1 sets: action?.metadata?.connectorId === 'mpp'
}

export function renderMppSessionBadge(_action: ActionWithMppMeta): string {
  return ''; // Phase 1 returns: '<span class="approval-badge approval-badge--mpp">MPP</span>'
}

registerApprovalBadge<ActionWithMppMeta>({
  id: 'mpp-session',
  match: matchMppSession,
  render: renderMppSessionBadge,
});

export const __mppSessionBadgeForTests = {
  matchMppSession,
  renderMppSessionBadge,
};
