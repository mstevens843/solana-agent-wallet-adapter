export const CHAT_TOOL_DISPLAY_LABELS: Record<string, string> = {
  get_token_price: 'Token price',
  search_tokens: 'Token search',
  get_token_safety: 'Token safety',
  get_market_regime: 'Market regime',
  get_token_age: 'Token age',
  get_wallet_history: 'Wallet history',
  get_connector_facts: 'Connector data',
  get_token_market: 'Token market',
  get_trending_tokens: 'Trending tokens',
  get_wallet_nfts: 'Wallet NFTs',
  get_asset: 'Asset metadata',
  get_coin_market: 'Coin market',
  get_trending_coins: 'Trending coins',
  get_new_listings: 'New listings',
  get_wallet_portfolio: 'Wallet portfolio',
  get_wallet_pnl: 'Wallet PnL',
  get_wallet_origin: 'Wallet origin',
  get_token_top_traders: 'Top traders',
  get_token_supply_changes: 'Supply changes',
  get_token_activity: 'Token activity',
  get_pair_overview: 'Pair overview',
  get_smart_money_tokens: 'Smart money',
  get_gainers_losers: 'Trader leaderboard',
  get_wallet_net_worth_history: 'Net-worth history',
  get_priority_fee: 'Priority fee',
  get_transaction: 'Transaction lookup',
  get_token_holders: 'Token holders',
  get_coin_categories: 'Crypto sectors',
};

export const CHAT_TOOL_RUNNING_LABELS: Record<string, string> = {
  get_token_price: 'Checking price…',
  search_tokens: 'Searching tokens…',
  get_token_safety: 'Checking token safety…',
  get_market_regime: 'Checking the market…',
  get_token_age: 'Checking token age…',
  get_wallet_history: 'Reading wallet history…',
  get_connector_facts: 'Reading connector data…',
  get_token_market: 'Checking token market…',
  get_trending_tokens: 'Checking trending tokens…',
  get_wallet_nfts: 'Reading wallet NFTs…',
  get_asset: 'Reading asset metadata…',
  get_coin_market: 'Checking coin market…',
  get_trending_coins: 'Checking trending coins…',
  get_new_listings: 'Checking new listings…',
  get_wallet_portfolio: 'Checking wallet portfolio…',
  get_wallet_pnl: 'Checking wallet PnL…',
  get_wallet_origin: 'Checking wallet origin…',
  get_token_top_traders: 'Checking top traders…',
  get_token_supply_changes: 'Checking supply changes…',
  get_token_activity: 'Checking token activity…',
  get_pair_overview: 'Checking pair overview…',
  get_smart_money_tokens: 'Checking smart money…',
  get_gainers_losers: 'Checking trader leaderboard…',
  get_wallet_net_worth_history: 'Checking net-worth history…',
  get_priority_fee: 'Checking priority fee…',
  get_transaction: 'Looking up transaction…',
  get_token_holders: 'Checking token holders…',
  get_coin_categories: 'Checking crypto sectors…',
};

export function fallbackChatToolLabel(tool: string): string {
  const cleaned = tool.replace(/^solana_/, '').replace(/_/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function chatToolDisplayLabel(tool: string): string {
  return CHAT_TOOL_DISPLAY_LABELS[tool] ?? fallbackChatToolLabel(tool);
}

export function chatToolRunningLabelText(tool: string): string {
  return CHAT_TOOL_RUNNING_LABELS[tool] ?? `Running ${chatToolDisplayLabel(tool)}…`;
}

export function explicitChatToolRunningLabelText(tool: string): string | undefined {
  return CHAT_TOOL_RUNNING_LABELS[tool];
}

export function hasExplicitChatToolLabels(tool: string): boolean {
  return tool in CHAT_TOOL_DISPLAY_LABELS && tool in CHAT_TOOL_RUNNING_LABELS;
}
