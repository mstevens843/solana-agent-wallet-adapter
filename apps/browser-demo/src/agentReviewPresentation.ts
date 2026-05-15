import type { AgentPlan } from './planner.js';
import { findingsSpecFor, type DeterministicFactKey } from './agentFindingsSpec.js';

export type AgentEvidenceTone = 'good' | 'warn' | 'neutral' | 'fail';

export interface AgentEvidenceDisplayRow {
  label: string;
  value: string;
  tone: AgentEvidenceTone;
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
    addRow(row);
  }
  for (const finding of evidenceFindingRows(evidence)) {
    addRow(finding);
  }
  for (const row of tokenMismatchEvidenceRows(evidence)) {
    addRow(row);
  }
  for (const row of sourceEvidenceRows(evidence)) {
    addRow(row);
  }
  for (const row of auditReceiptDisplayRows(review.auditReceipt)) {
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
      if (isTokenMismatchEvidenceKey(key) || isStructuredEvidenceKey(key) || isMissingInputEvidenceKey(key)) continue;
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

export function isTokenMismatchEvidenceKey(key: string): boolean {
  return TOKEN_MISMATCH_KEYS.has(normalizeEvidenceKey(key));
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
  if (Array.isArray(evidence.sources) && evidence.sources.length > 0) return true;
  return Array.isArray(evidence.citations) && evidence.citations.length > 0;
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
