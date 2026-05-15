/**
 * Per-wallet behavioural baseline. Tracks what a wallet's "normal" looks like over its
 * approval history and flags anomalies on new drafts.
 *
 * Design constraints:
 *   - Storage is bounded (top-50 recipients, capped histogram buckets).
 *   - Update is pure: feed in a completion record, get a new baseline.
 *   - Evaluation is pure: feed in a baseline + plan, get a list of signals.
 *   - Signals default to severity 'warn' — they SURFACE patterns, not auto-deny.
 *     Users can escalate via policy if they want anomalies to block.
 *   - Quantile estimates use the P²-style approximation (no sample retention required).
 */

export const BEHAVIORAL_BASELINE_SCHEMA_VERSION = 1 as const;

export interface BaselineRecipientEntry {
  address: string;
  count: number;
  lastSeenAt: string;
  totalSolLamports: number;
}

export interface BaselineAmountStats {
  count: number;
  sumLamports: number;
  /** Approximate p50 / p95 / p99 of historical amounts in lamports (1e9 SOL units). */
  p50: number;
  p95: number;
  p99: number;
  /** Largest historical amount in lamports. */
  max: number;
}

export interface BehavioralBaseline {
  schemaVersion: typeof BEHAVIORAL_BASELINE_SCHEMA_VERSION;
  walletAddress: string;
  cluster: string;
  createdAt: string;
  updatedAt: string;
  totalApprovals: number;
  decisionTally: {
    approved: number;
    denied: number;
    needsInput: number;
  };
  actionTypeCounts: Record<string, number>;
  protocolCounts: Record<string, number>;
  recipients: BaselineRecipientEntry[];
  amountStatsByToken: Record<string, BaselineAmountStats>;
}

export interface BaselineSignal {
  id: string;
  label: string;
  value: string;
  severity: 'info' | 'warn' | 'block';
  kind: 'new_recipient' | 'anomalous_amount' | 'new_protocol' | 'new_action_type' | 'first_use';
  detail?: Record<string, unknown>;
}

export interface BaselinePlanInput {
  actionType?: string;
  connectorId?: string;
  recipient?: string;
  amountLamports?: number;
  amountTokenKey?: string;
}

export interface BaselineCompletion {
  decision: 'approve' | 'deny' | 'needs_input';
  approvedAt: string;
  actionType?: string;
  connectorId?: string;
  recipient?: string;
  amountLamports?: number;
  amountTokenKey?: string;
}

const MAX_RECIPIENTS_TRACKED = 50;
const FIRST_USE_GRACE_APPROVALS = 3;

export function createEmptyBaseline(walletAddress: string, cluster: string, nowIso?: string): BehavioralBaseline {
  const ts = nowIso ?? new Date().toISOString();
  return {
    schemaVersion: BEHAVIORAL_BASELINE_SCHEMA_VERSION,
    walletAddress,
    cluster,
    createdAt: ts,
    updatedAt: ts,
    totalApprovals: 0,
    decisionTally: { approved: 0, denied: 0, needsInput: 0 },
    actionTypeCounts: {},
    protocolCounts: {},
    recipients: [],
    amountStatsByToken: {},
  };
}

/**
 * Update a baseline with a completed action. Only counts confirmed approvals toward
 * recipient/protocol/amount stats — denied and needs_input completions only update the
 * decision tally.
 */
export function updateBaselineFromCompletion(
  baseline: BehavioralBaseline,
  completion: BaselineCompletion,
): BehavioralBaseline {
  const next: BehavioralBaseline = {
    ...baseline,
    updatedAt: completion.approvedAt,
    decisionTally: { ...baseline.decisionTally },
    actionTypeCounts: { ...baseline.actionTypeCounts },
    protocolCounts: { ...baseline.protocolCounts },
    recipients: baseline.recipients.map((entry) => ({ ...entry })),
    amountStatsByToken: { ...baseline.amountStatsByToken },
  };
  if (completion.decision === 'approve') next.decisionTally.approved += 1;
  if (completion.decision === 'deny') next.decisionTally.denied += 1;
  if (completion.decision === 'needs_input') next.decisionTally.needsInput += 1;

  if (completion.decision !== 'approve') return next;

  next.totalApprovals += 1;

  if (completion.actionType) {
    next.actionTypeCounts[completion.actionType] = (next.actionTypeCounts[completion.actionType] ?? 0) + 1;
  }
  if (completion.connectorId) {
    next.protocolCounts[completion.connectorId] = (next.protocolCounts[completion.connectorId] ?? 0) + 1;
  }
  if (completion.recipient) {
    const existing = next.recipients.find((entry) => entry.address === completion.recipient);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = completion.approvedAt;
      if (typeof completion.amountLamports === 'number') {
        existing.totalSolLamports += completion.amountLamports;
      }
    } else {
      next.recipients.push({
        address: completion.recipient,
        count: 1,
        lastSeenAt: completion.approvedAt,
        totalSolLamports: typeof completion.amountLamports === 'number' ? completion.amountLamports : 0,
      });
    }
    next.recipients.sort((a, b) => b.count - a.count || (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
    if (next.recipients.length > MAX_RECIPIENTS_TRACKED) {
      next.recipients = next.recipients.slice(0, MAX_RECIPIENTS_TRACKED);
    }
  }

  if (completion.amountTokenKey && typeof completion.amountLamports === 'number') {
    const prev = next.amountStatsByToken[completion.amountTokenKey];
    next.amountStatsByToken[completion.amountTokenKey] = updateAmountStats(prev, completion.amountLamports);
  }

  return next;
}

function updateAmountStats(prev: BaselineAmountStats | undefined, amount: number): BaselineAmountStats {
  if (!prev) {
    return {
      count: 1,
      sumLamports: amount,
      p50: amount,
      p95: amount,
      p99: amount,
      max: amount,
    };
  }
  const count = prev.count + 1;
  const sumLamports = prev.sumLamports + amount;
  // P²-style EWMA approximation. The marker increment shrinks as the sample grows so
  // early data has more influence and the curve smooths out with history.
  const p50 = quantileBlend(prev.p50, amount, 0.5, count);
  const p95 = quantileBlend(prev.p95, amount, 0.95, count);
  const p99 = quantileBlend(prev.p99, amount, 0.99, count);
  return {
    count,
    sumLamports,
    p50,
    p95,
    p99,
    max: Math.max(prev.max, amount),
  };
}

function quantileBlend(prevQuantile: number, newSample: number, percentile: number, count: number): number {
  // Increment towards the new sample weighted by where the sample sits vs. the prev
  // quantile and how rare the percentile is. The 1/count factor decays influence over
  // time, matching the intuition that with more history the quantile should be stable.
  const direction = newSample > prevQuantile ? 1 : newSample < prevQuantile ? -1 : 0;
  const aggressiveness = direction === 1 ? percentile : 1 - percentile;
  const step = (newSample - prevQuantile) * (aggressiveness / Math.max(2, count));
  return prevQuantile + step;
}

/**
 * Evaluate a plan against the baseline. Returns one signal per detected anomaly.
 *
 * Default severity is 'warn'. The browser caller surfaces these as AgentEvidenceFacts;
 * the agent's reviewer can factor them into the approve/deny call (an anomaly does not
 * itself block). Users wanting hard blocks should add a policy.
 */
export function evaluateBaselineSignals(baseline: BehavioralBaseline, plan: BaselinePlanInput): BaselineSignal[] {
  const signals: BaselineSignal[] = [];
  const isFirstUse = baseline.totalApprovals < FIRST_USE_GRACE_APPROVALS;

  if (isFirstUse) {
    signals.push({
      id: 'baseline.first_use',
      label: 'No behavioural baseline yet',
      value: `Only ${baseline.totalApprovals} prior approval(s); anomaly checks are still calibrating.`,
      severity: 'info',
      kind: 'first_use',
      detail: { totalApprovals: baseline.totalApprovals },
    });
    return signals;
  }

  if (plan.recipient) {
    const known = baseline.recipients.find((entry) => entry.address === plan.recipient);
    if (!known) {
      signals.push({
        id: 'baseline.new_recipient',
        label: 'New recipient',
        value: `Wallet has never approved a transfer to ${plan.recipient} in ${baseline.totalApprovals} prior approval(s).`,
        severity: 'warn',
        kind: 'new_recipient',
        detail: { recipient: plan.recipient, knownRecipients: baseline.recipients.length },
      });
    }
  }

  if (plan.connectorId) {
    const prior = baseline.protocolCounts[plan.connectorId] ?? 0;
    if (prior === 0) {
      signals.push({
        id: 'baseline.new_protocol',
        label: 'New protocol',
        value: `Wallet has never used "${plan.connectorId}" in prior approvals.`,
        severity: 'warn',
        kind: 'new_protocol',
        detail: { connectorId: plan.connectorId },
      });
    }
  }

  if (plan.actionType) {
    const prior = baseline.actionTypeCounts[plan.actionType] ?? 0;
    if (prior === 0) {
      signals.push({
        id: 'baseline.new_action_type',
        label: 'New action type',
        value: `Wallet has never approved a "${plan.actionType}" action before.`,
        severity: 'warn',
        kind: 'new_action_type',
        detail: { actionType: plan.actionType },
      });
    }
  }

  if (plan.amountTokenKey && typeof plan.amountLamports === 'number') {
    const stats = baseline.amountStatsByToken[plan.amountTokenKey];
    if (stats && stats.count >= FIRST_USE_GRACE_APPROVALS) {
      if (plan.amountLamports > stats.p99) {
        signals.push({
          id: 'baseline.anomalous_amount_p99',
          label: 'Amount above p99 of history',
          value: `${plan.amountLamports} > p99 (${Math.round(stats.p99)}) for ${plan.amountTokenKey}.`,
          severity: 'warn',
          kind: 'anomalous_amount',
          detail: { tokenKey: plan.amountTokenKey, amountLamports: plan.amountLamports, p99: stats.p99, max: stats.max },
        });
      } else if (plan.amountLamports > stats.p95) {
        signals.push({
          id: 'baseline.anomalous_amount_p95',
          label: 'Amount above p95 of history',
          value: `${plan.amountLamports} > p95 (${Math.round(stats.p95)}) for ${plan.amountTokenKey}.`,
          severity: 'info',
          kind: 'anomalous_amount',
          detail: { tokenKey: plan.amountTokenKey, amountLamports: plan.amountLamports, p95: stats.p95 },
        });
      }
    }
  }

  return signals;
}

/**
 * Convenience: pick the recipient address out of a plan's parameters. Recognizes the
 * common parameter names across first-class adapters.
 */
export function extractRecipientFromParameters(parameters: Record<string, string> | undefined): string | undefined {
  if (!parameters) return undefined;
  const keys = ['recipient', 'recipientAddress', 'to', 'toAddress', 'destination', 'destinationAddress'];
  for (const key of keys) {
    const value = parameters[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Pick out a (tokenKey, amountLamports) tuple from a plan's parameters. Recognizes
 * the common parameter names. tokenKey is the SOL mint placeholder ('SOL') or the
 * SPL mint string.
 */
export function extractAmountFromParameters(
  parameters: Record<string, string> | undefined,
  actionType: string | undefined,
): { tokenKey: string; amountLamports: number } | undefined {
  if (!parameters) return undefined;
  const solCandidates = [parameters.solAmount, parameters.amountSol];
  for (const raw of solCandidates) {
    if (typeof raw === 'string' && raw.trim()) {
      const num = Number(raw.trim());
      if (Number.isFinite(num) && num >= 0) return { tokenKey: 'SOL', amountLamports: Math.round(num * 1e9) };
    }
  }
  const amount = parameters.amount;
  const mint = parameters.mint ?? parameters.token ?? parameters.outputMint;
  if (typeof amount === 'string' && amount.trim()) {
    const num = Number(amount.trim());
    if (Number.isFinite(num) && num >= 0) {
      const tokenKey = (typeof mint === 'string' && mint.trim()) ? mint.trim() : (actionType ?? 'amount');
      return { tokenKey, amountLamports: Math.round(num * 1e9) };
    }
  }
  return undefined;
}

/**
 * Stable storage key for a baseline. Browser-demo uses this to persist per-wallet baselines.
 */
export function baselineStorageKey(walletAddress: string, cluster: string): string {
  return `${cluster}|${walletAddress}`;
}
