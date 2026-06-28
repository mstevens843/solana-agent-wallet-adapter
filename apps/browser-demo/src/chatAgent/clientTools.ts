// Client-side chat tool executor for the Device Agent loop. Mirrors the server's
// runChatReadTool, but every read goes through a client-callable path (the local
// bridge when present, else the cloud /api/* read proxies, else public APIs) — no
// operator secrets in the browser. The concrete readers are injected by main.ts so
// this module stays decoupled from the giant app file. Every tool returns compact
// data and NEVER throws the turn: on failure it returns { unavailable | error }.

import type { ChatToolExecutor } from '@solana-agent-wallet-adapter/workflow';
import { clampConnectorFacts, getConnectorAtom } from '@solana-agent-wallet-adapter/workflow';

const BASE58_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface ClientResolvedToken {
  mint: string;
  symbol?: string;
  name?: string;
  priceUsd?: number | null;
  isVerified?: boolean | null;
  organicScoreLabel?: string | null;
}

export interface ClientChatToolDeps {
  // Resolve a symbol/name to candidate tokens (mint + basic facts). Birdeye/Jupiter.
  searchTokens: (query: string) => Promise<ClientResolvedToken[]>;
  // Canonical-first resolution: maps a known symbol (JUP/SOL/USDC/BONK/WIF…) to its canonical mint,
  // so an ambiguous symbol never resolves to a higher-liquidity same-symbol sibling (e.g. a "JUP"
  // search ranking jlUSDC first). Returns null for unknown symbols (then searchTokens is used).
  canonicalToken?: (value: string) => ClientResolvedToken | null;
  // USD prices for one or more mints.
  priceForMints: (mints: string[]) => Promise<Array<{ mint: string; usdPrice: number | null }>>;
  // On-chain safety facts (authorities, verified, organic score) for a mint.
  tokenSafety: (mint: string) => Promise<Record<string, unknown>>;
  // Market-wide regime (BTC dominance, total mcap, fear & greed).
  marketRegime: () => Promise<Record<string, unknown>>;
  // Mint creation time / age — optional (needs Helius/bridge); undefined → unavailable.
  tokenAge?: (mint: string) => Promise<Record<string, unknown>>;
  // Connected wallet recent activity — optional (needs Helius/bridge/session).
  walletHistory?: (wallet: string) => Promise<Array<Record<string, unknown>>>;
  // Live connector action facts — optional (needs the local bridge / cloud connector
  // read proxy). Receives the connectorReadFacts input ({connectorId, capability, ...})
  // and returns the SAME raw envelope the server gets, so the shared atom format() runs
  // identically here. Undefined → connector facts come back as unavailable.
  connectorFacts?: (req: { connectorId: string; capability: string } & Record<string, unknown>) => Promise<Record<string, unknown>>;
  // Token market-quality metrics (liquidity, mcap, fdv, volume, holders, price change) —
  // optional; mirrors the server get_token_market shape. Undefined → unavailable.
  tokenMarket?: (mint: string) => Promise<Record<string, unknown>>;
  // Trending Solana tokens — optional; mirrors the server get_trending_tokens shape.
  trendingTokens?: () => Promise<Record<string, unknown>>;
  // The connected wallet's NFTs (Helius DAS) — optional. Undefined → unavailable.
  walletNfts?: (wallet: string) => Promise<Record<string, unknown>>;
  // Single asset/NFT metadata by mint (Helius DAS) — optional.
  asset?: (mint: string) => Promise<Record<string, unknown>>;
  // CoinGecko coin metrics (rank/ATH/supply) — optional; mirrors server get_coin_market.
  coinMarket?: (query: string) => Promise<Record<string, unknown>>;
  // CoinGecko cross-chain trending — optional; mirrors server get_trending_coins.
  trendingCoins?: () => Promise<Record<string, unknown>>;
  // Newly-listed Solana tokens (BirdEye) — optional; mirrors server get_new_listings.
  newListings?: () => Promise<Record<string, unknown>>;
  // Wallet net worth + holdings for ANY wallet (BirdEye) — optional; mirrors get_wallet_portfolio.
  walletPortfolio?: (wallet: string) => Promise<Record<string, unknown>>;
  // Wallet trading PnL for ANY wallet (BirdEye) — optional; mirrors get_wallet_pnl.
  walletPnl?: (wallet: string, duration: string) => Promise<Record<string, unknown>>;
  // Wallet first-funding origin for ANY wallet (BirdEye) — optional; mirrors get_wallet_origin.
  walletOrigin?: (wallet: string) => Promise<Record<string, unknown>>;
  // Token top traders (BirdEye) — optional; mirrors get_token_top_traders.
  tokenTopTraders?: (mint: string) => Promise<Record<string, unknown>>;
  // Token mint/burn supply changes (BirdEye) — optional; mirrors get_token_supply_changes.
  tokenSupplyChanges?: (mint: string) => Promise<Record<string, unknown>>;
  // Token multi-timeframe activity (BirdEye trade-data) — optional; mirrors get_token_activity.
  tokenActivity?: (mint: string) => Promise<Record<string, unknown>>;
  // Pair / pool overview (BirdEye) — optional; mirrors get_pair_overview.
  pairOverview?: (address: string) => Promise<Record<string, unknown>>;
  // Smart-money token list (BirdEye, premium) — optional; mirrors get_smart_money_tokens.
  smartMoneyTokens?: () => Promise<Record<string, unknown>>;
  // Top gaining/losing traders (BirdEye, premium) — optional; mirrors get_gainers_losers.
  gainersLosers?: (type: string) => Promise<Record<string, unknown>>;
  // Wallet net-worth history for ANY wallet (BirdEye) — optional; mirrors get_wallet_net_worth_history.
  walletNetWorthHistory?: (wallet: string) => Promise<Record<string, unknown>>;
  // Current Solana priority-fee levels (Helius) — optional; mirrors get_priority_fee.
  priorityFee?: () => Promise<Record<string, unknown>>;
  // Explain a single transaction by signature (Helius enhanced) — optional; mirrors get_transaction.
  transaction?: (signature: string) => Promise<Record<string, unknown>>;
  // Top holders of a token (BirdEye) — optional; mirrors get_token_holders.
  tokenHolders?: (mint: string) => Promise<Record<string, unknown>>;
  // Crypto sector/category performance (CoinGecko) — optional; mirrors get_coin_categories.
  coinCategories?: (category: string) => Promise<Record<string, unknown>>;
}

function isBase58Mint(value: string): boolean {
  return BASE58_MINT_PATTERN.test(value.trim());
}

function shortMint(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 8)}…` : mint;
}

// Cross-chain majors that are NOT native Solana tokens — price these via CoinGecko (coinMarket),
// never the Solana token search (which would return a low-liquidity wrapper like wBTC). Mirrors the
// server's `coingeckoIdForSymbol && !mintForSymbol` cross-chain guard.
const CROSS_CHAIN_SYMBOLS = new Set([
  'BTC', 'ETH', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'MATIC', 'DOT', 'LINK', 'TRX', 'LTC', 'BCH', 'ATOM', 'NEAR', 'APT', 'SUI', 'TON',
]);
function isCrossChainSymbol(value: string): boolean {
  return CROSS_CHAIN_SYMBOLS.has(value.trim().replace(/^\$/, '').toUpperCase());
}

export function createClientChatToolExecutor(deps: ClientChatToolDeps): ChatToolExecutor {
  const resolveMint = async (raw: string): Promise<ClientResolvedToken | null> => {
    const value = (raw ?? '').trim().replace(/^\$/, '');
    if (!value) return null;
    if (isBase58Mint(value)) return { mint: value };
    // Cross-chain asset (BTC/ETH/…): no canonical Solana mint — don't fall through to the Solana
    // token search (it would return a wrapper). get_token_price routes these to CoinGecko.
    if (isCrossChainSymbol(value)) return null;
    // Canonical-first: a known symbol resolves to its canonical mint (exactly like the swap path),
    // so a fuzzy search can't pick a higher-liquidity same-symbol sibling (e.g. "JUP" → jlUSDC).
    const canonical = deps.canonicalToken?.(value);
    if (canonical) return canonical;
    try {
      const results = await deps.searchTokens(value);
      // Prefer an EXACT (case-insensitive) symbol match over a substring/liquidity-ranked [0].
      const lower = value.toLowerCase();
      const exact = results.find((r) => typeof r.symbol === 'string' && r.symbol.toLowerCase() === lower);
      return exact ?? results[0] ?? null;
    } catch {
      return null;
    }
  };

  return async (name, input, walletAddress) => {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const mintArg = typeof input.mint === 'string' ? input.mint.trim() : '';

    if (name === 'search_tokens') {
      if (!query) return { summary: 'No query provided.', data: { error: 'query is required' } };
      try {
        const tokens = (await deps.searchTokens(query)).slice(0, 5).map((token) => ({
          symbol: token.symbol ?? null,
          name: token.name ?? null,
          mint: token.mint,
          isVerified: token.isVerified ?? null,
          organicScoreLabel: token.organicScoreLabel ?? null,
          usdPrice: token.priceUsd ?? null,
        }));
        return { summary: `Found ${tokens.length} token(s) for "${query}".`, data: { query, tokens } };
      } catch (err) {
        return { summary: 'Token search unavailable.', data: { error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_token_price') {
      if (!query) return { summary: 'No token provided.', data: { error: 'query is required' } };
      try {
        // H7-E2: shape each price like the server tool ({mint, usdPrice, priceChange24h,
        // status}) so the model sees identical keys on device-agent vs Hosted. The client
        // price source has no 24h change → null (honest); status mirrors the server.
        const shapePrice = (mint: string, usdPrice: number | null) =>
          ({ mint, usdPrice, priceChange24h: null, status: usdPrice != null ? 'priced' : 'unavailable' });
        const bare = query.replace(/^\$/, '');
        // Cross-chain asset → CoinGecko (coinMarket), never a Solana wrapper. Echo source + symbol.
        if (isCrossChainSymbol(bare) && deps.coinMarket) {
          const coin = await deps.coinMarket(bare);
          const usd = typeof coin.usdPrice === 'number' ? coin.usdPrice : null;
          return {
            summary: usd != null ? `${bare}: $${usd} (CoinGecko, cross-chain)` : `No CoinGecko price for "${bare}".`,
            data: { query: bare, source: 'coingecko', resolvedSymbol: bare, crossChain: true, usdPrice: usd, note: 'Cross-chain asset priced via CoinGecko, not a Solana wrapper.' },
          };
        }
        const token = await resolveMint(query);
        if (!token) return { summary: `No token matched "${query}".`, data: { found: false, query } };
        if (typeof token.priceUsd === 'number') {
          // Echo the resolved mint so a wrong-token answer (e.g. JUP→jlUSDC) is visible.
          return { summary: `${query}: $${token.priceUsd} (mint ${shortMint(token.mint)})`, data: { query, resolvedMint: token.mint, prices: [shapePrice(token.mint, token.priceUsd)] } };
        }
        const raw = await deps.priceForMints([token.mint]);
        const prices = raw.map((p) => shapePrice(p.mint, p.usdPrice));
        const top = prices[0];
        const summary = top && top.usdPrice != null ? `${query}: $${top.usdPrice} (mint ${shortMint(token.mint)})` : `No price for "${query}".`;
        return { summary, data: { query, resolvedMint: token.mint, prices } };
      } catch (err) {
        return { summary: 'Price lookup unavailable.', data: { error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_token_safety') {
      const token = await resolveMint(mintArg || query);
      if (!token) return { summary: 'No token resolved.', data: { error: 'a token symbol or mint is required' } };
      try {
        const data = await deps.tokenSafety(token.mint);
        return { summary: `Token safety for ${shortMint(token.mint)}`, data };
      } catch (err) {
        return { summary: 'Token safety unavailable.', data: { mint: token.mint, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_market_regime') {
      try {
        return { summary: 'Market regime', data: await deps.marketRegime() };
      } catch (err) {
        return { summary: 'Market data unavailable.', data: { unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_token_age') {
      const token = await resolveMint(mintArg || query);
      if (!token) return { summary: 'No token resolved.', data: { error: 'a token symbol or mint is required' } };
      if (!deps.tokenAge) return { summary: 'Token age unavailable.', data: { mint: token.mint, unavailable: true, reason: 'no_age_source' } };
      try {
        return { summary: `Token age for ${shortMint(token.mint)}`, data: await deps.tokenAge(token.mint) };
      } catch (err) {
        return { summary: 'Token age unavailable.', data: { mint: token.mint, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_wallet_history') {
      const wallet = (walletAddress || '').trim();
      if (!wallet) return { summary: 'No wallet connected.', data: { error: 'wallet not connected' } };
      if (!deps.walletHistory) return { summary: 'Wallet history unavailable.', data: { wallet, unavailable: true, reason: 'no_history_source' } };
      try {
        const recent = (await deps.walletHistory(wallet)).slice(0, 5);
        // H7-E3: include source like the server tool ({…, source:'helius'}).
        return { summary: 'Recent wallet activity', data: { wallet, count: recent.length, recent, source: 'helius' } };
      } catch (err) {
        return { summary: 'Wallet history unavailable.', data: { wallet, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_connector_facts') {
      const connectorId = typeof input.connectorId === 'string' && input.connectorId.trim() ? input.connectorId.trim() : 'jupiter';
      const action = typeof input.action === 'string' ? input.action.trim() : '';
      const atom = getConnectorAtom(connectorId, action);
      if (!atom) return { summary: `No connector action for "${action}".`, data: { error: `unknown action ${action} for ${connectorId}` } };
      // Knowledge-only atom (swap/portfolio) or no reader wired: return the capability
      // card so the model still answers from grounded knowledge.
      if (!atom.factSpec || !deps.connectorFacts) {
        return { summary: `${connectorId} ${atom.action} info`, data: { knowledge: atom.knowledge } };
      }
      const factSpec = atom.factSpec;
      const argStr = (key: string): string | undefined => (typeof input[key] === 'string' && (input[key] as string).trim() ? (input[key] as string).trim() : undefined);
      const factArgs = {
        ...(walletAddress ? { walletAddress } : {}),
        ...(mintArg ? { mint: mintArg } : {}),
        ...(query ? { query } : {}),
        ...(argStr('amount') ? { amount: argStr('amount') } : {}),
        ...(argStr('inputToken') ? { inputToken: argStr('inputToken') } : {}),
        ...(argStr('outputToken') ? { outputToken: argStr('outputToken') } : {}),
      };
      try {
        const raw = await deps.connectorFacts({ connectorId, capability: factSpec.capability, ...factSpec.buildInput(factArgs) });
        const formatted = clampConnectorFacts(factSpec.format(raw), factSpec.maxChars);
        return { summary: `${connectorId} ${atom.action} facts`, data: { connectorId, action: atom.action, ...formatted } };
      } catch (err) {
        return { summary: `${connectorId} ${atom.action} unavailable.`, data: { connectorId, action: atom.action, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_token_market') {
      const token = await resolveMint(mintArg || query);
      if (!token) return { summary: 'No token resolved.', data: { error: 'a token symbol or mint is required' } };
      if (!deps.tokenMarket) return { summary: 'Market data unavailable.', data: { mint: token.mint, unavailable: true, reason: 'no_market_source' } };
      try {
        return { summary: `Market data for ${shortMint(token.mint)}`, data: await deps.tokenMarket(token.mint) };
      } catch (err) {
        return { summary: 'Market data unavailable.', data: { mint: token.mint, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_trending_tokens') {
      if (!deps.trendingTokens) return { summary: 'Trending unavailable.', data: { unavailable: true, reason: 'no_trending_source' } };
      try {
        return { summary: 'Trending tokens', data: await deps.trendingTokens() };
      } catch (err) {
        return { summary: 'Trending unavailable.', data: { unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_wallet_nfts') {
      const wallet = (walletAddress || '').trim();
      if (!wallet) return { summary: 'No wallet connected.', data: { error: 'wallet not connected' } };
      if (!deps.walletNfts) return { summary: 'NFTs unavailable.', data: { wallet, unavailable: true, reason: 'no_nft_source' } };
      try {
        return { summary: 'Wallet NFTs', data: await deps.walletNfts(wallet) };
      } catch (err) {
        return { summary: 'NFTs unavailable.', data: { wallet, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_asset') {
      const mint = mintArg || query;
      if (!mint) return { summary: 'No mint provided.', data: { error: 'a base58 mint is required' } };
      if (!deps.asset) return { summary: 'Asset metadata unavailable.', data: { mint, unavailable: true, reason: 'no_asset_source' } };
      try {
        return { summary: `Asset ${shortMint(mint)}`, data: await deps.asset(mint) };
      } catch (err) {
        return { summary: 'Asset metadata unavailable.', data: { mint, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_coin_market') {
      if (!query) return { summary: 'No coin provided.', data: { error: 'a coin symbol or mint is required' } };
      if (!deps.coinMarket) return { summary: 'Coin metrics unavailable.', data: { query, unavailable: true, reason: 'no_coin_source' } };
      try {
        return { summary: `CoinGecko market for ${query}`, data: await deps.coinMarket(query) };
      } catch (err) {
        return { summary: 'Coin metrics unavailable.', data: { query, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_trending_coins') {
      if (!deps.trendingCoins) return { summary: 'Trending coins unavailable.', data: { unavailable: true, reason: 'no_trending_source' } };
      try {
        return { summary: 'Trending coins', data: await deps.trendingCoins() };
      } catch (err) {
        return { summary: 'Trending coins unavailable.', data: { unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_new_listings') {
      if (!deps.newListings) return { summary: 'New listings unavailable.', data: { unavailable: true, reason: 'no_listings_source' } };
      try {
        return { summary: 'New listings', data: await deps.newListings() };
      } catch (err) {
        return { summary: 'New listings unavailable.', data: { unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_wallet_portfolio') {
      const wallet = (typeof input.wallet === 'string' && input.wallet.trim() ? input.wallet : walletAddress || '').trim();
      if (!wallet) return { summary: 'No wallet provided.', data: { error: 'a wallet address is required' } };
      if (!deps.walletPortfolio) return { summary: 'Wallet portfolio unavailable.', data: { wallet, unavailable: true, reason: 'no_wallet_source' } };
      try {
        return { summary: `Portfolio for ${shortMint(wallet)}`, data: await deps.walletPortfolio(wallet) };
      } catch (err) {
        return { summary: 'Wallet portfolio unavailable.', data: { wallet, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_wallet_pnl') {
      const wallet = (typeof input.wallet === 'string' && input.wallet.trim() ? input.wallet : walletAddress || '').trim();
      if (!wallet) return { summary: 'No wallet provided.', data: { error: 'a wallet address is required' } };
      if (!deps.walletPnl) return { summary: 'Wallet PnL unavailable.', data: { wallet, unavailable: true, reason: 'no_wallet_source' } };
      const duration = typeof input.duration === 'string' ? input.duration : 'all';
      try {
        return { summary: `PnL for ${shortMint(wallet)}`, data: await deps.walletPnl(wallet, duration) };
      } catch (err) {
        return { summary: 'Wallet PnL unavailable.', data: { wallet, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_wallet_origin') {
      const wallet = (typeof input.wallet === 'string' && input.wallet.trim() ? input.wallet : walletAddress || '').trim();
      if (!wallet) return { summary: 'No wallet provided.', data: { error: 'a wallet address is required' } };
      if (!deps.walletOrigin) return { summary: 'Wallet origin unavailable.', data: { wallet, unavailable: true, reason: 'no_wallet_source' } };
      try {
        return { summary: `Funding origin for ${shortMint(wallet)}`, data: await deps.walletOrigin(wallet) };
      } catch (err) {
        return { summary: 'Wallet origin unavailable.', data: { wallet, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_token_top_traders') {
      const token = await resolveMint(mintArg || query);
      if (!token) return { summary: 'No token resolved.', data: { error: 'a token symbol or mint is required' } };
      if (!deps.tokenTopTraders) return { summary: 'Top traders unavailable.', data: { mint: token.mint, unavailable: true, reason: 'no_traders_source' } };
      try {
        return { summary: `Top traders for ${shortMint(token.mint)}`, data: await deps.tokenTopTraders(token.mint) };
      } catch (err) {
        return { summary: 'Top traders unavailable.', data: { mint: token.mint, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_token_supply_changes') {
      const token = await resolveMint(mintArg || query);
      if (!token) return { summary: 'No token resolved.', data: { error: 'a token symbol or mint is required' } };
      if (!deps.tokenSupplyChanges) return { summary: 'Supply changes unavailable.', data: { mint: token.mint, unavailable: true, reason: 'no_supply_source' } };
      try {
        return { summary: `Supply changes for ${shortMint(token.mint)}`, data: await deps.tokenSupplyChanges(token.mint) };
      } catch (err) {
        return { summary: 'Supply changes unavailable.', data: { mint: token.mint, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_token_activity') {
      const token = await resolveMint(mintArg || query);
      if (!token) return { summary: 'No token resolved.', data: { error: 'a token symbol or mint is required' } };
      if (!deps.tokenActivity) return { summary: 'Token activity unavailable.', data: { mint: token.mint, unavailable: true, reason: 'no_activity_source' } };
      try {
        return { summary: `Activity for ${shortMint(token.mint)}`, data: await deps.tokenActivity(token.mint) };
      } catch (err) {
        return { summary: 'Token activity unavailable.', data: { mint: token.mint, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_pair_overview') {
      const address = (typeof input.address === 'string' && input.address.trim() ? input.address : mintArg || query).trim();
      if (!address) return { summary: 'No pair provided.', data: { error: 'a pair/pool address is required' } };
      if (!deps.pairOverview) return { summary: 'Pair overview unavailable.', data: { pair: address, unavailable: true, reason: 'no_pair_source' } };
      try {
        return { summary: `Pair overview for ${shortMint(address)}`, data: await deps.pairOverview(address) };
      } catch (err) {
        return { summary: 'Pair overview unavailable.', data: { pair: address, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_smart_money_tokens') {
      if (!deps.smartMoneyTokens) return { summary: 'Smart-money tokens unavailable.', data: { unavailable: true, reason: 'no_smart_money_source' } };
      try {
        return { summary: 'Smart-money tokens', data: await deps.smartMoneyTokens() };
      } catch (err) {
        return { summary: 'Smart-money tokens unavailable.', data: { unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_gainers_losers') {
      if (!deps.gainersLosers) return { summary: 'Gainers/losers unavailable.', data: { unavailable: true, reason: 'no_traders_source' } };
      const type = typeof input.type === 'string' ? input.type : '1W';
      try {
        return { summary: 'Top traders (gainers/losers)', data: await deps.gainersLosers(type) };
      } catch (err) {
        return { summary: 'Gainers/losers unavailable.', data: { unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_wallet_net_worth_history') {
      const wallet = (typeof input.wallet === 'string' && input.wallet.trim() ? input.wallet : walletAddress || '').trim();
      if (!wallet) return { summary: 'No wallet provided.', data: { error: 'a wallet address is required' } };
      if (!deps.walletNetWorthHistory) return { summary: 'Net-worth history unavailable.', data: { wallet, unavailable: true, reason: 'no_wallet_source' } };
      try {
        return { summary: `Net-worth history for ${shortMint(wallet)}`, data: await deps.walletNetWorthHistory(wallet) };
      } catch (err) {
        return { summary: 'Net-worth history unavailable.', data: { wallet, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_priority_fee') {
      if (!deps.priorityFee) return { summary: 'Priority fee unavailable.', data: { unavailable: true, reason: 'no_network_source' } };
      try {
        return { summary: 'Priority fee / network conditions', data: await deps.priorityFee() };
      } catch (err) {
        return { summary: 'Priority fee unavailable.', data: { unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_transaction') {
      const sig = (typeof input.signature === 'string' && input.signature.trim() ? input.signature : query).trim();
      if (!sig) return { summary: 'No signature provided.', data: { error: 'a transaction signature is required' } };
      if (!deps.transaction) return { summary: 'Transaction lookup unavailable.', data: { signature: sig, unavailable: true, reason: 'no_tx_source' } };
      try {
        return { summary: `Transaction ${shortMint(sig)}`, data: await deps.transaction(sig) };
      } catch (err) {
        return { summary: 'Transaction lookup unavailable.', data: { signature: sig, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_token_holders') {
      const token = await resolveMint(mintArg || query);
      if (!token) return { summary: 'No token resolved.', data: { error: 'a token symbol or mint is required' } };
      if (!deps.tokenHolders) return { summary: 'Top holders unavailable.', data: { mint: token.mint, unavailable: true, reason: 'no_holders_source' } };
      try {
        return { summary: `Top holders for ${shortMint(token.mint)}`, data: await deps.tokenHolders(token.mint) };
      } catch (err) {
        return { summary: 'Top holders unavailable.', data: { mint: token.mint, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (name === 'get_coin_categories') {
      if (!deps.coinCategories) return { summary: 'Sector data unavailable.', data: { unavailable: true, reason: 'no_categories_source' } };
      try {
        return { summary: 'Crypto sector / category performance', data: await deps.coinCategories(typeof input.category === 'string' ? input.category : '') };
      } catch (err) {
        return { summary: 'Sector data unavailable.', data: { unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    return { summary: `Unknown tool: ${name}`, data: { error: `unknown tool ${name}` } };
  };
}
