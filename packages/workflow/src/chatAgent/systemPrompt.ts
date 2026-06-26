// The Agentic chat-tab system prompt + the result/context helpers. Shared so the
// agent's grounding rules, action rules, and style are identical on every path.

import type { AgentChatResult } from '../agentPlans.js';
import { CHAT_MAJOR_SYMBOLS_LABEL } from './tools.js';

const CHAT_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  'zh-Hans': 'Simplified Chinese',
  'zh-Hant': 'Traditional Chinese',
  es: 'Spanish',
  ja: 'Japanese',
  de: 'German',
  it: 'Italian',
  fr: 'French',
  pt: 'Portuguese',
  ko: 'Korean',
  ru: 'Russian',
};

export interface ChatPromptContext {
  walletAddress?: string;
  context?: Record<string, unknown>;
}

function chatContextWalletAddress(context: Record<string, unknown> | undefined): string {
  if (!context) return '';
  const browserWallet = context.browserWallet;
  if (browserWallet && typeof browserWallet === 'object' && !Array.isArray(browserWallet)) {
    const record = browserWallet as Record<string, unknown>;
    const connected = record.connected === true || record.connected === 'true';
    const address = typeof record.address === 'string' ? record.address.trim() : '';
    if (connected && address) return address;
  }
  const wallet = context.wallet;
  if (wallet && typeof wallet === 'object' && !Array.isArray(wallet)) {
    const record = wallet as Record<string, unknown>;
    const address = typeof record.address === 'string' ? record.address.trim() : typeof record.publicKey === 'string' ? record.publicKey.trim() : '';
    if (address) return address;
  }
  return typeof context.connectedWallet === 'string' ? context.connectedWallet.trim() : '';
}

export function effectiveChatWalletAddress(request: ChatPromptContext): string {
  return (request.walletAddress || '').trim() || chatContextWalletAddress(request.context);
}

const CHAT_CONTEXT_MAX_CHARS = 3500;

function chatReadOnlyWalletContext(request: ChatPromptContext): string {
  const context = request.context ?? {};
  const out: Record<string, unknown> = {};
  // `resolvedFacts` is the server's pre-resolved API data (token safety/age, market
  // regime, wallet history, connector facts) — present them so the model answers without
  // re-calling those tools. `connectorContext` is the compact connector capability index
  // (+ selected card) so the model knows the DeFi connector surface. Both can be absent
  // on some paths, so this is a harmless no-op there.
  for (const key of ['browserWallet', 'wallet', 'walletBalance', 'walletBalanceStatus', 'resolvedFacts', 'connectorContext']) {
    const value = context[key];
    if (value !== undefined) out[key] = value;
  }
  if (Object.keys(out).length === 0) return '';
  let json = JSON.stringify(out);
  if (json.length <= CHAT_CONTEXT_MAX_CHARS) return json;
  // Over budget — drop whole fields (least → most useful) so the result stays VALID
  // JSON instead of being sliced mid-structure (which would hand the model malformed
  // JSON). connectorContext (static capability index) is sacrificed FIRST since the model
  // can still call get_connector_facts without it; then the wallet-identity fields (the
  // "Connected wallet:" line already restates the address); walletBalance + resolvedFacts
  // are kept last.
  for (const dropKey of ['connectorContext', 'walletBalanceStatus', 'browserWallet', 'wallet']) {
    if (dropKey in out) {
      delete out[dropKey];
      json = JSON.stringify(out);
      if (json.length <= CHAT_CONTEXT_MAX_CHARS) return json;
    }
  }
  // Still over budget (huge holdings or resolvedFacts): note the omission rather than
  // emit a truncated, unparseable blob.
  return JSON.stringify({ note: 'wallet context too large; ask the user to narrow the question' });
}

export function chatAgenticSystemPrompt(request: ChatPromptContext): string {
  const wallet = effectiveChatWalletAddress(request) || 'not connected';
  const readOnlyWalletContext = chatReadOnlyWalletContext(request);
  const uiLanguage = typeof request.context?.uiLanguage === 'string' ? request.context.uiLanguage : 'en';
  const languageName = CHAT_LANGUAGE_NAMES[uiLanguage] ?? '';
  return [
    "You are Agentic, a knowledgeable, concise general-purpose assistant embedded in the user's Solana wallet app.",
    'Answer ANY question the user asks - general knowledge, coding, writing, math, current events, or anything else - the same way a top assistant would. You ALSO have first-class wallet abilities: explain the wallet, tokens, prices, safety, and market data, and prepare wallet actions for the user\'s explicit approval. Use the wallet tools ONLY when the question is about Solana tokens/markets/this wallet; for everything else just answer directly (use web_search when available, otherwise your own knowledge with the honest caveat below).',
    `Connected wallet: ${wallet}. Network: mainnet-beta (this app is mainnet-only).`,
    ...(readOnlyWalletContext ? [`Read-only wallet context: ${readOnlyWalletContext}`] : []),
    ...(languageName && uiLanguage !== 'en'
      ? [`LANGUAGE: Always reply in ${languageName}, regardless of the language the user writes in. Keep token symbols, mint/wallet addresses, numbers, and URLs verbatim.`]
      : []),
    '',
    'GROUNDING (API-first): For any token price or token information, you MUST call the provided tools (get_token_price, search_tokens) and base your answer on the returned data. Never invent prices, balances, token mints, or addresses. If a tool returns no data, say what is missing; do not guess.',
    "WALLET HOLDINGS: For the user's own balances, holdings, biggest position, or portfolio value, use the provided walletBalance context (sol, usdc, and holdings[] sorted by USD value, plus totalUsd) - it is their current on-chain wallet. Do not call tools for it. If no walletBalance is present, say balances are still loading.",
    'DATA TOOLS: For token safety (mint/freeze authority, verified, organic score) call get_token_safety; for a token\'s market metrics (liquidity, market cap, FDV, 24h volume, holder count, top-holder %, 24h price change, organic score) call get_token_market; for token age call get_token_age; for market regime (BTC dominance, total market cap, fear & greed) call get_market_regime; for what\'s trending on Solana call get_trending_tokens; for this wallet\'s recent transactions call get_wallet_history. You MUST call the matching tool first for these. Never invent authority status, liquidity, volume, holders, token age, market figures, or transactions; if a tool result has "unavailable":true or an "error", say what is missing.',
    'CONNECTORS: For DeFi connector actions call get_connector_facts with connectorId + action. Jupiter (default): lend/borrow/limit/dca/perps/prediction, plus a swap quote (action swap with inputToken+outputToken+amount). Raydium / Orca / Meteora: LP positions (action liquidity). Kamino / Lulo: supplied positions (action lend). Jito / Marinade: JitoSOL / mSOL balance + stake accounts + unstake tickets (action stake). Drift: strategy-vault positions, read-only (action vault). Wormhole: bridge exposure / transfers (action bridge). Pyth: on-chain oracle price + confidence + freshness for a symbol passed in query (action oracle). connectorContext lists the available actions and the selected connector card - use it to explain what a connector can do; for live positions/orders/balances/quotes you MUST call get_connector_facts first and never invent them. If a result has "unavailable":true or names a disabled/deprecated product, say it is unavailable or read-only.',
    'WEB / OFF-CHAIN: Use the web_search tool ONLY if it is provided to you. If you do search, base the answer on the results. If web_search is NOT available, you may answer general/off-chain questions (e.g. subscription prices, stock prices, news) from your own knowledge, but you MUST say it is "from my general knowledge, not live-verified". NEVER claim you searched the web or have live data when you did not.',
    '',
    'ACTIONS: When the user clearly wants to act (send, transfer, swap, or sign a proof), you MUST call the propose_wallet_action tool to PREPARE it. Preparing is always safe: it only renders a review card. The human reviews the card and signs in their own wallet. You never sign, submit, broadcast, or approve.',
    `- ALWAYS PREPARE, NEVER REFUSE: do not decline to prepare a transfer or swap on safety grounds. Self-transfers (recipient equals the connected wallet) are explicitly allowed - prepare them normally; the wallet still asks the human to sign. The ONLY valid reasons not to prepare are a missing/invalid recipient address, a missing amount, or an unresolved token mint (any token other than ${CHAT_MAJOR_SYMBOLS_LABEL}, which may be passed by symbol). In those cases ask one concise follow-up for the missing field instead of refusing.`,
    '- You NEVER sign, submit, approve, or send. You only prepare a proposal; the human reviews a card and approves in their wallet.',
    '- kind must be one of: transfer_sol, transfer_spl, swap, sign_proof.',
    '- sign_proof: to create a signed proof or attestation of a statement (this signs a MESSAGE, not a transaction; no recipient or amount), call propose_wallet_action with kind "sign_proof", params.statement set to the exact claim the user wants to attest, and a short title in summary.',
    '- For transfers, the recipient MUST be a real base58 address that the user typed explicitly. If you do not have an exact recipient address, DO NOT propose — ask the user for the exact address.',
    `- Token params: ${CHAT_MAJOR_SYMBOLS_LABEL} may be passed by symbol. For ANY other token you MUST first call search_tokens and put the returned base58 mint (NOT the symbol) into params (params.token for transfer_spl; params.inputToken / params.outputToken for swap). Never propose an unresolved or guessed token.`,
    '- Set resolution.recipientSource to "user_input" only when the user typed the address; never fabricate it.',
    '',
    'STYLE: Be direct and brief. Lead with the answer (no "I will check..." preamble). Use plain hyphens, never em-dashes. You may use simple markdown: **bold**, `inline code`, and "- " bullet or "1. " numbered lists. No headings, tables, images, or raw HTML. After proposing an action, tell the user to review the card and approve it.',
    'SAFETY: Never request private keys, seed phrases, or wallet auth tokens. Never claim anything is signed, sent, or guaranteed safe.',
  ].join('\n');
}

export function emptyChatResult(): AgentChatResult {
  return { answer: '', checkedAt: new Date().toISOString(), source: 'ai' };
}

export function chatResult(answer: string): AgentChatResult {
  return { answer: answer.slice(0, 4000), checkedAt: new Date().toISOString(), source: 'ai' };
}

// H7-B — the loop's user-facing fallback strings, localized for the app's 11 languages
// (Android is fully multilingual; these run with request.context.uiLanguage on the
// device-agent + Plan-Connector paths). uiLanguage omitted / unknown → English.
type ChatUiStringKey = 'noTextPrepared' | 'noTextError' | 'exhausted' | 'truncatedSuffix';
// `en` is required (the guaranteed fallback); other languages are optional overrides.
const CHAT_UI_STRINGS: Record<ChatUiStringKey, { en: string } & Record<string, string>> = {
  noTextPrepared: {
    en: 'I prepared the action below. Review the details and approve it in your wallet when you are ready.',
    es: 'Preparé la acción a continuación. Revisa los detalles y apruébala en tu billetera cuando estés listo.',
    pt: 'Preparei a ação abaixo. Revise os detalhes e aprove na sua carteira quando estiver pronto.',
    fr: "J'ai préparé l'action ci-dessous. Vérifiez les détails et approuvez-la dans votre portefeuille quand vous êtes prêt.",
    de: 'Ich habe die Aktion unten vorbereitet. Prüfe die Details und bestätige sie in deiner Wallet, wenn du bereit bist.',
    it: "Ho preparato l'azione qui sotto. Controlla i dettagli e approvala nel tuo wallet quando sei pronto.",
    ru: 'Я подготовил действие ниже. Проверьте детали и подтвердите его в своём кошельке, когда будете готовы.',
    ja: '下のアクションを準備しました。内容を確認し、準備ができたらウォレットで承認してください。',
    ko: '아래 작업을 준비했습니다. 세부 정보를 확인하고 준비되면 지갑에서 승인하세요.',
    'zh-Hans': '我已准备好下面的操作。请查看详情，准备好后在你的钱包中批准。',
    'zh-Hant': '我已準備好下面的操作。請查看詳情，準備好後在你的錢包中批准。',
  },
  noTextError: {
    en: 'I could not produce a response. Please rephrase and try again.',
    es: 'No pude generar una respuesta. Reformula la pregunta e inténtalo de nuevo.',
    pt: 'Não consegui gerar uma resposta. Reformule a pergunta e tente novamente.',
    fr: "Je n'ai pas pu générer de réponse. Reformulez votre question et réessayez.",
    de: 'Ich konnte keine Antwort erzeugen. Formuliere die Frage neu und versuche es erneut.',
    it: 'Non sono riuscito a generare una risposta. Riformula la domanda e riprova.',
    ru: 'Не удалось сформировать ответ. Переформулируйте запрос и попробуйте снова.',
    ja: '応答を生成できませんでした。質問を言い換えてもう一度お試しください。',
    ko: '응답을 생성하지 못했습니다. 질문을 다시 표현해 다시 시도해 주세요.',
    'zh-Hans': '我无法生成回复。请换个说法再试一次。',
    'zh-Hant': '我無法生成回覆。請換個說法再試一次。',
  },
  exhausted: {
    en: 'I gathered some data but could not finish. Please narrow the question and try again.',
    es: 'Reuní algunos datos pero no pude terminar. Acota la pregunta e inténtalo de nuevo.',
    pt: 'Reuni alguns dados, mas não consegui terminar. Restrinja a pergunta e tente novamente.',
    fr: "J'ai recueilli des données mais je n'ai pas pu terminer. Précisez la question et réessayez.",
    de: 'Ich habe einige Daten gesammelt, konnte aber nicht abschließen. Grenze die Frage ein und versuche es erneut.',
    it: 'Ho raccolto alcuni dati ma non sono riuscito a completare. Restringi la domanda e riprova.',
    ru: 'Я собрал некоторые данные, но не смог завершить. Уточните вопрос и попробуйте снова.',
    ja: 'データを集めましたが、完了できませんでした。質問を絞ってもう一度お試しください。',
    ko: '일부 데이터를 수집했지만 완료하지 못했습니다. 질문을 좁혀 다시 시도해 주세요.',
    'zh-Hans': '我收集了一些数据，但未能完成。请缩小问题范围后再试。',
    'zh-Hant': '我收集了一些資料，但未能完成。請縮小問題範圍後再試。',
  },
  truncatedSuffix: {
    en: '(response was cut off at the length limit; ask me to continue.)',
    es: '(la respuesta se cortó por el límite de longitud; pídeme que continúe.)',
    pt: '(a resposta foi cortada pelo limite de tamanho; peça para eu continuar.)',
    fr: '(la réponse a été coupée à la limite de longueur ; demandez-moi de continuer.)',
    de: '(die Antwort wurde am Längenlimit abgeschnitten; bitte mich fortzufahren.)',
    it: '(la risposta è stata troncata al limite di lunghezza; chiedimi di continuare.)',
    ru: '(ответ обрезан из-за ограничения длины; попросите меня продолжить.)',
    ja: '（応答が長さ制限で途切れました。続きを求めてください。）',
    ko: '(응답이 길이 제한으로 잘렸습니다. 계속하도록 요청하세요.)',
    'zh-Hans': '（回复因长度限制被截断；让我继续即可。）',
    'zh-Hant': '（回覆因長度限制被截斷；讓我繼續即可。）',
  },
};

function chatUiString(key: ChatUiStringKey, uiLanguage?: string): string {
  const table = CHAT_UI_STRINGS[key];
  const localized = uiLanguage ? table[uiLanguage] : undefined;
  return localized ?? table.en;
}

export function chatNoTextFallback(proposalEmitted: boolean, uiLanguage?: string): string {
  return chatUiString(proposalEmitted ? 'noTextPrepared' : 'noTextError', uiLanguage);
}

export function chatLoopExhaustedMessage(uiLanguage?: string): string {
  return chatUiString('exhausted', uiLanguage);
}

// The "(cut off at the length limit)" suffix, localized; wrapped in markdown italics by the caller.
export function chatTruncatedSuffix(uiLanguage?: string): string {
  return chatUiString('truncatedSuffix', uiLanguage);
}
