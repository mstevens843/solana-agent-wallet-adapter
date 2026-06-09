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
import { logDeviceAgentDiag } from '../runtime/diagnosticLog.js';

import { filterLowAuthorityCitations, isPricingInstruction } from './citationFilter.js';
import { PROVIDER_ERROR_CODES, ProviderHttpError } from './errorCodes.js';
import type { HttpExecutor } from './http.js';
import { openRouterAttributionHeaders } from './openRouterHeaders.js';
import {
  assertApiKeyHeaderSafe,
  composeErrorMessage,
  effectiveMaxOutputTokens,
  emptyModelTextMessage,
  isReasoningModel,
  mapHttpStatusToErrorCode,
  normalizeBaseUrl,
} from './providerHttp.js';
import { researchTargetsForPayload } from './researchTargets.js';
import { extractResponsesApiCitations, extractResponsesApiText, parseModelJson, responsesApiTruncated } from './responseParser.js';
import { finalizeReviewResultForPayload } from './reviewPostprocess.js';
import type { DeviceAgentProvider } from './types.js';

const PLAN_TEMPERATURE = 0.2;
const REVIEW_TEMPERATURE = 0.2;
const ASK_TEMPERATURE = 0.3;
const PLAN_MAX_TOKENS = 1024;
const REVIEW_MAX_TOKENS = 1800;
const RESEARCH_MAX_TOKENS = 1800;
const ASK_MAX_TOKENS = 800;
const OPENAI_REASONING_EFFORT = 'low' as const;
// Plan stays terse (cheap, snappy). Review bumps to 'medium' so the reconciler-promoted
// "why it passed/denied" prose has room to match Claude-style breadth (listing
// alternatives, naming the resolved fact) instead of one-liners. Cost delta per review
// call is negligible; UX delta on the audit log is meaningful. ask/research paths
// don't use text.format at all, so they don't need a verbosity setting.
type OpenAiVerbosity = 'low' | 'medium' | 'high';
const OPENAI_PLAN_VERBOSITY: OpenAiVerbosity = 'low';
const OPENAI_REVIEW_VERBOSITY: OpenAiVerbosity = 'medium';

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
    // Short label only — keeps the plan-card RISK box a clean "Low/Medium/High" (the strict
    // Responses schema hard-enforces this for gpt-5/o-series; the shared prompt covers other providers).
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
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
      additionalProperties: true,
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              tone: { type: 'string', enum: ['good', 'warn', 'neutral', 'fail'] },
            },
            required: ['label', 'value', 'tone'],
          },
        },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              title: { type: 'string' },
              url: { type: 'string' },
            },
            required: ['url'],
          },
        },
        research: {
          type: 'object',
          additionalProperties: true,
          properties: {
            status: { type: 'string' },
          },
        },
        policiesApplied: {
          type: 'array',
          items: { type: 'string' },
        },
      },
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
    evidenceFactIds: {
      type: 'array',
      items: { type: 'string' },
    },
    blockingFactIds: {
      type: 'array',
      items: { type: 'string' },
    },
    missingFactIds: {
      type: 'array',
      items: { type: 'string' },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['decision', 'reason', 'summary', 'evidence'],
} as const;

interface ResponseSchema {
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
  verbosity: OpenAiVerbosity;
}

const PLAN_SCHEMA: ResponseSchema = {
  name: 'agentic_device_plan',
  strict: true,
  schema: PLAN_JSON_SCHEMA as unknown as Record<string, unknown>,
  verbosity: OPENAI_PLAN_VERBOSITY,
};

// evidence is intentionally open-shaped (device agent surfaces findings, sources,
// research, policiesApplied), so strict:false. Matches aiPlanner.ts:746-747.
const REVIEW_SCHEMA: ResponseSchema = {
  name: 'agentic_device_review',
  strict: false,
  schema: REVIEW_JSON_SCHEMA as unknown as Record<string, unknown>,
  verbosity: OPENAI_REVIEW_VERBOSITY,
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
    return this.parseJsonResult(response);
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
      return finalizeReviewResultForPayload(this.parseJsonResult(response), reviewPayload);
    }
    const messages = buildReviewMessages(payload);
    const response = await this.postResponses(messages, {
      responseSchema: REVIEW_SCHEMA,
      temperature: REVIEW_TEMPERATURE,
      maxOutputTokens: REVIEW_MAX_TOKENS,
      research: false,
    }, signal);
    return finalizeReviewResultForPayload(this.parseJsonResult(response), payload);
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
      const messages = buildResearchMessages(payload, researchTargetsForPayload(payload));
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

      // A pricing question with no usable official citation is "unverified" — whether the
      // citations were filtered out as low-authority OR the provider returned none at all
      // (e.g. a model answering from training because its web-search tool silently never ran).
      // Never propagate an un-sourced price: replace it with the could-not-verify summary so the
      // structured review returns needs_input instead of approving on a fabricated figure.
      const pricingQuestion = isPricingInstruction(instruction);
      const unverifiedPricing = pricingQuestion && filteredCitations.length === 0;
      const summary = unverifiedPricing
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
        responsesApiTruncated(response)
          ? emptyModelTextMessage(this.config.model, true)
          : 'Provider response had no answer text.',
      );
    }
    return { output_text: text };
  }

  // Shared plan/review extraction. An empty Responses payload that was cut off by the
  // output-token ceiling (status:'incomplete') means a reasoning model spent its whole budget
  // before answering — surface that explicitly rather than the opaque empty-response error.
  private parseJsonResult(response: Record<string, unknown>): Record<string, unknown> {
    const text = extractResponsesApiText(response);
    if (text.trim().length === 0) {
      const truncated = responsesApiTruncated(response);
      logDeviceAgentDiag('warn', 'provider.empty', {
        format: 'responses',
        model: this.config.model,
        truncated,
        status: typeof response.status === 'string' ? response.status : undefined,
      });
      throw new ProviderHttpError(
        PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        emptyModelTextMessage(this.config.model, truncated),
      );
    }
    return parseModelJson(text);
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
      max_output_tokens: effectiveMaxOutputTokens(model, options.maxOutputTokens),
      store: false,
    };
    if (options.responseSchema) {
      // json_schema (NOT json_object): json_object requires the literal word "json" in
      // the input field, which our JSON-stringified userContent does not contain. The
      // server's hosted-BYOK path (aiPlanner.ts:741-750) uses this same shape.
      body.text = {
        verbosity: options.responseSchema.verbosity,
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
      body.tools = [webSearchToolForConfig(this.config)];
      body.tool_choice = 'auto';
      if (!isOpenRouterConfig(this.config)) {
        body.include = ['web_search_call.action.sources'];
      }
    }

    // Browser-direct (Device Agent) calls go through CORS. OpenRouter's documented browser
    // headers are HTTP-Referer + X-Title only (see openRouterHeaders.ts); the undocumented
    // `X-OpenRouter-Metadata` adds a non-allowlisted entry to the CORS preflight's
    // Access-Control-Request-Headers, which OpenRouter can reject — surfacing as the generic
    // "Failed to fetch". We deliberately omit it here (browser), the same way this provider's
    // Anthropic sibling adds `anthropic-dangerous-direct-browser-access` only in the browser.
    // The Kotlin/Swift native runtimes (no CORS) keep sending it unchanged.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      ...openRouterAttributionHeaders(isOpenRouterConfig(this.config)),
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

function isOpenRouterConfig(config: RuntimeConfig): boolean {
  return config.provider.trim().toLowerCase() === 'openrouter' || (config.baseUrl ?? '').includes('openrouter.ai');
}

function webSearchToolForConfig(config: RuntimeConfig): Record<string, unknown> {
  return isOpenRouterConfig(config) ? openRouterWebSearchTool() : openAiWebSearchTool();
}

function openRouterWebSearchTool(): Record<string, unknown> {
  return {
    type: 'openrouter:web_search',
    parameters: {
      engine: 'auto',
      max_total_results: 3,
      user_location: {
        type: 'approximate',
        country: 'US',
        timezone: 'America/Los_Angeles',
      },
    },
  };
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
