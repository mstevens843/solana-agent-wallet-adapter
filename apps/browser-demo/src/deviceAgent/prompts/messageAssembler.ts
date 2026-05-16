// TypeScript port of DeviceAgentMessageAssembler.kt. Mirrors Kotlin behavior:
// alias resolution (prompt → userPrompt, connectorContext → protocolConnectors),
// connector rule derivation, hardcoded research object, and exact field
// insertion order so JSON.stringify produces wire-compatible payloads.
//
// Intentional divergences from apps/browser-demo/src/planner.ts (the original
// JS source) — do NOT "fix" these back to the planner.ts shape; they exist so
// the browser-native Device Agent emits the same request body as the Android
// (Kotlin) runtime. Source-of-truth is the Kotlin port. See parent plan
// docs/plans/browser-device-agent-runtime-plan.md line 83 ("When in doubt,
// Kotlin wins").
//
//   1. research.needed/mode are hardcoded `false` / `'not_required'`.
//      planner.ts:1676-1714 toggles these dynamically via
//      reviewNeedsWebResearch(request). The Device Agent runtime does not
//      perform web research — it runs a single chat completion only — so the
//      simpler shape is correct.
//
//   2. `plan` defaults to `{}` when absent in the payload.
//      planner.ts:1674 passes `request.plan` raw; if it's undefined,
//      JSON.stringify omits the field. Kotlin's
//      `payload.opt("plan") ?: JSONObject()` always emits an empty object.
//      We mirror Kotlin so Android and browser produce byte-identical wire
//      bodies for the same input.
//
//   3. `walletAddress` / `cluster` are trimmed before the
//      `'not_connected'` / `'unknown'` fallback.
//      planner.ts:1672-1673 uses `||` without trim, so `'   '` would pass
//      through as truthy. Kotlin trims first via `.optString(...).trim()`.
//      We mirror Kotlin.
//
//   4. Connector `name` / `id` are trimmed inside deriveConnectorRule.
//      planner.ts:1627 uses `selectedConnector.name || selectedConnector.id
//      || 'selected connector'` without trim. Kotlin trims each candidate.
//      We mirror Kotlin.

import { DEVICE_AGENT_BOUNDARIES } from './boundaries.js';
import { DEVICE_AGENT_SYSTEM_PROMPTS } from './systemPrompts.js';

const RESEARCH_MAX_USES = 3;

const CONNECTOR_RULE_DEFAULT =
  'Only propose first-class or Blink executable actions for enabled connectors with matching capabilities. ' +
  'If a requested protocol/action is disabled, unsupported, or missing an action URL/client key, make the plan ' +
  'proof/read-only and state which connector fact, key, or action URL is missing.';

export interface DeviceAgentMessages {
  system: string;
  userContent: string;
}

export type NowFn = () => Date;

export function buildPlanMessages(payload: Record<string, unknown>): DeviceAgentMessages {
  const protocolConnectors = pickProtocolConnectors(payload);
  const providedRule = trimmedString(payload.connectorRule);
  const connectorRule = providedRule !== '' ? providedRule : deriveConnectorRule(protocolConnectors);
  const boundary = resolveBoundary(payload.requiredBoundary, DEVICE_AGENT_BOUNDARIES.PLAN);
  const userPrompt = payload.userPrompt ?? payload.prompt ?? '';

  const userContent: Record<string, unknown> = {
    userPrompt,
  };
  if (payload.userNotes !== undefined) {
    userContent.userNotes = payload.userNotes;
  }
  if (payload.template !== undefined) {
    userContent.template = payload.template;
  }
  if (payload.parameters !== undefined) {
    userContent.parameters = payload.parameters;
  }
  userContent.protocolConnectors = protocolConnectors;
  userContent.connectorRule = connectorRule;
  userContent.requiredBoundary = boundary;

  return {
    system: DEVICE_AGENT_SYSTEM_PROMPTS.PLAN,
    userContent: JSON.stringify(userContent),
  };
}

export function buildReviewMessages(
  payload: Record<string, unknown>,
  now?: NowFn,
): DeviceAgentMessages {
  const instructionRaw = trimmedString(payload.instruction);
  const instruction = instructionRaw === '' ? DEVICE_AGENT_BOUNDARIES.REVIEW_DEFAULT_INSTRUCTION : instructionRaw;
  const walletAddress = defaultIfEmpty(trimmedString(payload.walletAddress), 'not_connected');
  const cluster = defaultIfEmpty(trimmedString(payload.cluster), 'unknown');
  const boundary = resolveBoundary(payload.requiredBoundary, DEVICE_AGENT_BOUNDARIES.REVIEW);

  const userContent: Record<string, unknown> = {
    instruction,
    walletAddress,
    cluster,
    plan: payload.plan ?? {},
    context: payload.context ?? {},
    research: researchObject(now),
    requiredBoundary: boundary,
  };

  return {
    system: DEVICE_AGENT_SYSTEM_PROMPTS.REVIEW,
    userContent: JSON.stringify(userContent),
  };
}

export function buildAskMessages(
  payload: Record<string, unknown>,
  now?: NowFn,
): DeviceAgentMessages {
  const walletAddress = defaultIfEmpty(trimmedString(payload.walletAddress), 'not_connected');
  const cluster = defaultIfEmpty(trimmedString(payload.cluster), 'unknown');
  const boundary = resolveBoundary(payload.requiredBoundary, DEVICE_AGENT_BOUNDARIES.ASK);

  const userContent: Record<string, unknown> = {
    question: payload.question ?? '',
    plan: payload.plan ?? {},
    walletAddress,
    cluster,
    context: payload.context ?? {},
    research: researchObject(now),
    requiredBoundary: boundary,
  };

  return {
    system: DEVICE_AGENT_SYSTEM_PROMPTS.ASK,
    userContent: JSON.stringify(userContent),
  };
}

function pickProtocolConnectors(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.protocolConnectors)) return payload.protocolConnectors;
  if (Array.isArray(payload.connectorContext)) return payload.connectorContext;
  return [];
}

function researchObject(now: NowFn | undefined): Record<string, unknown> {
  const date = typeof now === 'function' ? now() : new Date();
  return {
    needed: false,
    mode: 'not_required',
    currentDate: date.toISOString(),
    maxSearches: RESEARCH_MAX_USES,
  };
}

function deriveConnectorRule(protocolConnectors: unknown[]): string {
  const selected = findSelectedConnector(protocolConnectors);
  if (!selected) return CONNECTOR_RULE_DEFAULT;
  const name =
    trimmedString(selected.name) ||
    trimmedString(selected.id) ||
    'selected connector';
  return [
    `Use the selected protocol connector only: ${name}.`,
    'Do not switch protocols.',
    'If required connector facts are missing, ask for missing facts instead of inventing execution.',
    'Do not claim the action is signed, submitted, approved, or safe.',
    'The wallet owner must approve separately.',
  ].join(' ');
}

function findSelectedConnector(arr: unknown[]): Record<string, unknown> | null {
  for (const item of arr) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj.selected === true || obj.selectedOnly === true) {
      return obj;
    }
  }
  return null;
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function defaultIfEmpty(value: string, fallback: string): string {
  return value === '' ? fallback : value;
}

function resolveBoundary(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.trim() === '' ? fallback : value;
}
