import { registerApprovalBadge } from '../approvalBadges.js';
import './ap2Verified.css';

interface Ap2VerifiedAgent {
  agentId: string;
  agentLabel: string;
  verified: boolean;
}

interface ActionWithAp2Meta {
  metadata?: { ap2VerifiedAgent?: Ap2VerifiedAgent } | null;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

registerApprovalBadge<ActionWithAp2Meta>({
  id: 'ap2-verified',
  match: (action) => action?.metadata?.ap2VerifiedAgent?.verified === true,
  render: (action) => {
    const label = action?.metadata?.ap2VerifiedAgent?.agentLabel ?? 'agent';
    const safe = escapeText(label);
    return `<span class="ap2-verified-pill" title="AP2-verified agent: ${safe}">AP2 verified · ${safe}</span>`;
  },
});
