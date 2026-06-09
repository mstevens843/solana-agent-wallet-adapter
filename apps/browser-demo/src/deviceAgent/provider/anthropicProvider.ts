// TypeScript port of AnthropicProvider.kt with one deliberate divergence:
// the `anthropic-dangerous-direct-browser-access: 'true'` header. Browsers
// without this header are blocked by Anthropic's CORS policy; Android's
// HttpURLConnection has no CORS, so the Kotlin runtime omits it (and its
// AnthropicProviderTest pins the absence). Mirrors the planner.ts pattern.

import { buildAskMessages, buildPlanMessages, buildResearchMessages, buildReviewMessages } from '../prompts/messageAssembler.js';
import type { DeviceAgentMessages } from '../prompts/messageAssembler.js';
import type { RuntimeConfig } from '../runtime/config.js';

import { filterLowAuthorityCitations, isPricingInstruction } from './citationFilter.js';
import { PROVIDER_ERROR_CODES, ProviderHttpError } from './errorCodes.js';
import type { HttpExecutor } from './http.js';
import { openRouterAttributionHeaders } from './openRouterHeaders.js';
import {
  assertApiKeyHeaderSafe,
  composeErrorMessage,
  mapHttpStatusToErrorCode,
  normalizeBaseUrl,
} from './providerHttp.js';
import { researchTargetsForPayload } from './researchTargets.js';
import { extractAnthropicCitations, extractAnthropicText, parseModelJson } from './responseParser.js';
import { finalizeReviewResultForPayload } from './reviewPostprocess.js';
import type { DeviceAgentProvider } from './types.js';

const ANTHROPIC_VERSION = '2023-06-01';
const PLAN_TEMPERATURE = 0.2;
const REVIEW_TEMPERATURE = 0.2;
const ASK_TEMPERATURE = 0.3;
const PLAN_MAX_TOKENS = 1024;
const REVIEW_MAX_TOKENS = 1800;
const ASK_MAX_TOKENS = 800;

export class AnthropicProvider implements DeviceAgentProvider {
  private readonly config: RuntimeConfig;
  private readonly http: HttpExecutor;

  constructor(config: RuntimeConfig, http: HttpExecutor) {
    this.config = config;
    this.http = http;
  }

  async generatePlan(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const messages = buildPlanMessages(payload);
    const response = await this.postMessages(messages, PLAN_MAX_TOKENS, PLAN_TEMPERATURE, signal, payload);
    return parseModelJson(extractAnthropicText(response));
  }

  async reviewPlan(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    // Two-pass flow for parity with the local-bridge planner: when the review needs
    // outside facts, run a research-only call (web_search bound, no JSON requirement)
    // first, then a structured-output call with the research summary embedded in context.
    // This avoids the model juggling "search the web" + "return JSON" at the same time,
    // which was the failure mode on the Helium NOTE (Device Agent single-pass returned
    // $20 — a matching plan — while local-bridge two-pass returned $15, the cheapest).
    if (researchNeeded(payload)) {
      const enrichedPayload = await this.runResearchPass(payload, signal);
      // Second pass: structured review, NO web_search bound (research is done).
      // Mark research.needed=false so postMessages doesn't re-attach the tool.
      const reviewPayload: Record<string, unknown> = {
        ...enrichedPayload,
        research: {
          ...((enrichedPayload.research as Record<string, unknown> | undefined) ?? {}),
          needed: false,
          mode: 'provided_current_facts',
          providedEvidence: true,
        },
      };
      const messages = buildReviewMessages(reviewPayload);
      const response = await this.postMessages(messages, REVIEW_MAX_TOKENS, REVIEW_TEMPERATURE, signal, reviewPayload);
      return finalizeReviewResultForPayload(parseModelJson(extractAnthropicText(response)), reviewPayload);
    }
    const messages = buildReviewMessages(payload);
    const response = await this.postMessages(messages, REVIEW_MAX_TOKENS, REVIEW_TEMPERATURE, signal, payload);
    return finalizeReviewResultForPayload(parseModelJson(extractAnthropicText(response)), payload);
  }

  /**
   * Research pass — separate LLM call with web search bound. Captures the model's research
   * summary + citations and returns the original payload with `context.researchEvidence`
   * populated, ready for the structured review pass to consume.
   *
   * Failures here are non-fatal: if the research pass errors, we return the original payload
   * unchanged and let the review pass do its own (single-pass) thing as before.
   */
  private async runResearchPass(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    try {
      const messages = buildResearchMessages(payload, researchTargetsForPayload(payload));
      // Force research.needed=true on the inner payload so postMessages attaches web_search.
      const innerPayload: Record<string, unknown> = { ...payload, research: { ...(payload.research as Record<string, unknown> | undefined), needed: true } };
      const response = await this.postMessages(messages, REVIEW_MAX_TOKENS, REVIEW_TEMPERATURE, signal, innerPayload);
      const rawSummary = extractAnthropicText(response).trim();
      const rawCitations = extractAnthropicCitations(response);
      const instruction = extractInstructionText(payload);
      const filteredCitations = filterLowAuthorityCitations(rawCitations, instruction);

      // A pricing question with no usable official citation is "unverified" — whether the
      // citations were filtered out as low-authority OR the provider returned none at all
      // (e.g. a model answering from training because its web-search tool silently never ran —
      // the root cause of the OpenRouter+Claude Helium "$0"). Never propagate an un-sourced
      // price: replace it with the could-not-verify summary so the structured review returns
      // needs_input instead of approving on a fabricated figure.
      const pricingQuestion = isPricingInstruction(instruction);
      const unverifiedPricing = pricingQuestion && filteredCitations.length === 0;
      const summary = unverifiedPricing
        ? 'Current pricing could not be verified against an official source. Ask the user to confirm the plan name and price.'
        : (rawSummary || 'Research ran but produced no summary text.');

      if (filteredCitations.length === 0 && !rawSummary) return payload;
      const researchEvidence = {
        status: 'checked' as const,
        required: true,
        provider: 'Anthropic',
        checkedAt: new Date().toISOString(),
        summary,
        sources: filteredCitations.map((c) => ({ url: c.url, ...(c.title ? { title: c.title } : {}) })),
        sourcePolicy: 'Prefer official sources for prices and product facts. When a vendor publishes a plan page, use it as primary. Reject blog subdomains (blog.*, news.*) as primary sources for current pricing. Cite each fact with the official URL.',
      };
      const prevContext = (payload.context && typeof payload.context === 'object' && !Array.isArray(payload.context))
        ? payload.context as Record<string, unknown>
        : {};
      return { ...payload, context: { ...prevContext, researchEvidence } };
    } catch {
      // Research pass failure must not block the review — return the payload unchanged.
      return payload;
    }
  }

  async ask(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const messages = buildAskMessages(payload);
    const response = await this.postMessages(messages, ASK_MAX_TOKENS, ASK_TEMPERATURE, signal, payload);
    const text = extractAnthropicText(response);
    if (text.trim().length === 0) {
      throw new ProviderHttpError(
        PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        'Provider response had no answer text.',
      );
    }
    return { output_text: text };
  }

  private async postMessages(
    messages: DeviceAgentMessages,
    maxTokens: number,
    temperature: number,
    signal: AbortSignal | undefined,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const apiKey = (this.config.apiKey ?? '').trim();
    assertApiKeyHeaderSafe(apiKey);

    const apiFormat = isOpenRouterConfig(this.config) ? 'openai-compatible' : 'anthropic';
    const baseUrl = normalizeBaseUrl(this.config.baseUrl, apiFormat);
    const url = `${baseUrl}/messages`;

    const body: Record<string, unknown> = {
      model: this.config.model.trim(),
      max_tokens: maxTokens,
      system: messages.system,
      messages: [{ role: 'user', content: messages.userContent }],
      temperature,
      // This provider always speaks the Anthropic Messages format (/messages), whether direct
      // or via OpenRouter's Anthropic-compat skin. OpenRouter's `openrouter:web_search` server
      // tool only works on its Chat Completions / Responses endpoints — NOT the Messages skin —
      // so binding it here meant the tool was silently dropped and Claude answered the research
      // prompt ungrounded (the Helium "$0" bug). Always bind Anthropic's NATIVE web_search tool;
      // OpenRouter's skin forwards native tool use to Anthropic 1P, which executes it.
      ...(researchNeeded(payload) ? { tools: [anthropicWebSearchTool(payload)] } : {}),
    };

    // Browser-direct (Device Agent) calls go through CORS. OpenRouter's documented browser
    // headers are HTTP-Referer + X-Title only; the undocumented `X-OpenRouter-Metadata` adds a
    // non-allowlisted entry to the CORS preflight that OpenRouter can reject (surfacing as a
    // bare "Failed to fetch"), so we omit it on this browser path — the same deliberate
    // browser-vs-native divergence as the `anthropic-dangerous-direct-browser-access` header
    // below. The Kotlin/Swift native runtimes (no CORS) keep sending it unchanged.
    const headers: Record<string, string> = isOpenRouterConfig(this.config)
      ? {
        Authorization: `Bearer ${apiKey}`,
        ...openRouterAttributionHeaders(true),
      }
      : {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      };

    const response = await this.http.postJson(url, headers, JSON.stringify(body), signal);
    const errorCode = mapHttpStatusToErrorCode(response.status);
    if (errorCode !== null) {
      throw new ProviderHttpError(errorCode, composeErrorMessage(response.status, response.body));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new ProviderHttpError(
        PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        'Provider response was not valid JSON.',
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ProviderHttpError(
        PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        'Provider response was not valid JSON.',
      );
    }
    return parsed as Record<string, unknown>;
  }
}

function researchNeeded(payload: Record<string, unknown>): boolean {
  const research = payload.research;
  return Boolean(research && typeof research === 'object' && !Array.isArray(research) && (research as Record<string, unknown>).needed === true);
}

function extractInstructionText(payload: Record<string, unknown>): string {
  const direct = typeof payload.instruction === 'string' ? payload.instruction : '';
  if (direct.length > 0) return direct;
  const userPrompt = typeof payload.userPrompt === 'string' ? payload.userPrompt : '';
  if (userPrompt.length > 0) return userPrompt;
  const question = typeof payload.question === 'string' ? payload.question : '';
  return question;
}

function researchMaxUses(payload: Record<string, unknown>): number {
  const research = payload.research;
  if (!research || typeof research !== 'object' || Array.isArray(research)) return 3;
  const value = (research as Record<string, unknown>).maxSearches;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(Math.floor(value), 5))
    : 3;
}

function isOpenRouterConfig(config: RuntimeConfig): boolean {
  return config.provider.trim().toLowerCase() === 'openrouter' || (config.baseUrl ?? '').includes('openrouter.ai');
}

function anthropicWebSearchTool(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: researchMaxUses(payload),
    user_location: {
      type: 'approximate',
      country: 'US',
      timezone: 'America/Los_Angeles',
    },
  };
}
