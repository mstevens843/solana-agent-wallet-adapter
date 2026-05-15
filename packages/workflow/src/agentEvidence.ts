import type {
  AgentConnectorProfileKind,
  AgentFactNeed,
  AgentFactProvider,
  AgentFactRoute,
  AgentFactRoutePlan,
} from './agentFactRouter.js';
import type { AgentReviewQuestion } from './agentPlans.js';

export type AgentEvidenceSeverity = 'info' | 'warn' | 'block';
export type AgentEvidenceRequirementStatus = 'required' | 'optional';
export type AgentEvidenceFreshness = 'fresh' | 'stale' | 'missing';
export type AgentEvidenceGateDecision = 'pass' | 'block' | 'needs_input';
export type AgentEvidenceFactTone = 'good' | 'neutral' | 'warn' | 'fail';
export type AgentEvidenceFactSource =
  | 'deterministic'
  | 'wallet'
  | 'helius'
  | 'birdeye'
  | 'coingecko'
  | 'jupiter'
  | 'connector'
  | 'ai';

export interface AgentEvidenceRequirement {
  id: string;
  routeId: string;
  need: AgentFactNeed;
  provider: AgentFactProvider;
  endpoint: string;
  status: AgentEvidenceRequirementStatus;
  ttlMs: number;
  blocking: boolean;
  reason: string;
  connectorProfile?: AgentConnectorProfileKind;
  connectorId?: string;
  capability?: string;
}

export interface AgentEvidenceFact {
  id: string;
  requirementId?: string;
  routeId?: string;
  label: string;
  value: string;
  tone: AgentEvidenceFactTone;
  source: AgentEvidenceFactSource;
  checkedAt: string;
  expiresAt?: string;
  freshness: AgentEvidenceFreshness;
  severity: AgentEvidenceSeverity;
  detail?: Record<string, unknown>;
}

export interface AgentEvidenceGateResult {
  decision: AgentEvidenceGateDecision;
  checkedAt: string;
  requirements: AgentEvidenceRequirement[];
  facts: AgentEvidenceFact[];
  missingRequired: AgentEvidenceRequirement[];
  staleRequired: AgentEvidenceRequirement[];
  blockingFacts: AgentEvidenceFact[];
  warnings: AgentEvidenceFact[];
  reason: string;
}

export interface AgentDecisionContract {
  decision: 'approve' | 'deny' | 'needs_input';
  confidence?: 'high' | 'medium' | 'low';
  reason: string;
  summary: string;
  evidenceFactIds: string[];
  missingFactIds?: string[];
  blockingFactIds?: string[];
  warnings?: string[];
  questions?: AgentReviewQuestion[];
}

export interface AgentDecisionAuditReceipt {
  schemaVersion: 1;
  receiptId: string;
  planFingerprint: string;
  walletAddress: string;
  cluster: string;
  connectorId?: string;
  connectorProfile?: AgentConnectorProfileKind;
  routePlanHash: string;
  evidenceHash: string;
  aiDecisionHash: string;
  finalDecision: 'approve' | 'deny' | 'needs_input';
  gateDecision: AgentEvidenceGateDecision;
  checkedAt: string;
  providerRoutes: string[];
  evidenceFactIds: string[];
  blockingFactIds: string[];
  missingRequirementIds: string[];
}

export interface AgentEvidenceContext {
  walletAddress?: string;
  draftWalletAddress?: string;
  cluster?: string;
  connectorId?: string;
  connectorProfile?: AgentConnectorProfileKind;
  connectorEnabled?: boolean;
  connectorReadReady?: boolean;
  planFingerprint?: string;
  nowIso?: string;
  isWalletScoped?: boolean;
  enabledUserPolicyIds?: string[];
  externalResearchAvailable?: boolean;
}

export const AGENT_EVIDENCE_RECEIPT_SCHEMA_VERSION = 1 as const;

const ONE_SECOND_MS = 1_000;
const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export const AGENT_EVIDENCE_TTL_MS_BY_ROUTE: Readonly<Record<string, number>> = Object.freeze({
  'wallet.connected_public_key': Number.POSITIVE_INFINITY,
  'helius.getTransfersByAddress': 120 * ONE_SECOND_MS,
  'birdeye.wallet_token_list': 60 * ONE_SECOND_MS,
  'birdeye.token_metadata': ONE_DAY_MS,
  'birdeye.token_security': 10 * ONE_MINUTE_MS,
  'birdeye.price_multi': 30 * ONE_SECOND_MS,
  'coingecko.token_evidence': 5 * ONE_MINUTE_MS,
  'coingecko.global': 5 * ONE_MINUTE_MS,
  'alternative_me.fear_greed': 15 * ONE_MINUTE_MS,
  'jupiter.swap_order_preview': 20 * ONE_SECOND_MS,
  'jupiter.swap_route': 20 * ONE_SECOND_MS,
  'protocol_connector.read_facts': 60 * ONE_SECOND_MS,
  'external_research.current_web': 10 * ONE_MINUTE_MS,
  'dexscreener.token_pairs': 60 * ONE_SECOND_MS,
});

const ORACLE_CONNECTOR_TTL_MS = 30 * ONE_SECOND_MS;
const DEFAULT_TTL_MS = 60 * ONE_SECOND_MS;

export function ttlForRoute(route: AgentFactRoute, profileKind?: AgentConnectorProfileKind): number {
  if (route.id === 'protocol_connector.read_facts' && profileKind === 'oracle') {
    return ORACLE_CONNECTOR_TTL_MS;
  }
  const base = AGENT_EVIDENCE_TTL_MS_BY_ROUTE[route.id];
  return typeof base === 'number' ? base : DEFAULT_TTL_MS;
}

export function expiresAtFor(checkedAtIso: string, ttlMs: number): string | undefined {
  if (!Number.isFinite(ttlMs)) return undefined;
  const checked = Date.parse(checkedAtIso);
  if (Number.isNaN(checked)) return undefined;
  return new Date(checked + ttlMs).toISOString();
}

export function freshnessFor(
  checkedAtIso: string | undefined,
  ttlMs: number,
  nowIso?: string,
): AgentEvidenceFreshness {
  if (!checkedAtIso) return 'missing';
  if (!Number.isFinite(ttlMs)) return 'fresh';
  const checked = Date.parse(checkedAtIso);
  if (Number.isNaN(checked)) return 'missing';
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  if (Number.isNaN(now)) return 'fresh';
  return now - checked > ttlMs ? 'stale' : 'fresh';
}

export interface NormalizeAgentEvidenceFactInput {
  id: string;
  routeId?: string;
  requirementId?: string;
  label: string;
  value: string;
  tone?: AgentEvidenceFactTone;
  source: AgentEvidenceFactSource;
  severity?: AgentEvidenceSeverity;
  checkedAt?: string;
  ttlMs?: number;
  nowIso?: string;
  detail?: Record<string, unknown>;
}

export function normalizeAgentEvidenceFact(input: NormalizeAgentEvidenceFactInput): AgentEvidenceFact {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const ttlMs = typeof input.ttlMs === 'number' ? input.ttlMs : Number.POSITIVE_INFINITY;
  const freshness = freshnessFor(checkedAt, ttlMs, input.nowIso);
  const tone: AgentEvidenceFactTone = input.tone ?? 'neutral';
  const severity: AgentEvidenceSeverity = input.severity ?? severityForTone(tone, freshness);
  const expiresAt = expiresAtFor(checkedAt, ttlMs);
  return {
    id: input.id,
    label: input.label,
    value: input.value,
    tone,
    source: input.source,
    checkedAt,
    freshness,
    severity,
    ...(input.routeId ? { routeId: input.routeId } : {}),
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

function severityForTone(tone: AgentEvidenceFactTone, freshness: AgentEvidenceFreshness): AgentEvidenceSeverity {
  if (tone === 'fail') return 'block';
  if (tone === 'warn' || freshness === 'stale' || freshness === 'missing') return 'warn';
  return 'info';
}

/**
 * Stable JSON: keys sorted alphabetically at every depth so the same data always produces the same string,
 * which is what the hash helpers below depend on.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonForStable(value));
}

function sortJsonForStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonForStable);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortJsonForStable(v)]));
  }
  return value;
}

const HEX_LOOKUP = Array.from({ length: 256 }, (_, idx) => idx.toString(16).padStart(2, '0'));

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX_LOOKUP[bytes[i] ?? 0];
  return out;
}

interface SubtleLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

function getSubtle(): SubtleLike {
  const cryptoRef = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto;
  const subtle = cryptoRef?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SubtleCrypto is required for evidence hashing but is not available in this environment.');
  }
  return subtle;
}

export async function hashStableJson(value: unknown): Promise<string> {
  const subtle = getSubtle();
  const data = new TextEncoder().encode(stableStringify(value));
  const digest = await subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

export async function routePlanHash(routesOrPlan: AgentFactRoute[] | AgentFactRoutePlan): Promise<string> {
  const routes = Array.isArray(routesOrPlan) ? routesOrPlan : routesOrPlan.routes;
  const projected = routes.map((route) => ({
    id: route.id,
    need: route.need,
    provider: route.provider,
    endpoint: route.endpoint,
    status: route.status,
    ...(route.params ? { params: route.params } : {}),
  }));
  return hashStableJson(projected);
}

export async function evidenceHash(facts: AgentEvidenceFact[]): Promise<string> {
  const projected = facts.map((fact) => ({
    id: fact.id,
    routeId: fact.routeId,
    requirementId: fact.requirementId,
    label: fact.label,
    value: fact.value,
    tone: fact.tone,
    source: fact.source,
    severity: fact.severity,
    freshness: fact.freshness,
    checkedAt: fact.checkedAt,
  }));
  return hashStableJson(projected);
}

export async function aiDecisionHash(contract: AgentDecisionContract): Promise<string> {
  return hashStableJson({
    decision: contract.decision,
    reason: contract.reason,
    summary: contract.summary,
    confidence: contract.confidence,
    evidenceFactIds: [...contract.evidenceFactIds].sort(),
    blockingFactIds: [...(contract.blockingFactIds ?? [])].sort(),
    missingFactIds: [...(contract.missingFactIds ?? [])].sort(),
  });
}

export function generateReceiptId(seed?: string): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  const tag = seed ? `_${seed.slice(0, 6)}` : '';
  return `rcpt_${time}_${rand}${tag}`;
}
