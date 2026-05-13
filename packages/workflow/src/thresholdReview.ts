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

export function extractInstructionThreshold(text: string): number | undefined {
  const matches = [...text.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Number.parseFloat(match[1] ?? ''))
    .filter(Number.isFinite);
  if (!matches.length) return undefined;
  return matches[0];
}

export function extractThresholdRule(instruction: string | undefined): ThresholdRule | undefined {
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
  const findings = Array.isArray(evidence.findings) ? evidence.findings : [];
  for (const entry of findings) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const label = typeof record.label === 'string' ? record.label : 'finding';
    const value = typeof record.value === 'string' ? record.value : '';
    if (value.trim()) fields.push({ label, text: value, source: 'finding' });
  }
  if (evidence.research && typeof evidence.research === 'object' && !Array.isArray(evidence.research)) {
    const summary = (evidence.research as Record<string, unknown>).summary;
    if (typeof summary === 'string' && summary.trim()) {
      fields.push({ label: 'research', text: summary, source: 'research' });
    }
  }
  return fields;
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
      const hasContextWord = PRICE_CONTEXT_KEYWORDS.test(sentence);
      const isThresholdHeavy = /\b(threshold|limit|rule|budget|cap)\b/i.test(sentence) && !hasContextWord;
      if (isThresholdHeavy) continue;
      if (!hasContextWord && field.source !== 'finding') continue;
      for (const match of sentence.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)) {
        const amount = Number.parseFloat(match[1] ?? '');
        if (!Number.isFinite(amount)) continue;
        if (amount === threshold) {
          const prefix = sentence.slice(0, Math.max(0, match.index ?? 0));
          if (!PRICE_CONTEXT_KEYWORDS.test(prefix) && field.source !== 'finding') continue;
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
): ThresholdPriceCandidate | undefined {
  const candidates = extractThresholdPriceCandidates(result, rule.threshold);
  if (!candidates.length) return undefined;

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
  const candidate = selectThresholdPriceCandidate(result, rule);

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

  const correctedReason = expected === 'needs_input'
    ? `${amountText} is exactly ${thresholdText}; the user rule used a strict under/over threshold, so the review needs clarification.`
    : `${amountText} is ${relation} ${thresholdText}, so the user threshold rule ${expected === 'approve' ? 'approves' : 'denies'} this draft. Wallet approval is still required before anything signs.`;

  return {
    ...result,
    decision: expected,
    reason: compactText(correctedReason, 280),
    summary: compactText(`Threshold rule checked: ${amountText} is ${relation} ${thresholdText}.`, 160),
    evidence,
  };
}
