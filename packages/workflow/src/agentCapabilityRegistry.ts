/**
 * Capability registry — maps each atom type to its ordered provider chain.
 *
 * Atoms (from `agentAtoms.ts`) describe WHAT the reviewer needs to know.
 * The registry describes WHICH providers can answer each atom type, in what
 * priority order, with what TTL, and which post-processor (if any) is used
 * to turn the raw response into a structured fact.
 *
 * Web is always the last tier (failsafe escalation). For atom types that no
 * crypto API can answer (e.g. `external_price` for off-chain items like phone
 * plans), web is the only tier.
 */

import type {
  AgentAtom,
  AgentAtomType,
} from './agentAtoms.js';
import type { AgentFactProvider } from './agentFactRouter.js';

export type CapabilityProvider = AgentFactProvider | 'web';

export interface CapabilityTier {
  provider: CapabilityProvider;
  /** Optional endpoint hint — used by adapters to pick the right call shape. */
  endpoint?: string;
  /** Time-to-live for cached facts produced from this tier. */
  ttlMs: number;
  /** Optional gate that restricts when this tier applies (e.g. only for a specific subject). */
  when?: (atom: AgentAtom) => boolean;
  /** Optional post-processor id (e.g. 'tx_gate_analyzer'). Resolvers may attach behavior. */
  postProcessor?: string;
}

const ONE_SECOND_MS = 1_000;
const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;

/** Default fallback TTL used when a tier doesn't override it. */
export const DEFAULT_CAPABILITY_TTL_MS = 60 * ONE_SECOND_MS;

/**
 * Provider chains, in priority order. Web is always last (or only) when there
 * is genuinely no other authoritative source.
 *
 * `when` predicates handle subject-level specialization (e.g. Fear & Greed has
 * a dedicated provider; BTC dominance routes through CoinGecko global; both
 * fall back to web).
 */
export const CAPABILITY_REGISTRY: Readonly<Record<AgentAtomType, ReadonlyArray<CapabilityTier>>> = Object.freeze({
  price: [
    { provider: 'jupiter', endpoint: 'price', ttlMs: 30 * ONE_SECOND_MS },
    { provider: 'coingecko', endpoint: 'simple.price', ttlMs: ONE_MINUTE_MS },
    { provider: 'birdeye', endpoint: 'price_multi', ttlMs: 30 * ONE_SECOND_MS },
    { provider: 'web', ttlMs: 10 * ONE_MINUTE_MS },
  ],
  market_regime: [
    {
      provider: 'alternative_me',
      endpoint: 'fng',
      ttlMs: 15 * ONE_MINUTE_MS,
      when: (atom) => atom.type === 'market_regime' && atom.subject === 'fear_and_greed',
    },
    {
      provider: 'coingecko',
      endpoint: 'global',
      ttlMs: 5 * ONE_MINUTE_MS,
      when: (atom) => atom.type === 'market_regime' && atom.subject !== 'fear_and_greed',
    },
    { provider: 'web', ttlMs: 10 * ONE_MINUTE_MS },
  ],
  token_audit: [
    { provider: 'jupiter', endpoint: 'token_evidence', ttlMs: 5 * ONE_MINUTE_MS },
    { provider: 'birdeye', endpoint: 'token_security', ttlMs: 10 * ONE_MINUTE_MS },
  ],
  token_age: [
    { provider: 'helius', endpoint: 'mint_creation', ttlMs: 24 * 60 * ONE_MINUTE_MS },
    { provider: 'birdeye', endpoint: 'token_security', ttlMs: ONE_MINUTE_MS },
    { provider: 'web', ttlMs: 10 * ONE_MINUTE_MS },
  ],
  tx_gate: [
    { provider: 'rpc', endpoint: 'simulate_transaction', ttlMs: 15 * ONE_SECOND_MS, postProcessor: 'tx_gate_analyzer' },
  ],
  external_price: [
    { provider: 'web', ttlMs: 10 * ONE_MINUTE_MS },
  ],
  protocol_health: [
    { provider: 'protocol_connector', endpoint: 'read_facts', ttlMs: ONE_MINUTE_MS },
    { provider: 'web', ttlMs: 10 * ONE_MINUTE_MS },
  ],
});

/* -------------------------------------------------------------------------- */
/* Resolution helpers                                                         */
/* -------------------------------------------------------------------------- */

export interface ResolvedAtomTier {
  atom: AgentAtom;
  /** Provider chain for this specific atom, after `when` gates are applied. */
  chain: CapabilityTier[];
}

/** Returns the ordered provider chain for an atom, filtering tiers whose `when` predicate fails. */
export function chainForAtom(atom: AgentAtom): CapabilityTier[] {
  const tiers = CAPABILITY_REGISTRY[atom.type] ?? [];
  return tiers.filter((tier) => (tier.when ? tier.when(atom) : true));
}

/** Build resolution plans for a batch of atoms. */
export function planAtomResolution(atoms: ReadonlyArray<AgentAtom>): ResolvedAtomTier[] {
  return atoms.map((atom) => ({ atom, chain: chainForAtom(atom) }));
}

/** True if web search is the only tier (i.e. there is no crypto-API alternative). */
export function isWebOnly(atom: AgentAtom): boolean {
  const chain = chainForAtom(atom);
  return chain.length > 0 && chain.every((tier) => tier.provider === 'web');
}

/** True if the chain includes a web fallback tier. */
export function hasWebFallback(atom: AgentAtom): boolean {
  return chainForAtom(atom).some((tier) => tier.provider === 'web');
}

/* -------------------------------------------------------------------------- */
/* Per-atom resolution loop                                                   */
/* -------------------------------------------------------------------------- */

export type CapabilityResolverFn<T = unknown> = (
  atom: AgentAtom,
  tier: CapabilityTier,
) => Promise<CapabilityResolutionAttempt<T>>;

export interface CapabilityResolutionAttempt<T = unknown> {
  status: 'ok' | 'missing' | 'error';
  value?: T;
  source: CapabilityProvider;
  endpoint?: string;
  checkedAt: string;
  /** Set when `status` is 'error' or 'missing' to explain the fall-through. */
  detail?: string;
}

export interface CapabilityResolution<T = unknown> {
  atom: AgentAtom;
  attempts: CapabilityResolutionAttempt<T>[];
  /** The first successful attempt, if any. */
  resolved?: CapabilityResolutionAttempt<T>;
  /** True when every tier in the chain failed or returned missing. */
  exhausted: boolean;
}

export interface ResolveOptions {
  /** When true (default), a single tier that throws a transient error gets ONE
   *  retry with a short backoff before falling through to the next tier. */
  retryTransient?: boolean;
  /** Backoff before retrying a transient failure, in ms. Default 150. */
  retryDelayMs?: number;
  /** Optional structured trace sink — called once per attempt (success or failure).
   *  Wire `AGENT_WALLET_TRACE=1` callers through this hook to get per-atom logs without
   *  coupling the registry to any logging framework. */
  trace?: (event: CapabilityTraceEvent) => void;
}

export interface CapabilityTraceEvent {
  atomId: string;
  atomType: AgentAtom['type'];
  tierIndex: number;
  tier: CapabilityTier;
  attempt: 'first' | 'retry';
  outcome: 'ok' | 'missing' | 'error';
  detail?: string;
  durationMs?: number;
}

const TRANSIENT_RE = /\b(timeout|timed?\s*out|econn|enotfound|fetch\s*failed|network|reset|503|504|429|abort|temporar(?:y|ily)|unavailable)\b/i;

function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_RE.test(msg);
}

function isTransientAttempt(attempt: CapabilityResolutionAttempt<unknown>): boolean {
  if (attempt.status !== 'error') return false;
  return isTransientError(attempt.detail);
}

function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve a single atom by trying each tier in order.
 *
 * The resolver function is provider-agnostic — call sites inject a function
 * that knows how to make calls to each provider. This keeps `agentCapabilityRegistry.ts`
 * free of network code so it can be reused from any layer (mcp-server, browser-demo,
 * cloud worker, etc.).
 *
 * Behavior:
 *   - Tiers are tried in priority order.
 *   - A tier that throws or returns status='error' with a transient-looking message
 *     is retried ONCE (after `retryDelayMs`) when `retryTransient !== false`. Use this
 *     to absorb single-flap network blips before falling through to the next tier.
 *   - The first tier that returns status='ok' wins; the rest are skipped.
 *   - `trace` is called once per attempt — including retries — for telemetry.
 */
export async function resolveAtom<T = unknown>(
  atom: AgentAtom,
  resolver: CapabilityResolverFn<T>,
  options: ResolveOptions = {},
): Promise<CapabilityResolution<T>> {
  const chain = chainForAtom(atom);
  const attempts: CapabilityResolutionAttempt<T>[] = [];
  const retryTransient = options.retryTransient !== false;
  const retryDelayMs = options.retryDelayMs ?? 150;
  for (let tierIndex = 0; tierIndex < chain.length; tierIndex += 1) {
    const tier = chain[tierIndex]!;
    const attempt = await runTierOnce(atom, tier, resolver);
    options.trace?.({
      atomId: atom.id,
      atomType: atom.type,
      tierIndex,
      tier,
      attempt: 'first',
      outcome: attempt.status,
      detail: attempt.detail,
    });
    attempts.push(attempt);
    if (attempt.status === 'ok') {
      return { atom, attempts, resolved: attempt, exhausted: false };
    }
    if (retryTransient && isTransientAttempt(attempt)) {
      await sleep(retryDelayMs);
      const retry = await runTierOnce(atom, tier, resolver);
      options.trace?.({
        atomId: atom.id,
        atomType: atom.type,
        tierIndex,
        tier,
        attempt: 'retry',
        outcome: retry.status,
        detail: retry.detail,
      });
      attempts.push(retry);
      if (retry.status === 'ok') {
        return { atom, attempts, resolved: retry, exhausted: false };
      }
    }
  }
  return { atom, attempts, exhausted: true };
}

async function runTierOnce<T>(
  atom: AgentAtom,
  tier: CapabilityTier,
  resolver: CapabilityResolverFn<T>,
): Promise<CapabilityResolutionAttempt<T>> {
  try {
    return await resolver(atom, tier);
  } catch (err) {
    return {
      status: 'error',
      source: tier.provider,
      endpoint: tier.endpoint,
      checkedAt: new Date().toISOString(),
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve many atoms in parallel; returns one resolution per atom in input order.
 */
export async function resolveAtoms<T = unknown>(
  atoms: ReadonlyArray<AgentAtom>,
  resolver: CapabilityResolverFn<T>,
  options: ResolveOptions = {},
): Promise<CapabilityResolution<T>[]> {
  return Promise.all(atoms.map((atom) => resolveAtom(atom, resolver, options)));
}
