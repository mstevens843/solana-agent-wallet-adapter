import { extractAtoms } from './agentAtoms.js';

export const POLICY_LANGUAGE_CODES = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'es',
  'ja',
  'de',
  'it',
  'fr',
  'pt',
  'ko',
  'ru',
  'unknown',
] as const;

export type PolicyLanguageCode = (typeof POLICY_LANGUAGE_CODES)[number];
export type PolicyTextNormalizationMethod = 'none' | 'phrase_pack' | 'model';
export type PolicyTextNormalizationStatus = 'not_needed' | 'success' | 'failed';

export interface PolicyLanguageDetection {
  language: PolicyLanguageCode;
  confidence: number;
  isEnglish: boolean;
  shouldCanonicalize: boolean;
  probablePolicy: boolean;
  reason: string;
}

export interface PolicyTextNormalizationResult {
  originalText: string;
  canonicalEnglish: string;
  sourceLanguage: PolicyLanguageCode;
  confidence: number;
  canonicalized: boolean;
  method: PolicyTextNormalizationMethod;
  status: PolicyTextNormalizationStatus;
  probablePolicy: boolean;
  requiresInput: boolean;
  warnings: string[];
  canonicalizationHash: string;
}

export interface PolicyTextNormalizationInput {
  text: string;
  knownTokenSymbols?: readonly string[];
}

export interface PolicyTextCanonicalizerInput {
  text: string;
  sourceLanguage: PolicyLanguageCode;
  knownTokenSymbols?: readonly string[];
}

export type PolicyTextCanonicalizer = (
  input: PolicyTextCanonicalizerInput,
) => Promise<
  | string
  | Partial<PolicyTextNormalizationResult>
  | { canonicalEnglish?: unknown; normalizedText?: unknown; warnings?: unknown }
  | null
  | undefined
>;

const DEFAULT_TOKEN_SYMBOLS = ['SOL', 'BTC', 'ETH', 'USDC', 'USDT', 'JUP', 'BONK', 'POPCAT', 'WIF', 'JTO'];

const TRADITIONAL_CHINESE_HINTS = /[當僅於過個價錢費體幣]/u;
const CJK_RE = /[\u3400-\u9fff]/u;
const KANA_RE = /[\u3040-\u30ff]/u;
const HANGUL_RE = /[\uac00-\ud7af]/u;
const CYRILLIC_RE = /[\u0400-\u04ff]/u;
// Latin-script accented letters that do not occur in ordinary English. Used as a
// last-resort signal that policy-looking Latin text is non-English and must be routed
// through canonicalization (and fail closed if it cannot be parsed) rather than silently
// passing as an unparsed English note. Pure-ASCII strings that read as valid English
// (e.g. "SOL minimum $100") intentionally stay English -- the reviewer sees the raw text.
const NON_ENGLISH_LATIN_RE = /[\u00e1\u00e0\u00e2\u00e3\u00e4\u00e9\u00e8\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f3\u00f2\u00f4\u00f5\u00f6\u00fa\u00f9\u00fb\u00fc\u00fd\u00ff\u00f1\u00e7\u00df\u0153\u00e6]/iu;

const LANGUAGE_MARKERS: Array<{ language: PolicyLanguageCode; re: RegExp }> = [
  { language: 'de', re: /\b(genehmigen|nur wenn|über|ueber|größer|groesser|kleiner|preis|tarif|mindestens|höchstens|hoechstens)\b/iu },
  { language: 'it', re: /\b(approva|approvare|solo se|sotto|sopra|superiore|inferiore|prezzo|piano|tariffa|minimo|massimo|almeno)\b/iu },
  { language: 'fr', re: /\b(approuve|approuver|seulement si|dessus|dessous|sup[ée]rieur|inf[ée]rieur|prix|forfait|abonnement|au moins|au plus)\b/iu },
  { language: 'pt', re: /\b(aprova|aprovar|somente se|apenas se|acima|abaixo|pre[çc]o|plano|mensal|m[íi]nimo|m[áa]ximo|pelo menos)\b/iu },
  { language: 'es', re: /\b(aprueba|aprobar|s[oó]lo|encima|debajo|d[oó]lares?|precio|tarifa|m[íi]nimo|m[áa]ximo|al menos|como mucho)\b/iu },
];

const POLICY_MARKERS = [
  /approve|deny|reject|only if|unless|must be|should be|above|below|under|over|less than|more than|greater than|at least|at most|>=?|<=?/iu,
  /批准|核准|拒绝|拒絕|仅当|僅當|只有|高于|高於|大于|大於|低于|低於|小于|小於|超过|超過|以下|以上|套餐|价格|價格|美元/u,
  /承認|承認する|拒否|のみ|場合|以上|以下|未満|超|価格|料金|プラン/u,
  /승인|거부|오직|경우|이상|이하|초과|미만|가격|요금제/u,
  /одобр|отклон|только если|выше|ниже|больше|меньше|цена|тариф/u,
  /\b(aprueba|aprobar|rechaza|rechazar|solo|s[oó]lo|si|encima|debajo|menor|mayor|menos de|m[aá]s de)\b/iu,
  /\b(genehmigen|ablehnen|nur wenn|wenn|unter|über|ueber|mehr als|weniger als|größer|groesser|kleiner)\b/iu,
  /\b(approva|rifiuta|solo se|sotto|sopra|inferiore|superiore|meno di|pi[uù] di)\b/iu,
  /\b(approuve|rejette|seulement si|moins de|plus de|au-dessus|en dessous|sup[ée]rieur|inf[ée]rieur)\b/iu,
  /\b(aprova|rejeita|somente se|apenas se|menos de|mais de|acima|abaixo|maior|menor)\b/iu,
];

const OP_PATTERNS: Array<{ op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'; re: RegExp }> = [
  { op: 'gte', re: />=|at least|no less than|minimum|min(?:i|í)mo|以上|至少|以上|mínimo|minimo|al menos|mindestens|almeno|au moins|pelo menos|이상|минимум|не менее/iu },
  { op: 'lte', re: /<=|at most|no more than|maximum|max(?:i|í)mo|massimo|以下|至多|máximo|maximo|como mucho|höchstens|hoechstens|al massimo|au plus|no máximo|이하|максимум|не более/iu },
  { op: 'gt', re: />|above|over|greater than|more than|高于|高於|大于|大於|超过|超過|por encima de|mayor que|más de|mas de|über|ueber|größer als|groesser als|mehr als|sopra|superiore a|maggiore di|più di|piu di|au-dessus|supérieur à|superieur a|plus de|acima de|maior que|mais de|より高い|超える|초과|보다 높|выше|больше|более/iu },
  { op: 'lt', re: /<|below|under|less than|fewer than|低于|低於|小于|小於|少于|少於|debajo de|por debajo de|menor que|menos de|unter|kleiner als|weniger als|sotto|inferiore a|meno di|en dessous|inférieur à|inferieur a|moins de|abaixo de|menor que|menos de|未満|より低い|미만|보다 낮|ниже|меньше|менее/iu },
  { op: 'eq', re: /=|equal to|equals|is|等于|等於|igual a|gleich|uguale a|égal à|egal a|같|равно/iu },
];

const PLAN_MARKER_RE = /plan|phone plan|monthly plan|subscription|service|bill|fee|cost|price|rate|membership|套餐|手机套餐|手機套餐|订阅|訂閱|月费|月費|プラン|料金|サブスク|요금제|구독|tarifa|suscripci[oó]n|tarif|abonnement|piano|abbonamento|plano|assinatura|тариф|подписка/iu;
const CLAUSE_SPLIT_RE = /(?:[.;。；\n]+|[,，]\s+|[，]|(?:\s+|\b)(?:and|but|or|und|oder|y|o|e|et|ou|pero|aber|ma|mais|и|или)(?:\s+|\b)|且|并且|以及|或者|或|和|または|そして|かつ|그리고|또는)/iu;
const USD_UNIT_RE = /^(?:usd|dollars?|bucks?|美元|美金|달러|ドル|d[oó]lares?|dolares?|доллар(?:ов|а)?|dollar)$/iu;
const UNSUPPORTED_CURRENCY_RE = /[€£¥]|(?:\beur\b|\beuros?\b|\byen\b|\byuan\b|日元|円|元|유로|엔|евро)\b/iu;

export function detectPolicyLanguage(text: string): PolicyLanguageDetection {
  const value = (text ?? '').trim();
  if (!value) {
    return {
      language: 'en',
      confidence: 1,
      isEnglish: true,
      shouldCanonicalize: false,
      probablePolicy: false,
      reason: 'empty',
    };
  }

  const probablePolicy = POLICY_MARKERS.some((re) => re.test(value)) || /\$\s*\d/u.test(value);

  if (KANA_RE.test(value)) return detection('ja', 0.98, probablePolicy, 'kana');
  if (HANGUL_RE.test(value)) return detection('ko', 0.98, probablePolicy, 'hangul');
  if (CYRILLIC_RE.test(value)) return detection('ru', 0.94, probablePolicy, 'cyrillic');
  if (CJK_RE.test(value)) {
    return detection(TRADITIONAL_CHINESE_HINTS.test(value) ? 'zh-Hant' : 'zh-Hans', 0.92, probablePolicy, 'cjk');
  }

  for (const marker of LANGUAGE_MARKERS) {
    if (marker.re.test(value)) return detection(marker.language, 0.72, probablePolicy, 'latin-marker');
  }

  // Safety net: policy-looking Latin text with non-English accents that no marker matched
  // must NOT be assumed English — classify it as an unknown non-English policy so it routes
  // through canonicalization and fails closed if it cannot be turned into atoms.
  if (probablePolicy && NON_ENGLISH_LATIN_RE.test(value)) {
    return detection('unknown', 0.5, probablePolicy, 'non-english-latin');
  }

  return {
    language: 'en',
    confidence: 0.9,
    isEnglish: true,
    shouldCanonicalize: false,
    probablePolicy,
    reason: 'default-english',
  };
}

export function normalizePolicyText(input: PolicyTextNormalizationInput): PolicyTextNormalizationResult {
  const originalText = input.text ?? '';
  const detection = detectPolicyLanguage(originalText);
  if (!detection.shouldCanonicalize) {
    return normalizationResult({
      originalText,
      canonicalEnglish: originalText,
      detection,
      canonicalized: false,
      method: 'none',
      status: 'not_needed',
      warnings: [],
    });
  }

  const deterministic = deterministicCanonicalization(originalText, input.knownTokenSymbols ?? []);
  if (deterministic.lines.length > 0 && deterministic.warnings.length === 0) {
    return normalizationResult({
      originalText,
      canonicalEnglish: deterministic.lines.join('\n'),
      detection,
      canonicalized: true,
      method: 'phrase_pack',
      status: 'success',
      warnings: [],
    });
  }

  const warnings = deterministic.warnings.length > 0
    ? deterministic.warnings
    : detection.probablePolicy
      ? ['Non-English policy-like text could not be canonicalized by the phrase pack.']
      : ['Non-English text did not match a supported policy phrase.'];

  return normalizationResult({
    originalText,
    canonicalEnglish: originalText,
    detection,
    canonicalized: false,
    method: 'phrase_pack',
    status: detection.probablePolicy ? 'failed' : 'not_needed',
    warnings,
  });
}

export function mergeModelPolicyTextNormalization(
  base: PolicyTextNormalizationResult,
  modelResult: Awaited<ReturnType<PolicyTextCanonicalizer>>,
): PolicyTextNormalizationResult {
  const modelRecord = modelResult && typeof modelResult === 'object'
    ? modelResult as Record<string, unknown>
    : undefined;
  const canonicalEnglish = typeof modelResult === 'string'
    ? modelResult
    : typeof modelRecord?.canonicalEnglish === 'string'
      ? modelRecord.canonicalEnglish
      : typeof modelRecord?.normalizedText === 'string'
        ? modelRecord.normalizedText
        : '';
  const trimmed = canonicalEnglish.trim();
  const warnings = Array.isArray(modelRecord?.warnings)
    ? modelRecord.warnings.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (!trimmed) {
    return {
      ...base,
      status: 'failed',
      method: 'model',
      canonicalized: false,
      requiresInput: base.probablePolicy,
      warnings: [...base.warnings, 'Model canonicalization returned no canonical English text.', ...warnings],
    };
  }
  return normalizationResult({
    originalText: base.originalText,
    canonicalEnglish: trimmed,
    detection: {
      language: base.sourceLanguage,
      confidence: base.confidence,
      isEnglish: base.sourceLanguage === 'en',
      shouldCanonicalize: base.sourceLanguage !== 'en',
      probablePolicy: base.probablePolicy,
      reason: 'model',
    },
    canonicalized: true,
    method: 'model',
    status: 'success',
    warnings,
  });
}

export function policyTextHasExtractableAtoms(text: string, knownTokenSymbols: readonly string[] = []): boolean {
  return extractAtoms({ text, knownTokenSymbols: [...knownTokenSymbols] }).atoms.length > 0;
}

/**
 * Canonical user-facing copy for a language-canonicalization fail-closed decision.
 *
 * MIRRORED VERBATIM in the native enforcers (Android `PolicyBundleEnforcer.kt`, iOS
 * `AgenticPolicyBundleEnforcer.swift`) and the browser device-agent enforcer
 * (`apps/browser-demo/src/policyEnrichClient.ts:enforceLanguageNeedsInput`). Those copies
 * cannot import TypeScript, so if you change a string here you MUST update all four.
 */
export const POLICY_LANGUAGE_NEEDS_INPUT_REASON =
  'Agentic could not safely translate this non-English policy rule. Rephrase it or provide the rule in English before approval.';
export const POLICY_LANGUAGE_NEEDS_INPUT_SUMMARY = 'Non-English policy translation needs review.';
export const POLICY_LANGUAGE_MISSING_FACT_ID = 'policy.language.canonicalization';

/** Public wire shape for the language metadata serialized into a policy bundle for clients. */
export interface PolicyLanguageWire {
  sourceLanguage: PolicyLanguageCode;
  canonicalized: boolean;
  canonicalizationMethod: PolicyTextNormalizationMethod;
  canonicalizationStatus: PolicyTextNormalizationStatus;
  requiresInput: boolean;
  confidence: number;
  probablePolicy: boolean;
  canonicalizationHash: string;
  warnings?: string[];
}

/**
 * Serialize the internal normalization result into the public wire shape used by every
 * policy-bundle producer (cloud `/api/policy/enrich` and the MCP review path). Renames
 * `method`→`canonicalizationMethod` and `status`→`canonicalizationStatus` so field names
 * read clearly on the client. Single source of truth — call this from every compactor so
 * the producers cannot drift.
 */
export function compactPolicyLanguageForWire(language: PolicyTextNormalizationResult): PolicyLanguageWire {
  return {
    sourceLanguage: language.sourceLanguage,
    canonicalized: language.canonicalized,
    canonicalizationMethod: language.method,
    canonicalizationStatus: language.status,
    requiresInput: language.requiresInput,
    confidence: language.confidence,
    probablePolicy: language.probablePolicy,
    canonicalizationHash: language.canonicalizationHash,
    ...(language.warnings.length > 0 ? { warnings: language.warnings } : {}),
  };
}

/**
 * Whether a language object (internal OR wire-shaped) signals a fail-closed canonicalization
 * failure. Accepts both the raw `status` and the renamed `canonicalizationStatus` so it works
 * on either side of the wire. Mirrors the predicate baked into the browser/native enforcers.
 */
export function policyLanguageRequiresInput(language: unknown): boolean {
  if (!language || typeof language !== 'object') return false;
  const record = language as Record<string, unknown>;
  return record.requiresInput === true ||
    record.canonicalizationStatus === 'failed' ||
    record.status === 'failed';
}

function detection(
  language: PolicyLanguageCode,
  confidence: number,
  probablePolicy: boolean,
  reason: string,
): PolicyLanguageDetection {
  return {
    language,
    confidence,
    isEnglish: language === 'en',
    shouldCanonicalize: language !== 'en',
    probablePolicy,
    reason,
  };
}

function normalizationResult(input: {
  originalText: string;
  canonicalEnglish: string;
  detection: PolicyLanguageDetection;
  canonicalized: boolean;
  method: PolicyTextNormalizationMethod;
  status: PolicyTextNormalizationStatus;
  warnings: string[];
}): PolicyTextNormalizationResult {
  const canonicalEnglish = input.canonicalEnglish.trim();
  const requiresInput = input.status === 'failed' && input.detection.probablePolicy;
  return {
    originalText: input.originalText,
    canonicalEnglish,
    sourceLanguage: input.detection.language,
    confidence: input.detection.confidence,
    canonicalized: input.canonicalized,
    method: input.method,
    status: input.status,
    probablePolicy: input.detection.probablePolicy,
    requiresInput,
    warnings: input.warnings,
    canonicalizationHash: hashString(`${input.detection.language}:${canonicalEnglish}`),
  };
}

function deterministicCanonicalization(text: string, knownTokenSymbols: readonly string[]): { lines: string[]; warnings: string[] } {
  const lines: string[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  const clauses = policyClauses(text);

  for (const clause of clauses) {
    const clauseLines = canonicalLinesForClause(clause, knownTokenSymbols);
    if (clauseLines.length === 0 && clauseRequiresCanonicalization(clause, knownTokenSymbols)) {
      warnings.push(`Unsupported non-English policy clause: "${compactClauseForWarning(clause)}".`);
      continue;
    }
    for (const line of clauseLines) {
      const key = line.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        lines.push(line);
      }
    }
  }
  return { lines, warnings };
}

function canonicalLinesForClause(clause: string, knownTokenSymbols: readonly string[]): string[] {
  return [
    ...extractPriceCanonicalLines(clause, knownTokenSymbols),
    ...extractExternalPriceCanonicalLines(clause),
    ...extractTxGateCanonicalLines(clause),
    ...extractTokenAuditCanonicalLines(clause),
  ];
}

function policyClauses(text: string): string[] {
  const clauses = text
    .split(CLAUSE_SPLIT_RE)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return clauses.length > 0 ? clauses : [text.trim()].filter(Boolean);
}

function clauseRequiresCanonicalization(clause: string, knownTokenSymbols: readonly string[]): boolean {
  const value = clause.trim();
  if (!value || isApprovalOnlyClause(value) || isFillerClause(value)) return false;
  if (UNSUPPORTED_CURRENCY_RE.test(value)) return true;
  if (containsKnownToken(value, knownTokenSymbols) && (comparisonLike(value) || moneyLike(value))) return true;
  if (PLAN_MARKER_RE.test(value) && (comparisonLike(value) || moneyLike(value))) return true;
  if (tokenAuditLike(value) || txGateLike(value)) return true;
  if ((CJK_RE.test(value) || KANA_RE.test(value) || HANGUL_RE.test(value) || CYRILLIC_RE.test(value)) && policyClauseLike(value)) return true;
  if (NON_ENGLISH_LATIN_RE.test(value) && policyClauseLike(value)) return true;
  if (LANGUAGE_MARKERS.some((marker) => marker.re.test(value)) && (policyClauseLike(value) || moneyLike(value))) return true;
  return false;
}

function isApprovalOnlyClause(clause: string): boolean {
  const normalized = clause
    .replace(/\b(?:approve|approved|approval|deny|reject|only|if|when|then|please|por favor|solo|s[oó]lo|se|si|wenn|nur|genehmigen|approva|approuve|aprova)\b/giu, '')
    .replace(/(?:仅当|僅當|只有|时|時|才|批准|核准|承認|のみ|場合|승인|경우|одобрить|только|если)/gu, '')
    .replace(/[^\p{L}\p{N}$€£¥<>.=]+/gu, '')
    .trim();
  return normalized.length === 0;
}

function isFillerClause(clause: string): boolean {
  return /^(?:please|por favor|请|請|帮我|幫我|お願いします|por\s+favor)$/iu.test(clause.trim());
}

function containsKnownToken(text: string, knownTokenSymbols: readonly string[]): boolean {
  const symbols = Array.from(new Set([...DEFAULT_TOKEN_SYMBOLS, ...knownTokenSymbols.map((s) => s.toUpperCase())]));
  return symbols.some((symbol) => new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'iu').test(text));
}

function comparisonLike(text: string): boolean {
  return OP_PATTERNS.some((pattern) => {
    pattern.re.lastIndex = 0;
    return pattern.re.test(text);
  });
}

function moneyLike(text: string): boolean {
  return /[$€£¥]\s*\d|\d+(?:[.,]\d+)?\s*(?:usd|dollars?|bucks?|美元|美金|달러|ドル|d[oó]lares?|dolares?|eur|euros?|доллар(?:ов|а)?)/iu.test(text);
}

function policyClauseLike(text: string): boolean {
  return POLICY_MARKERS.some((re) => re.test(text)) || /条件|條件|满足|滿足|condition|condici[oó]n|bedingung|condizione|condiç[aã]o|услови/iu.test(text);
}

function tokenAuditLike(text: string): boolean {
  return /mint|freeze|authority|铸币|鑄幣|冻结|凍結|acuñación|congelación|cunhagem|congelamento|berechtigung|autorità|autorité|ミント|フリーズ|凍結|권한|минтинг|замороз/iu.test(text);
}

function txGateLike(text: string): boolean {
  return /transfer|recipient|instruction|转账|轉帳|收款人|接收者|指令|transferencia|destinatario|instrucci[oó]n|transfert|destinataire|instruction|전송|수신자|명령|перевод|получател|送金|転送|受取人|指示/iu.test(text);
}

function compactClauseForWarning(clause: string): string {
  return clause.replace(/\s+/g, ' ').slice(0, 120);
}

function extractPriceCanonicalLines(text: string, knownTokenSymbols: readonly string[]): string[] {
  const symbols = Array.from(new Set([...DEFAULT_TOKEN_SYMBOLS, ...knownTokenSymbols.map((s) => s.toUpperCase())]));
  const lines: string[] = [];
  for (const symbol of symbols) {
    const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'giu');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const start = Math.max(0, match.index - 60);
      const end = Math.min(text.length, match.index + symbol.length + 120);
      const window = text.slice(start, end);
      const comparison = findBestComparison(window, match.index - start, match.index - start);
      if (!comparison) continue;
      lines.push(`${symbol} is ${operatorPhrase(comparison.op)} ${comparison.value}.`);
    }
  }
  return lines;
}

function extractExternalPriceCanonicalLines(text: string): string[] {
  const marker = findPlanMarker(text);
  if (!marker) return [];
  const comparison = findBestComparison(text, marker.index, 0);
  if (!comparison) return [];
  const subject = externalSubject(text);
  return [`${subject} is ${operatorPhrase(comparison.op)} ${comparison.value}.`];
}

function extractTxGateCanonicalLines(text: string): string[] {
  const lines: string[] = [];
  if (/no\s+extra\s+transfers?|no\s+additional\s+transfers?|不要额外转账|不要額外轉帳|无额外转账|無額外轉帳|sin\s+transferencias\s+extra|keine\s+zusätzlichen\s+transfers|keine\s+zusaetzlichen\s+transfers|nessun\s+trasferimento\s+extra|aucun\s+transfert\s+supplémentaire|aucun\s+transfert\s+supplementaire|sem\s+transferências\s+extras|추가\s*전송\s*없|без\s+дополнительных\s+переводов|(?:追加|余分)の(?:送金|転送)(?:なし|禁止)/iu.test(text)) {
    lines.push('no extra transfers');
  }
  if (/no\s+unknown\s+recipients?|未知收款人|未知接收者|destinatarios\s+desconocidos|unbekannte\s+empfänger|unbekannte\s+empfaenger|destinatari\s+sconosciuti|destinataires\s+inconnus|destinatários\s+desconhecidos|알\s*수\s*없는\s*수신자|неизвестных\s+получателей|不明な(?:受取人|受信者|宛先)/iu.test(text)) {
    lines.push('no unknown recipients');
  }
  if (/no\s+unrelated\s+instructions?|不相关指令|不相關指令|instrucciones\s+no\s+relacionadas|unbezogene\s+anweisungen|istruzioni\s+non\s+correlate|instructions\s+sans\s+rapport|instruções\s+não\s+relacionadas|관련\s*없는\s*명령|посторонних\s+инструкций|無関係な(?:命令|指示)/iu.test(text)) {
    lines.push('no unrelated instructions');
  }
  return lines;
}

function extractTokenAuditCanonicalLines(text: string): string[] {
  const lines: string[] = [];
  if (/mint\s+authority\s+(disabled|null|revoked|none|removed)|铸币权限(已)?(禁用|撤销|移除)|鑄幣權限(已)?(停用|撤銷|移除)|autoridad\s+de\s+acuñación\s+(deshabilitada|revocada)|autoridade\s+de\s+cunhagem\s+(desativada|revogada)|mint-berechtigung\s+(deaktiviert|widerrufen)|autorità\s+di\s+mint\s+(disabilitata|revocata)|autorité\s+de\s+mint\s+(désactivée|révoquée)|ミント権限.*(無効|取り消し|取消|削除)|권한.*(비활성|철회)|право\s+минтинга\s+(отключено|отозвано)/iu.test(text)) {
    lines.push('mint authority disabled');
  }
  if (/freeze\s+authority\s+(disabled|null|revoked|none|removed)|冻结权限(已)?(禁用|撤销|移除)|凍結權限(已)?(停用|撤銷|移除)|autoridad\s+de\s+congelación\s+(deshabilitada|revocada)|autoridade\s+de\s+congelamento\s+(desativada|revogada)|freeze-berechtigung\s+(deaktiviert|widerrufen)|autorità\s+di\s+freeze\s+(disabilitata|revocata)|autorité\s+de\s+gel\s+(désactivée|révoquée)|(フリーズ|凍結)権限.*(無効|取り消し|取消|削除)|동결.*권한.*(비활성|철회)|право\s+заморозки\s+(отключено|отозвано)/iu.test(text)) {
    lines.push('freeze authority disabled');
  }
  return lines;
}

function findBestComparison(
  text: string,
  anchorIndex: number,
  minNumberIndex: number,
): { op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'; value: string } | null {
  const candidates: Array<{
    op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
    value: string;
    distance: number;
    matchIndex: number;
    matchLength: number;
    beforePenalty: number;
  }> = [];

  for (const pattern of OP_PATTERNS) {
    const re = globalRegExp(pattern.re);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const after = numberAfter(text, match.index + match[0].length, match.index + match[0].length + 60);
      if (after) {
        candidates.push({
          op: pattern.op,
          value: after.value,
          distance: Math.abs(match.index - anchorIndex) + Math.abs(after.index - anchorIndex),
          matchIndex: match.index,
          matchLength: match[0].length,
          beforePenalty: 0,
        });
      }
      const before = numberBefore(text, Math.max(minNumberIndex, match.index - 60), match.index);
      if (before) {
        candidates.push({
          op: pattern.op,
          value: before.value,
          distance: Math.abs(match.index - anchorIndex) + Math.abs(before.index - anchorIndex),
          matchIndex: match.index,
          matchLength: match[0].length,
          beforePenalty: 8,
        });
      }
    }
  }

  candidates.sort((a, b) =>
    a.distance - b.distance ||
    a.beforePenalty - b.beforePenalty ||
    b.matchLength - a.matchLength ||
    a.matchIndex - b.matchIndex,
  );
  const best = candidates[0];
  return best ? { op: best.op, value: best.value } : null;
}

function globalRegExp(re: RegExp): RegExp {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return new RegExp(re.source, flags);
}

const NUMBER_RE = /([$€£¥])?\s*(\d+(?:[.,]\d+)?)(?:\s*(usd|dollars?|bucks?|美元|美金|달러|ドル|d[oó]lares?|dolares?|eur|euros?|доллар(?:ов|а)?))?/giu;

function numberAfter(text: string, start: number, end: number): { value: string; index: number } | null {
  const slice = text.slice(start, Math.min(text.length, end));
  NUMBER_RE.lastIndex = 0;
  const match = NUMBER_RE.exec(slice);
  return match ? parsedNumber(match, start + match.index) : null;
}

function numberBefore(text: string, start: number, end: number): { value: string; index: number } | null {
  const slice = text.slice(Math.max(0, start), Math.max(0, end));
  NUMBER_RE.lastIndex = 0;
  let current: { value: string; index: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_RE.exec(slice)) !== null) {
    current = parsedNumber(match, Math.max(0, start) + match.index) ?? current;
  }
  return current;
}

function parsedNumber(match: RegExpExecArray, index: number): { value: string; index: number } | null {
  const currency = match[1] ?? '';
  const rawNumber = match[2] ?? '';
  const unit = match[3] ?? '';
  if (!rawNumber || /[€£¥]/u.test(currency) || (unit && !USD_UNIT_RE.test(unit))) return null;
  const normalized = rawNumber.replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const prefix = currency === '$' || USD_UNIT_RE.test(unit) ? '$' : '';
  return { value: `${prefix}${normalized}`, index };
}

function findPlanMarker(text: string): { index: number } | null {
  const re = globalRegExp(PLAN_MARKER_RE);
  const match = re.exec(text);
  return match ? { index: match.index } : null;
}

function operatorPhrase(op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'): string {
  switch (op) {
    case 'gt': return 'above';
    case 'gte': return 'at least';
    case 'lt': return 'under';
    case 'lte': return 'at most';
    case 'eq': return 'equal to';
  }
}

function externalSubject(text: string): string {
  if (/\bhelium\b/iu.test(text)) return 'Helium monthly plan';
  if (/\bt-?mobile\b/iu.test(text)) return 'T-Mobile monthly plan';
  const beforeMarker = text.split(PLAN_MARKER_RE)[0] ?? '';
  const brand = beforeMarker.match(/\b([A-Z][A-Za-z0-9-]{1,24})(?:\s+[A-Z][A-Za-z0-9-]{1,24}){0,2}\s*$/u)?.[0]?.trim();
  return brand ? `${brand} monthly plan` : 'Monthly plan';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
