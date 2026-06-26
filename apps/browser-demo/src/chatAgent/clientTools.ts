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
}

function isBase58Mint(value: string): boolean {
  return BASE58_MINT_PATTERN.test(value.trim());
}

function shortMint(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 8)}…` : mint;
}

export function createClientChatToolExecutor(deps: ClientChatToolDeps): ChatToolExecutor {
  const resolveMint = async (raw: string): Promise<ClientResolvedToken | null> => {
    const value = (raw ?? '').trim().replace(/^\$/, '');
    if (!value) return null;
    if (isBase58Mint(value)) return { mint: value };
    try {
      const results = await deps.searchTokens(value);
      return results[0] ?? null;
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
        const token = await resolveMint(query);
        if (!token) return { summary: `No token matched "${query}".`, data: { found: false, query } };
        if (typeof token.priceUsd === 'number') {
          return { summary: `${query}: $${token.priceUsd}`, data: { query, prices: [shapePrice(token.mint, token.priceUsd)] } };
        }
        const raw = await deps.priceForMints([token.mint]);
        const prices = raw.map((p) => shapePrice(p.mint, p.usdPrice));
        const top = prices[0];
        const summary = top && top.usdPrice != null ? `${query}: $${top.usdPrice}` : `No price for "${query}".`;
        return { summary, data: { query, prices } };
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
      const factArgs = {
        ...(walletAddress ? { walletAddress } : {}),
        ...(mintArg ? { mint: mintArg } : {}),
        ...(query ? { query } : {}),
      };
      try {
        const raw = await deps.connectorFacts({ connectorId, capability: factSpec.capability, ...factSpec.buildInput(factArgs) });
        const formatted = clampConnectorFacts(factSpec.format(raw), factSpec.maxChars);
        return { summary: `${connectorId} ${atom.action} facts`, data: { connectorId, action: atom.action, ...formatted } };
      } catch (err) {
        return { summary: `${connectorId} ${atom.action} unavailable.`, data: { connectorId, action: atom.action, unavailable: true, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    return { summary: `Unknown tool: ${name}`, data: { error: `unknown tool ${name}` } };
  };
}
