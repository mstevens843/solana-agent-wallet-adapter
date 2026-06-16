// TypeScript port of DeviceAgentMessageAssembler.kt. Mirrors Kotlin behavior:
// alias resolution (prompt → userPrompt, connectorContext → protocolConnectors),
// connector rule derivation, research-object handling, and exact field
// insertion order so JSON.stringify produces wire-compatible payloads.
//
// Intentional divergences from apps/browser-demo/src/planner.ts (the original
// JS source) — do NOT "fix" these back to the planner.ts shape; they exist so
// the browser-native Device Agent emits the same request body as the Android
// (Kotlin) runtime. Source-of-truth is the Kotlin port. See parent plan
// docs/plans/browser-device-agent-runtime-plan.md line 83 ("When in doubt,
// Kotlin wins").
//
//   1. research defaults to `false` / `'not_required'` when absent, but a
//      browser caller may pass a precomputed research object. The runtime keeps
//      that object so providers with native search can decide whether to attach
//      tools.
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

import {
  agentReviewLocalizationMessages,
  type AgentReviewLocalizationPayload,
} from '@solana-agent-wallet-adapter/workflow';

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
    research: researchObject(payload, now),
    requiredBoundary: boundary,
  };

  return {
    system: DEVICE_AGENT_SYSTEM_PROMPTS.REVIEW,
    userContent: JSON.stringify(userContent),
  };
}

/**
 * Build the message pair for the research pass — Device Agent parity with the local-bridge
 * two-pass flow. When the review needs current outside facts, the LLM gets a research-only
 * turn (with web search bound) before the structured review turn. This keeps the model from
 * juggling "search the web" + "return JSON" at the same time, which was the difference
 * between local-bridge ($15 → approve) and Device Agent single-pass ($20 → needs_input).
 */
export function buildResearchMessages(
  payload: Record<string, unknown>,
  researchTargets?: ReadonlyArray<Record<string, unknown>>,
  now?: NowFn,
): DeviceAgentMessages {
  const instructionRaw = trimmedString(payload.instruction);
  const instruction = instructionRaw === '' ? DEVICE_AGENT_BOUNDARIES.REVIEW_DEFAULT_INSTRUCTION : instructionRaw;
  const walletAddress = defaultIfEmpty(trimmedString(payload.walletAddress), 'not_connected');
  const cluster = defaultIfEmpty(trimmedString(payload.cluster), 'unknown');
  const hasTargets = Array.isArray(researchTargets) && researchTargets.length > 0;
  const sourcePolicy =
    'Prefer official vendor pricing pages over blogs and aggregators. When a vendor publishes a plan/pricing page, use it as the primary source. ' +
    'Pricing pages are the authoritative source for current prices, fees, and plan rates. ' +
    'Never cite a blog subdomain (blog.*, news.*, medium.com, substack.com, community.*) as the primary source for current pricing — if only blog citations are available, state that current pricing could not be verified against an official page. ' +
    'Cite each fact with the official URL, not a blog post.';
  const systemPrelude = hasTargets
    ? 'You research current outside facts for a Solana wallet approval review. Do not approve, deny, or ask the wallet to sign. The reviewer has already broken the NOTE into atomic fact requests — see context.researchTargets. Batch your searches: cover every researchTarget in as few queries as possible (ideally one). For each target, return a concise source-backed value (price, plan name, current state) plus a citation URL. Prefer official sources. '
    : 'You research current outside facts for a Solana wallet approval review. Do not approve, deny, or ask the wallet to sign. Search reliable current sources, prefer official sources, and return concise source-backed facts in plain English. Include current prices, thresholds, dates, plan names, ambiguity, and URLs when they are relevant. If multiple current options could change the approval outcome, list each option clearly. ';
  const userContent: Record<string, unknown> = {
    instruction,
    walletAddress,
    cluster,
    plan: payload.plan ?? {},
    context: { ...(payload.context as Record<string, unknown> | undefined), ...(hasTargets ? { researchTargets } : {}) },
    research: {
      needed: true,
      mode: hasTargets ? 'resolve_specific_atoms' : 'collect_current_facts_only',
      currentDate: (now ?? (() => new Date()))().toISOString(),
      maxSearches: RESEARCH_MAX_USES,
      sourcePolicy,
    },
    requiredBoundary: 'This research pass cannot approve, deny, sign, or submit. It only gathers facts for a later structured review.',
  };
  return {
    system: systemPrelude + sourcePolicy,
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
    research: researchObject(payload, now),
    requiredBoundary: boundary,
  };

  return {
    system: DEVICE_AGENT_SYSTEM_PROMPTS.ASK,
    userContent: JSON.stringify(userContent),
  };
}

// Review-result localization: translate display copy into the user's language. The system +
// user content come from the SHARED workflow builder so the device-agent runtime, the hosted
// MCP path, and (once mirrored) the native runtimes all use byte-identical translate prompts.
export function buildLocalizeMessages(payload: Record<string, unknown>): DeviceAgentMessages {
  const messages = agentReviewLocalizationMessages(payload as unknown as AgentReviewLocalizationPayload);
  return {
    system: messages[0]?.content ?? '',
    userContent: messages[1]?.content ?? JSON.stringify(payload),
  };
}

function pickProtocolConnectors(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.protocolConnectors)) return payload.protocolConnectors;
  if (Array.isArray(payload.connectorContext)) return payload.connectorContext;
  return [];
}

function researchObject(payload: Record<string, unknown>, now: NowFn | undefined): Record<string, unknown> {
  if (isRecord(payload.research)) return payload.research;
  const date = typeof now === 'function' ? now() : new Date();
  return {
    needed: false,
    mode: 'not_required',
    currentDate: date.toISOString(),
    maxSearches: RESEARCH_MAX_USES,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
