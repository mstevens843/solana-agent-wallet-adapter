import type { AgentPlan } from './planner.js';
import { findingsSpecFor, type DeterministicFactKey } from './agentFindingsSpec.js';

export type AgentEvidenceTone = 'good' | 'warn' | 'neutral' | 'fail';

export interface AgentEvidenceDisplayRow {
  label: string;
  value: string;
  tone: AgentEvidenceTone;
}

export type AgentEvidenceSectionId =
  | 'decision'
  | 'market'
  | 'token'
  | 'transaction'
  | 'sources'
  | 'other'
  | 'advanced';

export interface AgentEvidenceDisplaySection {
  id: AgentEvidenceSectionId;
  label: string;
  rows: AgentEvidenceDisplayRow[];
  advanced?: boolean;
}

export interface AgentEvidenceCheckLike {
  label: string;
  value: string;
  tone?: AgentEvidenceTone;
}

export interface AgentEvidenceFactLike {
  state: 'checked' | 'missing' | 'warn' | 'ok' | 'fail';
  message?: string;
}

export interface AgentEvidencePolicyLike {
  label: string;
  ruleText: string;
  outcome: 'pass' | 'warn' | 'block' | 'not_applicable';
}

export interface AgentEvidenceReviewerLike {
  label: string;
  decision: 'approve' | 'deny' | 'needs_input';
  reason: string;
}

export interface AgentEvidenceQuestionLike {
  prompt: string;
  required?: boolean;
}

export interface AgentEvidenceStalenessLike {
  staleSince: string;
  triggers?: Array<{ field: string }>;
}

export interface AgentEvidenceFactRow {
  id: string;
  routeId?: string;
  label: string;
  value: string;
  tone?: AgentEvidenceTone;
  severity?: 'info' | 'warn' | 'block';
  freshness?: 'fresh' | 'stale' | 'missing';
  source?: string;
  checkedAt?: string;
}

export interface AgentAuditReceiptLike {
  schemaVersion: number;
  receiptId: string;
  planFingerprint: string;
  walletAddress: string;
  cluster: string;
  connectorId?: string;
  connectorProfile?: string;
  routePlanHash: string;
  evidenceHash: string;
  aiDecisionHash: string;
  finalDecision: 'approve' | 'deny' | 'needs_input';
  gateDecision: 'pass' | 'block' | 'needs_input';
  checkedAt: string;
  providerRoutes: string[];
  evidenceFactIds: string[];
  blockingFactIds: string[];
  missingRequirementIds: string[];
  confidenceScore?: number;
  confidenceBand?: 'high' | 'medium' | 'low';
  counterfactualSummary?: Array<{ id: string; rationale: string; decisionAfter: 'approve' | 'deny' | 'needs_input' }>;
  spotPrices?: Record<string, { usdPerToken: number; source: string; checkedAt: string; confidence?: number }>;
  totalUsdAtRisk?: number;
}

export interface AgentEvidenceReviewLike {
  status?: 'checking' | 'approved' | 'denied' | 'needs_input' | 'error';
  decision?: 'approve' | 'deny' | 'needs_input';
  reason?: string;
  summary?: string;
  evidence?: Record<string, unknown>;
  checks?: AgentEvidenceCheckLike[];
  facts?: Partial<Record<
    'quote' | 'route' | 'policy' | 'simulation' | 'protocol' | 'protocolConnector' | 'blinkAction' | 'blinkClassification' | 'tokenMint' | 'recipient' | 'limits' | 'schedule' | 'research',
    AgentEvidenceFactLike
  >>;
  policies?: AgentEvidencePolicyLike[];
  reviewers?: AgentEvidenceReviewerLike[];
  questions?: AgentEvidenceQuestionLike[];
  staleness?: AgentEvidenceStalenessLike;
  evidenceFacts?: AgentEvidenceFactRow[];
  auditReceipt?: AgentAuditReceiptLike;
  decisionContract?: unknown;
  evidenceGate?: unknown;
  decisionViolations?: string[];
}

export interface ReviewEvidenceRowsOptions {
  stale?: boolean;
  stringify?: (value: unknown) => string;
  actionType?: string;
}

export interface SwapTokenTextMismatchWarning {
  expectedToken: string;
  actualToken: string;
  actualValue: string;
  message: string;
}

const KNOWN_OUTPUT_TOKEN_MINTS: Record<string, string> = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
};

const KNOWN_OUTPUT_TOKENS = Object.keys(KNOWN_OUTPUT_TOKEN_MINTS);
const TOKEN_MISMATCH_KEYS = new Set([
  'tokenmismatch',
  'token_mismatch',
  'actualtoken',
  'actual_token',
  'actualmint',
  'actual_mint',
  'actualoutputtoken',
  'actual_output_token',
  'actualoutputmint',
  'actual_output_mint',
  'intendedtoken',
  'intended_token',
  'expectedtoken',
  'expected_token',
]);

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
]);

const AUDIT_EVIDENCE_KEYS = new Set([
  'decisioncontract',
  'decision_contract',
  'evidencefactids',
  'evidence_fact_ids',
  'blockingfactids',
  'blocking_fact_ids',
  'missingfactids',
  'missing_fact_ids',
  'missingrequirementids',
  'missing_requirement_ids',
  'confidence',
  'confidencescore',
  'confidence_score',
  'confidenceband',
  'confidence_band',
  'confidencefactors',
  'confidence_factors',
  'counterfactuals',
  'counterfactualsummary',
  'counterfactual_summary',
  'evidencegate',
  'evidence_gate',
  'decisionviolations',
  'decision_violations',
  'auditreceipt',
  'audit_receipt',
  'receiptid',
  'receipt_id',
  'planfingerprint',
  'plan_fingerprint',
  'routeplanhash',
  'route_plan_hash',
  'evidencehash',
  'evidence_hash',
  'aidecisionhash',
  'ai_decision_hash',
]);

const RESEARCH_FALLBACK_EVIDENCE_KEYS = new Set([
  'actiontype',
  'action_type',
  'templatetitle',
  'template_title',
  'parseerror',
  'parse_error',
]);

const MISSING_INPUT_KEYS = new Set([
  'missinginput',
  'missinginputs',
  'missing_input',
  'missing_inputs',
  'missinguserinput',
  'missinguserinputs',
  'missing_user_input',
  'missing_user_inputs',
  'requiredinput',
  'requiredinputs',
  'required_input',
  'required_inputs',
]);

export function swapTokenTextMismatchWarning(
  plan: Pick<AgentPlan, 'actionType' | 'intent' | 'route' | 'userNotes' | 'parameters'>,
  displayToken: (value: string) => string = (value) => value,
): SwapTokenTextMismatchWarning | undefined {
  if (plan.actionType !== 'swap') return undefined;
  const outputToken = plan.parameters.outputToken?.trim();
  if (!outputToken) return undefined;
  const expectedToken = expectedOutputTokenFromPlanText(plan);
  const outputLabel = plan.parameters.outputTokenLabel?.trim();
  if (!expectedToken || outputMatchesExpectedToken(outputToken, outputLabel, expectedToken)) return undefined;
  const actualToken = outputLabel || displayToken(outputToken);
  return {
    expectedToken,
    actualToken,
    actualValue: outputToken,
    message: `Draft text mentions ${expectedToken}, but the output token is ${actualToken}.`,
  };
}

function formatUsdInline(value: number): string {
  if (!Number.isFinite(value)) return '$?';
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return value < 0 ? '-<$0.01' : '<$0.01';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export function evidenceFactDisplayRows(facts: AgentEvidenceFactRow[] | undefined): AgentEvidenceDisplayRow[] {
  if (!facts?.length) return [];
  return facts.map((fact) => {
    const tone: AgentEvidenceTone = fact.tone ?? (fact.severity === 'block'
      ? 'fail'
      : fact.severity === 'warn' || fact.freshness === 'stale' || fact.freshness === 'missing'
        ? 'warn'
        : 'neutral');
    const suffix = fact.freshness === 'stale'
      ? ' (stale)'
      : fact.freshness === 'missing'
        ? ' (missing)'
        : '';
    return {
      label: fact.label,
      value: `${fact.value}${suffix}`,
      tone,
    };
  });
}

export function auditReceiptDisplayRows(receipt: AgentAuditReceiptLike | undefined): AgentEvidenceDisplayRow[] {
  if (!receipt) return [];
  const rows: AgentEvidenceDisplayRow[] = [];
  const decisionTone: AgentEvidenceTone = receipt.finalDecision === 'approve'
    ? 'good'
    : receipt.finalDecision === 'needs_input'
      ? 'warn'
      : 'fail';
  const gateTone: AgentEvidenceTone = receipt.gateDecision === 'pass'
    ? 'good'
    : receipt.gateDecision === 'needs_input'
      ? 'warn'
      : 'fail';
  rows.push({ label: 'Audit receipt', value: receipt.receiptId, tone: 'neutral' });
  rows.push({ label: 'Final decision', value: receipt.finalDecision, tone: decisionTone });
  rows.push({ label: 'Gate decision', value: receipt.gateDecision, tone: gateTone });
  if (typeof receipt.totalUsdAtRisk === 'number') {
    rows.push({
      label: 'USD at risk',
      value: formatUsdInline(receipt.totalUsdAtRisk),
      tone: receipt.totalUsdAtRisk > 100 ? 'warn' : 'neutral',
    });
  }
  if (receipt.spotPrices && Object.keys(receipt.spotPrices).length > 0) {
    const lines = Object.entries(receipt.spotPrices).map(([mint, snap]) => {
      const label = mint === 'SOL' ? 'SOL' : mint.length > 10 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
      return `${label}: ${formatUsdInline(snap.usdPerToken)} (${snap.source})`;
    });
    rows.push({ label: 'Spot prices', value: lines.join(' · '), tone: 'neutral' });
  }
  if (typeof receipt.confidenceScore === 'number' && receipt.confidenceBand) {
    const confidenceTone: AgentEvidenceTone = receipt.confidenceBand === 'high'
      ? 'good'
      : receipt.confidenceBand === 'medium'
        ? 'warn'
        : 'fail';
    rows.push({
      label: 'Confidence',
      value: `${receipt.confidenceBand} (${(receipt.confidenceScore * 100).toFixed(1)}%)`,
      tone: confidenceTone,
    });
  }
  if (receipt.counterfactualSummary?.length) {
    for (const cf of receipt.counterfactualSummary) {
      const tone: AgentEvidenceTone = cf.decisionAfter === 'approve'
        ? 'good'
        : cf.decisionAfter === 'needs_input'
          ? 'warn'
          : 'fail';
      rows.push({
        label: `Counterfactual → ${cf.decisionAfter}`,
        value: cf.rationale,
        tone,
      });
    }
  }
  rows.push({ label: 'Plan fingerprint', value: receipt.planFingerprint, tone: 'neutral' });
  rows.push({ label: 'Route plan hash', value: receipt.routePlanHash, tone: 'neutral' });
  rows.push({ label: 'Evidence hash', value: receipt.evidenceHash, tone: 'neutral' });
  rows.push({ label: 'AI decision hash', value: receipt.aiDecisionHash, tone: 'neutral' });
  if (receipt.connectorId || receipt.connectorProfile) {
    rows.push({
      label: 'Connector',
      value: [receipt.connectorId, receipt.connectorProfile].filter(Boolean).join(' · '),
      tone: 'neutral',
    });
  }
  if (receipt.providerRoutes.length) {
    rows.push({
      label: 'Provider routes',
      value: receipt.providerRoutes.join(', '),
      tone: 'neutral',
    });
  }
  if (receipt.evidenceFactIds.length) {
    rows.push({
      label: 'Cited evidence ids',
      value: receipt.evidenceFactIds.join(', '),
      tone: 'neutral',
    });
  }
  if (receipt.blockingFactIds.length) {
    rows.push({
      label: 'Blocking ids',
      value: receipt.blockingFactIds.join(', '),
      tone: 'fail',
    });
  }
  if (receipt.missingRequirementIds.length) {
    rows.push({
      label: 'Missing requirements',
      value: receipt.missingRequirementIds.join(', '),
      tone: 'warn',
    });
  }
  return rows;
}

export function tokenMismatchEvidenceRows(evidence: Record<string, unknown> | undefined): AgentEvidenceDisplayRow[] {
  if (!evidence) return [];
  const mismatch = evidenceValue(evidence, ['tokenMismatch', 'token_mismatch']);
  const intended = evidenceValue(evidence, ['intendedToken', 'intended_token', 'expectedToken', 'expected_token']);
  const actual = evidenceValue(evidence, ['actualToken', 'actual_token', 'actualOutputToken', 'actual_output_token']);
  const actualMint = evidenceValue(evidence, ['actualMint', 'actual_mint', 'actualOutputMint', 'actual_output_mint']);
  if (!mismatch && !intended && !actual && !actualMint) return [];
  const pieces = [
    intended ? `expected ${intended}` : '',
    actual ? `actual ${actual}` : '',
    actualMint ? `mint ${actualMint}` : '',
    typeof mismatch === 'string' && mismatch !== 'true' ? mismatch : '',
  ].filter(Boolean);
  return [{
    label: 'Token mismatch',
    value: pieces.join('; ') || 'Output token does not match the draft intent.',
    tone: 'fail',
  }];
}

export function reviewEvidenceRows(
  review: AgentEvidenceReviewLike,
  options: ReviewEvidenceRowsOptions = {},
): AgentEvidenceDisplayRow[] {
  const rows: AgentEvidenceDisplayRow[] = [];
  const seen = new Set<string>();
  const evidence = review.evidence && isPlainRecord(review.evidence) ? review.evidence : undefined;
  const stringify = options.stringify ?? stableStringify;
  const researchFocused = hasResearchEvidence(evidence) || Boolean(review.facts?.research);
  const addRow = (row: Partial<AgentEvidenceDisplayRow>): void => {
    const label = textValue(row.label).slice(0, 96);
    const value = textValue(row.value).slice(0, 720);
    if (!label || !value) return;
    const key = `${label.toLowerCase()}\n${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      label,
      value,
      tone: normalizeEvidenceTone(row.tone) ?? evidenceEntryTone(label, value),
    });
  };

  for (const check of review.checks ?? []) {
    addRow({ label: check.label, value: check.value, tone: check.tone });
  }
  for (const row of evidenceFactDisplayRows(review.evidenceFacts)) {
    if (researchFocused && row.tone !== 'fail' && row.tone !== 'warn' && isPromptScopedOperationalRow(row)) continue;
    addRow(row);
  }
  for (const finding of evidenceFindingRows(evidence)) {
    if (researchFocused && finding.tone !== 'fail' && finding.tone !== 'warn' && isPromptScopedOperationalRow(finding)) continue;
    addRow(finding);
  }
  for (const row of tokenMismatchEvidenceRows(evidence)) {
    addRow(row);
  }
  for (const row of sourceEvidenceRows(evidence)) {
    addRow(row);
  }

  const facts = review.facts;
  if (facts) {
    const spec = findingsSpecFor(options.actionType);
    const defaultLabels: Record<DeterministicFactKey, string> = {
      research: 'Research',
      route: 'Route',
      quote: 'Quote',
      protocol: 'Protocol',
      protocolConnector: 'Connector',
      blinkAction: 'Connector action',
      blinkClassification: 'Blink type',
      simulation: 'Simulation',
      tokenMint: 'Token mint',
      recipient: 'Recipient',
      policy: 'Policy',
      limits: 'Limits',
      schedule: 'Schedule',
    };
    const slotOrder = spec.slots.includes('research') || !facts.research
      ? spec.slots
      : (['research', ...spec.slots] as DeterministicFactKey[]);
    for (const key of slotOrder) {
      const fact = facts[key];
      if (!fact) continue;
      if (researchFocused && key !== 'research' && fact.state !== 'fail' && fact.state !== 'warn') continue;
      const label = spec.labels?.[key] ?? defaultLabels[key];
      addRow({
        label,
        value: textValue(fact.message) || agentEvidenceFactStateLabel(fact.state),
        tone: agentEvidenceFactTone(fact.state),
      });
    }
  }

  for (const question of review.questions ?? []) {
    addRow({
      label: question.required === false ? 'Requested input' : 'Missing input',
      value: question.prompt,
      tone: 'warn',
    });
  }
  for (const row of missingInputEvidenceRows(evidence, stringify)) {
    addRow(row);
  }

  for (const snapshot of review.policies ?? []) {
    addRow({
      label: `Policy: ${snapshot.label}`,
      value: snapshot.ruleText,
      tone: snapshot.outcome === 'pass'
        ? 'good'
        : snapshot.outcome === 'warn'
          ? 'warn'
          : snapshot.outcome === 'block'
            ? 'fail'
            : 'neutral',
    });
  }

  for (const reviewer of review.reviewers ?? []) {
    const decisionLabel = reviewer.decision === 'approve'
      ? 'Approved'
      : reviewer.decision === 'needs_input'
        ? 'Needs input'
        : 'Denied';
    addRow({
      label: `${reviewer.label}: ${decisionLabel}`,
      value: reviewer.reason,
      tone: reviewer.decision === 'approve' ? 'good' : reviewer.decision === 'needs_input' ? 'warn' : 'fail',
    });
  }

  if (options.stale || review.staleness) {
    const triggerLabels = review.staleness?.triggers?.map((trigger) => trigger.field).filter(Boolean) ?? [];
    addRow({
      label: 'Stale review',
      value: triggerLabels.length
        ? `Draft changed after review: ${triggerLabels.join(', ')}. Ask the agent again before relying on this decision.`
        : 'Draft changed after review. Ask the agent again before relying on this decision.',
      tone: 'warn',
    });
  }

  if (evidence) {
    const seenLabels = new Set(rows.map((row) => row.label.toLowerCase()));
    for (const [key, raw] of Object.entries(evidence)) {
      if (raw === undefined || raw === null) continue;
      if (researchFocused && isResearchFallbackEvidenceKey(key)) continue;
      if (isTokenMismatchEvidenceKey(key) || isStructuredEvidenceKey(key) || isMissingInputEvidenceKey(key) || isAuditEvidenceKey(key)) continue;
      if (!isDisplayableEvidenceValue(raw)) continue;
      const label = humanizeEvidenceKey(key);
      if (seenLabels.has(label.toLowerCase())) continue;
      const value = evidenceValueText(raw, stringify);
      addRow({ label, value, tone: evidenceEntryTone(label, value) });
    }
  }

  if (!rows.length) {
    addFallbackRows(review, addRow);
  }
  return rows.slice(0, 32);
}

export function reviewEvidenceSections(
  review: AgentEvidenceReviewLike,
  options: ReviewEvidenceRowsOptions = {},
): AgentEvidenceDisplaySection[] {
  const sections = new Map<AgentEvidenceSectionId, AgentEvidenceDisplayRow[]>();
  const addToSection = (id: AgentEvidenceSectionId, row: AgentEvidenceDisplayRow): void => {
    const rows = sections.get(id) ?? [];
    rows.push(row);
    sections.set(id, rows);
  };

  const decisionRows = reviewDecisionDisplayRows(review);
  for (const row of decisionRows) {
    addToSection('decision', row);
  }

  const evidenceRows = reviewEvidenceRows(review, options);
  const groupedRows = decisionRows.length
    ? evidenceRows.filter((row) => !isDecisionSummaryRow(row))
    : evidenceRows;
  for (const row of groupedRows) {
    addToSection(evidenceSectionForRow(row), row);
  }

  const ordered: AgentEvidenceDisplaySection[] = [];
  for (const id of ['decision', 'market', 'token', 'transaction', 'sources', 'other'] as const) {
    const rows = sections.get(id);
    if (rows?.length) {
      ordered.push({ id, label: evidenceSectionLabel(id), rows });
    }
  }

  const advancedRows = advancedEvidenceRows(review, options);
  if (advancedRows.length) {
    ordered.push({
      id: 'advanced',
      label: evidenceSectionLabel('advanced'),
      rows: advancedRows,
      advanced: true,
    });
  }
  return ordered;
}

export function advancedEvidenceRows(
  review: AgentEvidenceReviewLike,
  options: ReviewEvidenceRowsOptions = {},
): AgentEvidenceDisplayRow[] {
  const rows: AgentEvidenceDisplayRow[] = [];
  const seen = new Set<string>();
  const evidence = review.evidence && isPlainRecord(review.evidence) ? review.evidence : undefined;
  const stringify = options.stringify ?? stableStringify;
  const addRow = (row: Partial<AgentEvidenceDisplayRow>): void => {
    const label = textValue(row.label).slice(0, 96);
    const value = textValue(row.value).slice(0, 720);
    if (!label || !value) return;
    const key = `${label.toLowerCase()}\n${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      label,
      value,
      tone: normalizeEvidenceTone(row.tone) ?? 'neutral',
    });
  };

  const decisionContract = decisionContractRecord(review, evidence);
  if (decisionContract) {
    const decision = textValue(decisionContract.decision);
    const factIds = stringArrayValue(decisionContract.evidenceFactIds);
    const blocking = stringArrayValue(decisionContract.blockingFactIds);
    const missing = stringArrayValue(decisionContract.missingFactIds);
    const confidence = textValue(decisionContract.confidence);
    addRow({
      label: 'Decision contract',
      value: [
        decision ? `decision: ${decision}` : '',
        `${factIds.length} cited fact${factIds.length === 1 ? '' : 's'}`,
        `${blocking.length} blocking`,
        `${missing.length} missing`,
      ].filter(Boolean).join(' · '),
      tone: decision === 'approve' ? 'good' : decision === 'deny' ? 'fail' : decision === 'needs_input' ? 'warn' : 'neutral',
    });
    if (confidence) {
      addRow({
        label: 'Confidence',
        value: confidence,
        tone: confidence === 'high' ? 'good' : confidence === 'medium' ? 'warn' : 'fail',
      });
    }
    if (factIds.length) {
      addRow({ label: 'Cited evidence ids', value: factIds.join(', '), tone: 'neutral' });
    }
    if (blocking.length) {
      addRow({ label: 'Blocking facts', value: blocking.join(', '), tone: 'fail' });
    }
    if (missing.length) {
      addRow({ label: 'Missing facts', value: missing.join(', '), tone: 'warn' });
    }
    const warnings = stringArrayValue(decisionContract.warnings);
    if (warnings.length) {
      addRow({ label: 'Contract warnings', value: warnings.join('; '), tone: 'warn' });
    }
  }

  const evidenceGate = isPlainRecord(review.evidenceGate) ? review.evidenceGate : undefined;
  if (evidenceGate) {
    const decision = textValue(evidenceGate.decision);
    addRow({
      label: 'Evidence gate',
      value: decision ? `Gate result: ${decision}` : evidenceValueText(evidenceGate, stringify),
      tone: decision === 'pass' ? 'good' : decision === 'block' ? 'fail' : decision === 'needs_input' ? 'warn' : 'neutral',
    });
  }

  if (review.decisionViolations?.length) {
    addRow({ label: 'Validation issues', value: review.decisionViolations.join('; '), tone: 'warn' });
  }

  for (const row of auditReceiptDisplayRows(review.auditReceipt)) {
    addRow(row);
  }

  if (evidence) {
    for (const [key, raw] of Object.entries(evidence)) {
      if (raw === undefined || raw === null) continue;
      if (normalizeEvidenceKey(key) === 'decisioncontract') continue;
      if (isStructuredEvidenceKey(key) || isMissingInputEvidenceKey(key) || isTokenMismatchEvidenceKey(key)) continue;
      if (!isAuditEvidenceKey(key) && isDisplayableEvidenceValue(raw)) continue;
      const value = isDisplayableEvidenceValue(raw)
        ? evidenceValueText(raw, stringify)
        : 'Available in raw audit JSON.';
      addRow({
        label: humanizeEvidenceKey(key),
        value,
        tone: isAuditEvidenceKey(key) ? 'neutral' : evidenceEntryTone(key, value),
      });
    }
  }

  return rows.slice(0, 24);
}

export function isTokenMismatchEvidenceKey(key: string): boolean {
  return TOKEN_MISMATCH_KEYS.has(normalizeEvidenceKey(key));
}

export function isAuditEvidenceKey(key: string): boolean {
  return AUDIT_EVIDENCE_KEYS.has(normalizeEvidenceKey(key));
}

function isResearchFallbackEvidenceKey(key: string): boolean {
  return RESEARCH_FALLBACK_EVIDENCE_KEYS.has(normalizeEvidenceKey(key));
}

export function evidenceEntryTone(label: string, value: string): AgentEvidenceTone {
  const text = `${label} ${value}`.toLowerCase();
  return /\b(token mismatch|wrong token|intended token|actual token|actual mint|expected token)\b/.test(text)
    ? 'fail'
    : 'neutral';
}

function evidenceFindingRows(evidence: Record<string, unknown> | undefined): AgentEvidenceDisplayRow[] {
  if (!evidence) return [];
  const raw = Array.isArray(evidence.findings)
    ? evidence.findings
    : Array.isArray(evidence.checks)
      ? evidence.checks
      : Array.isArray(evidence.evidenceRows)
        ? evidence.evidenceRows
        : undefined;
  if (!raw) return [];
  const rows: AgentEvidenceDisplayRow[] = [];
  for (const entry of raw) {
    if (!isPlainRecord(entry)) continue;
    const label = textValue(entry.label);
    const value = textValue(entry.value);
    if (!label || !value) continue;
    rows.push({
      label,
      value,
      tone: normalizeEvidenceTone(entry.tone) ?? evidenceEntryTone(label, value),
    });
    if (rows.length >= 24) break;
  }
  return rows;
}

function hasResearchEvidence(evidence: Record<string, unknown> | undefined): boolean {
  if (!evidence) return false;
  if (isPlainRecord(evidence.research)) return true;
  return false;
}

function isPromptScopedOperationalRow(row: Pick<AgentEvidenceDisplayRow, 'label' | 'value'>): boolean {
  const text = `${row.label} ${row.value}`.toLowerCase();
  return /\b(connected wallet|wallet approval|send for approval|swap quote|swap route|jupiter|slippage|max slippage|price impact|token identity|token metadata|token security|token safety|token market|token price|token age|mint authority|freeze authority|birdeye|coingecko|dex\s*screener)\b/u.test(text);
}

function sourceEvidenceRows(evidence: Record<string, unknown> | undefined): AgentEvidenceDisplayRow[] {
  if (!evidence) return [];
  const raw = Array.isArray(evidence.sources)
    ? evidence.sources
    : Array.isArray(evidence.citations)
      ? evidence.citations
      : undefined;
  if (!raw) return [];
  const rows: AgentEvidenceDisplayRow[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isPlainRecord(entry)) continue;
    const url = textValue(entry.url) || textValue(entry.ref);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = textValue(entry.title);
    rows.push({
      label: title ? `Source: ${title}` : 'Source',
      value: url,
      tone: 'neutral',
    });
    if (rows.length >= 6) break;
  }
  return rows;
}

function missingInputEvidenceRows(
  evidence: Record<string, unknown> | undefined,
  stringify: (value: unknown) => string,
): AgentEvidenceDisplayRow[] {
  if (!evidence) return [];
  const rows: AgentEvidenceDisplayRow[] = [];
  for (const [key, raw] of Object.entries(evidence)) {
    if (!isMissingInputEvidenceKey(key) || raw === undefined || raw === null) continue;
    rows.push({
      label: 'Missing input',
      value: evidenceValueText(raw, stringify),
      tone: 'warn',
    });
  }
  return rows;
}

function reviewDecisionDisplayRows(review: AgentEvidenceReviewLike): AgentEvidenceDisplayRow[] {
  const status = review.status ?? (review.decision === 'approve' ? 'approved' : review.decision === 'deny' ? 'denied' : undefined);
  const rows: AgentEvidenceDisplayRow[] = [];
  if (review.summary) {
    rows.push({ label: 'Summary', value: review.summary, tone: statusTone(status) });
  }
  const reason = textValue(review.reason);
  if (reason && reason !== review.summary) {
    rows.push({ label: reasonFallbackLabel(status), value: reason, tone: statusTone(status) });
  }
  return rows;
}

const DECISION_SUMMARY_LABELS = new Set([
  'summary',
  'reason',
  'approval summary',
  'denial reason',
  'missing information',
  'review error',
  'review status',
  'review state',
]);

function isDecisionSummaryRow(row: AgentEvidenceDisplayRow): boolean {
  return DECISION_SUMMARY_LABELS.has(row.label.toLowerCase());
}

function addFallbackRows(
  review: AgentEvidenceReviewLike,
  addRow: (row: Partial<AgentEvidenceDisplayRow>) => void,
): void {
  const status = review.status ?? (review.decision === 'approve' ? 'approved' : review.decision === 'deny' ? 'denied' : undefined);
  if (review.summary) {
    addRow({ label: 'Summary', value: review.summary, tone: statusTone(status) });
  }
  if (review.reason) {
    addRow({ label: reasonFallbackLabel(status), value: review.reason, tone: statusTone(status) });
  }
  if (!review.summary && !review.reason) {
    addRow({
      label: 'Review state',
      value: status ? humanizeEvidenceKey(status) : 'No findings were returned by the agent.',
      tone: statusTone(status),
    });
  }
}

function evidenceSectionForRow(row: AgentEvidenceDisplayRow): AgentEvidenceSectionId {
  const text = `${row.label} ${row.value}`.toLowerCase();
  if (/^source:|^source$|https?:\/\/|www\./i.test(row.label) || /^https?:\/\//i.test(row.value)) return 'sources';
  if (/\b(threshold|decision|approval|denial|missing input|requested input|stale review)\b/.test(text)) return 'decision';
  if (/\b(token|mint|freeze authority|mint authority|age|symbol)\b/.test(text)) return 'token';
  if (/\b(price|rate|usd|market|liquidity|volume|dominance|fear\s*&\s*greed|fear and greed|coingecko|birdeye|dex screener)\b/.test(text)) return 'market';
  if (/\b(route|quote|slippage|swap amount|simulation|recipient|wallet|transfer|instruction|connector|protocol|policy|limit|schedule|program)\b/.test(text)) return 'transaction';
  return 'other';
}

function evidenceSectionLabel(id: AgentEvidenceSectionId): string {
  switch (id) {
    case 'decision':
      return 'Decision';
    case 'market':
      return 'Market & Price';
    case 'token':
      return 'Token Safety';
    case 'transaction':
      return 'Transaction Safety';
    case 'sources':
      return 'Sources';
    case 'advanced':
      return 'Advanced Audit';
    case 'other':
    default:
      return 'Other Checks';
  }
}

function reasonFallbackLabel(status: AgentEvidenceReviewLike['status'] | undefined): string {
  switch (status) {
    case 'approved':
      return 'Approval summary';
    case 'denied':
      return 'Denial reason';
    case 'needs_input':
      return 'Missing information';
    case 'error':
      return 'Review error';
    case 'checking':
      return 'Review status';
    default:
      return 'Reason';
  }
}

function statusTone(status: AgentEvidenceReviewLike['status'] | undefined): AgentEvidenceTone {
  switch (status) {
    case 'approved':
      return 'good';
    case 'denied':
    case 'error':
      return 'fail';
    case 'needs_input':
      return 'warn';
    case 'checking':
    default:
      return 'neutral';
  }
}

function agentEvidenceFactTone(state: AgentEvidenceFactLike['state']): AgentEvidenceTone {
  switch (state) {
    case 'ok':
    case 'checked':
      return 'good';
    case 'warn':
      return 'warn';
    case 'fail':
      return 'fail';
    case 'missing':
    default:
      return 'neutral';
  }
}

function agentEvidenceFactStateLabel(state: AgentEvidenceFactLike['state']): string {
  switch (state) {
    case 'ok':
      return 'OK';
    case 'checked':
      return 'Checked';
    case 'warn':
      return 'Warning noted';
    case 'fail':
      return 'Failed';
    case 'missing':
    default:
      return 'Not checked';
  }
}

function decisionContractRecord(
  review: AgentEvidenceReviewLike,
  evidence: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (isPlainRecord(review.decisionContract)) return review.decisionContract;
  const fromEvidence = evidence?.decisionContract;
  return isPlainRecord(fromEvidence) ? fromEvidence : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    : [];
}

function evidenceValueText(raw: unknown, stringify: (value: unknown) => string): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) {
    const primitiveValues = raw
      .map((entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean' ? String(entry) : '')
      .filter(Boolean);
    if (primitiveValues.length === raw.length) return primitiveValues.join(', ');
  }
  return stringify(raw);
}

function isDisplayableEvidenceValue(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return true;
  return Array.isArray(raw) && raw.every((entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean');
}

function isStructuredEvidenceKey(key: string): boolean {
  return STRUCTURED_EVIDENCE_KEYS.has(normalizeEvidenceKey(key));
}

function isMissingInputEvidenceKey(key: string): boolean {
  return MISSING_INPUT_KEYS.has(normalizeEvidenceKey(key));
}

function normalizeEvidenceTone(value: unknown): AgentEvidenceTone | undefined {
  if (value === 'good' || value === 'warn' || value === 'neutral' || value === 'fail') return value;
  if (value === 'success' || value === 'pass' || value === 'ok') return 'good';
  if (value === 'warning' || value === 'needs_input') return 'warn';
  if (value === 'danger' || value === 'error' || value === 'deny' || value === 'denied') return 'fail';
  return undefined;
}

function humanizeEvidenceKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return key;
  const spaced = trimmed.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function expectedOutputTokenFromPlanText(
  plan: Pick<AgentPlan, 'intent' | 'route' | 'userNotes' | 'parameters'>,
): string | undefined {
  const outputTokenRaw = plan.parameters.outputToken?.trim();
  if (!outputTokenRaw) return undefined;
  if (textMentionsTokenValue(plan.route, outputTokenRaw)) return undefined;
  const outputTokenLabel = plan.parameters.outputTokenLabel?.trim();
  if (outputTokenLabel && textMentionsTokenValue(plan.route, outputTokenLabel)) return undefined;
  const text = plan.route;
  const outputToken = plan.parameters.outputToken?.trim().toUpperCase();
  for (const token of KNOWN_OUTPUT_TOKENS) {
    if (token === outputToken) continue;
    if (mentionsOutputToken(text, token)) return token;
  }
  return undefined;
}

function mentionsOutputToken(text: string, token: string): boolean {
  const escaped = escapeRegExp(token);
  return [
    new RegExp(`(?:->|→)\\s*${escaped}\\b`, 'i'),
    new RegExp(`\\bto\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:output|receive|buy|get|into)\\s+(?:token\\s+)?${escaped}\\b`, 'i'),
  ].some((pattern) => pattern.test(text));
}

function textMentionsTokenValue(text: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  return text.toLowerCase().includes(trimmed.toLowerCase());
}

function outputMatchesExpectedToken(outputToken: string, outputLabel: string | undefined, expectedToken: string): boolean {
  const normalized = outputToken.trim();
  return normalized.toUpperCase() === expectedToken ||
    outputLabel?.trim().toUpperCase() === expectedToken ||
    normalized === KNOWN_OUTPUT_TOKEN_MINTS[expectedToken];
}

function evidenceValue(evidence: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = evidence[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'true' : '';
  }
  return '';
}

function normalizeEvidenceKey(key: string): string {
  return key.trim().replace(/[\s-]+/g, '_').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
