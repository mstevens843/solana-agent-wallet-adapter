import { header, badge, kv, divider } from '../tui/index.js';

interface Atom {
  id?: string;
  type?: string;
  kind?: string;
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
  evidence?: Record<string, unknown> & { policyBundle?: PolicyBundle };
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
export function renderPolicyBundle(response: DecisionShape | null | undefined): PolicyReviewVerdict {
  if (!response) {
    return { decision: 'unknown', hasBlockingFailure: false, atomCount: 0, unresolvedCount: 0 };
  }
  const bundle = response.policyBundle ?? response.evidence?.policyBundle;
  const decision = (response.decision ?? '').toLowerCase();
  const hasBlockingFailure = Boolean(bundle?.hasBlockingFailure);

  if (decision && decision !== 'approve' && hasBlockingFailure) {
    // ok — decision and bundle agree.
  } else if (decision === 'approve' && hasBlockingFailure) {
    console.log();
    console.log(badge('⚠ Inconsistent verdict — bridge says APPROVE but a blocking policy failed.', 'warn'));
  }

  if (decision) {
    console.log();
    console.log(decisionBanner(decision, response.reason ?? response.summary));
  }

  const atoms = bundle?.atoms ?? [];
  const evaluations = bundle?.evaluations ?? [];
  const unresolved = bundle?.unresolvedAtoms ?? [];
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
    const provider = res?.provider ?? ev?.provider ?? '—';
    const value = describeValue(ev?.value ?? res?.value);
    const verdict = ev?.pass === true ? badge('✓', 'ok')
                  : ev?.pass === false ? badge('✗', 'err')
                  : badge('—', 'muted');
    console.log(`  ${verdict}  ${describeAtom(atom).padEnd(40)}  ${badge(provider, 'muted')}  ${value}`);
    if (ev?.reason) console.log(`         ${badge(ev.reason, 'muted')}`);
  }
}

function describeAtom(atom: Atom): string {
  const type = atom.kind ?? atom.type ?? 'atom';
  const query = atom.query ?? atom.text ?? atom.symbol ?? '';
  return `${type}${query ? `  ${query}` : ''}`;
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
