import type { AgentConnectorProfileKind, AgentFactRoute, AgentFactRoutePlan } from './agentFactRouter.js';
import type { AgentPlanReviewResult } from './agentPlans.js';
import {
  AGENT_EVIDENCE_RECEIPT_SCHEMA_VERSION,
  type AgentDecisionAuditReceipt,
  type AgentDecisionContract,
  type AgentEvidenceContext,
  type AgentEvidenceFact,
  type AgentEvidenceFreshness,
  type AgentEvidenceGateDecision,
  type AgentEvidenceGateResult,
  type AgentEvidenceRequirement,
  aiDecisionHash,
  evidenceHash,
  freshnessFor,
  generateReceiptId,
  routePlanHash,
} from './agentEvidence.js';
import { computeConfidence, type ConfidenceBand } from './confidence.js';
import { computeCounterfactuals } from './counterfactuals.js';

const WALLET_IDENTITY_ROUTE = 'wallet.connected_public_key';
const EXTERNAL_RESEARCH_ROUTE = 'external_research.current_web';
const CONNECTOR_READ_ROUTE = 'protocol_connector.read_facts';

interface FactIndex {
  byId: Map<string, AgentEvidenceFact>;
  byRequirementId: Map<string, AgentEvidenceFact[]>;
  byRouteId: Map<string, AgentEvidenceFact[]>;
}

function indexFacts(facts: AgentEvidenceFact[]): FactIndex {
  const byId = new Map<string, AgentEvidenceFact>();
  const byRequirementId = new Map<string, AgentEvidenceFact[]>();
  const byRouteId = new Map<string, AgentEvidenceFact[]>();
  for (const fact of facts) {
    byId.set(fact.id, fact);
    if (fact.requirementId) {
      const list = byRequirementId.get(fact.requirementId) ?? [];
      list.push(fact);
      byRequirementId.set(fact.requirementId, list);
    }
    if (fact.routeId) {
      const list = byRouteId.get(fact.routeId) ?? [];
      list.push(fact);
      byRouteId.set(fact.routeId, list);
    }
  }
  return { byId, byRequirementId, byRouteId };
}

function factsForRequirement(req: AgentEvidenceRequirement, index: FactIndex): AgentEvidenceFact[] {
  const matched = index.byRequirementId.get(req.id) ?? [];
  if (matched.length) return matched;
  return index.byRouteId.get(req.routeId) ?? [];
}

function applyCurrentFreshness(fact: AgentEvidenceFact, ttlMs: number, nowIso: string): AgentEvidenceFact {
  const freshness = freshnessFor(fact.checkedAt, ttlMs, nowIso);
  if (freshness === fact.freshness) return fact;
  const severity = freshness === 'stale' && fact.severity === 'info' ? 'warn' : fact.severity;
  return { ...fact, freshness, severity };
}

/**
 * Pre-AI gate. Decides whether the AI can even be asked to approve.
 *
 * Rules (from AGENT_ASK_APPROVAL_ALGORITHM.md §6):
 *   - Required-but-missing fact → block (or needs_input for external research)
 *   - Required-but-stale fact → block
 *   - Required-but-failed fact → block
 *   - Any blocking-severity fact → block
 *   - Wallet-scoped review without connected public key → block
 *   - Wallet mismatch between connected and draft → block
 *   - Connector required but disabled/not-read-ready → block
 *   - External research required but unavailable → needs_input
 *   - Optional missing facts → pass with warnings
 */
export function evaluateAgentEvidenceGate(
  requirements: AgentEvidenceRequirement[],
  facts: AgentEvidenceFact[],
  context: AgentEvidenceContext,
): AgentEvidenceGateResult {
  const nowIso = context.nowIso ?? new Date().toISOString();
  const normalizedFacts = facts.map((fact) => {
    const req = requirements.find((r) => r.id === fact.requirementId || r.routeId === fact.routeId);
    const ttl = req?.ttlMs ?? Number.POSITIVE_INFINITY;
    return applyCurrentFreshness(fact, ttl, nowIso);
  });
  const index = indexFacts(normalizedFacts);

  const missingRequired: AgentEvidenceRequirement[] = [];
  const staleRequired: AgentEvidenceRequirement[] = [];
  const blockingFacts: AgentEvidenceFact[] = [];
  const warnings: AgentEvidenceFact[] = [];
  const reasons: string[] = [];

  let decision: AgentEvidenceGateDecision = 'pass';
  const downgradeToBlock = (reason: string): void => {
    decision = 'block';
    if (reason) reasons.push(reason);
  };
  const downgradeToNeedsInput = (reason: string): void => {
    if (decision !== 'block') decision = 'needs_input';
    if (reason) reasons.push(reason);
  };

  for (const req of requirements) {
    const matching = factsForRequirement(req, index);
    const usable = matching.filter((f) => f.severity !== 'block' && f.freshness === 'fresh');
    if (req.status !== 'required') {
      if (!matching.length && req.blocking === false) {
        // optional + missing: do nothing
      }
      continue;
    }

    if (!matching.length) {
      if (req.routeId === EXTERNAL_RESEARCH_ROUTE && context.externalResearchAvailable === true) {
        // The configured AI provider will perform two-pass web research via its native search
        // tool (Anthropic web_search, OpenAI Responses web_search_preview, Gemini google_search).
        // This is deferred-to-AI, NOT a gate gap — do not record it as missingRequired, otherwise
        // the post-AI validator would downgrade a research-backed approve. validateAgentReviewDecision
        // separately enforces that the AI actually returned research before trusting the approve.
        continue;
      }
      missingRequired.push(req);
      if (req.routeId === EXTERNAL_RESEARCH_ROUTE) {
        if (context.externalResearchAvailable === false) {
          downgradeToNeedsInput(`External research required but unavailable: ${req.reason}`);
          continue;
        }
        // undefined: fall through to the conservative default (block-if-blocking).
      }
      if (req.blocking || req.routeId === WALLET_IDENTITY_ROUTE) {
        downgradeToBlock(`Required evidence missing: ${req.reason}`);
      } else {
        downgradeToNeedsInput(`Required evidence missing: ${req.reason}`);
      }
      continue;
    }

    const stale = matching.find((f) => f.freshness === 'stale');
    if (stale && !usable.length) {
      staleRequired.push(req);
      downgradeToBlock(`Required evidence is stale (${req.routeId}).`);
    }

    const fail = matching.find((f) => f.severity === 'block');
    if (fail) {
      blockingFacts.push(fail);
      downgradeToBlock(`Blocking fact present: ${fail.label}`);
    }
  }

  for (const fact of normalizedFacts) {
    if (fact.severity === 'block' && !blockingFacts.includes(fact)) {
      blockingFacts.push(fact);
      downgradeToBlock(`Blocking fact present: ${fact.label}`);
    } else if (fact.severity === 'warn') {
      warnings.push(fact);
    }
  }

  if (context.isWalletScoped !== false) {
    if (!context.walletAddress) {
      downgradeToBlock('Wallet-scoped action requires a connected public key.');
    } else if (
      context.draftWalletAddress &&
      context.draftWalletAddress.trim() &&
      context.draftWalletAddress.trim() !== context.walletAddress.trim()
    ) {
      downgradeToBlock(`Connected wallet (${context.walletAddress}) does not match draft wallet (${context.draftWalletAddress}).`);
    }
  }

  if (context.connectorId) {
    if (context.connectorEnabled === false) {
      downgradeToBlock(`Selected connector ${context.connectorId} is disabled.`);
    } else if (
      requirements.some((req) => req.routeId === CONNECTOR_READ_ROUTE && req.status === 'required') &&
      context.connectorReadReady === false
    ) {
      downgradeToBlock(`Selected connector ${context.connectorId} read endpoints are not ready.`);
    }
  }

  const reason = decision === 'pass'
    ? warnings.length
      ? `Gate passed with ${warnings.length} optional warning${warnings.length === 1 ? '' : 's'}.`
      : 'All required evidence is present, fresh, and passing.'
    : reasons.join(' ');

  return {
    decision,
    checkedAt: nowIso,
    requirements,
    facts: normalizedFacts,
    missingRequired,
    staleRequired,
    blockingFacts,
    warnings,
    reason,
  };
}

export interface ValidateAgentReviewDecisionInput {
  aiResult: AgentPlanReviewResult;
  gate: AgentEvidenceGateResult;
  facts: AgentEvidenceFact[];
  requirements: AgentEvidenceRequirement[];
  /** Optional. When supplied, counterfactuals are computed against the same context. */
  context?: AgentEvidenceContext;
}

export interface ValidateAgentReviewDecisionOutput {
  final: AgentPlanReviewResult;
  decisionContract: AgentDecisionContract;
  violations: string[];
}

/**
 * Post-AI validator. The AI is not allowed to override deterministic blocks; this enforces that.
 *
 * Rules (from AGENT_ASK_APPROVAL_ALGORITHM.md §8):
 *   - AI approve + gate not pass → deny (or needs_input)
 *   - AI cites unknown evidence ids → needs_input
 *   - AI omits required evidence ids while approving → needs_input
 *   - AI approve while any required fact is stale/missing → deny
 *   - AI deny with blocking evidence → preserved
 *   - AI needs_input + all required facts pass → still needs_input (user input still required)
 */
export function validateAgentReviewDecision(
  input: ValidateAgentReviewDecisionInput,
): ValidateAgentReviewDecisionOutput {
  const { aiResult, gate, facts, requirements } = input;
  const knownFactIds = new Set(facts.map((fact) => fact.id));
  const contract = extractDecisionContractFromAiResult(aiResult, knownFactIds);
  const violations: string[] = [];

  let decision: AgentPlanReviewResult['decision'] = contract.decision;
  let reason = aiResult.reason;
  let summary = aiResult.summary;

  // A required external-research route that the gate DEFERRED to the AI (externalResearchAvailable
  // === true, so it is not in missingRequired) is only satisfied if the AI actually returned
  // research — either a matching deterministic fact resolved it pre-AI, or the AI cited research in
  // its result. If neither holds, an approve is unsupported and must drop to needs_input.
  const researchDeferredButUnsatisfied = (): boolean => {
    const researchReq = requirements.find(
      (req) => req.routeId === EXTERNAL_RESEARCH_ROUTE && req.status === 'required',
    );
    if (!researchReq) return false;
    if (input.context?.externalResearchAvailable !== true) return false;
    const satisfiedByFact = facts.some(
      (fact) => fact.routeId === EXTERNAL_RESEARCH_ROUTE || fact.requirementId === researchReq.id,
    );
    if (satisfiedByFact) return false;
    return !hasExternalResearchCitation(aiResult);
  };

  if (decision === 'approve') {
    if (gate.decision === 'block') {
      decision = 'deny';
      reason = `Gate blocked: ${gate.reason}`;
      violations.push('AI approved while gate blocked.');
    } else if (gate.decision === 'needs_input') {
      decision = 'needs_input';
      reason = `Gate needs input: ${gate.reason}`;
      violations.push('AI approved while gate required input.');
    } else if (gate.missingRequired.length > 0) {
      decision = 'needs_input';
      reason = `Missing required evidence: ${gate.missingRequired.map((req) => req.routeId).join(', ')}`;
      violations.push('AI approved while required evidence was missing.');
    } else if (gate.staleRequired.length > 0 || gate.blockingFacts.length > 0) {
      decision = 'deny';
      reason = `Required evidence is stale or blocked: ${gate.reason}`;
      violations.push('AI approved while required evidence was stale or had blocking facts.');
    } else if (researchDeferredButUnsatisfied()) {
      decision = 'needs_input';
      reason = 'External research was required but the AI returned no research findings. Re-run the review or supply the value.';
      violations.push('AI approved a research-gated action without returning research.');
    } else {
      // Gate has already verified every required requirement is present, fresh, and not blocked.
      // We DO NOT require the AI to cite an internal evidenceFactId — many valid approvals are
      // driven entirely by external research (e.g., "approve if T-Mobile plan < $20"), where the
      // citation is in `evidence.sources` rather than the deterministic fact set. Trust the gate;
      // only strip ids the AI hallucinated.
      const unknownIds = contract.evidenceFactIds.filter((id) => !knownFactIds.has(id));
      const allCitedUnknown = unknownIds.length > 0 && unknownIds.length === contract.evidenceFactIds.length;
      const hasExternalCitation = hasExternalResearchCitation(aiResult);
      if (allCitedUnknown && !hasExternalCitation) {
        decision = 'needs_input';
        reason = `AI cited only unknown evidence ids: ${unknownIds.join(', ')}`;
        violations.push('AI cited only unknown evidence ids.');
      } else if (unknownIds.length) {
        violations.push(`AI cited unknown evidence ids that were stripped: ${unknownIds.join(', ')}`);
      }
    }
  } else if (decision === 'needs_input') {
    // Preserve needs_input.
  } else {
    // deny preserved
  }

  if (decision !== contract.decision) {
    summary = `${summary} [adjusted by validator]`.trim();
  }

  const sanitizedFactIds = contract.evidenceFactIds.filter((id) => knownFactIds.has(id));

  // Deterministic confidence calibration. Combines gate health with the AI's stated band
  // as a weighted input, producing a numeric score and a band the receipt can record.
  const externalResearchUsed = hasExternalResearchCitation(aiResult);
  const confidence = computeConfidence({
    gate,
    facts,
    requirements,
    aiBand: contract.confidence,
    decision,
    citedFactIdCount: sanitizedFactIds.length,
    externalResearchUsed,
  });

  // Counterfactuals: which evidence would, if changed, flip the decision? Requires the
  // context that produced the gate so the simulator can re-evaluate.
  const counterfactuals = input.context
    ? computeCounterfactuals({
        decision,
        gate,
        facts,
        requirements,
        context: input.context,
      })
    : [];

  const sanitizedContract: AgentDecisionContract = {
    ...contract,
    decision,
    reason,
    summary,
    evidenceFactIds: sanitizedFactIds,
    confidence: confidence.band,
    confidenceScore: confidence.score,
    confidenceFactors: confidence.factors,
    counterfactuals,
  };

  const finalResult: AgentPlanReviewResult = {
    ...aiResult,
    decision,
    reason,
    summary,
    evidence: {
      ...(aiResult.evidence ?? {}),
      decisionContract: sanitizedContract,
    },
  };

  return { final: finalResult, decisionContract: sanitizedContract, violations };
}

function extractDecisionContractFromAiResult(
  aiResult: AgentPlanReviewResult,
  knownFactIds: Set<string>,
): AgentDecisionContract {
  const evidence = (aiResult.evidence ?? {}) as Record<string, unknown>;
  const fromEvidence = evidence.decisionContract;
  const source: Partial<AgentDecisionContract> = isJsonObject(fromEvidence) ? (fromEvidence as Partial<AgentDecisionContract>) : {};
  const directEvidenceIds = readStringArray(evidence.evidenceFactIds);
  const directBlocking = readStringArray(evidence.blockingFactIds);
  const directMissing = readStringArray(evidence.missingFactIds);
  const decision = aiResult.decision;
  return {
    decision,
    confidence: typeof source.confidence === 'string'
      ? (source.confidence as AgentDecisionContract['confidence'])
      : undefined,
    reason: aiResult.reason,
    summary: aiResult.summary,
    evidenceFactIds: (Array.isArray(source.evidenceFactIds) ? source.evidenceFactIds : directEvidenceIds).filter((id) => typeof id === 'string'),
    blockingFactIds: (Array.isArray(source.blockingFactIds) ? source.blockingFactIds : directBlocking).filter((id) => typeof id === 'string'),
    missingFactIds: (Array.isArray(source.missingFactIds) ? source.missingFactIds : directMissing).filter((id) => typeof id === 'string'),
    warnings: Array.isArray(source.warnings) ? source.warnings.filter((value): value is string => typeof value === 'string') : undefined,
    questions: aiResult.questions,
  };

  function readStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
    return [];
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The AI may approve based on external web research (e.g., "approve if T-Mobile plan < $20").
 * In that case the citation lives in `evidence.research` and `evidence.sources` rather than
 * in our deterministic `evidenceFactIds`. Detect that here so the validator doesn't downgrade
 * a research-backed approval just because no deterministic fact was cited.
 */
function hasExternalResearchCitation(aiResult: AgentPlanReviewResult): boolean {
  const evidence = aiResult.evidence as Record<string, unknown> | undefined;
  if (!evidence) return false;
  const research = evidence.research;
  if (isJsonObject(research) && (research.status === 'checked' || research.required === true)) {
    return true;
  }
  const sources = evidence.sources;
  if (Array.isArray(sources) && sources.length > 0) return true;
  return false;
}

export interface CreateDecisionAuditReceiptInput {
  finalDecision: AgentPlanReviewResult['decision'];
  decisionContract: AgentDecisionContract;
  gate: AgentEvidenceGateResult;
  facts: AgentEvidenceFact[];
  requirements: AgentEvidenceRequirement[];
  routes: AgentFactRoute[] | AgentFactRoutePlan;
  walletAddress: string;
  cluster: string;
  planFingerprint: string;
  connectorId?: string;
  connectorProfile?: AgentConnectorProfileKind;
  nowIso?: string;
  receiptIdSeed?: string;
}

export async function createDecisionAuditReceipt(
  input: CreateDecisionAuditReceiptInput,
): Promise<AgentDecisionAuditReceipt> {
  const routes = Array.isArray(input.routes) ? input.routes : input.routes.routes;
  const [routePlanHashHex, evidenceHashHex, aiDecisionHashHex] = await Promise.all([
    routePlanHash(routes),
    evidenceHash(input.facts),
    aiDecisionHash(input.decisionContract),
  ]);
  const checkedAt = input.nowIso ?? new Date().toISOString();
  const counterfactualSummary = (input.decisionContract.counterfactuals ?? []).map((cf) => ({
    id: cf.id,
    rationale: cf.rationale,
    decisionAfter: cf.decisionAfter,
  }));
  return {
    schemaVersion: AGENT_EVIDENCE_RECEIPT_SCHEMA_VERSION,
    receiptId: generateReceiptId(input.receiptIdSeed ?? input.walletAddress),
    planFingerprint: input.planFingerprint,
    walletAddress: input.walletAddress,
    cluster: input.cluster,
    ...(input.connectorId ? { connectorId: input.connectorId } : {}),
    ...(input.connectorProfile ? { connectorProfile: input.connectorProfile } : {}),
    routePlanHash: routePlanHashHex,
    evidenceHash: evidenceHashHex,
    aiDecisionHash: aiDecisionHashHex,
    finalDecision: input.finalDecision,
    gateDecision: input.gate.decision,
    checkedAt,
    providerRoutes: routes.map((route) => route.id),
    evidenceFactIds: input.decisionContract.evidenceFactIds,
    blockingFactIds: input.decisionContract.blockingFactIds ?? input.gate.blockingFacts.map((f) => f.id),
    missingRequirementIds: input.gate.missingRequired.map((req) => req.id),
    ...(typeof input.decisionContract.confidenceScore === 'number'
      ? { confidenceScore: input.decisionContract.confidenceScore }
      : {}),
    ...(input.decisionContract.confidence
      ? { confidenceBand: input.decisionContract.confidence }
      : {}),
    ...(counterfactualSummary.length ? { counterfactualSummary } : {}),
  };
}

