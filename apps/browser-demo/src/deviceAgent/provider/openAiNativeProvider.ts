// Native OpenAI Device Agent provider — hits the Responses API (/v1/responses) instead
// of chat completions. Adds two-pass web research with the `web_search_preview` tool,
// mirroring AnthropicProvider.runResearchPass so the Helium-style "check X. if < $20.
// approve." prompts resolve identically across providers.
//
// Why a separate class from OpenAiCompatibleProvider:
//   - Responses API uses `instructions` + `input` (not `messages`) and `max_output_tokens`
//     (not `max_tokens` or `max_completion_tokens`).
//   - Structured output uses `text.format.type = 'json_schema'` (NOT `json_object`, which
//     requires the literal word "json" in the input field and 400s on our JSON-stringified
//     userContent). Mirrors the server's pattern at packages/mcp-server/src/aiPlanner.ts.
//   - Web search tool wiring is OpenAI-direct only; OpenRouter and Custom passthroughs
//     do not expose `web_search_preview` and must keep the fail-closed path.
//   - Routing is by `config.provider === 'openai'` at the dispatcher level
//     (deviceAgentProviderExecutor.ts), so OpenRouter/Custom stay on
//     OpenAiCompatibleProvider unchanged.
//
// Citation filter: the research pass uses filterLowAuthorityCitations to drop blog/news
// subdomain citations for pricing questions. OpenAI's web_search backend tends to surface
// blog posts (e.g. blog.heliummobile.com) describing discontinued plans; filtering at the
// citation layer forces the review to either rely on official sources or fall through to
// needs_input rather than fabricate a stale answer.
//
// Kotlin parity for this class is a followup ticket — the Android Device Agent still hits
// chat completions via OpenAiCompatibleProvider.kt. The TS chat-completions wire shape
// that Kotlin owns is unchanged; this is a new path on top.

import { buildAskMessages, buildPlanMessages, buildResearchMessages, buildReviewMessages } from '../prompts/messageAssembler.js';
import type { DeviceAgentMessages } from '../prompts/messageAssembler.js';
import type { RuntimeConfig } from '../runtime/config.js';

import { filterLowAuthorityCitations, isPricingInstruction } from './citationFilter.js';
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
const OPENAI_TEXT_VERBOSITY = 'low' as const;

// Schemas mirror packages/mcp-server/src/aiPlanner.ts:147-209. Kept inline here so the
// device agent is self-contained — the server can't import from apps/browser-demo, and
// the device agent shouldn't depend on the mcp-server package at build time. Keep the
// two definitions in sync when widening.
const PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string' },
    route: { type: 'string' },
    risk: { type: 'string' },
    approval: { type: 'string' },
    safeguards: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['intent', 'route', 'risk', 'approval', 'safeguards'],
} as const;

const REVIEW_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['approve', 'deny', 'needs_input'] },
    reason: { type: 'string' },
    summary: { type: 'string' },
    evidence: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    questions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          prompt: { type: 'string' },
          inputKind: { type: 'string', enum: ['text', 'select', 'number'] },
          options: { type: 'array', items: { type: 'string' } },
          required: { type: 'boolean' },
          hint: { type: 'string' },
        },
        required: ['id', 'prompt', 'inputKind'],
      },
    },
    reviewers: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', enum: ['risk', 'quote', 'policy', 'protocol'] },
          decision: { type: 'string', enum: ['approve', 'deny', 'needs_input'] },
          reason: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['id', 'decision', 'reason'],
      },
    },
  },
  required: ['decision', 'reason', 'summary', 'evidence'],
} as const;

interface ResponseSchema {
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
}

const PLAN_SCHEMA: ResponseSchema = {
  name: 'agentic_device_plan',
  strict: true,
  schema: PLAN_JSON_SCHEMA as unknown as Record<string, unknown>,
};

// evidence is intentionally open-shaped (device agent surfaces findings, sources,
// research, policiesApplied), so strict:false. Matches aiPlanner.ts:746-747.
const REVIEW_SCHEMA: ResponseSchema = {
  name: 'agentic_device_review',
  strict: false,
  schema: REVIEW_JSON_SCHEMA as unknown as Record<string, unknown>,
};

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
      responseSchema: PLAN_SCHEMA,
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
        responseSchema: REVIEW_SCHEMA,
        temperature: REVIEW_TEMPERATURE,
        maxOutputTokens: REVIEW_MAX_TOKENS,
        research: false,
      }, signal);
      return parseModelJson(extractResponsesApiText(response));
    }
    const messages = buildReviewMessages(payload);
    const response = await this.postResponses(messages, {
      responseSchema: REVIEW_SCHEMA,
      temperature: REVIEW_TEMPERATURE,
      maxOutputTokens: REVIEW_MAX_TOKENS,
      research: false,
    }, signal);
    return parseModelJson(extractResponsesApiText(response));
  }

  /**
   * Research pass mirroring AnthropicProvider.runResearchPass. Runs a Responses API call
   * with `web_search_preview` bound, captures the model's research summary + citations,
   * filters blog/news subdomain citations for pricing questions, and returns the original
   * payload with `context.researchEvidence` populated for the second (structured) pass.
   * Failures are non-fatal — the original payload is returned unchanged so the review
   * still runs single-pass.
   */
  private async runResearchPass(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    try {
      const messages = buildResearchMessages(payload);
      const response = await this.postResponses(messages, {
        // Research pass: no schema (free-text grounded output). Schemas would also
        // collide with the web_search tool on some Responses API model versions.
        temperature: REVIEW_TEMPERATURE,
        maxOutputTokens: RESEARCH_MAX_TOKENS,
        research: true,
      }, signal);
      const rawSummary = extractResponsesApiText(response).trim();
      const rawCitations = extractResponsesApiCitations(response);
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
        provider: 'OpenAI',
        checkedAt: new Date().toISOString(),
        summary,
        sources: filteredCitations.map((c) => ({ url: c.url, ...(c.title ? { title: c.title } : {}) })),
        sourcePolicy:
          'Prefer official vendor pricing pages over blogs. Reject blog subdomains (blog.*, news.*) as primary sources for current prices. Cite each fact with the official URL.',
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
      // ask: no schema (plain-text answer)
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
      responseSchema?: ResponseSchema;
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
    if (options.responseSchema) {
      // json_schema (NOT json_object): json_object requires the literal word "json" in
      // the input field, which our JSON-stringified userContent does not contain. The
      // server's hosted-BYOK path (aiPlanner.ts:741-750) uses this same shape.
      body.text = {
        verbosity: OPENAI_TEXT_VERBOSITY,
        format: {
          type: 'json_schema',
          name: options.responseSchema.name,
          strict: options.responseSchema.strict,
          schema: options.responseSchema.schema,
        },
      };
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

function extractInstructionText(payload: Record<string, unknown>): string {
  const direct = typeof payload.instruction === 'string' ? payload.instruction : '';
  if (direct.length > 0) return direct;
  const userPrompt = typeof payload.userPrompt === 'string' ? payload.userPrompt : '';
  if (userPrompt.length > 0) return userPrompt;
  const question = typeof payload.question === 'string' ? payload.question : '';
  return question;
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
