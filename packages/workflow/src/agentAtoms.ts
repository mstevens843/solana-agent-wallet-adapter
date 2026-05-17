/**
 * Atom-level decomposition of a reviewer NOTE/instruction.
 *
 * An "atom" is one user-stated claim that the reviewer needs to verify
 * (e.g. "SOL > $80", "mint authority disabled", "helium plan < $20").
 * Each atom is a structured fact-request that the capability registry maps to
 * a provider chain; the reviewer LLM applies user rules over the resolved
 * atoms instead of re-discovering facts.
 *
 * The extractor is deliberately conservative: it recognizes the documented
 * gate vocabulary (token security, token age, market regime, price thresholds,
 * tx gates, off-chain price lookups). Anything it can't classify falls through
 * to the existing reviewer flow.
 */

export type AgentAtomType =
  | 'price'
  | 'market_regime'
  | 'token_audit'
  | 'token_age'
  | 'tx_gate'
  | 'external_price'
  | 'protocol_health'
  | 'external_state'
  | 'external_event'
  | 'external_identity'
  | 'tradfi_price'
  | 'time_fact'
  | 'network_metric'
  | 'wallet_balance'
  | 'token_balance'
  | 'relative_amount'
  | 'tx_fee'
  | 'network_congestion'
  | 'token_supply'
  | 'mint_decimals'
  | 'wallet_age_onchain'
  | 'recipient_known'
  | 'token_held_duration'
  | 'required_signatures'
  | 'instruction_count'
  | 'account_writability_count'
  | 'rent_exempt_required';

export type AgentAtomOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

export type MarketRegimeMetric =
  | 'fear_and_greed'
  | 'btc_dominance'
  | 'eth_dominance'
  | 'total_market_cap';

export type TokenAuditField =
  | 'mint_authority_disabled'
  | 'freeze_authority_disabled'
  | 'is_verified';

export type TxGateRule =
  | 'only_requested_swap'
  | 'no_extra_transfers'
  | 'no_unknown_recipients'
  | 'no_unrelated_instructions';

export type ExternalStateKind =
  | 'network_outage'
  | 'exploit'
  | 'hack'
  | 'incident'
  | 'paused_withdrawals'
  | 'service_outage';

export type ExternalEventKind =
  | 'scheduled_upgrade'
  | 'governance_vote'
  | 'mainnet_fork'
  | 'release'
  | 'announcement';

export type ExternalIdentityKind =
  | 'sanctions_list'
  | 'sec_action'
  | 'kyc_status';

export type TimeFactKind =
  | 'is_business_day'
  | 'is_us_holiday'
  | 'is_market_open'
  | 'day_of_week';

export type NetworkMetric =
  | 'tps'
  | 'slot_height'
  | 'validator_jailed'
  | 'epoch_progress_pct';

export interface AgentAtomBase {
  /** Stable id derived from type+subject+op+value. Same NOTE → same ids. */
  id: string;
  type: AgentAtomType;
  /** The substring of the source text that produced this atom (for debugging/UX). */
  rawText: string;
}

export interface PriceAtom extends AgentAtomBase {
  type: 'price';
  /** Token symbol ('SOL', 'BTC', 'ETH', 'USDC', …) or mint address. */
  subject: string;
  op: AgentAtomOperator;
  value: number;
  unit: 'USD';
}

export interface MarketRegimeAtom extends AgentAtomBase {
  type: 'market_regime';
  subject: MarketRegimeMetric;
  op: AgentAtomOperator;
  value: number;
}

export interface TokenAuditAtom extends AgentAtomBase {
  type: 'token_audit';
  /** Mint address when explicitly named; undefined means "every token in this swap". */
  subject?: string;
  field: TokenAuditField;
  expected: boolean;
}

export interface TokenAgeAtom extends AgentAtomBase {
  type: 'token_age';
  subject?: string;
  op: AgentAtomOperator;
  /** Threshold in seconds. */
  value: number;
}

export interface TxGateAtom extends AgentAtomBase {
  type: 'tx_gate';
  rule: TxGateRule;
}

export interface ExternalPriceAtom extends AgentAtomBase {
  type: 'external_price';
  /** Natural-language description of the off-chain item being priced. */
  subject: string;
  op: AgentAtomOperator;
  value: number;
  unit: string;
}

export interface ProtocolHealthAtom extends AgentAtomBase {
  type: 'protocol_health';
  subject: string;
  metric: string;
  op?: AgentAtomOperator;
  value?: number;
}

export interface ExternalStateAtom extends AgentAtomBase {
  type: 'external_state';
  /** What the user is asking the state about (e.g. 'solana network', 'jupiter', 'magic eden'). */
  subject: string;
  kind: ExternalStateKind;
  /** What the user expects: true = "in this state" (e.g. outage exists), false = "not in this state". */
  expected: boolean;
}

export interface ExternalEventAtom extends AgentAtomBase {
  type: 'external_event';
  subject: string;
  kind: ExternalEventKind;
  /** When the user cares about an upcoming window: 'within' (next N seconds) or 'past' (last N seconds). */
  window?: 'within' | 'past';
  /** Window size in seconds when `window` is set. */
  windowSeconds?: number;
  /** What the user expects to find in the window: true = "yes, scheduled/happened", false = "nothing scheduled". */
  expected: boolean;
}

export interface ExternalIdentityAtom extends AgentAtomBase {
  type: 'external_identity';
  /** The address / entity being checked (wallet pubkey, issuer name, etc.). */
  subject: string;
  kind: ExternalIdentityKind;
  /** What the user expects: false = "not on the list / no action", true = "is on the list / has action". */
  expected: boolean;
}

export interface TradfiPriceAtom extends AgentAtomBase {
  type: 'tradfi_price';
  /** Ticker or quote symbol (e.g. 'SPY', 'GLD', 'EURUSD', 'GOLD'). */
  subject: string;
  op: AgentAtomOperator;
  value: number;
  unit: 'USD' | 'EUR' | 'GBP' | string;
}

export interface TimeFactAtom extends AgentAtomBase {
  type: 'time_fact';
  kind: TimeFactKind;
  /** What the user expects: true = "yes, today is a business day / market is open". */
  expected: boolean;
  /** Optional time-zone hint, e.g. 'America/New_York'. Defaults to UTC. */
  timezone?: string;
}

export interface NetworkMetricAtom extends AgentAtomBase {
  type: 'network_metric';
  metric: NetworkMetric;
  /** When the metric is comparable (TPS, slot, epoch_progress): the operator + value. */
  op?: AgentAtomOperator;
  value?: number;
  /** For validator_jailed: which validator vote-account / identity. */
  subject?: string;
}

/* -------------------------------------------------------------------------- */
/* Tier 1: balance / fee atoms                                                */
/* -------------------------------------------------------------------------- */

export interface WalletBalanceAtom extends AgentAtomBase {
  type: 'wallet_balance';
  /** Asset whose balance the user is gating on. Today: 'SOL'. */
  subject: 'SOL';
  op: AgentAtomOperator;
  /** Threshold value in `unit` (SOL, USD, or lamports). */
  value: number;
  unit: 'SOL' | 'USD' | 'lamports';
}

export interface TokenBalanceAtom extends AgentAtomBase {
  type: 'token_balance';
  /** Token symbol ('USDC', 'JUP', …) or mint address. */
  subject: string;
  op: AgentAtomOperator;
  /** Threshold value in `unit`. */
  value: number;
  unit: 'tokens' | 'USD';
}

export interface RelativeAmountAtom extends AgentAtomBase {
  type: 'relative_amount';
  /** The portion of wallet the user is gating on (e.g. 0.10 = 10%). */
  fraction: number;
  op: AgentAtomOperator;
  /** Source the relative amount is computed against: 'wallet' = total USD-valued holdings,
   *  'sol_balance' = SOL balance only, 'token_balance' = input-token balance. */
  basis: 'wallet' | 'sol_balance' | 'token_balance';
}

export interface TxFeeAtom extends AgentAtomBase {
  type: 'tx_fee';
  op: AgentAtomOperator;
  value: number;
  unit: 'USD' | 'SOL' | 'lamports';
}

export interface NetworkCongestionAtom extends AgentAtomBase {
  type: 'network_congestion';
  /** Threshold on the median prioritization fee in microlamports. */
  op: AgentAtomOperator;
  value: number;
  unit: 'microlamports';
}

/* -------------------------------------------------------------------------- */
/* Tier 2: token / wallet sanity atoms                                        */
/* -------------------------------------------------------------------------- */

export interface TokenSupplyAtom extends AgentAtomBase {
  type: 'token_supply';
  /** Mint address (or symbol resolvable to a mint). */
  subject?: string;
  op: AgentAtomOperator;
  /** Threshold on circulating supply (in whole tokens, not raw amount). */
  value: number;
}

export interface MintDecimalsAtom extends AgentAtomBase {
  type: 'mint_decimals';
  subject?: string;
  op: AgentAtomOperator;
  /** Decimals threshold (0-9 typical). */
  value: number;
}

export interface WalletAgeOnchainAtom extends AgentAtomBase {
  type: 'wallet_age_onchain';
  op: AgentAtomOperator;
  /** Age threshold in seconds. */
  value: number;
}

export interface RecipientKnownAtom extends AgentAtomBase {
  type: 'recipient_known';
  /** Recipient address being checked (when explicit); falls back to the draft recipient. */
  subject?: string;
  /** What the user expects: true = "has prior history with recipient", false = "never sent". */
  expected: boolean;
}

export interface TokenHeldDurationAtom extends AgentAtomBase {
  type: 'token_held_duration';
  subject?: string;
  op: AgentAtomOperator;
  /** Held-duration threshold in seconds. */
  value: number;
}

/* -------------------------------------------------------------------------- */
/* Tier 3: tx-inspect atoms                                                   */
/* -------------------------------------------------------------------------- */

export interface RequiredSignaturesAtom extends AgentAtomBase {
  type: 'required_signatures';
  op: AgentAtomOperator;
  value: number;
}

export interface InstructionCountAtom extends AgentAtomBase {
  type: 'instruction_count';
  op: AgentAtomOperator;
  value: number;
}

export interface AccountWritabilityCountAtom extends AgentAtomBase {
  type: 'account_writability_count';
  op: AgentAtomOperator;
  value: number;
}

export interface RentExemptRequiredAtom extends AgentAtomBase {
  type: 'rent_exempt_required';
  op: AgentAtomOperator;
  value: number;
  unit: 'lamports' | 'SOL' | 'USD';
}

export type AgentAtom =
  | PriceAtom
  | MarketRegimeAtom
  | TokenAuditAtom
  | TokenAgeAtom
  | TxGateAtom
  | ExternalPriceAtom
  | ProtocolHealthAtom
  | ExternalStateAtom
  | ExternalEventAtom
  | ExternalIdentityAtom
  | TradfiPriceAtom
  | TimeFactAtom
  | NetworkMetricAtom
  | WalletBalanceAtom
  | TokenBalanceAtom
  | RelativeAmountAtom
  | TxFeeAtom
  | NetworkCongestionAtom
  | TokenSupplyAtom
  | MintDecimalsAtom
  | WalletAgeOnchainAtom
  | RecipientKnownAtom
  | TokenHeldDurationAtom
  | RequiredSignaturesAtom
  | InstructionCountAtom
  | AccountWritabilityCountAtom
  | RentExemptRequiredAtom;

export interface ExtractAtomsInput {
  /** Free-form user instruction / NOTE text. */
  text?: string;
  /** Token symbols already known from the draft (e.g. ['SOL','USDC']). Used to disambiguate
   * `$X` thresholds: if the price keyword cleanly binds to a known symbol it becomes a price
   * atom; otherwise it falls through to external_price. */
  knownTokenSymbols?: string[];
}

export interface ExtractAtomsResult {
  atoms: AgentAtom[];
  /** Substring spans that the extractor consumed. Useful for debugging coverage. */
  consumedSpans: Array<{ start: number; end: number }>;
}

/* -------------------------------------------------------------------------- */
/* Operator + unit normalization                                              */
/* -------------------------------------------------------------------------- */

// Word-style aliases use \b boundaries; symbol aliases (>, <, =) are matched without
// boundaries because non-word characters never satisfy \b. Order matters in operatorFromText:
// compound forms (>=, <=) are checked BEFORE their bare counterparts (>, <) so we don't
// mis-classify ">=" as just ">".
const ABOVE_WORD_RE = /\b(above|over|greater than|more than|gte|exceeds?)\b/i;
const BELOW_WORD_RE = /\b(below|under|less than|fewer than|lte)\b/i;
const EQUAL_WORD_RE = /\b(equal to|equals|is)\b/i;

function operatorFromText(snippet: string): AgentAtomOperator | undefined {
  if (/>=|\bgte\b|\bat least\b|\bor more\b/i.test(snippet)) return 'gte';
  if (/<=|\blte\b|\bat most\b|\bor less\b|\bor fewer\b/i.test(snippet)) return 'lte';
  if (ABOVE_WORD_RE.test(snippet) || /(^|[^=<])>(?!=)/.test(snippet)) return 'gt';
  if (BELOW_WORD_RE.test(snippet) || /(^|[^=>])<(?!=)/.test(snippet)) return 'lt';
  if (EQUAL_WORD_RE.test(snippet) || /(^|[^<>!])=(?!=)/.test(snippet)) return 'eq';
  return undefined;
}

function parseAgeSecondsFromUnit(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith('mo')) return value * 30 * 86_400;
  if (u.startsWith('w')) return value * 7 * 86_400;
  if (u.startsWith('d')) return value * 86_400;
  if (u.startsWith('h')) return value * 3_600;
  if (u.startsWith('m')) return value * 60;
  if (u.startsWith('s')) return value;
  return value;
}

/* -------------------------------------------------------------------------- */
/* ID derivation                                                              */
/* -------------------------------------------------------------------------- */

function atomId(parts: ReadonlyArray<string | number | boolean | undefined>): string {
  const slug = parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part) => String(part).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter((part) => part.length > 0)
    .join('.');
  return `atom.${slug}`;
}

/* -------------------------------------------------------------------------- */
/* Per-type extractors                                                        */
/* Each returns atoms it finds and the spans it consumed.                     */
/* -------------------------------------------------------------------------- */

interface ExtractorResult {
  atoms: AgentAtom[];
  spans: Array<{ start: number; end: number }>;
}

/** Token security atoms — "mint authority disabled" / "freeze authority disabled" / "is verified". */
function extractTokenAuditAtoms(text: string): ExtractorResult {
  const atoms: TokenAuditAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const patterns: Array<{ re: RegExp; field: TokenAuditField; expected: boolean }> = [
    { re: /\bmint(?:ing)?\s+authority\s+(disabled|null|revoked|none|removed)\b/gi, field: 'mint_authority_disabled', expected: true },
    { re: /\bfreeze\s+authority\s+(disabled|null|revoked|none|removed)\b/gi, field: 'freeze_authority_disabled', expected: true },
    { re: /\bis\s+verified\b|\bmust be verified\b|\bverified\s+token\b/gi, field: 'is_verified', expected: true },
  ];
  for (const { re, field, expected } of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const rawText = match[0];
      atoms.push({
        id: atomId(['token_audit', field, expected]),
        type: 'token_audit',
        rawText,
        field,
        expected,
      });
      spans.push({ start: match.index, end: match.index + rawText.length });
    }
  }
  return { atoms, spans };
}

/** Token age atoms — "token age above 24h" / "age must be greater than 7 days". */
function extractTokenAgeAtoms(text: string): ExtractorResult {
  const atoms: TokenAgeAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  // Match either "token age (op) N unit" or "age (op) N unit"
  const re = /\b(?:token\s+)?age\s+(?:(?:must|should)\s+be\s+)?(above|over|greater than|more than|>=?|below|under|less than|fewer than|<=?|at least|at most)\s+(\d+(?:\.\d+)?)\s*(months?|month|mo|weeks?|w|days?|d|hours?|h|minutes?|min|m|seconds?|sec|s)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const opText = match[1] ?? '';
    const op = operatorFromText(opText);
    const numericValue = Number(match[2]);
    const unit = match[3] ?? 'd';
    if (!op || !Number.isFinite(numericValue)) continue;
    const seconds = parseAgeSecondsFromUnit(numericValue, unit);
    atoms.push({
      id: atomId(['token_age', op, seconds]),
      type: 'token_age',
      rawText: match[0],
      op,
      value: seconds,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** Market-regime atoms — "BTC Fear & Greed > 20", "BTC dominance < 55", "total market cap above $2T". */
function extractMarketRegimeAtoms(text: string): ExtractorResult {
  const atoms: MarketRegimeAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];

  // Fear & Greed
  const fngRe = /\b(?:btc\s+|bitcoin\s+|crypto\s+)?fear\s*(?:&|and)\s*greed\b[^.\n]{0,80}?(above|over|greater than|more than|>=?|below|under|less than|fewer than|<=?|at least|at most|equal to|equals|=|is)\s*(\d{1,3})/gi;
  let match: RegExpExecArray | null;
  while ((match = fngRe.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const value = Number(match[2]);
    if (!op || !Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['market_regime', 'fear_and_greed', op, value]),
      type: 'market_regime',
      rawText: match[0],
      subject: 'fear_and_greed',
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }

  // BTC / ETH dominance
  const domRe = /\b(btc|bitcoin|eth|ethereum)\s+dominance\b[^.\n]{0,40}?(above|over|greater than|more than|>=?|below|under|less than|<=?|at least|at most|equal to|equals|=|is)\s*(\d{1,3}(?:\.\d+)?)/gi;
  while ((match = domRe.exec(text)) !== null) {
    const tokenWord = (match[1] ?? '').toLowerCase();
    const op = operatorFromText(match[2] ?? '');
    const value = Number(match[3]);
    if (!op || !Number.isFinite(value)) continue;
    const subject: MarketRegimeMetric = tokenWord.startsWith('eth') ? 'eth_dominance' : 'btc_dominance';
    atoms.push({
      id: atomId(['market_regime', subject, op, value]),
      type: 'market_regime',
      rawText: match[0],
      subject,
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }

  // Total market cap
  const tmcRe = /\btotal\s+(?:crypto\s+)?market\s+cap\b[^.\n]{0,40}?(above|over|greater than|>=?|below|under|less than|<=?|at least|at most|equal to|equals|=|is)\s*\$?\s*(\d+(?:\.\d+)?)\s*([kmbt])?/gi;
  while ((match = tmcRe.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const base = Number(match[2]);
    if (!op || !Number.isFinite(base)) continue;
    const suffix = (match[3] ?? '').toLowerCase();
    const multiplier = suffix === 't' ? 1e12 : suffix === 'b' ? 1e9 : suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1;
    const value = base * multiplier;
    atoms.push({
      id: atomId(['market_regime', 'total_market_cap', op, value]),
      type: 'market_regime',
      rawText: match[0],
      subject: 'total_market_cap',
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }

  return { atoms, spans };
}

/** Price atoms — "SOL > $80", "BTC must be above $40000", or "<symbol> < $X". */
function extractPriceAtoms(text: string, knownTokenSymbols: ReadonlyArray<string>): ExtractorResult {
  const atoms: PriceAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  // Build a symbol set: known token symbols from the draft + common crypto symbols.
  const baseline = ['SOL', 'BTC', 'ETH', 'USDC', 'USDT', 'JUP', 'BONK', 'POPCAT', 'WIF', 'JTO'];
  const symbols = Array.from(new Set([...baseline, ...knownTokenSymbols.map((s) => s.toUpperCase())]));
  const symbolPattern = symbols.map(escapeRegExp).join('|');
  const re = new RegExp(
    `\\b(${symbolPattern})\\b\\s+(?:(?:must|should|is|are)\\s+(?:be\\s+)?)?(above|over|greater than|more than|>=?|below|under|less than|<=?|at least|at most|equal to|equals|=)\\s*\\$?\\s*(\\d+(?:[.,]\\d+)?)`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const subject = (match[1] ?? '').toUpperCase();
    const op = operatorFromText(match[2] ?? '');
    const value = Number((match[3] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['price', subject, op, value]),
      type: 'price',
      rawText: match[0],
      subject,
      op,
      value,
      unit: 'USD',
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** Tx-gate atoms — fixed-phrase rules the deterministic analyzer can check after simulation. */
function extractTxGateAtoms(text: string): ExtractorResult {
  const atoms: TxGateAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const patterns: Array<{ re: RegExp; rule: TxGateRule }> = [
    { re: /only\s+executes?\s+the\s+(?:requested\s+)?swap|only\s+(?:the\s+)?requested\s+swap|just\s+the\s+swap/gi, rule: 'only_requested_swap' },
    { re: /no\s+extra\s+transfers?|no\s+additional\s+transfers?/gi, rule: 'no_extra_transfers' },
    { re: /no\s+unknown\s+recipients?|no\s+(?:unexpected|unfamiliar)\s+recipients?/gi, rule: 'no_unknown_recipients' },
    { re: /no\s+unrelated\s+instructions?|no\s+(?:unexpected|unfamiliar)\s+instructions?|no\s+extra\s+instructions?/gi, rule: 'no_unrelated_instructions' },
  ];
  for (const { re, rule } of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      atoms.push({
        id: atomId(['tx_gate', rule]),
        type: 'tx_gate',
        rawText: match[0],
        rule,
      });
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return { atoms, spans };
}

/**
 * External-price atoms — off-chain priced items like "helium phone plan < $20" or
 * "monthly subscription under $15". Catches noun phrases adjacent to a $X threshold
 * that did not bind to a crypto-symbol price atom.
 */
function extractExternalPriceAtoms(text: string, consumedSpans: ReadonlyArray<{ start: number; end: number }>): ExtractorResult {
  const atoms: ExternalPriceAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  // Noun phrase: up to 5 word-like tokens (letters/apostrophes/hyphens) followed by one of the
  // "priced item" keywords. Restricting to a single sentence (no period, comma, or newline in
  // the noun phrase) keeps the match from running away across clauses.
  const re = /\b((?:[a-z][a-z'-]*\s+){0,4}[a-z][a-z'-]*)\s+(plan|subscription|service|bill|fee|cost|price|rate|invoice|membership)\b\s+(?:is\s+|must\s+be\s+|should\s+be\s+|costs?\s+)?(above|over|greater than|more than|>=?|below|under|less than|<=?|at least|at most|equal to|equals|=)\s*\$?\s*(\d+(?:[.,]\d+)?)\s*(?:dollars?|usd|bucks?|\/?\s*(?:mo(?:nth)?|yr|year|week|day))?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    // Skip if this span overlaps a span already consumed (e.g. a crypto price atom that
    // bound a $-threshold to a known token symbol).
    if (consumedSpans.some((span) => spansOverlap(span, { start, end }))) continue;
    const subject = `${(match[1] ?? '').trim()} ${(match[2] ?? '').trim()}`.trim().toLowerCase();
    const op = operatorFromText(match[3] ?? '');
    const value = Number((match[4] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(value) || subject.length === 0) continue;
    atoms.push({
      id: atomId(['external_price', subject, op, value]),
      type: 'external_price',
      rawText: match[0],
      subject,
      op,
      value,
      unit: 'USD',
    });
    spans.push({ start, end });
  }
  return { atoms, spans };
}

/* -------------------------------------------------------------------------- */
/* External state — outage / exploit / hack / incident / paused withdrawals   */
/* -------------------------------------------------------------------------- */

/**
 * `external_state` atoms — protocol-level "is X currently broken" checks.
 * Patterns hit imperative phrasings like "no outage", "deny if exploit", "approve only if
 * not paused". The subject is the noun the user names ("solana network", "jupiter",
 * "marinade"). `expected` reflects what the user wants TO BE TRUE (e.g. "no outage" =
 * expected=false; "if there was an exploit" with deny semantics → expected=false too).
 */
function extractExternalStateAtoms(text: string): ExtractorResult {
  const atoms: ExternalStateAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const kinds: Array<{ re: RegExp; kind: ExternalStateKind }> = [
    { re: /\b(?:network\s+)?outages?\b/gi, kind: 'network_outage' },
    { re: /\bexploits?\b/gi, kind: 'exploit' },
    { re: /\bhacks?\b/gi, kind: 'hack' },
    { re: /\bincidents?\b/gi, kind: 'incident' },
    { re: /\bpaused\s+withdrawals?\b|\bwithdrawal[s]?\s+paused\b/gi, kind: 'paused_withdrawals' },
    { re: /\b(?:service\s+)?downtime\b|\b(?:website|site)\s+offline\b|\b(?:website|site)\s+down\b/gi, kind: 'service_outage' },
  ];
  for (const { re, kind } of kinds) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const rawText = match[0];
      const start = match.index;
      const end = start + rawText.length;
      // Subject = a 4-token noun phrase preceding the kind keyword. Falls back to the
      // kind-keyword itself if no preceding noun phrase is present.
      const lookback = text.substring(Math.max(0, start - 60), start);
      const subjMatch = lookback.match(/([a-z][a-z0-9'.-]*(?:\s+[a-z][a-z0-9'.-]*){0,3})\s*$/i);
      const subject = subjMatch ? subjMatch[1]!.trim().toLowerCase() : kind;
      const expected = inferExternalStateExpected(text, start, end);
      atoms.push({
        id: atomId(['external_state', subject, kind, expected]),
        type: 'external_state',
        rawText,
        subject,
        kind,
        expected,
      });
      spans.push({ start, end });
    }
  }
  return { atoms, spans };
}

/**
 * Infer whether the user wants the state-check to be TRUE or FALSE, by reading the
 * imperative around the keyword. "no outage" / "approve if no outage" / "deny if outage"
 * → expected=false. "approve if there's an outage" / "if outage" → expected=true.
 *
 * Detection is intentionally lenient — "is no Solana network outage" should count as a
 * negation even though there are 3 words between "no" and the keyword. Defaults to TRUE
 * (literal interpretation: user named the state, so they want it checked).
 */
function inferExternalStateExpected(text: string, start: number, _end: number): boolean {
  // Look ~60 chars before the keyword for a negation token (no / not / never / without /
  // isn't / "approve only if no ..."). If found, the user wants the state ABSENT.
  const lookback = text.substring(Math.max(0, start - 60), start).toLowerCase();
  if (/\b(?:no|not|never|without|isn[''']t|aren[''']t|no\s+current|no\s+ongoing)\b/.test(lookback)) return false;
  // "deny if <state>" / "reject if <state>" / "block if <state>" → user wants state ABSENT.
  if (/\b(?:deny|reject|block|fail)\s+(?:if|when)\s+(?:there'?s\s+|the\s+)?$/i.test(lookback.replace(/\s+$/, ' '))) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* External event — scheduled upgrade / governance vote / release             */
/* -------------------------------------------------------------------------- */

function extractExternalEventAtoms(text: string): ExtractorResult {
  const atoms: ExternalEventAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const kinds: Array<{ re: RegExp; kind: ExternalEventKind }> = [
    { re: /\bscheduled\s+(?:mainnet\s+)?upgrades?\b|\bnetwork\s+upgrades?\b|\bmainnet\s+upgrades?\b/gi, kind: 'scheduled_upgrade' },
    { re: /\b(?:governance|dao)\s+votes?\b|\bgovernance\s+proposals?\b/gi, kind: 'governance_vote' },
    { re: /\bmainnet\s+forks?\b|\bhard\s+forks?\b/gi, kind: 'mainnet_fork' },
    { re: /\bnew\s+releases?\b|\brelease\s+notes?\b|\bversion\s+release\b/gi, kind: 'release' },
    { re: /\bannouncements?\b/gi, kind: 'announcement' },
  ];
  // Optional time window: "in the next 24h", "within 7 days", "last 30 days".
  const windowRe = /\b(?:in\s+the\s+next|within|next)\s+(\d+(?:\.\d+)?)\s*(seconds?|sec|minutes?|min|hours?|hrs?|h|days?|d|weeks?|w|months?|mo)\b|\b(?:in\s+the\s+last|over\s+the\s+last|past)\s+(\d+(?:\.\d+)?)\s*(seconds?|sec|minutes?|min|hours?|hrs?|h|days?|d|weeks?|w|months?|mo)\b/i;
  for (const { re, kind } of kinds) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const surrounding = text.substring(Math.max(0, start - 60), Math.min(text.length, end + 60));
      const windowMatch = windowRe.exec(surrounding);
      let window: 'within' | 'past' | undefined;
      let windowSeconds: number | undefined;
      if (windowMatch) {
        const isPast = Boolean(windowMatch[3]); // groups 3-4 = past form, 1-2 = within form
        const valueStr = isPast ? windowMatch[3] : windowMatch[1];
        const unitStr = isPast ? windowMatch[4] : windowMatch[2];
        const n = Number(valueStr);
        if (Number.isFinite(n) && unitStr) {
          window = isPast ? 'past' : 'within';
          windowSeconds = parseAgeSecondsFromUnit(n, unitStr);
        }
      }
      // expected: false if the user wrote "no", "not", "without" anywhere in the surrounding
      // window — they want NO scheduled upgrade / vote / fork. Default true.
      const negated = /\b(?:no|not|never|without|isn[''']t|aren[''']t)\b/i.test(surrounding)
        || /\b(?:approve|allow)\s+only\s+if\s+(?:there'?s\s+|the\s+)?no\b/i.test(surrounding);
      const expected = !negated;
      // Subject: the protocol/network the event applies to (e.g. "solana", "jupiter").
      const lookback = text.substring(Math.max(0, start - 40), start);
      const subjMatch = lookback.match(/([a-z][a-z0-9'.-]*(?:\s+[a-z][a-z0-9'.-]*){0,2})\s*$/i);
      const subject = subjMatch ? subjMatch[1]!.trim().toLowerCase() : kind;
      atoms.push({
        id: atomId(['external_event', subject, kind, window ?? '', windowSeconds ?? '', expected]),
        type: 'external_event',
        rawText: match[0],
        subject,
        kind,
        ...(window ? { window } : {}),
        ...(windowSeconds !== undefined ? { windowSeconds } : {}),
        expected,
      });
      spans.push({ start, end });
    }
  }
  return { atoms, spans };
}

/* -------------------------------------------------------------------------- */
/* External identity — sanctions / SEC action / KYC                            */
/* -------------------------------------------------------------------------- */

function extractExternalIdentityAtoms(text: string): ExtractorResult {
  const atoms: ExternalIdentityAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const kinds: Array<{ re: RegExp; kind: ExternalIdentityKind }> = [
    { re: /\b(?:ofac\s+)?sanctions?\s+list\b|\bsanction(?:ed|s)\b/gi, kind: 'sanctions_list' },
    { re: /\b(?:sec)\s+(?:enforcement(?:\s+action)?|action)\b|\bsec\s+complaint\b/gi, kind: 'sec_action' },
    { re: /\bkyc\s+(?:status|check|verification|complete[d]?)\b|\bknow[- ]your[- ]customer\b/gi, kind: 'kyc_status' },
  ];
  for (const { re, kind } of kinds) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const surrounding = text.substring(Math.max(0, start - 40), Math.min(text.length, end + 40));
      // expected: false for sanctions/SEC ("approve only if NOT on sanctions list"),
      // true for kyc ("approve only if KYC is complete").
      let expected: boolean;
      if (kind === 'kyc_status') {
        expected = !/\bno\s+kyc\b|\bkyc\s+(?:not|incomplete|missing)\b/i.test(surrounding);
      } else {
        expected = /\b(?:approve|allow)\s+(?:only\s+)?if\b[\s\S]{0,40}\b(?:sanctioned|on\s+the\s+sanctions\s+list|sec\s+action)/i.test(surrounding);
        // Default to false (user wants the address NOT to be on the list).
      }
      const subject = subjectFromIdentityWindow(text, start);
      atoms.push({
        id: atomId(['external_identity', subject, kind, expected]),
        type: 'external_identity',
        rawText: match[0],
        subject,
        kind,
        expected,
      });
      spans.push({ start, end });
    }
  }
  return { atoms, spans };
}

/** Subject for an identity check: usually a wallet address (base58, 32-44 chars) or
 *  a noun phrase ("token issuer", "recipient", "wallet"). Falls back to a generic label. */
function subjectFromIdentityWindow(text: string, start: number): string {
  const lookback = text.substring(Math.max(0, start - 80), start);
  // Prefer a base58 pubkey-like token if present.
  const pubkeyMatch = lookback.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
  if (pubkeyMatch && pubkeyMatch.length > 0) return pubkeyMatch[pubkeyMatch.length - 1]!;
  // Otherwise a short trailing noun phrase.
  const subjMatch = lookback.match(/([a-z][a-z0-9'.-]*(?:\s+[a-z][a-z0-9'.-]*){0,2})\s*$/i);
  return subjMatch ? subjMatch[1]!.trim().toLowerCase() : 'subject';
}

/* -------------------------------------------------------------------------- */
/* Tradfi price — SPY, GLD, FX rates                                          */
/* -------------------------------------------------------------------------- */

/**
 * Tradfi tickers / metals / FX pairs. Distinct from `price` (which is restricted to
 * crypto symbol vocabulary) so we don't accidentally route SPY/GLD through the
 * Jupiter price chain.
 */
const TRADFI_TICKERS = ['SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'GLD', 'SLV', 'TLT', 'GOLD', 'SILVER', 'OIL', 'WTI', 'BRENT'];
const FX_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCAD', 'AUDUSD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CAD', 'AUD/USD'];

function extractTradfiPriceAtoms(text: string): ExtractorResult {
  const atoms: TradfiPriceAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const tickerAlts = [...TRADFI_TICKERS, ...FX_PAIRS].map(escapeRegExp).join('|');
  const re = new RegExp(
    `\\b(${tickerAlts})\\b\\s+(?:(?:must|should|is|are)\\s+(?:be\\s+)?)?(above|over|greater than|more than|>=?|below|under|less than|<=?|at least|at most|equal to|equals|=)\\s*\\$?\\s*(\\d+(?:[.,]\\d+)?)`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const subject = (match[1] ?? '').toUpperCase();
    const op = operatorFromText(match[2] ?? '');
    const value = Number((match[3] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['tradfi_price', subject, op, value]),
      type: 'tradfi_price',
      rawText: match[0],
      subject,
      op,
      value,
      unit: 'USD',
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/* -------------------------------------------------------------------------- */
/* Time fact — business day / holiday / market hours / day of week            */
/* -------------------------------------------------------------------------- */

function extractTimeFactAtoms(text: string): ExtractorResult {
  const atoms: TimeFactAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const patterns: Array<{ re: RegExp; kind: TimeFactKind; defaultExpected: boolean }> = [
    { re: /\b(?:us\s+)?business\s+day\b|\bweekday\b/gi, kind: 'is_business_day', defaultExpected: true },
    { re: /\b(?:us\s+)?(?:public\s+)?holiday\b|\bbank\s+holiday\b/gi, kind: 'is_us_holiday', defaultExpected: false },
    { re: /\bmarket\s+(?:hours|open)\b|\bduring\s+market\s+hours\b/gi, kind: 'is_market_open', defaultExpected: true },
    { re: /\b(?:on\s+a\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, kind: 'day_of_week', defaultExpected: true },
  ];
  for (const { re, kind, defaultExpected } of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const surrounding = text.substring(Math.max(0, match.index - 30), Math.min(text.length, match.index + match[0].length + 30));
      // "approve only if today is a business day" → expected=true (default).
      // "deny if today is a holiday" → expected=false (default for holiday).
      // "not a business day" → flip default.
      const flip = /\b(?:not|isn[''']t|never)\b/.test(surrounding) ||
        /\b(?:deny|reject|block)\s+(?:if|when)\b/.test(surrounding);
      const expected = flip ? !defaultExpected : defaultExpected;
      atoms.push({
        id: atomId(['time_fact', kind, expected]),
        type: 'time_fact',
        rawText: match[0],
        kind,
        expected,
      });
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return { atoms, spans };
}

/* -------------------------------------------------------------------------- */
/* Network metric — TPS / slot height / validator health                       */
/* -------------------------------------------------------------------------- */

function extractNetworkMetricAtoms(text: string): ExtractorResult {
  const atoms: NetworkMetricAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];

  // TPS thresholds: "TPS > 1000", "TPS above 1500", "tps under 500".
  const tpsRe = /\b(?:solana\s+)?tps\b\s+(?:(?:must|should|is|are)\s+(?:be\s+)?)?(above|over|greater than|more than|>=?|below|under|less than|<=?|at least|at most|equal to|equals|=)\s*(\d+(?:[.,]\d+)?)/gi;
  let match: RegExpExecArray | null;
  while ((match = tpsRe.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const value = Number((match[2] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['network_metric', 'tps', op, value]),
      type: 'network_metric',
      rawText: match[0],
      metric: 'tps',
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }

  // Slot height thresholds: "slot height > 300000000" or "slot height is below N".
  const slotRe = /\bslot\s+height\b\s+(?:(?:must|should|is|are)\s+(?:be\s+)?)?(above|over|greater than|>=?|below|under|less than|<=?|at least|at most|equal to|equals|=)\s*(\d+(?:[.,]\d+)?)/gi;
  while ((match = slotRe.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const value = Number((match[2] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['network_metric', 'slot_height', op, value]),
      type: 'network_metric',
      rawText: match[0],
      metric: 'slot_height',
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }

  // Validator jail: "validator <pubkey> jailed" / "isn't jailed" / "not jailed".
  const jailRe = /\bvalidator\b[^.\n]{0,80}?\b(?:is\s+(?:not\s+)?|isn[''']t\s+|not\s+|jailed|delinquent)\b/gi;
  while ((match = jailRe.exec(text)) !== null) {
    const sentence = match[0];
    const expected = !/\b(?:not|isn[''']t|never)\s+(?:jailed|delinquent)\b/i.test(sentence)
      && !/\bvalidator\b[^.\n]*\b(?:not|isn[''']t)\b[^.\n]*\b(?:jailed|delinquent)\b/i.test(sentence)
      && /\b(?:jailed|delinquent)\b/i.test(sentence);
    const pubkeyMatch = sentence.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    atoms.push({
      id: atomId(['network_metric', 'validator_jailed', pubkeyMatch?.[0] ?? '', expected]),
      type: 'network_metric',
      rawText: sentence,
      metric: 'validator_jailed',
      ...(pubkeyMatch ? { subject: pubkeyMatch[0] } : {}),
    });
    spans.push({ start: match.index, end: match.index + sentence.length });
  }

  // Epoch progress percentage.
  const epochRe = /\bepoch\s+progress\b\s+(above|over|greater than|>=?|below|under|less than|<=?|at least|at most|equal to|equals|=|is)\s*(\d+(?:[.,]\d+)?)\s*%?/gi;
  while ((match = epochRe.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const value = Number((match[2] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['network_metric', 'epoch_progress_pct', op, value]),
      type: 'network_metric',
      rawText: match[0],
      metric: 'epoch_progress_pct',
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }

  return { atoms, spans };
}

/* -------------------------------------------------------------------------- */
/* Tier 1: balance / fee atoms                                                 */
/* -------------------------------------------------------------------------- */

const INTRO = String.raw`(?:(?:must|should|is|are)\s+(?:be\s+)?)?`;
const OP_ALT = String.raw`(above|over|greater than|more than|>=?|below|under|less than|<=?|at least|at most|equal to|equals|=)`;

/** wallet_balance — "SOL balance above 1", "leave at least 0.5 SOL", "deny if I'm under $50". */
function extractWalletBalanceAtoms(text: string): ExtractorResult {
  const atoms: WalletBalanceAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  // Direct phrasing: "SOL balance > 1", "my SOL balance is above 0.5", "wallet balance < $100"
  const directRe = new RegExp(
    String.raw`\b(?:my\s+)?(?:sol|wallet)\s+balance\s+${INTRO}${OP_ALT}\s*\$?\s*(\d+(?:[.,]\d+)?)\s*(sol|lamports?|usd|dollars?)?`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = directRe.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const value = Number((match[2] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(value)) continue;
    const unitWord = (match[3] ?? '').toLowerCase();
    const isUsd = /\$/.test(match[0]) || unitWord === 'usd' || unitWord.startsWith('dollar');
    const unit: 'SOL' | 'USD' | 'lamports' = unitWord.startsWith('lamport') ? 'lamports' : isUsd ? 'USD' : 'SOL';
    atoms.push({
      id: atomId(['wallet_balance', 'sol', op, value, unit]),
      type: 'wallet_balance',
      rawText: match[0],
      subject: 'SOL',
      op,
      value,
      unit,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  // Inverse phrasing: "leave at least 0.5 SOL", "keep 0.1 SOL for fees".
  const leaveRe = /\b(?:leave|keep|reserve|hold|maintain)\s+(?:at\s+least\s+|a\s+minimum\s+of\s+)?(\d+(?:\.\d+)?)\s*sol\b/gi;
  while ((match = leaveRe.exec(text)) !== null) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['wallet_balance', 'sol', 'gte', value, 'SOL']),
      type: 'wallet_balance',
      rawText: match[0],
      subject: 'SOL',
      op: 'gte',
      value,
      unit: 'SOL',
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** token_balance — "USDC balance above 100", "I have $50+ of USDC", "deny if JUP balance < 1000". */
function extractTokenBalanceAtoms(text: string): ExtractorResult {
  const atoms: TokenBalanceAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  // Standard SPL token symbols we look for; SOL is excluded since wallet_balance handles it.
  const symbols = ['USDC', 'USDT', 'JUP', 'BONK', 'WIF', 'POPCAT', 'PYUSD', 'JTO', 'MSOL', 'JITOSOL'];
  const symPattern = symbols.map(escapeRegExp).join('|');
  const re = new RegExp(
    String.raw`\b(${symPattern})\s+balance\s+${INTRO}${OP_ALT}\s*\$?\s*(\d+(?:[.,]\d+)?)\s*(tokens?|usd|dollars?)?`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const subject = (match[1] ?? '').toUpperCase();
    const op = operatorFromText(match[2] ?? '');
    const value = Number((match[3] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(value)) continue;
    const unitWord = (match[4] ?? '').toLowerCase();
    const isUsd = /\$/.test(match[0]) || unitWord === 'usd' || unitWord.startsWith('dollar');
    const unit: 'tokens' | 'USD' = isUsd ? 'USD' : 'tokens';
    atoms.push({
      id: atomId(['token_balance', subject, op, value, unit]),
      type: 'token_balance',
      rawText: match[0],
      subject,
      op,
      value,
      unit,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** relative_amount — "more than 10% of my wallet", "less than 5% of holdings", "X% of my SOL". */
function extractRelativeAmountAtoms(text: string): ExtractorResult {
  const atoms: RelativeAmountAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  // "X% of my wallet/holdings/balance/SOL"
  const re = /\b(above|over|greater than|more than|>=?|below|under|less than|<=?)\s+(\d+(?:\.\d+)?)\s*%\s*(?:of\s+(?:my\s+)?)?(wallet|holdings?|balance|sol(?:\s+balance)?|portfolio)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const pct = Number(match[2]);
    if (!op || !Number.isFinite(pct)) continue;
    const basisWord = (match[3] ?? '').toLowerCase();
    const basis: 'wallet' | 'sol_balance' | 'token_balance' = /sol/.test(basisWord) ? 'sol_balance' : 'wallet';
    const fraction = pct / 100;
    atoms.push({
      id: atomId(['relative_amount', basis, op, fraction]),
      type: 'relative_amount',
      rawText: match[0],
      fraction,
      op,
      basis,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** tx_fee — "fee above $1", "tx fee under 0.001 SOL", "priority fee less than $0.50". */
function extractTxFeeAtoms(text: string): ExtractorResult {
  const atoms: TxFeeAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const re = new RegExp(
    String.raw`\b(?:tx\s+|transaction\s+|priority\s+|gas\s+|network\s+)?fee\s+${INTRO}${OP_ALT}\s*\$?\s*(\d+(?:[.,]\d+)?)\s*(sol|lamports?|usd|dollars?|cents?)?`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const value = Number((match[2] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(value)) continue;
    const unitWord = (match[3] ?? '').toLowerCase();
    const isUsd = /\$/.test(match[0]) || unitWord === 'usd' || unitWord.startsWith('dollar') || unitWord.startsWith('cent');
    const unit: 'USD' | 'SOL' | 'lamports' = unitWord.startsWith('lamport') ? 'lamports' : isUsd ? 'USD' : unitWord === 'sol' ? 'SOL' : 'USD';
    atoms.push({
      id: atomId(['tx_fee', op, value, unit]),
      type: 'tx_fee',
      rawText: match[0],
      op,
      value,
      unit,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** network_congestion — "median priority fee > 100000", "network congestion under 50k microlamports". */
function extractNetworkCongestionAtoms(text: string): ExtractorResult {
  const atoms: NetworkCongestionAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const re = new RegExp(
    String.raw`\b(?:median\s+)?(?:priority|prioritization)\s+fee\s+${INTRO}${OP_ALT}\s*(\d+(?:[.,]\d+)?)\s*(k|m|micro\s*lamports?|microlamports?|lamports?)?`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const raw = Number((match[2] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(raw)) continue;
    const suffix = (match[3] ?? '').toLowerCase();
    const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
    const value = raw * multiplier;
    atoms.push({
      id: atomId(['network_congestion', op, value]),
      type: 'network_congestion',
      rawText: match[0],
      op,
      value,
      unit: 'microlamports',
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  // Also catch "network is congested" / "network is calm" qualitative phrasings — these
  // map to an above/below threshold on a conventional cutoff (250_000 microlamports).
  const qualitativeCongested = /\bnetwork\s+(?:is\s+)?(?:congested|busy|crowded|slammed)\b/gi;
  while ((match = qualitativeCongested.exec(text)) !== null) {
    atoms.push({
      id: atomId(['network_congestion', 'gt', 250_000]),
      type: 'network_congestion',
      rawText: match[0],
      op: 'gt',
      value: 250_000,
      unit: 'microlamports',
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  const qualitativeCalm = /\bnetwork\s+(?:is\s+)?(?:calm|quiet|idle|fast)\b/gi;
  while ((match = qualitativeCalm.exec(text)) !== null) {
    atoms.push({
      id: atomId(['network_congestion', 'lt', 50_000]),
      type: 'network_congestion',
      rawText: match[0],
      op: 'lt',
      value: 50_000,
      unit: 'microlamports',
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/* -------------------------------------------------------------------------- */
/* Tier 2: token / wallet sanity atoms                                         */
/* -------------------------------------------------------------------------- */

/** token_supply — "supply > 1M", "circulating supply at least 100k". */
function extractTokenSupplyAtoms(text: string): ExtractorResult {
  const atoms: TokenSupplyAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const re = new RegExp(
    String.raw`\b(?:token\s+|circulating\s+|total\s+)?supply\s+${INTRO}${OP_ALT}\s*(\d+(?:[.,]\d+)?)\s*([kmbt])?`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const base = Number((match[2] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(base)) continue;
    const suffix = (match[3] ?? '').toLowerCase();
    const multiplier = suffix === 't' ? 1e12 : suffix === 'b' ? 1e9 : suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1;
    const value = base * multiplier;
    atoms.push({
      id: atomId(['token_supply', op, value]),
      type: 'token_supply',
      rawText: match[0],
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** mint_decimals — "decimals = 6", "decimals at least 4", "deny if decimals is 0". */
function extractMintDecimalsAtoms(text: string): ExtractorResult {
  const atoms: MintDecimalsAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const re = new RegExp(
    String.raw`\b(?:mint\s+|token\s+)?decimals\s+${INTRO}${OP_ALT}\s*(\d+)`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const value = Number(match[2]);
    if (!op || !Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['mint_decimals', op, value]),
      type: 'mint_decimals',
      rawText: match[0],
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** wallet_age_onchain — "wallet age above 7 days", "my wallet was created more than 30 days ago". */
function extractWalletAgeAtoms(text: string): ExtractorResult {
  const atoms: WalletAgeOnchainAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  // "wallet age (op) N <unit>"
  const re1 = new RegExp(
    String.raw`\b(?:my\s+)?wallet\s+age\s+${INTRO}${OP_ALT}\s+(\d+(?:\.\d+)?)\s*(months?|month|mo|weeks?|w|days?|d|hours?|h)\b`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re1.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const n = Number(match[2]);
    const unit = match[3] ?? 'd';
    if (!op || !Number.isFinite(n)) continue;
    const seconds = parseAgeSecondsFromUnit(n, unit);
    atoms.push({
      id: atomId(['wallet_age_onchain', op, seconds]),
      type: 'wallet_age_onchain',
      rawText: match[0],
      op,
      value: seconds,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  // "my wallet was created (op) N <unit> ago"
  const re2 = /\b(?:my\s+)?wallet\s+(?:was\s+)?created\s+(?:less|more|fewer|greater)\s+than\s+(\d+(?:\.\d+)?)\s*(months?|month|mo|weeks?|w|days?|d|hours?|h)\s+ago\b/gi;
  while ((match = re2.exec(text)) !== null) {
    const lower = match[0].toLowerCase();
    const op: AgentAtomOperator = /less|fewer/.test(lower) ? 'lt' : 'gt';
    const seconds = parseAgeSecondsFromUnit(Number(match[1]), match[2] ?? 'd');
    atoms.push({
      id: atomId(['wallet_age_onchain', op, seconds]),
      type: 'wallet_age_onchain',
      rawText: match[0],
      op,
      value: seconds,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** recipient_known — "recipient is a new address", "deny if recipient is unknown", "approve only if I've sent to this address before". */
function extractRecipientKnownAtoms(text: string): ExtractorResult {
  const atoms: RecipientKnownAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const patterns: Array<{ re: RegExp; expected: boolean }> = [
    { re: /\brecipient\s+is\s+(?:a\s+)?new\s+address\b/gi, expected: false },
    { re: /\brecipient\s+is\s+unknown\b|\bunknown\s+recipient\b/gi, expected: false },
    { re: /\bnever\s+sent\s+to\b|\bnever\s+paid\b/gi, expected: false },
    { re: /\b(?:sent\s+to|paid)\s+(?:this\s+)?(?:recipient|address)\s+before\b/gi, expected: true },
    { re: /\b(?:known|familiar)\s+recipient\b|\brecipient\s+is\s+(?:known|familiar)\b/gi, expected: true },
  ];
  for (const { re, expected } of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      atoms.push({
        id: atomId(['recipient_known', expected]),
        type: 'recipient_known',
        rawText: match[0],
        expected,
      });
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return { atoms, spans };
}

/** token_held_duration — "held SOL for more than 7 days", "owned JUP more than a week". */
function extractTokenHeldDurationAtoms(text: string): ExtractorResult {
  const atoms: TokenHeldDurationAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const re = /\b(?:held|owned|holding)\s+([A-Z]{2,10})\s+(?:for\s+)?(?:less|more|fewer|greater)\s+than\s+(\d+(?:\.\d+)?)\s*(months?|month|mo|weeks?|w|days?|d|hours?|h)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const lower = match[0].toLowerCase();
    const op: AgentAtomOperator = /less|fewer/.test(lower) ? 'lt' : 'gt';
    const subject = (match[1] ?? '').toUpperCase();
    const seconds = parseAgeSecondsFromUnit(Number(match[2]), match[3] ?? 'd');
    atoms.push({
      id: atomId(['token_held_duration', subject, op, seconds]),
      type: 'token_held_duration',
      rawText: match[0],
      subject,
      op,
      value: seconds,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/* -------------------------------------------------------------------------- */
/* Tier 3: tx-inspect atoms                                                    */
/* -------------------------------------------------------------------------- */

/** required_signatures — "signatures > 1", "deny if more than one signer". */
function extractRequiredSignaturesAtoms(text: string): ExtractorResult {
  const atoms: RequiredSignaturesAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const re1 = new RegExp(
    String.raw`\b(?:required\s+)?(?:signatures|signers)\s+${INTRO}${OP_ALT}\s*(\d+)`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re1.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const value = Number(match[2]);
    if (!op || !Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['required_signatures', op, value]),
      type: 'required_signatures',
      rawText: match[0],
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  const re2 = /\b(?:more|fewer|less|greater)\s+than\s+(\d+|one|two|three)\s+sign(?:er|ature)s?\b/gi;
  while ((match = re2.exec(text)) !== null) {
    const lower = match[0].toLowerCase();
    const op: AgentAtomOperator = /less|fewer/.test(lower) ? 'lt' : 'gt';
    const numericWord = (match[1] ?? '').toLowerCase();
    const value = numericWord === 'one' ? 1 : numericWord === 'two' ? 2 : numericWord === 'three' ? 3 : Number(numericWord);
    if (!Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['required_signatures', op, value]),
      type: 'required_signatures',
      rawText: match[0],
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** instruction_count — "instructions > 8", "more than 10 instructions". */
function extractInstructionCountAtoms(text: string): ExtractorResult {
  const atoms: InstructionCountAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const re1 = new RegExp(
    String.raw`\binstructions\s+${INTRO}${OP_ALT}\s*(\d+)`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re1.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const value = Number(match[2]);
    if (!op || !Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['instruction_count', op, value]),
      type: 'instruction_count',
      rawText: match[0],
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  const re2 = /\b(?:more|fewer|less|greater)\s+than\s+(\d+)\s+instructions\b/gi;
  while ((match = re2.exec(text)) !== null) {
    const lower = match[0].toLowerCase();
    const op: AgentAtomOperator = /less|fewer/.test(lower) ? 'lt' : 'gt';
    const value = Number(match[1]);
    atoms.push({
      id: atomId(['instruction_count', op, value]),
      type: 'instruction_count',
      rawText: match[0],
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** account_writability_count — "writable accounts > 5", "more than 5 writable accounts". */
function extractAccountWritabilityAtoms(text: string): ExtractorResult {
  const atoms: AccountWritabilityCountAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const re1 = new RegExp(
    String.raw`\bwritable\s+accounts?\s+${INTRO}${OP_ALT}\s*(\d+)`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re1.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const value = Number(match[2]);
    if (!op || !Number.isFinite(value)) continue;
    atoms.push({
      id: atomId(['account_writability_count', op, value]),
      type: 'account_writability_count',
      rawText: match[0],
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  const re2 = /\b(?:more|fewer|less|greater)\s+than\s+(\d+)\s+writable\s+accounts?\b/gi;
  while ((match = re2.exec(text)) !== null) {
    const lower = match[0].toLowerCase();
    const op: AgentAtomOperator = /less|fewer/.test(lower) ? 'lt' : 'gt';
    const value = Number(match[1]);
    atoms.push({
      id: atomId(['account_writability_count', op, value]),
      type: 'account_writability_count',
      rawText: match[0],
      op,
      value,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** rent_exempt_required — "rent above $0.10", "deny if rent > 0.01 SOL". */
function extractRentExemptAtoms(text: string): ExtractorResult {
  const atoms: RentExemptRequiredAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const re = new RegExp(
    String.raw`\brent\s+${INTRO}${OP_ALT}\s*\$?\s*(\d+(?:[.,]\d+)?)\s*(sol|lamports?|usd|dollars?)?`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const op = operatorFromText(match[1] ?? '');
    const value = Number((match[2] ?? '').replace(/,/g, ''));
    if (!op || !Number.isFinite(value)) continue;
    const unitWord = (match[3] ?? '').toLowerCase();
    const isUsd = /\$/.test(match[0]) || unitWord === 'usd' || unitWord.startsWith('dollar');
    const unit: 'lamports' | 'SOL' | 'USD' = unitWord.startsWith('lamport') ? 'lamports' : isUsd ? 'USD' : 'SOL';
    atoms.push({
      id: atomId(['rent_exempt_required', op, value, unit]),
      type: 'rent_exempt_required',
      rawText: match[0],
      op,
      value,
      unit,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/** epoch_warmup — "first 5% of the new epoch" → produces an epoch_progress_pct atom (lt N). */
function extractEpochWarmupAtoms(text: string): ExtractorResult {
  const atoms: NetworkMetricAtom[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const re = /\b(?:in\s+the\s+)?first\s+(\d+(?:\.\d+)?)\s*%\s*of\s+(?:the\s+|a\s+|new\s+|current\s+)*epoch\b|\bepoch\s+warmup\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const pct = match[1] ? Number(match[1]) : 5; // default 5% if no number specified
    if (!Number.isFinite(pct)) continue;
    atoms.push({
      id: atomId(['network_metric', 'epoch_progress_pct', 'lt', pct]),
      type: 'network_metric',
      rawText: match[0],
      metric: 'epoch_progress_pct',
      op: 'lt',
      value: pct,
    });
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { atoms, spans };
}

/* -------------------------------------------------------------------------- */

function spansOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* -------------------------------------------------------------------------- */
/* Public entrypoint                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Extract structured atoms from a reviewer NOTE / instruction text.
 *
 * Order of extraction is important: token-specific atoms run first, then market
 * regime, then crypto-symbol price, then tx gates, and finally the external-price
 * fallback consumes any remaining unmatched `$X` thresholds. Each extractor records
 * the spans it consumed so later extractors can skip them.
 */
export function extractAtoms(input: ExtractAtomsInput): ExtractAtomsResult {
  const text = (input.text ?? '').trim();
  if (!text) return { atoms: [], consumedSpans: [] };
  const knownTokenSymbols = input.knownTokenSymbols ?? [];

  const all: AgentAtom[] = [];
  const consumedSpans: Array<{ start: number; end: number }> = [];

  const runners: Array<() => ExtractorResult> = [
    () => extractTokenAuditAtoms(text),
    () => extractTokenAgeAtoms(text),
    () => extractMarketRegimeAtoms(text),
    // Tradfi-price runs BEFORE crypto-price so SPY/GLD/EUR-USD don't fall through to the
    // crypto symbol pattern. Each extractor records its consumed span so the next pass skips.
    () => extractTradfiPriceAtoms(text),
    // Balance atoms run BEFORE crypto-price so "USDC balance > 100" isn't mistaken for "USDC > 100".
    () => extractWalletBalanceAtoms(text),
    () => extractTokenBalanceAtoms(text),
    () => extractPriceAtoms(text, knownTokenSymbols),
    () => extractTxGateAtoms(text),
    // External-state / event / identity run BEFORE external-price so a sentence like
    // "if there's a Solana outage" doesn't accidentally produce an external_price atom.
    () => extractExternalStateAtoms(text),
    () => extractExternalEventAtoms(text),
    () => extractExternalIdentityAtoms(text),
    () => extractTimeFactAtoms(text),
    () => extractNetworkMetricAtoms(text),
    // Relative-amount, fee, congestion, sanity, tx-inspect — order doesn't matter among
    // themselves since each pattern is uniquely keyed.
    () => extractRelativeAmountAtoms(text),
    () => extractTxFeeAtoms(text),
    () => extractNetworkCongestionAtoms(text),
    () => extractTokenSupplyAtoms(text),
    () => extractMintDecimalsAtoms(text),
    () => extractWalletAgeAtoms(text),
    () => extractRecipientKnownAtoms(text),
    () => extractTokenHeldDurationAtoms(text),
    () => extractRequiredSignaturesAtoms(text),
    () => extractInstructionCountAtoms(text),
    () => extractAccountWritabilityAtoms(text),
    () => extractRentExemptAtoms(text),
    () => extractEpochWarmupAtoms(text),
    () => extractExternalPriceAtoms(text, consumedSpans),
  ];

  for (const runner of runners) {
    const result = runner();
    for (const atom of result.atoms) {
      if (!all.some((existing) => existing.id === atom.id)) all.push(atom);
    }
    for (const span of result.spans) {
      consumedSpans.push(span);
    }
  }

  return { atoms: all, consumedSpans };
}

/* -------------------------------------------------------------------------- */
/* LLM fallback extraction                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Heuristic: text reads like a policy (conditional + threshold/comparison) but the
 * regex extractor found zero atoms. Use this to decide whether the (more expensive)
 * LLM fallback is worth invoking.
 */
export function looksLikePolicyWithoutAtoms(text: string, atoms: ReadonlyArray<AgentAtom>): boolean {
  if (atoms.length > 0) return false;
  const normalized = (text ?? '').toLowerCase().trim();
  if (!normalized) return false;
  // Strong conditionals — the user is clearly stating a policy rule.
  const strongConditional = /\b(approve if|deny if|reject if|only if|approve only|deny only|approve when|deny when|reject when)\b/.test(normalized);
  if (strongConditional) return true;
  // Weaker conditionals + any comparison-like vocabulary.
  const conditional = /\b(must be|should be|require|requires|when the|if the|provided that|so long as)\b/.test(normalized);
  const comparator = /[<>]=?|less than|more than|greater than|fewer than|above|over|below|under|equal to|equals|newer than|older than|fresher than|before|after|since|under \$|over \$/.test(normalized);
  const hasDollar = /\$\s*\d/.test(normalized);
  return (conditional && (comparator || hasDollar)) || (hasDollar && comparator);
}

/**
 * Caller-supplied LLM extractor function. Implementations must return a JSON-parseable
 * array of `AgentAtom` objects. The aiPlanner side provides an Anthropic/OpenAI-backed
 * implementation; workflow tests can pass a stub.
 */
export type AgentAtomLlmExtractor = (input: {
  text: string;
  knownTokenSymbols?: string[];
}) => Promise<AgentAtom[]>;

export interface ExtractAtomsWithFallbackOptions {
  llm?: AgentAtomLlmExtractor;
}

/**
 * Run the regex extractor; if it returns no atoms AND the text looks like a policy,
 * fall through to the LLM extractor (when supplied). Useful for NOTEs phrased outside
 * the documented vocabulary ("low-cap meme coin", "fresh launch", "newer than a week").
 */
export async function extractAtomsWithLlmFallback(
  input: ExtractAtomsInput,
  options: ExtractAtomsWithFallbackOptions = {},
): Promise<ExtractAtomsResult> {
  const primary = extractAtoms(input);
  if (primary.atoms.length > 0) return primary;
  if (!options.llm) return primary;
  if (!looksLikePolicyWithoutAtoms(input.text ?? '', primary.atoms)) return primary;
  try {
    const llmAtoms = await options.llm({ text: input.text ?? '', knownTokenSymbols: input.knownTokenSymbols });
    if (!Array.isArray(llmAtoms) || llmAtoms.length === 0) return primary;
    // Drop any duplicate ids; the caller may emit overlapping shapes.
    const seen = new Set<string>();
    const merged: AgentAtom[] = [];
    for (const atom of llmAtoms) {
      if (!atom || typeof atom !== 'object') continue;
      const id = (atom as { id?: unknown }).id;
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      merged.push(atom);
    }
    return { atoms: merged, consumedSpans: primary.consumedSpans };
  } catch {
    // Never let the LLM fallback throw out of the extractor — return the regex result.
    return primary;
  }
}
