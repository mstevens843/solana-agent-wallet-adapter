import { header, badge, kv, divider } from '../tui/index.js';

interface Atom {
  id?: string;
  type?: string;
  kind?: string;
  rawText?: string;
  query?: string;
  text?: string;
  threshold?: string | number;
  symbol?: string;
}

interface Evaluation {
  atomId?: string;
  pass?: boolean;
  reason?: string;
  value?: unknown;
  provider?: string;
  unresolved?: boolean;
  finding?: {
    label?: string;
    value?: unknown;
    tone?: string;
  };
}

interface PolicyBundle {
  atoms?: Atom[];
  resolutions?: Array<{ atomId?: string; provider?: string; value?: unknown; success?: boolean }>;
  evaluations?: Evaluation[];
  unresolvedAtoms?: Atom[];
  hasBlockingFailure?: boolean;
  txGateOutcomes?: Record<string, { pass?: boolean; reason?: string }>;
  finishedAt?: string;
}

interface DecisionShape {
  decision?: string;
  reason?: string;
  summary?: string;
  evidence?: Record<string, unknown> & {
    policyBundle?: PolicyBundle;
    policyAtoms?: Atom[];
    policyTxGates?: PolicyBundle['txGateOutcomes'];
  };
  policyBundle?: PolicyBundle;
}

// Boiled-down verdict that callers (runAgent, maybeEnhanceWithAi) can act on:
// skip the queue prompt when decision === 'deny' OR hasBlockingFailure === true.
export interface PolicyReviewVerdict {
  decision: string;
  reason?: string;
  hasBlockingFailure: boolean;
  atomCount: number;
  unresolvedCount: number;
}

// Top-level renderer — takes whatever the bridge returned and prints the
// decision banner, atom verdicts, blocking-failure warning. Returns a
// `PolicyReviewVerdict` for the caller; safe to call when the bundle is
// missing (returns a default `decision: 'unknown'`).
export interface RenderPolicyBundleOptions {
  printDecision?: boolean;
}

export function renderPolicyBundle(
  response: DecisionShape | null | undefined,
  options: RenderPolicyBundleOptions = {},
): PolicyReviewVerdict {
  if (!response) {
    return { decision: 'unknown', hasBlockingFailure: false, atomCount: 0, unresolvedCount: 0 };
  }
  const bundle = policyBundleFromResponse(response);
  const decision = (response.decision ?? '').toLowerCase();
  const hasBlockingFailure = Boolean(bundle?.hasBlockingFailure);

  if (decision && decision !== 'approve' && hasBlockingFailure) {
    // ok — decision and bundle agree.
  } else if (decision === 'approve' && hasBlockingFailure) {
    console.log();
    console.log(badge('⚠ Inconsistent verdict — bridge says APPROVE but a blocking policy failed.', 'warn'));
  }

  if (decision && options.printDecision !== false) {
    console.log();
    console.log(decisionBanner(decision, response.reason ?? response.summary));
  }

  const atoms = bundle?.atoms ?? [];
  const evaluations = bundle?.evaluations ?? [];
  const unresolved = bundle?.unresolvedAtoms ?? atoms.filter((atom) => {
    const ev = atom.id ? evaluations.find((candidate) => candidate.atomId === atom.id) : undefined;
    return ev?.unresolved === true;
  });
  const resolutions = bundle?.resolutions ?? [];

  if (atoms.length > 0 || evaluations.length > 0 || unresolved.length > 0) {
    console.log();
    console.log(header('Policy atoms'));
    renderAtomTable(atoms, evaluations, resolutions);

    if (unresolved.length > 0) {
      console.log();
      console.log(badge(`${unresolved.length} unresolved atom${unresolved.length === 1 ? '' : 's'} (web fallback may have run)`, 'warn'));
      for (const u of unresolved) {
        console.log(`  · ${describeAtom(u)}`);
      }
    }

    if (hasBlockingFailure) {
      console.log();
      console.log(badge('hasBlockingFailure: TRUE — at least one policy check failed; queue will be skipped.', 'err'));
    }

    const txGate = bundle?.txGateOutcomes ?? {};
    const txGateKeys = Object.keys(txGate);
    if (txGateKeys.length > 0) {
      console.log();
      console.log(header('Tx-gate outcomes'));
      for (const key of txGateKeys) {
        const outcome = txGate[key]!;
        const chip = outcome.pass ? badge('pass', 'ok') : badge('fail', 'err');
        console.log(`  ${chip}  ${key}  ${outcome.reason ?? ''}`);
      }
    }

    console.log(divider());
  }

  return {
    decision: decision || 'unknown',
    ...(response.reason !== undefined ? { reason: response.reason } : (response.summary !== undefined ? { reason: response.summary } : {})),
    hasBlockingFailure,
    atomCount: atoms.length,
    unresolvedCount: unresolved.length,
  };
}

export function verdictBlocksQueue(verdict: PolicyReviewVerdict | null | undefined): boolean {
  if (!verdict) return false;
  return verdict.decision === 'deny' || verdict.hasBlockingFailure;
}

function decisionBanner(decision: string, reason?: string): string {
  const d = decision.toLowerCase();
  const banner = d === 'approve'  ? badge('APPROVE',    'ok')
              : d === 'deny'     ? badge('DENY',       'err')
              : d === 'needs_input' ? badge('NEEDS INPUT', 'warn')
              : badge(decision.toUpperCase(), 'muted');
  return `${banner}  ${reason ?? ''}`;
}

function renderAtomTable(atoms: Atom[], evaluations: Evaluation[], resolutions: Array<{ atomId?: string; provider?: string; value?: unknown; success?: boolean }>): void {
  if (atoms.length === 0) {
    console.log(badge('No atoms extracted from the policy NOTE.', 'muted'));
    return;
  }
  for (const atom of atoms) {
    const id = atom.id ?? '?';
    const ev = evaluations.find((e) => e.atomId === id);
    const res = resolutions.find((r) => r.atomId === id);
    const provider = res?.provider ?? ev?.provider ?? providerHint(atom, ev);
    const value = describeValue(ev?.finding?.value ?? ev?.value ?? res?.value);
    const verdict = ev?.pass === true ? badge('✓', 'ok')
                  : ev?.pass === false ? badge('✗', 'err')
                  : ev?.unresolved === true ? badge('?', 'warn')
                  : badge('—', 'muted');
    const providerPart = provider ? `  ${badge(provider, 'muted')}` : '';
    console.log(`  ${verdict}  ${describeAtom(atom).padEnd(40)}${providerPart}  ${value}`);
    const reason = ev?.reason ?? (typeof ev?.finding?.label === 'string' ? ev.finding.label : undefined);
    if (reason) console.log(`         ${badge(reason, 'muted')}`);
  }
}

function describeAtom(atom: Atom): string {
  const type = atom.kind ?? atom.type ?? 'atom';
  const query = atom.rawText ?? atom.query ?? atom.text ?? atom.symbol ?? '';
  return `${type}${query ? `  ${query}` : ''}`;
}

function providerHint(atom: Atom, ev: Evaluation | undefined): string {
  if (ev?.unresolved) return 'unresolved';
  if (!atom.type) return '';
  if (atom.type === 'tx_gate') return 'tx analyzer';
  return '';
}

function describeValue(v: unknown): string {
  if (v === undefined || v === null) return badge('—', 'muted');
  if (typeof v === 'string') return v.length > 30 ? `${v.slice(0, 27)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  } catch {
    return badge('(complex)', 'muted');
  }
}

interface ReviewQuestion {
  id?: string;
  label?: string;
  prompt?: string;
  options?: string[];
  type?: string;
}

export interface ReviewResponse {
  decision?: string;
  reason?: string;
  summary?: string;
  questions?: ReviewQuestion[];
  evidence?: Record<string, unknown> & { policyBundle?: PolicyBundle };
  policyBundle?: PolicyBundle;
}

function policyBundleFromResponse(response: DecisionShape): PolicyBundle | undefined {
  const explicit = response.policyBundle ?? response.evidence?.policyBundle;
  if (explicit) {
    const txGates = explicit.txGateOutcomes ?? response.evidence?.policyTxGates;
    return txGates && txGates !== explicit.txGateOutcomes
      ? { ...explicit, txGateOutcomes: txGates }
      : explicit;
  }
  const evidence = response.evidence;
  if (!evidence) return undefined;

  const atoms = Array.isArray(evidence.policyAtoms)
    ? evidence.policyAtoms.map((atom) => compactAtom(atom)).filter((atom): atom is Atom => Boolean(atom))
    : [];
  const txGateOutcomes = isRecord(evidence.policyTxGates)
    ? evidence.policyTxGates as PolicyBundle['txGateOutcomes']
    : undefined;
  const evaluations = evidenceFindingsAsEvaluations(evidence, atoms);
  if (atoms.length === 0 && evaluations.length === 0 && !txGateOutcomes) return undefined;
  const unresolvedAtoms = atoms.filter((atom) => {
    const ev = atom.id ? evaluations.find((candidate) => candidate.atomId === atom.id) : undefined;
    return ev?.unresolved === true;
  });
  const blockingIds = decisionContractIds(evidence, 'blockingFactIds');
  const hasBlockingFailure = evaluations.some((evaluation) => evaluation.pass === false)
    || Object.values(txGateOutcomes ?? {}).some((outcome) => outcome?.pass === false)
    || atoms.some((atom) => atom.id ? blockingIds.has(atom.id) : false);
  return {
    atoms,
    evaluations,
    unresolvedAtoms,
    ...(txGateOutcomes ? { txGateOutcomes } : {}),
    hasBlockingFailure,
  };
}

function compactAtom(raw: unknown): Atom | null {
  if (!isRecord(raw)) return null;
  const id = stringValue(raw.id);
  const type = stringValue(raw.type ?? raw.kind);
  if (!id && !type) return null;
  return {
    ...(id ? { id } : {}),
    ...(type ? { type } : {}),
    ...(stringValue(raw.kind) ? { kind: stringValue(raw.kind) } : {}),
    ...(stringValue(raw.rawText) ? { rawText: stringValue(raw.rawText) } : {}),
    ...(stringValue(raw.query) ? { query: stringValue(raw.query) } : {}),
    ...(stringValue(raw.text) ? { text: stringValue(raw.text) } : {}),
    ...(stringValue(raw.symbol) ? { symbol: stringValue(raw.symbol) } : {}),
  };
}

function evidenceFindingsAsEvaluations(evidence: Record<string, unknown>, atoms: Atom[]): Evaluation[] {
  const findings = Array.isArray(evidence.findings) ? evidence.findings : [];
  const atomIds = new Set(atoms.map((atom) => atom.id).filter((id): id is string => Boolean(id)));
  const evaluations: Evaluation[] = [];
  for (const raw of findings) {
    if (!isRecord(raw)) continue;
    const atomId = stringValue(raw.atomId);
    if (!atomId || (atomIds.size > 0 && !atomIds.has(atomId))) continue;
    const value = raw.value;
    const tone = stringValue(raw.tone);
    evaluations.push({
      atomId,
      pass: tone === 'good' || tone === 'ok' || tone === 'pass'
        ? true
        : tone === 'fail' || tone === 'error' || tone === 'deny'
          ? false
          : undefined,
      unresolved: /^unknown$/i.test(typeof value === 'string' ? value.trim() : ''),
      finding: {
        ...(stringValue(raw.label) ? { label: stringValue(raw.label) } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(tone ? { tone } : {}),
      },
    });
  }
  return evaluations;
}

function decisionContractIds(evidence: Record<string, unknown>, key: string): Set<string> {
  const contract = isRecord(evidence.decisionContract) ? evidence.decisionContract : undefined;
  const raw = contract?.[key];
  return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
