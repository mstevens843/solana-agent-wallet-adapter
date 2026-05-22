/**
 * Calls the cloud `/api/policy/enrich` endpoint (defined in
 * apps/render-web/src/cloud/policyEnrich.ts) to get a pre-resolved
 * `policyBundle` for a BYOK device-agent request.
 *
 * The bundle contains atoms + per-atom provider-resolved evaluations + tx-gate
 * outcomes + `hasBlockingFailure`. Splicing it into `payload.context.policyBundle`
 * before invoking the device LLM means the LLM sees the same authoritative
 * evidence that the cloud's hosted-AI path injects into its own LLM calls
 * (jupiter / coingecko / birdeye / helius / alternative_me / web).
 *
 * Failure modes are silent: if the endpoint is unreachable or returns an error,
 * we forward the request without enrichment so the LLM can still attempt to
 * answer (with degraded evidence). This matches the cloud-side aiPlanner
 * behavior (`enrichRequestWithPolicyBundle` swallows errors).
 */

const DEFAULT_BASE_URL = inferBaseUrl();
const TIMEOUT_MS = 10_000;

export interface PolicyEnrichRequestPayload {
  instruction?: string;
  userNotes?: string;
  intent?: string;
  knownTokenSymbols?: string[];
  walletAddress?: string;
  draftParameters?: Record<string, string>;
  transactionBase64?: string;
  /** Pre-built simulation digest. When omitted but `transactionBase64` is present,
   *  the cloud will run simulation itself. */
  simulationDigest?: Record<string, unknown>;
  /** Override tx-gate context (allowedPrograms / swapProgramIds). Usually omitted;
   *  the cloud builds a sensible default from `actionType`. */
  txGateContext?: Record<string, unknown>;
  actionType?: string;
}

export interface PolicyBundleAtom {
  id: string;
  type: string;
  rawText: string;
}

export interface PolicyBundleEvaluation {
  atomId: string;
  pass?: boolean;
  unresolved?: boolean;
  finding: { label: string; value: string; tone: 'good' | 'warn' | 'fail' | 'neutral' };
}

export interface PolicyBundleTxGateOutcome {
  rule: string;
  pass: boolean;
  reason: string;
}

export interface PolicyBundle {
  atoms: PolicyBundleAtom[];
  evaluations: PolicyBundleEvaluation[];
  txGateOutcomes?: Record<string, PolicyBundleTxGateOutcome>;
  hasBlockingFailure: boolean;
  finishedAt: string;
}

export async function fetchPolicyBundle(
  payload: PolicyEnrichRequestPayload,
  options: { baseUrl?: string; signal?: AbortSignal } = {},
): Promise<PolicyBundle | null> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  if (!baseUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const cleanupSignal = () => {
    if (options.signal?.aborted) controller.abort();
  };
  options.signal?.addEventListener('abort', cleanupSignal, { once: true });
  try {
    const response = await fetch(`${baseUrl}/api/policy/enrich`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentic-client': 'browser-demo-byok',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: boolean; policyBundle?: PolicyBundle };
    if (!body.ok || !body.policyBundle) return null;
    return body.policyBundle;
  } catch {
    // Network failure / timeout / abort — silent degradation. The LLM falls
    // back to un-enriched reasoning, mirroring cloud-side aiPlanner behavior.
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cleanupSignal);
  }
}

/**
 * Splice a policyBundle into the device-agent payload under `context.policyBundle`.
 * Used by deviceAgentClient before invoking the native bridge for BYOK LLM calls.
 * Idempotent: callers can invoke unconditionally; a null bundle is a no-op.
 */
export function spliceBundle(payload: unknown, bundle: PolicyBundle | null): unknown {
  if (!bundle || bundle.atoms.length === 0) return payload;
  if (!payload || typeof payload !== 'object') {
    return { context: { policyBundle: bundle } };
  }
  const obj = payload as Record<string, unknown>;
  const existingContext = obj.context && typeof obj.context === 'object' && !Array.isArray(obj.context)
    ? (obj.context as Record<string, unknown>)
    : {};
  return {
    ...obj,
    context: {
      ...existingContext,
      policyBundle: bundle,
    },
  };
}

/**
 * Derive the cloud base URL from the current environment. In a hosted browser
 * shell, falls back to the current origin (assumes Render proxies /api/*).
 * In a native shell (Android / iOS / Tauri), the wrapper is responsible for
 * configuring an explicit baseUrl via env / setBaseUrl().
 */
function inferBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const { origin } = window.location;
    return origin;
  } catch {
    return '';
  }
}

/**
 * Enforce server-side `hasBlockingFailure` semantics after the BYOK LLM responds.
 * Cloud-side aiPlanner does this in `applyServerSideReviewSafety`; the device-agent
 * path must do it client-side because the LLM call bypasses the cloud.
 *
 * If the bundle had blocking failures AND the LLM returned `decision: approve`,
 * force-deny and surface the failing atoms via `blockingFactIds`. The optional
 * field is reflected in the return type so callers can read it without a cast.
 */
export function enforceBlockingFailure<R extends Record<string, unknown>>(
  llmResult: R,
  bundle: PolicyBundle | null | undefined,
): R & { blockingFactIds?: string[] } {
  if (!bundle || !bundle.hasBlockingFailure) return llmResult;
  const decision = llmResult.decision;
  if (decision !== 'approve') return llmResult;
  const failing = bundle.evaluations.filter((ev) => ev.pass === false);
  const first = failing[0];
  const reason = first
    ? `User policy bundle failed: ${first.finding.label}`
    : 'User policy bundle has at least one failing rule.';
  return {
    ...llmResult,
    decision: 'deny',
    reason,
    blockingFactIds: failing.map((ev) => ev.atomId),
  };
}
