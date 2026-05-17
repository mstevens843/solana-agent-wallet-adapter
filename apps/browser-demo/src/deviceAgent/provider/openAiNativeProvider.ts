// Native OpenAI Device Agent provider — hits the Responses API (/v1/responses) instead
// of chat completions. Adds two-pass web research with the `web_search_preview` tool,
// mirroring AnthropicProvider.runResearchPass so the Helium-style "check X. if < $20.
// approve." prompts resolve identically across providers.
//
// Why a separate class from OpenAiCompatibleProvider:
//   - Responses API uses `instructions` + `input` (not `messages`) and `max_output_tokens`
//     (not `max_tokens` or `max_completion_tokens`).
//   - Web search tool wiring is OpenAI-direct only; OpenRouter and Custom passthroughs
//     do not expose `web_search_preview` and must keep the fail-closed path.
//   - Routing is by `config.provider === 'openai'` at the dispatcher level
//     (deviceAgentProviderExecutor.ts), so OpenRouter/Custom stay on
//     OpenAiCompatibleProvider unchanged.
//
// Kotlin parity for this class is a followup ticket — the Android Device Agent still
// hits chat completions via OpenAiCompatibleProvider.kt. The TS chat-completions wire
// shape that Kotlin owns is unchanged; this is a new path on top.

import { buildAskMessages, buildPlanMessages, buildResearchMessages, buildReviewMessages } from '../prompts/messageAssembler.js';
import type { DeviceAgentMessages } from '../prompts/messageAssembler.js';
import type { RuntimeConfig } from '../runtime/config.js';

import { PROVIDER_ERROR_CODES, ProviderHttpError } from './errorCodes.js';
import type { HttpExecutor } from './http.js';
import {
  assertApiKeyHeaderSafe,
  composeErrorMessage,
  isReasoningModel,
  mapHttpStatusToErrorCode,
  normalizeBaseUrl,
} from './providerHttp.js';
import { extractResponsesApiCitations, extractResponsesApiText, parseModelJson } from './responseParser.js';
import type { DeviceAgentProvider } from './types.js';

const PLAN_TEMPERATURE = 0.2;
const REVIEW_TEMPERATURE = 0.2;
const ASK_TEMPERATURE = 0.3;
const PLAN_MAX_TOKENS = 1024;
const REVIEW_MAX_TOKENS = 1024;
const RESEARCH_MAX_TOKENS = 1800;
const ASK_MAX_TOKENS = 800;
const OPENAI_REASONING_EFFORT = 'low' as const;

export class OpenAiNativeProvider implements DeviceAgentProvider {
  private readonly config: RuntimeConfig;
  private readonly http: HttpExecutor;

  constructor(config: RuntimeConfig, http: HttpExecutor) {
    this.config = config;
    this.http = http;
  }

  async generatePlan(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const messages = buildPlanMessages(payload);
    const response = await this.postResponses(messages, {
      jsonObjectMode: true,
      temperature: PLAN_TEMPERATURE,
      maxOutputTokens: PLAN_MAX_TOKENS,
      research: false,
    }, signal);
    return parseModelJson(extractResponsesApiText(response));
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
      const response = await this.postResponses(messages, {
        jsonObjectMode: true,
        temperature: REVIEW_TEMPERATURE,
        maxOutputTokens: REVIEW_MAX_TOKENS,
        research: false,
      }, signal);
      return parseModelJson(extractResponsesApiText(response));
    }
    const messages = buildReviewMessages(payload);
    const response = await this.postResponses(messages, {
      jsonObjectMode: true,
      temperature: REVIEW_TEMPERATURE,
      maxOutputTokens: REVIEW_MAX_TOKENS,
      research: false,
    }, signal);
    return parseModelJson(extractResponsesApiText(response));
  }

  /**
   * Research pass mirroring AnthropicProvider.runResearchPass. Runs a Responses API call
   * with `web_search_preview` bound, captures the model's research summary + citations,
   * and returns the original payload with `context.researchEvidence` populated for the
   * second (structured) pass to consume. Failures are non-fatal — the original payload
   * is returned unchanged so the review still runs single-pass.
   */
  private async runResearchPass(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    try {
      const messages = buildResearchMessages(payload);
      const response = await this.postResponses(messages, {
        jsonObjectMode: false,
        temperature: REVIEW_TEMPERATURE,
        maxOutputTokens: RESEARCH_MAX_TOKENS,
        research: true,
      }, signal);
      const summary = extractResponsesApiText(response).trim();
      const citations = extractResponsesApiCitations(response);
      if (!summary && citations.length === 0) return payload;
      const researchEvidence = {
        status: 'checked' as const,
        required: true,
        provider: 'OpenAI',
        checkedAt: new Date().toISOString(),
        summary: summary || 'Research ran but produced no summary text.',
        sources: citations.map((c) => ({ url: c.url, ...(c.title ? { title: c.title } : {}) })),
        sourcePolicy:
          'Prefer official sources for prices and product facts. When a vendor publishes a plan page, use it as primary. Cite each fact with a URL.',
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
    const response = await this.postResponses(messages, {
      jsonObjectMode: false,
      temperature: ASK_TEMPERATURE,
      maxOutputTokens: ASK_MAX_TOKENS,
      research,
    }, signal);
    const text = extractResponsesApiText(response);
    if (text.trim().length === 0) {
      throw new ProviderHttpError(
        PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        'Provider response had no answer text.',
      );
    }
    return { output_text: text };
  }

  private async postResponses(
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

    const baseUrl = normalizeBaseUrl(this.config.baseUrl, 'openai-compatible');
    const url = `${baseUrl}/responses`;

    const model = this.config.model.trim();
    const reasoning = isReasoningModel(model);

    const body: Record<string, unknown> = {
      model,
      instructions: messages.system,
      input: messages.userContent,
      max_output_tokens: options.maxOutputTokens,
      store: false,
    };
    if (options.jsonObjectMode) {
      body.text = { format: { type: 'json_object' } };
    }
    if (!reasoning) {
      // Reasoning models reject explicit `temperature`; only set it for non-reasoning models.
      body.temperature = options.temperature;
    } else {
      body.reasoning = { effort: OPENAI_REASONING_EFFORT };
    }
    if (options.research) {
      body.tools = [openAiWebSearchTool()];
      body.tool_choice = 'auto';
      body.include = ['web_search_call.action.sources'];
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
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
  return Boolean(
    research && typeof research === 'object' && !Array.isArray(research)
      && (research as Record<string, unknown>).needed === true,
  );
}

function openAiWebSearchTool(): Record<string, unknown> {
  return {
    type: 'web_search_preview',
    user_location: {
      type: 'approximate',
      country: 'US',
      timezone: 'America/Los_Angeles',
    },
  };
}
