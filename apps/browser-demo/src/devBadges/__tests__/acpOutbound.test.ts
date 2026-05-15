import { describe, expect, it } from 'vitest';

import { matchAcpOutbound, renderAcpOutboundBadge } from '../acpOutbound.js';

describe('acp-outbound badge', () => {
  it('matches approvals whose metadata.source is acp_outbound', () => {
    expect(matchAcpOutbound({ metadata: { source: 'acp_outbound' } })).toBe(true);
    expect(matchAcpOutbound({ metadata: { source: 'acp_outbound', merchant: { name: 'Acme' } } })).toBe(true);
  });

  it('rejects approvals with other sources or no metadata', () => {
    expect(matchAcpOutbound({ metadata: { source: 'ap2_inbound' } })).toBe(false);
    expect(matchAcpOutbound({ metadata: null })).toBe(false);
    expect(matchAcpOutbound({})).toBe(false);
    expect(matchAcpOutbound(null)).toBe(false);
    expect(matchAcpOutbound(undefined)).toBe(false);
  });

  it('renders a pill containing the merchant name and payment token', () => {
    const html = renderAcpOutboundBadge({
      metadata: { source: 'acp_outbound', merchant: { name: 'Acme Coffee' }, paymentToken: 'USDC' },
    });
    expect(html).toContain('acp-outbound-pill');
    expect(html).toContain('Acme Coffee');
    expect(html).toContain('USDC');
  });

  it('escapes merchant name HTML', () => {
    const html = renderAcpOutboundBadge({
      metadata: { source: 'acp_outbound', merchant: { name: '<script>alert(1)</script>' } },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('falls back to "ACP cart" when merchant name is missing', () => {
    const html = renderAcpOutboundBadge({ metadata: { source: 'acp_outbound' } });
    expect(html).toContain('ACP · ACP cart');
  });
});

describe('acp-outbound badge registration', () => {
  it('registers itself with the approval-badge registry on module load', async () => {
    // Import the side-effecting module so registerApprovalBadge runs.
    await import('../acpOutbound.js');
    const { listApprovalBadges } = await import('../../approvalBadges.js');
    const ids = listApprovalBadges().map((b) => b.id);
    expect(ids).toContain('acp-outbound');
  });
});
