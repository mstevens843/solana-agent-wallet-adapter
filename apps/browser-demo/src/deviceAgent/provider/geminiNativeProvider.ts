// Native Gemini Device Agent provider — hits Google's :generateContent endpoint instead
// of the OpenAI-compatible passthrough. Adds two-pass web research with Google Search
// grounding (`tools: [{ google_search: {} }]`), mirroring AnthropicProvider.runResearchPass
// so external-fact prompts like "check helium mobile. lowest monthly plan. if < $20.
// approve." resolve identically across providers.
//
// Why a separate class from OpenAiCompatibleProvider:
//   - Gemini's /v1beta/openai compat endpoint does NOT support `tools: [{ google_search: {} }]`
//     — the grounding tool is only exposed on the native :generateContent endpoint.
//   - The native request shape (`systemInstruction`, `contents[].parts[]`,
//     `generationConfig.{responseMimeType, temperature, maxOutputTokens}`) is incompatible
//     with chat completions, so it lives in its own class.
//   - Gemini rejects `generationConfig.responseMimeType: 'application/json'` whenever any
//     tool is attached, so the research pass MUST drop responseMimeType. We drive both
//     `tools` attachment and `responseMimeType` removal off one condition to prevent drift.
//   - Routing is by `config.provider === 'gemini'` at the dispatcher level
//     (deviceAgentProviderExecutor.ts), so OpenRouter/Custom stay on
//     OpenAiCompatibleProvider unchanged.
//
// Kotlin parity for this class is a followup ticket — the Android Device Agent still hits
// the OpenAI-compat passthrough.

import { buildAskMessages, buildPlanMessages, buildResearchMessages, buildReviewMessages } from '../prompts/messageAssembler.js';
import type { DeviceAgentMessages } from '../prompts/messageAssembler.js';
import type { RuntimeConfig } from '../runtime/config.js';

import { filterLowAuthorityCitations, isPricingInstruction } from './citationFilter.js';
import { PROVIDER_ERROR_CODES, ProviderHttpError } from './errorCodes.js';
import type { HttpExecutor } from './http.js';
import {
  assertApiKeyHeaderSafe,
  composeErrorMessage,
  mapHttpStatusToErrorCode,
} from './providerHttp.js';
import { extractGeminiCitations, extractGeminiText, parseModelJson } from './responseParser.js';
import type { DeviceAgentProvider } from './types.js';

const GEMINI_DEFAULT_NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_COMPAT_SUFFIX = /\/openai\/?$/i;
const VERSION_SEGMENT = /\/v\d+(beta)?(\/|$)/i;

const PLAN_TEMPERATURE = 0.2;
const REVIEW_TEMPERATURE = 0.2;
const ASK_TEMPERATURE = 0.3;
const PLAN_MAX_TOKENS = 1024;
const REVIEW_MAX_TOKENS = 1024;
const RESEARCH_MAX_TOKENS = 1800;
const ASK_MAX_TOKENS = 800;

export class GeminiNativeProvider implements DeviceAgentProvider {
  private readonly config: RuntimeConfig;
  private readonly http: HttpExecutor;

  constructor(config: RuntimeConfig, http: HttpExecutor) {
    this.config = config;
    this.http = http;
  }

  async generatePlan(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const messages = buildPlanMessages(payload);
    const response = await this.postGenerateContent(messages, {
      jsonObjectMode: true,
      temperature: PLAN_TEMPERATURE,
      maxOutputTokens: PLAN_MAX_TOKENS,
      research: false,
    }, signal);
    return parseModelJson(extractGeminiText(response));
  }

  async reviewPlan(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (researchNeeded(payload)) {
      const enrichedPayload = await this.runResearchPass(payload, signal);
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
      const response = await this.postGenerateContent(messages, {
        jsonObjectMode: true,
        temperature: REVIEW_TEMPERATURE,
        maxOutputTokens: REVIEW_MAX_TOKENS,
        research: false,
      }, signal);
      return parseModelJson(extractGeminiText(response));
    }
    const messages = buildReviewMessages(payload);
    const response = await this.postGenerateContent(messages, {
      jsonObjectMode: true,
      temperature: REVIEW_TEMPERATURE,
      maxOutputTokens: REVIEW_MAX_TOKENS,
      research: false,
    }, signal);
    return parseModelJson(extractGeminiText(response));
  }

  /**
   * Research pass mirroring AnthropicProvider.runResearchPass. Runs a Gemini call with
   * `tools: [{ google_search: {} }]` (and no `responseMimeType` — Gemini rejects the
   * combination), captures the grounded text summary + `groundingMetadata.groundingChunks`
   * URLs, and returns the original payload with `context.researchEvidence` populated.
   * Failures are non-fatal — the original payload is returned unchanged.
   */
  private async runResearchPass(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    try {
      const messages = buildResearchMessages(payload);
      const response = await this.postGenerateContent(messages, {
        jsonObjectMode: false,
        temperature: REVIEW_TEMPERATURE,
        maxOutputTokens: RESEARCH_MAX_TOKENS,
        research: true,
      }, signal);
      const rawSummary = extractGeminiText(response).trim();
      const rawCitations = extractGeminiCitations(response);
      const instruction = extractInstructionText(payload);
      const filteredCitations = filterLowAuthorityCitations(rawCitations, instruction);

      // If filtering dropped every citation AND the question is a pricing question,
      // suppress the summary too — better to let the structured review fall through to
      // needs_input than surface a stale answer from a discarded blog post.
      const dropped = rawCitations.length > 0 && filteredCitations.length === 0;
      const pricingQuestion = isPricingInstruction(instruction);
      const summary = (dropped && pricingQuestion)
        ? 'Current pricing could not be verified against an official source. Ask the user to confirm the plan name and price.'
        : (rawSummary || 'Research ran but produced no summary text.');

      if (filteredCitations.length === 0 && !rawSummary) return payload;
      const researchEvidence = {
        status: 'checked' as const,
        required: true,
        provider: 'Gemini',
        checkedAt: new Date().toISOString(),
        summary,
        sources: filteredCitations.map((c) => ({ url: c.url, ...(c.title ? { title: c.title } : {}) })),
        sourcePolicy:
          'Prefer official sources for prices and product facts. When a vendor publishes a plan page, use it as primary. Reject blog subdomains (blog.*, news.*) as primary sources for current pricing. Cite each fact with the official URL.',
      };
      const prevContext = (payload.context && typeof payload.context === 'object' && !Array.isArray(payload.context))
        ? payload.context as Record<string, unknown>
        : {};
      return { ...payload, context: { ...prevContext, researchEvidence } };
    } catch {
      return payload;
    }
  }

  async ask(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const research = researchNeeded(payload);
    const messages = buildAskMessages(payload);
    const response = await this.postGenerateContent(messages, {
      jsonObjectMode: false,
      temperature: ASK_TEMPERATURE,
      maxOutputTokens: ASK_MAX_TOKENS,
      research,
    }, signal);
    const text = extractGeminiText(response);
    if (text.trim().length === 0) {
      throw new ProviderHttpError(
        PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        'Provider response had no answer text.',
      );
    }
    return { output_text: text };
  }

  private async postGenerateContent(
    messages: DeviceAgentMessages,
    options: {
      jsonObjectMode: boolean;
      temperature: number;
      maxOutputTokens: number;
      research: boolean;
    },
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const apiKey = (this.config.apiKey ?? '').trim();
    assertApiKeyHeaderSafe(apiKey);

    const model = this.config.model.trim();
    const baseUrl = normalizeNativeBaseUrl(this.config.baseUrl);
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

    const generationConfig: Record<string, unknown> = {
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
    };
    // Gemini rejects `responseMimeType: 'application/json'` whenever any tool is attached,
    // so the research pass (which has `tools`) must omit it. Single condition prevents drift.
    if (options.jsonObjectMode && !options.research) {
      generationConfig.responseMimeType = 'application/json';
    }

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: messages.system }] },
      contents: [{ role: 'user', parts: [{ text: messages.userContent }] }],
      generationConfig,
    };
    if (options.research) {
      body.tools = [{ google_search: {} }];
    }

    const headers: Record<string, string> = {
      'x-goog-api-key': apiKey,
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

/**
 * Map an OpenAI-compat Gemini baseUrl to the native :generateContent base.
 *
 * The browser-demo preset stores Gemini's baseUrl as
 * `https://generativelanguage.googleapis.com/v1beta/openai` (because the rest of the
 * stack speaks OpenAI-compat). The native endpoint lives at `/v1beta` — without the
 * `/openai` suffix. Strip it. Idempotent: already-native URLs pass through.
 */
function normalizeNativeBaseUrl(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/u, '');
  if (trimmed.length === 0) return GEMINI_DEFAULT_NATIVE_BASE_URL;
  const stripped = trimmed.replace(OPENAI_COMPAT_SUFFIX, '');
  if (VERSION_SEGMENT.test(stripped)) return stripped;
  return `${stripped}/v1beta`;
}

function researchNeeded(payload: Record<string, unknown>): boolean {
  const research = payload.research;
  return Boolean(
    research && typeof research === 'object' && !Array.isArray(research)
      && (research as Record<string, unknown>).needed === true,
  );
}

function extractInstructionText(payload: Record<string, unknown>): string {
  const direct = typeof payload.instruction === 'string' ? payload.instruction : '';
  if (direct.length > 0) return direct;
  const userPrompt = typeof payload.userPrompt === 'string' ? payload.userPrompt : '';
  if (userPrompt.length > 0) return userPrompt;
  const question = typeof payload.question === 'string' ? payload.question : '';
  return question;
}
