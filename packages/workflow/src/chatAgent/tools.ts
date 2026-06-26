// Chat read-tool schemas (OpenAI / Anthropic / Gemini), the proposal schema, and
// server-grade proposal validation. Pure + provider-agnostic; the loop and every
// runtime share these so the agent behaves identically everywhere.

import type { AgentChatProposedAction } from '../agentPlans.js';

// Multi-tool chains (search → price → safety → age → propose) can exceed 5 turns.
export const CHAT_TOOL_MAX_ITERATIONS = 8;
// Output cap per turn. 1500 truncated longer answers; 2048 is a safer floor. Anthropic
// gets more headroom because native web_search + citations consume output budget.
export const CHAT_TOOL_MAX_TOKENS = 2048;
export const CHAT_ANTHROPIC_MAX_TOKENS = 4096;
// Cap the prior conversation resent each turn (prevents quadratic token cost + eventual
// context-length errors on long chats). Keeps the most recent user+assistant turns.
export const CHAT_MAX_HISTORY_MESSAGES = 16;
export const CHAT_TOOL_NAMES = new Set([
  'get_token_price',
  'search_tokens',
  'get_token_safety',
  'get_market_regime',
  'get_token_age',
  'get_wallet_history',
  'get_connector_facts',
]);
export const CHAT_PROPOSAL_KINDS = new Set(['transfer_sol', 'transfer_spl', 'swap', 'sign_proof']);
export const CHAT_BASE58_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const CHAT_RESOLUTION_SOURCES = new Set(['evidence', 'user_input']);
const CHAT_STATEMENT_MAX_CHARS = 280;
// Tokens that may be referenced by symbol in a chat proposal (the prepare path resolves
// these symbols→mints via the known-token map). Every other token (the long tail of
// SPLs) MUST be a base58 mint - never a guessed symbol.
export const CHAT_MAJOR_SYMBOLS = new Set(['SOL', 'USDC', 'USDT', 'PYUSD']);
// Single source of truth for the symbol list shown in the system prompt + error messages,
// so they can never drift from the validator again (H8-D). e.g. "SOL/USDC/USDT/PYUSD".
export const CHAT_MAJOR_SYMBOLS_LABEL = [...CHAT_MAJOR_SYMBOLS].join('/');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Decode base58 and return the byte length, or -1 if not valid base58. A Solana
// address/mint is EXACTLY 32 bytes — the regex alone admits charset-valid strings of
// the wrong size, so we verify the real decoded length (defense-in-depth; the wallet
// still does the final human-approved signing). Pure JS, no deps (browser-safe).
function base58ByteLength(str: string): number {
  if (!str) return -1;
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i += 1) {
    const value = BASE58_ALPHABET.indexOf(str[i] as string);
    if (value === -1) return -1;
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (let i = 0; i < str.length && str[i] === '1'; i += 1) leadingZeros += 1;
  return leadingZeros + bytes.length;
}

// A valid Solana public key / mint: 32 bytes once base58-decoded.
export function isSolanaAddress(value: string): boolean {
  const v = value.trim();
  return CHAT_BASE58_MINT_PATTERN.test(v) && base58ByteLength(v) === 32;
}

function isResolvedTokenRef(value: string): boolean {
  const v = value.trim();
  return CHAT_MAJOR_SYMBOLS.has(v.toUpperCase()) || isSolanaAddress(v);
}

// Amount must be a finite number > 0 (rejects "abc", "0", "-1", Infinity, NaN).
function isPositiveAmount(value: unknown): boolean {
  if (value === undefined || value === null || String(value).trim() === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

// Canonicalize a positive amount to a PLAIN decimal string so the approval card + the
// prepared action never show scientific notation like "1e9 SOL" (H8-E). Returns
// undefined if the value isn't a finite positive number (caller keeps the original).
function canonicalAmount(value: unknown): string | undefined {
  if (!isPositiveAmount(value)) return undefined;
  return Number(value).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

export function chatToolStatusLabel(name: string, input: Record<string, unknown>): string {
  const query = typeof input.query === 'string' ? input.query : '';
  if (name === 'get_token_price') return query ? `Checking price of ${query}…` : 'Checking price…';
  if (name === 'search_tokens') return query ? `Searching tokens for ${query}…` : 'Searching tokens…';
  if (name === 'get_connector_facts') {
    const connector = typeof input.connectorId === 'string' && input.connectorId.trim() ? input.connectorId.trim() : 'Jupiter';
    const action = typeof input.action === 'string' ? input.action.trim() : '';
    return action ? `Reading ${connector} ${action}…` : `Reading ${connector}…`;
  }
  return `Running ${name}…`;
}

export function chatProposalSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['transfer_sol', 'transfer_spl', 'swap', 'sign_proof'] },
      summary: { type: 'string', description: 'One-line human summary, e.g. "Swap 1 SOL to USDC" or "Proof of Q3 budget review"' },
      params: {
        type: 'object',
        description: 'transfer_sol: {recipient, amountSol}. transfer_spl: {token, recipient, amount}. swap: {inputToken, outputToken, amount, slippageBps}. sign_proof: {statement} (the exact claim to sign; no transaction).',
      },
      note: { type: 'string' },
      resolution: {
        type: 'object',
        properties: {
          recipientSource: { type: 'string', enum: ['evidence', 'user_input'] },
          tokenMintSource: { type: 'string', enum: ['evidence', 'user_input'] },
        },
      },
    },
    required: ['kind', 'summary', 'params'],
  };
}

// Anthropic-style tool definitions (name/description/input_schema). This is the
// canonical shape; the OpenAI and Gemini variants are derived from it.
export function chatToolsAnthropic(): Array<Record<string, unknown>> {
  return [
    {
      name: 'get_token_price',
      description: 'Get the current USD price of a Solana token. Call this whenever the user asks what a token is worth or about its price. Accepts a token symbol (e.g. SOL, BONK) or a base58 mint address.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Token symbol or base58 mint address' } }, required: ['query'] },
    },
    {
      name: 'search_tokens',
      description: 'Search Solana tokens by symbol or name to resolve the mint address and basic facts (verification, organic score, price). Call this to disambiguate a token or resolve a symbol to a mint.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Token symbol or name to search' } }, required: ['query'] },
    },
    {
      name: 'get_token_safety',
      description: 'Get on-chain safety facts for a Solana token: whether mint & freeze authority are disabled, verification status, and organic score. Call this for any "is X safe / can it be frozen / mint authority / rug" question. Accepts a symbol or base58 mint.',
      input_schema: { type: 'object', properties: { mint: { type: 'string', description: 'Token symbol or base58 mint address' } }, required: ['mint'] },
    },
    {
      name: 'get_market_regime',
      description: 'Get current market-wide indicators: BTC dominance, total crypto market cap, and the Fear & Greed index. Call this for market-regime / fear & greed / dominance / total market cap questions.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_token_age',
      description: 'Get how old a Solana token is (mint creation time + age in seconds). Call this for "how old / when was it launched / is it fresh" questions. Accepts a symbol or base58 mint.',
      input_schema: { type: 'object', properties: { mint: { type: 'string', description: 'Token symbol or base58 mint address' } }, required: ['mint'] },
    },
    {
      name: 'get_wallet_history',
      description: "Get the connected wallet's most recent on-chain transactions (compact summaries). Call this for 'my recent transactions / activity / what did I do' questions.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_connector_facts',
      description: "Get live, pre-formatted facts for a DeFi connector action (Jupiter today). Call this for questions about the user's Jupiter Lend/Earn positions, Borrow positions & health, Limit/TP-SL (trigger) orders, DCA/recurring orders, Perps status, or prediction markets - e.g. 'my Jupiter lend positions', 'show my limit orders', 'what's my borrow health'. For token prices/safety use get_token_price / get_token_safety instead. connectorId defaults to 'jupiter'.",
      input_schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: "Connector id, e.g. 'jupiter' (default)" },
          action: { type: 'string', description: 'lend | borrow | limit | dca | perps | prediction' },
          mint: { type: 'string', description: 'Optional token/asset mint to scope the read' },
          query: { type: 'string', description: 'Optional search query (e.g. for prediction events)' },
        },
        required: ['action'],
      },
    },
    {
      name: 'propose_wallet_action',
      description: 'Prepare a wallet action for the user to review and approve. Use only when the user clearly wants to act. You never sign; the human approves.',
      input_schema: chatProposalSchema(),
    },
  ];
}

// Anthropic's native server-side web search tool. Anthropic runs the search inline
// (no round-trip to us) and folds the results into its answer; our parser tolerates
// the resulting server_tool_use / web_search_tool_result blocks. Only Anthropic has
// this — OpenAI chat/completions + Gemini-with-function-tools do not, so it's added
// ONLY to the Anthropic tool set (never to chatToolsOpenAi/chatToolsGemini).
export const CHAT_WEB_SEARCH_MAX_USES = 5;
export function chatAnthropicWebSearchTool(): Record<string, unknown> {
  return { type: 'web_search_20250305', name: 'web_search', max_uses: CHAT_WEB_SEARCH_MAX_USES };
}

// OpenAI function-tool format.
export function chatToolsOpenAi(): Array<Record<string, unknown>> {
  return chatToolsAnthropic().map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
}

// Gemini function-declaration format: a single tools[] entry holding all
// functionDeclarations { name, description, parameters }.
export function chatToolsGemini(): Array<Record<string, unknown>> {
  return [
    {
      functionDeclarations: chatToolsAnthropic().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      })),
    },
  ];
}

// Server-grade validation before a proposal is sent to the UI. The recipient must
// be a real base58 address (never fabricated from prose); the wallet still does the
// final human approval. Returns either a clean proposal or an error string.
export function validateChatProposedAction(input: Record<string, unknown>): { proposal?: AgentChatProposedAction; error?: string } {
  const kind = typeof input.kind === 'string' ? input.kind : '';
  if (!CHAT_PROPOSAL_KINDS.has(kind)) {
    return { error: 'kind must be transfer_sol, transfer_spl, swap, or sign_proof.' };
  }
  const summary = typeof input.summary === 'string' && input.summary.trim() ? input.summary.trim().slice(0, 140) : '';
  if (!summary) return { error: 'summary is required.' };
  const params = input.params && typeof input.params === 'object' ? (input.params as Record<string, unknown>) : null;
  if (!params) return { error: 'params is required.' };
  const resolution = input.resolution && typeof input.resolution === 'object' ? (input.resolution as Record<string, unknown>) : {};
  if (resolution.recipientSource === 'chat_text_alone') {
    return { error: 'recipient must come from explicit user input, not chat text.' };
  }
  // If a resolution source is present it must be one of the declared enum values
  // (never a fabricated provenance the audit trail would record verbatim).
  for (const field of ['recipientSource', 'tokenMintSource'] as const) {
    const v = resolution[field];
    if (v !== undefined && (typeof v !== 'string' || !CHAT_RESOLUTION_SOURCES.has(v))) {
      return { error: `resolution.${field} must be "evidence" or "user_input".` };
    }
  }
  if (kind === 'transfer_sol' || kind === 'transfer_spl') {
    const recipient = typeof params.recipient === 'string' ? params.recipient.trim() : '';
    if (!isSolanaAddress(recipient)) {
      return { error: 'recipient must be a valid base58 address. Ask the user for the exact address.' };
    }
    const amount = params.amount ?? params.amountSol;
    if (!isPositiveAmount(amount)) {
      return { error: 'a positive amount is required.' };
    }
    const canonical = canonicalAmount(amount);
    if (canonical !== undefined) {
      if (params.amount !== undefined) params.amount = canonical;
      if (params.amountSol !== undefined) params.amountSol = canonical;
    }
  }
  if (kind === 'transfer_spl') {
    const token = typeof params.token === 'string' ? params.token.trim() : '';
    if (!token) return { error: `transfer_spl requires the token mint (or a ${CHAT_MAJOR_SYMBOLS_LABEL} symbol) in params.token.` };
    if (!isResolvedTokenRef(token)) {
      return { error: `${token} needs a mint address (or a ${CHAT_MAJOR_SYMBOLS_LABEL} symbol). Pick the token from your balances or paste its base58 mint.` };
    }
  }
  if (kind === 'swap') {
    if (!isPositiveAmount(params.amount)) {
      return { error: 'a positive swap amount is required.' };
    }
    const canonicalSwap = canonicalAmount(params.amount);
    if (canonicalSwap !== undefined) params.amount = canonicalSwap;
    const inputToken = typeof params.inputToken === 'string' ? params.inputToken.trim() : '';
    const outputToken = typeof params.outputToken === 'string' ? params.outputToken.trim() : '';
    if (!inputToken || !outputToken) return { error: 'swap requires both params.inputToken and params.outputToken.' };
    if (!isResolvedTokenRef(inputToken)) {
      return { error: `${inputToken} needs a mint address (or a ${CHAT_MAJOR_SYMBOLS_LABEL} symbol). Pick the input token from your balances or paste its base58 mint.` };
    }
    if (!isResolvedTokenRef(outputToken)) {
      return { error: `${outputToken} needs a mint address (or a ${CHAT_MAJOR_SYMBOLS_LABEL} symbol). Pick the output token from your balances or paste its base58 mint.` };
    }
    if (inputToken === outputToken) return { error: 'input and output tokens must be different.' };
  }
  if (kind === 'sign_proof') {
    const statement = typeof params.statement === 'string' ? params.statement.trim() : typeof params.message === 'string' ? params.message.trim() : '';
    if (!statement) return { error: 'sign_proof requires params.statement (the exact claim to sign).' };
    // Cap an over-long statement so the signed message stays a concise attestation.
    if (statement.length > CHAT_STATEMENT_MAX_CHARS) {
      params.statement = statement.slice(0, CHAT_STATEMENT_MAX_CHARS);
      if ('message' in params) delete params.message;
    }
  }
  return {
    proposal: {
      kind,
      summary,
      params,
      ...(typeof input.note === 'string' ? { note: input.note.slice(0, 280) } : {}),
      ...(typeof input.cluster === 'string' ? { cluster: input.cluster } : {}),
      resolution: {
        ...(typeof resolution.recipientSource === 'string' ? { recipientSource: resolution.recipientSource as 'evidence' | 'user_input' } : {}),
        ...(typeof resolution.tokenMintSource === 'string' ? { tokenMintSource: resolution.tokenMintSource as 'evidence' | 'user_input' } : {}),
      },
      requiresApproval: true,
    },
  };
}
