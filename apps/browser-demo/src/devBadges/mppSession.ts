import { registerApprovalBadge } from '../approvalBadges.js';

interface ActionWithMppMeta {
  metadata?: { connectorId?: string } | null;
}

export function matchMppSession(action: ActionWithMppMeta | null | undefined): boolean {
  return action?.metadata?.connectorId === 'mpp';
}

export function renderMppSessionBadge(_action: ActionWithMppMeta): string {
  return '<span class="approval-badge approval-badge--mpp">MPP</span>';
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
