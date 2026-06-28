export const CHAT_FACT_CATEGORIES = [
  'token_price',
  'token_search',
  'token_safety',
  'market_regime',
  'token_market',
  'trending_tokens',
  'token_age',
  'wallet_history',
  'wallet_nfts',
  'asset_metadata',
  'coin_market',
  'trending_coins',
  'new_listings',
  'wallet_portfolio',
  'wallet_pnl',
  'wallet_origin',
  'token_top_traders',
  'token_supply_changes',
  'token_activity',
  'pair_overview',
  'smart_money_tokens',
  'gainers_losers',
  'wallet_net_worth_history',
  'priority_fee',
  'transaction',
  'token_holders',
  'coin_categories',
  'connector_facts',
  'web_current_fact',
] as const;

export type ChatFactCategory = (typeof CHAT_FACT_CATEGORIES)[number];

export interface ChatFactClassification {
  categories: ChatFactCategory[];
  /** True when the latest user message should prefer native web/search over crypto APIs. */
  webSearchPreferred: boolean;
  /** True for own-wallet questions that should stay on wallet context/tools, never web. */
  ownWallet: boolean;
}

function has(text: string, re: RegExp): boolean {
  return re.test(text);
}

function add(out: Set<ChatFactCategory>, category: ChatFactCategory, condition: boolean): void {
  if (condition) out.add(category);
}

export function chatMentionsOwnWalletText(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  const balance = /\b(balance|balances|portfolio|holdings?|worth|value)\b/.test(t) &&
    /\b(my|wallet|current|sol|usdc|token|tokens|portfolio)\b/.test(t);
  if (balance) return true;
  return /\b(my|wallet)\b/.test(t) &&
    /\b(address|account|history|activity|transactions?|positions?|nfts?)\b/.test(t);
}

export function chatTextNeedsWebResearch(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return false;
  return (
    /\b(latest|today|tonight|tomorrow|yesterday|real[-\s]?time|up[-\s]?to[-\s]?date|as of)\b/.test(normalized) ||
    /\b(price|cost|fee|rate|plan|subscription|monthly|per\s+month|market\s+cap|liquidity|apr|apy|weather|news|status|available|availability|outage|exploit|hack|incident|upgrade|governance|vote|sec|sanctions|ofac|kyc|issuer|jailed|tps|slot|withdrawals?|paused|offline)\b/.test(normalized) &&
      /\b(check|find|look\s+up|search|verify|how\s+much|whether|if|less\s+than|more\s+than|under|over|above|below|approve|deny|reject)\b/.test(normalized) ||
    /\$\s*\d+/.test(normalized) && /\b(less\s+than|more\s+than|under|over|approve|deny|per\s+month|monthly)\b/.test(normalized)
  );
}

export function classifyChatFactText(text: string): ChatFactClassification {
  const t = text.toLowerCase();
  const categories = new Set<ChatFactCategory>();
  const ownWallet = chatMentionsOwnWalletText(text);

  add(categories, 'token_search', has(t, /\b(resolve|find|search|which token|token mint|mint address|contract address|what token)\b/));
  add(categories, 'token_price', has(t, /\b(price|worth|usd value|trades? at|quote|how much is|what'?s .* worth)\b/));
  add(categories, 'token_safety', has(t, /\b(safe|safety|rug|honeypot|mint authority|freeze authority|can (?:they|the issuer|someone|anyone) freeze|verified)\b/));
  add(categories, 'market_regime', has(t, /\b(fear (?:and|&|\/) ?greed|btc dominance|bitcoin dominance|eth dominance|market regime|total (?:crypto )?market cap|market sentiment)\b/));
  add(categories, 'token_age', has(t, /\b(how old|token age|days? old|fresh launch|newly? launched|just launched|when (?:was|did)\b.*\b(?:launch|created|mint))\b/));
  add(categories, 'wallet_history', has(t, /\b(my (?:recent )?(?:transactions?|txns?|history|activity)|recent (?:transactions?|activity)|what did i (?:do|send|swap|buy)|last (?:few )?(?:transactions?|txns?))\b/));
  add(categories, 'token_market', has(t, /\b(liquidity|market cap|mcap|fdv|fully diluted|24h volume|trading volume|holder count|how many holders|top holders?|concentration|price change|24h change)\b/));
  add(categories, 'trending_tokens', has(t, /\b(trending|what'?s hot|hot tokens?|popular tokens?|top (?:gainers|movers|tokens))\b/));
  add(categories, 'wallet_nfts', has(t, /\b(my nfts?|nfts? (?:do i|i)\s*(?:own|have|hold)|my collectibles?|what nfts?)\b/));
  add(categories, 'asset_metadata', has(t, /\b(asset metadata|nft metadata|traits?|royalt(?:y|ies)|collection|creators?)\b/));
  add(categories, 'coin_market', has(t, /\b(market cap rank|mcap rank|ranked\b|all[-\s]?time high|\bath\b|circulating supply|max supply|how far from)\b/));
  add(categories, 'trending_coins', has(t, /\b(trending coins?|trending (?:in )?crypto|cross[-\s]?chain trending|trending overall)\b/));
  add(categories, 'new_listings', has(t, /\b(new listings?|newly listed|just launched|new tokens?|recent listings?|what just launched)\b/));
  add(categories, 'wallet_portfolio', has(t, /\b(net ?worth|portfolio value|wallet (?:value|worth|holdings|balance)|what(?:'s| is) (?:in |inside |this )?(?:the )?wallet|how much is .*(?:wallet|address).* worth|holdings of)\b/));
  add(categories, 'wallet_pnl', has(t, /\b(p ?n ?l|p&l|profit (?:and|&|\/) ?loss|profit\/loss|how much (?:has|have|did) .*(?:made|lost|gained|profit)|realized pnl|unrealized pnl|win[- ]?rate|\broi\b)\b/));
  add(categories, 'wallet_origin', has(t, /\b(who funded|first funded|funding source|funded (?:by|this)|wallet (?:age|origin|creator)|fresh wallet|brand new wallet|when was .* funded)\b/));
  add(categories, 'token_top_traders', has(t, /\b(top traders?|smart money|biggest (?:buyers?|traders?|whales?)|whales?|who(?:'s| is| are) (?:trading|buying)|best traders?)\b/));
  add(categories, 'token_supply_changes', has(t, /\b(mint(?:ed|ing|s)?|burn(?:ed|ing|s)?|supply change|dilution|new supply)\b/));
  add(categories, 'token_activity', has(t, /\b(price action|momentum|buy(?:ing)? (?:vs|or) sell|sell(?:ing)? pressure|buy pressure|trade volume|unique wallets?|how many (?:traders?|wallets?)|\d+\s*(?:m|h)\b.*\bchange|how(?:'s| is) it (?:moving|performing))\b/));
  add(categories, 'smart_money_tokens', has(t, /\b(smart money|smart wallets?|smart traders?|alpha (?:plays?|tokens?|wallets?)|what (?:are|is) (?:the )?smart .*(?:buying|accumulating))\b/));
  add(categories, 'gainers_losers', has(t, /\b(top gainers?|biggest gainers?|top losers?|biggest losers?|who(?:'s| is) up the most|who(?:'s| is) down the most|best traders? (?:today|this week|right now)|worst traders?)\b/));
  add(categories, 'wallet_net_worth_history', has(t, /\b(net ?worth (?:over time|history|chart|trend|last|past)|portfolio (?:history|over time|trend|chart)|how has .*(?:net ?worth|portfolio).*(?:grown|changed|trended))\b/));
  add(categories, 'pair_overview', has(t, /\b(pair overview|pool stats?|pool overview|lp pool|liquidity pool stats?|stats? (?:for|on) (?:the )?(?:pool|pair))\b/));
  add(categories, 'priority_fee', has(t, /\b(priority fee|prio fee|gas fee|network (?:congest|busy|fast|slow|condition)|congest(?:ed|ion)|compute unit price|how much .* (?:fast|priority)|why .* tx .* slow)\b/));
  add(categories, 'transaction', has(t, /\b(explain (?:this )?(?:transaction|tx|signature)|what (?:happened|did) .* (?:transaction|tx|signature)|decode (?:this )?(?:transaction|tx|signature)|this (?:transaction|tx|signature))\b/));
  add(categories, 'token_holders', has(t, /\b(top holders?|biggest holders?|whales? (?:holding|in)|who holds|holder (?:list|breakdown)|holder distribution|whale (?:wallets?|concentration))\b/));
  add(categories, 'coin_categories', has(t, /\b(sector|category|categories|narrative|best performing (?:sector|category|narrative)|ai tokens?|meme ?coins?|defi (?:sector|tokens?)|gaming tokens?|how are .* tokens? doing)\b/));
  add(categories, 'connector_facts', has(t, /\b(jupiter|kamino|lulo|jito|marinade|drift|wormhole|pyth|raydium|orca|meteora)\b/));

  const webSearchPreferred = !ownWallet && chatTextNeedsWebResearch(text) && (
    has(t, /\b(weather|news|status|available|availability|outage|exploit|hack|incident|upgrade|governance|vote|sec|sanctions|ofac|kyc|subscription|monthly|plan|law|schedule)\b/) ||
    !Array.from(categories).some((category) => category !== 'web_current_fact' && category !== 'connector_facts')
  );
  add(categories, 'web_current_fact', webSearchPreferred);

  return { categories: Array.from(categories), webSearchPreferred, ownWallet };
}

export function chatFactHasCategory(
  classification: ChatFactClassification,
  category: ChatFactCategory,
): boolean {
  return classification.categories.includes(category);
}
