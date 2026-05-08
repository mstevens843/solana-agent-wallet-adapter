import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { redactSecrets } from './trace.js';

export type AiApiFormat = 'openai-compatible' | 'anthropic';

export interface AiPlanTemplateContext {
  id: string;
  category: string;
  title: string;
  description: string;
  actionType: string;
  risk: string;
}

export interface AiPlanRequest {
  prompt?: string;
  template?: AiPlanTemplateContext;
  parameters?: Record<string, string>;
  userNotes?: string;
}

export interface AiPlan {
  intent: string;
  route: string;
  risk: string;
  approval: string;
  source: 'ai';
  category: string;
  actionType: string;
  templateTitle: string;
  userNotes?: string;
  parameters: Record<string, string>;
  fields: Array<{ label: string; value: string }>;
  safeguards: string[];
}

interface AiRuntimeConfig {
  provider: string;
  apiFormat: AiApiFormat;
  baseUrl: string;
  model: string;
  apiKey: string;
  source: 'env' | 'session';
}

export interface AiStatus {
  available: boolean;
  configured: boolean;
  source: 'env' | 'session' | 'none';
  provider?: string;
  apiFormat?: AiApiFormat;
  baseUrl?: string;
  model?: string;
}

const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_AI_MODEL = 'gpt-5';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const OPENAI_REASONING_EFFORT = 'low';
const OPENAI_TEXT_VERBOSITY = 'low';
const OPENAI_MAX_OUTPUT_TOKENS = 4096;
const SHARED_SAFEGUARDS = [
  'Wallet approval is required before any signature or transaction leaves the device.',
  'The agent never receives the wallet private key or seed phrase.',
  'Amounts, recipients, routes, and policy notes must be visible before signing.',
];

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

export class BridgeAiPlanner {
  #sessionConfig: AiRuntimeConfig | null = null;

  status(): AiStatus {
    const config = this.config();
    if (!config) {
      return { available: false, configured: false, source: 'none' };
    }
    return {
      available: true,
      configured: true,
      source: config.source,
      provider: config.provider,
      apiFormat: config.apiFormat,
      baseUrl: stripKeyFromUrl(config.baseUrl),
      model: config.model,
    };
  }

  setSessionKey(input: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    provider?: string;
    apiFormat?: string;
    clear?: boolean;
  }): AiStatus {
    if (input.clear) {
      this.#sessionConfig = null;
      return this.status();
    }
    if (!input.apiKey?.trim()) {
      throw new ProtocolError('invalid_request', 'Missing AI API key.');
    }
    const provider = input.provider?.trim() || 'openai-compatible';
    const apiFormat = normalizeApiFormat(input.apiFormat, provider);
    this.#sessionConfig = {
      provider,
      apiFormat,
      baseUrl: normalizeBaseUrl(input.baseUrl || defaultBaseUrl(apiFormat), apiFormat),
      model: input.model?.trim() || defaultModel(apiFormat),
      apiKey: input.apiKey.trim(),
      source: 'session',
    };
    return this.status();
  }

  async generatePlan(request: AiPlanRequest): Promise<AiPlan> {
    const config = this.config();
    if (!config) {
      throw new ProtocolError('unsupported_method', 'Bridge AI is not configured. Set AGENTIC_AI_API_KEY or provide a bridge session key.');
    }
    const normalizedRequest = normalizeRequest(request);
    if (config.apiFormat === 'anthropic') {
      return this.generateAnthropicPlan(config, normalizedRequest);
    }
    if (shouldUseOpenAiResponses(config)) {
      return this.generateOpenAiResponsesPlan(config, normalizedRequest);
    }
    return this.generateOpenAiCompatiblePlan(config, normalizedRequest);
  }

  private async generateOpenAiResponsesPlan(
    config: AiRuntimeConfig,
    normalizedRequest: Required<AiPlanRequest>,
  ): Promise<AiPlan> {
    const messages = aiMessages(normalizedRequest);
    const systemMessage = messages[0]?.content ?? '';
    const userMessage = messages[1]?.content ?? JSON.stringify(normalizedRequest);
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl, 'openai-compatible')}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        instructions: systemMessage,
        input: userMessage,
        max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
        store: false,
        text: {
          verbosity: OPENAI_TEXT_VERBOSITY,
          format: {
            type: 'json_schema',
            name: 'agentic_ai_plan',
            strict: true,
            schema: PLAN_JSON_SCHEMA,
          },
        },
        ...(isReasoningModel(config.model) && {
          reasoning: { effort: OPENAI_REASONING_EFFORT },
        }),
      }),
    }).catch((err) => {
      throw new ProtocolError(
        'wallet_unreachable',
        `AI provider request failed. ${redactText(err instanceof Error ? err.message : String(err))}`,
      );
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) {
      throw new ProtocolError(
        'wallet_unreachable',
        providerFailureMessage(payload, response.status),
      );
    }
    assertCompleteOpenAiResponse(payload);
    return normalizeStrictAiPlan(payload, normalizedRequest, 'OpenAI');
  }

  private async generateOpenAiCompatiblePlan(
    config: AiRuntimeConfig,
    normalizedRequest: Required<AiPlanRequest>,
  ): Promise<AiPlan> {
    const body = {
      model: config.model,
      response_format: { type: 'json_object' },
      messages: aiMessages(normalizedRequest),
      ...(!isDefaultTemperatureOnlyModel(config.model) && { temperature: 0.2 }),
    };
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl, 'openai-compatible')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }).catch((err) => {
      throw new ProtocolError(
        'wallet_unreachable',
        `AI provider request failed. ${redactText(err instanceof Error ? err.message : String(err))}`,
      );
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) {
      throw new ProtocolError(
        'wallet_unreachable',
        providerFailureMessage(payload, response.status),
      );
    }
    return normalizeAiPlan(payload, normalizedRequest);
  }

  private async generateAnthropicPlan(
    config: AiRuntimeConfig,
    normalizedRequest: Required<AiPlanRequest>,
  ): Promise<AiPlan> {
    const messages = aiMessages(normalizedRequest);
    const systemMessage = messages[0]?.content ?? '';
    const userMessage = messages[1]?.content ?? JSON.stringify(normalizedRequest);
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl, 'anthropic')}/messages`, {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1024,
        system: systemMessage,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.2,
      }),
    }).catch((err) => {
      throw new ProtocolError(
        'wallet_unreachable',
        `AI provider request failed. ${redactText(err instanceof Error ? err.message : String(err))}`,
      );
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) {
      throw new ProtocolError(
        'wallet_unreachable',
        providerFailureMessage(payload, response.status),
      );
    }
    return normalizeAiPlan(payload, normalizedRequest);
  }

  private config(): AiRuntimeConfig | null {
    return this.#sessionConfig ?? envConfig();
  }
}

function envConfig(): AiRuntimeConfig | null {
  const apiKey = process.env.AGENTIC_AI_API_KEY?.trim();
  if (!apiKey) return null;
  const provider = process.env.AGENTIC_AI_PROVIDER?.trim() || 'openai-compatible';
  const apiFormat = normalizeApiFormat(process.env.AGENTIC_AI_API_FORMAT, provider);
  return {
    provider,
    apiFormat,
    baseUrl: normalizeBaseUrl(process.env.AGENTIC_AI_BASE_URL || defaultBaseUrl(apiFormat), apiFormat),
    model: process.env.AGENTIC_AI_MODEL?.trim() || defaultModel(apiFormat),
    apiKey,
    source: 'env',
  };
}

function normalizeRequest(request: AiPlanRequest): Required<AiPlanRequest> {
  const template = request.template ?? {
    id: 'custom-request',
    category: 'custom',
    title: 'Custom request',
    description: 'Turn a user request into a wallet approval plan.',
    actionType: 'manual_review',
    risk: 'medium',
  };
  return {
    prompt: request.prompt?.trim() || template.description,
    template,
    parameters: request.parameters ?? {},
    userNotes: request.userNotes?.trim() || request.prompt?.trim() || template.description,
  };
}

function aiMessages(request: Required<AiPlanRequest>): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You convert Solana wallet user requests into structured approval plans. Return only JSON with string fields intent, route, risk, approval, and safeguards as an array of short strings. Never claim a transaction is signed, submitted, approved, or safe. Never request private keys. The wallet user must approve separately.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        userPrompt: request.prompt,
        userNotes: request.userNotes,
        template: request.template,
        parameters: request.parameters,
        requiredBoundary: 'AI drafts a plan only. Wallet approval and signing happen later in the user wallet.',
      }),
    },
  ];
}

function normalizeAiPlan(payload: unknown, request: Required<AiPlanRequest>): AiPlan {
  const parsed = parsePlanJson(extractModelText(payload));
  return aiPlanFromParsed(parsed, request);
}

function normalizeStrictAiPlan(
  payload: unknown,
  request: Required<AiPlanRequest>,
  providerLabel: string,
): AiPlan {
  const content = extractModelText(payload).trim();
  if (!content) {
    throw new ProtocolError(
      'wallet_unreachable',
      `${providerLabel} returned no plan text. Try again or choose a model with enough output tokens for structured JSON.`,
    );
  }
  const parsed = parsePlanJson(content);
  if (!isPlanJson(parsed)) {
    throw new ProtocolError(
      'wallet_unreachable',
      `${providerLabel} returned a response that was not a valid Agentic plan JSON.`,
    );
  }
  return aiPlanFromParsed(parsed, request);
}

function aiPlanFromParsed(parsed: Record<string, unknown>, request: Required<AiPlanRequest>): AiPlan {
  const parameters = request.parameters;
  return {
    intent: stringOr(parsed.intent, `${request.template.title}: ${request.prompt}`),
    route: stringOr(parsed.route, `Draft ${request.template.actionType} request and show route details before wallet approval.`),
    risk: stringOr(parsed.risk, `Risk level ${request.template.risk}. Verify all visible fields before signing.`),
    approval: stringOr(parsed.approval, 'Wallet approval remains a separate explicit user action.'),
    source: 'ai',
    category: request.template.category,
    actionType: request.template.actionType,
    templateTitle: request.template.title,
    userNotes: request.userNotes,
    parameters,
    fields: Object.entries(parameters)
      .filter(([, value]) => value.trim().length > 0)
      .map(([key, value]) => ({ label: titleCase(key), value })),
    safeguards: normalizeSafeguards(parsed.safeguards),
  };
}

function isPlanJson(value: Record<string, unknown>): boolean {
  return (
    typeof value.intent === 'string' &&
    typeof value.route === 'string' &&
    typeof value.risk === 'string' &&
    typeof value.approval === 'string' &&
    Array.isArray(value.safeguards) &&
    value.safeguards.every((entry) => typeof entry === 'string')
  );
}

function normalizeSafeguards(value: unknown): string[] {
  if (!Array.isArray(value)) return SHARED_SAFEGUARDS;
  const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return [...SHARED_SAFEGUARDS, ...entries.slice(0, 8)];
}

function normalizeApiFormat(value: string | undefined, provider: string): AiApiFormat {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'anthropic') return 'anthropic';
  if (/anthropic|claude/i.test(provider)) return 'anthropic';
  return 'openai-compatible';
}

function defaultBaseUrl(format: AiApiFormat): string {
  return format === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_AI_BASE_URL;
}

function defaultModel(format: AiApiFormat): string {
  return format === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_AI_MODEL;
}

function shouldUseOpenAiResponses(config: AiRuntimeConfig): boolean {
  return isOfficialOpenAiBaseUrl(config.baseUrl);
}

function isOfficialOpenAiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(normalizeBaseUrl(baseUrl, 'openai-compatible')).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function isReasoningModel(model: string): boolean {
  return isDefaultTemperatureOnlyModel(model);
}

function isDefaultTemperatureOnlyModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.startsWith('gpt-5') ||
    normalized.includes('/gpt-5') ||
    /^o\d/.test(normalized) ||
    normalized.startsWith('o-') ||
    normalized.includes('/o1') ||
    normalized.includes('/o3') ||
    normalized.includes('/o4')
  );
}

function normalizeBaseUrl(baseUrl: string, format: AiApiFormat): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return defaultBaseUrl(format);
  if (format === 'anthropic') {
    return /\/v\d+(\/|$)/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }
  if (/\/v\d+(beta)?(\/|$)/i.test(trimmed) || /\/openai$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

function stripKeyFromUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret/i.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.toString();
  } catch {
    return redactText(baseUrl);
  }
}

function redactText(value: string): string {
  const redacted = redactSecrets(value);
  return typeof redacted === 'string' ? redacted : '[redacted]';
}

function extractProviderError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    return typeof message === 'string' ? message : '';
  }
  return '';
}

function providerFailureMessage(payload: unknown, status: number): string {
  const message = extractProviderError(payload) || `AI provider returned HTTP ${status}.`;
  if (/unsupported value:\s*['"]?temperature/i.test(message) || /temperature.*only the default/i.test(message)) {
    return redactText(`Model does not support one of Agentic's request parameters. ${message}`);
  }
  return redactText(message);
}

function assertCompleteOpenAiResponse(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const record = payload as Record<string, unknown>;
  if (record.status === 'incomplete') {
    const details = record.incomplete_details;
    const reason = details && typeof details === 'object'
      ? (details as Record<string, unknown>).reason
      : undefined;
    const suffix = typeof reason === 'string' && reason.trim()
      ? ` Reason: ${reason.trim()}.`
      : '';
    throw new ProtocolError(
      'wallet_unreachable',
      `OpenAI response was incomplete before a valid plan was produced.${suffix}`,
    );
  }
  if (record.status === 'failed') {
    const error = record.error;
    const message = error && typeof error === 'object'
      ? (error as Record<string, unknown>).message
      : undefined;
    throw new ProtocolError(
      'wallet_unreachable',
      redactText(typeof message === 'string' && message.trim() ? message : 'OpenAI response failed before a valid plan was produced.'),
    );
  }
}

function extractModelText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const outputText = record.output_text;
  if (typeof outputText === 'string') return outputText;
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        const value = (entry as Record<string, unknown>).text;
        return typeof value === 'string' ? value : '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  const choices = record.choices;
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (first && typeof first === 'object') {
      const message = (first as Record<string, unknown>).message;
      if (message && typeof message === 'object') {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === 'string') return content;
      }
      const text = (first as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
    }
  }
  const output = record.output;
  if (Array.isArray(output)) {
    const text = output
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        const entryRecord = entry as Record<string, unknown>;
        if (typeof entryRecord.text === 'string') return entryRecord.text;
        const entryContent = entryRecord.content;
        if (!Array.isArray(entryContent)) return '';
        return entryContent
          .map((contentEntry) => {
            if (!contentEntry || typeof contentEntry !== 'object') return '';
            const contentRecord = contentEntry as Record<string, unknown>;
            return typeof contentRecord.text === 'string' ? contentRecord.text : '';
          })
          .filter(Boolean)
          .join('\n');
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  return JSON.stringify(payload);
}

function parsePlanJson(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const json = trimmed.startsWith('{')
    ? trimmed
    : trimmed.slice(Math.max(0, trimmed.indexOf('{')), trimmed.lastIndexOf('}') + 1);
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function titleCase(value: string): string {
  return value
    .replace(/([A-Z])/g, ' $1')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
