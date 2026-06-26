// The Agentic chat-tab system prompt + the result/context helpers. Shared so the
// agent's grounding rules, action rules, and style are identical on every path.

import type { AgentChatResult } from '../agentPlans.js';

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

function chatReadOnlyWalletContext(request: ChatPromptContext): string {
  const context = request.context ?? {};
  const out: Record<string, unknown> = {};
  // `resolvedFacts` is the server's pre-resolved API data (token safety/age, market
  // regime, wallet history) — present them so the model answers without re-calling
  // those tools. Absent on the client (Device Agent), so it's a harmless no-op there.
  for (const key of ['browserWallet', 'wallet', 'walletBalance', 'walletBalanceStatus', 'resolvedFacts']) {
    const value = context[key];
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out).slice(0, 3500) : '';
}

export function chatAgenticSystemPrompt(request: ChatPromptContext): string {
  const wallet = effectiveChatWalletAddress(request) || 'not connected';
  const readOnlyWalletContext = chatReadOnlyWalletContext(request);
  const uiLanguage = typeof request.context?.uiLanguage === 'string' ? request.context.uiLanguage : 'en';
  const languageName = CHAT_LANGUAGE_NAMES[uiLanguage] ?? '';
  return [
    "You are the Agentic wallet assistant, a knowledgeable, concise Solana agent embedded in the user's wallet app.",
    'You help the user understand their wallet, tokens, prices, and risk, and you can prepare wallet actions for their explicit approval.',
    `Connected wallet: ${wallet}. Network: mainnet-beta (this app is mainnet-only).`,
    ...(readOnlyWalletContext ? [`Read-only wallet context: ${readOnlyWalletContext}`] : []),
    ...(languageName && uiLanguage !== 'en'
      ? [`LANGUAGE: Always reply in ${languageName}, regardless of the language the user writes in. Keep token symbols, mint/wallet addresses, numbers, and URLs verbatim.`]
      : []),
    '',
    'GROUNDING (API-first): For any token price or token information, you MUST call the provided tools (get_token_price, search_tokens) and base your answer on the returned data. Never invent prices, balances, token mints, or addresses. If a tool returns no data, say what is missing; do not guess.',
    "WALLET HOLDINGS: For the user's own balances, holdings, biggest position, or portfolio value, use the provided walletBalance context (sol, usdc, and holdings[] sorted by USD value, plus totalUsd) - it is their current on-chain wallet. Do not call tools for it. If no walletBalance is present, say balances are still loading.",
    'DATA TOOLS: For token safety (mint/freeze authority, verified, organic score) call get_token_safety; for token age call get_token_age; for market regime (BTC dominance, total market cap, fear & greed) call get_market_regime; for this wallet\'s recent transactions call get_wallet_history. You MUST call the matching tool first for these. Never invent authority status, token age, market figures, or transactions; if a tool result has "unavailable":true or an "error", say what is missing.',
    'WEB / OFF-CHAIN: Use the web_search tool ONLY if it is provided to you. If you do search, base the answer on the results. If web_search is NOT available, you may answer general/off-chain questions (e.g. subscription prices, stock prices, news) from your own knowledge, but you MUST say it is "from my general knowledge, not live-verified". NEVER claim you searched the web or have live data when you did not.',
    '',
    'ACTIONS: When the user clearly wants to act (send, transfer, swap, or sign a proof), you MUST call the propose_wallet_action tool to PREPARE it. Preparing is always safe: it only renders a review card. The human reviews the card and signs in their own wallet. You never sign, submit, broadcast, or approve.',
    '- ALWAYS PREPARE, NEVER REFUSE: do not decline to prepare a transfer or swap on safety grounds. Self-transfers (recipient equals the connected wallet) are explicitly allowed - prepare them normally; the wallet still asks the human to sign. The ONLY valid reasons not to prepare are a missing/invalid recipient address, a missing amount, or an unresolved non-SOL/USDC token mint. In those cases ask one concise follow-up for the missing field instead of refusing.',
    '- You NEVER sign, submit, approve, or send. You only prepare a proposal; the human reviews a card and approves in their wallet.',
    '- kind must be one of: transfer_sol, transfer_spl, swap, sign_proof.',
    '- sign_proof: to create a signed proof or attestation of a statement (this signs a MESSAGE, not a transaction; no recipient or amount), call propose_wallet_action with kind "sign_proof", params.statement set to the exact claim the user wants to attest, and a short title in summary.',
    '- For transfers, the recipient MUST be a real base58 address that the user typed explicitly. If you do not have an exact recipient address, DO NOT propose — ask the user for the exact address.',
    '- Token params: SOL and USDC may be passed by symbol. For ANY other token you MUST first call search_tokens and put the returned base58 mint (NOT the symbol) into params (params.token for transfer_spl; params.inputToken / params.outputToken for swap). Never propose an unresolved or guessed token.',
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

export function chatNoTextFallback(proposalEmitted: boolean): string {
  return proposalEmitted
    ? 'I prepared the action below. Review the details and approve it in your wallet when you are ready.'
    : 'I could not produce a response. Please rephrase and try again.';
}

export function chatLoopExhaustedMessage(): string {
  return 'I gathered some data but could not finish. Please narrow the question and try again.';
}
