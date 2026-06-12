// Regression guard for the guided /demo AGENT DECISION card (Plan 2 = Helium threshold payout,
// Plan 3 = Mad Lads NFT floor buy). These plans render the rich grouped agent-findings card by handing a
// plain review object to the same `reviewEvidenceSections()` the real /app workspace uses. Section routing is
// keyword-based, so a reworded finding can silently land in the wrong group — these tests pin the mapping to
// the exact copy in AGENT_DECISION_PLANS (apps/browser-demo/src/main.ts).
//
// NOTE: filename keeps a `_tmp_` prefix only because the dev environment blocked file rename/delete; the test
// itself is a keeper. Rename to e.g. guidedDemoAgentDecisionReview.test.ts when convenient.
import { describe, expect, it } from 'vitest';
import { reviewEvidenceSections } from '../agentReviewPresentation';

// Mirrors the review object guidedDemoReviewPreparedPlan() builds for Plan 2 (Helium).
const heliumReview = {
  required: true,
  status: 'approved' as const,
  decision: 'approve' as const,
  summary: 'Threshold rule checked: $15 is under $20.',
  reason: "Monthly rate is $15, under the user's $20 threshold, so the agent approved the $20 payout for wallet approval.",
  checks: [
    { label: 'Threshold check', value: 'Corrected model comparison: $15 is under $20. Original decision was deny.', tone: 'good' as const },
    { label: 'Threshold rule promoted', value: 'true', tone: 'good' as const },
    { label: 'Monthly rate', value: '$15/month', tone: 'good' as const },
    { label: 'Transaction simulation', value: 'Runs after the wallet signs and broadcasts.', tone: 'neutral' as const },
    { label: 'Helium Mobile lowest plan', value: '$15/month', tone: 'good' as const },
    { label: 'Action mismatch', value: 'None - the prepared $20 payout matches the approved action.', tone: 'good' as const },
    { label: 'Prepared action', value: 'Send $20 USDC to the saved Coinbase address.', tone: 'neutral' as const },
    { label: 'Requested action', value: 'Check Helium Mobile lowest monthly plan and approve only if under $20.', tone: 'neutral' as const },
  ],
  evidence: {
    sources: [
      { title: 'All Things Helium Mobile FAQ', url: 'https://support.hellohelium.com/x' },
      { title: 'Helium Mobile plan terms', url: 'https://heliummobile.com/' },
    ],
    decisionContract: { decision: 'approve', confidence: 'high', evidenceFactIds: ['a', 'b', 'c'], blockingFactIds: [], missingFactIds: [], warnings: [] },
  },
};

// Plan 3 (Mad Lads NFT floor).
const nftReview = {
  required: true,
  status: 'approved' as const,
  decision: 'approve' as const,
  summary: 'Floor rule checked: 26.4 SOL is under 30 SOL.',
  reason: "Mad Lads floor is 26.4 SOL, under the user's 30 SOL ceiling, so the agent approved buying the cheapest listing for wallet approval.",
  checks: [
    { label: 'Threshold check', value: 'Floor 26.4 SOL is under the 30 SOL approval threshold.', tone: 'good' as const },
    { label: 'Decision rule', value: 'Floor under the ceiling -> APPROVE buying the cheapest listing.', tone: 'good' as const },
    { label: 'Floor price', value: '26.4 SOL', tone: 'good' as const },
    { label: '24h volume', value: '812 SOL across 41 sales', tone: 'neutral' as const },
    { label: 'Buy scope', value: 'Buys only the one approved NFT; no extra transfer or unknown recipient.', tone: 'good' as const },
    { label: 'Transaction simulation', value: 'Runs after the wallet signs and broadcasts.', tone: 'neutral' as const },
    { label: 'Cheapest listing', value: '26.4 SOL - Mad Lad #4198', tone: 'good' as const },
    { label: 'Collection verified', value: 'Mad Lads is a verified Magic Eden collection.', tone: 'good' as const },
    { label: 'Prepared action', value: 'Buy Mad Lad #4198 for 26.4 SOL on Magic Eden.', tone: 'neutral' as const },
  ],
  evidence: {
    sources: [
      { title: 'Magic Eden - Mad Lads', url: 'https://magiceden.io/marketplace/mad_lads' },
      { title: 'Magic Eden collection stats API', url: 'https://api-mainnet.magiceden.dev/x' },
    ],
    decisionContract: { decision: 'approve', confidence: 'high', evidenceFactIds: ['a', 'b', 'c'], blockingFactIds: [], missingFactIds: [], warnings: [] },
  },
};

function byId(sections: ReturnType<typeof reviewEvidenceSections>, id: string) {
  return sections.find((s) => s.id === id);
}
function labels(sections: ReturnType<typeof reviewEvidenceSections>, id: string) {
  return (byId(sections, id)?.rows ?? []).map((r) => r.label);
}

describe('guided demo agent-decision plan review bucketing', () => {
  it('Helium routes findings into the expected grouped sections', () => {
    const sections = reviewEvidenceSections(heliumReview, { actionType: 'transfer_sol' });
    expect(labels(sections, 'decision')).toEqual(
      expect.arrayContaining(['Summary', 'Approval summary', 'Threshold check', 'Threshold rule promoted']),
    );
    expect(labels(sections, 'market')).toContain('Monthly rate');
    expect(labels(sections, 'transaction')).toContain('Transaction simulation');
    expect(labels(sections, 'other')).toEqual(
      expect.arrayContaining(['Helium Mobile lowest plan', 'Action mismatch', 'Prepared action', 'Requested action']),
    );
    expect(byId(sections, 'sources')?.rows.length).toBe(2);
    expect(byId(sections, 'advanced')?.advanced).toBe(true);
    expect(labels(sections, 'advanced')).toContain('Decision contract');
  });

  it('NFT floor routes findings into the expected grouped sections', () => {
    const sections = reviewEvidenceSections(nftReview, { actionType: 'transfer_sol' });
    expect(labels(sections, 'decision')).toEqual(expect.arrayContaining(['Threshold check', 'Decision rule']));
    expect(labels(sections, 'market')).toEqual(expect.arrayContaining(['Floor price', '24h volume']));
    expect(labels(sections, 'transaction')).toEqual(expect.arrayContaining(['Buy scope', 'Transaction simulation']));
    expect(labels(sections, 'other')).toEqual(
      expect.arrayContaining(['Cheapest listing', 'Collection verified', 'Prepared action']),
    );
    expect(byId(sections, 'sources')?.rows.length).toBe(2);
    expect(labels(sections, 'advanced')).toContain('Decision contract');
  });
});
