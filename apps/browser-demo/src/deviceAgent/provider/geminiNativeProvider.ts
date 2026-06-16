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
//     `generationConfig.{responseMimeType,responseSchema,temperature,maxOutputTokens}`) is incompatible
//     with chat completions, so it lives in its own class.
//   - Gemini rejects JSON response config whenever any tool is attached, so the research pass
//     MUST drop responseMimeType/responseSchema. One condition prevents drift.
//   - Routing is by `config.provider === 'gemini'` at the dispatcher level
//     (deviceAgentProviderExecutor.ts), so OpenRouter/Custom stay on
//     OpenAiCompatibleProvider unchanged.
import { buildAskMessages, buildLocalizeMessages, buildPlanMessages, buildResearchMessages, buildReviewMessages } from '../prompts/messageAssembler.js';
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
import { researchTargetsForPayload } from './researchTargets.js';
import { extractGeminiCitations, extractGeminiText, parseModelJson } from './responseParser.js';
import { finalizeReviewResultForPayload } from './reviewPostprocess.js';
import type { DeviceAgentProvider } from './types.js';

const GEMINI_DEFAULT_NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_COMPAT_SUFFIX = /\/openai\/?$/i;
const VERSION_SEGMENT = /\/v\d+(beta)?(\/|$)/i;

const PLAN_TEMPERATURE = 0.2;
const REVIEW_TEMPERATURE = 0.2;
const ASK_TEMPERATURE = 0.3;
const PLAN_MAX_TOKENS = 1024;
const REVIEW_MAX_TOKENS = 1800;
const RESEARCH_MAX_TOKENS = 1800;
const ASK_MAX_TOKENS = 800;

const GEMINI_STRING_ARRAY_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
} as const;

const GEMINI_FINDING_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    value: { type: 'string' },
    tone: { type: 'string', enum: ['good', 'warn', 'neutral', 'fail'] },
  },
  required: ['label', 'value', 'tone'],
  propertyOrdering: ['label', 'value', 'tone'],
} as const;

const GEMINI_SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    url: { type: 'string' },
  },
  required: ['url'],
  propertyOrdering: ['title', 'url'],
} as const;

const GEMINI_PLAN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string' },
    route: { type: 'string' },
    risk: { type: 'string' },
    approval: { type: 'string' },
    safeguards: GEMINI_STRING_ARRAY_SCHEMA,
  },
  required: ['intent', 'route', 'risk', 'approval', 'safeguards'],
  propertyOrdering: ['intent', 'route', 'risk', 'approval', 'safeguards'],
} as const;

const GEMINI_REVIEW_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['approve', 'deny', 'needs_input'] },
    reason: { type: 'string' },
    summary: { type: 'string' },
    evidence: {
      type: 'object',
      properties: {
        findings: { type: 'array', items: GEMINI_FINDING_SCHEMA },
        sources: { type: 'array', items: GEMINI_SOURCE_SCHEMA },
        research: {
          type: 'object',
          properties: {
            status: { type: 'string' },
          },
        },
        policiesApplied: GEMINI_STRING_ARRAY_SCHEMA,
      },
      propertyOrdering: ['findings', 'sources', 'research', 'policiesApplied'],
    },
    questions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          prompt: { type: 'string' },
          inputKind: { type: 'string', enum: ['text', 'select', 'number'] },
          options: GEMINI_STRING_ARRAY_SCHEMA,
          required: { type: 'boolean' },
          hint: { type: 'string' },
        },
        required: ['id', 'prompt', 'inputKind'],
        propertyOrdering: ['id', 'prompt', 'inputKind', 'options', 'required', 'hint'],
      },
    },
    reviewers: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', enum: ['risk', 'quote', 'policy', 'protocol'] },
          decision: { type: 'string', enum: ['approve', 'deny', 'needs_input'] },
          reason: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['id', 'decision', 'reason'],
        propertyOrdering: ['id', 'decision', 'reason', 'summary'],
      },
    },
    evidenceFactIds: GEMINI_STRING_ARRAY_SCHEMA,
    blockingFactIds: GEMINI_STRING_ARRAY_SCHEMA,
    missingFactIds: GEMINI_STRING_ARRAY_SCHEMA,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['decision', 'reason', 'summary', 'evidence'],
  propertyOrdering: [
    'decision',
    'reason',
    'summary',
    'evidence',
    'questions',
    'reviewers',
    'evidenceFactIds',
    'blockingFactIds',
    'missingFactIds',
    'confidence',
  ],
} as const;

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
      responseSchema: GEMINI_PLAN_RESPONSE_SCHEMA,
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
        responseSchema: GEMINI_REVIEW_RESPONSE_SCHEMA,
        temperature: REVIEW_TEMPERATURE,
        maxOutputTokens: REVIEW_MAX_TOKENS,
        research: false,
      }, signal);
      return finalizeReviewResultForPayload(parseModelJson(extractGeminiText(response)), reviewPayload);
    }
    const messages = buildReviewMessages(payload);
    const response = await this.postGenerateContent(messages, {
      jsonObjectMode: true,
      responseSchema: GEMINI_REVIEW_RESPONSE_SCHEMA,
      temperature: REVIEW_TEMPERATURE,
      maxOutputTokens: REVIEW_MAX_TOKENS,
      research: false,
    }, signal);
    return finalizeReviewResultForPayload(parseModelJson(extractGeminiText(response)), payload);
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
      const messages = buildResearchMessages(payload, researchTargetsForPayload(payload));
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

  async localize(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const messages = buildLocalizeMessages(payload);
    const response = await this.postGenerateContent(messages, {
      jsonObjectMode: false,
      temperature: ASK_TEMPERATURE,
      maxOutputTokens: ASK_MAX_TOKENS,
      research: false,
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
      responseSchema?: Record<string, unknown>;
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
    // Gemini rejects JSON response config whenever any tool is attached, so the research
    // pass (which has `tools`) must omit it. Single condition prevents drift.
    if (options.jsonObjectMode && !options.research) {
      generationConfig.responseMimeType = 'application/json';
      if (options.responseSchema) {
        generationConfig.responseSchema = options.responseSchema;
      }
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
