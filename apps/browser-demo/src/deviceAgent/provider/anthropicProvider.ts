// TypeScript port of AnthropicProvider.kt with one deliberate divergence:
// the `anthropic-dangerous-direct-browser-access: 'true'` header. Browsers
// without this header are blocked by Anthropic's CORS policy; Android's
// HttpURLConnection has no CORS, so the Kotlin runtime omits it (and its
// AnthropicProviderTest pins the absence). Mirrors the planner.ts pattern.

import { buildAskMessages, buildPlanMessages, buildReviewMessages } from '../prompts/messageAssembler.js';
import type { DeviceAgentMessages } from '../prompts/messageAssembler.js';
import type { RuntimeConfig } from '../runtime/config.js';

import { PROVIDER_ERROR_CODES, ProviderHttpError } from './errorCodes.js';
import type { HttpExecutor } from './http.js';
import {
  assertApiKeyHeaderSafe,
  composeErrorMessage,
  mapHttpStatusToErrorCode,
  normalizeBaseUrl,
} from './providerHttp.js';
import { extractAnthropicText, parseModelJson } from './responseParser.js';
import type { DeviceAgentProvider } from './types.js';

const ANTHROPIC_VERSION = '2023-06-01';
const PLAN_TEMPERATURE = 0.2;
const REVIEW_TEMPERATURE = 0.2;
const ASK_TEMPERATURE = 0.3;
const PLAN_MAX_TOKENS = 1024;
const REVIEW_MAX_TOKENS = 1024;
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
    const response = await this.postMessages(messages, PLAN_MAX_TOKENS, PLAN_TEMPERATURE, signal);
    return parseModelJson(extractAnthropicText(response));
  }

  async reviewPlan(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const messages = buildReviewMessages(payload);
    const response = await this.postMessages(messages, REVIEW_MAX_TOKENS, REVIEW_TEMPERATURE, signal);
    return parseModelJson(extractAnthropicText(response));
  }

  async ask(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const messages = buildAskMessages(payload);
    const response = await this.postMessages(messages, ASK_MAX_TOKENS, ASK_TEMPERATURE, signal);
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
  ): Promise<Record<string, unknown>> {
    const apiKey = (this.config.apiKey ?? '').trim();
    assertApiKeyHeaderSafe(apiKey);

    const baseUrl = normalizeBaseUrl(this.config.baseUrl, 'anthropic');
    const url = `${baseUrl}/messages`;

    const body: Record<string, unknown> = {
      model: this.config.model.trim(),
      max_tokens: maxTokens,
      system: messages.system,
      messages: [{ role: 'user', content: messages.userContent }],
      temperature,
    };

    const headers: Record<string, string> = {
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
