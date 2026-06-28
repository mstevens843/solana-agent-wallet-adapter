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
  'get_token_market',
  'get_trending_tokens',
  'get_wallet_nfts',
  'get_asset',
  'get_coin_market',
  'get_trending_coins',
  'get_new_listings',
  'get_wallet_portfolio',
  'get_wallet_pnl',
  'get_wallet_origin',
  'get_token_top_traders',
  'get_token_supply_changes',
  'get_token_activity',
  'get_pair_overview',
  'get_smart_money_tokens',
  'get_gainers_losers',
  'get_wallet_net_worth_history',
  'get_priority_fee',
  'get_transaction',
  'get_token_holders',
  'get_coin_categories',
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
  if (name === 'get_token_market') {
    const mint = typeof input.mint === 'string' ? input.mint : '';
    return mint ? `Checking ${mint} market data…` : 'Checking market data…';
  }
  if (name === 'get_trending_tokens') return 'Checking trending tokens…';
  if (name === 'get_wallet_nfts') return 'Reading your NFTs…';
  if (name === 'get_asset') return 'Reading asset metadata…';
  if (name === 'get_coin_market') {
    const q = typeof input.query === 'string' ? input.query : '';
    return q ? `Checking ${q} on CoinGecko…` : 'Checking coin metrics…';
  }
  if (name === 'get_trending_coins') return 'Checking trending coins…';
  if (name === 'get_new_listings') return 'Checking new listings…';
  if (name === 'get_wallet_portfolio') return 'Checking wallet net worth…';
  if (name === 'get_wallet_pnl') return 'Checking wallet PnL…';
  if (name === 'get_wallet_origin') return 'Checking wallet funding origin…';
  if (name === 'get_token_top_traders') {
    const mint = typeof input.mint === 'string' ? input.mint : '';
    return mint ? `Checking ${mint} top traders…` : 'Checking top traders…';
  }
  if (name === 'get_token_supply_changes') {
    const mint = typeof input.mint === 'string' ? input.mint : '';
    return mint ? `Checking ${mint} mint/burn…` : 'Checking supply changes…';
  }
  if (name === 'get_token_activity') {
    const mint = typeof input.mint === 'string' ? input.mint : '';
    return mint ? `Checking ${mint} activity…` : 'Checking token activity…';
  }
  if (name === 'get_pair_overview') return 'Checking pair stats…';
  if (name === 'get_smart_money_tokens') return 'Checking smart-money tokens…';
  if (name === 'get_gainers_losers') return 'Checking top traders…';
  if (name === 'get_wallet_net_worth_history') return 'Checking net-worth history…';
  if (name === 'get_priority_fee') return 'Checking network priority fee…';
  if (name === 'get_transaction') {
    const sig = typeof input.signature === 'string' ? input.signature : '';
    return sig ? `Explaining transaction ${sig.slice(0, 8)}…` : 'Explaining transaction…';
  }
  if (name === 'get_token_holders') {
    const mint = typeof input.mint === 'string' ? input.mint : '';
    return mint ? `Checking ${mint} top holders…` : 'Checking top holders…';
  }
  if (name === 'get_coin_categories') {
    const cat = typeof input.category === 'string' ? input.category : '';
    return cat ? `Checking ${cat} sector…` : 'Checking crypto sectors…';
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
        // Explicit (union-of-kinds, all optional) properties: only the fields for the chosen
        // `kind` are filled; the validator enforces per-kind requirements. Declaring them is
        // strictly more guidance for OpenAI/Anthropic and is REQUIRED for Gemini, whose
        // function-declaration schema rejects an OBJECT with no `properties` (400).
        properties: {
          recipient: { type: 'string', description: 'transfer_sol/transfer_spl: destination base58 address' },
          amountSol: { type: 'string', description: 'transfer_sol: amount of SOL to send' },
          token: { type: 'string', description: 'transfer_spl: token mint or major symbol (SOL/USDC/USDT/PYUSD)' },
          amount: { type: 'string', description: 'transfer_spl/swap: amount in the sent/input token units' },
          inputToken: { type: 'string', description: 'swap: input token symbol or base58 mint' },
          outputToken: { type: 'string', description: 'swap: output token symbol or base58 mint' },
          slippageBps: { type: 'number', description: 'swap: optional slippage in basis points' },
          statement: { type: 'string', description: 'sign_proof: the exact claim to sign' },
        },
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
      description: "Get live, pre-formatted facts for a DeFi connector action. Jupiter (connectorId 'jupiter', default): Lend/Earn positions, Borrow positions & health, Limit/TP-SL (trigger) orders, DCA/recurring orders, Perps status, prediction markets, and a Swap quote (action 'swap' — preview output/price-impact/route; pass inputToken, outputToken, amount). Raydium / Orca / Meteora (action 'liquidity'): the wallet's LP positions. Kamino / Lulo (action 'lend'): supplied positions + earned interest. Jito / Marinade (action 'stake'): JitoSOL / mSOL balance, native stake accounts, unstake tickets. Drift (action 'vault'): strategy-vault positions (read-only). Wormhole (action 'bridge'): your bridge exposure (pending/recent transfers + redeem status). Pyth (action 'oracle'): on-chain oracle price + confidence + freshness for a symbol (pass it in query). Call this for 'my Kamino positions', 'my JitoSOL balance', 'my Drift vaults', 'my Lulo balances', 'my Wormhole transfers', 'Pyth price of SOL', 'preview swapping 1 SOL to USDC'. For plain token spot prices/safety use get_token_price / get_token_safety instead.",
      input_schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: "Connector id: jupiter (default) | raydium | orca | meteora | kamino | jito | marinade | drift | lulo | wormhole | pyth" },
          action: { type: 'string', description: 'jupiter: lend|borrow|limit|dca|perps|prediction|swap. raydium/orca/meteora: liquidity. kamino/lulo: lend. jito/marinade: stake. drift: vault. wormhole: bridge. pyth: oracle' },
          mint: { type: 'string', description: 'Optional token/asset mint to scope the read' },
          query: { type: 'string', description: 'Optional search query / symbol (e.g. SOL for a Pyth oracle price, or a prediction event search)' },
          inputToken: { type: 'string', description: 'Swap quote only: input token symbol or mint (e.g. SOL)' },
          outputToken: { type: 'string', description: 'Swap quote only: output token symbol or mint (e.g. USDC)' },
          amount: { type: 'string', description: 'Swap quote only: input amount (per the input token, e.g. "1")' },
        },
        required: ['action'],
      },
    },
    {
      name: 'get_token_market',
      description: "Get a Solana token's market-quality metrics: liquidity (USD), market cap, FDV, 24h volume, holder count, top-holder concentration %, 24h price change %, and organic score. Call this for 'what's X's liquidity / market cap / volume / how many holders / is it concentrated / how's it doing today'. This is the numeric counterpart to get_token_safety (which only returns authority flags). Accepts a symbol or base58 mint.",
      input_schema: { type: 'object', properties: { mint: { type: 'string', description: 'Token symbol or base58 mint address' } }, required: ['mint'] },
    },
    {
      name: 'get_trending_tokens',
      description: "Get the top trending Solana tokens right now (symbol, price, 24h change, market cap, volume). Call this for 'what's trending / hot / popular on Solana' questions.",
      input_schema: { type: 'object', properties: { interval: { type: 'string', description: "Trending window: '5m' | '1h' | '6h' | '24h' (default 24h)" } }, required: [] },
    },
    {
      name: 'get_wallet_nfts',
      description: "Get the connected wallet's NFTs (name, collection, mint, compressed flag). Call this for 'what NFTs do I own / hold / my NFTs / my collectibles'. Floor prices are NOT included here - use the Magic Eden or Tensor connector for collection floor.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_asset',
      description: "Get on-chain metadata for a single Solana asset (NFT or token) by mint: name, symbol, collection, attributes, royalty %, creators, compressed flag. Call this for 'tell me about this NFT / what is this asset / its traits / collection'. Accepts a base58 mint.",
      input_schema: { type: 'object', properties: { mint: { type: 'string', description: 'Base58 mint address of the asset' } }, required: ['mint'] },
    },
    {
      name: 'get_coin_market',
      description: "Get CoinGecko cross-chain market metrics for an established/listed coin: market-cap RANK, all-time high (ATH) + % from ATH, all-time low, circulating/total/max supply, and price change over 24h/7d/30d. Call this for 'what's X's market-cap rank / how far from its ATH / max supply / how's it done this month'. Best for major coins (SOL, BTC, ETH, JUP); for long-tail Solana tokens use get_token_market. Accepts a symbol or base58 mint.",
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Coin symbol (e.g. SOL, BTC) or base58 mint' } }, required: ['query'] },
    },
    {
      name: 'get_trending_coins',
      description: "Get the top trending coins on CoinGecko (cross-chain, by search volume): symbol, name, market-cap rank. Call this for 'what's trending in crypto overall / what are people searching'. For Solana DEX trending use get_trending_tokens instead.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_new_listings',
      description: "Get newly-listed Solana tokens (symbol, mint, name, liquidity, listed time). Call this for 'what just launched / new tokens / recent listings'. WARNING: these are unvetted and high-risk - always pair with get_token_safety / get_token_market before acting.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_wallet_portfolio',
      description: "Get a wallet's net worth (total USD) and top holdings (token, USD value, amount). Call this for 'what's wallet X worth / what's in this wallet / its holdings / portfolio value'. Works for ANY wallet address; omit `wallet` to use the connected wallet.",
      input_schema: { type: 'object', properties: { wallet: { type: 'string', description: "Base58 wallet address to analyze; omit for the user's connected wallet" } }, required: [] },
    },
    {
      name: 'get_wallet_pnl',
      description: "Get a wallet's trading PnL: realized + unrealized USD, total PnL, ROI %, win rate %, trade count. Call this for 'how is wallet X doing / its PnL / profit and loss / is it profitable'. Works for ANY wallet; omit `wallet` for the connected wallet.",
      input_schema: { type: 'object', properties: { wallet: { type: 'string', description: "Base58 wallet address; omit for the connected wallet" }, duration: { type: 'string', description: "Window: 'all' | '90d' | '30d' | '7d' | '24h' (default all)" } }, required: [] },
    },
    {
      name: 'get_wallet_origin',
      description: "Get how a wallet was first funded: the funder/source address, funding tx, time, and amount. Call this for 'who funded this wallet / where did it come from / is it a fresh wallet / wallet creator'. Works for ANY wallet; omit `wallet` for the connected wallet.",
      input_schema: { type: 'object', properties: { wallet: { type: 'string', description: "Base58 wallet address; omit for the connected wallet" } }, required: [] },
    },
    {
      name: 'get_token_top_traders',
      description: "Get a token's top traders over the last 24h (trader address, USD volume, trade count, PnL). Call this for 'who are the top/biggest traders of X / smart money / whales trading X'. Accepts a symbol or base58 mint.",
      input_schema: { type: 'object', properties: { mint: { type: 'string', description: 'Token symbol or base58 mint address' } }, required: ['mint'] },
    },
    {
      name: 'get_token_supply_changes',
      description: "Get a token's recent mint/burn transactions (type, amount, tx, time) plus mint/burn counts. Call this for 'is X's supply being minted/burned / is it being diluted / supply changes / new supply'. A dilution / rug signal; pair with get_token_safety. Accepts a symbol or base58 mint.",
      input_schema: { type: 'object', properties: { mint: { type: 'string', description: 'Token symbol or base58 mint address' } }, required: ['mint'] },
    },
    {
      name: 'get_token_activity',
      description: "Get a token's multi-timeframe trading activity: price + price-change % over 1h/4h/24h, 1h/24h volume (USD), 24h buy-vs-sell volume, unique wallets, trades, holders, market count. Call this for momentum / 'how is X moving over 1h/4h', 'buy or sell pressure', 'how many traders/wallets', '% change'. Richer than get_token_market (which is 24h only). Accepts a symbol or base58 mint.",
      input_schema: { type: 'object', properties: { mint: { type: 'string', description: 'Token symbol or base58 mint address' } }, required: ['mint'] },
    },
    {
      name: 'get_pair_overview',
      description: "Get stats for a specific liquidity pool / trading pair by its pair address: name, DEX, liquidity (USD), 24h volume, price, 24h trades. Call this for 'stats for this pool/pair', 'pool overview', 'LP pool metrics'. Takes a base58 PAIR/POOL address (not a token mint).",
      input_schema: { type: 'object', properties: { address: { type: 'string', description: 'Base58 pair / pool address' } }, required: ['address'] },
    },
    {
      name: 'get_smart_money_tokens',
      description: "Get tokens currently being accumulated by smart-money traders (symbol, mint, smart-trader count, net flow USD, market cap). Call this for 'what is smart money buying / accumulating', 'smart wallets', 'alpha plays'. May be unavailable on the current API tier.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_gainers_losers',
      description: "Get the top gaining / losing TRADERS leaderboard (trader address, PnL USD, volume, trades). Call this for 'top gainers/losers', 'who's up/down the most', 'best/worst traders today'. Distinct from get_token_top_traders (which is per-token). May be unavailable on the current API tier.",
      input_schema: { type: 'object', properties: { type: { type: 'string', description: "Window: 'today' | 'yesterday' | '1W' | '30d' | '90d' (default 1W)" } }, required: [] },
    },
    {
      name: 'get_wallet_net_worth_history',
      description: "Get a wallet's net-worth trend over time (current, earliest, change %, recent points). Call this for 'net worth over time / portfolio history / how has wallet X grown'. Pairs with get_wallet_portfolio (current snapshot). Works for ANY wallet; omit `wallet` for the connected wallet.",
      input_schema: { type: 'object', properties: { wallet: { type: 'string', description: "Base58 wallet address; omit for the connected wallet" } }, required: [] },
    },
    {
      name: 'get_priority_fee',
      description: "Get the current Solana priority-fee estimate (recommended micro-lamports per compute unit + low/medium/high/veryHigh levels + a congestion label). Call this for 'what priority fee should I use', 'is the network congested/busy', 'why is my transaction slow', 'gas right now'. The value changes within seconds - present it as 'as of now'.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_transaction',
      description: "Explain a single Solana transaction by its signature: type, source/program, human description, fee, time, and token/SOL transfers. Call this for 'what happened in tx <sig>', 'explain this transaction', 'decode this signature'. For a wallet's recent activity use get_wallet_history instead.",
      input_schema: { type: 'object', properties: { signature: { type: 'string', description: 'Base58 transaction signature' } }, required: ['signature'] },
    },
    {
      name: 'get_token_holders',
      description: "Get a token's top holders (owner wallet addresses + amount + % of supply) and combined top-holder %. Call this for 'who are the top/biggest holders of X', 'whale wallets holding X', 'which wallets hold X', 'is X whale-concentrated'. The aggregate concentration % alone is in get_token_market; this returns the actual wallet list. Accepts a symbol or base58 mint.",
      input_schema: { type: 'object', properties: { mint: { type: 'string', description: 'Token symbol or base58 mint address' } }, required: ['mint'] },
    },
    {
      name: 'get_coin_categories',
      description: "Get crypto sector/category market performance (name, market cap, 24h change %, volume, top coins). Call this for 'best/worst performing sector or narrative', 'how are AI tokens / memecoins / DeFi / gaming / L1s doing'. Pass `category` to focus one (e.g. 'artificial-intelligence', 'meme-token', 'gaming'); omit for the top sectors by market cap.",
      input_schema: { type: 'object', properties: { category: { type: 'string', description: "Optional category id/name to filter (e.g. 'artificial-intelligence', 'gaming'); omit for top sectors" } }, required: [] },
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

// Gemini's function-declaration schema is STRICTER than OpenAI/Anthropic: an OBJECT-typed
// schema MUST carry a non-empty `properties` map or generateContent returns
// `400 ... parameters.properties: should be non-empty for OBJECT type`. Our no-arg tools
// ({type:object, properties:{}}) and any property-less nested object would trip this on
// EVERY Gemini turn (the always-present propose_wallet_action included), making Gemini chat
// unusable. Produce a Gemini-safe schema: recursively DROP empty-properties OBJECT
// subschemas and return undefined when the whole `parameters` object collapses to empty
// (→ omit `parameters` for that no-arg tool). Pure transform; OpenAI/Anthropic keep the
// raw input_schema (they tolerate empty-properties objects).
export function geminiSanitizeSchema(node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as Record<string, unknown>;
  if (n.type === 'object') {
    const rawProps = n.properties && typeof n.properties === 'object' ? (n.properties as Record<string, unknown>) : {};
    const outProps: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(rawProps)) {
      const sanitizedChild = geminiSanitizeChild(child);
      if (sanitizedChild !== undefined) outProps[key] = sanitizedChild;
    }
    // An OBJECT with no usable properties is invalid for Gemini → signal "omit me".
    if (Object.keys(outProps).length === 0) return undefined;
    const out: Record<string, unknown> = { ...n, type: 'object', properties: outProps };
    if (Array.isArray(n.required)) {
      const required = (n.required as unknown[]).filter((r): r is string => typeof r === 'string' && r in outProps);
      if (required.length > 0) out.required = required;
      else delete out.required;
    }
    return out;
  }
  return n;
}

// Sanitize a property's schema. Object subschemas that collapse to empty are dropped
// (caller omits the property); arrays recurse into `items`; scalars pass through.
function geminiSanitizeChild(child: unknown): unknown {
  if (!child || typeof child !== 'object') return child;
  const c = child as Record<string, unknown>;
  if (c.type === 'object') return geminiSanitizeSchema(c); // may be undefined → dropped
  if (c.type === 'array' && c.items && typeof c.items === 'object') {
    const items = geminiSanitizeChild(c.items);
    return items === undefined ? child : { ...c, items };
  }
  return child;
}

// Gemini function-declaration format: a single tools[] entry holding all
// functionDeclarations { name, description, parameters? }.
export function chatToolsGemini(): Array<Record<string, unknown>> {
  return [
    {
      functionDeclarations: chatToolsAnthropic().map((tool) => {
        const parameters = geminiSanitizeSchema(tool.input_schema);
        return {
          name: tool.name,
          description: tool.description,
          // Omit `parameters` entirely for no-arg tools — Gemini rejects an empty OBJECT.
          ...(parameters ? { parameters } : {}),
        };
      }),
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
