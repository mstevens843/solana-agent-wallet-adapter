export interface ReviewPostprocessPayload {
  context?: unknown;
}

type JsonRecord = Record<string, unknown>;

export function finalizeReviewResultForPayload<R extends JsonRecord>(
  result: R,
  payload: ReviewPostprocessPayload,
): R {
  const normalized = normalizeReviewResult(result);
  const researchEvidence = researchEvidenceFromPayload(payload);
  if (!researchEvidence) return normalized as R;
  return attachResearchEvidence(normalized, researchEvidence) as R;
}

function normalizeReviewResult(result: JsonRecord): JsonRecord {
  const out: JsonRecord = { ...result };
  const decision = stringValue(out.decision)
    || stringValue(out.verdict)
    || stringValue(out.status)
    || stringValue(out.decision_status)
    || stringValue(out.decisionStatus);
  if (decision) {
    out.decision = normalizeDecision(decision);
  } else if (typeof out.approved === 'boolean') {
    out.decision = out.approved ? 'approve' : 'deny';
  }

  if (!stringValue(out.reason)) {
    const reason = stringValue(out.rationale) || stringValue(out.explanation) || stringValue(out.why);
    if (reason) out.reason = reason;
  }
  if (!stringValue(out.summary)) {
    const summary = stringValue(out.result) || stringValue(out.answer);
    if (summary) out.summary = summary;
  }

  const evidence = isRecord(out.evidence) ? { ...out.evidence } : {};
  for (const key of ['findings', 'checks', 'evidenceRows', 'evidence_rows', 'sources', 'citations'] as const) {
    if (evidence[key] === undefined && out[key] !== undefined) {
      evidence[key] = out[key];
      delete out[key];
    }
  }
  out.evidence = evidence;
  return out;
}

function attachResearchEvidence(result: JsonRecord, researchEvidence: JsonRecord): JsonRecord {
  const evidence = isRecord(result.evidence) ? { ...result.evidence } : {};
  if (!isRecord(evidence.research)) {
    evidence.research = {
      status: stringValue(researchEvidence.status) || 'checked',
      required: researchEvidence.required === true,
      ...(stringValue(researchEvidence.provider) ? { provider: stringValue(researchEvidence.provider) } : {}),
      ...(stringValue(researchEvidence.checkedAt) ? { checkedAt: stringValue(researchEvidence.checkedAt) } : {}),
    };
  }
  const sources = mergeSourceRows(evidence.sources, researchEvidence.sources);
  if (sources.length) evidence.sources = sources;
  const findings = Array.isArray(evidence.findings) ? [...evidence.findings] : [];
  const summary = stringValue(researchEvidence.summary);
  if (summary && !findings.some((entry) => findingLabel(entry) === 'current research')) {
    findings.push({
      label: 'Current research',
      value: summary,
      tone: 'neutral',
    });
  }
  if (findings.length) evidence.findings = findings;
  return { ...result, evidence };
}

function mergeSourceRows(existing: unknown, added: unknown): JsonRecord[] {
  const out: JsonRecord[] = [];
  const seen = new Set<string>();
  for (const entry of [...sourceRows(existing), ...sourceRows(added)]) {
    const url = stringValue(entry.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(entry);
  }
  return out;
}

function sourceRows(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((entry) => {
    const url = stringValue(entry.url) || stringValue(entry.ref);
    if (!url) return [];
    const title = stringValue(entry.title);
    return [{ url, ...(title ? { title } : {}) }];
  });
}

function researchEvidenceFromPayload(payload: ReviewPostprocessPayload): JsonRecord | undefined {
  const context = isRecord(payload.context) ? payload.context : undefined;
  const researchEvidence = context?.researchEvidence;
  return isRecord(researchEvidence) ? researchEvidence : undefined;
}

function normalizeDecision(value: string): string {
  const lower = value.trim().toLowerCase().replace(/[\s-]+/gu, '_');
  if (lower === 'approved' || lower === 'pass' || lower === 'passed' || lower === 'allow') return 'approve';
  if (lower === 'denied' || lower === 'reject' || lower === 'rejected' || lower === 'fail' || lower === 'failed') return 'deny';
  if (lower === 'needs_input' || lower === 'needsinput' || lower === 'needs_user_input' || lower === 'manual_review') return 'needs_input';
  return lower;
}

function findingLabel(value: unknown): string {
  return isRecord(value) ? stringValue(value.label).trim().toLowerCase() : '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
