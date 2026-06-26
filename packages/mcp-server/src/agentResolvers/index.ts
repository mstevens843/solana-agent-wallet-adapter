/**
 * Per-provider capability resolver shims for the agent atom pipeline.
 *
 * `agentCapabilityRegistry.resolveAtoms(atoms, resolver)` takes a provider-agnostic
 * resolver function. This file wires the workflow registry to the actual mcp-server
 * adapters: Jupiter price, CoinGecko (price + global regime), BirdEye (token security),
 * Helius (mint creation), alternative.me (Fear & Greed), and a 'web' tier that defers
 * to the LLM research pass.
 *
 * The resolver is provider-only and stateless aside from injected clients; tests can
 * pass stub clients to exercise each branch deterministically.
 */

import { Connection, PublicKey } from '@solana/web3.js';

import type {
  AccountWritabilityCountAtom,
  AgentAtom,
  CapabilityResolutionAttempt,
  CapabilityTier,
  ClosesAccountAtom,
  CooldownSinceLastTxAtom,
  DailyOutflowSumAtom,
  DayOfWeekWindowAtom,
  DelegatesTokenAtom,
  ExternalPriceAtom,
  InstructionCountAtom,
  MarketRegimeAtom,
  MintDecimalsAtom,
  NetworkCongestionAtom,
  NetworkMetricAtom,
  PriceAtom,
  RecentBlockhashAgeAtom,
  RecipientKnownAtom,
  RelativeAmountAtom,
  RentExemptRequiredAtom,
  RequiredSignaturesAtom,
  SetsAuthorityAtom,
  SimulationDigest,
  TimeFactAtom,
  TimeOfDayAtom,
  TokenAgeAtom,
  TokenAuditAtom,
  TokenBalanceAtom,
  TokenHeldDurationAtom,
  TokenMetricAtom,
  TokenMetricField,
  TokenSupplyAtom,
  TxFeeAtom,
  WalletAgeOnchainAtom,
  WalletBalanceAtom,
} from '@solana-agent-wallet-adapter/workflow';

import type { AgentWalletConfig } from '../config.js';
import {
  AlternativeMeClient,
  getAlternativeMeClient,
} from '../adapters/alternative_me/index.js';
import { getJupiterPrice } from '../adapters/jupiter/prices.js';
import { getJupiterTokenRiskEvidence, type JupiterTokenRiskEvidence } from '../adapters/jupiter/tokenEvidence.js';
import { requestBirdeyeTokenSecurity } from '../birdeye.js';
import {
  requestCoinGecko,
  requestCoinGeckoGlobal,
  type CoinGeckoGlobalSnapshot,
} from '../coingecko.js';
import { getMintCreationTxForMint } from '../helius.js';

type BlockhashValidityResult = boolean | { value: boolean };

type BlockhashValidityConnection = Connection & {
  isBlockhashValid?: (
    blockhash: string,
    rawConfig?: { commitment?: 'processed' | 'confirmed' | 'finalized' },
  ) => Promise<BlockhashValidityResult>;
  _rpcRequest?: (method: string, args: unknown[]) => Promise<unknown>;
};

/* -------------------------------------------------------------------------- */
/* Subject → mint mapping                                                      */
/* -------------------------------------------------------------------------- */

/** Solana-mainnet mint addresses for canonical symbols. Used by the Jupiter / BirdEye
 *  resolvers when the atom's `subject` is a symbol rather than a mint address. */
export const KNOWN_SYMBOL_MINTS: Readonly<Record<string, string>> = Object.freeze({
  SOL: 'So11111111111111111111111111111111111111112',
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
});

/** CoinGecko coin ids for symbols that don't live on Solana (BTC, ETH) or that
 *  benefit from CoinGecko's broader off-Solana price coverage. */
export const KNOWN_SYMBOL_COINGECKO_IDS: Readonly<Record<string, string>> = Object.freeze({
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  USDC: 'usd-coin',
  USDT: 'tether',
});

/** Returns the canonical Solana mint for a symbol, or undefined if the symbol
 *  is already a mint address or has no known mint mapping. */
export function mintForSymbol(symbolOrMint: string): string | undefined {
  const upper = symbolOrMint.trim().toUpperCase();
  return KNOWN_SYMBOL_MINTS[upper];
}

/** Returns the CoinGecko coin id for a known symbol, or undefined. */
export function coingeckoIdForSymbol(symbol: string): string | undefined {
  return KNOWN_SYMBOL_COINGECKO_IDS[symbol.trim().toUpperCase()];
}

/* -------------------------------------------------------------------------- */
/* Result helpers                                                              */
/* -------------------------------------------------------------------------- */

function ok<T>(source: string, value: T, endpoint?: string): CapabilityResolutionAttempt<T> {
  return {
    status: 'ok',
    value,
    source: source as CapabilityResolutionAttempt<T>['source'],
    ...(endpoint ? { endpoint } : {}),
    checkedAt: new Date().toISOString(),
  };
}

function missing<T = unknown>(source: string, detail?: string, endpoint?: string): CapabilityResolutionAttempt<T> {
  return {
    status: 'missing',
    source: source as CapabilityResolutionAttempt<T>['source'],
    ...(endpoint ? { endpoint } : {}),
    ...(detail ? { detail } : {}),
    checkedAt: new Date().toISOString(),
  };
}

function error<T = unknown>(source: string, err: unknown, endpoint?: string): CapabilityResolutionAttempt<T> {
  return {
    status: 'error',
    source: source as CapabilityResolutionAttempt<T>['source'],
    ...(endpoint ? { endpoint } : {}),
    detail: err instanceof Error ? err.message : String(err),
    checkedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Per-provider handlers                                                       */
/* -------------------------------------------------------------------------- */

export interface McpResolverDeps {
  config: AgentWalletConfig;
  alternativeMe?: AlternativeMeClient;
  /** Optional fetch override for the BirdEye / CoinGecko / Helius fallbacks. */
  fetchImpl?: typeof fetch;
  /**
   * Solana RPC connection — used by the `network_metric`, `wallet_balance`,
   * `token_balance`, `token_supply`, `mint_decimals`, `wallet_age_onchain`,
   * `recipient_known`, `token_held_duration`, `tx_fee`, and `network_congestion`
   * resolvers. Wire from the bridge server's existing `Connection` (config.rpcUrl
   * honors Helius / QuickNode / public). When undefined, those atoms fall through
   * to the web tier (or stay unresolved if the chain has no web tier).
   */
  connection?: Connection;
  /**
   * Per-request context populated by the planner before invoking the resolver.
   * Lets resolvers reach the user's wallet address, the draft's parameters
   * (for relative_amount math), and the pre-computed simulation digest (for
   * tx_fee, rent_exempt_required, and the tx-inspect atoms).
   */
  requestContext?: {
    walletAddress?: string;
    draftParameters?: Record<string, string>;
    simulationDigest?: SimulationDigest;
    transactionBase64?: string;
  };
}

interface JupiterPriceValue { numeric: number }
interface CoinGeckoPriceValue { numeric: number; coingeckoId: string }
interface MarketRegimeValue { numeric: number; text?: string }

export function createMcpCapabilityResolver(deps: McpResolverDeps) {
  const config = deps.config;
  const altMe = deps.alternativeMe ?? getAlternativeMeClient();
  const connection = deps.connection;
  const requestContext = deps.requestContext;
  // Per-request memo so two atoms that share a (provider, endpoint, key) re-use one RPC.
  // Caches wallet balance, the parsed token-account list, and the prioritization-fee call.
  // Distinct from the (provider,endpoint,subject) memo a few lines down — this one is
  // keyed by the actual RPC call shape (e.g. `balance:<wallet>`, `prioritization-fees`).
  const rpcMemo = new Map<string, Promise<unknown>>();
  const memoize = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const cached = rpcMemo.get(key);
    if (cached) return cached as Promise<T>;
    const p = fn();
    rpcMemo.set(key, p as Promise<unknown>);
    return p;
  };

  // Per-request memoization: if two atoms in the same review hit the same
  // (provider, endpoint, subject) tuple, share one in-flight call. Cache lives for the
  // lifetime of this resolver instance, which is one review request. Cleared by GC after.
  const memo = new Map<string, Promise<CapabilityResolutionAttempt<unknown>>>();
  const memoKey = (atom: AgentAtom, tier: CapabilityTier): string | undefined => {
    // Only memoize when the atom has a stable subject — otherwise the cache key collides
    // across atoms with the same provider but different fact requests.
    const subject = 'subject' in atom && atom.subject ? String(atom.subject) : undefined;
    if (!subject) return undefined;
    const field = 'field' in atom ? String((atom as { field?: unknown }).field ?? '') : '';
    return `${tier.provider}|${tier.endpoint ?? ''}|${subject}|${field}`;
  };

  return async function resolver(atom: AgentAtom, tier: CapabilityTier): Promise<CapabilityResolutionAttempt<unknown>> {
    const key = memoKey(atom, tier);
    if (key) {
      const cached = memo.get(key);
      if (cached) return cached;
      const promise = resolveOnce(atom, tier);
      memo.set(key, promise);
      return promise;
    }
    return resolveOnce(atom, tier);
  };

  async function resolveOnce(atom: AgentAtom, tier: CapabilityTier): Promise<CapabilityResolutionAttempt<unknown>> {
    const provider = tier.provider;
    // -------- price atoms -----------------------------------------------------
    if (atom.type === 'price') {
      if (provider === 'jupiter') return jupiterPrice(atom, config);
      if (provider === 'coingecko') return coingeckoPriceById(atom);
      if (provider === 'birdeye') return missing('birdeye', 'BirdEye price resolver is not enabled in the default resolver; falling through.', 'price_multi');
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
    }
    // -------- market_regime atoms --------------------------------------------
    if (atom.type === 'market_regime') {
      if (provider === 'alternative_me' && atom.subject === 'fear_and_greed') {
        return altFearGreed(atom, altMe);
      }
      if (provider === 'coingecko') return coingeckoGlobal(atom);
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
    }
    // -------- token_audit atoms ----------------------------------------------
    if (atom.type === 'token_audit') {
      if (provider === 'jupiter') return jupiterTokenAudit(atom, config);
      if (provider === 'birdeye') return birdeyeTokenAudit(atom);
    }
    // -------- token_age atoms ------------------------------------------------
    if (atom.type === 'token_age') {
      if (provider === 'helius') return heliusMintCreation(atom);
      if (provider === 'birdeye') return birdeyeTokenAge(atom);
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
    }
    // -------- token_metric atoms (liquidity/mcap/fdv/volume/holders/...) ------
    if (atom.type === 'token_metric') {
      if (provider === 'jupiter') return jupiterTokenMetric(atom, config, requestContext);
      // BirdEye token_overview fallback is not wired in the default resolver; fall through.
      if (provider === 'birdeye') return missing('birdeye', 'BirdEye token_overview resolver not enabled in the default resolver; falling through.', 'token_overview');
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
    }
    // -------- external_price atoms (web-only) --------------------------------
    if (atom.type === 'external_price') {
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
    }
    // -------- tx_gate atoms (post-processed by txGates analyzer, not resolved here)
    if (atom.type === 'tx_gate') {
      return missing('rpc', 'tx_gate atoms are post-processed by txGates analyzer after simulation, not resolved here.');
    }
    // -------- protocol_health atoms ------------------------------------------
    if (atom.type === 'protocol_health') {
      if (provider === 'protocol_connector') return missing('protocol_connector', 'Per-protocol health resolves through explicit connector read routes; default resolver falls through.', 'read_facts');
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
    }
    // -------- external_state atoms (web-only today; news/status APIs later) ---
    if (atom.type === 'external_state') {
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
    }
    // -------- external_event atoms (web-only) --------------------------------
    if (atom.type === 'external_event') {
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
    }
    // -------- external_identity atoms (chainalysis → web) --------------------
    if (atom.type === 'external_identity') {
      // Future extension (external_identity): To enable structured sanctions/KYC screening, wire one of:
      //   1. **Chainalysis Sanctions Oracle API** — sign up at chainalysis.com, get an API
      //      key, add CHAINALYSIS_API_KEY env, and implement a screening call here. Free
      //      tier covers OFAC sanctions screening for individual addresses.
      //   2. **On-chain OFAC list** — Chainalysis publishes the sanctioned-address list as
      //      an on-chain account. You can query it via the existing `connection` (no key)
      //      with `connection.getProgramAccounts(SANCTIONS_PROGRAM_ID, …)`. Slower update
      //      cadence but free and self-contained.
      // Today this branch falls through to web (the LLM searches sanctions databases),
      // which works for SEC-action lookups and major sanctioned entities but isn't a
      // structured deterministic source.
      if (provider === 'chainalysis') return missing('chainalysis', 'Chainalysis screening not enabled. Add CHAINALYSIS_API_KEY env (Sanctions Oracle) or wire on-chain OFAC list lookup. Falling through to web.', 'screening');
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
    }
    // -------- tradfi_price atoms (web-only; AlphaVantage tier later) ---------
    if (atom.type === 'tradfi_price') {
      // Future extension (tradfi_price): To enable structured TradFi quotes (SPY, GLD, FX), wire one of:
      //   1. **AlphaVantage** — free API key at alphavantage.co (~5 calls/min, 500/day).
      //      Add ALPHAVANTAGE_API_KEY env and implement /query?function=GLOBAL_QUOTE here.
      //   2. **Twelve Data** — also has a free tier with similar shape.
      //   3. **Yahoo Finance unofficial** — no key, but rate-limited and brittle (endpoint
      //      changes shape periodically). Only recommended for prototyping.
      // Today this branch falls through to web (the LLM searches the live quote), which
      // works reliably for major tickers (SPY, gold, FX) but adds latency + LLM cost.
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
    }
    // -------- time_fact atoms (LOCAL computation — no network call) ----------
    if (atom.type === 'time_fact') {
      if (provider === 'local') return resolveTimeFact(atom);
    }
    // -------- network_metric atoms (real Solana RPC via shared Connection) ---
    if (atom.type === 'network_metric') {
      if (provider === 'rpc') {
        if (!connection) {
          return missing('rpc', 'No Solana Connection wired into createMcpCapabilityResolver. Pass `connection` in deps (bridgeServer.ts builds one from config.rpcUrl — Helius / QuickNode / public RPC all work).', tier.endpoint);
        }
        return resolveNetworkMetric(atom, tier, connection);
      }
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
    }
    // -------- Tier 1: wallet_balance / token_balance / relative_amount ------
    if (atom.type === 'wallet_balance' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      if (!requestContext?.walletAddress) return missing('rpc', 'No walletAddress in request context.', tier.endpoint);
      return resolveWalletBalance(atom, requestContext.walletAddress, connection, memoize);
    }
    if (atom.type === 'token_balance' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      if (!requestContext?.walletAddress) return missing('rpc', 'No walletAddress in request context.', tier.endpoint);
      return resolveTokenBalance(atom, requestContext.walletAddress, connection, memoize);
    }
    if (atom.type === 'relative_amount' && provider === 'composite') {
      if (!connection || !requestContext?.walletAddress) return missing('composite', 'relative_amount needs walletAddress + Connection.', tier.endpoint);
      return resolveRelativeAmount(atom, requestContext.walletAddress, requestContext.draftParameters ?? {}, connection, memoize);
    }
    if (atom.type === 'tx_fee' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      return resolveTxFee(atom, requestContext?.simulationDigest, connection, memoize);
    }
    if (atom.type === 'network_congestion' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      return resolveNetworkCongestion(atom, connection, memoize);
    }
    // -------- Tier 2: token_supply / mint_decimals / wallet_age / recipient_known / token_held_duration
    if (atom.type === 'token_supply' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      return resolveTokenSupply(atom, connection);
    }
    if (atom.type === 'mint_decimals' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      return resolveMintDecimals(atom, connection);
    }
    if (atom.type === 'wallet_age_onchain' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      if (!requestContext?.walletAddress) return missing('rpc', 'No walletAddress in request context.', tier.endpoint);
      return resolveWalletAge(requestContext.walletAddress, connection);
    }
    if (atom.type === 'recipient_known' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      if (!requestContext?.walletAddress) return missing('rpc', 'No walletAddress in request context.', tier.endpoint);
      const recipient = atom.subject ?? (requestContext.draftParameters ?? {}).recipient;
      if (!recipient) return missing('rpc', 'No recipient address in atom subject or draft.recipient.', tier.endpoint);
      return resolveRecipientKnown(recipient, requestContext.walletAddress, connection);
    }
    if (atom.type === 'token_held_duration' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      if (!requestContext?.walletAddress) return missing('rpc', 'No walletAddress in request context.', tier.endpoint);
      return resolveTokenHeldDuration(atom, requestContext.walletAddress, connection);
    }
    // -------- Tier 3: tx-inspect atoms (local-only, parse transaction message)
    if (atom.type === 'required_signatures' && provider === 'local_tx') {
      return resolveRequiredSignatures(requestContext?.transactionBase64);
    }
    if (atom.type === 'instruction_count' && provider === 'local_tx') {
      return resolveInstructionCount(requestContext?.transactionBase64);
    }
    if (atom.type === 'account_writability_count' && provider === 'local_tx') {
      return resolveAccountWritability(requestContext?.transactionBase64);
    }
    if (atom.type === 'rent_exempt_required' && provider === 'local_tx') {
      return resolveRentExempt(atom, requestContext?.simulationDigest);
    }
    // -------- Tier S: drain-attack defenses (local_tx, parse instructions) ----
    if (atom.type === 'sets_authority' && provider === 'local_tx') {
      return resolveSetsAuthority(atom, requestContext?.transactionBase64);
    }
    if (atom.type === 'delegates_token' && provider === 'local_tx') {
      return resolveDelegatesToken(atom, requestContext?.transactionBase64);
    }
    if (atom.type === 'closes_account' && provider === 'local_tx') {
      return resolveClosesAccount(atom, requestContext?.transactionBase64, requestContext?.simulationDigest);
    }
    // -------- Tier A: spending governance (composite + RPC) -------------------
    if (atom.type === 'daily_outflow_sum' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      if (!requestContext?.walletAddress) return missing('rpc', 'No walletAddress in request context.', tier.endpoint);
      return resolveDailyOutflow(atom, requestContext.walletAddress, connection);
    }
    if (atom.type === 'cooldown_since_last_tx' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      if (!requestContext?.walletAddress) return missing('rpc', 'No walletAddress in request context.', tier.endpoint);
      return resolveCooldownSinceLastTx(requestContext.walletAddress, connection);
    }
    if (atom.type === 'recent_blockhash_age_ms' && provider === 'rpc') {
      if (!connection) return missing('rpc', 'No Solana Connection wired.', tier.endpoint);
      return resolveRecentBlockhashAge(requestContext?.transactionBase64, connection);
    }
    // -------- Tier C: temporal policy (pure local) ----------------------------
    if (atom.type === 'time_of_day' && provider === 'local') {
      return resolveTimeOfDay(atom);
    }
    if (atom.type === 'day_of_week_window' && provider === 'local') {
      return resolveDayOfWeekWindow(atom);
    }
    return missing(String(provider), 'no resolver for this (atom.type, provider) pair');
  };
}

/* -------------------------------------------------------------------------- */
/* Provider implementations                                                    */
/* -------------------------------------------------------------------------- */

async function jupiterPrice(atom: PriceAtom, config: AgentWalletConfig): Promise<CapabilityResolutionAttempt<JupiterPriceValue>> {
  const subject = atom.subject.trim();
  // Subjects that look like Solana mint addresses go straight through; symbols
  // get mapped via KNOWN_SYMBOL_MINTS. Off-Solana symbols (BTC/ETH) have no mint
  // and immediately fall through to coingecko in the chain.
  const mint = mintForSymbol(subject) ?? (subject.length >= 32 ? subject : undefined);
  if (!mint) {
    return missing('jupiter', `No Solana mint known for symbol "${subject}".`, 'price');
  }
  try {
    const snap = await getJupiterPrice(config, { mint });
    if (snap.status !== 'found' || snap.usdPrice === undefined) {
      return missing('jupiter', snap.reason ?? 'no price returned', 'price');
    }
    return ok('jupiter', { numeric: snap.usdPrice }, 'price');
  } catch (err) {
    return error('jupiter', err, 'price');
  }
}

async function coingeckoPriceById(atom: PriceAtom): Promise<CapabilityResolutionAttempt<CoinGeckoPriceValue>> {
  const id = coingeckoIdForSymbol(atom.subject);
  if (!id) return missing('coingecko', `No CoinGecko id known for symbol "${atom.subject}".`, 'simple.price');
  try {
    const data = await requestCoinGecko('/simple/price', {
      query: { ids: id, vs_currencies: 'usd' },
    });
    const row = (data as Record<string, unknown>)[id];
    const usd = row && typeof row === 'object' ? Number((row as Record<string, unknown>).usd) : NaN;
    if (!Number.isFinite(usd)) return missing('coingecko', 'no usd price in payload', 'simple.price');
    return ok('coingecko', { numeric: usd, coingeckoId: id }, 'simple.price');
  } catch (err) {
    return error('coingecko', err, 'simple.price');
  }
}

async function altFearGreed(_atom: MarketRegimeAtom, client: AlternativeMeClient): Promise<CapabilityResolutionAttempt<MarketRegimeValue>> {
  try {
    const entry = await client.getFearGreedIndex();
    if (!entry) return missing('alternative_me', 'no current Fear & Greed entry available', 'fng');
    return ok('alternative_me', { numeric: entry.value, text: entry.classification }, 'fng');
  } catch (err) {
    return error('alternative_me', err, 'fng');
  }
}

async function coingeckoGlobal(atom: MarketRegimeAtom): Promise<CapabilityResolutionAttempt<MarketRegimeValue>> {
  try {
    const snap: CoinGeckoGlobalSnapshot = await requestCoinGeckoGlobal();
    switch (atom.subject) {
      case 'btc_dominance':
        if (typeof snap.btcDominancePct === 'number') return ok('coingecko', { numeric: snap.btcDominancePct }, 'global');
        break;
      case 'eth_dominance':
        if (typeof snap.ethDominancePct === 'number') return ok('coingecko', { numeric: snap.ethDominancePct }, 'global');
        break;
      case 'total_market_cap':
        if (typeof snap.totalMarketCapUsd === 'number') return ok('coingecko', { numeric: snap.totalMarketCapUsd }, 'global');
        break;
      case 'fear_and_greed':
        return missing('coingecko', 'CoinGecko global does not include Fear & Greed; use alternative_me.', 'global');
    }
    return missing('coingecko', `metric ${atom.subject} not present in CoinGecko global snapshot`, 'global');
  } catch (err) {
    return error('coingecko', err, 'global');
  }
}

// Resolve a token_metric gate against the Jupiter token-evidence bundle (which already
// carries liquidity / mcap / fdv / holders / topHolders% / organicScore / priceChange24h /
// 24h volume). The token is the atom's named subject, else the swap's output token from
// the draft parameters. One fetch per (mint) is memoized upstream by the resolver.
function tokenMetricValue(field: TokenMetricField, ev: JupiterTokenRiskEvidence): number | undefined {
  switch (field) {
    case 'liquidity': return ev.liquidity;
    case 'market_cap': return ev.mcap;
    case 'fdv': return ev.fdv;
    case 'volume_24h': {
      const s = ev.stats?.stats24h;
      if (!s) return undefined;
      const buy = typeof s.buyVolume === 'number' ? s.buyVolume : 0;
      const sell = typeof s.sellVolume === 'number' ? s.sellVolume : 0;
      const total = buy + sell;
      return total > 0 ? total : undefined;
    }
    case 'holder_count': return ev.holderCount;
    case 'top_holder_pct': return ev.topHoldersPercentage;
    case 'price_change_24h': return ev.priceChange24h;
    case 'organic_score': return ev.organicScore;
  }
}

async function jupiterTokenMetric(
  atom: TokenMetricAtom,
  config: AgentWalletConfig,
  requestContext: { draftParameters?: Record<string, string> } | undefined,
): Promise<CapabilityResolutionAttempt<{ numeric: number; text?: string }>> {
  const params = requestContext?.draftParameters ?? {};
  const candidate = atom.subject
    ?? params['outputMint'] ?? params['outputToken'] ?? params['mint'] ?? params['token'];
  const mint = mintFromSubject(candidate);
  if (!mint) {
    return missing('jupiter', 'token_metric has no concrete token (no named subject and no swap output token in context).', 'token_evidence');
  }
  try {
    const evidence = await getJupiterTokenRiskEvidence(config, { mint, includePrice: true });
    const value = tokenMetricValue(atom.field, evidence);
    if (value === undefined || !Number.isFinite(value)) {
      return missing('jupiter', `Jupiter token evidence has no ${atom.field} for ${mint.slice(0, 8)}…`, 'token_evidence');
    }
    const text = atom.field === 'organic_score' ? evidence.organicScoreLabel : undefined;
    return ok('jupiter', { numeric: value, ...(text ? { text } : {}) }, 'token_evidence');
  } catch (err) {
    return error('jupiter', err, 'token_evidence');
  }
}

async function jupiterTokenAudit(_atom: TokenAuditAtom, _config: AgentWalletConfig): Promise<CapabilityResolutionAttempt<boolean>> {
  // The token-evidence audit (mintAuthorityDisabled, freezeAuthorityDisabled) is produced by
  // packages/mcp-server/src/adapters/jupiter/tokenEvidence.ts as part of the swap evidence
  // bundle — not via a dedicated per-atom call. The orchestrator wires this by looking up
  // the audit from already-fetched evidence facts when present. Until that handoff lands,
  // return missing so the chain falls through to BirdEye.
  return missing('jupiter', 'jupiter token_evidence is bundled with swap evidence; falling through to birdeye.', 'token_evidence');
}

/**
 * BirdEye token_security → resolves token_audit atoms by reading the mint/freeze
 * authority fields. The atom asks whether a specific field is disabled (`expected: true`);
 * BirdEye reports the authority as `null` when disabled, an address string when enabled.
 */
async function birdeyeTokenAudit(atom: TokenAuditAtom): Promise<CapabilityResolutionAttempt<boolean>> {
  const mint = mintFromSubject(atom.subject);
  if (!mint) return missing('birdeye', 'token_audit atom has no concrete mint address (subject is a symbol or wildcard).', 'token_security');
  try {
    const payload = await requestBirdeyeTokenSecurity(mint);
    const data = asRecord(asRecord(payload)?.data) ?? asRecord(payload);
    if (!data) return missing('birdeye', 'no data in BirdEye token_security payload', 'token_security');
    switch (atom.field) {
      case 'mint_authority_disabled':
        return ok('birdeye', data.mintAuthority === null, 'token_security');
      case 'freeze_authority_disabled':
        return ok('birdeye', data.freezeAuthority === null, 'token_security');
      case 'is_verified':
        // BirdEye reports `isTrueToken` as the closest signal for "verified".
        if (typeof data.isTrueToken === 'boolean') return ok('birdeye', data.isTrueToken, 'token_security');
        return missing('birdeye', 'isTrueToken not in payload', 'token_security');
    }
  } catch (err) {
    return error('birdeye', err, 'token_security');
  }
}

/**
 * Helius mint_creation → resolves token_age atoms by reading the earliest tx timestamp
 * for the mint and computing seconds since.
 */
async function heliusMintCreation(atom: TokenAgeAtom): Promise<CapabilityResolutionAttempt<number>> {
  const mint = mintFromSubject(atom.subject);
  if (!mint) return missing('helius', 'token_age atom has no concrete mint address.', 'mint_creation');
  try {
    const result = await getMintCreationTxForMint(mint);
    if (!result.ok || !result.tx) return missing('helius', result.reason ?? 'no mint-creation tx found', 'mint_creation');
    const tx = result.tx as Record<string, unknown>;
    const timestampSec = typeof tx.timestamp === 'number'
      ? tx.timestamp
      : typeof tx.blockTime === 'number'
        ? tx.blockTime
        : undefined;
    if (timestampSec === undefined || !Number.isFinite(timestampSec)) {
      return missing('helius', 'mint creation tx has no usable timestamp', 'mint_creation');
    }
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - timestampSec);
    return ok('helius', ageSeconds, 'mint_creation');
  } catch (err) {
    return error('helius', err, 'mint_creation');
  }
}

/**
 * BirdEye fallback for token_age — uses `data.creationTime` from token_security.
 */
async function birdeyeTokenAge(atom: TokenAgeAtom): Promise<CapabilityResolutionAttempt<number>> {
  const mint = mintFromSubject(atom.subject);
  if (!mint) return missing('birdeye', 'token_age atom has no concrete mint address.', 'token_security');
  try {
    const payload = await requestBirdeyeTokenSecurity(mint);
    const data = asRecord(asRecord(payload)?.data) ?? asRecord(payload);
    if (!data) return missing('birdeye', 'no data in BirdEye token_security payload', 'token_security');
    const creationTime = typeof data.creationTime === 'number'
      ? data.creationTime
      : typeof data.creationTime === 'string' && Number.isFinite(Number(data.creationTime))
        ? Number(data.creationTime)
        : undefined;
    if (creationTime === undefined) return missing('birdeye', 'no creationTime in token_security payload', 'token_security');
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - creationTime);
    return ok('birdeye', ageSeconds, 'token_security');
  } catch (err) {
    return error('birdeye', err, 'token_security');
  }
}

/** Resolve a subject (symbol or mint string) to a canonical Solana mint address. */
function mintFromSubject(subject: string | undefined): string | undefined {
  if (!subject) return undefined;
  const trimmed = subject.trim();
  if (!trimmed) return undefined;
  if (trimmed.length >= 32) return trimmed;
  return mintForSymbol(trimmed);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/* -------------------------------------------------------------------------- */
/* Local time-fact resolver                                                   */
/* -------------------------------------------------------------------------- */

/**
 * US federal-holiday lookup. Fixed-date holidays (Independence Day, Veterans Day, etc.)
 * are checked by month/day; moving holidays (MLK Day, Thanksgiving, Memorial Day) are
 * computed from weekday-of-month rules. Falls back to false for any date outside the set.
 */
const US_FIXED_HOLIDAYS: ReadonlyArray<{ month: number; day: number; name: string }> = [
  { month: 1, day: 1, name: "New Year's Day" },
  { month: 6, day: 19, name: 'Juneteenth' },
  { month: 7, day: 4, name: 'Independence Day' },
  { month: 11, day: 11, name: 'Veterans Day' },
  { month: 12, day: 25, name: 'Christmas Day' },
];

function isUsFederalHoliday(date: Date): { holiday: boolean; name?: string } {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const weekday = date.getUTCDay(); // 0=Sun … 6=Sat
  for (const h of US_FIXED_HOLIDAYS) {
    if (h.month === month && h.day === day) return { holiday: true, name: h.name };
  }
  const weekOfMonth = Math.ceil(day / 7);
  if (month === 1 && weekday === 1 && weekOfMonth === 3) return { holiday: true, name: 'Martin Luther King Jr. Day' };
  if (month === 2 && weekday === 1 && weekOfMonth === 3) return { holiday: true, name: "Presidents' Day" };
  // Memorial Day = LAST Monday of May
  if (month === 5 && weekday === 1) {
    const lastDayOfMay = new Date(Date.UTC(date.getUTCFullYear(), 5, 0)).getUTCDate();
    if (day > lastDayOfMay - 7) return { holiday: true, name: 'Memorial Day' };
  }
  if (month === 9 && weekday === 1 && weekOfMonth === 1) return { holiday: true, name: 'Labor Day' };
  if (month === 10 && weekday === 1 && weekOfMonth === 2) return { holiday: true, name: 'Columbus Day' };
  if (month === 11 && weekday === 4 && weekOfMonth === 4) return { holiday: true, name: 'Thanksgiving Day' };
  return { holiday: false };
}

function dateInTimezone(timezone: string | undefined, now: Date = new Date()): Date {
  if (!timezone) return now;
  // Compute the wall-clock date in the requested timezone by formatting and reparsing.
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
    const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}Z`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? now : parsed;
  } catch {
    return now;
  }
}

/**
 * Resolve a time_fact atom locally — pure date math, no network. Always returns ok
 * because we always know the current time. Honors `atom.timezone` when supplied.
 */
function resolveTimeFact(atom: TimeFactAtom): CapabilityResolutionAttempt<{ boolean: boolean; text?: string }> {
  const now = dateInTimezone(atom.timezone);
  const weekday = now.getUTCDay();
  switch (atom.kind) {
    case 'is_business_day': {
      const isWeekend = weekday === 0 || weekday === 6;
      const { holiday, name } = isUsFederalHoliday(now);
      const value = !isWeekend && !holiday;
      const detail = isWeekend ? 'weekend' : holiday ? (name ?? 'holiday') : 'business day';
      return ok('local', { boolean: value, text: detail }, 'time');
    }
    case 'is_us_holiday': {
      const { holiday, name } = isUsFederalHoliday(now);
      return ok('local', { boolean: holiday, text: name }, 'time');
    }
    case 'is_market_open': {
      // NYSE: 9:30am – 4:00pm Eastern, Mon–Fri, non-holiday.
      const eastern = dateInTimezone('America/New_York');
      const isWeekend = eastern.getUTCDay() === 0 || eastern.getUTCDay() === 6;
      const { holiday } = isUsFederalHoliday(eastern);
      const hour = eastern.getUTCHours();
      const minute = eastern.getUTCMinutes();
      const minutesIntoDay = hour * 60 + minute;
      const open = !isWeekend && !holiday && minutesIntoDay >= 9 * 60 + 30 && minutesIntoDay < 16 * 60;
      return ok('local', { boolean: open, text: `NYSE ${open ? 'open' : 'closed'} (${eastern.toISOString().slice(11, 16)} ET)` }, 'time');
    }
    case 'day_of_week': {
      const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      // For day_of_week, the user provided a specific day in the NOTE; we can't
      // verify "today is Monday" without knowing which day was asked. Return text
      // so the evaluator can show "today is Tuesday" and the LLM applies the rule.
      return ok('local', { boolean: true, text: `today is ${names[weekday]}` }, 'time');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Solana RPC network_metric resolver — uses the shared Connection            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a network_metric atom against live Solana RPC. The Connection is the same one
 * the bridge server uses (config.rpcUrl — Helius if HELIUS_API_KEY is set and rpcUrl
 * points at a Helius endpoint, QuickNode, Triton, or the public RPC).
 *
 * Per-metric calls:
 *   tps                  → getRecentPerformanceSamples(1) → numTransactions / samplePeriodSecs
 *   slot_height          → getSlot('confirmed')
 *   validator_jailed     → getVoteAccounts() — checks the delinquent array
 *   epoch_progress_pct   → getEpochInfo('confirmed') → (slotIndex / slotsInEpoch) * 100
 *
 * All errors surface as `error` attempts so the chain can fall through to the web tier
 * if the RPC is rate-limited or down.
 */
async function resolveNetworkMetric(
  atom: NetworkMetricAtom,
  tier: CapabilityTier,
  connection: Connection,
): Promise<CapabilityResolutionAttempt<{ numeric?: number; boolean?: boolean; text?: string }>> {
  const endpoint = tier.endpoint;
  try {
    switch (atom.metric) {
      case 'tps': {
        const samples = await connection.getRecentPerformanceSamples(1);
        const sample = samples[0];
        if (!sample || sample.samplePeriodSecs <= 0) {
          return missing('rpc', 'No recent performance samples returned by RPC.', endpoint);
        }
        const tps = sample.numTransactions / sample.samplePeriodSecs;
        return ok('rpc', { numeric: tps, text: `${sample.numTransactions} txs / ${sample.samplePeriodSecs}s sample` }, endpoint);
      }
      case 'slot_height': {
        const slot = await connection.getSlot('confirmed');
        return ok('rpc', { numeric: slot }, endpoint);
      }
      case 'validator_jailed': {
        const accounts = await connection.getVoteAccounts();
        const subject = atom.subject?.trim();
        // If the user named a specific validator (vote pubkey or node pubkey), check it.
        // Otherwise return a count of currently-delinquent validators as a network-wide signal.
        if (subject) {
          const isDelinquent = accounts.delinquent.some(
            (v) => v.votePubkey === subject || v.nodePubkey === subject,
          );
          return ok('rpc', { boolean: isDelinquent, text: isDelinquent ? 'delinquent' : 'active' }, endpoint);
        }
        // No subject — return the network-wide delinquency count for advisory display.
        return ok('rpc', {
          boolean: accounts.delinquent.length > 0,
          numeric: accounts.delinquent.length,
          text: `${accounts.delinquent.length} delinquent / ${accounts.current.length} current`,
        }, endpoint);
      }
      case 'epoch_progress_pct': {
        const epoch = await connection.getEpochInfo('confirmed');
        const pct = epoch.slotsInEpoch > 0 ? (epoch.slotIndex / epoch.slotsInEpoch) * 100 : 0;
        return ok('rpc', { numeric: pct, text: `epoch ${epoch.epoch} (${epoch.slotIndex}/${epoch.slotsInEpoch} slots)` }, endpoint);
      }
    }
  } catch (err) {
    return error('rpc', err, endpoint);
  }
}

/* -------------------------------------------------------------------------- */
/* Tier 1: wallet_balance / token_balance / relative_amount resolvers          */
/* -------------------------------------------------------------------------- */

type Memoizer = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

const LAMPORTS_PER_SOL = 1_000_000_000;

async function resolveWalletBalance(
  atom: WalletBalanceAtom,
  walletAddress: string,
  connection: Connection,
  memoize: Memoizer,
): Promise<CapabilityResolutionAttempt<{ numeric: number }>> {
  try {
    const pubkey = new PublicKey(walletAddress);
    const lamports = await memoize(`balance:${walletAddress}`, () => connection.getBalance(pubkey, 'confirmed'));
    if (atom.unit === 'USD') {
      // USD comparison needs a SOL→USD price we don't have here; deferring keeps the
      // evaluator from comparing a lamport-scale number against a dollar threshold.
      return missing('rpc', 'wallet_balance in USD needs a SOL→USD price; resolve in SOL today or pair with a SOL price atom.', 'getBalance');
    }
    const value = atom.unit === 'lamports' ? lamports : lamports / LAMPORTS_PER_SOL;
    return ok('rpc', { numeric: value }, 'getBalance');
  } catch (err) {
    return error('rpc', err, 'getBalance');
  }
}

async function resolveTokenBalance(
  atom: TokenBalanceAtom,
  walletAddress: string,
  connection: Connection,
  memoize: Memoizer,
): Promise<CapabilityResolutionAttempt<{ numeric: number; text?: string }>> {
  try {
    const mint = mintFromSubject(atom.subject);
    if (!mint) return missing('rpc', `No mint known for token "${atom.subject}".`, 'getParsedTokenAccountsByOwner');
    const pubkey = new PublicKey(walletAddress);
    const mintKey = new PublicKey(mint);
    const accounts = await memoize(`token-accounts:${walletAddress}`,
      () => connection.getParsedTokenAccountsByOwner(pubkey, { mint: mintKey }, 'confirmed'),
    );
    let totalUiAmount = 0;
    let decimals = 0;
    for (const entry of accounts.value) {
      const info = (entry.account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number; decimals?: number } } } })?.parsed?.info?.tokenAmount;
      if (info && typeof info.uiAmount === 'number') totalUiAmount += info.uiAmount;
      if (info && typeof info.decimals === 'number') decimals = info.decimals;
    }
    // For unit==='USD' we'd need a price lookup; today we return token-native units when
    // unit==='tokens', or 0 when unit==='USD' without a price source (evaluator marks
    // unresolved if no fact provided). Best-effort: only the 'tokens' path is reliable here.
    if (atom.unit === 'USD') {
      // USD requires a price — defer with a structured-missing so the caller knows why.
      return missing('rpc', 'token_balance with unit=USD needs a follow-up price atom (use a separate price gate or token_balance with unit=tokens).', 'getParsedTokenAccountsByOwner');
    }
    return ok('rpc', { numeric: totalUiAmount, text: `${accounts.value.length} account(s), ${decimals}d` }, 'getParsedTokenAccountsByOwner');
  } catch (err) {
    return error('rpc', err, 'getParsedTokenAccountsByOwner');
  }
}

async function resolveRelativeAmount(
  atom: RelativeAmountAtom,
  walletAddress: string,
  draftParameters: Record<string, string>,
  connection: Connection,
  memoize: Memoizer,
): Promise<CapabilityResolutionAttempt<{ numeric: number; text?: string }>> {
  try {
    // Pull the draft amount (token-native) and convert to the same unit as the basis.
    const amountStr = (draftParameters.amount ?? draftParameters.inputAmount ?? '').trim();
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      return missing('composite', 'No positive amount in draft parameters.', 'relative_amount');
    }
    if (atom.basis === 'sol_balance') {
      const pubkey = new PublicKey(walletAddress);
      const lamports = await memoize(`balance:${walletAddress}`, () => connection.getBalance(pubkey, 'confirmed'));
      const sol = lamports / LAMPORTS_PER_SOL;
      if (sol <= 0) return missing('composite', 'Wallet has no SOL balance.', 'relative_amount');
      const fraction = amount / sol;
      return ok('composite', { numeric: fraction, text: `${amount} / ${sol.toFixed(4)} SOL` }, 'relative_amount');
    }
    // 'wallet' needs a USD-aggregated portfolio snapshot; 'token_balance' needs a
    // per-token spot balance fetch. Both are deferrable today — only 'sol_balance' is wired.
    const reason = atom.basis === 'wallet'
      ? 'basis=wallet needs a USD-aggregated wallet snapshot; only basis=sol_balance is wired today.'
      : `basis="${atom.basis}" needs a per-token balance fetch; only basis=sol_balance is wired today.`;
    return missing('composite', reason, 'relative_amount');
  } catch (err) {
    return error('composite', err, 'relative_amount');
  }
}

/* -------------------------------------------------------------------------- */
/* Tier 1: tx_fee / network_congestion resolvers                               */
/* -------------------------------------------------------------------------- */

async function getMedianPriorityFee(connection: Connection, memoize: Memoizer): Promise<number> {
  const fees = await memoize('prioritization-fees', () => connection.getRecentPrioritizationFees());
  if (!fees || fees.length === 0) return 0;
  const sorted = fees.map((f) => f.prioritizationFee).slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid] ?? 0;
}

async function resolveTxFee(
  atom: TxFeeAtom,
  simulationDigest: SimulationDigest | undefined,
  connection: Connection,
  memoize: Memoizer,
): Promise<CapabilityResolutionAttempt<{ numeric: number; text?: string }>> {
  try {
    // Base fee is 5000 lamports per signature; we approximate signers=1 unless a sim digest
    // tells us otherwise. The prioritization fee is microlamports × CU consumed / 1e6.
    const microPerCu = await getMedianPriorityFee(connection, memoize);
    const cuConsumed = (simulationDigest as unknown as { unitsConsumed?: number })?.unitsConsumed ?? 200_000;
    const baseLamports = 5000; // 1 signer × 5k lamports
    const priorityLamports = Math.floor((microPerCu * cuConsumed) / 1_000_000);
    const totalLamports = baseLamports + priorityLamports;
    let valueInUnit: number;
    if (atom.unit === 'lamports') valueInUnit = totalLamports;
    else if (atom.unit === 'SOL') valueInUnit = totalLamports / LAMPORTS_PER_SOL;
    else {
      // USD — requires SOL price. Defer cleanly so the LLM can ask the user or follow up.
      return missing('rpc', 'tx_fee in USD needs a SOL→USD price; resolve as SOL today.', 'getRecentPrioritizationFees');
    }
    return ok('rpc', {
      numeric: valueInUnit,
      text: `${baseLamports} base + ${priorityLamports} priority (≈${microPerCu.toFixed(0)}μL/CU × ${cuConsumed} CU)`,
    }, 'getRecentPrioritizationFees');
  } catch (err) {
    return error('rpc', err, 'getRecentPrioritizationFees');
  }
}

async function resolveNetworkCongestion(
  _atom: NetworkCongestionAtom,
  connection: Connection,
  memoize: Memoizer,
): Promise<CapabilityResolutionAttempt<{ numeric: number; text?: string }>> {
  try {
    const median = await getMedianPriorityFee(connection, memoize);
    return ok('rpc', { numeric: median, text: `${median.toFixed(0)} μL/CU median` }, 'getRecentPrioritizationFees');
  } catch (err) {
    return error('rpc', err, 'getRecentPrioritizationFees');
  }
}

/* -------------------------------------------------------------------------- */
/* Tier 2: token_supply / mint_decimals / wallet_age / recipient_known / held  */
/* -------------------------------------------------------------------------- */

async function resolveTokenSupply(
  atom: TokenSupplyAtom,
  connection: Connection,
): Promise<CapabilityResolutionAttempt<{ numeric: number; text?: string }>> {
  try {
    const mint = mintFromSubject(atom.subject);
    if (!mint) return missing('rpc', `No mint known for "${atom.subject}".`, 'getTokenSupply');
    const supply = await connection.getTokenSupply(new PublicKey(mint));
    const ui = supply.value.uiAmount ?? Number(supply.value.amount) / Math.pow(10, supply.value.decimals);
    return ok('rpc', { numeric: ui, text: `${supply.value.decimals} decimals` }, 'getTokenSupply');
  } catch (err) {
    return error('rpc', err, 'getTokenSupply');
  }
}

async function resolveMintDecimals(
  atom: MintDecimalsAtom,
  connection: Connection,
): Promise<CapabilityResolutionAttempt<{ numeric: number }>> {
  try {
    const mint = mintFromSubject(atom.subject);
    if (!mint) return missing('rpc', `No mint known for "${atom.subject}".`, 'getParsedAccountInfo');
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const decimals = ((info.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals);
    if (typeof decimals !== 'number') return missing('rpc', 'Mint account did not return parsed decimals.', 'getParsedAccountInfo');
    return ok('rpc', { numeric: decimals }, 'getParsedAccountInfo');
  } catch (err) {
    return error('rpc', err, 'getParsedAccountInfo');
  }
}

const WALLET_HISTORY_PAGE_SIZE = 1000;
const WALLET_HISTORY_MAX_PAGES = 3; // cap so we don't paginate forever on whale wallets

async function resolveWalletAge(
  walletAddress: string,
  connection: Connection,
): Promise<CapabilityResolutionAttempt<{ numeric: number; text?: string }>> {
  try {
    const pubkey = new PublicKey(walletAddress);
    let before: string | undefined;
    let earliestBlockTime: number | undefined;
    for (let page = 0; page < WALLET_HISTORY_MAX_PAGES; page += 1) {
      const sigs = await connection.getSignaturesForAddress(
        pubkey,
        { limit: WALLET_HISTORY_PAGE_SIZE, ...(before ? { before } : {}) },
        'confirmed',
      );
      if (sigs.length === 0) break;
      const last = sigs[sigs.length - 1]!;
      if (typeof last.blockTime === 'number') earliestBlockTime = last.blockTime;
      if (sigs.length < WALLET_HISTORY_PAGE_SIZE) break; // hit the end of history
      before = last.signature;
    }
    if (earliestBlockTime === undefined) {
      return missing('rpc', 'No signature history returned for wallet.', 'getSignaturesForAddress');
    }
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - earliestBlockTime);
    return ok('rpc', { numeric: ageSeconds, text: `first tx ~${formatRelative(ageSeconds)} ago` }, 'getSignaturesForAddress');
  } catch (err) {
    return error('rpc', err, 'getSignaturesForAddress');
  }
}

async function resolveRecipientKnown(
  recipient: string,
  walletAddress: string,
  connection: Connection,
): Promise<CapabilityResolutionAttempt<{ boolean: boolean; text?: string }>> {
  try {
    const pubkey = new PublicKey(walletAddress);
    // Pull a recent window of signatures; for each, fetch the parsed transaction and check
    // whether the wallet sent any value to the recipient. This is paginated/capped.
    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 200 }, 'confirmed');
    if (sigs.length === 0) {
      return ok('rpc', { boolean: false, text: 'no recent signatures' }, 'getSignaturesForAddress');
    }
    // Heuristic: scan up to 50 most recent transactions for an instruction touching the recipient.
    const recipientLower = recipient.toLowerCase();
    const sample = sigs.slice(0, 50).map((s) => s.signature);
    for (const sig of sample) {
      const tx = await connection.getParsedTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (!tx) continue;
      const accountKeys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey.toBase58()));
      if (accountKeys.some((k) => k.toLowerCase() === recipientLower)) {
        return ok('rpc', { boolean: true, text: `seen in ${sig.slice(0, 8)}…` }, 'getSignaturesForAddress');
      }
    }
    return ok('rpc', { boolean: false, text: `no prior tx with ${recipient.slice(0, 8)}… in last ${sample.length} signatures` }, 'getSignaturesForAddress');
  } catch (err) {
    return error('rpc', err, 'getSignaturesForAddress');
  }
}

async function resolveTokenHeldDuration(
  atom: TokenHeldDurationAtom,
  walletAddress: string,
  connection: Connection,
): Promise<CapabilityResolutionAttempt<{ numeric: number; text?: string }>> {
  try {
    const mint = mintFromSubject(atom.subject);
    if (!mint) return missing('rpc', `No mint known for "${atom.subject}".`, 'getSignaturesForAddress');
    // Find the user's token account for this mint and look up its earliest signature.
    const accounts = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(walletAddress),
      { mint: new PublicKey(mint) },
      'confirmed',
    );
    if (accounts.value.length === 0) return ok('rpc', { numeric: 0, text: 'no token account' }, 'getSignaturesForAddress');
    let earliestBlockTime: number | undefined;
    for (const account of accounts.value) {
      let before: string | undefined;
      for (let page = 0; page < WALLET_HISTORY_MAX_PAGES; page += 1) {
        const sigs = await connection.getSignaturesForAddress(
          account.pubkey,
          { limit: WALLET_HISTORY_PAGE_SIZE, ...(before ? { before } : {}) },
          'confirmed',
        );
        if (sigs.length === 0) break;
        const last = sigs[sigs.length - 1]!;
        if (typeof last.blockTime === 'number') {
          if (earliestBlockTime === undefined || last.blockTime < earliestBlockTime) earliestBlockTime = last.blockTime;
        }
        if (sigs.length < WALLET_HISTORY_PAGE_SIZE) break;
        before = last.signature;
      }
    }
    if (earliestBlockTime === undefined) {
      return missing('rpc', 'No token-account signatures found.', 'getSignaturesForAddress');
    }
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - earliestBlockTime);
    return ok('rpc', { numeric: seconds, text: `first held ~${formatRelative(seconds)} ago` }, 'getSignaturesForAddress');
  } catch (err) {
    return error('rpc', err, 'getSignaturesForAddress');
  }
}

/* -------------------------------------------------------------------------- */
/* Tier 3: tx-inspect resolvers (local, no RPC)                                */
/* -------------------------------------------------------------------------- */

function decodeTransactionBase64(transactionBase64: string): {
  requiredSignatures: number;
  instructionCount: number;
  writableCount: number;
} | undefined {
  if (!transactionBase64) return undefined;
  let bytes: Buffer;
  try { bytes = Buffer.from(transactionBase64, 'base64'); } catch { return undefined; }
  // Try versioned first, then legacy.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- web3.js types pulled at runtime
    const web3 = require('@solana/web3.js') as typeof import('@solana/web3.js');
    try {
      const versioned = web3.VersionedTransaction.deserialize(bytes);
      const header = versioned.message.header;
      const requiredSignatures = header.numRequiredSignatures;
      const instructionCount = versioned.message.compiledInstructions.length;
      // Writable = (numRequiredSignatures - numReadonlySignedAccounts) +
      //            (totalKeys - numRequiredSignatures - numReadonlyUnsignedAccounts)
      const totalKeys = versioned.message.staticAccountKeys.length;
      const writableCount = (header.numRequiredSignatures - header.numReadonlySignedAccounts)
        + (totalKeys - header.numRequiredSignatures - header.numReadonlyUnsignedAccounts);
      return { requiredSignatures, instructionCount, writableCount };
    } catch {
      const legacy = web3.Transaction.from(bytes);
      const requiredSignatures = legacy.signatures.length;
      const instructionCount = legacy.instructions.length;
      // Legacy: count accounts marked isWritable across all instructions.
      const writableSet = new Set<string>();
      for (const ix of legacy.instructions) {
        for (const meta of ix.keys) {
          if (meta.isWritable) writableSet.add(meta.pubkey.toBase58());
        }
      }
      return { requiredSignatures, instructionCount, writableCount: writableSet.size };
    }
  } catch {
    return undefined;
  }
}

function resolveRequiredSignatures(transactionBase64: string | undefined): CapabilityResolutionAttempt<{ numeric: number }> {
  if (!transactionBase64) return missing('local_tx', 'No transactionBase64 in request context.', 'parse_message');
  const parsed = decodeTransactionBase64(transactionBase64);
  if (!parsed) return missing('local_tx', 'Could not parse transaction.', 'parse_message');
  return ok('local_tx', { numeric: parsed.requiredSignatures }, 'parse_message');
}

function resolveInstructionCount(transactionBase64: string | undefined): CapabilityResolutionAttempt<{ numeric: number }> {
  if (!transactionBase64) return missing('local_tx', 'No transactionBase64 in request context.', 'parse_message');
  const parsed = decodeTransactionBase64(transactionBase64);
  if (!parsed) return missing('local_tx', 'Could not parse transaction.', 'parse_message');
  return ok('local_tx', { numeric: parsed.instructionCount }, 'parse_message');
}

function resolveAccountWritability(transactionBase64: string | undefined): CapabilityResolutionAttempt<{ numeric: number }> {
  if (!transactionBase64) return missing('local_tx', 'No transactionBase64 in request context.', 'parse_message');
  const parsed = decodeTransactionBase64(transactionBase64);
  if (!parsed) return missing('local_tx', 'Could not parse transaction.', 'parse_message');
  return ok('local_tx', { numeric: parsed.writableCount }, 'parse_message');
}

function resolveRentExempt(
  atom: RentExemptRequiredAtom,
  simulationDigest: SimulationDigest | undefined,
): CapabilityResolutionAttempt<{ numeric: number; text?: string }> {
  // Walk simulation logs for "CreateAccount" / "InitializeAccount" + rent-exempt computations.
  // For an MVP, count the number of CreateAccount invocations and report a per-account
  // rent estimate (2_039_280 lamports for a typical SPL token account).
  if (!simulationDigest) return missing('local_tx', 'No simulationDigest in request context.', 'sim_rent_delta');
  const createAccountLogs = simulationDigest.logs.filter((line: string) => /Instruction:\s*(CreateAccount|InitializeAccount)/i.test(line));
  const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;
  const rentLamports = createAccountLogs.length * TOKEN_ACCOUNT_RENT_LAMPORTS;
  let valueInUnit: number;
  if (atom.unit === 'lamports') valueInUnit = rentLamports;
  else if (atom.unit === 'SOL') valueInUnit = rentLamports / LAMPORTS_PER_SOL;
  else {
    return missing('local_tx', 'rent_exempt_required with unit=USD needs a SOL→USD price; use SOL today.', 'sim_rent_delta');
  }
  return ok('local_tx', {
    numeric: valueInUnit,
    text: `${createAccountLogs.length} CreateAccount × ${TOKEN_ACCOUNT_RENT_LAMPORTS} lamports each`,
  }, 'sim_rent_delta');
}

function formatRelative(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds < 30 * 86_400) return `${(seconds / 86_400).toFixed(1)}d`;
  return `${(seconds / (30 * 86_400)).toFixed(1)}mo`;
}

/* -------------------------------------------------------------------------- */
/* Tier S: drain-attack defense resolvers (local-tx parse_instructions)        */
/* -------------------------------------------------------------------------- */

const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
// SPL Token instruction discriminators (data[0]).
const SPL_IX_APPROVE = 4;
const SPL_IX_SET_AUTHORITY = 6;
const SPL_IX_CLOSE_ACCOUNT = 9;
const SPL_IX_APPROVE_CHECKED = 13;

interface ParsedInstruction {
  programId: string;
  accountKeys: string[]; // resolved keys for this instruction in account-meta order
  data: Uint8Array;
  /** True when one or more account-key indexes resolved outside the static key set —
   *  i.e. the instruction references accounts loaded via an address lookup table that
   *  the offline parser cannot resolve. Fail-closed: callers should treat such
   *  instructions as potentially suspicious (the delegate / target may be hidden). */
  hasUnresolvedAccounts: boolean;
}

/**
 * Decode a base64 tx (versioned or legacy) and return its program instructions.
 * Returns undefined when the input cannot be parsed.
 *
 * Note on ALT (Address Lookup Tables): a versioned tx can reference accounts whose
 * pubkeys live in a lookup table that is NOT included in the serialized message.
 * Resolving them requires an `getAddressLookupTable` RPC call, which we deliberately
 * avoid here (the parser is sync + offline). Each instruction that references such
 * accounts gets `hasUnresolvedAccounts: true` so security-sensitive resolvers can
 * fail-closed rather than silently pass.
 */
function parseInstructions(transactionBase64: string | undefined): ParsedInstruction[] | undefined {
  if (!transactionBase64) return undefined;
  let bytes: Buffer;
  try { bytes = Buffer.from(transactionBase64, 'base64'); } catch { return undefined; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- runtime require to stay in sync with the rest of this file
    const web3 = require('@solana/web3.js') as typeof import('@solana/web3.js');
    try {
      const versioned = web3.VersionedTransaction.deserialize(bytes);
      const staticKeys = versioned.message.staticAccountKeys.map((k) => k.toBase58());
      return versioned.message.compiledInstructions.map((ix) => {
        const indexes = Array.from(ix.accountKeyIndexes);
        const accountKeys: string[] = [];
        let hasUnresolvedAccounts = false;
        for (const idx of indexes) {
          const key = staticKeys[idx];
          if (key === undefined) {
            hasUnresolvedAccounts = true;
            accountKeys.push(''); // placeholder — callers should consult hasUnresolvedAccounts
          } else {
            accountKeys.push(key);
          }
        }
        return {
          programId: staticKeys[ix.programIdIndex] ?? '',
          accountKeys,
          data: ix.data instanceof Uint8Array ? ix.data : new Uint8Array(ix.data ?? []),
          hasUnresolvedAccounts,
        };
      });
    } catch {
      const legacy = web3.Transaction.from(bytes);
      return legacy.instructions.map((ix) => ({
        programId: ix.programId.toBase58(),
        accountKeys: ix.keys.map((meta) => meta.pubkey.toBase58()),
        data: ix.data instanceof Uint8Array ? ix.data : new Uint8Array(ix.data ?? []),
        hasUnresolvedAccounts: false, // legacy txs have no ALT
      }));
    }
  } catch {
    return undefined;
  }
}

function isSplTokenProgram(programId: string): boolean {
  return programId === SPL_TOKEN_PROGRAM_ID || programId === SPL_TOKEN_2022_PROGRAM_ID;
}

function resolveSetsAuthority(
  atom: SetsAuthorityAtom,
  transactionBase64: string | undefined,
): CapabilityResolutionAttempt<{ boolean: boolean; text?: string }> {
  if (!transactionBase64) return missing('local_tx', 'No transactionBase64 in request context.', 'parse_instructions');
  const ixs = parseInstructions(transactionBase64);
  if (!ixs) return missing('local_tx', 'Could not parse transaction.', 'parse_instructions');
  const hits = ixs.filter((ix) => isSplTokenProgram(ix.programId) && ix.data.length >= 1 && ix.data[0] === SPL_IX_SET_AUTHORITY);
  if (hits.length === 0) {
    return ok('local_tx', { boolean: false, text: 'no SetAuthority instructions' }, 'parse_instructions');
  }
  const targets = hits.map((ix) => (ix.accountKeys[0] || '?').slice(0, 8) + '…').join(', ');
  void atom; // expected used at evaluator level
  return ok('local_tx', { boolean: true, text: `${hits.length} SetAuthority on ${targets}` }, 'parse_instructions');
}

/**
 * Read a little-endian u64 from `data` starting at `offset`. Returns Number.MAX_SAFE_INTEGER
 * when the value exceeds Number's safe integer range — adequate because we only ever compare
 * against u64::MAX, not perform arithmetic on the result.
 */
function readU64LE(data: Uint8Array, offset: number): number {
  if (offset + 8 > data.length) return NaN;
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value |= BigInt(data[offset + i] ?? 0) << BigInt(i * 8);
  }
  // u64::MAX = 0xFFFFFFFFFFFFFFFF — outside Number range; clamp to Number.MAX_SAFE_INTEGER
  // and let callers compare via the `isUnlimited` helper.
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function isUnlimitedApproval(data: Uint8Array): boolean {
  // Approve / ApproveChecked encode the amount at bytes 1..9 (little-endian u64).
  if (data.length < 9) return false;
  for (let i = 1; i < 9; i += 1) {
    if (data[i] !== 0xff) return false;
  }
  return true;
}

function resolveDelegatesToken(
  atom: DelegatesTokenAtom,
  transactionBase64: string | undefined,
): CapabilityResolutionAttempt<{ boolean: boolean; text?: string }> {
  if (!transactionBase64) return missing('local_tx', 'No transactionBase64 in request context.', 'parse_instructions');
  const ixs = parseInstructions(transactionBase64);
  if (!ixs) return missing('local_tx', 'Could not parse transaction.', 'parse_instructions');
  const known = new Set((atom.knownDelegates ?? []).map((d) => d.trim()).filter(Boolean));
  const flagged: Array<{ delegate: string; unlimited: boolean; amount: number }> = [];
  let unresolvedHits = 0;
  for (const ix of ixs) {
    if (!isSplTokenProgram(ix.programId)) continue;
    if (ix.data.length < 1) continue;
    const disc = ix.data[0];
    const isApprove = disc === SPL_IX_APPROVE;
    const isApproveChecked = disc === SPL_IX_APPROVE_CHECKED;
    if (!isApprove && !isApproveChecked) continue;
    // Approve: keys = [source, delegate, owner].  ApproveChecked: keys = [source, mint, delegate, owner].
    const delegate = isApproveChecked ? ix.accountKeys[2] : ix.accountKeys[1];
    const amount = readU64LE(ix.data, 1);
    const unlimited = isUnlimitedApproval(ix.data);
    // Fail-closed: an Approve instruction with an unresolvable (ALT-bound) delegate is
    // treated as suspicious — we cannot prove it's in `knownDelegates`.
    if (ix.hasUnresolvedAccounts || !delegate) {
      if (atom.onlyUnlimited && !unlimited) continue;
      unresolvedHits += 1;
      flagged.push({ delegate: delegate || '<alt-hidden>', unlimited, amount });
      continue;
    }
    if (atom.onlyUnlimited && !unlimited) continue;
    if (!unlimited && known.has(delegate)) continue;
    flagged.push({ delegate, unlimited, amount });
  }
  if (flagged.length === 0) {
    return ok('local_tx', { boolean: false, text: atom.onlyUnlimited ? 'no unlimited approvals' : 'no flagged approvals' }, 'parse_instructions');
  }
  const labels = flagged
    .map((f) => `${f.unlimited ? 'unlimited' : Number.isFinite(f.amount) ? `${f.amount}` : '?'} → ${f.delegate.slice(0, 8)}…`)
    .join(', ');
  const altNote = unresolvedHits > 0 ? ` (${unresolvedHits} via ALT — delegate hidden)` : '';
  return ok('local_tx', { boolean: true, text: `${flagged.length} delegation${flagged.length > 1 ? 's' : ''}: ${labels}${altNote}` }, 'parse_instructions');
}

function resolveClosesAccount(
  atom: ClosesAccountAtom,
  transactionBase64: string | undefined,
  simulationDigest: SimulationDigest | undefined,
): CapabilityResolutionAttempt<{ boolean: boolean; text?: string }> {
  if (!transactionBase64) return missing('local_tx', 'No transactionBase64 in request context.', 'parse_instructions');
  const ixs = parseInstructions(transactionBase64);
  if (!ixs) return missing('local_tx', 'Could not parse transaction.', 'parse_instructions');
  // Default allowlist: wSOL (Jupiter wraps/unwraps SOL by closing the temp wSOL ATA).
  const allowedMints = new Set((atom.allowedMints && atom.allowedMints.length > 0)
    ? atom.allowedMints
    : [WSOL_MINT]);
  // Without simulation/account data we can't always determine the mint of the closed
  // account. Heuristic: walk the tx instructions for a preceding ATA-create / Token.Initialize
  // for the same account, and read its mint argument. If found and in the allowlist, ignore
  // this closure. Otherwise flag it.
  const initMintByAccount = new Map<string, string>();
  for (const ix of ixs) {
    if (!isSplTokenProgram(ix.programId)) continue;
    // InitializeAccount (1), InitializeAccount2 (16), InitializeAccount3 (18) all carry the
    // mint in the account-key list (keys[1] = mint for InitializeAccount, keys[1]/keys[2]).
    const disc = ix.data[0];
    if (disc === 1 || disc === 16 || disc === 18) {
      const account = ix.accountKeys[0];
      const mint = ix.accountKeys[1];
      if (account && mint) initMintByAccount.set(account, mint);
    }
  }
  void simulationDigest;
  const flagged: Array<{ account: string; mint?: string }> = [];
  let unresolvedHits = 0;
  for (const ix of ixs) {
    if (!isSplTokenProgram(ix.programId)) continue;
    if (ix.data.length < 1 || ix.data[0] !== SPL_IX_CLOSE_ACCOUNT) continue;
    // Fail-closed for ALT-hidden closures — we can't verify the mint or destination.
    if (ix.hasUnresolvedAccounts) {
      unresolvedHits += 1;
      flagged.push({ account: '<alt-hidden>' });
      continue;
    }
    const account = ix.accountKeys[0];
    const destination = ix.accountKeys[1];
    const owner = ix.accountKeys[2];
    if (!account) continue;
    // CloseAccount keys = [account, destination, owner]. When destination === owner, it's
    // the typical wSOL unwrap-to-self pattern (Jupiter closes the temp ATA, returning the
    // lamports + native rent to the same owner that signed). Safe regardless of mint.
    if (destination && owner && destination === owner) continue;
    const mint = initMintByAccount.get(account);
    if (mint && allowedMints.has(mint)) continue; // Jupiter wSOL-style unwrap — safe.
    flagged.push({ account, ...(mint ? { mint } : {}) });
  }
  if (flagged.length === 0) {
    return ok('local_tx', { boolean: false, text: 'no flagged account closures' }, 'parse_instructions');
  }
  const labels = flagged
    .map((f) => `${f.account.slice(0, 8)}…${f.mint ? ` (mint ${f.mint.slice(0, 8)}…)` : ''}`)
    .join(', ');
  const altNote = unresolvedHits > 0 ? ` (${unresolvedHits} via ALT — mint hidden)` : '';
  return ok('local_tx', { boolean: true, text: `${flagged.length} CloseAccount: ${labels}${altNote}` }, 'parse_instructions');
}

/* -------------------------------------------------------------------------- */
/* Tier A: spending governance resolvers (composite + RPC)                     */
/* -------------------------------------------------------------------------- */

async function resolveDailyOutflow(
  atom: DailyOutflowSumAtom,
  walletAddress: string,
  connection: Connection,
): Promise<CapabilityResolutionAttempt<{ numeric: number; text?: string }>> {
  try {
    if (atom.unit === 'USD') {
      return missing('rpc', 'daily_outflow_sum with unit=USD needs a SOL→USD price; use SOL/lamports today.', 'getParsedTransaction');
    }
    const pubkey = new PublicKey(walletAddress);
    const windowSecs = atom.windowSeconds ?? 86_400;
    const cutoff = Math.floor(Date.now() / 1000) - windowSecs;
    // Cap signatures we walk so a chatty wallet doesn't pin the resolver.
    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 200 }, 'confirmed');
    const inWindow = sigs.filter((s) => typeof s.blockTime === 'number' && s.blockTime >= cutoff);
    if (inWindow.length === 0) {
      return ok('rpc', { numeric: 0, text: `no signed txs in last ${(windowSecs / 3600).toFixed(0)}h` }, 'getParsedTransaction');
    }
    // Walk each tx, compute (postBalance - preBalance) for the wallet, accumulate negative deltas.
    // Fail-closed: if a chatty wallet exceeds DAILY_OUTFLOW_TX_CAP, return missing so the
    // evaluator marks the gate unresolved instead of silently passing on an under-counted sum.
    const DAILY_OUTFLOW_TX_CAP = 100;
    if (inWindow.length > DAILY_OUTFLOW_TX_CAP) {
      return missing(
        'rpc',
        `Wallet has ${inWindow.length} signed txs in last ${(windowSecs / 3600).toFixed(0)}h — exceeds ${DAILY_OUTFLOW_TX_CAP}-tx fetch cap. Outflow sum cannot be verified without unbounded RPC load.`,
        'getParsedTransaction',
      );
    }
    let outflowLamports = 0;
    let counted = 0;
    for (const sigInfo of inWindow) {
      const tx = await connection.getParsedTransaction(sigInfo.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }).catch(() => null);
      if (!tx || !tx.meta) continue;
      const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey.toBase58()));
      const idx = keys.findIndex((k) => k === walletAddress);
      if (idx < 0) continue;
      const pre = tx.meta.preBalances[idx];
      const post = tx.meta.postBalances[idx];
      if (typeof pre !== 'number' || typeof post !== 'number') continue;
      const delta = post - pre; // negative when SOL left the wallet
      if (delta < 0) outflowLamports += -delta;
      counted += 1;
    }
    const value = atom.unit === 'lamports' ? outflowLamports : outflowLamports / LAMPORTS_PER_SOL;
    return ok('rpc', {
      numeric: value,
      text: `summed across ${counted} tx in last ${(windowSecs / 3600).toFixed(0)}h`,
    }, 'getParsedTransaction');
  } catch (err) {
    return error('rpc', err, 'getParsedTransaction');
  }
}

async function resolveCooldownSinceLastTx(
  walletAddress: string,
  connection: Connection,
): Promise<CapabilityResolutionAttempt<{ numeric: number; text?: string }>> {
  try {
    const pubkey = new PublicKey(walletAddress);
    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 1 }, 'confirmed');
    const last = sigs[0];
    if (!last || typeof last.blockTime !== 'number') {
      return missing('rpc', 'No prior signatures for wallet (or last signature has no blockTime).', 'getSignaturesForAddress');
    }
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - last.blockTime);
    return ok('rpc', {
      numeric: seconds,
      text: `last tx ${last.signature.slice(0, 8)}… ${formatRelative(seconds)} ago`,
    }, 'getSignaturesForAddress');
  } catch (err) {
    return error('rpc', err, 'getSignaturesForAddress');
  }
}

function readBlockhashFromTransactionBase64(transactionBase64: string): string | undefined {
  let bytes: Buffer;
  try { bytes = Buffer.from(transactionBase64, 'base64'); } catch { return undefined; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const web3 = require('@solana/web3.js') as typeof import('@solana/web3.js');
    try {
      const versioned = web3.VersionedTransaction.deserialize(bytes);
      return versioned.message.recentBlockhash;
    } catch {
      const legacy = web3.Transaction.from(bytes);
      return legacy.recentBlockhash ?? undefined;
    }
  } catch {
    return undefined;
  }
}

function readBlockhashValidity(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.value === 'boolean') return record.value;
  const result = record.result;
  if (typeof result === 'boolean') return result;
  if (result && typeof result === 'object') {
    const resultValue = (result as Record<string, unknown>).value;
    if (typeof resultValue === 'boolean') return resultValue;
  }
  return undefined;
}

async function isRecentBlockhashValid(connection: Connection, blockhash: string): Promise<boolean> {
  const compatibleConnection = connection as BlockhashValidityConnection;
  if (typeof compatibleConnection.isBlockhashValid === 'function') {
    const result = await compatibleConnection.isBlockhashValid(blockhash, { commitment: 'confirmed' });
    const valid = readBlockhashValidity(result);
    if (typeof valid === 'boolean') return valid;
  }

  if (typeof compatibleConnection._rpcRequest === 'function') {
    const result = await compatibleConnection._rpcRequest('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]);
    const valid = readBlockhashValidity(result);
    if (typeof valid === 'boolean') return valid;
  }

  throw new Error('Connection does not support isBlockhashValid');
}

async function resolveRecentBlockhashAge(
  transactionBase64: string | undefined,
  connection: Connection,
): Promise<CapabilityResolutionAttempt<{ numeric: number; text?: string }>> {
  try {
    if (!transactionBase64) return missing('rpc', 'No transactionBase64 in request context.', 'isBlockhashValid');
    const blockhash = readBlockhashFromTransactionBase64(transactionBase64);
    if (!blockhash) return missing('rpc', 'Could not extract recentBlockhash from transaction.', 'isBlockhashValid');
    // Solana keeps ~150 recent blockhashes valid (~60s). `isBlockhashValid` gives a
    // binary signal; we report the midpoint of the valid window when ok, and a value
    // safely above the expiry threshold when not.
    const valid = await isRecentBlockhashValid(connection, blockhash);
    if (valid) {
      return ok('rpc', { numeric: 30_000, text: `blockhash ${blockhash.slice(0, 8)}… still valid (≤60s)` }, 'isBlockhashValid');
    }
    return ok('rpc', { numeric: 90_000, text: `blockhash ${blockhash.slice(0, 8)}… expired (>60s)` }, 'isBlockhashValid');
  } catch (err) {
    return error('rpc', err, 'isBlockhashValid');
  }
}

/* -------------------------------------------------------------------------- */
/* Tier C: temporal policy resolvers (pure local)                              */
/* -------------------------------------------------------------------------- */

function hoursIntoDay(date: Date): number {
  return date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
}

function resolveTimeOfDay(atom: TimeOfDayAtom): CapabilityResolutionAttempt<{ boolean: boolean; text?: string }> {
  const now = dateInTimezone(atom.timezone);
  const h = hoursIntoDay(now);
  // Handle midnight-wrap windows: when end < start, the window is [start, 24) ∪ [0, end).
  const inWindow = atom.end >= atom.start
    ? h >= atom.start && h < atom.end
    : h >= atom.start || h < atom.end;
  const tzLabel = atom.timezone ? ` ${atom.timezone}` : ' UTC';
  const display = `${Math.floor(h)}:${String(Math.floor((h - Math.floor(h)) * 60)).padStart(2, '0')}${tzLabel}`;
  return ok('local', {
    boolean: inWindow,
    text: `now ${display}; window [${atom.start.toFixed(2)}, ${atom.end.toFixed(2)})`,
  }, 'time');
}

function resolveDayOfWeekWindow(atom: DayOfWeekWindowAtom): CapabilityResolutionAttempt<{ boolean: boolean; text?: string }> {
  const now = dateInTimezone(atom.timezone);
  const weekday = now.getUTCDay();
  const allowed = new Set(atom.allowedDays);
  const inWindow = allowed.has(weekday);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return ok('local', {
    boolean: inWindow,
    text: `today is ${dayNames[weekday]}; allowed=[${atom.allowedDays.map((d) => dayNames[d]?.slice(0, 3)).join(',')}]`,
  }, 'time');
}
