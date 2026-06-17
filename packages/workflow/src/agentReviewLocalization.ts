import {
  detectPolicyLanguage,
  POLICY_LANGUAGE_CODES,
  type PolicyLanguageCode,
} from './policyLanguage.js';

export type AgentReviewLocalizationStatus = 'ready' | 'failed';
export type AgentReviewLocalizationSource = 'model' | 'phrase_pack';

export interface AgentReviewLocalizedFinding {
  index: number;
  atomId?: string;
  label?: string;
  value?: string;
}

export interface AgentReviewLocalizedQuestion {
  id: string;
  prompt?: string;
  hint?: string;
  options?: string[];
}

export interface AgentReviewLocalizedReviewer {
  id?: string;
  label?: string;
  reason?: string;
  summary?: string;
}

export interface AgentReviewLocalizedPolicy {
  index: number;
  label?: string;
  ruleText?: string;
}

export interface AgentReviewLocalizedFact {
  key: string;
  message?: string;
}

export interface AgentReviewLocalizedCounterfactual {
  index: number;
  rationale?: string;
}

export interface AgentReviewLocalizedCopy {
  language: PolicyLanguageCode;
  status: AgentReviewLocalizationStatus;
  source: AgentReviewLocalizationSource;
  canonicalHash?: string;
  generatedAt?: string;
  reason?: string;
  summary?: string;
  findings?: AgentReviewLocalizedFinding[];
  questions?: AgentReviewLocalizedQuestion[];
  reviewers?: AgentReviewLocalizedReviewer[];
  policies?: AgentReviewLocalizedPolicy[];
  facts?: AgentReviewLocalizedFact[];
  counterfactuals?: AgentReviewLocalizedCounterfactual[];
  error?: string;
}

type LocalizedStringMap = Partial<Record<PolicyLanguageCode, string>>;

export type AgentReviewLocalizedLabelKey =
  | 'summary'
  | 'approvalSummary'
  | 'denialReason'
  | 'missingInformation'
  | 'walletRequired'
  | 'reviewError'
  | 'reviewStatus'
  | 'reviewState'
  | 'reason'
  | 'decision'
  | 'marketAndPrice'
  | 'tokenSafety'
  | 'transactionSafety'
  | 'sources'
  | 'advancedAudit'
  | 'otherChecks'
  | 'missingInput'
  | 'requestedInput'
  | 'staleReview'
  | 'whyItPassed'
  | 'blockingReason'
  | 'needsInput'
  | 'reviewDetails'
  | 'agentFindings'
  | 'pass'
  | 'fail'
  | 'wallet'
  | 'review'
  | 'reviewPassed'
  | 'reviewDenied'
  | 'reviewNeedsInput'
  | 'reviewChecking'
  | 'agentReviewFailed'
  | 'noFindings';

export type LocalizableAgentReview = {
  reason?: string;
  summary?: string;
  evidence?: Record<string, unknown>;
  localized?: AgentReviewLocalizedCopy;
  questions?: Array<{ id?: string; prompt?: string; hint?: string; options?: string[] }>;
  reviewers?: Array<{ id?: string; label?: string; reason?: string; summary?: string }>;
  policies?: Array<{ label?: string; ruleText?: string; outcome?: string }>;
  // `object` (not a string-indexed Record) so a caller's known-keys fact map
  // (e.g. Partial<Record<DeterministicFactKey, …>>) assigns cleanly; read via factSourceMessages.
  facts?: object;
  auditReceipt?: { counterfactualSummary?: Array<{ rationale?: string }> };
};

const NON_LOCALIZED_LANGUAGES = new Set<PolicyLanguageCode>(['en', 'unknown']);
const LANGUAGE_SET = new Set<PolicyLanguageCode>(POLICY_LANGUAGE_CODES);

const ENGLISH_LABELS: Record<AgentReviewLocalizedLabelKey, string> = {
  summary: 'Summary',
  approvalSummary: 'Approval summary',
  denialReason: 'Denial reason',
  missingInformation: 'Missing information',
  walletRequired: 'Wallet required',
  reviewError: 'Review error',
  reviewStatus: 'Review status',
  reviewState: 'Review state',
  reason: 'Reason',
  decision: 'Decision',
  marketAndPrice: 'Market & Price',
  tokenSafety: 'Token Safety',
  transactionSafety: 'Transaction Safety',
  sources: 'Sources',
  advancedAudit: 'Advanced Audit',
  otherChecks: 'Other Checks',
  missingInput: 'Missing input',
  requestedInput: 'Requested input',
  staleReview: 'Stale review',
  whyItPassed: 'Why it passed',
  blockingReason: 'Blocking reason',
  needsInput: 'Needs input',
  reviewDetails: 'Review details',
  agentFindings: 'Agent findings',
  pass: 'Pass',
  fail: 'Fail',
  wallet: 'Wallet',
  review: 'Review',
  reviewPassed: 'Review passed',
  reviewDenied: 'Review denied',
  reviewNeedsInput: 'Review needs input',
  reviewChecking: 'Review checking',
  agentReviewFailed: 'Agent review failed',
  noFindings: 'No findings were returned by the agent.',
};

const LABELS: Record<PolicyLanguageCode, Partial<Record<AgentReviewLocalizedLabelKey, string>>> = {
  en: {},
  unknown: {},
  'zh-Hans': {
    summary: '摘要',
    approvalSummary: '批准摘要',
    denialReason: '拒绝原因',
    missingInformation: '缺少信息',
    walletRequired: '需要连接钱包',
    reviewError: '审核错误',
    reviewStatus: '审核状态',
    reviewState: '审核状态',
    reason: '原因',
    decision: '决策',
    marketAndPrice: '市场与价格',
    tokenSafety: '代币安全',
    transactionSafety: '交易安全',
    sources: '来源',
    advancedAudit: '高级审计',
    otherChecks: '其他检查',
    missingInput: '缺少输入',
    requestedInput: '请求输入',
    staleReview: '审核已过期',
    whyItPassed: '通过原因',
    blockingReason: '阻止原因',
    needsInput: '需要输入',
    reviewDetails: '审核详情',
    agentFindings: 'Agent 检查结果',
    pass: '通过',
    fail: '失败',
    wallet: '钱包',
    review: '审核',
    reviewPassed: '审核通过',
    reviewDenied: '审核拒绝',
    reviewNeedsInput: '审核需要输入',
    reviewChecking: '正在审核',
    agentReviewFailed: 'Agent 审核失败',
    noFindings: 'Agent 没有返回检查结果。',
  },
  'zh-Hant': {
    summary: '摘要',
    approvalSummary: '核准摘要',
    denialReason: '拒絕原因',
    missingInformation: '缺少資訊',
    walletRequired: '需要連接錢包',
    reviewError: '審核錯誤',
    reviewStatus: '審核狀態',
    reviewState: '審核狀態',
    reason: '原因',
    decision: '決策',
    marketAndPrice: '市場與價格',
    tokenSafety: '代幣安全',
    transactionSafety: '交易安全',
    sources: '來源',
    advancedAudit: '進階審計',
    otherChecks: '其他檢查',
    missingInput: '缺少輸入',
    requestedInput: '要求輸入',
    staleReview: '審核已過期',
    whyItPassed: '通過原因',
    blockingReason: '阻止原因',
    needsInput: '需要輸入',
    reviewDetails: '審核詳情',
    agentFindings: 'Agent 檢查結果',
    pass: '通過',
    fail: '失敗',
    wallet: '錢包',
    review: '審核',
    reviewPassed: '審核通過',
    reviewDenied: '審核拒絕',
    reviewNeedsInput: '審核需要輸入',
    reviewChecking: '正在審核',
    agentReviewFailed: 'Agent 審核失敗',
    noFindings: 'Agent 沒有返回檢查結果。',
  },
  es: {
    summary: 'Resumen',
    approvalSummary: 'Resumen de aprobación',
    denialReason: 'Motivo del rechazo',
    missingInformation: 'Información faltante',
    walletRequired: 'Wallet requerido',
    reviewError: 'Error de revisión',
    reviewStatus: 'Estado de revisión',
    reviewState: 'Estado de revisión',
    reason: 'Motivo',
    decision: 'Decisión',
    marketAndPrice: 'Mercado y precio',
    tokenSafety: 'Seguridad del token',
    transactionSafety: 'Seguridad de la transacción',
    sources: 'Fuentes',
    advancedAudit: 'Auditoría avanzada',
    otherChecks: 'Otras comprobaciones',
    missingInput: 'Entrada faltante',
    requestedInput: 'Entrada solicitada',
    staleReview: 'Revisión desactualizada',
    whyItPassed: 'Por qué pasó',
    blockingReason: 'Motivo bloqueante',
    needsInput: 'Necesita datos',
    reviewDetails: 'Detalles de revisión',
    agentFindings: 'Hallazgos del agente',
    pass: 'Pasa',
    fail: 'Falla',
    wallet: 'Wallet',
    review: 'Revisión',
    reviewPassed: 'Revisión aprobada',
    reviewDenied: 'Revisión rechazada',
    reviewNeedsInput: 'La revisión necesita datos',
    reviewChecking: 'Revisando',
    agentReviewFailed: 'Falló la revisión del agente',
    noFindings: 'El agente no devolvió hallazgos.',
  },
  ja: {
    summary: '要約',
    approvalSummary: '承認の要約',
    denialReason: '拒否理由',
    missingInformation: '不足情報',
    walletRequired: 'ウォレットが必要',
    reviewError: 'レビューエラー',
    reviewStatus: 'レビュー状態',
    reviewState: 'レビュー状態',
    reason: '理由',
    decision: '判断',
    marketAndPrice: '市場と価格',
    tokenSafety: 'トークン安全性',
    transactionSafety: '取引安全性',
    sources: '出典',
    advancedAudit: '詳細監査',
    otherChecks: 'その他の確認',
    missingInput: '不足入力',
    requestedInput: '要求された入力',
    staleReview: '古いレビュー',
    whyItPassed: '通過理由',
    blockingReason: 'ブロック理由',
    needsInput: '入力が必要',
    reviewDetails: 'レビュー詳細',
    agentFindings: 'エージェントの確認結果',
    pass: '通過',
    fail: '失敗',
    wallet: 'ウォレット',
    review: 'レビュー',
    reviewPassed: 'レビュー通過',
    reviewDenied: 'レビュー拒否',
    reviewNeedsInput: 'レビューに入力が必要',
    reviewChecking: 'レビュー中',
    agentReviewFailed: 'エージェントレビュー失敗',
    noFindings: 'エージェントは確認結果を返しませんでした。',
  },
  de: {
    summary: 'Zusammenfassung',
    approvalSummary: 'Genehmigungszusammenfassung',
    denialReason: 'Ablehnungsgrund',
    missingInformation: 'Fehlende Informationen',
    walletRequired: 'Wallet erforderlich',
    reviewError: 'Prüfungsfehler',
    reviewStatus: 'Prüfstatus',
    reviewState: 'Prüfstatus',
    reason: 'Grund',
    decision: 'Entscheidung',
    marketAndPrice: 'Markt & Preis',
    tokenSafety: 'Token-Sicherheit',
    transactionSafety: 'Transaktionssicherheit',
    sources: 'Quellen',
    advancedAudit: 'Erweitertes Audit',
    otherChecks: 'Weitere Prüfungen',
    missingInput: 'Fehlende Eingabe',
    requestedInput: 'Angeforderte Eingabe',
    staleReview: 'Veraltete Prüfung',
    whyItPassed: 'Warum bestanden',
    blockingReason: 'Blockierender Grund',
    needsInput: 'Eingabe nötig',
    reviewDetails: 'Prüfdetails',
    agentFindings: 'Agent-Prüfergebnisse',
    pass: 'Bestanden',
    fail: 'Fehlgeschlagen',
    wallet: 'Wallet',
    review: 'Prüfung',
    reviewPassed: 'Prüfung bestanden',
    reviewDenied: 'Prüfung abgelehnt',
    reviewNeedsInput: 'Prüfung braucht Eingabe',
    reviewChecking: 'Prüfung läuft',
    agentReviewFailed: 'Agent-Prüfung fehlgeschlagen',
    noFindings: 'Der Agent hat keine Prüfergebnisse zurückgegeben.',
  },
  it: {
    summary: 'Riepilogo',
    approvalSummary: 'Riepilogo approvazione',
    denialReason: 'Motivo del rifiuto',
    missingInformation: 'Informazioni mancanti',
    walletRequired: 'Wallet richiesto',
    reviewError: 'Errore di revisione',
    reviewStatus: 'Stato revisione',
    reviewState: 'Stato revisione',
    reason: 'Motivo',
    decision: 'Decisione',
    marketAndPrice: 'Mercato e prezzo',
    tokenSafety: 'Sicurezza token',
    transactionSafety: 'Sicurezza transazione',
    sources: 'Fonti',
    advancedAudit: 'Audit avanzato',
    otherChecks: 'Altri controlli',
    missingInput: 'Input mancante',
    requestedInput: 'Input richiesto',
    staleReview: 'Revisione scaduta',
    whyItPassed: 'Perché è passata',
    blockingReason: 'Motivo bloccante',
    needsInput: 'Serve input',
    reviewDetails: 'Dettagli revisione',
    agentFindings: 'Risultati dell’agente',
    pass: 'Passa',
    fail: 'Fallisce',
    wallet: 'Wallet',
    review: 'Revisione',
    reviewPassed: 'Revisione superata',
    reviewDenied: 'Revisione rifiutata',
    reviewNeedsInput: 'La revisione richiede input',
    reviewChecking: 'Revisione in corso',
    agentReviewFailed: 'Revisione agente fallita',
    noFindings: 'L’agente non ha restituito risultati.',
  },
  fr: {
    summary: 'Résumé',
    approvalSummary: 'Résumé d’approbation',
    denialReason: 'Motif du refus',
    missingInformation: 'Informations manquantes',
    walletRequired: 'Wallet requis',
    reviewError: 'Erreur de vérification',
    reviewStatus: 'État de vérification',
    reviewState: 'État de vérification',
    reason: 'Motif',
    decision: 'Décision',
    marketAndPrice: 'Marché et prix',
    tokenSafety: 'Sécurité du token',
    transactionSafety: 'Sécurité de la transaction',
    sources: 'Sources',
    advancedAudit: 'Audit avancé',
    otherChecks: 'Autres vérifications',
    missingInput: 'Entrée manquante',
    requestedInput: 'Entrée demandée',
    staleReview: 'Vérification périmée',
    whyItPassed: 'Pourquoi c’est validé',
    blockingReason: 'Motif bloquant',
    needsInput: 'Entrée nécessaire',
    reviewDetails: 'Détails de vérification',
    agentFindings: 'Constats de l’agent',
    pass: 'Réussi',
    fail: 'Échec',
    wallet: 'Wallet',
    review: 'Vérification',
    reviewPassed: 'Vérification réussie',
    reviewDenied: 'Vérification refusée',
    reviewNeedsInput: 'La vérification nécessite une entrée',
    reviewChecking: 'Vérification en cours',
    agentReviewFailed: 'Échec de la vérification agent',
    noFindings: 'L’agent n’a renvoyé aucun constat.',
  },
  pt: {
    summary: 'Resumo',
    approvalSummary: 'Resumo da aprovação',
    denialReason: 'Motivo da recusa',
    missingInformation: 'Informações ausentes',
    walletRequired: 'Wallet necessária',
    reviewError: 'Erro de revisão',
    reviewStatus: 'Status da revisão',
    reviewState: 'Status da revisão',
    reason: 'Motivo',
    decision: 'Decisão',
    marketAndPrice: 'Mercado e preço',
    tokenSafety: 'Segurança do token',
    transactionSafety: 'Segurança da transação',
    sources: 'Fontes',
    advancedAudit: 'Auditoria avançada',
    otherChecks: 'Outras verificações',
    missingInput: 'Entrada ausente',
    requestedInput: 'Entrada solicitada',
    staleReview: 'Revisão desatualizada',
    whyItPassed: 'Por que passou',
    blockingReason: 'Motivo bloqueante',
    needsInput: 'Precisa de entrada',
    reviewDetails: 'Detalhes da revisão',
    agentFindings: 'Achados do agente',
    pass: 'Passou',
    fail: 'Falhou',
    wallet: 'Wallet',
    review: 'Revisão',
    reviewPassed: 'Revisão aprovada',
    reviewDenied: 'Revisão negada',
    reviewNeedsInput: 'A revisão precisa de entrada',
    reviewChecking: 'Revisando',
    agentReviewFailed: 'Falha na revisão do agente',
    noFindings: 'O agente não retornou achados.',
  },
  ko: {
    summary: '요약',
    approvalSummary: '승인 요약',
    denialReason: '거부 이유',
    missingInformation: '누락된 정보',
    walletRequired: '월렛 필요',
    reviewError: '검토 오류',
    reviewStatus: '검토 상태',
    reviewState: '검토 상태',
    reason: '이유',
    decision: '결정',
    marketAndPrice: '시장 및 가격',
    tokenSafety: '토큰 안전성',
    transactionSafety: '거래 안전성',
    sources: '출처',
    advancedAudit: '고급 감사',
    otherChecks: '기타 확인',
    missingInput: '누락된 입력',
    requestedInput: '요청된 입력',
    staleReview: '오래된 검토',
    whyItPassed: '통과 이유',
    blockingReason: '차단 이유',
    needsInput: '입력 필요',
    reviewDetails: '검토 세부 정보',
    agentFindings: '에이전트 확인 결과',
    pass: '통과',
    fail: '실패',
    wallet: '월렛',
    review: '검토',
    reviewPassed: '검토 통과',
    reviewDenied: '검토 거부',
    reviewNeedsInput: '검토에 입력 필요',
    reviewChecking: '검토 중',
    agentReviewFailed: '에이전트 검토 실패',
    noFindings: '에이전트가 확인 결과를 반환하지 않았습니다.',
  },
  ru: {
    summary: 'Сводка',
    approvalSummary: 'Сводка одобрения',
    denialReason: 'Причина отказа',
    missingInformation: 'Недостающая информация',
    walletRequired: 'Требуется кошелек',
    reviewError: 'Ошибка проверки',
    reviewStatus: 'Статус проверки',
    reviewState: 'Статус проверки',
    reason: 'Причина',
    decision: 'Решение',
    marketAndPrice: 'Рынок и цена',
    tokenSafety: 'Безопасность токена',
    transactionSafety: 'Безопасность транзакции',
    sources: 'Источники',
    advancedAudit: 'Расширенный аудит',
    otherChecks: 'Другие проверки',
    missingInput: 'Недостающий ввод',
    requestedInput: 'Запрошенный ввод',
    staleReview: 'Устаревшая проверка',
    whyItPassed: 'Почему прошло',
    blockingReason: 'Блокирующая причина',
    needsInput: 'Нужен ввод',
    reviewDetails: 'Детали проверки',
    agentFindings: 'Выводы агента',
    pass: 'Прошло',
    fail: 'Ошибка',
    wallet: 'Кошелек',
    review: 'Проверка',
    reviewPassed: 'Проверка пройдена',
    reviewDenied: 'Проверка отклонена',
    reviewNeedsInput: 'Проверке нужен ввод',
    reviewChecking: 'Проверка идет',
    agentReviewFailed: 'Проверка агента не удалась',
    noFindings: 'Агент не вернул выводов.',
  },
};

const FINDING_LABELS: Record<string, Partial<Record<PolicyLanguageCode, string>>> = {
  thresholdcheck: {
    'zh-Hans': '阈值检查',
    'zh-Hant': '門檻檢查',
    es: 'Comprobación del umbral',
    ja: 'しきい値チェック',
    de: 'Schwellenwertprüfung',
    it: 'Controllo soglia',
    fr: 'Vérification du seuil',
    pt: 'Verificação do limite',
    ko: '임계값 확인',
    ru: 'Проверка порога',
  },
  monthlyrate: {
    'zh-Hans': '月费',
    'zh-Hant': '月費',
    es: 'Tarifa mensual',
    ja: '月額料金',
    de: 'Monatsrate',
    it: 'Tariffa mensile',
    fr: 'Tarif mensuel',
    pt: 'Tarifa mensal',
    ko: '월 요금',
    ru: 'Месячная ставка',
  },
  planrate: {
    'zh-Hans': '套餐价格',
    'zh-Hant': '方案價格',
    es: 'Precio del plan',
    ja: 'プラン料金',
    de: 'Tarifpreis',
    it: 'Prezzo del piano',
    fr: 'Prix du forfait',
    pt: 'Preço do plano',
    ko: '요금제 가격',
    ru: 'Цена тарифа',
  },
  subscriptionprice: {
    'zh-Hans': '订阅价格',
    'zh-Hant': '訂閱價格',
    es: 'Precio de suscripción',
    ja: 'サブスク価格',
    de: 'Abo-Preis',
    it: 'Prezzo abbonamento',
    fr: 'Prix d’abonnement',
    pt: 'Preço da assinatura',
    ko: '구독 가격',
    ru: 'Цена подписки',
  },
  currentprice: {
    'zh-Hans': '当前价格',
    'zh-Hant': '目前價格',
    es: 'Precio actual',
    ja: '現在価格',
    de: 'Aktueller Preis',
    it: 'Prezzo attuale',
    fr: 'Prix actuel',
    pt: 'Preço atual',
    ko: '현재 가격',
    ru: 'Текущая цена',
  },
  currentresearch: {
    'zh-Hans': '当前查询',
    'zh-Hant': '目前查詢',
    es: 'Investigación actual',
    ja: '現在の調査',
    de: 'Aktuelle Recherche',
    it: 'Ricerca attuale',
    fr: 'Recherche actuelle',
    pt: 'Pesquisa atual',
    ko: '현재 조사',
    ru: 'Текущее исследование',
  },
};

const COMMON_FINDING_LABELS: Record<string, LocalizedStringMap> = {
  connectedwallet: translations('连接的钱包', '連接的錢包', 'Wallet conectado', '接続ウォレット', 'Verbundenes Wallet', 'Wallet connesso', 'Wallet connecté', 'Wallet conectado', '연결된 월렛', 'Подключенный кошелек'),
  transactionsimulation: translations('交易模拟', '交易模擬', 'Simulación de transacción', '取引シミュレーション', 'Transaktionssimulation', 'Simulazione transazione', 'Simulation de transaction', 'Simulação da transação', '거래 시뮬레이션', 'Симуляция транзакции'),
  decisioncontract: translations('决策合约', '決策合約', 'Contrato de decisión', '判断コントラクト', 'Entscheidungsvertrag', 'Contratto decisionale', 'Contrat de décision', 'Contrato de decisão', '결정 계약', 'Контракт решения'),
  confidence: translations('置信度', '信心度', 'Confianza', '信頼度', 'Konfidenz', 'Confidenza', 'Confiance', 'Confiança', '신뢰도', 'Уверенность'),
  citedevidenceids: translations('引用的证据 ID', '引用的證據 ID', 'IDs de evidencia citados', '引用証拠 ID', 'Zitierte Evidenz-IDs', 'ID prove citate', 'ID de preuves citées', 'IDs de evidência citados', '인용된 증거 ID', 'ID цитированных доказательств'),
  blockingfacts: translations('阻止事实', '阻止事實', 'Hechos bloqueantes', 'ブロック要因', 'Blockierende Fakten', 'Fatti bloccanti', 'Faits bloquants', 'Fatos bloqueantes', '차단 사실', 'Блокирующие факты'),
  missingfacts: translations('缺失事实', '缺失事實', 'Hechos faltantes', '不足している事実', 'Fehlende Fakten', 'Fatti mancanti', 'Faits manquants', 'Fatos ausentes', '누락된 사실', 'Недостающие факты'),
  contractwarnings: translations('合约警告', '合約警告', 'Advertencias del contrato', 'コントラクト警告', 'Vertragswarnungen', 'Avvisi del contratto', 'Avertissements du contrat', 'Avisos do contrato', '계약 경고', 'Предупреждения контракта'),
  evidencegate: translations('证据门控', '證據門控', 'Puerta de evidencia', '証拠ゲート', 'Evidenz-Gate', 'Gate prove', 'Contrôle des preuves', 'Gate de evidência', '증거 게이트', 'Шлюз доказательств'),
  validationissues: translations('验证问题', '驗證問題', 'Problemas de validación', '検証の問題', 'Validierungsprobleme', 'Problemi di validazione', 'Problèmes de validation', 'Problemas de validação', '검증 문제', 'Проблемы проверки'),
  auditreceipt: translations('审计收据', '審計收據', 'Recibo de auditoría', '監査レシート', 'Audit-Beleg', 'Ricevuta audit', 'Reçu d’audit', 'Recibo de auditoria', '감사 영수증', 'Квитанция аудита'),
  finaldecision: translations('最终决定', '最終決定', 'Decisión final', '最終判断', 'Endentscheidung', 'Decisione finale', 'Décision finale', 'Decisão final', '최종 결정', 'Итоговое решение'),
  gatedecision: translations('门控决定', '門控決定', 'Decisión de la puerta', 'ゲート判断', 'Gate-Entscheidung', 'Decisione gate', 'Décision du contrôle', 'Decisão do gate', '게이트 결정', 'Решение шлюза'),
  usdatrisk: translations('风险美元金额', '風險美元金額', 'USD en riesgo', 'リスク USD', 'USD im Risiko', 'USD a rischio', 'USD à risque', 'USD em risco', '위험 USD', 'USD под риском'),
  spotprices: translations('现货价格', '現貨價格', 'Precios spot', 'スポット価格', 'Spotpreise', 'Prezzi spot', 'Prix spot', 'Preços spot', '현물 가격', 'Спотовые цены'),
  planfingerprint: translations('计划指纹', '計畫指紋', 'Huella del plan', 'プラン指紋', 'Plan-Fingerabdruck', 'Impronta piano', 'Empreinte du plan', 'Impressão digital do plano', '계획 지문', 'Отпечаток плана'),
  routeplanhash: translations('路由计划哈希', '路由計畫雜湊', 'Hash del plan de ruta', 'ルート計画ハッシュ', 'Routenplan-Hash', 'Hash piano percorso', 'Hash du plan de route', 'Hash do plano de rota', '경로 계획 해시', 'Хэш плана маршрута'),
  evidencehash: translations('证据哈希', '證據雜湊', 'Hash de evidencia', '証拠ハッシュ', 'Evidenz-Hash', 'Hash prove', 'Hash des preuves', 'Hash de evidência', '증거 해시', 'Хэш доказательств'),
  aidecisionhash: translations('AI 决策哈希', 'AI 決策雜湊', 'Hash de decisión de AI', 'AI 判断ハッシュ', 'AI-Entscheidungs-Hash', 'Hash decisione AI', 'Hash de décision IA', 'Hash da decisão de AI', 'AI 결정 해시', 'Хэш решения AI'),
  connector: translations('连接器', '連接器', 'Conector', 'コネクタ', 'Connector', 'Connettore', 'Connecteur', 'Conector', '커넥터', 'Коннектор'),
  providerroutes: translations('提供方路由', '提供者路由', 'Rutas de proveedor', 'プロバイダールート', 'Provider-Routen', 'Percorsi provider', 'Routes fournisseur', 'Rotas do provedor', '제공자 경로', 'Маршруты провайдера'),
  blockingids: translations('阻止 ID', '阻止 ID', 'IDs bloqueantes', 'ブロック ID', 'Blockierende IDs', 'ID bloccanti', 'ID bloquants', 'IDs bloqueantes', '차단 ID', 'Блокирующие ID'),
  missingrequirements: translations('缺失要求', '缺失要求', 'Requisitos faltantes', '不足要件', 'Fehlende Anforderungen', 'Requisiti mancanti', 'Exigences manquantes', 'Requisitos ausentes', '누락된 요구사항', 'Недостающие требования'),
  source: translations('来源', '來源', 'Fuente', '出典', 'Quelle', 'Fonte', 'Source', 'Fonte', '출처', 'Источник'),
  research: translations('查询', '查詢', 'Investigación', '調査', 'Recherche', 'Ricerca', 'Recherche', 'Pesquisa', '조사', 'Исследование'),
  route: translations('路线', '路線', 'Ruta', 'ルート', 'Route', 'Percorso', 'Route', 'Rota', '경로', 'Маршрут'),
  quote: translations('报价', '報價', 'Cotización', '見積もり', 'Quote', 'Quotazione', 'Devis', 'Cotação', '견적', 'Котировка'),
  protocol: translations('协议', '協議', 'Protocolo', 'プロトコル', 'Protokoll', 'Protocollo', 'Protocole', 'Protocolo', '프로토콜', 'Протокол'),
  tokenmint: translations('代币 mint', '代幣 mint', 'Mint del token', 'トークン mint', 'Token-Mint', 'Mint token', 'Mint du token', 'Mint do token', '토큰 민트', 'Минт токена'),
  recipient: translations('接收方', '接收方', 'Destinatario', '受取人', 'Empfänger', 'Destinatario', 'Destinataire', 'Destinatário', '수신자', 'Получатель'),
  limits: translations('限制', '限制', 'Límites', '制限', 'Limits', 'Limiti', 'Limites', 'Limites', '한도', 'Лимиты'),
  schedule: translations('计划时间', '排程', 'Programa', 'スケジュール', 'Zeitplan', 'Programma', 'Calendrier', 'Agenda', '일정', 'Расписание'),
  simulation: translations('模拟', '模擬', 'Simulación', 'シミュレーション', 'Simulation', 'Simulazione', 'Simulation', 'Simulação', '시뮬레이션', 'Симуляция'),
  policy: translations('策略', '策略', 'Política', 'ポリシー', 'Policy', 'Policy', 'Règle', 'Política', '정책', 'Политика'),
  thresholdrule: translations('阈值规则', '門檻規則', 'Regla de umbral', 'しきい値ルール', 'Schwellenwertregel', 'Regola soglia', 'Règle de seuil', 'Regra de limite', '임계값 규칙', 'Пороговое правило'),
  approved: translations('已批准', '已核准', 'aprobado', '承認済み', 'genehmigt', 'approvato', 'approuvé', 'aprovado', '승인됨', 'одобрено'),
  denied: translations('已拒绝', '已拒絕', 'rechazado', '拒否済み', 'abgelehnt', 'rifiutato', 'refusé', 'negado', '거부됨', 'отказано'),
  needsinput: translations('需要输入', '需要輸入', 'necesita datos', '入力が必要', 'Eingabe nötig', 'serve input', 'entrée nécessaire', 'precisa de entrada', '입력 필요', 'нужен ввод'),
};

export function normalizeReviewLanguageCode(value: unknown): PolicyLanguageCode {
  if (typeof value === 'string' && LANGUAGE_SET.has(value as PolicyLanguageCode)) {
    return value as PolicyLanguageCode;
  }
  return 'unknown';
}

export function shouldLocalizeAgentReview(language: unknown): boolean {
  return !NON_LOCALIZED_LANGUAGES.has(normalizeReviewLanguageCode(language));
}

export function agentReviewLocalizedLabel(
  key: AgentReviewLocalizedLabelKey,
  language: unknown,
): string {
  const code = normalizeReviewLanguageCode(language);
  return LABELS[code]?.[key] ?? ENGLISH_LABELS[key];
}

export function agentReviewLocalizedFindingLabel(label: string, language: unknown): string {
  const code = normalizeReviewLanguageCode(language);
  if (!shouldLocalizeAgentReview(code)) return label;
  const normalized = normalizeLabelKey(label);
  const translated = FINDING_LABELS[normalized]?.[code] ?? COMMON_FINDING_LABELS[normalized]?.[code];
  return translated ?? label;
}

export function agentReviewLocalizedProse(value: string | undefined, language: unknown): string | undefined {
  const text = value?.trim();
  if (!text) return text;
  const code = normalizeReviewLanguageCode(language);
  if (!shouldLocalizeAgentReview(code)) return text;

  const heliumApproveBecause = /^Approve(?: the)? swap because (?:the )?cheapest Helium Mobile monthly (?:phone )?plan is (?:under|below|less than) (\$[\d,.]+)\.?$/iu.exec(text);
  if (heliumApproveBecause) return heliumApproveBecausePlan(code, cleanProtectedToken(heliumApproveBecause[1]!));

  const heliumPass = /^(?:Cheapest|The cheapest) Helium Mobile monthly (?:phone )?plan is (?:under|below|less than) (\$[\d,.]+), so (?:the )?swap(?: draft)? passes (?:the )?(?:stated )?condition\.?$/iu.exec(text);
  if (heliumPass) return heliumPlanPass(code, cleanProtectedToken(heliumPass[1]!));

  const heliumListed = /^Helium Mobile[’']?s cheapest (?:listed )?monthly (?:mobile|phone) plan(?: found)? is (\$[\d,.]+(?:\/month)?), which is below the user[’']?s (\$[\d,.]+) approval threshold\.?$/iu.exec(text);
  if (heliumListed) return heliumListedBelow(code, cleanProtectedToken(heliumListed[1]!), cleanProtectedToken(heliumListed[2]!));

  const belowApprove = /^(.+?) is (?:below|under|less than) (\$[\d,.]+), so (?:the approve-when condition|the user[’']?s approval condition) holds\.?$/iu.exec(text);
  if (belowApprove) return belowApproveHolds(code, cleanProtectedToken(belowApprove[1]!), cleanProtectedToken(belowApprove[2]!));

  const belowApproveShort = /^(.+?) is (?:below|under|less than) (\$[\d,.]+), so approve\.?$/iu.exec(text);
  if (belowApproveShort) return belowApproveHolds(code, cleanProtectedToken(belowApproveShort[1]!), cleanProtectedToken(belowApproveShort[2]!));

  const correctedBelow = /^Corrected model comparison: (.+?) is (?:under|below|less than) (\$[\d,.]+)\. Original decision was deny\.?$/iu.exec(text);
  if (correctedBelow) return correctedBelowThreshold(code, cleanProtectedToken(correctedBelow[1]!), cleanProtectedToken(correctedBelow[2]!));

  const failedPolicy = /^User policy bundle failed: (.+)$/iu.exec(text);
  if (failedPolicy) return failedPolicyText(code, failedPolicy[1]!);

  const cannotTranslate = /^Agentic could not safely translate this non-English policy rule\./iu.test(text);
  if (cannotTranslate) return unsafeTranslationText(code);

  const translationNeedsReview = /^Non-English policy translation needs review\.?$/iu.test(text);
  if (translationNeedsReview) return translationNeedsReviewText(code);

  const txSimulation = /^Transaction simulation runs after the wallet signs and broadcasts\. Not required for draft review unless the prompt asks about on-chain effects\.?$/iu.test(text);
  if (txSimulation) return transactionSimulationText(code);

  const rawAudit = /^Available in raw audit JSON\.?$/iu.test(text);
  if (rawAudit) return rawAuditText(code);

  const decisionContract = /^decision:\s*(approve|deny|needs_input)\s*·\s*(\d+)\s+cited facts?\s*·\s*(\d+)\s+blocking\s*·\s*(\d+)\s+missing$/iu.exec(text);
  if (decisionContract) return decisionContractText(code, decisionContract[1]!, decisionContract[2]!, decisionContract[3]!, decisionContract[4]!);

  const gateResult = /^Gate result:\s*(pass|block|needs_input)$/iu.exec(text);
  if (gateResult) return gateResultText(code, gateResult[1]!);

  const staleChanged = /^Draft changed after review(?:: (.+?))?\. Ask the agent again before relying on this decision\.?$/iu.exec(text);
  if (staleChanged) return staleReviewText(code, staleChanged[1]);

  const exact = exactProseText(code, text);
  if (exact) return exact;

  return text;
}

export function sourceLanguageFromReview(
  review: LocalizableAgentReview | undefined,
  fallbackText = '',
): PolicyLanguageCode {
  const localizedLanguage = normalizeReviewLanguageCode(review?.localized?.language);
  if (localizedLanguage !== 'unknown') return localizedLanguage;
  const evidence = isRecord(review?.evidence) ? review.evidence : undefined;
  const evidenceLanguage = languageFromRecord(evidence?.language);
  if (evidenceLanguage !== 'unknown') return evidenceLanguage;
  const policyBundleLanguage = languageFromRecord(recordValue(evidence?.policyBundle)?.language);
  if (policyBundleLanguage !== 'unknown') return policyBundleLanguage;
  if (fallbackText.trim()) return detectPolicyLanguage(fallbackText).language;
  return 'unknown';
}

export function localizeAgentReviewResultForDisplay<T extends LocalizableAgentReview>(
  review: T,
  options: {
    language?: unknown;
    fallbackText?: string;
    now?: () => string;
    source?: AgentReviewLocalizationSource;
  } = {},
): T & { localized?: AgentReviewLocalizedCopy } {
  const language = normalizeReviewLanguageCode(
    options.language ?? sourceLanguageFromReview(review, options.fallbackText ?? ''),
  );
  if (!shouldLocalizeAgentReview(language)) return review;
  const phrasePack = buildPhrasePackLocalization(review, language, {
    generatedAt: options.now?.() ?? new Date().toISOString(),
    source: options.source ?? 'phrase_pack',
  });
  const existing = review.localized &&
    normalizeReviewLanguageCode(review.localized.language) === language &&
    (!review.localized.canonicalHash || review.localized.canonicalHash === phrasePack.canonicalHash)
    ? sanitizeAgentReviewLocalizedCopy(review, review.localized)
    : undefined;
  return {
    ...review,
    localized: mergeLocalizedCopy(existing, phrasePack),
  };
}

export function agentReviewCanonicalHash(review: LocalizableAgentReview): string {
  return reviewTextHash(review);
}

// ── Model-backed localization (shared by the hosted MCP path AND the on-device BYOK
// device-agent runtime, so the translate prompt + payload + parse are defined ONCE). ──

export interface AgentReviewLocalizationPayload {
  language: PolicyLanguageCode;
  summary?: string;
  reason?: string;
  findings: AgentReviewLocalizedFinding[];
  questions: Array<{ id: string; prompt?: string; hint?: string; options?: string[] }>;
  reviewers: Array<{ id?: string; label?: string; reason?: string; summary?: string }>;
  policies: AgentReviewLocalizedPolicy[];
  facts: AgentReviewLocalizedFact[];
  counterfactuals: AgentReviewLocalizedCounterfactual[];
}

/** Extract the user-facing display copy a model needs to translate, by index/atomId. */
export function reviewLocalizationPayload(
  review: LocalizableAgentReview,
  language: PolicyLanguageCode,
): AgentReviewLocalizationPayload {
  return {
    language,
    ...(review.summary ? { summary: review.summary } : {}),
    ...(review.reason ? { reason: review.reason } : {}),
    findings: reviewLocalizationFindings(review.evidence),
    questions: (review.questions ?? []).flatMap((question) => {
      const id = typeof question.id === 'string' && question.id.trim() ? question.id.trim() : '';
      if (!id) return [];
      return [{
        id,
        ...(question.prompt ? { prompt: question.prompt } : {}),
        ...(question.hint ? { hint: question.hint } : {}),
        ...(question.options?.length ? { options: question.options } : {}),
      }];
    }),
    reviewers: (review.reviewers ?? []).map((reviewer) => ({
      ...(reviewer.id ? { id: reviewer.id } : {}),
      ...(reviewer.label ? { label: reviewer.label } : {}),
      ...(reviewer.reason ? { reason: reviewer.reason } : {}),
      ...(reviewer.summary ? { summary: reviewer.summary } : {}),
    })),
    policies: (review.policies ?? []).flatMap((policy, index): AgentReviewLocalizedPolicy[] => {
      const label = typeof policy.label === 'string' && policy.label.trim() ? policy.label.trim() : undefined;
      const ruleText = typeof policy.ruleText === 'string' && policy.ruleText.trim() ? policy.ruleText.trim() : undefined;
      if (!label && !ruleText) return [];
      return [{ index, ...(label ? { label } : {}), ...(ruleText ? { ruleText } : {}) }];
    }),
    facts: Object.entries(isRecord(review.facts) ? review.facts : {}).flatMap(([key, fact]): AgentReviewLocalizedFact[] => {
      const message = isRecord(fact) && typeof fact.message === 'string' && fact.message.trim() ? fact.message.trim() : undefined;
      if (!message) return [];
      return [{ key, message }];
    }),
    counterfactuals: (review.auditReceipt?.counterfactualSummary ?? []).flatMap((cf, index): AgentReviewLocalizedCounterfactual[] => {
      const rationale = typeof cf.rationale === 'string' && cf.rationale.trim() ? cf.rationale.trim() : undefined;
      if (!rationale) return [];
      return [{ index, rationale }];
    }),
  };
}

export function reviewLocalizationPayloadHasText(payload: AgentReviewLocalizationPayload): boolean {
  return Boolean(
    payload.summary ||
    payload.reason ||
    payload.findings.some((finding) => finding.label || finding.value) ||
    payload.questions.some((question) => question.prompt || question.hint || question.options?.length) ||
    payload.reviewers.some((reviewer) => reviewer.label || reviewer.reason || reviewer.summary) ||
    payload.policies.some((policy) => policy.label || policy.ruleText) ||
    payload.facts.some((fact) => fact.message) ||
    payload.counterfactuals.some((counterfactual) => counterfactual.rationale),
  );
}

function reviewLocalizationFindings(evidence: Record<string, unknown> | undefined): AgentReviewLocalizedFinding[] {
  if (!isRecord(evidence)) return [];
  const raw = Array.isArray(evidence.findings)
    ? evidence.findings
    : Array.isArray(evidence.checks)
      ? evidence.checks
      : Array.isArray(evidence.evidenceRows)
        ? evidence.evidenceRows
        : [];
  return raw.flatMap((entry, index): AgentReviewLocalizedFinding[] => {
    if (!isRecord(entry)) return [];
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : undefined;
    const value = typeof entry.value === 'string' && entry.value.trim() ? entry.value.trim() : undefined;
    if (!label && !value) return [];
    return [{
      index,
      ...(typeof entry.atomId === 'string' && entry.atomId.trim() ? { atomId: entry.atomId.trim() } : {}),
      ...(label ? { label } : {}),
      ...(value ? { value } : {}),
    }];
  });
}

/** The translate system + user messages. Identical text on server and device-agent runtime. */
export function agentReviewLocalizationMessages(
  payload: AgentReviewLocalizationPayload,
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        'Translate only user-facing Solana agent review display text into the requested target language.',
        'Return only JSON with optional string fields summary and reason, optional arrays findings, questions, reviewers, policies, and facts.',
        'Keep every finding index, policy index, fact key, and atomId unchanged. Do not add, remove, or reorder facts.',
        'Preserve exact numbers, currencies, percentages, token symbols, wallet addresses, URLs, dates, source names, product names, and approve/deny/needs_input meaning.',
        'Do not translate raw JSON, evidence ids, wallet addresses, URLs, token symbols, or provider/source names.',
        'Do not change the decision, invent facts, soften a denial, or add wallet-signature disclaimers.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        targetLanguage: payload.language,
        displayCopy: payload,
        requiredOutputShape: {
          summary: 'translated summary if present',
          reason: 'translated reason if present',
          findings: [{ index: 0, atomId: 'same optional atomId', label: 'translated label', value: 'translated value' }],
          questions: [{ id: 'same id', prompt: 'translated prompt', hint: 'translated hint', options: ['translated options'] }],
          reviewers: [{ id: 'same optional id', label: 'translated label', reason: 'translated reason', summary: 'translated summary' }],
          policies: [{ index: 0, label: 'translated label', ruleText: 'translated rule text' }],
          facts: [{ key: 'same fact key', message: 'translated message' }],
          counterfactuals: [{ index: 0, rationale: 'translated rationale' }],
        },
      }),
    },
  ];
}

/** Minimal, dependency-free JSON extraction for model output (handles ``` fences). */
export function parseAgentReviewLocalizationJson(text: string): Record<string, unknown> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return {};
  const unfenced = trimmed.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  const slice = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  try {
    const parsed = JSON.parse(slice) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Normalize + sanitize a model translation into a trusted `AgentReviewLocalizedCopy`. */
export function agentReviewLocalizedCopyFromModel(
  parsed: Record<string, unknown>,
  review: LocalizableAgentReview,
  language: PolicyLanguageCode,
  generatedAt: string = new Date().toISOString(),
): AgentReviewLocalizedCopy | undefined {
  const raw = isRecord(parsed.localized) ? parsed.localized : parsed;
  const normalized = normalizeAgentReviewLocalizedCopy({
    ...raw,
    language,
    status: 'ready',
    source: 'model',
    canonicalHash: agentReviewCanonicalHash(review),
    generatedAt,
  });
  return sanitizeAgentReviewLocalizedCopy(review, normalized);
}

export function sanitizeAgentReviewLocalizedCopy(
  review: LocalizableAgentReview,
  localized: AgentReviewLocalizedCopy | undefined,
): AgentReviewLocalizedCopy | undefined {
  if (!localized || !shouldLocalizeAgentReview(localized.language)) return undefined;
  const findings = sanitizeLocalizedFindings(review, localized.findings);
  const questions = sanitizeLocalizedQuestions(review, localized.questions);
  const reviewers = sanitizeLocalizedReviewers(review, localized.reviewers);
  const policies = sanitizeLocalizedPolicies(review, localized.policies);
  const facts = sanitizeLocalizedFacts(review, localized.facts);
  const counterfactuals = sanitizeLocalizedCounterfactuals(review, localized.counterfactuals);
  const reason = safeLocalizedText(review.reason, localized.reason);
  const summary = safeLocalizedText(review.summary, localized.summary);
  const hasDisplayCopy = Boolean(
    reason || summary || findings?.length || questions?.length || reviewers?.length ||
    policies?.length || facts?.length || counterfactuals?.length,
  );
  if (!hasDisplayCopy && localized.status !== 'failed') return undefined;
  return {
    language: localized.language,
    status: localized.status,
    source: localized.source,
    ...(localized.canonicalHash ? { canonicalHash: localized.canonicalHash } : {}),
    ...(localized.generatedAt ? { generatedAt: localized.generatedAt } : {}),
    ...(reason ? { reason } : {}),
    ...(summary ? { summary } : {}),
    ...(findings?.length ? { findings } : {}),
    ...(questions?.length ? { questions } : {}),
    ...(reviewers?.length ? { reviewers } : {}),
    ...(policies?.length ? { policies } : {}),
    ...(facts?.length ? { facts } : {}),
    ...(counterfactuals?.length ? { counterfactuals } : {}),
    ...(localized.error ? { error: localized.error } : {}),
  };
}

export function normalizeAgentReviewLocalizedCopy(value: unknown): AgentReviewLocalizedCopy | undefined {
  if (!isRecord(value)) return undefined;
  const language = normalizeReviewLanguageCode(value.language);
  if (!shouldLocalizeAgentReview(language)) return undefined;
  const reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : undefined;
  const summary = typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : undefined;
  const findings = Array.isArray(value.findings)
    ? value.findings.flatMap((entry): AgentReviewLocalizedFinding[] => {
        if (!isRecord(entry)) return [];
        const index = typeof entry.index === 'number' && Number.isInteger(entry.index) && entry.index >= 0
          ? entry.index
          : undefined;
        if (index === undefined) return [];
        const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : undefined;
        const findingValue = typeof entry.value === 'string' && entry.value.trim() ? entry.value.trim() : undefined;
        if (!label && !findingValue) return [];
        return [{
          index,
          ...(typeof entry.atomId === 'string' && entry.atomId.trim() ? { atomId: entry.atomId.trim() } : {}),
          ...(label ? { label } : {}),
          ...(findingValue ? { value: findingValue } : {}),
        }];
      })
    : undefined;
  const questions = Array.isArray(value.questions)
    ? value.questions.flatMap((entry): AgentReviewLocalizedQuestion[] => {
        if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) return [];
        return [{
          id: entry.id.trim(),
          ...(typeof entry.prompt === 'string' && entry.prompt.trim() ? { prompt: entry.prompt.trim() } : {}),
          ...(typeof entry.hint === 'string' && entry.hint.trim() ? { hint: entry.hint.trim() } : {}),
          ...(Array.isArray(entry.options) ? { options: entry.options.filter((option): option is string => typeof option === 'string') } : {}),
        }];
      })
    : undefined;
  const reviewers = Array.isArray(value.reviewers)
    ? value.reviewers.flatMap((entry): AgentReviewLocalizedReviewer[] => {
        if (!isRecord(entry)) return [];
        const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : undefined;
        const reviewerReason = typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason.trim() : undefined;
        const reviewerSummary = typeof entry.summary === 'string' && entry.summary.trim() ? entry.summary.trim() : undefined;
        if (!label && !reviewerReason && !reviewerSummary) return [];
        return [{
          ...(typeof entry.id === 'string' && entry.id.trim() ? { id: entry.id.trim() } : {}),
          ...(label ? { label } : {}),
          ...(reviewerReason ? { reason: reviewerReason } : {}),
          ...(reviewerSummary ? { summary: reviewerSummary } : {}),
        }];
      })
    : undefined;
  const policies = Array.isArray(value.policies)
    ? value.policies.flatMap((entry): AgentReviewLocalizedPolicy[] => {
        if (!isRecord(entry)) return [];
        const index = typeof entry.index === 'number' && Number.isInteger(entry.index) && entry.index >= 0 ? entry.index : undefined;
        if (index === undefined) return [];
        const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : undefined;
        const ruleText = typeof entry.ruleText === 'string' && entry.ruleText.trim() ? entry.ruleText.trim() : undefined;
        if (!label && !ruleText) return [];
        return [{ index, ...(label ? { label } : {}), ...(ruleText ? { ruleText } : {}) }];
      })
    : undefined;
  const facts = Array.isArray(value.facts)
    ? value.facts.flatMap((entry): AgentReviewLocalizedFact[] => {
        if (!isRecord(entry) || typeof entry.key !== 'string' || !entry.key.trim()) return [];
        const message = typeof entry.message === 'string' && entry.message.trim() ? entry.message.trim() : undefined;
        if (!message) return [];
        return [{ key: entry.key.trim(), message }];
      })
    : undefined;
  const counterfactuals = Array.isArray(value.counterfactuals)
    ? value.counterfactuals.flatMap((entry): AgentReviewLocalizedCounterfactual[] => {
        if (!isRecord(entry)) return [];
        const index = typeof entry.index === 'number' && Number.isInteger(entry.index) && entry.index >= 0 ? entry.index : undefined;
        if (index === undefined) return [];
        const rationale = typeof entry.rationale === 'string' && entry.rationale.trim() ? entry.rationale.trim() : undefined;
        if (!rationale) return [];
        return [{ index, rationale }];
      })
    : undefined;
  if (!reason && !summary && !findings?.length && !questions?.length && !reviewers?.length &&
      !policies?.length && !facts?.length && !counterfactuals?.length) {
    return undefined;
  }
  return {
    language,
    status: value.status === 'failed' ? 'failed' : 'ready',
    source: value.source === 'model' || value.source === 'phrase_pack'
      ? value.source
      : 'model',
    ...(typeof value.canonicalHash === 'string' && value.canonicalHash.trim() ? { canonicalHash: value.canonicalHash.trim() } : {}),
    ...(typeof value.generatedAt === 'string' && value.generatedAt.trim() ? { generatedAt: value.generatedAt.trim() } : {}),
    ...(reason ? { reason } : {}),
    ...(summary ? { summary } : {}),
    ...(findings?.length ? { findings } : {}),
    ...(questions?.length ? { questions } : {}),
    ...(reviewers?.length ? { reviewers } : {}),
    ...(policies?.length ? { policies } : {}),
    ...(facts?.length ? { facts } : {}),
    ...(counterfactuals?.length ? { counterfactuals } : {}),
    ...(typeof value.error === 'string' && value.error.trim() ? { error: value.error.trim() } : {}),
  };
}

function buildPhrasePackLocalization(
  review: LocalizableAgentReview,
  language: PolicyLanguageCode,
  options: { generatedAt: string; source: AgentReviewLocalizationSource },
): AgentReviewLocalizedCopy {
  const findings = localizedFindingsFromEvidence(review.evidence, language);
  const questions = (review.questions ?? []).flatMap((question): AgentReviewLocalizedQuestion[] => {
    const id = typeof question.id === 'string' && question.id.trim() ? question.id.trim() : '';
    const prompt = agentReviewLocalizedProse(question.prompt, language);
    if (!id || !prompt) return [];
    return [{
      id,
      prompt,
      ...(question.hint ? { hint: agentReviewLocalizedProse(question.hint, language) } : {}),
      ...(Array.isArray(question.options) ? { options: question.options } : {}),
    }];
  });
  const reviewers = (review.reviewers ?? []).flatMap((reviewer): AgentReviewLocalizedReviewer[] => {
    const reason = agentReviewLocalizedProse(reviewer.reason, language);
    const summary = agentReviewLocalizedProse(reviewer.summary, language);
    if (!reason && !summary) return [];
    return [{
      ...(reviewer.id ? { id: reviewer.id } : {}),
      ...(reviewer.label ? { label: reviewer.label } : {}),
      ...(reason ? { reason } : {}),
      ...(summary ? { summary } : {}),
    }];
  });
  const policies = (review.policies ?? []).flatMap((policy, index): AgentReviewLocalizedPolicy[] => {
    const label = policy.label ? agentReviewLocalizedFindingLabel(policy.label, language) : undefined;
    const ruleText = agentReviewLocalizedProse(policy.ruleText, language);
    if (!label && !ruleText) return [];
    return [{ index, ...(label ? { label } : {}), ...(ruleText ? { ruleText } : {}) }];
  });
  const facts = Object.entries(isRecord(review.facts) ? review.facts : {}).flatMap(([key, fact]): AgentReviewLocalizedFact[] => {
    const sourceMessage = isRecord(fact) && typeof fact.message === 'string' ? fact.message : undefined;
    const message = agentReviewLocalizedProse(sourceMessage, language);
    if (!message) return [];
    return [{ key, message }];
  });
  const counterfactuals = (review.auditReceipt?.counterfactualSummary ?? []).flatMap((cf, index): AgentReviewLocalizedCounterfactual[] => {
    const rationale = agentReviewLocalizedProse(cf.rationale, language);
    if (!rationale) return [];
    return [{ index, rationale }];
  });
  return {
    language,
    status: 'ready',
    source: options.source,
    canonicalHash: reviewTextHash(review),
    generatedAt: options.generatedAt,
    ...(review.reason ? { reason: agentReviewLocalizedProse(review.reason, language) } : {}),
    ...(review.summary ? { summary: agentReviewLocalizedProse(review.summary, language) } : {}),
    ...(findings.length ? { findings } : {}),
    ...(questions.length ? { questions } : {}),
    ...(reviewers.length ? { reviewers } : {}),
    ...(policies.length ? { policies } : {}),
    ...(facts.length ? { facts } : {}),
    ...(counterfactuals.length ? { counterfactuals } : {}),
  };
}

function sanitizeLocalizedFindings(
  review: LocalizableAgentReview,
  findings: AgentReviewLocalizedFinding[] | undefined,
): AgentReviewLocalizedFinding[] | undefined {
  if (!findings?.length) return undefined;
  const sourceFindings = sourceFindingRecords(review.evidence);
  const out: AgentReviewLocalizedFinding[] = [];
  for (const entry of findings) {
    const source = sourceFindingForLocalizedEntry(sourceFindings, entry);
    const label = entry.label?.trim();
    const value = safeLocalizedText(source?.value, entry.value);
    if (!label && !value) continue;
    out.push({
      index: entry.index,
      ...(entry.atomId ? { atomId: entry.atomId } : {}),
      ...(label ? { label } : {}),
      ...(value ? { value } : {}),
    });
  }
  return out.length ? out : undefined;
}

function sanitizeLocalizedQuestions(
  review: LocalizableAgentReview,
  questions: AgentReviewLocalizedQuestion[] | undefined,
): AgentReviewLocalizedQuestion[] | undefined {
  if (!questions?.length) return undefined;
  const sourceById = new Map(
    (review.questions ?? [])
      .flatMap((question) => typeof question.id === 'string' && question.id.trim() ? [[question.id.trim(), question] as const] : []),
  );
  const out: AgentReviewLocalizedQuestion[] = [];
  for (const question of questions) {
    const source = sourceById.get(question.id);
    const prompt = safeLocalizedText(source?.prompt, question.prompt);
    const hint = safeLocalizedText(source?.hint, question.hint);
    // Map over SOURCE options so the result stays the same length and index-aligned with the
    // source (the renderer indexes localized options by source position). A rejected/missing
    // translation falls back to the source option — NEVER filtered, which would shift indices
    // and make later options render another option's translated label.
    const sourceOptions = Array.isArray(source?.options) ? source.options : undefined;
    const candidateOptions = Array.isArray(question.options) ? question.options : undefined;
    const options = sourceOptions
      ? sourceOptions.map((sourceOption, index) => safeLocalizedText(sourceOption, candidateOptions?.[index]) ?? sourceOption)
      : undefined;
    if (!prompt && !hint && !options?.length) continue;
    out.push({
      id: question.id,
      ...(prompt ? { prompt } : {}),
      ...(hint ? { hint } : {}),
      ...(options?.length ? { options } : {}),
    });
  }
  return out.length ? out : undefined;
}

function sanitizeLocalizedReviewers(
  review: LocalizableAgentReview,
  reviewers: AgentReviewLocalizedReviewer[] | undefined,
): AgentReviewLocalizedReviewer[] | undefined {
  if (!reviewers?.length) return undefined;
  const sourceById = new Map(
    (review.reviewers ?? []).flatMap((reviewer, index) => {
      const id = typeof reviewer.id === 'string' && reviewer.id.trim() ? reviewer.id.trim() : `index:${index}`;
      return [[id, reviewer] as const];
    }),
  );
  const out: AgentReviewLocalizedReviewer[] = [];
  for (let index = 0; index < reviewers.length; index += 1) {
    const reviewer = reviewers[index]!;
    const source = sourceById.get(reviewer.id ?? `index:${index}`);
    const label = reviewer.label?.trim();
    const reason = safeLocalizedText(source?.reason, reviewer.reason);
    const summary = safeLocalizedText(source?.summary, reviewer.summary);
    if (!label && !reason && !summary) continue;
    out.push({
      ...(reviewer.id ? { id: reviewer.id } : {}),
      ...(label ? { label } : {}),
      ...(reason ? { reason } : {}),
      ...(summary ? { summary } : {}),
    });
  }
  return out.length ? out : undefined;
}

function sanitizeLocalizedPolicies(
  review: LocalizableAgentReview,
  policies: AgentReviewLocalizedPolicy[] | undefined,
): AgentReviewLocalizedPolicy[] | undefined {
  if (!policies?.length) return undefined;
  const source = review.policies ?? [];
  const out: AgentReviewLocalizedPolicy[] = [];
  for (const entry of policies) {
    const sourcePolicy = source[entry.index];
    if (!sourcePolicy) continue;
    const label = safeLocalizedText(sourcePolicy.label, entry.label);
    const ruleText = safeLocalizedText(sourcePolicy.ruleText, entry.ruleText);
    if (!label && !ruleText) continue;
    out.push({ index: entry.index, ...(label ? { label } : {}), ...(ruleText ? { ruleText } : {}) });
  }
  return out.length ? out : undefined;
}

function sanitizeLocalizedFacts(
  review: LocalizableAgentReview,
  facts: AgentReviewLocalizedFact[] | undefined,
): AgentReviewLocalizedFact[] | undefined {
  if (!facts?.length) return undefined;
  const sourceByKey = new Map<string, string>();
  for (const [key, value] of Object.entries(isRecord(review.facts) ? review.facts : {})) {
    if (isRecord(value) && typeof value.message === 'string' && value.message.trim()) {
      sourceByKey.set(key, value.message.trim());
    }
  }
  const out: AgentReviewLocalizedFact[] = [];
  for (const entry of facts) {
    const message = safeLocalizedText(sourceByKey.get(entry.key), entry.message);
    if (!message) continue;
    out.push({ key: entry.key, message });
  }
  return out.length ? out : undefined;
}

function sanitizeLocalizedCounterfactuals(
  review: LocalizableAgentReview,
  counterfactuals: AgentReviewLocalizedCounterfactual[] | undefined,
): AgentReviewLocalizedCounterfactual[] | undefined {
  if (!counterfactuals?.length) return undefined;
  const source = review.auditReceipt?.counterfactualSummary ?? [];
  const out: AgentReviewLocalizedCounterfactual[] = [];
  for (const entry of counterfactuals) {
    const rationale = safeLocalizedText(source[entry.index]?.rationale, entry.rationale);
    if (!rationale) continue;
    out.push({ index: entry.index, rationale });
  }
  return out.length ? out : undefined;
}

function sourceFindingRecords(
  evidence: Record<string, unknown> | undefined,
): Array<{ index: number; atomId?: string; label?: string; value?: string }> {
  if (!isRecord(evidence)) return [];
  const raw = Array.isArray(evidence.findings)
    ? evidence.findings
    : Array.isArray(evidence.checks)
      ? evidence.checks
      : Array.isArray(evidence.evidenceRows)
        ? evidence.evidenceRows
        : [];
  return raw.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    return [{
      index,
      ...(typeof entry.atomId === 'string' && entry.atomId.trim() ? { atomId: entry.atomId.trim() } : {}),
      ...(typeof entry.label === 'string' && entry.label.trim() ? { label: entry.label.trim() } : {}),
      ...(typeof entry.value === 'string' && entry.value.trim() ? { value: entry.value.trim() } : {}),
    }];
  });
}

function sourceFindingForLocalizedEntry(
  sourceFindings: Array<{ index: number; atomId?: string; label?: string; value?: string }>,
  entry: AgentReviewLocalizedFinding,
): { index: number; atomId?: string; label?: string; value?: string } | undefined {
  if (entry.atomId) {
    const byAtom = sourceFindings.find((source) => source.atomId === entry.atomId);
    if (byAtom) return byAtom;
  }
  return sourceFindings.find((source) => source.index === entry.index);
}

function safeLocalizedText(source: string | undefined, candidate: string | undefined): string | undefined {
  const text = candidate?.trim();
  if (!text) return undefined;
  const sourceText = source?.trim();
  // No matching source string means there is nothing legitimate to translate (e.g. the
  // model invented an entry with an unknown id/index/key). Drop it rather than trusting
  // unvalidated model text into the display copy.
  if (!sourceText) return undefined;
  return preservesProtectedTokens(sourceText, text) ? text : undefined;
}

export function preservesProtectedTokens(source: string, candidate: string): boolean {
  for (const token of protectedTokens(source)) {
    if (candidate.includes(token)) continue;
    // Currency amounts are frequently reformatted by translation ("$20" -> "20 USD" /
    // "20 dollari" / "20 美元"). Accept the translation as long as the NUMERIC amount
    // survives; non-currency tokens (URLs, wallet addresses, token symbols, percentages)
    // must still appear verbatim so the model cannot silently alter them.
    if (/[$€£¥]/u.test(token)) {
      const numeric = token.replace(/[^\d.,]/gu, '').replace(/[.,]+$/u, '');
      if (numeric && candidate.includes(numeric)) continue;
    }
    return false;
  }
  // Reject a translation that INTRODUCES a URL or wallet address absent from the source —
  // a hallucinated phishing link or swapped address must never reach the user.
  if (introducesForeignSensitiveToken(source, candidate)) return false;
  return true;
}

/** URLs + base58 wallet addresses only — the tokens an attacker-shaped translation could weaponize. */
function sensitiveExfilTokens(value: string): string[] {
  const tokens = new Set<string>();
  const patterns = [
    /https?:\/\/[^\s),;]+/giu,
    /\bwww\.[^\s),;]+/giu,
    /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const token = cleanProtectedToken(match[0]?.trim() ?? '');
      if (token) tokens.add(token);
    }
  }
  return Array.from(tokens);
}

function introducesForeignSensitiveToken(source: string, candidate: string): boolean {
  const sourceTokens = new Set(sensitiveExfilTokens(source));
  return sensitiveExfilTokens(candidate).some((token) => !sourceTokens.has(token));
}

function protectedTokens(value: string): string[] {
  const tokens = new Set<string>();
  const patterns = [
    /https?:\/\/[^\s),;]+/giu,
    /\bwww\.[^\s),;]+/giu,
    /\b[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s),;]*)?/giu,
    /[$€£¥]\s?\d[\d,.]*(?:\/(?:month|mo|year|yr))?/giu,
    /\b\d+(?:\.\d+)?%/gu,
    /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,
    /\b(?:SOL|USDC|USDT|BTC|ETH|JUP|BONK|PYUSD|WIF|JITO|mSOL|bSOL|USDS|USDP)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const token = cleanProtectedToken(match[0]?.trim() ?? '');
      if (token) tokens.add(token);
    }
  }
  return Array.from(tokens);
}

function cleanProtectedToken(token: string): string {
  return token.trim().replace(/[.,;:]+$/u, '');
}

function localizedFindingsFromEvidence(
  evidence: Record<string, unknown> | undefined,
  language: PolicyLanguageCode,
): AgentReviewLocalizedFinding[] {
  if (!isRecord(evidence)) return [];
  const raw = Array.isArray(evidence.findings)
    ? evidence.findings
    : Array.isArray(evidence.checks)
      ? evidence.checks
      : Array.isArray(evidence.evidenceRows)
        ? evidence.evidenceRows
        : [];
  const out: AgentReviewLocalizedFinding[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const label = typeof entry.label === 'string'
      ? agentReviewLocalizedFindingLabel(entry.label, language)
      : undefined;
    const value = typeof entry.value === 'string'
      ? agentReviewLocalizedProse(entry.value, language)
      : undefined;
    if (!label && !value) return;
    out.push({
      index,
      ...(typeof entry.atomId === 'string' ? { atomId: entry.atomId } : {}),
      ...(label ? { label } : {}),
      ...(value ? { value } : {}),
    });
  });
  return out;
}

function mergeLocalizedCopy(
  existing: AgentReviewLocalizedCopy | undefined,
  fallback: AgentReviewLocalizedCopy,
): AgentReviewLocalizedCopy {
  if (!existing) return fallback;
  return {
    ...fallback,
    ...existing,
    reason: existing.reason || fallback.reason,
    summary: existing.summary || fallback.summary,
    findings: mergeLocalizedFindings(existing.findings, fallback.findings),
    questions: existing.questions?.length ? existing.questions : fallback.questions,
    reviewers: existing.reviewers?.length ? existing.reviewers : fallback.reviewers,
    policies: existing.policies?.length ? existing.policies : fallback.policies,
    facts: existing.facts?.length ? existing.facts : fallback.facts,
    counterfactuals: existing.counterfactuals?.length ? existing.counterfactuals : fallback.counterfactuals,
  };
}

function mergeLocalizedFindings(
  existing: AgentReviewLocalizedFinding[] | undefined,
  fallback: AgentReviewLocalizedFinding[] | undefined,
): AgentReviewLocalizedFinding[] | undefined {
  if (!existing?.length) return fallback;
  if (!fallback?.length) return existing;
  const byKey = new Map<string, AgentReviewLocalizedFinding>();
  for (const entry of fallback) byKey.set(localizedFindingKey(entry), entry);
  for (const entry of existing) {
    const key = localizedFindingKey(entry);
    byKey.set(key, { ...(byKey.get(key) ?? {}), ...entry });
  }
  return Array.from(byKey.values()).sort((a, b) => a.index - b.index);
}

function localizedFindingKey(entry: AgentReviewLocalizedFinding): string {
  return entry.atomId ? `atom:${entry.atomId}` : `index:${entry.index}`;
}

function languageFromRecord(value: unknown): PolicyLanguageCode {
  const record = isRecord(value) ? value : undefined;
  return normalizeReviewLanguageCode(record?.sourceLanguage ?? record?.language);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function reviewTextHash(review: LocalizableAgentReview): string {
  const findings = Array.isArray(review.evidence?.findings) ? review.evidence.findings : [];
  return hashString(JSON.stringify({
    reason: review.reason ?? '',
    summary: review.summary ?? '',
    findings,
  }));
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeLabelKey(label: string): string {
  return label.replace(/[_\-\s&:()]+/gu, '').toLowerCase();
}

function translations(
  zhHans: string,
  zhHant: string,
  es: string,
  ja: string,
  de: string,
  it: string,
  fr: string,
  pt: string,
  ko: string,
  ru: string,
): LocalizedStringMap {
  return {
    'zh-Hans': zhHans,
    'zh-Hant': zhHant,
    es,
    ja,
    de,
    it,
    fr,
    pt,
    ko,
    ru,
  };
}

function heliumApproveBecausePlan(language: PolicyLanguageCode, threshold: string): string {
  switch (language) {
    case 'zh-Hans': return `批准该 swap，因为 Helium Mobile 最便宜的月度套餐低于 ${threshold}。`;
    case 'zh-Hant': return `核准該 swap，因為 Helium Mobile 最便宜的月度方案低於 ${threshold}。`;
    case 'es': return `Aprueba el swap porque el plan mensual más barato de Helium Mobile está por debajo de ${threshold}.`;
    case 'ja': return `Helium Mobile の最安月額プランが ${threshold} 未満なので、この swap を承認します。`;
    case 'de': return `Genehmige den Swap, weil der günstigste Monatstarif von Helium Mobile unter ${threshold} liegt.`;
    case 'it': return `Approva lo swap perché il piano mensile più economico di Helium Mobile è sotto ${threshold}.`;
    case 'fr': return `Approuve le swap car le forfait mensuel Helium Mobile le moins cher est sous ${threshold}.`;
    case 'pt': return `Aprove o swap porque o plano mensal mais barato da Helium Mobile está abaixo de ${threshold}.`;
    case 'ko': return `Helium Mobile의 가장 저렴한 월간 요금제가 ${threshold} 미만이므로 이 swap을 승인합니다.`;
    case 'ru': return `Одобрите swap, потому что самый дешевый месячный тариф Helium Mobile ниже ${threshold}.`;
    default: return `Approve the swap because the cheapest Helium Mobile monthly plan is under ${threshold}.`;
  }
}

function heliumPlanPass(language: PolicyLanguageCode, threshold: string): string {
  switch (language) {
    case 'zh-Hans': return `Helium Mobile 最便宜的月度套餐低于 ${threshold}，因此该 swap 草稿符合条件。`;
    case 'zh-Hant': return `Helium Mobile 最便宜的月度方案低於 ${threshold}，因此該 swap 草稿符合條件。`;
    case 'es': return `El plan mensual más barato de Helium Mobile está por debajo de ${threshold}, así que el borrador de swap cumple la condición.`;
    case 'ja': return `Helium Mobile の最安月額プランは ${threshold} 未満なので、この swap 下書きは条件を満たします。`;
    case 'de': return `Der günstigste Monatstarif von Helium Mobile liegt unter ${threshold}; der Swap-Entwurf erfüllt die Bedingung.`;
    case 'it': return `Il piano mensile più economico di Helium Mobile è sotto ${threshold}, quindi la bozza di swap soddisfa la condizione.`;
    case 'fr': return `Le forfait mensuel Helium Mobile le moins cher est sous ${threshold}; le brouillon de swap respecte donc la condition.`;
    case 'pt': return `O plano mensal mais barato da Helium Mobile está abaixo de ${threshold}, então o rascunho de swap atende à condição.`;
    case 'ko': return `Helium Mobile의 가장 저렴한 월간 요금제가 ${threshold} 미만이므로 swap 초안은 조건을 충족합니다.`;
    case 'ru': return `Самый дешевый месячный тариф Helium Mobile ниже ${threshold}, поэтому черновик swap проходит условие.`;
    default: return `Cheapest Helium Mobile monthly plan is under ${threshold}, so the swap draft passes the stated condition.`;
  }
}

function heliumListedBelow(language: PolicyLanguageCode, value: string, threshold: string): string {
  switch (language) {
    case 'zh-Hans': return `Helium Mobile 列出的最便宜月度移动套餐是 ${value}，低于用户的 ${threshold} 批准阈值。`;
    case 'zh-Hant': return `Helium Mobile 列出的最便宜月度行動方案是 ${value}，低於使用者的 ${threshold} 核准門檻。`;
    case 'es': return `El plan móvil mensual más barato listado por Helium Mobile es ${value}, por debajo del umbral de aprobación de ${threshold} del usuario.`;
    case 'ja': return `Helium Mobile の掲載されている最安月額モバイルプランは ${value} で、ユーザーの承認しきい値 ${threshold} を下回っています。`;
    case 'de': return `Der günstigste gelistete Monats-Mobiltarif von Helium Mobile beträgt ${value} und liegt unter dem Genehmigungsschwellenwert von ${threshold}.`;
    case 'it': return `Il piano mobile mensile più economico indicato da Helium Mobile è ${value}, sotto la soglia di approvazione di ${threshold} dell’utente.`;
    case 'fr': return `Le forfait mobile mensuel le moins cher listé par Helium Mobile est ${value}, sous le seuil d’approbation utilisateur de ${threshold}.`;
    case 'pt': return `O plano móvel mensal mais barato listado pela Helium Mobile é ${value}, abaixo do limite de aprovação de ${threshold} do usuário.`;
    case 'ko': return `Helium Mobile에 표시된 가장 저렴한 월간 모바일 요금제는 ${value}이며, 사용자의 ${threshold} 승인 임계값보다 낮습니다.`;
    case 'ru': return `Самый дешевый месячный мобильный тариф Helium Mobile указан как ${value}, ниже пользовательского порога одобрения ${threshold}.`;
    default: return `Helium Mobile's cheapest listed monthly mobile plan is ${value}, which is below the user's ${threshold} approval threshold.`;
  }
}

function belowApproveHolds(language: PolicyLanguageCode, value: string, threshold: string): string {
  switch (language) {
    case 'zh-Hans': return `${value} 低于 ${threshold}，因此“满足条件时批准”的规则成立。`;
    case 'zh-Hant': return `${value} 低於 ${threshold}，因此「條件成立時核准」的規則成立。`;
    case 'es': return `${value} está por debajo de ${threshold}, así que se cumple la condición de aprobación.`;
    case 'ja': return `${value} は ${threshold} を下回っているため、承認条件は成立します。`;
    case 'de': return `${value} liegt unter ${threshold}; die Genehmigungsbedingung ist erfüllt.`;
    case 'it': return `${value} è sotto ${threshold}, quindi la condizione di approvazione è soddisfatta.`;
    case 'fr': return `${value} est sous ${threshold}, donc la condition d’approbation est remplie.`;
    case 'pt': return `${value} está abaixo de ${threshold}, então a condição de aprovação é atendida.`;
    case 'ko': return `${value}은(는) ${threshold}보다 낮으므로 승인 조건이 충족됩니다.`;
    case 'ru': return `${value} ниже ${threshold}, поэтому условие одобрения выполнено.`;
    default: return `${value} is below ${threshold}, so the approve-when condition holds.`;
  }
}

function correctedBelowThreshold(language: PolicyLanguageCode, value: string, threshold: string): string {
  switch (language) {
    case 'zh-Hans': return `已更正模型比较：${value} 低于 ${threshold}。原始决定是拒绝。`;
    case 'zh-Hant': return `已更正模型比較：${value} 低於 ${threshold}。原始決定是拒絕。`;
    case 'es': return `Comparación del modelo corregida: ${value} está por debajo de ${threshold}. La decisión original fue rechazar.`;
    case 'ja': return `モデル比較を修正しました: ${value} は ${threshold} 未満です。元の判断は拒否でした。`;
    case 'de': return `Korrigierter Modellvergleich: ${value} liegt unter ${threshold}. Die ursprüngliche Entscheidung war Ablehnung.`;
    case 'it': return `Confronto del modello corretto: ${value} è sotto ${threshold}. La decisione originale era rifiutare.`;
    case 'fr': return `Comparaison modèle corrigée : ${value} est sous ${threshold}. La décision initiale était le refus.`;
    case 'pt': return `Comparação do modelo corrigida: ${value} está abaixo de ${threshold}. A decisão original foi negar.`;
    case 'ko': return `수정된 모델 비교: ${value}은(는) ${threshold}보다 낮습니다. 원래 결정은 거부였습니다.`;
    case 'ru': return `Исправленное сравнение модели: ${value} ниже ${threshold}. Первоначальное решение было отказом.`;
    default: return `Corrected model comparison: ${value} is under ${threshold}. Original decision was deny.`;
  }
}

function failedPolicyText(language: PolicyLanguageCode, label: string): string {
  const translatedLabel = agentReviewLocalizedFindingLabel(label, language);
  switch (language) {
    case 'zh-Hans': return `用户策略包失败：${translatedLabel}`;
    case 'zh-Hant': return `使用者策略包失敗：${translatedLabel}`;
    case 'es': return `Falló el paquete de políticas del usuario: ${translatedLabel}`;
    case 'ja': return `ユーザーポリシーバンドルが失敗しました: ${translatedLabel}`;
    case 'de': return `Benutzer-Policy-Bundle fehlgeschlagen: ${translatedLabel}`;
    case 'it': return `Bundle di policy utente non riuscito: ${translatedLabel}`;
    case 'fr': return `Échec du paquet de politiques utilisateur : ${translatedLabel}`;
    case 'pt': return `O pacote de políticas do usuário falhou: ${translatedLabel}`;
    case 'ko': return `사용자 정책 번들 실패: ${translatedLabel}`;
    case 'ru': return `Пакет пользовательских политик не прошел: ${translatedLabel}`;
    default: return `User policy bundle failed: ${label}`;
  }
}

function unsafeTranslationText(language: PolicyLanguageCode): string {
  switch (language) {
    case 'zh-Hans': return 'Agentic 无法安全翻译这条非英语策略规则。请重新表述，或在批准前用英语提供规则。';
    case 'zh-Hant': return 'Agentic 無法安全翻譯這條非英語策略規則。請重新表述，或在核准前用英語提供規則。';
    case 'es': return 'Agentic no pudo traducir de forma segura esta regla de política que no está en inglés. Reformúlala o proporciona la regla en inglés antes de aprobar.';
    case 'ja': return 'Agentic はこの英語以外のポリシールールを安全に翻訳できませんでした。承認前に言い換えるか、英語でルールを入力してください。';
    case 'de': return 'Agentic konnte diese nicht-englische Policy-Regel nicht sicher übersetzen. Formuliere sie neu oder gib die Regel vor der Genehmigung auf Englisch ein.';
    case 'it': return 'Agentic non è riuscito a tradurre in modo sicuro questa regola non inglese. Riformulala o fornisci la regola in inglese prima dell’approvazione.';
    case 'fr': return 'Agentic n’a pas pu traduire cette règle non anglaise en toute sécurité. Reformule-la ou fournis la règle en anglais avant approbation.';
    case 'pt': return 'O Agentic não conseguiu traduzir com segurança esta regra que não está em inglês. Reformule-a ou forneça a regra em inglês antes da aprovação.';
    case 'ko': return 'Agentic이 이 비영어 정책 규칙을 안전하게 번역하지 못했습니다. 승인 전에 규칙을 다시 작성하거나 영어로 제공하세요.';
    case 'ru': return 'Agentic не смог безопасно перевести это правило не на английском. Переформулируйте его или укажите правило на английском перед одобрением.';
    default: return 'Agentic could not safely translate this non-English policy rule. Rephrase it or provide the rule in English before approval.';
  }
}

function translationNeedsReviewText(language: PolicyLanguageCode): string {
  switch (language) {
    case 'zh-Hans': return '非英语策略翻译需要审核。';
    case 'zh-Hant': return '非英語策略翻譯需要審核。';
    case 'es': return 'La traducción de la política no inglesa necesita revisión.';
    case 'ja': return '英語以外のポリシー翻訳には確認が必要です。';
    case 'de': return 'Die Übersetzung der nicht-englischen Policy muss geprüft werden.';
    case 'it': return 'La traduzione della policy non inglese richiede revisione.';
    case 'fr': return 'La traduction de la règle non anglaise doit être vérifiée.';
    case 'pt': return 'A tradução da política não inglesa precisa de revisão.';
    case 'ko': return '비영어 정책 번역은 검토가 필요합니다.';
    case 'ru': return 'Перевод политики не на английском требует проверки.';
    default: return 'Non-English policy translation needs review.';
  }
}

function transactionSimulationText(language: PolicyLanguageCode): string {
  switch (language) {
    case 'zh-Hans': return '交易模拟会在钱包签名并广播后运行。除非提示要求检查链上影响，否则草稿审核不需要模拟。';
    case 'zh-Hant': return '交易模擬會在錢包簽名並廣播後執行。除非提示要求檢查鏈上影響，否則草稿審核不需要模擬。';
    case 'es': return 'La simulación de la transacción se ejecuta después de que el wallet firma y transmite. No se requiere para revisar el borrador salvo que la solicitud pregunte por efectos on-chain.';
    case 'ja': return '取引シミュレーションはウォレットが署名してブロードキャストした後に実行されます。オンチェーン影響を確認する依頼でない限り、下書きレビューには不要です。';
    case 'de': return 'Die Transaktionssimulation läuft, nachdem das Wallet signiert und gesendet hat. Für die Entwurfsprüfung ist sie nur nötig, wenn die Anfrage nach On-Chain-Auswirkungen fragt.';
    case 'it': return 'La simulazione della transazione viene eseguita dopo la firma e la trasmissione dal wallet. Non è richiesta per la revisione della bozza salvo che il prompt chieda effetti on-chain.';
    case 'fr': return 'La simulation de transaction s’exécute après la signature et la diffusion par le wallet. Elle n’est pas requise pour la vérification du brouillon sauf si la demande porte sur les effets on-chain.';
    case 'pt': return 'A simulação da transação roda depois que a wallet assina e transmite. Não é necessária para revisar o rascunho salvo se o pedido perguntar sobre efeitos on-chain.';
    case 'ko': return '거래 시뮬레이션은 월렛이 서명하고 브로드캐스트한 뒤 실행됩니다. 온체인 영향을 묻는 요청이 아니라면 초안 검토에는 필요하지 않습니다.';
    case 'ru': return 'Симуляция транзакции выполняется после подписи и отправки кошельком. Для проверки черновика она не требуется, если запрос не касается ончейн-эффектов.';
    default: return 'Transaction simulation runs after the wallet signs and broadcasts. Not required for draft review unless the prompt asks about on-chain effects.';
  }
}

function rawAuditText(language: PolicyLanguageCode): string {
  switch (language) {
    case 'zh-Hans': return '可在原始审计 JSON 中查看。';
    case 'zh-Hant': return '可在原始審計 JSON 中查看。';
    case 'es': return 'Disponible en el JSON de auditoría sin procesar.';
    case 'ja': return '未加工の監査 JSON で確認できます。';
    case 'de': return 'Im rohen Audit-JSON verfügbar.';
    case 'it': return 'Disponibile nel JSON di audit grezzo.';
    case 'fr': return 'Disponible dans le JSON d’audit brut.';
    case 'pt': return 'Disponível no JSON bruto de auditoria.';
    case 'ko': return '원시 감사 JSON에서 확인할 수 있습니다.';
    case 'ru': return 'Доступно в исходном JSON аудита.';
    default: return 'Available in raw audit JSON.';
  }
}

function decisionContractText(
  language: PolicyLanguageCode,
  decision: string,
  cited: string,
  blocking: string,
  missing: string,
): string {
  const localizedDecision = exactProseText(language, decision) ?? decision;
  switch (language) {
    case 'zh-Hans': return `决定：${localizedDecision} · 引用事实 ${cited} 条 · 阻止 ${blocking} 条 · 缺失 ${missing} 条`;
    case 'zh-Hant': return `決定：${localizedDecision} · 引用事實 ${cited} 條 · 阻止 ${blocking} 條 · 缺失 ${missing} 條`;
    case 'es': return `decisión: ${localizedDecision} · ${cited} hechos citados · ${blocking} bloqueantes · ${missing} faltantes`;
    case 'ja': return `判断: ${localizedDecision} · 引用事実 ${cited} 件 · ブロック ${blocking} 件 · 不足 ${missing} 件`;
    case 'de': return `Entscheidung: ${localizedDecision} · ${cited} zitierte Fakten · ${blocking} blockierend · ${missing} fehlend`;
    case 'it': return `decisione: ${localizedDecision} · ${cited} fatti citati · ${blocking} bloccanti · ${missing} mancanti`;
    case 'fr': return `décision : ${localizedDecision} · ${cited} faits cités · ${blocking} bloquants · ${missing} manquants`;
    case 'pt': return `decisão: ${localizedDecision} · ${cited} fatos citados · ${blocking} bloqueantes · ${missing} ausentes`;
    case 'ko': return `결정: ${localizedDecision} · 인용 사실 ${cited}개 · 차단 ${blocking}개 · 누락 ${missing}개`;
    case 'ru': return `решение: ${localizedDecision} · цитированных фактов: ${cited} · блокирующих: ${blocking} · недостающих: ${missing}`;
    default: return `decision: ${decision} · ${cited} cited facts · ${blocking} blocking · ${missing} missing`;
  }
}

function gateResultText(language: PolicyLanguageCode, result: string): string {
  const localized = exactProseText(language, result) ?? result;
  switch (language) {
    case 'zh-Hans': return `门控结果：${localized}`;
    case 'zh-Hant': return `門控結果：${localized}`;
    case 'es': return `Resultado de la puerta: ${localized}`;
    case 'ja': return `ゲート結果: ${localized}`;
    case 'de': return `Gate-Ergebnis: ${localized}`;
    case 'it': return `Risultato gate: ${localized}`;
    case 'fr': return `Résultat du contrôle : ${localized}`;
    case 'pt': return `Resultado do gate: ${localized}`;
    case 'ko': return `게이트 결과: ${localized}`;
    case 'ru': return `Результат шлюза: ${localized}`;
    default: return `Gate result: ${result}`;
  }
}

function staleReviewText(language: PolicyLanguageCode, fields: string | undefined): string {
  const changed = fields?.trim();
  switch (language) {
    case 'zh-Hans': return changed ? `审核后草稿已更改：${changed}。依赖此决定前请再次询问 agent。` : '审核后草稿已更改。依赖此决定前请再次询问 agent。';
    case 'zh-Hant': return changed ? `審核後草稿已變更：${changed}。依賴此決定前請再次詢問 agent。` : '審核後草稿已變更。依賴此決定前請再次詢問 agent。';
    case 'es': return changed ? `El borrador cambió después de la revisión: ${changed}. Pregunta al agente otra vez antes de confiar en esta decisión.` : 'El borrador cambió después de la revisión. Pregunta al agente otra vez antes de confiar en esta decisión.';
    case 'ja': return changed ? `レビュー後に下書きが変更されました: ${changed}。この判断に頼る前にエージェントへ再確認してください。` : 'レビュー後に下書きが変更されました。この判断に頼る前にエージェントへ再確認してください。';
    case 'de': return changed ? `Der Entwurf wurde nach der Prüfung geändert: ${changed}. Frage den Agenten erneut, bevor du dich auf diese Entscheidung verlässt.` : 'Der Entwurf wurde nach der Prüfung geändert. Frage den Agenten erneut, bevor du dich auf diese Entscheidung verlässt.';
    case 'it': return changed ? `La bozza è cambiata dopo la revisione: ${changed}. Chiedi di nuovo all’agente prima di affidarti a questa decisione.` : 'La bozza è cambiata dopo la revisione. Chiedi di nuovo all’agente prima di affidarti a questa decisione.';
    case 'fr': return changed ? `Le brouillon a changé après la vérification : ${changed}. Redemande à l’agent avant de t’appuyer sur cette décision.` : 'Le brouillon a changé après la vérification. Redemande à l’agent avant de t’appuyer sur cette décision.';
    case 'pt': return changed ? `O rascunho mudou após a revisão: ${changed}. Pergunte ao agente novamente antes de confiar nesta decisão.` : 'O rascunho mudou após a revisão. Pergunte ao agente novamente antes de confiar nesta decisão.';
    case 'ko': return changed ? `검토 후 초안이 변경되었습니다: ${changed}. 이 결정에 의존하기 전에 에이전트에게 다시 물어보세요.` : '검토 후 초안이 변경되었습니다. 이 결정에 의존하기 전에 에이전트에게 다시 물어보세요.';
    case 'ru': return changed ? `Черновик изменился после проверки: ${changed}. Спросите агента снова, прежде чем полагаться на это решение.` : 'Черновик изменился после проверки. Спросите агента снова, прежде чем полагаться на это решение.';
    default: return changed ? `Draft changed after review: ${changed}. Ask the agent again before relying on this decision.` : 'Draft changed after review. Ask the agent again before relying on this decision.';
  }
}

function exactProseText(language: PolicyLanguageCode, text: string): string | undefined {
  const table: Record<string, LocalizedStringMap> = {
    approve: translations('批准', '核准', 'aprobar', '承認', 'genehmigen', 'approva', 'approuver', 'aprovar', '승인', 'одобрить'),
    approved: translations('已批准', '已核准', 'aprobado', '承認済み', 'genehmigt', 'approvato', 'approuvé', 'aprovado', '승인됨', 'одобрено'),
    deny: translations('拒绝', '拒絕', 'rechazar', '拒否', 'ablehnen', 'rifiuta', 'refuser', 'negar', '거부', 'отказать'),
    denied: translations('已拒绝', '已拒絕', 'rechazado', '拒否済み', 'abgelehnt', 'rifiutato', 'refusé', 'negado', '거부됨', 'отказано'),
    needs_input: translations('需要输入', '需要輸入', 'necesita datos', '入力が必要', 'Eingabe nötig', 'serve input', 'entrée nécessaire', 'precisa de entrada', '입력 필요', 'нужен ввод'),
    pass: translations('通过', '通過', 'pasa', '通過', 'bestanden', 'passa', 'réussi', 'passou', '통과', 'прошло'),
    fail: translations('失败', '失敗', 'falla', '失敗', 'fehlgeschlagen', 'fallisce', 'échec', 'falhou', '실패', 'ошибка'),
    block: translations('阻止', '阻止', 'bloquear', 'ブロック', 'blockieren', 'blocca', 'bloquer', 'bloquear', '차단', 'блок'),
    high: translations('高', '高', 'alta', '高', 'hoch', 'alta', 'élevée', 'alta', '높음', 'высокая'),
    medium: translations('中', '中', 'media', '中', 'mittel', 'media', 'moyenne', 'média', '보통', 'средняя'),
    low: translations('低', '低', 'baja', '低', 'niedrig', 'bassa', 'faible', 'baixa', '낮음', 'низкая'),
  };
  return table[text.trim().toLowerCase()]?.[language];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
