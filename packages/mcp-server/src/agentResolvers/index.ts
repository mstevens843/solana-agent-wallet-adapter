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

import type {
  AgentAtom,
  CapabilityResolutionAttempt,
  CapabilityTier,
  ExternalPriceAtom,
  MarketRegimeAtom,
  PriceAtom,
  TokenAgeAtom,
  TokenAuditAtom,
} from '@solana-agent-wallet-adapter/workflow';

import type { AgentWalletConfig } from '../config.js';
import {
  AlternativeMeClient,
  getAlternativeMeClient,
} from '../adapters/alternative_me/index.js';
import { getJupiterPrice } from '../adapters/jupiter/prices.js';
import { requestBirdeyeTokenSecurity } from '../birdeye.js';
import {
  requestCoinGecko,
  requestCoinGeckoGlobal,
  type CoinGeckoGlobalSnapshot,
} from '../coingecko.js';
import { getMintCreationTxForMint } from '../helius.js';

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
}

interface JupiterPriceValue { numeric: number }
interface CoinGeckoPriceValue { numeric: number; coingeckoId: string }
interface MarketRegimeValue { numeric: number; text?: string }

export function createMcpCapabilityResolver(deps: McpResolverDeps) {
  const config = deps.config;
  const altMe = deps.alternativeMe ?? getAlternativeMeClient();

  return async function resolver(atom: AgentAtom, tier: CapabilityTier): Promise<CapabilityResolutionAttempt<unknown>> {
    const provider = tier.provider;
    // -------- price atoms -----------------------------------------------------
    if (atom.type === 'price') {
      if (provider === 'jupiter') return jupiterPrice(atom, config);
      if (provider === 'coingecko') return coingeckoPriceById(atom);
      if (provider === 'birdeye') return missing('birdeye', 'BirdEye price resolver not implemented; falling through.', 'price_multi');
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
      if (provider === 'protocol_connector') return missing('protocol_connector', 'Per-protocol health resolver wires via connector adapters; not implemented in the default shim.', 'read_facts');
      if (provider === 'web') return missing('web', 'deferred_to_research_pass');
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
