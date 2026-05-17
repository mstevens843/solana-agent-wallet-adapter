/**
 * Pure helpers for evaluating an extracted atom against a resolved fact.
 *
 * The browser-demo previously hand-rolled the threshold checks and finding
 * formatting inline (see `apps/browser-demo/src/main.ts:22260-22420`). Now that
 * the atom layer carries the user's gate as structured data, the evaluator is
 * a one-shot pure function: `evaluateAtom(atom, resolvedFact)`.
 *
 * Same module works in browser-demo, mcp-server, and any future surface so
 * the policy-gate findings are byte-identical across them.
 */

import type {
  AccountWritabilityCountAtom,
  AgentAtom,
  AgentAtomOperator,
  ExternalEventAtom,
  ExternalIdentityAtom,
  ExternalPriceAtom,
  ExternalStateAtom,
  InstructionCountAtom,
  MarketRegimeAtom,
  MintDecimalsAtom,
  NetworkCongestionAtom,
  NetworkMetricAtom,
  PriceAtom,
  RecipientKnownAtom,
  RelativeAmountAtom,
  RentExemptRequiredAtom,
  RequiredSignaturesAtom,
  TimeFactAtom,
  TokenAgeAtom,
  TokenAuditAtom,
  TokenBalanceAtom,
  TokenHeldDurationAtom,
  TokenSupplyAtom,
  TradfiPriceAtom,
  TxFeeAtom,
  TxGateAtom,
  WalletAgeOnchainAtom,
  WalletBalanceAtom,
} from './agentAtoms.js';
import type { AgentEvidenceFactTone } from './agentEvidence.js';

/* -------------------------------------------------------------------------- */
/* Operator semantics                                                         */
/* -------------------------------------------------------------------------- */

/** Apply an operator to a numeric fact and threshold. */
export function compareNumeric(op: AgentAtomOperator, fact: number, threshold: number): boolean {
  switch (op) {
    case 'gt':  return fact > threshold;
    case 'gte': return fact >= threshold;
    case 'lt':  return fact < threshold;
    case 'lte': return fact <= threshold;
    case 'eq':  return fact === threshold;
  }
}

/* -------------------------------------------------------------------------- */
/* Resolved fact shape (one per atom)                                         */
/* -------------------------------------------------------------------------- */

export interface ResolvedFactValue {
  /** Numeric value when applicable (price in USD, dominance pct, age in seconds, index value, etc.). */
  numeric?: number;
  /** Boolean value when applicable (mint authority disabled, freeze authority disabled, etc.). */
  boolean?: boolean;
  /** Free-form text when the fact is a label (classification name, error reason). */
  text?: string;
  /** Provider that resolved this fact (e.g. 'alternative_me', 'jupiter', 'web'). */
  source: string;
  /** Optional ISO timestamp of when the fact was retrieved. */
  checkedAt?: string;
}

/* -------------------------------------------------------------------------- */
/* Per-atom evaluation                                                        */
/* -------------------------------------------------------------------------- */

export interface AtomEvaluation {
  atomId: string;
  /** True when the user's rule is satisfied. False when violated. Undefined when undetermined. */
  pass?: boolean;
  /** Formatted finding for UI display: {label, value, tone}. */
  finding: {
    label: string;
    value: string;
    tone: AgentEvidenceFactTone;
  };
  /** True when the underlying fact was missing/error; the gate is treated as pass=undefined. */
  unresolved?: boolean;
}

/** Format a numeric value in USD with sensible compaction. */
export function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

/** Format a seconds duration as a short label (e.g. "24h", "7d", "12.3 months"). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(1)}h`;
  if (seconds < 30 * 86_400) return `${(seconds / 86_400).toFixed(1)}d`;
  return `${(seconds / (30 * 86_400)).toFixed(1)} months`;
}

function toneFromPass(pass: boolean | undefined): AgentEvidenceFactTone {
  if (pass === true) return 'good';
  if (pass === false) return 'fail';
  return 'warn';
}

function unresolvedEvaluation(atom: AgentAtom, label: string): AtomEvaluation {
  return {
    atomId: atom.id,
    pass: undefined,
    unresolved: true,
    finding: { label, value: 'unknown', tone: 'warn' },
  };
}

/* -------- per-atom evaluators --------------------------------------------- */

function evaluatePrice(atom: PriceAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = `${atom.subject} price`;
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${formatUsdCompact(fact.numeric)} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateMarketRegime(atom: MarketRegimeAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = marketRegimeLabel(atom);
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  const display = atom.subject === 'total_market_cap'
    ? formatUsdCompact(fact.numeric)
    : atom.subject === 'fear_and_greed'
      ? `${fact.numeric}${fact.text ? ` (${fact.text})` : ''}`
      : `${fact.numeric.toFixed(2)}%`;
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${display} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function marketRegimeLabel(atom: MarketRegimeAtom): string {
  switch (atom.subject) {
    case 'fear_and_greed':    return 'BTC Fear & Greed';
    case 'btc_dominance':     return 'BTC dominance';
    case 'eth_dominance':     return 'ETH dominance';
    case 'total_market_cap':  return 'Total crypto market cap';
  }
}

function evaluateTokenAudit(atom: TokenAuditAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = tokenAuditLabel(atom);
  if (!fact || fact.boolean === undefined) return unresolvedEvaluation(atom, label);
  const pass = fact.boolean === atom.expected;
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${fact.boolean ? 'yes' : 'no'} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function tokenAuditLabel(atom: TokenAuditAtom): string {
  switch (atom.field) {
    case 'mint_authority_disabled':   return `${atom.subject ?? 'Token'} mint authority`;
    case 'freeze_authority_disabled': return `${atom.subject ?? 'Token'} freeze authority`;
    case 'is_verified':                return `${atom.subject ?? 'Token'} verified`;
  }
}

function evaluateTokenAge(atom: TokenAgeAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = `${atom.subject ?? 'Token'} age`;
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${formatDuration(fact.numeric)} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateTxGate(atom: TxGateAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = `Tx gate: ${atom.rule.replace(/_/g, ' ')}`;
  if (!fact || fact.boolean === undefined) return unresolvedEvaluation(atom, label);
  const pass = fact.boolean === true;
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${pass ? 'pass' : 'fail'}${fact.text ? ` — ${fact.text}` : ''}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateExternalPrice(atom: ExternalPriceAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = atom.subject;
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${formatUsdCompact(fact.numeric)} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function externalStateLabel(atom: ExternalStateAtom): string {
  const kindLabels: Record<ExternalStateAtom['kind'], string> = {
    network_outage: 'network outage',
    exploit: 'exploit',
    hack: 'hack',
    incident: 'incident',
    paused_withdrawals: 'paused withdrawals',
    service_outage: 'service outage',
  };
  return `${atom.subject} ${kindLabels[atom.kind]}`;
}

function evaluateExternalState(atom: ExternalStateAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = externalStateLabel(atom);
  if (!fact || fact.boolean === undefined) return unresolvedEvaluation(atom, label);
  const pass = fact.boolean === atom.expected;
  const verb = fact.boolean ? 'present' : 'none';
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${verb}${fact.text ? ` — ${fact.text}` : ''} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function externalEventLabel(atom: ExternalEventAtom): string {
  const kindLabels: Record<ExternalEventAtom['kind'], string> = {
    scheduled_upgrade: 'scheduled upgrade',
    governance_vote: 'governance vote',
    mainnet_fork: 'mainnet fork',
    release: 'release',
    announcement: 'announcement',
  };
  const windowSuffix = atom.window === 'within' && atom.windowSeconds
    ? ` (within ${formatDuration(atom.windowSeconds)})`
    : atom.window === 'past' && atom.windowSeconds
      ? ` (last ${formatDuration(atom.windowSeconds)})`
      : '';
  return `${atom.subject} ${kindLabels[atom.kind]}${windowSuffix}`;
}

function evaluateExternalEvent(atom: ExternalEventAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = externalEventLabel(atom);
  if (!fact || fact.boolean === undefined) return unresolvedEvaluation(atom, label);
  const pass = fact.boolean === atom.expected;
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${fact.boolean ? 'yes' : 'no'}${fact.text ? ` — ${fact.text}` : ''} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function externalIdentityLabel(atom: ExternalIdentityAtom): string {
  const kindLabels: Record<ExternalIdentityAtom['kind'], string> = {
    sanctions_list: 'on sanctions list',
    sec_action: 'SEC enforcement',
    kyc_status: 'KYC status',
  };
  return `${atom.subject} ${kindLabels[atom.kind]}`;
}

function evaluateExternalIdentity(atom: ExternalIdentityAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = externalIdentityLabel(atom);
  if (!fact || fact.boolean === undefined) return unresolvedEvaluation(atom, label);
  const pass = fact.boolean === atom.expected;
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${fact.boolean ? 'yes' : 'no'}${fact.text ? ` — ${fact.text}` : ''} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateTradfiPrice(atom: TradfiPriceAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = `${atom.subject} price`;
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${formatUsdCompact(fact.numeric)} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function timeFactLabel(atom: TimeFactAtom): string {
  switch (atom.kind) {
    case 'is_business_day':  return 'Business day';
    case 'is_us_holiday':    return 'US holiday';
    case 'is_market_open':   return 'Market open';
    case 'day_of_week':      return 'Day of week';
  }
}

function evaluateTimeFact(atom: TimeFactAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = timeFactLabel(atom);
  if (!fact || fact.boolean === undefined) return unresolvedEvaluation(atom, label);
  const pass = fact.boolean === atom.expected;
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${fact.boolean ? 'yes' : 'no'}${fact.text ? ` (${fact.text})` : ''} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function networkMetricLabel(atom: NetworkMetricAtom): string {
  switch (atom.metric) {
    case 'tps':                  return 'Solana TPS';
    case 'slot_height':          return 'Solana slot height';
    case 'validator_jailed':     return atom.subject ? `Validator ${atom.subject.slice(0, 8)}… jailed` : 'Validator jailed';
    case 'epoch_progress_pct':   return 'Epoch progress';
  }
}

function evaluateNetworkMetric(atom: NetworkMetricAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = networkMetricLabel(atom);
  if (!fact) return unresolvedEvaluation(atom, label);
  // Boolean metrics (validator_jailed) compare against the user's implicit "is this true?"
  if (atom.metric === 'validator_jailed') {
    if (fact.boolean === undefined) return unresolvedEvaluation(atom, label);
    // The atom carries no explicit `expected`; default user intent is "must NOT be jailed",
    // so pass = !fact.boolean.
    const pass = fact.boolean === false;
    return {
      atomId: atom.id,
      pass,
      finding: { label, value: `${fact.boolean ? 'jailed' : 'active'} — ${fact.source}`, tone: toneFromPass(pass) },
    };
  }
  // Numeric metrics need both an operator and a value on the atom.
  if (fact.numeric === undefined || atom.op === undefined || atom.value === undefined) {
    return unresolvedEvaluation(atom, label);
  }
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${atom.metric === 'epoch_progress_pct' ? `${fact.numeric.toFixed(1)}%` : fact.numeric.toLocaleString()} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Tier 1: balance / fee evaluators                                            */
/* -------------------------------------------------------------------------- */

function formatNumeric(value: number, unit: string): string {
  if (unit === 'USD') return formatUsdCompact(value);
  if (unit === 'SOL') return `${value.toFixed(value < 1 ? 4 : 2)} SOL`;
  if (unit === 'lamports') return `${value.toLocaleString()} lamports`;
  if (unit === 'microlamports') return `${value.toLocaleString()} μLamports`;
  if (unit === 'tokens') return `${value.toLocaleString()} tokens`;
  return `${value}`;
}

function evaluateWalletBalance(atom: WalletBalanceAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = 'SOL balance';
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${formatNumeric(fact.numeric, atom.unit)} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateTokenBalance(atom: TokenBalanceAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = `${atom.subject} balance`;
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${formatNumeric(fact.numeric, atom.unit)} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateRelativeAmount(atom: RelativeAmountAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = `Trade ${(atom.fraction * 100).toFixed(0)}% of ${atom.basis === 'sol_balance' ? 'SOL' : atom.basis}`;
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  // fact.numeric is the ACTUAL fraction (computed by resolver as draft / basis).
  const pass = compareNumeric(atom.op, fact.numeric, atom.fraction);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `actual ${(fact.numeric * 100).toFixed(2)}% — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateTxFee(atom: TxFeeAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = 'Transaction fee';
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${formatNumeric(fact.numeric, atom.unit)} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateNetworkCongestion(atom: NetworkCongestionAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = 'Network congestion';
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${formatNumeric(fact.numeric, 'microlamports')} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Tier 2: token / wallet sanity evaluators                                    */
/* -------------------------------------------------------------------------- */

function evaluateTokenSupply(atom: TokenSupplyAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = `${atom.subject ?? 'Token'} supply`;
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${fact.numeric.toLocaleString()} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateMintDecimals(atom: MintDecimalsAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = `${atom.subject ?? 'Mint'} decimals`;
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${fact.numeric} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateWalletAge(atom: WalletAgeOnchainAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = 'Wallet age (on-chain)';
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${formatDuration(fact.numeric)} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateRecipientKnown(atom: RecipientKnownAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = atom.subject ? `Recipient ${atom.subject.slice(0, 8)}… history` : 'Recipient history';
  if (!fact || fact.boolean === undefined) return unresolvedEvaluation(atom, label);
  const pass = fact.boolean === atom.expected;
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${fact.boolean ? 'known' : 'new (no prior sends)'} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

function evaluateTokenHeldDuration(atom: TokenHeldDurationAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = `${atom.subject ?? 'Token'} held duration`;
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${formatDuration(fact.numeric)} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Tier 3: tx-inspect evaluators                                               */
/* -------------------------------------------------------------------------- */

function evaluateRequiredSignatures(atom: RequiredSignaturesAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = 'Required signatures';
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: { label, value: `${fact.numeric} — ${fact.source}`, tone: toneFromPass(pass) },
  };
}

function evaluateInstructionCount(atom: InstructionCountAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = 'Instruction count';
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: { label, value: `${fact.numeric} — ${fact.source}`, tone: toneFromPass(pass) },
  };
}

function evaluateAccountWritability(atom: AccountWritabilityCountAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = 'Writable accounts';
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: { label, value: `${fact.numeric} — ${fact.source}`, tone: toneFromPass(pass) },
  };
}

function evaluateRentExempt(atom: RentExemptRequiredAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  const label = 'Rent required';
  if (!fact || fact.numeric === undefined) return unresolvedEvaluation(atom, label);
  const pass = compareNumeric(atom.op, fact.numeric, atom.value);
  return {
    atomId: atom.id,
    pass,
    finding: {
      label,
      value: `${formatNumeric(fact.numeric, atom.unit)} — ${fact.source}`,
      tone: toneFromPass(pass),
    },
  };
}

/** Dispatcher: pick the right evaluator for the atom's type. */
export function evaluateAtom(atom: AgentAtom, fact: ResolvedFactValue | undefined): AtomEvaluation {
  switch (atom.type) {
    case 'price':                      return evaluatePrice(atom, fact);
    case 'market_regime':              return evaluateMarketRegime(atom, fact);
    case 'token_audit':                return evaluateTokenAudit(atom, fact);
    case 'token_age':                  return evaluateTokenAge(atom, fact);
    case 'tx_gate':                    return evaluateTxGate(atom, fact);
    case 'external_price':             return evaluateExternalPrice(atom, fact);
    case 'external_state':             return evaluateExternalState(atom, fact);
    case 'external_event':             return evaluateExternalEvent(atom, fact);
    case 'external_identity':          return evaluateExternalIdentity(atom, fact);
    case 'tradfi_price':               return evaluateTradfiPrice(atom, fact);
    case 'time_fact':                  return evaluateTimeFact(atom, fact);
    case 'network_metric':             return evaluateNetworkMetric(atom, fact);
    case 'wallet_balance':             return evaluateWalletBalance(atom, fact);
    case 'token_balance':              return evaluateTokenBalance(atom, fact);
    case 'relative_amount':            return evaluateRelativeAmount(atom, fact);
    case 'tx_fee':                     return evaluateTxFee(atom, fact);
    case 'network_congestion':         return evaluateNetworkCongestion(atom, fact);
    case 'token_supply':               return evaluateTokenSupply(atom, fact);
    case 'mint_decimals':              return evaluateMintDecimals(atom, fact);
    case 'wallet_age_onchain':         return evaluateWalletAge(atom, fact);
    case 'recipient_known':            return evaluateRecipientKnown(atom, fact);
    case 'token_held_duration':        return evaluateTokenHeldDuration(atom, fact);
    case 'required_signatures':        return evaluateRequiredSignatures(atom, fact);
    case 'instruction_count':          return evaluateInstructionCount(atom, fact);
    case 'account_writability_count':  return evaluateAccountWritability(atom, fact);
    case 'rent_exempt_required':       return evaluateRentExempt(atom, fact);
    case 'protocol_health':
      return unresolvedEvaluation(atom, `${atom.subject} ${atom.metric}`);
  }
}

/** Evaluate a batch of atoms against a map of resolved facts keyed by atom id. */
export function evaluateAtoms(
  atoms: ReadonlyArray<AgentAtom>,
  facts: Readonly<Record<string, ResolvedFactValue | undefined>>,
): AtomEvaluation[] {
  return atoms.map((atom) => evaluateAtom(atom, facts[atom.id]));
}

/* -------------------------------------------------------------------------- */
/* Backwards-compat threshold parsers (used by browser-demo's inline path)    */
/* -------------------------------------------------------------------------- */

/** Parse a "fear & greed above N" threshold from free text. Returns the threshold value or undefined. */
export function parseFearGreedThreshold(text: string): number | undefined {
  if (!text) return undefined;
  const match = text.match(/fear\s*(?:&|and)\s*greed[^.\n]*?(?:above|over|greater than|>=?|>)\s*(\d{1,3})/i);
  if (!match || !match[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** Parse a "BTC dominance above N" threshold from free text. */
export function parseDominanceThreshold(text: string): number | undefined {
  if (!text) return undefined;
  const match = text.match(/(?:btc|bitcoin)\s*dominance[^.\n]*?(?:above|over|greater than|>=?|>)\s*(\d{1,3}(?:\.\d+)?)/i);
  if (!match || !match[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** Parse an "age above N <unit>" threshold and return the seconds equivalent. */
export function parseAgeThresholdSeconds(value: string, unit: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  const u = unit.toLowerCase();
  if (u.startsWith('mo')) return n * 30 * 86_400;
  if (u.startsWith('w'))  return n * 7 * 86_400;
  if (u.startsWith('d'))  return n * 86_400;
  if (u.startsWith('h'))  return n * 3_600;
  if (u.startsWith('m'))  return n * 60;
  if (u.startsWith('s'))  return n;
  return n;
}
