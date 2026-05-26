import { header, badge, divider, kv } from '../tui/index.js';
import { renderPolicyBundle, type PolicyReviewVerdict } from './policyBundleRender.js';

export type EvidenceTone = 'good' | 'warn' | 'neutral' | 'fail';

export type EvidenceSectionId =
  | 'decision'
  | 'market'
  | 'token'
  | 'transaction'
  | 'sources'
  | 'other';

interface EvidenceDisplayRow {
  label: string;
  value: string;
  tone: EvidenceTone;
}

interface EvidenceDisplaySection {
  id: EvidenceSectionId | 'advanced';
  label: string;
  rows: EvidenceDisplayRow[];
}

export interface AgentReviewResponse {
  decision?: string;
  reason?: string;
  summary?: string;
  evidence?: Record<string, unknown>;
  policyBundle?: Record<string, unknown>;
  checks?: Array<{ label?: string; value?: string; tone?: string }>;
  provider?: string;
  model?: string;
  checkedAt?: string;
  questions?: Array<{ id?: string; label?: string; prompt?: string; options?: string[]; required?: boolean }>;
}

// Renders the agent's verdict the way the web app does: a green/red banner with
// summary + reason, then sectioned findings (Decision / Market & Price / Token
// Safety / Transaction Safety / Sources / Other), then an Advanced Audit block
// that delegates to renderPolicyBundle for the atom-level details.
// Returns a verdict the caller can use to gate the queue, same shape as
// renderPolicyBundle so callers can switch transparently.
export function renderAgentReview(response: AgentReviewResponse | null | undefined): PolicyReviewVerdict {
  if (!response) {
    return { decision: 'unknown', hasBlockingFailure: false, atomCount: 0, unresolvedCount: 0 };
  }

  const decision = (response.decision ?? '').toLowerCase();
  printBanner(decision, response);

  const sections = sectionize(response);
  for (const section of sections) {
    if (section.rows.length === 0) continue;
    console.log();
    console.log(header(section.label));
    if (section.id === 'sources') {
      printSources(section.rows);
    } else {
      printRows(section.rows);
    }
  }

  // Advanced Audit — delegate to the existing policy-bundle renderer for the
  // atom table + tx-gate outcomes. This is what makes /new flows surface the
  // same atom-level detail that /agent has always shown.
  const verdict = renderPolicyBundle(response as unknown as Parameters<typeof renderPolicyBundle>[0]);
  return verdict;
}

function printBanner(decision: string, response: AgentReviewResponse): void {
  const provider = response.provider?.trim();
  const model = response.model?.trim();
  const checkedAt = formatCheckedAt(response.checkedAt);
  const meta = [provider, model, checkedAt].filter(Boolean).join(' · ');

  let chip: string;
  if (decision === 'approve') chip = badge('AGENT APPROVED', 'ok');
  else if (decision === 'deny') chip = badge('AGENT DENIED', 'err');
  else if (decision === 'needs_input') chip = badge('AGENT NEEDS INPUT', 'warn');
  else chip = badge(`AGENT ${decision.toUpperCase() || 'REVIEW'}`, 'muted');

  console.log();
  console.log(meta ? `${chip}  ${badge(meta, 'muted')}` : chip);

  const rows: Array<[string, string]> = [];
  if (response.summary?.trim()) rows.push(['Summary', response.summary.trim()]);
  const reason = response.reason?.trim();
  if (reason && reason !== response.summary?.trim()) {
    rows.push([reasonLabel(decision), reason]);
  }
  if (rows.length > 0) console.log(kv(rows));
}

function reasonLabel(decision: string): string {
  if (decision === 'approve') return 'Approval summary';
  if (decision === 'deny') return 'Denial reason';
  if (decision === 'needs_input') return 'Missing information';
  return 'Reason';
}

function formatCheckedAt(checkedAt: string | undefined): string {
  if (!checkedAt) return '';
  try {
    const d = new Date(checkedAt);
    if (Number.isNaN(d.getTime())) return '';
    // Mirror web app's "May 17, 05:25 PM" formatting.
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

function printRows(rows: EvidenceDisplayRow[]): void {
  const longest = rows.reduce((acc, row) => Math.max(acc, row.label.length), 0);
  for (const row of rows) {
    const mark = toneMark(row.tone);
    const label = row.label.padEnd(Math.min(longest, 30));
    const value = truncateValue(row.value);
    console.log(`  ${mark}  ${label}  ${value}`);
  }
}

function printSources(rows: EvidenceDisplayRow[]): void {
  for (const row of rows) {
    console.log(`  · ${row.label.replace(/^Source:\s*/, '')}`);
    console.log(`    ${badge(row.value, 'muted')}`);
  }
}

function truncateValue(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}…` : collapsed;
}

function toneMark(tone: EvidenceTone): string {
  switch (tone) {
    case 'good': return badge('✓', 'ok');
    case 'fail': return badge('✗', 'err');
    case 'warn': return badge('⚠', 'warn');
    case 'neutral':
    default: return badge('—', 'muted');
  }
}

// Pure-function bucketing — ported from
// apps/browser-demo/src/agentReviewPresentation.ts (reviewEvidenceSections +
// reviewEvidenceRows + evidenceSectionForRow), with the action-type-specific
// findings spec and the cross-app helpers (token-mismatch checks, web-research
// fallback) trimmed down to what the CLI needs.
function sectionize(response: AgentReviewResponse): EvidenceDisplaySection[] {
  const sections = new Map<EvidenceSectionId, EvidenceDisplayRow[]>();
  const addRow = (id: EvidenceSectionId, row: EvidenceDisplayRow): void => {
    const list = sections.get(id) ?? [];
    list.push(row);
    sections.set(id, list);
  };
  const seen = new Set<string>();
  const enqueue = (row: EvidenceDisplayRow): void => {
    const key = `${row.label.toLowerCase()}\n${row.value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    addRow(routeRowToSection(row), row);
  };

  const evidence = isPlainRecord(response.evidence) ? response.evidence : undefined;

  // checks[] on the top-level response or inside evidence
  for (const check of response.checks ?? []) {
    const row = checkRow(check);
    if (row) enqueue(row);
  }
  for (const check of arrayValue(evidence?.checks)) {
    const row = checkRow(check);
    if (row) enqueue(row);
  }

  // findings[] or evidenceRows[] inside evidence — primary structured findings
  // the LLM emits. Same shape as checks.
  for (const finding of arrayValue(evidence?.findings)) {
    const row = checkRow(finding);
    if (row) enqueue(row);
  }
  for (const finding of arrayValue(evidence?.evidenceRows)) {
    const row = checkRow(finding);
    if (row) enqueue(row);
  }
  for (const finding of arrayValue(evidence?.evidenceFacts)) {
    const row = factRow(finding);
    if (row) enqueue(row);
  }

  // Sources (research citations) — both `sources` and `citations` arrays.
  for (const source of arrayValue(evidence?.sources)) {
    const row = sourceRow(source);
    if (row) enqueue(row);
  }
  for (const source of arrayValue(evidence?.citations)) {
    const row = sourceRow(source);
    if (row) enqueue(row);
  }

  // Unprompted clarifying questions (when decision was needs_input).
  for (const question of response.questions ?? []) {
    const row = questionRow(question);
    if (row) enqueue(row);
  }

  // Any remaining string/number/array evidence keys the LLM emitted ad-hoc.
  // Keep the most useful ones; skip structured fields we've already handled.
  if (evidence) {
    for (const [key, raw] of Object.entries(evidence)) {
      if (raw === undefined || raw === null) continue;
      if (STRUCTURED_KEYS.has(normalizeKey(key)) || AUDIT_KEYS.has(normalizeKey(key))) continue;
      if (!isDisplayableValue(raw)) continue;
      const row: EvidenceDisplayRow = {
        label: humanizeKey(key),
        value: stringifyEvidenceValue(raw),
        tone: 'neutral',
      };
      enqueue(row);
    }
  }

  // Final ordering.
  const ordered: EvidenceDisplaySection[] = [];
  for (const id of ['decision', 'market', 'token', 'transaction', 'sources', 'other'] as const) {
    const rows = sections.get(id);
    if (rows?.length) ordered.push({ id, label: sectionLabel(id), rows });
  }
  return ordered;
}

function sectionLabel(id: EvidenceSectionId): string {
  switch (id) {
    case 'decision': return 'Decision';
    case 'market': return 'Market & Price';
    case 'token': return 'Token Safety';
    case 'transaction': return 'Transaction Safety';
    case 'sources': return 'Sources';
    case 'other': return 'Other Checks';
  }
}

// Mirror of evidenceSectionForRow from
// apps/browser-demo/src/agentReviewPresentation.ts.
function routeRowToSection(row: EvidenceDisplayRow): EvidenceSectionId {
  const label = row.label.toLowerCase();
  const value = row.value.toLowerCase();
  const text = `${label} ${value}`;
  if (/^source:|^source$/i.test(row.label) || /^https?:\/\//i.test(row.value) || /www\./i.test(row.value)) return 'sources';
  if (/\b(threshold|decision|approval summary|denial reason|missing input|requested input|stale review)\b/.test(text)) return 'decision';
  if (/\b(token|mint|freeze authority|mint authority|symbol|verified|age)\b/.test(text)) return 'token';
  if (/\b(price|rate|usd|market|liquidity|volume|dominance|fear\s*&\s*greed|fear and greed|coingecko|birdeye|dex screener|cap)\b/.test(text)) return 'market';
  if (/\b(route|quote|slippage|swap amount|simulation|recipient|wallet|transfer|instruction|connector|protocol|policy|limit|schedule|program)\b/.test(text)) return 'transaction';
  return 'other';
}

function checkRow(raw: unknown): EvidenceDisplayRow | null {
  if (!isPlainRecord(raw)) return null;
  const label = textValue(raw.label);
  const value = textValue(raw.value);
  if (!label || !value) return null;
  return { label, value, tone: normalizeTone(raw.tone) ?? 'neutral' };
}

function factRow(raw: unknown): EvidenceDisplayRow | null {
  if (!isPlainRecord(raw)) return null;
  const label = textValue(raw.label);
  const value = textValue(raw.value);
  if (!label || !value) return null;
  return { label, value, tone: normalizeTone(raw.tone) ?? 'neutral' };
}

function sourceRow(raw: unknown): EvidenceDisplayRow | null {
  if (!isPlainRecord(raw)) return null;
  const url = textValue(raw.url) || textValue(raw.ref);
  if (!url) return null;
  const title = textValue(raw.title);
  return {
    label: title ? `Source: ${title}` : 'Source',
    value: url,
    tone: 'neutral',
  };
}

function questionRow(raw: { id?: string; label?: string; prompt?: string; required?: boolean }): EvidenceDisplayRow | null {
  const promptText = (raw.prompt ?? raw.label ?? '').trim();
  if (!promptText) return null;
  return {
    label: raw.required === false ? 'Requested input' : 'Missing input',
    value: promptText,
    tone: 'warn',
  };
}

function normalizeTone(value: unknown): EvidenceTone | undefined {
  if (value === 'good' || value === 'warn' || value === 'neutral' || value === 'fail') return value;
  if (value === 'success' || value === 'pass' || value === 'ok') return 'good';
  if (value === 'warning' || value === 'needs_input') return 'warn';
  if (value === 'danger' || value === 'error' || value === 'deny' || value === 'denied') return 'fail';
  return undefined;
}

function normalizeKey(key: string): string {
  return key.replace(/[_\-\s]+/g, '').toLowerCase();
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function stringifyEvidenceValue(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) {
    const flat = raw.map((entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean' ? String(entry) : '').filter(Boolean);
    if (flat.length) return flat.join(', ');
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function isDisplayableValue(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return true;
  return Array.isArray(raw) && raw.every((entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Keys that already produce rows via the structured paths above. Skipping them
// in the "Other" fallback prevents the renderer from showing the same data
// twice (once as a structured row, once as a stringified blob).
const STRUCTURED_KEYS = new Set([
  'findings',
  'checks',
  'evidencerows',
  'evidencefacts',
  'sources',
  'citations',
  'questions',
  'reviewers',
  'policies',
  'policybundle',
  'simulation',
  'simulationdigest',
  'staleness',
  'research',
  'connectorcontext',
  'protocolconnectors',
]);

// Keys that belong in the Advanced Audit block instead of the inline sections.
// renderPolicyBundle handles policyBundle, txGateOutcomes, atoms, evaluations.
const AUDIT_KEYS = new Set([
  'auditreceipt',
  'decisioncontract',
  'evidencegate',
  'guardrailreport',
  'decisionviolations',
  'constraintfingerprint',
  'constrainthash',
]);

// Short audit string used in the prepared-action note field, e.g.:
//   "Agent approved: Helium plan $15/mo ≤ $20"
//   "Agent denied: SOL ($85) < $1,000,000 threshold"
// The web app's review never lands in the note (it persists in the plan
// record). For the CLI v1 we surface it in `note` so /inbox still shows the
// audit trail when the user views the action later.
export function reviewSummaryLine(response: AgentReviewResponse): string {
  const decision = (response.decision ?? 'unknown').toLowerCase();
  const verb = decision === 'approve' ? 'Agent approved'
    : decision === 'deny' ? 'Agent denied'
    : decision === 'needs_input' ? 'Agent needs input'
    : 'Agent review';
  const detail = (response.summary || response.reason || '').replace(/\s+/g, ' ').trim();
  if (!detail) return verb;
  const joined = `${verb}: ${detail}`;
  return joined.length > 200 ? `${joined.slice(0, 197)}…` : joined;
}
