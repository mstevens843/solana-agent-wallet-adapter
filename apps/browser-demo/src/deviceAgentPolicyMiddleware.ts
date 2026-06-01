import type { DeviceAgentMethod } from './deviceAgentClient.js';
import {
  applyPolicyBundleReviewSafety,
  fetchPolicyBundle,
  spliceBundle,
  type PolicyBundle,
} from './policyEnrichClient.js';

export interface DeviceAgentPolicyPreparation {
  payload: unknown;
  bundle: PolicyBundle | null;
}

export interface DeviceAgentPolicyMiddleware {
  prepare(
    method: DeviceAgentMethod,
    payload: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<DeviceAgentPolicyPreparation>;
  finalize<R>(
    method: DeviceAgentMethod,
    result: R,
    bundle: PolicyBundle | null | undefined,
  ): R;
}

export const defaultDeviceAgentPolicyMiddleware: DeviceAgentPolicyMiddleware = {
  prepare: prepareDeviceAgentPolicyPayload,
  finalize: finalizeDeviceAgentPolicyResult,
};

export async function prepareDeviceAgentPolicyPayload(
  method: DeviceAgentMethod,
  payload: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<DeviceAgentPolicyPreparation> {
  if (!shouldEnrichPolicyBundle(method, payload)) {
    return { payload, bundle: null };
  }
  const bundle = await fetchPolicyBundle(
    extractPolicyEnrichPayload(method, payload),
    { signal: options.signal },
  );
  return {
    payload: bundle ? spliceBundle(payload, bundle) : payload,
    bundle,
  };
}

export function finalizeDeviceAgentPolicyResult<R>(
  method: DeviceAgentMethod,
  result: R,
  bundle: PolicyBundle | null | undefined,
): R {
  if (
    method !== 'reviewPlan' ||
    !bundle ||
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result)
  ) {
    return result;
  }
  return applyPolicyBundleReviewSafety(result as Record<string, unknown>, bundle) as R;
}

/**
 * Only review/ask calls get policy enrichment. Plan generation is intentionally
 * left alone: there is no draft action to enforce yet, and the review pass will
 * resolve any user-stated gates before approval.
 */
export function shouldEnrichPolicyBundle(method: DeviceAgentMethod, payload: unknown): boolean {
  if (method !== 'reviewPlan' && method !== 'ask') return false;
  if (!payload || typeof payload !== 'object') return true;
  const ctx = (payload as { context?: unknown }).context;
  if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) {
    if ((ctx as { policyBundle?: unknown }).policyBundle) return false;
  }
  return true;
}

/**
 * Extract the fields the enrich endpoint cares about from the device-agent
 * payload. Different methods carry the user text in different shapes
 * (reviewPlan: `instruction`, ask: `question`).
 */
export function extractPolicyEnrichPayload(
  method: DeviceAgentMethod,
  payload: unknown,
): Record<string, unknown> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const plan = (p.plan && typeof p.plan === 'object' ? p.plan : {}) as Record<string, unknown>;
  const ctx = (p.context && typeof p.context === 'object' ? p.context : {}) as Record<string, unknown>;
  const instruction = method === 'ask'
    ? (typeof p.question === 'string' ? p.question : '') || (typeof p.instruction === 'string' ? p.instruction : '')
    : (typeof p.instruction === 'string' ? p.instruction : '');
  return {
    instruction,
    userNotes: typeof plan.userNotes === 'string' ? plan.userNotes : undefined,
    intent: typeof plan.intent === 'string' ? plan.intent : undefined,
    walletAddress: typeof p.walletAddress === 'string' ? p.walletAddress : undefined,
    draftParameters: plan.parameters && typeof plan.parameters === 'object' && !Array.isArray(plan.parameters)
      ? plan.parameters as Record<string, string>
      : undefined,
    transactionBase64: typeof ctx.transactionBase64 === 'string' ? ctx.transactionBase64 : undefined,
    simulationDigest: ctx.simulationDigest && typeof ctx.simulationDigest === 'object' && !Array.isArray(ctx.simulationDigest)
      ? ctx.simulationDigest as Record<string, unknown>
      : undefined,
    actionType: typeof plan.actionType === 'string' ? plan.actionType : undefined,
    knownTokenSymbols: Array.isArray(p.knownTokenSymbols)
      ? (p.knownTokenSymbols as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined,
  };
}
