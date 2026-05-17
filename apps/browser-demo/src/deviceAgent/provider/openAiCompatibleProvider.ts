// TypeScript port of OpenAiCompatibleProvider.kt. Same temperatures, same
// max_tokens, same json_object mode for plan/review (off for ask), and the
// gpt-5 / o-series temperature drop. Wire body field order kept compatible
// with the Kotlin runtime.

import { buildAskMessages, buildPlanMessages, buildReviewMessages } from '../prompts/messageAssembler.js';
import type { DeviceAgentMessages } from '../prompts/messageAssembler.js';
import type { RuntimeConfig } from '../runtime/config.js';

import { PROVIDER_ERROR_CODES, ProviderHttpError } from './errorCodes.js';
import type { HttpExecutor } from './http.js';
import {
  assertApiKeyHeaderSafe,
  composeErrorMessage,
  isDefaultTemperatureOnlyModel,
  mapHttpStatusToErrorCode,
  normalizeBaseUrl,
  tokenLimitKey,
} from './providerHttp.js';
import { extractOpenAiText, parseModelJson } from './responseParser.js';
import type { DeviceAgentProvider } from './types.js';

const PLAN_TEMPERATURE = 0.2;
const REVIEW_TEMPERATURE = 0.2;
const ASK_TEMPERATURE = 0.3;
const PLAN_MAX_TOKENS = 1024;
const REVIEW_MAX_TOKENS = 1024;
const ASK_MAX_TOKENS = 800;

// OpenRouter requires these per
// https://openrouter.ai/docs/api-reference/overview#headers — without them
// requests are aggressively rate-limited and excluded from analytics. We only
// send them for the openrouter provider so other gateways don't see our origin.
const OPENROUTER_FALLBACK_REFERER = 'https://browser-device-agent.local';
const OPENROUTER_X_TITLE = 'Agentic Browser Device Agent';

function browserOriginForOpenRouter(): string {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  const origin = loc?.origin?.trim();
  return origin && origin.length > 0 ? origin : OPENROUTER_FALLBACK_REFERER;
}

export class OpenAiCompatibleProvider implements DeviceAgentProvider {
  private readonly config: RuntimeConfig;
  private readonly http: HttpExecutor;

  constructor(config: RuntimeConfig, http: HttpExecutor) {
    this.config = config;
    this.http = http;
  }

  async generatePlan(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const messages = buildPlanMessages(payload);
    const response = await this.postChatCompletion(messages, true, PLAN_TEMPERATURE, PLAN_MAX_TOKENS, signal);
    return parseModelJson(extractOpenAiText(response));
  }

  async reviewPlan(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (researchNeeded(payload)) {
      return currentResearchUnavailableReview();
    }
    const messages = buildReviewMessages(payload);
    const response = await this.postChatCompletion(messages, true, REVIEW_TEMPERATURE, REVIEW_MAX_TOKENS, signal);
    return parseModelJson(extractOpenAiText(response));
  }

  async ask(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (researchNeeded(payload)) {
      return {
        output_text: 'Device Agent OpenAI-compatible mode cannot fetch current outside facts yet. Use Anthropic Device Agent or Local Bridge, or provide a source-backed current value.',
      };
    }
    const messages = buildAskMessages(payload);
    const response = await this.postChatCompletion(messages, false, ASK_TEMPERATURE, ASK_MAX_TOKENS, signal);
    const text = extractOpenAiText(response);
    if (text.trim().length === 0) {
      throw new ProviderHttpError(
        PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        'Provider response had no answer text.',
      );
    }
    return { output_text: text };
  }

  private async postChatCompletion(
    messages: DeviceAgentMessages,
    jsonObjectMode: boolean,
    temperature: number,
    maxTokens: number,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const apiKey = (this.config.apiKey ?? '').trim();
    assertApiKeyHeaderSafe(apiKey);

    const baseUrl = normalizeBaseUrl(this.config.baseUrl, 'openai-compatible');
    const url = `${baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.config.model.trim(),
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.userContent },
      ],
      [tokenLimitKey(this.config.model)]: maxTokens,
    };
    if (jsonObjectMode) {
      body.response_format = { type: 'json_object' };
    }
    if (!isDefaultTemperatureOnlyModel(this.config.model)) {
      body.temperature = temperature;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };
    if (this.config.provider === 'openrouter') {
      headers['HTTP-Referer'] = browserOriginForOpenRouter();
      headers['X-Title'] = OPENROUTER_X_TITLE;
    }

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

function currentResearchUnavailableReview(): Record<string, unknown> {
  const reason = 'Device Agent OpenAI-compatible mode cannot fetch current outside facts yet. Use Anthropic Device Agent or Local Bridge, or provide a source-backed current value.';
  return {
    decision: 'needs_input',
    reason,
    summary: 'Current outside facts are required before the Device Agent can decide.',
    evidence: {
      research: { status: 'unavailable', provider: 'openai-compatible', required: true },
      findings: [
        {
          label: 'Research needed',
          value: reason,
          tone: 'warn',
        },
      ],
    },
    questions: [
      {
        id: 'device_agent_current_fact',
        prompt: 'What source-backed current value should be checked?',
        inputKind: 'text',
        required: true,
      },
    ],
    evidenceFactIds: [],
    blockingFactIds: [],
    missingFactIds: [],
    confidence: 'low',
  };
}
