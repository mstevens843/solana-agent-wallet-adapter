import { describe, expect, it } from 'vitest';

import { reviewEvidenceSections, type AgentEvidenceReviewLike } from '../agentReviewPresentation.js';
import { tDemo } from '../demo-i18n/tDemo.js';

// The /demo Plan 2/3 drawer reuses the shared evidence system, which buckets findings into
// sections by ENGLISH-keyword regex on the raw row (then localizes for display). The demo must
// therefore feed ENGLISH findings; translating them first collapses market/token/transaction into
// "Other". This test locks in that contract — it is the reason guidedDemoReviewPreparedPlan keeps
// review.findings English and guidedDemoReviewDrawer post-translates the rendered rows.

const ENGLISH_PLAN2_REVIEW: AgentEvidenceReviewLike = {
  status: 'approved',
  decision: 'approve',
  summary: 'Threshold rule checked: $15 is under $20.',
  reason: "Monthly rate is $15, under the user's $20 threshold, so the agent approved the $20 payout for wallet approval.",
  checks: [
    { label: 'Threshold check', value: 'Corrected model comparison: $15 is under $20. Original decision was deny.', tone: 'good' },
    { label: 'Monthly rate', value: '$15/month', tone: 'good' },
    { label: 'Token age', value: 'POPCAT age is 29.4 months, above the required 24h gate.', tone: 'good' },
    { label: 'Transaction simulation', value: 'Runs after the wallet signs and broadcasts.', tone: 'neutral' },
    { label: 'Action mismatch', value: 'None - the prepared $20 payout matches the approved action.', tone: 'good' },
  ],
  evidence: {
    sources: [{ title: 'All Things Helium Mobile FAQ', url: 'https://support.hellohelium.com/en/articles/7039213' }],
  },
  // The demo drives the display language via localized.language (reviewDisplayLanguage reads it first).
  localized: { language: 'es', status: 'ready', source: 'phrase_pack' },
};

describe('demo review evidence bucketing', () => {
  it('buckets English findings into the right sections even when display language is es', () => {
    const sections = reviewEvidenceSections(ENGLISH_PLAN2_REVIEW, { actionType: 'transfer_sol' });
    const ids = sections.map((s) => s.id);
    // The whole point: market / token / transaction are NOT collapsed into "other".
    expect(ids).toContain('decision');
    expect(ids).toContain('market');
    expect(ids).toContain('token');
    expect(ids).toContain('transaction');
    expect(ids).toContain('sources');
  });

  it('localizes section headers to the display language', () => {
    const sections = reviewEvidenceSections(ENGLISH_PLAN2_REVIEW, { actionType: 'transfer_sol' });
    const market = sections.find((s) => s.id === 'market');
    const decision = sections.find((s) => s.id === 'decision');
    // es headers must differ from the English defaults.
    expect(market?.label).toBeTruthy();
    expect(market?.label).not.toBe('Market & Price');
    expect(decision?.label).not.toBe('Decision');
  });

  it('post-translates finding labels + values from the catalog (full drawer pipeline)', () => {
    // Mirrors guidedDemoReviewDrawer: bucket on English, then post-translate the rendered rows.
    const sections = reviewEvidenceSections(ENGLISH_PLAN2_REVIEW, { actionType: 'transfer_sol' });
    const localized = sections.map((section) => ({
      ...section,
      rows: section.rows.map((row) => ({ ...row, label: tDemo(row.label, 'es'), value: tDemo(row.value, 'es') })),
    }));
    const labels = localized.flatMap((section) => section.rows.map((row) => row.label));
    const values = localized.flatMap((section) => section.rows.map((row) => row.value));

    // "Action mismatch" is uncovered by the shared dictionary/prose, so ONLY our catalog can
    // translate it — this proves the post-translate fills the gap the shared system leaves.
    const enLabel = 'Action mismatch';
    const enValue = 'None - the prepared $20 payout matches the approved action.';
    const esLabel = tDemo(enLabel, 'es');
    const esValue = tDemo(enValue, 'es');
    expect(esLabel).not.toBe(enLabel); // catalog has a translation
    expect(esValue).not.toBe(enValue);
    expect(esValue).toContain('$20'); // protected token preserved
    expect(labels).toContain(esLabel);
    expect(values).toContain(esValue);
    expect(labels).not.toContain(enLabel); // English originals are gone
    expect(values).not.toContain(enValue);
  });

  it('demonstrates why pre-translated findings break bucketing (collapse to other)', () => {
    const preTranslated: AgentEvidenceReviewLike = {
      ...ENGLISH_PLAN2_REVIEW,
      checks: [
        { label: 'Tarifa mensual', value: '$15/mes', tone: 'good' },
        { label: 'Simulación de transacción', value: 'Se ejecuta después de firmar.', tone: 'neutral' },
      ],
    };
    const ids = reviewEvidenceSections(preTranslated, { actionType: 'transfer_sol' }).map((s) => s.id);
    // Spanish labels miss the English keyword regex for market/transaction → "other".
    expect(ids).not.toContain('market');
    expect(ids).not.toContain('transaction');
    expect(ids).toContain('other');
  });
});
