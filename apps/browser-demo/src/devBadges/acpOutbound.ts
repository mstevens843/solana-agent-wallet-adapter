import './acpOutbound.css';
import { registerApprovalBadge } from '../approvalBadges.js';

interface ActionWithAcpMeta {
  metadata?: {
    source?: string;
    merchant?: { name?: string };
    paymentToken?: string;
  } | null;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function matchAcpOutbound(action: ActionWithAcpMeta | null | undefined): boolean {
  return action?.metadata?.source === 'acp_outbound';
}

export function renderAcpOutboundBadge(action: ActionWithAcpMeta): string {
  const name = action?.metadata?.merchant?.name ?? 'ACP cart';
  const token = action?.metadata?.paymentToken;
  const safe = escapeText(name);
  const tokenSuffix = token ? ` · ${escapeText(token)}` : '';
  return `<span class="acp-outbound-pill" title="ACP outbound payment to ${safe}">ACP · ${safe}${tokenSuffix}</span>`;
}

registerApprovalBadge<ActionWithAcpMeta>({
  id: 'acp-outbound',
  match: matchAcpOutbound,
  render: renderAcpOutboundBadge,
});
