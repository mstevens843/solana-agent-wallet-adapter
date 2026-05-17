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
  | 'protocol_health';

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

export type AgentAtom =
  | PriceAtom
  | MarketRegimeAtom
  | TokenAuditAtom
  | TokenAgeAtom
  | TxGateAtom
  | ExternalPriceAtom
  | ProtocolHealthAtom;

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
    `\\b(${symbolPattern})\\b\\s+(?:(?:must|should)\\s+be\\s+)?(above|over|greater than|more than|>=?|below|under|less than|<=?|at least|at most|equal to|equals|=|is)\\s*\\$?\\s*(\\d+(?:[.,]\\d+)?)`,
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
    () => extractPriceAtoms(text, knownTokenSymbols),
    () => extractTxGateAtoms(text),
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
