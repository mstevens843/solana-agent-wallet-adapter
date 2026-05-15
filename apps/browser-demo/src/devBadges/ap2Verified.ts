import { registerApprovalBadge } from '../approvalBadges.js';
import './ap2Verified.css';

// Mirrors `packages/ap2-adapter/src/types.ts::Ap2VerifiedAgent` plus the
// `publicKey` enrichment that `apps/render-web/src/cloud/ap2Routes.ts` adds
// before persisting (lines 211-215). Kept local to avoid pulling
// `ap2-adapter`'s `node:crypto` deps into the browser bundle.
interface Ap2VerifiedAgent {
  agentId: string;
  agentLabel: string;
  publicKey?: string;
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

function isValidVerifiedAgent(agent: unknown): agent is Ap2VerifiedAgent {
  if (typeof agent !== 'object' || agent === null) return false;
  const candidate = agent as { agentId?: unknown; agentLabel?: unknown };
  return typeof candidate.agentId === 'string' && typeof candidate.agentLabel === 'string';
}

registerApprovalBadge<ActionWithAp2Meta>({
  id: 'ap2-verified',
  match: (action) => isValidVerifiedAgent(action?.metadata?.ap2VerifiedAgent),
  render: (action) => {
    const agent = action?.metadata?.ap2VerifiedAgent;
    if (!isValidVerifiedAgent(agent)) return '';
    const label = agent.agentLabel || agent.agentId;
    const safeLabel = escapeText(label);
    const tooltipSuffix = agent.publicKey ? ` · ${escapeText(agent.publicKey)}` : '';
    return `<span class="ap2-verified-pill" title="AP2-verified agent: ${safeLabel}${tooltipSuffix}">AP2 verified · ${safeLabel}</span>`;
  },
});

// Test-only surface; ignored by the runtime registration above.
export const __ap2VerifiedBadgeForTests = {
  matchAction: (action: ActionWithAp2Meta): boolean =>
    isValidVerifiedAgent(action?.metadata?.ap2VerifiedAgent),
  isValidVerifiedAgent,
  escapeText,
};
