import type {
  AgentPlanReviewDecision,
  AgentPlanReviewRequest,
  AgentPlanReviewResult,
  AgentReviewQuestion,
} from './agentPlans.js';

export type ThresholdReviewTone = 'good' | 'warn' | 'neutral' | 'fail';

export interface ThresholdRule {
  threshold: number;
  approveWhen: 'below' | 'above';
}

export interface ThresholdPriceCandidate {
  amount: number;
  label: string;
  text: string;
  source: 'finding' | 'reason' | 'summary' | 'research' | 'evidence';
}

export interface ReviewFinding {
  label: string;
  value: string;
  tone: ThresholdReviewTone;
}

const PRICE_CONTEXT_KEYWORDS = /\b(cost|costs|price|priced|plan|plans|monthly|weekly|yearly|annual|per\s+(?:month|year|mo|yr)|\/mo|\/month|\/yr|\/year|subscription|rate|rates|fee|fees|charge|charges|tier|tiers|amount|currently|today|current|cheapest|air|infinity|starts\s+at|priced\s+at)\b/i;

const PRICE_LIKE_LABEL = /plan\s*rate|subscription|fact|answer|current\s*price|monthly\s*cost|monthly|^rate$|^price$|^cost$|price$|rate$|cost$|fee$/i;

// Token symbols and crypto-asset words that strongly signal a candidate sentence is about
// a swap/quote/asset rather than the user's off-chain question. Used to de-prefer candidates
// when the user's instruction's subject is something else (e.g. "helium phone plan").
const CRYPTO_ASSET_TOKENS = /\b(SOL|WSOL|BTC|BITCOIN|ETH|ETHEREUM|USDC|USDT|JUP|BONK|WIF|PYUSD|MSOL|JITOSOL|swap\s+(?:quote|rate|price)|token\s+price|sol\s+price|sol\/usd)\b/i;

const FACT_LABEL_HINTS: Array<{ test: RegExp; label: string }> = [
  { test: /\bplan\s+rate\b/i, label: 'Plan rate' },
  { test: /\bmonthly\s+plan\b|\bmonthly\s+rate\b|\bmonthly\s+cost\b|\bmonthly\s+price\b|\bmonthly\s+fee\b/i, label: 'Monthly rate' },
  { test: /\bsubscription\b/i, label: 'Subscription price' },
  { test: /\bcurrent\s+price\b/i, label: 'Current price' },
  { test: /\bfloor\s+price\b|\bfloor\b/i, label: 'Floor price' },
  { test: /\bannual\b|\byearly\b|\bper\s+year\b/i, label: 'Annual rate' },
  { test: /\bweekly\b|\bper\s+week\b/i, label: 'Weekly rate' },
  { test: /\bfee\b/i, label: 'Fee' },
  { test: /\bprice\b/i, label: 'Price' },
  { test: /\brate\b/i, label: 'Rate' },
  { test: /\bcost\b/i, label: 'Cost' },
];

export function factLabelFromInstruction(instruction: string | undefined): string {
  const text = (instruction ?? '').toLowerCase();
  for (const hint of FACT_LABEL_HINTS) {
    if (hint.test.test(text)) return hint.label;
  }
  return 'Plan rate';
}

/**
 * Extract subject keywords from the user's instruction — the noun-phrase tokens that
 * describe WHAT the user is asking about. Used by `selectThresholdPriceCandidate` to
 * prefer candidate sentences mentioning the same subject (e.g. "helium" / "phone")
 * over candidates about an unrelated token's price.
 *
 * Drops generic threshold/policy words (approve/deny/$X/under/over) so what's left is
 * the subject of the question. Returns lowercased tokens of length >= 3.
 */
export function extractInstructionSubjectHints(instruction: string | undefined): string[] {
  if (!instruction) return [];
  const normalized = instruction.toLowerCase();
  // Strip URLs and $-amounts up front; they're never subjects.
  const stripped = normalized
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\$\s*\d+(?:\.\d+)?/g, ' ');
  // Words we explicitly DON'T treat as subject (verbs, policy nouns, threshold connectives).
  const stopWords = new Set([
    'approve', 'deny', 'reject', 'allow', 'block', 'pass', 'fail', 'cancel',
    'check', 'verify', 'confirm', 'find', 'look', 'search', 'lookup',
    'if', 'when', 'is', 'are', 'be', 'was', 'were', 'the', 'a', 'an', 'this', 'that', 'these', 'those',
    'and', 'or', 'but', 'not', 'no', 'yes',
    'under', 'over', 'below', 'above', 'less', 'more', 'than', 'greater', 'fewer',
    'value', 'amount', 'price', 'cost', 'rate', 'fee', 'charge', 'plan', 'subscription',
    'monthly', 'weekly', 'yearly', 'annually', 'daily', 'hourly', 'per', 'month', 'week', 'year', 'day', 'hour',
    'current', 'currently', 'today', 'now', 'latest', 'recent',
    'lowest', 'highest', 'cheapest', 'expensive', 'best', 'worst',
    'dollar', 'dollars', 'usd', 'cents',
    'review', 'rule', 'threshold', 'limit', 'budget', 'cap', 'policy',
    'agent', 'wallet', 'approval', 'sign', 'draft',
  ]);
  const tokens = stripped.split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !stopWords.has(token));
  // Dedupe preserving first occurrence.
  return Array.from(new Set(tokens));
}

function candidateMentionsAnySubject(candidate: { label: string; text: string }, subjects: ReadonlyArray<string>): boolean {
  if (!subjects.length) return false;
  const haystack = `${candidate.label} ${candidate.text}`.toLowerCase();
  return subjects.some((subject) => haystack.includes(subject));
}

function candidateLooksLikeCryptoAsset(candidate: { label: string; text: string }): boolean {
  // Combine label + value text — most candidates carry the asset name on the label
  // (e.g. label="SOL price", value="$86.18") so checking value alone misses them.
  const haystack = `${candidate.label} ${candidate.text}`;
  return CRYPTO_ASSET_TOKENS.test(haystack);
}

export function extractInstructionThreshold(text: string): number | undefined {
  const matches = [...text.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Number.parseFloat(match[1] ?? ''))
    .filter(Number.isFinite);
  if (!matches.length) return undefined;
  return matches[0];
}

// Returns true when the instruction contains more than one distinct numeric threshold
// — e.g. a mixed policy like "SOL must be above $80. only approve if helium plan is
// less than $20." Multi-threshold instructions cannot be reconciled by the single-rule
// reconciler (which would arbitrarily pick one threshold and one direction and apply
// them to whichever candidate happens to match — typically wrong, as in the SOL/$80
// vs Helium/$20 case where the SOL price gets matched against the Helium $20 rule).
// The model's own decision (informed by all gates + policyBundle.evaluations) is
// authoritative for these prompts.
export function instructionHasMultipleThresholds(instruction: string | undefined): boolean {
  const normalized = (instruction ?? '').toLowerCase();
  const dollarValues = [...normalized.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Number.parseFloat(match[1] ?? ''))
    .filter(Number.isFinite);
  const distinct = new Set(dollarValues);
  if (distinct.size > 1) return true;
  // Even with a single dollar threshold, a non-dollar numeric threshold counts as a
  // second rule (e.g. "Fear & Greed above 20" alongside "$X less than $20").
  // Detect "<keyword> above|below|over|under <number>" patterns where the keyword
  // is a known non-price metric.
  const nonDollarMetricMatches = normalized.match(
    /\b(fear\s*(?:and|&)?\s*greed|dominance|market\s+cap|apr|apy|tvl|age|days?|hours?)\b[\s\S]{0,40}\b(above|below|over|under|less\s+than|more\s+than|greater\s+than|>|<)\b[\s\S]{0,15}\d/g,
  );
  if (nonDollarMetricMatches && nonDollarMetricMatches.length > 0 && distinct.size >= 1) return true;
  return false;
}

export function extractThresholdRule(instruction: string | undefined): ThresholdRule | undefined {
  // Multi-rule prompts are out of scope for the single-threshold reconciler. Return
  // undefined so the model's own decision stands. See instructionHasMultipleThresholds.
  if (instructionHasMultipleThresholds(instruction)) return undefined;
  const normalized = (instruction ?? '').toLowerCase();
  const threshold = extractInstructionThreshold(normalized);
  if (threshold === undefined) return undefined;
  const approveBelow = /\b(approve|allow|pass)\b[\s\S]{0,80}\b(under|below|less\s+than|cheaper\s+than|<)\b/.test(normalized) ||
    /\b(under|below|less\s+than|cheaper\s+than|<)\b[\s\S]{0,80}\b(approve|allow|pass)\b/.test(normalized);
  const approveAbove = /\b(approve|allow|pass)\b[\s\S]{0,80}\b(over|above|more\s+than|greater\s+than|>)\b/.test(normalized) ||
    /\b(over|above|more\s+than|greater\s+than|>)\b[\s\S]{0,80}\b(approve|allow|pass)\b/.test(normalized);
  const denyBelow = /\b(deny|block|reject|fail|don'?t\s+approve|do\s+not\s+approve)\b[\s\S]{0,80}\b(under|below|less\s+than|cheaper\s+than|<)\b/.test(normalized) ||
    /\b(under|below|less\s+than|cheaper\s+than|<)\b[\s\S]{0,80}\b(deny|block|reject|fail|don'?t\s+approve|do\s+not\s+approve)\b/.test(normalized);
  const denyAbove = /\b(deny|block|reject|fail|don'?t\s+approve|do\s+not\s+approve)\b[\s\S]{0,80}\b(over|above|more\s+than|greater\s+than|>)\b/.test(normalized) ||
    /\b(over|above|more\s+than|greater\s+than|>)\b[\s\S]{0,80}\b(deny|block|reject|fail|don'?t\s+approve|do\s+not\s+approve)\b/.test(normalized);
  // If both approve-below and approve-above keywords appear in the same prompt, the
  // intent is ambiguous (likely two rules with different directions). Defer to the
  // model rather than guessing — multi-direction prompts should be caught by the
  // multi-threshold check above, but this is a defensive fallback for edge cases
  // where two rules share the same $ value.
  if (approveBelow && approveAbove) return undefined;
  if (denyBelow && denyAbove) return undefined;
  if (approveBelow || denyAbove) return { threshold, approveWhen: 'below' };
  if (approveAbove || denyBelow) return { threshold, approveWhen: 'above' };
  return undefined;
}

export function expectedDecisionForThreshold(amount: number, rule: ThresholdRule): AgentPlanReviewDecision {
  if (amount === rule.threshold) return 'needs_input';
  if (rule.approveWhen === 'below') {
    return amount < rule.threshold ? 'approve' : 'deny';
  }
  return amount > rule.threshold ? 'approve' : 'deny';
}

export function formatDollar(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

export interface EvidenceTextField {
  label: string;
  text: string;
  source: ThresholdPriceCandidate['source'];
}

export function evidenceTextFields(evidence: Record<string, unknown>): EvidenceTextField[] {
  const fields: EvidenceTextField[] = [];
  for (const key of ['findings', 'checks', 'evidenceRows', 'evidence_rows']) {
    const rows = Array.isArray(evidence[key]) ? evidence[key] : [];
    for (const entry of rows) {
      appendEvidenceRowText(fields, entry, key === 'findings' ? 'finding' : 'evidence');
    }
  }
  appendEvidenceFactsText(fields, evidence.facts);
  for (const [key, raw] of Object.entries(evidence)) {
    if (isStructuredEvidenceKey(key)) continue;
    appendEvidenceValueText(fields, key, raw);
  }
  if (evidence.research && typeof evidence.research === 'object' && !Array.isArray(evidence.research)) {
    const summary = (evidence.research as Record<string, unknown>).summary;
    if (typeof summary === 'string' && summary.trim()) {
      fields.push({ label: 'research', text: summary, source: 'research' });
    }
  }
  return fields;
}

function appendEvidenceRowText(
  fields: EvidenceTextField[],
  entry: unknown,
  source: ThresholdPriceCandidate['source'],
): void {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
  const record = entry as Record<string, unknown>;
  const label = typeof record.label === 'string' ? record.label : 'finding';
  const value = stringValue(record.value) || stringValue(record.message) || stringValue(record.text);
  if (value.trim()) fields.push({ label, text: value, source });
}

function appendEvidenceFactsText(fields: EvidenceTextField[], facts: unknown): void {
  if (Array.isArray(facts)) {
    for (const entry of facts) {
      appendEvidenceRowText(fields, entry, 'evidence');
    }
    return;
  }
  if (!facts || typeof facts !== 'object') return;
  for (const [key, raw] of Object.entries(facts as Record<string, unknown>)) {
    appendEvidenceValueText(fields, key, raw);
  }
}

function appendEvidenceValueText(fields: EvidenceTextField[], key: string, raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    const value = stringValue(raw);
    if (value.trim()) fields.push({ label: humanizeEvidenceLabel(key), text: value, source: 'evidence' });
    return;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const record = raw as Record<string, unknown>;
  const label = stringValue(record.label) || humanizeEvidenceLabel(key);
  const value = stringValue(record.value) || stringValue(record.message) || stringValue(record.text) || stringValue(record.summary);
  if (value.trim()) fields.push({ label, text: value, source: 'evidence' });
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '';
}

const STRUCTURED_EVIDENCE_KEYS = new Set([
  'checks',
  'findings',
  'evidencerows',
  'evidence_rows',
  'facts',
  'questions',
  'reviewers',
  'sources',
  'citations',
  'research',
  'decisioncontract',
  'decision_contract',
  'evidencefactids',
  'evidence_fact_ids',
  'blockingfactids',
  'blocking_fact_ids',
  'missingfactids',
  'missing_fact_ids',
  'confidence',
  'confidencescore',
  'confidence_score',
  'counterfactuals',
  'evidencegate',
  'evidence_gate',
  'auditreceipt',
  'audit_receipt',
]);

function isStructuredEvidenceKey(key: string): boolean {
  return STRUCTURED_EVIDENCE_KEYS.has(key.toLowerCase().replace(/[\s_-]+/g, ''));
}

function humanizeEvidenceLabel(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced ? spaced.replace(/\b\w/g, (char) => char.toUpperCase()) : 'Evidence';
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function appendReviewFinding(
  evidence: Record<string, unknown>,
  finding: ReviewFinding,
  options: { dedupeByNormalizedLabel?: boolean } = {},
): Record<string, unknown> {
  const findings: ReviewFinding[] = Array.isArray(evidence.findings)
    ? (evidence.findings as unknown[]).filter((entry): entry is ReviewFinding => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
        .map((entry) => entry as ReviewFinding)
    : [];
  if (options.dedupeByNormalizedLabel) {
    const targetLabel = normalizeLabel(finding.label);
    const idx = findings.findIndex((entry) => typeof entry.label === 'string' && normalizeLabel(entry.label) === targetLabel);
    if (idx >= 0) {
      const replaced = [...findings];
      replaced[idx] = finding;
      return { ...evidence, findings: replaced };
    }
  }
  return { ...evidence, findings: [...findings, finding] };
}

export function extractThresholdPriceCandidates(
  result: Pick<AgentPlanReviewResult, 'reason' | 'summary' | 'evidence'>,
  threshold: number,
): ThresholdPriceCandidate[] {
  const fields: Array<{ label: string; text: string; source: ThresholdPriceCandidate['source'] }> = [
    { label: 'reason', text: result.reason, source: 'reason' },
    { label: 'summary', text: result.summary, source: 'summary' },
    ...evidenceTextFields(result.evidence ?? {}),
  ];
  const candidates: ThresholdPriceCandidate[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    for (const sentence of field.text.split(/(?<=[.!?])\s+|\n+/)) {
      if (!/\$/.test(sentence)) continue;
      const labelHasContextWord = PRICE_CONTEXT_KEYWORDS.test(field.label) || PRICE_LIKE_LABEL.test(field.label);
      const hasContextWord = PRICE_CONTEXT_KEYWORDS.test(sentence) || labelHasContextWord;
      const isThresholdHeavy = /\b(threshold|limit|rule|budget|cap)\b/i.test(sentence) && !hasContextWord;
      if (isThresholdHeavy) continue;
      if (!hasContextWord && field.source !== 'finding') continue;
      for (const match of sentence.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)) {
        const amount = Number.parseFloat(match[1] ?? '');
        if (!Number.isFinite(amount)) continue;
        if (amount === threshold) {
          const prefix = sentence.slice(0, Math.max(0, match.index ?? 0));
          if (!PRICE_CONTEXT_KEYWORDS.test(prefix) && !labelHasContextWord && field.source !== 'finding') continue;
        }
        const key = `${amount}:${field.source}:${sentence.trim().toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ amount, label: field.label, text: sentence.trim(), source: field.source });
      }
    }
  }
  return candidates;
}

export function selectThresholdPriceCandidate(
  result: Pick<AgentPlanReviewResult, 'reason' | 'summary' | 'evidence'>,
  rule: ThresholdRule,
  options: { instruction?: string } = {},
): ThresholdPriceCandidate | undefined {
  const candidates = extractThresholdPriceCandidates(result, rule.threshold);
  if (!candidates.length) return undefined;

  const subjects = extractInstructionSubjectHints(options.instruction);

  // Subject-aware first pass: if the user's instruction names a subject ("helium",
  // "phone", etc.), prefer candidates whose text mentions ANY of those subject tokens.
  // Drop candidates that look like crypto-asset prose ("SOL price", "swap quote", etc.)
  // when subjects exist and don't overlap with crypto vocabulary. This prevents the
  // Gemini-bug failure mode where the model dumps both the Helium plan price AND the
  // SOL price into prose and the wrong $X gets picked.
  const subjectMatchedCandidates = subjects.length > 0
    ? candidates.filter((c) => candidateMentionsAnySubject(c, subjects) && c.amount !== rule.threshold)
    : [];
  if (subjectMatchedCandidates.length > 0) {
    const finding = subjectMatchedCandidates.find((c) => c.source === 'finding');
    if (finding) return finding;
    if (subjectMatchedCandidates.length === 1) return subjectMatchedCandidates[0];
    // Multiple subject-matched candidates: prefer the one adjacent to the user's adjective.
    const adj = rule.approveWhen === 'below' ? /\b(under|below|less\s+than|cheaper\s+than|<)\b/i : /\b(over|above|more\s+than|greater\s+than|>)\b/i;
    const adjacent = subjectMatchedCandidates.find((c) => adj.test(c.text));
    if (adjacent) return adjacent;
    return subjectMatchedCandidates[0];
  }

  // When subjects exist but no candidate matches them, and there are crypto-asset
  // candidates lurking, refuse to pick — we'd guess wrong. Better to escalate to
  // needs_input than to compare the SOL price against a phone-plan threshold.
  const subjectsAreCryptoFree = subjects.length > 0 && !subjects.some((s) => CRYPTO_ASSET_TOKENS.test(s));
  if (subjectsAreCryptoFree) {
    const cryptoFiltered = candidates.filter((c) => !candidateLooksLikeCryptoAsset(c));
    if (cryptoFiltered.length === 0) {
      // Every candidate is about a crypto asset but the user asked about something else
      // → can't apply. Reconciler will downgrade to needs_input.
      return undefined;
    }
    // Fall through to the legacy heuristics against the crypto-filtered set.
    return selectFromHeuristics(cryptoFiltered, rule);
  }

  return selectFromHeuristics(candidates, rule);
}

function selectFromHeuristics(
  candidates: ThresholdPriceCandidate[],
  rule: ThresholdRule,
): ThresholdPriceCandidate | undefined {
  const findingCandidates = candidates.filter((c) => c.source === 'finding' && c.amount !== rule.threshold);
  const labeledFinding = findingCandidates.find((c) => PRICE_LIKE_LABEL.test(c.label));
  if (labeledFinding) return labeledFinding;
  if (findingCandidates.length === 1) return findingCandidates[0];

  const nonThreshold = candidates.filter((c) => c.amount !== rule.threshold);
  if (!nonThreshold.length) return undefined;
  if (nonThreshold.length === 1) return nonThreshold[0];

  const adjectiveWord = rule.approveWhen === 'below' ? /\b(under|below|less\s+than|cheaper\s+than|<)\b/i : /\b(over|above|more\s+than|greater\s+than|>)\b/i;
  const adjacentToAdjective = nonThreshold.find((c) => adjectiveWord.test(c.text));
  if (adjacentToAdjective) return adjacentToAdjective;

  const amounts = new Set(nonThreshold.map((c) => c.amount));
  if (amounts.size === 1) return nonThreshold[0];

  return undefined;
}

function relationWord(amount: number, threshold: number): 'under' | 'over' | 'equal to' {
  if (amount < threshold) return 'under';
  if (amount > threshold) return 'over';
  return 'equal to';
}

export function reconcileThresholdReviewDecision(
  result: AgentPlanReviewResult,
  request: Pick<AgentPlanReviewRequest, 'instruction'>,
): AgentPlanReviewResult {
  const rule = extractThresholdRule(request.instruction);
  if (!rule) return result;
  const candidate = selectThresholdPriceCandidate(result, rule, { instruction: request.instruction });

  if (!candidate) {
    if (result.decision === 'needs_input') return result;
    const questions: AgentReviewQuestion[] = Array.isArray(result.questions) ? [...result.questions] : [];
    const hasQuestion = questions.some((q) => q.id === 'agent_review_threshold_fact');
    if (!hasQuestion) {
      questions.push({
        id: 'agent_review_threshold_fact',
        prompt: 'What current value should be checked against the threshold? Provide an exact dollar amount.',
        inputKind: 'text',
        required: true,
        hint: request.instruction,
      });
    }
    const evidence = appendReviewFinding(result.evidence ?? {}, {
      label: 'Threshold check',
      value: `Could not extract a current value to compare against the ${formatDollar(rule.threshold)} threshold. Ask the agent for the current value explicitly.`,
      tone: 'warn',
    }, { dedupeByNormalizedLabel: true });
    return {
      ...result,
      decision: 'needs_input',
      reason: compactText(
        `The agent did not return a numeric value that could be compared against the ${formatDollar(rule.threshold)} threshold. Ask the agent again or supply the current value.`,
        280,
      ),
      summary: compactText(
        `Threshold rule needs a numeric value to apply (${formatDollar(rule.threshold)}).`,
        160,
      ),
      evidence,
      questions,
    };
  }

  const expected = expectedDecisionForThreshold(candidate.amount, rule);
  const thresholdText = formatDollar(rule.threshold);
  const amountText = formatDollar(candidate.amount);
  const relation = relationWord(candidate.amount, rule.threshold);
  const factLabel = factLabelFromInstruction(request.instruction);
  const factTone: ThresholdReviewTone = expected === 'approve' ? 'good' : expected === 'deny' ? 'fail' : 'warn';

  let evidence = appendReviewFinding(result.evidence ?? {}, {
    label: factLabel,
    value: amountText,
    tone: factTone,
  }, { dedupeByNormalizedLabel: true });

  if (expected === result.decision) {
    return { ...result, evidence };
  }

  evidence = appendReviewFinding(evidence, {
    label: 'Threshold check',
    value: `Corrected model comparison: ${amountText} is ${relation} ${thresholdText}. Original decision was ${result.decision}.`,
    tone: factTone,
  }, { dedupeByNormalizedLabel: true });

  // When the reconciler promotes a model deny/needs_input → approve because the user's
  // stated threshold rule is satisfied by the resolved value, mark the result so the
  // server-side safety gate (aiPlanner.applyServerSideReviewSafety) does not silently
  // downgrade it back to deny. The bypass is narrow on purpose: only set when the user
  // explicitly stated a threshold AND the resolved numeric value matches the rule's
  // approve condition. PolicyBundle.hasBlockingFailure remains a separate, harder fail
  // signal that the safety gate continues to honor regardless of this flag.
  if (expected === 'approve' && result.decision !== 'approve') {
    const evidenceRecord = evidence as Record<string, unknown>;
    evidenceRecord.thresholdRulePromoted = true;
  }

  // Surface the source sentence the corrected value came from as its own `Source`
  // finding so the audit trail stays traceable without polluting the reason text
  // with `(from "...")` parenthetical attribution. The reason itself stays natural —
  // matches the Anthropic/Gemini style ("X is $Y, under the user's $Z threshold")
  // instead of the prior templated `${amount} (from "...") is ${relation}...` shape.
  const sourceSnippet = compactText(candidate.text, 140).trim();
  if (sourceSnippet.length > 0) {
    evidence = appendReviewFinding(evidence, {
      label: 'Source',
      value: sourceSnippet,
      tone: 'neutral',
    }, { dedupeByNormalizedLabel: true });
  }

  const correctedReason = expected === 'needs_input'
    ? `${factLabel} is exactly ${thresholdText}; the user's strict under/over rule needs clarification.`
    : `${factLabel} is ${amountText}, ${relation} the user's ${thresholdText} threshold.`;

  return {
    ...result,
    decision: expected,
    reason: compactText(correctedReason, 320),
    summary: compactText(`Threshold rule checked: ${amountText} is ${relation} ${thresholdText}.`, 160),
    evidence,
  };
}
