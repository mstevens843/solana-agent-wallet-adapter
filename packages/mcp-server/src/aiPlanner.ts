import { ProtocolError } from '@solana-agent-wallet-adapter/core';
import {
  assertPlanGuardrails,
  type AgentPlan as AiPlan,
  type AgentPlanAskRequest as AiAskRequest,
  type AgentPlanAskResult as AiAskResult,
  type AgentPlanReviewDecision as AiReviewDecision,
  type AgentPlanReviewMode as AiReviewMode,
  type AgentPlanReviewRequest as AiReviewRequest,
  type AgentPlanReviewResult as AiReviewResult,
  type AgentReviewQuestion as AiReviewQuestion,
  type AgentReviewerEntry as AiReviewerEntry,
  type AiPlanRequest as WorkflowAiPlanRequest,
  type AiPlanTemplateContext,
} from '@solana-agent-wallet-adapter/workflow';

import { redactSecrets } from './trace.js';
import { connectorRegistryPromptContext } from './connectorRegistry.js';
import { BLINK_CLASSIFIER_REVIEW_PROMPT } from './blinkClassification.js';

export type AiApiFormat = 'openai-compatible' | 'anthropic';
export type {
  AiPlan,
  AiAskRequest,
  AiAskResult,
  AiPlanTemplateContext,
  AiReviewDecision,
  AiReviewMode,
  AiReviewQuestion,
  AiReviewerEntry,
  AiReviewRequest,
  AiReviewResult,
};

export type AiPlanRequest = Partial<WorkflowAiPlanRequest> & {
  template?: AiPlanTemplateContext;
  parameters?: Record<string, string>;
};

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
const RESEARCH_MAX_USES = 3;
const RESEARCH_SOURCE_POLICY = [
  'Prefer official vendor, product, support, pricing, documentation, regulator, or primary-source pages over blogs and aggregators.',
  'When the request mentions Helium Mobile, official Helium domains include hellohelium.com, support.hellohelium.com, and heliummobile.com.',
  'Third-party sources may support context but should not override an official current pricing or policy source.',
].join(' ');
const SHARED_SAFEGUARDS = [
  'Wallet approval is required before any signature or transaction leaves the device.',
  'The agent never receives the wallet private key or seed phrase.',
  'Amounts, recipients, routes, and policy notes must be visible before signing.',
];
const AI_KEY_COPY_PASTE_ARTIFACTS = /[\s\u200B-\u200D\u2060\uFEFF]+/gu;

const ALLOWED_AI_HOSTS: ReadonlySet<string> = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'api.x.ai',
  'generativelanguage.googleapis.com',
]);

const SOLANA_PUBKEY_LIKE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

interface AiResearchCitation {
  title?: string;
  url: string;
  citedText?: string;
}

interface AiReviewResearchEvidence {
  status: 'checked';
  required: true;
  provider: string;
  checkedAt: string;
  summary: string;
  sources: Array<{ title?: string; url: string; citedText?: string }>;
  sourcePolicy: string;
}

interface ThresholdRule {
  threshold: number;
  approveWhen: 'below' | 'above';
}

interface ThresholdPriceCandidate {
  amount: number;
  label: string;
  text: string;
}

const WELL_KNOWN_PUBKEYS: ReadonlySet<string> = new Set([
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
]);

function assertAiBaseUrlAllowed(baseUrl: string): void {
  if (process.env.AGENTIC_AI_ALLOW_CUSTOM_BASE_URL === '1') return;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new ProtocolError(
      'invalid_request',
      `AI base URL is not a valid URL. Set AGENTIC_AI_BASE_URL to one of: ${[...ALLOWED_AI_HOSTS].join(', ')}, or set AGENTIC_AI_ALLOW_CUSTOM_BASE_URL=1 to opt in to a custom host.`,
    );
  }
  if (!ALLOWED_AI_HOSTS.has(host)) {
    throw new ProtocolError(
      'invalid_request',
      `AI base URL host "${host}" is not in the allowlist. Allowed: ${[...ALLOWED_AI_HOSTS].join(', ')}. Set AGENTIC_AI_ALLOW_CUSTOM_BASE_URL=1 to override.`,
    );
  }
}

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
      additionalProperties: true,
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
    const providedApiKey = input.apiKey === undefined ? '' : normalizeAiApiKey(input.apiKey);
    const currentConfig = providedApiKey ? this.#sessionConfig : this.config();
    const apiKey = providedApiKey || normalizeAiApiKey(currentConfig?.apiKey ?? '');
    if (!apiKey) {
      throw new ProtocolError('invalid_request', 'Missing AI API key.');
    }
    assertAiApiKeyHeaderSafe(apiKey);
    const provider = input.provider?.trim() || currentConfig?.provider || 'openai-compatible';
    const apiFormat = normalizeApiFormat(input.apiFormat ?? currentConfig?.apiFormat, provider);
    const baseUrl = normalizeBaseUrl(input.baseUrl || currentConfig?.baseUrl || defaultBaseUrl(apiFormat), apiFormat);
    assertAiBaseUrlAllowed(baseUrl);
    this.#sessionConfig = {
      provider,
      apiFormat,
      baseUrl,
      model: input.model?.trim() || currentConfig?.model || defaultModel(apiFormat),
      apiKey,
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
    assertAiDraftRequestAllowed(normalizedRequest);
    if (config.apiFormat === 'anthropic') {
      return this.generateAnthropicPlan(config, normalizedRequest);
    }
    if (shouldUseOpenAiResponses(config)) {
      return this.generateOpenAiResponsesPlan(config, normalizedRequest);
    }
    return this.generateOpenAiCompatiblePlan(config, normalizedRequest);
  }

  async reviewPlan(request: AiReviewRequest): Promise<AiReviewResult> {
    const config = this.config();
    if (!config) {
      throw new ProtocolError('unsupported_method', 'Bridge AI is not configured. Set AGENTIC_AI_API_KEY or provide a bridge session key.');
    }
    const normalizedRequest = normalizeReviewRequest(request);
    assertAiReviewRequestAllowed(normalizedRequest);
    if (reviewNeedsWebResearch(normalizedRequest) && !supportsNativeWebResearch(config)) {
      return unsupportedResearchReview(normalizedRequest, config);
    }
    if (config.apiFormat === 'anthropic') {
      return this.generateAnthropicReview(config, normalizedRequest);
    }
    if (shouldUseOpenAiResponses(config)) {
      return this.generateOpenAiResponsesReview(config, normalizedRequest);
    }
    return this.generateOpenAiCompatibleReview(config, normalizedRequest);
  }

  async askAboutPlan(request: AiAskRequest): Promise<AiAskResult> {
    const config = this.config();
    if (!config) {
      throw new ProtocolError('unsupported_method', 'Bridge AI is not configured. Set AGENTIC_AI_API_KEY or provide a bridge session key.');
    }
    const normalizedRequest = normalizeAskRequest(request);
    assertAiAskRequestAllowed(normalizedRequest);
    if (askNeedsWebResearch(normalizedRequest) && !supportsNativeWebResearch(config)) {
      return unsupportedResearchAsk(normalizedRequest, config);
    }
    if (shouldUseOpenAiResponses(config) && askNeedsWebResearch(normalizedRequest)) {
      return this.generateOpenAiResponsesAsk(config, normalizedRequest);
    }
    if (config.apiFormat === 'anthropic') {
      return this.generateAnthropicAsk(config, normalizedRequest);
    }
    return this.generateOpenAiCompatibleAsk(config, normalizedRequest);
  }

  private async generateOpenAiResponsesAsk(
    config: AiRuntimeConfig,
    normalizedRequest: Required<AiAskRequest>,
  ): Promise<AiAskResult> {
    const messages = aiAskMessages(normalizedRequest);
    const systemMessage = messages[0]?.content ?? '';
    const userMessage = messages[1]?.content ?? JSON.stringify(normalizedRequest);
    const research = askNeedsWebResearch(normalizedRequest);
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
        max_output_tokens: 1200,
        store: false,
        ...(research ? {
          tools: [openAiWebSearchTool()],
          tool_choice: 'auto',
          include: ['web_search_call.action.sources'],
        } : {}),
        ...(isReasoningModel(config.model) && {
          reasoning: { effort: OPENAI_REASONING_EFFORT },
        }),
      }),
    }).catch((err) => {
      throw new ProtocolError(
        'wallet_unreachable',
        `AI provider ask request failed. ${redactText(err instanceof Error ? err.message : String(err))}`,
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
    return aiAskFromPayload(payload);
  }

  private async generateOpenAiCompatibleAsk(
    config: AiRuntimeConfig,
    normalizedRequest: Required<AiAskRequest>,
  ): Promise<AiAskResult> {
    const body = {
      model: config.model,
      messages: aiAskMessages(normalizedRequest),
      ...(!isDefaultTemperatureOnlyModel(config.model) && { temperature: 0.3 }),
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
        `AI provider ask request failed. ${redactText(err instanceof Error ? err.message : String(err))}`,
      );
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) {
      throw new ProtocolError(
        'wallet_unreachable',
        providerFailureMessage(payload, response.status),
      );
    }
    return aiAskFromPayload(payload);
  }

  private async generateAnthropicAsk(
    config: AiRuntimeConfig,
    normalizedRequest: Required<AiAskRequest>,
  ): Promise<AiAskResult> {
    const messages = aiAskMessages(normalizedRequest);
    const systemMessage = messages[0]?.content ?? '';
    const userMessage = messages[1]?.content ?? JSON.stringify(normalizedRequest);
    const research = askNeedsWebResearch(normalizedRequest);
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl, 'anthropic')}/messages`, {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 800,
        system: systemMessage,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.3,
        ...(research ? { tools: [anthropicWebSearchTool()] } : {}),
      }),
    }).catch((err) => {
      throw new ProtocolError(
        'wallet_unreachable',
        `AI provider ask request failed. ${redactText(err instanceof Error ? err.message : String(err))}`,
      );
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) {
      throw new ProtocolError(
        'wallet_unreachable',
        providerFailureMessage(payload, response.status),
      );
    }
    return aiAskFromPayload(payload);
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

  private async generateOpenAiResponsesReview(
    config: AiRuntimeConfig,
    normalizedRequest: Required<AiReviewRequest>,
  ): Promise<AiReviewResult> {
    const research = reviewNeedsWebResearch(normalizedRequest);
    const researchResult = research
      ? await this.generateOpenAiResponsesResearchEvidence(config, normalizedRequest)
      : undefined;
    const messages = aiReviewMessages(normalizedRequest, researchResult?.evidence);
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
            name: 'agentic_ai_review',
            strict: true,
            schema: REVIEW_JSON_SCHEMA,
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
    return normalizeStrictAiReview(payload, normalizedRequest, 'OpenAI', {
      citations: researchResult?.citations,
      researchEvidence: researchResult?.evidence,
    });
  }

  private async generateOpenAiResponsesResearchEvidence(
    config: AiRuntimeConfig,
    normalizedRequest: Required<AiReviewRequest>,
  ): Promise<{ evidence: AiReviewResearchEvidence; citations: AiResearchCitation[] }> {
    const messages = aiResearchMessages(normalizedRequest);
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
        max_output_tokens: 1800,
        store: false,
        tools: [openAiWebSearchTool()],
        tool_choice: 'auto',
        include: ['web_search_call.action.sources'],
        ...(isReasoningModel(config.model) && {
          reasoning: { effort: OPENAI_REASONING_EFFORT },
        }),
      }),
    }).catch((err) => {
      throw new ProtocolError(
        'wallet_unreachable',
        `AI provider research request failed. ${redactText(err instanceof Error ? err.message : String(err))}`,
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
    return normalizeResearchEvidence(payload, normalizedRequest, 'OpenAI');
  }

  private async generateOpenAiCompatibleReview(
    config: AiRuntimeConfig,
    normalizedRequest: Required<AiReviewRequest>,
  ): Promise<AiReviewResult> {
    const body = {
      model: config.model,
      response_format: { type: 'json_object' },
      messages: aiReviewMessages(normalizedRequest),
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
    return normalizeAiReview(payload, normalizedRequest);
  }

  private async generateAnthropicReview(
    config: AiRuntimeConfig,
    normalizedRequest: Required<AiReviewRequest>,
  ): Promise<AiReviewResult> {
    const research = reviewNeedsWebResearch(normalizedRequest);
    const researchResult = research
      ? await this.generateAnthropicResearchEvidence(config, normalizedRequest)
      : undefined;
    const messages = aiReviewMessages(normalizedRequest, researchResult?.evidence);
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
    return normalizeAiReview(payload, normalizedRequest, {
      citations: researchResult?.citations,
      researchEvidence: researchResult?.evidence,
      providerLabel: 'Anthropic',
    });
  }

  private async generateAnthropicResearchEvidence(
    config: AiRuntimeConfig,
    normalizedRequest: Required<AiReviewRequest>,
  ): Promise<{ evidence: AiReviewResearchEvidence; citations: AiResearchCitation[] }> {
    const messages = aiResearchMessages(normalizedRequest);
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
        max_tokens: 1800,
        system: systemMessage,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.2,
        tools: [anthropicWebSearchTool()],
      }),
    }).catch((err) => {
      throw new ProtocolError(
        'wallet_unreachable',
        `AI provider research request failed. ${redactText(err instanceof Error ? err.message : String(err))}`,
      );
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) {
      throw new ProtocolError(
        'wallet_unreachable',
        providerFailureMessage(payload, response.status),
      );
    }
    return normalizeResearchEvidence(payload, normalizedRequest, 'Anthropic');
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
  const apiKey = normalizeAiApiKey(process.env.AGENTIC_AI_API_KEY ?? '');
  if (!apiKey) return null;
  assertAiApiKeyHeaderSafe(apiKey);
  const provider = process.env.AGENTIC_AI_PROVIDER?.trim() || 'openai-compatible';
  const apiFormat = normalizeApiFormat(process.env.AGENTIC_AI_API_FORMAT, provider);
  const baseUrl = normalizeBaseUrl(process.env.AGENTIC_AI_BASE_URL || defaultBaseUrl(apiFormat), apiFormat);
  assertAiBaseUrlAllowed(baseUrl);
  return {
    provider,
    apiFormat,
    baseUrl,
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
    connectorContext: normalizeConnectorContext(request.connectorContext),
  };
}

function normalizeReviewRequest(request: AiReviewRequest): Required<AiReviewRequest> {
  return {
    plan: request.plan,
    instruction: request.instruction?.trim() || 'Review this draft before it is sent for wallet approval. Decide approve or deny.',
    walletAddress: request.walletAddress?.trim() || '',
    cluster: request.cluster?.trim() || '',
    context: withDefaultConnectorContext(request.context),
    mode: request.mode === 'multi' ? 'multi' : 'single',
  };
}

function normalizeAskRequest(request: AiAskRequest): Required<AiAskRequest> {
  const question = request.question?.trim() ?? '';
  if (!question) {
    throw new ProtocolError('invalid_request', 'Ask agent: a question is required.');
  }
  return {
    plan: request.plan,
    question: question.slice(0, 600),
    walletAddress: request.walletAddress?.trim() || '',
    cluster: request.cluster?.trim() || '',
    context: withDefaultConnectorContext(request.context),
  };
}

function normalizeConnectorContext(
  context: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
  return Array.isArray(context) && context.length > 0
    ? context
    : connectorRegistryPromptContext();
}

function withDefaultConnectorContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base = context ?? {};
  if (Array.isArray(base.protocolConnectors) || Array.isArray(base.connectorRegistry)) {
    return base;
  }
  return {
    ...base,
    protocolConnectors: connectorRegistryPromptContext(),
  };
}

function supportsNativeWebResearch(config: AiRuntimeConfig): boolean {
  return config.apiFormat === 'anthropic' || shouldUseOpenAiResponses(config);
}

function askNeedsWebResearch(request: Required<AiAskRequest>): boolean {
  return textNeedsWebResearch([
    request.question,
    request.plan.intent,
    request.plan.route,
    request.plan.approval,
    request.plan.userNotes ?? '',
  ].join('\n'));
}

function reviewNeedsWebResearch(request: Required<AiReviewRequest>): boolean {
  return textNeedsWebResearch([
    request.instruction,
    request.plan.intent,
    request.plan.route,
    request.plan.approval,
    request.plan.userNotes ?? '',
  ].join('\n'));
}

function textNeedsWebResearch(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return false;
  return (
    /\b(current|currently|latest|today|tonight|tomorrow|yesterday|now|real[-\s]?time|up[-\s]?to[-\s]?date|as of)\b/.test(normalized) ||
    /\b(price|cost|fee|rate|plan|subscription|monthly|per\s+month|market\s+cap|liquidity|apr|apy|weather|news|status|available|availability)\b/.test(normalized) && /\b(check|find|look\s+up|search|verify|how\s+much|whether|if|less\s+than|more\s+than|under|over|approve|deny)\b/.test(normalized) ||
    /\$\s*\d+/.test(normalized) && /\b(less\s+than|more\s+than|under|over|approve|deny|per\s+month|monthly)\b/.test(normalized)
  );
}

function openAiWebSearchTool(): Record<string, unknown> {
  return {
    type: 'web_search',
    user_location: {
      type: 'approximate',
      country: 'US',
      timezone: 'America/Los_Angeles',
    },
  };
}

function anthropicWebSearchTool(): Record<string, unknown> {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: RESEARCH_MAX_USES,
    user_location: {
      type: 'approximate',
      country: 'US',
      timezone: 'America/Los_Angeles',
    },
  };
}

function unsupportedResearchReview(
  request: Required<AiReviewRequest>,
  config: AiRuntimeConfig,
): AiReviewResult {
  const provider = config.provider || config.apiFormat;
  const reason = `This review needs current outside facts, but ${provider} is not connected through a native web-search path.`;
  return {
    decision: 'needs_input',
    reason,
    summary: 'Current outside facts are required before the agent can decide.',
    evidence: {
      research: {
        status: 'unavailable',
        provider,
        required: true,
      },
      findings: [
        {
          label: 'Research needed',
          value: 'Switch to OpenAI or Anthropic through Hosted BYOK/Local bridge, or provide the current source fact in the draft.',
          tone: 'warn',
        },
      ],
      facts: {
        research: {
          state: 'missing',
          message: reason,
        },
      },
    },
    checkedAt: new Date().toISOString(),
    source: 'ai',
    questions: [{
      id: 'current_fact',
      prompt: 'What current source fact should the agent use for this decision?',
      inputKind: 'text',
      required: true,
      hint: request.instruction,
    }],
  };
}

function unsupportedResearchAsk(
  _request: Required<AiAskRequest>,
  config: AiRuntimeConfig,
): AiAskResult {
  const provider = config.provider || config.apiFormat;
  return {
    answer: `This question needs current outside facts, but ${provider} is not connected through a native web-search path. Switch to OpenAI or Anthropic through Hosted BYOK/Local bridge, or provide the source fact in the draft.`,
    checkedAt: new Date().toISOString(),
    source: 'ai',
  };
}

function aiAskMessages(request: Required<AiAskRequest>): Array<{ role: 'system' | 'user'; content: string }> {
  const needsResearch = askNeedsWebResearch(request);
  return [
    {
      role: 'system',
      content:
        'You answer the user\'s question about a Solana wallet action plan. Be concise: 1 to 4 sentences, plain English. Use plan fields, context.facts, executionPath, protocolConnectors, and connector read/write capability notes when present. If the question asks for current or outside facts and web search is available, search reliable sources and cite the source URL in the answer. Cite plan fields you reference by name (e.g., recipient, amount, slippageBps) or connector facts by label. Never claim anything is signed, submitted, guaranteed safe, or already approved. Never request private keys. If the question cannot be answered from the plan, facts, or available research tools, say so plainly and state what fact is missing.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: request.question,
        plan: request.plan,
        walletAddress: request.walletAddress || 'not_connected',
        cluster: request.cluster || 'unknown',
        context: request.context,
        research: {
          needed: needsResearch,
          mode: needsResearch ? 'auto_current_facts' : 'not_required',
          currentDate: new Date().toISOString(),
          maxSearches: RESEARCH_MAX_USES,
        },
        requiredBoundary: 'This is conversational Q&A about a draft. It cannot sign or submit a transaction.',
      }),
    },
  ];
}

function aiResearchMessages(request: Required<AiReviewRequest>): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You research current outside facts for a Solana wallet approval review. Do not approve, deny, or ask the wallet to sign. Search reliable current sources, prefer official sources, and return concise source-backed facts in plain English. Include current prices, thresholds, dates, plan names, ambiguity, and URLs when they are relevant. If multiple current options could change the approval outcome, list each option clearly. ' + RESEARCH_SOURCE_POLICY,
    },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: request.instruction,
        walletAddress: request.walletAddress || 'not_connected',
        cluster: request.cluster || 'unknown',
        plan: request.plan,
        context: request.context,
        research: {
          needed: true,
          mode: 'collect_current_facts_only',
          currentDate: new Date().toISOString(),
          maxSearches: RESEARCH_MAX_USES,
          sourcePolicy: RESEARCH_SOURCE_POLICY,
        },
        requiredBoundary: 'This research pass cannot approve, deny, sign, or submit. It only gathers facts for a later structured review.',
      }),
    },
  ];
}

function aiAskFromPayload(payload: unknown): AiAskResult {
  const text = extractModelText(payload).trim();
  if (!text) {
    throw new ProtocolError('wallet_unreachable', 'Agent did not return any answer text. Try again.');
  }
  const citations = sortResearchCitations(extractResearchCitations(payload));
  return {
    answer: compactReviewText(text, 800),
    ...(citations.length ? { citations: citations.map((citation) => ({
      kind: 'url',
      ref: citation.url,
      ...(citation.title ? { title: citation.title } : {}),
    })) } : {}),
    checkedAt: new Date().toISOString(),
    source: 'ai',
  };
}

function normalizeResearchEvidence(
  payload: unknown,
  _request: Required<AiReviewRequest>,
  providerLabel: string,
): { evidence: AiReviewResearchEvidence; citations: AiResearchCitation[] } {
  const citations = extractResearchCitations(payload);
  const text = extractModelText(payload).trim();
  const summary = text
    ? compactReviewText(text, 1600)
    : 'Research ran, but the provider did not return readable source-backed findings.';
  const sources = citations.map((citation) => ({
    ...(citation.title ? { title: citation.title } : {}),
    url: citation.url,
    ...(citation.citedText ? { citedText: citation.citedText } : {}),
  }));
  return {
    citations,
    evidence: {
      status: 'checked',
      required: true,
      provider: providerLabel,
      checkedAt: new Date().toISOString(),
      summary,
      sources,
      sourcePolicy: RESEARCH_SOURCE_POLICY,
    },
  };
}

function assertAiAskRequestAllowed(request: Required<AiAskRequest>): void {
  try {
    assertPlanGuardrails({
      source: request.plan.source,
      category: request.plan.category,
      actionType: request.plan.actionType,
      templateTitle: request.plan.templateTitle,
      parameters: request.plan.parameters,
      fields: request.plan.fields,
      userNotes: request.plan.userNotes,
      prompt: request.question,
      plan: {
        ...request.plan,
        userQuestion: request.question,
      },
    });
  } catch (err) {
    if (err instanceof Error) {
      throw new ProtocolError('invalid_request', err.message);
    }
    throw err;
  }
}

function aiMessages(request: Required<AiPlanRequest>): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You convert Solana wallet user requests into structured approval plans. Return only JSON with string fields intent, route, risk, approval, and safeguards as an array of short strings. Use enabled protocol connector context to explain which reads can inform the plan and which write actions can only prepare wallet approval work. When parameters include `inputTokenLabel`, `outputTokenLabel`, or `tokenLabel`, ALWAYS use those resolved symbols (for example "POPCAT") in the prose fields (intent, route, risk, approval, safeguards). Never substitute a different ticker for one provided in the parameter labels, and never invent a symbol when only a mint address is present. If a label is missing, refer to the token by its short mint form (first 4 + last 4 characters). Never claim a transaction is signed, submitted, approved, or safe. Never request private keys. The wallet user must approve separately.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        userPrompt: request.prompt,
        userNotes: request.userNotes,
        template: request.template,
        parameters: request.parameters,
        protocolConnectors: request.connectorContext,
        connectorRule: 'Only propose first-class or Blink executable actions for enabled connectors with matching capabilities. If a requested protocol/action is not present, make the plan proof/read-only and state what connector fact or action URL is missing.',
        requiredBoundary: 'AI drafts a plan only. Wallet approval and signing happen later in the user wallet.',
      }),
    },
  ];
}

function aiReviewMessages(
  request: Required<AiReviewRequest>,
  researchEvidence?: AiReviewResearchEvidence,
): Array<{ role: 'system' | 'user'; content: string }> {
  const multi = request.mode === 'multi';
  const needsResearch = reviewNeedsWebResearch(request);
  const baseSystem = 'You review a Solana wallet action draft before it is sent for wallet approval. Return only JSON with: decision ("approve", "deny", or "needs_input"); reason as one or two concise sentences; summary as one short sentence; evidence as an object. Put flexible user-facing findings in evidence.findings as an array of {label,value,tone}, where tone is good, warn, neutral, or fail. Findings must match the user request and connector facts; do not force route/quote/slippage rows when they do not apply. Use plan.actionType to decide which checks apply: swap drafts deserve route/quote/slippage scrutiny; lend/deposit/withdraw/stake/vault drafts deserve connector/reserve/vault checks and a balance/cap sanity check, not swap heuristics. For first-class adapter actions (kamino_deposit, kamino_withdraw, marginfi_*, save_*, marinade_*, jito_*, jupiter_lend_*, drift_vault_*, meteora_*, orca_*, raydium_*, sanctum_*), if the connector is enabled, the target token/reserve/vault is resolvable, and the amount is positive and within plausible bounds, approve unless a user policy or research result blocks. If the instruction asks for current or outside facts and web search is available, search reliable sources before deciding. Put source-backed findings in evidence.findings, put source links in evidence.sources as an array of {title,url}, and include evidence.research = {status:"checked"} when research was used. Apply user threshold rules exactly, for example "approve if under $20, deny if over $20". If multiple researched facts lead to different outcomes and the draft does not identify which one applies, return "needs_input" and list the found options. When you cannot decide because user intent is genuinely ambiguous, return decision "needs_input" plus a "questions" array with 1-3 short, specific questions answerable in under 20 words. Use "needs_input" only when the missing information is something the user must supply, such as a missing amount, missing token, missing recipient, or which researched option applies. Do not use "needs_input" for facts that are present in the plan, context.facts, context.executionPath, research results, or facts you can infer. For browser swap or recurring-swap drafts, Jupiter is the execution aggregator unless context says otherwise; do not ask the user which DEX/protocol will execute it. If a token mint address is present, review that mint address; do not ask the user what token it is or whether they verified it. If token metadata is missing, return approve or deny with a warning, not needs_input. If context includes protocolConnectors or connector facts, use reads as evidence and treat writes as prepare-only wallet-approval actions. If the context includes "userPolicies", treat each as a soft rule the user wants you to honor: factor them into your decision and cite the relevant policy id in evidence.policiesApplied when one influences the outcome. Be flexible: use the user instruction and available facts, not a fixed checklist. Never claim anything is signed, submitted, guaranteed safe, or already approved. Never request private keys. The wallet user must still approve separately.';
  const multiSystem = multi
    ? ' Additionally, fill the "reviewers" array with one entry per role (risk, quote, policy, protocol). Each reviewer evaluates the draft from their perspective independently and reports their own decision ("approve", "deny", or "needs_input") and a 1-sentence reason. The top-level decision should reflect the most severe verdict: any "deny" > any "needs_input" > all "approve". Risk inspects authority changes, unknown programs, and dangerous semantics. Quote checks slippage, output amount, and route freshness for swaps. Policy applies the user policies from context.userPolicies. Protocol identifies the protocol/aggregator and flags unknowns. Skip reviewers whose role does not apply (e.g., no quote role on a read-only plan).'
    : '';
  const blinkSystem = multi && request.plan?.actionType === 'blink_action'
    ? ` ${BLINK_CLASSIFIER_REVIEW_PROMPT}`
    : '';
  const researchSystem = researchEvidence
    ? ' Current outside-fact research has already been supplied in context.researchEvidence. Do not request another search and do not omit the researched fact. Use that evidence to produce the structured decision, including source-backed findings such as current price, threshold comparison, and source URL when relevant.'
    : '';
  const context = researchEvidence
    ? { ...request.context, researchEvidence }
    : request.context;
  return [
    {
      role: 'system',
      content: `${baseSystem}${multiSystem}${blinkSystem}${researchSystem}`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: request.instruction,
        walletAddress: request.walletAddress || 'not_connected',
        cluster: request.cluster || 'unknown',
        plan: request.plan,
        context,
        reviewMode: request.mode,
        research: {
          needed: researchEvidence ? false : needsResearch,
          mode: researchEvidence ? 'provided_current_facts' : needsResearch ? 'auto_current_facts' : 'not_required',
          currentDate: new Date().toISOString(),
          maxSearches: RESEARCH_MAX_USES,
          ...(researchEvidence ? { providedEvidence: true, sourcePolicy: researchEvidence.sourcePolicy } : {}),
        },
        requiredBoundary: 'This AI review can approve, deny, or request more input. It cannot sign or submit a transaction.',
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

function normalizeAiReview(
  payload: unknown,
  request: Required<AiReviewRequest>,
  options: {
    citations?: AiResearchCitation[];
    researchEvidence?: AiReviewResearchEvidence;
    providerLabel?: string;
  } = {},
): AiReviewResult {
  const content = extractModelText(payload);
  const parsed = parsePlanJson(content);
  return aiReviewFromParsed(parsed, request, {
    citations: options.citations ?? extractResearchCitations(payload),
    researchEvidence: options.researchEvidence,
    providerLabel: options.providerLabel ?? 'AI provider',
  });
}

function normalizeStrictAiReview(
  payload: unknown,
  request: Required<AiReviewRequest>,
  providerLabel: string,
  options: {
    citations?: AiResearchCitation[];
    researchEvidence?: AiReviewResearchEvidence;
  } = {},
): AiReviewResult {
  const content = extractModelText(payload).trim();
  if (!content) {
    return malformedAiReviewResult(request, {
      citations: options.citations ?? extractResearchCitations(payload),
      researchEvidence: options.researchEvidence,
      providerLabel,
      reason: `${providerLabel} returned no structured review text. Ask the agent again or narrow the request.`,
    });
  }
  const parsed = parsePlanJson(content);
  if (!isReviewJson(parsed)) {
    return malformedAiReviewResult(request, {
      citations: options.citations ?? extractResearchCitations(payload),
      researchEvidence: options.researchEvidence,
      providerLabel,
      reason: `${providerLabel} returned research but not a valid structured approval decision. Ask the agent again or narrow the request.`,
    });
  }
  return aiReviewFromParsed(parsed, request, {
    citations: options.citations ?? extractResearchCitations(payload),
    researchEvidence: options.researchEvidence,
    providerLabel,
  });
}

function aiPlanFromParsed(parsed: Record<string, unknown>, request: Required<AiPlanRequest>): AiPlan {
  const parameters = request.parameters;
  const scrubbed = scrubPlanProse(parsed, parameters);
  const plan: AiPlan = {
    intent: stringOr(scrubbed.parsed.intent, `${request.template.title}: ${request.prompt}`),
    route: stringOr(scrubbed.parsed.route, `Draft ${request.template.actionType} request and show route details before wallet approval.`),
    risk: stringOr(scrubbed.parsed.risk, `Risk level ${request.template.risk}. Verify all visible fields before signing.`),
    approval: stringOr(scrubbed.parsed.approval, 'Wallet approval remains a separate explicit user action.'),
    source: 'ai',
    category: request.template.category,
    actionType: request.template.actionType,
    templateTitle: request.template.title,
    userNotes: request.userNotes,
    parameters,
    fields: Object.entries(parameters)
      .filter(([, value]) => value.trim().length > 0)
      .map(([key, value]) => ({ label: titleCase(key), value })),
    safeguards: normalizeSafeguards(scrubbed.parsed.safeguards, scrubbed.warning),
  };
  return withGuardrailReport(plan, request);
}

function scrubPlanProse(
  parsed: Record<string, unknown>,
  parameters: Record<string, string>,
): { parsed: Record<string, unknown>; warning: string | null } {
  const allowed = new Set<string>();
  for (const value of Object.values(parameters)) {
    if (typeof value === 'string' && value.trim()) {
      allowed.add(value.trim());
    }
  }
  const proseFields = ['intent', 'route', 'risk', 'approval'] as const;
  for (const field of proseFields) {
    const value = parsed[field];
    if (typeof value !== 'string') continue;
    const matches = value.match(SOLANA_PUBKEY_LIKE);
    if (!matches) continue;
    for (const candidate of matches) {
      if (allowed.has(candidate)) continue;
      if (WELL_KNOWN_PUBKEYS.has(candidate)) continue;
      const stripped: Record<string, unknown> = { ...parsed };
      for (const drop of proseFields) {
        delete stripped[drop];
      }
      return {
        parsed: stripped,
        warning:
          'AI prose referenced an address that was not part of the user request. Using the deterministic template instead. Re-check the recipient before approving.',
      };
    }
  }
  return { parsed, warning: null };
}

function aiReviewFromParsed(
  parsed: Record<string, unknown>,
  request: Required<AiReviewRequest>,
  options: {
    citations?: AiResearchCitation[];
    researchEvidence?: AiReviewResearchEvidence;
    providerLabel?: string;
  } = {},
): AiReviewResult {
  const rawDecision = reviewDecisionOrUndefined(parsed.decision);
  if (!rawDecision) {
    return malformedAiReviewResult(request, {
      citations: options.citations ?? [],
      researchEvidence: options.researchEvidence,
      providerLabel: options.providerLabel ?? 'AI provider',
    });
  }
  const questions = normalizeReviewQuestions(parsed.questions);
  const reviewers = normalizeReviewers(parsed.reviewers);
  const decision = reviewers && reviewers.length
    ? aggregateReviewerDecision(reviewers, rawDecision)
    : rawDecision;
  const reason = stringOr(
    parsed.reason,
    decision === 'approve'
      ? 'Approved by the configured agent review. Wallet approval is still required before anything signs.'
      : decision === 'needs_input'
        ? 'Agent needs clarifying answers before deciding. Answer the questions or send anyway.'
        : 'Denied by the configured agent review. Review the draft or ask the agent again.',
  );
  const evidence = jsonObjectOr(parsed.evidence, {
    actionType: request.plan.actionType,
    templateTitle: request.plan.templateTitle,
  });
  if (options.researchEvidence) {
    if (!evidence.research) evidence.research = options.researchEvidence;
    if (!Array.isArray(evidence.sources) || evidence.sources.length === 0) {
      evidence.sources = options.researchEvidence.sources;
    }
  }
  const result: AiReviewResult = {
    decision,
    reason: compactReviewText(reason, 280),
    summary: compactReviewText(stringOr(parsed.summary, reason), 160),
    evidence: withResearchCitations(evidence, options.citations ?? []),
    checkedAt: new Date().toISOString(),
    source: 'ai',
    ...(questions ? { questions } : {}),
    ...(reviewers && reviewers.length ? { reviewers } : {}),
  };
  return reconcileThresholdReviewDecision(result, request);
}

function malformedAiReviewResult(
  request: Required<AiReviewRequest>,
  options: {
    citations?: AiResearchCitation[];
    researchEvidence?: AiReviewResearchEvidence;
    providerLabel?: string;
    reason?: string;
  } = {},
): AiReviewResult {
  const hasResearch = Boolean(options.researchEvidence) || Boolean(options.citations?.length);
  const reason = options.reason ?? (hasResearch
    ? `${options.providerLabel ?? 'AI provider'} completed research but did not return a structured approval decision. Ask the agent again or narrow the request.`
    : `${options.providerLabel ?? 'AI provider'} did not return a structured approval decision. Ask the agent again or narrow the request.`);
  const evidence = withResearchCitations({
    ...(options.researchEvidence ? { research: options.researchEvidence } : hasResearch ? { research: { status: 'checked', required: true } } : {}),
    findings: [{
      label: hasResearch ? 'Structured review' : 'Agent review',
      value: hasResearch
        ? 'Research sources were found, but the agent did not return a usable approval, denial, or price finding.'
        : 'The agent response was missing a usable approval, denial, or needs-input decision.',
      tone: 'warn',
    }],
    parseError: 'missing_or_invalid_review_json',
  }, options.citations ?? []);
  return {
    decision: 'needs_input',
    reason: compactReviewText(reason, 280),
    summary: hasResearch
      ? 'Research completed but the structured review failed.'
      : 'The agent review response was not structured.',
    evidence,
    checkedAt: new Date().toISOString(),
    source: 'ai',
    questions: [{
      id: 'agent_review_retry',
      prompt: 'Ask the agent again or provide the missing current fact in the draft.',
      inputKind: 'text',
      required: false,
      hint: request.instruction,
    }],
  };
}

function reconcileThresholdReviewDecision(
  result: AiReviewResult,
  request: Required<AiReviewRequest>,
): AiReviewResult {
  const rule = extractThresholdRule(request.instruction);
  if (!rule) return result;
  const candidate = selectThresholdPriceCandidate(result, rule);
  if (!candidate) return result;
  const expected = expectedDecisionForThreshold(candidate.amount, rule);
  if (expected === result.decision) return result;

  const thresholdText = formatDollar(rule.threshold);
  const amountText = formatDollar(candidate.amount);
  const relation = candidate.amount < rule.threshold
    ? 'under'
    : candidate.amount > rule.threshold
      ? 'over'
      : 'equal to';
  const correctedReason = expected === 'needs_input'
    ? `${amountText} is exactly ${thresholdText}; the user rule used a strict under/over threshold, so the review needs clarification.`
    : `${amountText} is ${relation} ${thresholdText}, so the user threshold rule ${expected === 'approve' ? 'approves' : 'denies'} this draft. Wallet approval is still required before anything signs.`;
  const evidence = appendReviewFinding(result.evidence, {
    label: 'Threshold check',
    value: `Corrected model comparison: ${amountText} is ${relation} ${thresholdText}. Original decision was ${result.decision}.`,
    tone: expected === 'approve' ? 'good' : expected === 'deny' ? 'fail' : 'warn',
  });
  return {
    ...result,
    decision: expected,
    reason: compactReviewText(correctedReason, 280),
    summary: compactReviewText(`Threshold rule checked: ${amountText} is ${relation} ${thresholdText}.`, 160),
    evidence,
  };
}

function extractThresholdRule(instruction: string): ThresholdRule | undefined {
  const normalized = instruction.toLowerCase();
  const threshold = extractInstructionThreshold(normalized);
  if (threshold === undefined) return undefined;
  const approveBelow = /\b(approve|allow|pass)\b[\s\S]{0,80}\b(under|below|less\s+than)\b/.test(normalized) ||
    /\b(under|below|less\s+than)\b[\s\S]{0,80}\b(approve|allow|pass)\b/.test(normalized);
  const approveAbove = /\b(approve|allow|pass)\b[\s\S]{0,80}\b(over|above|more\s+than|greater\s+than)\b/.test(normalized) ||
    /\b(over|above|more\s+than|greater\s+than)\b[\s\S]{0,80}\b(approve|allow|pass)\b/.test(normalized);
  const denyBelow = /\b(deny|block|reject|fail)\b[\s\S]{0,80}\b(under|below|less\s+than)\b/.test(normalized) ||
    /\b(under|below|less\s+than)\b[\s\S]{0,80}\b(deny|block|reject|fail)\b/.test(normalized);
  const denyAbove = /\b(deny|block|reject|fail)\b[\s\S]{0,80}\b(over|above|more\s+than|greater\s+than)\b/.test(normalized) ||
    /\b(over|above|more\s+than|greater\s+than)\b[\s\S]{0,80}\b(deny|block|reject|fail)\b/.test(normalized);
  if (approveBelow || denyAbove) return { threshold, approveWhen: 'below' };
  if (approveAbove || denyBelow) return { threshold, approveWhen: 'above' };
  return undefined;
}

function extractInstructionThreshold(text: string): number | undefined {
  const matches = [...text.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Number.parseFloat(match[1] ?? ''))
    .filter(Number.isFinite);
  if (!matches.length) return undefined;
  return matches[0];
}

function expectedDecisionForThreshold(amount: number, rule: ThresholdRule): AiReviewDecision {
  if (amount === rule.threshold) return 'needs_input';
  if (rule.approveWhen === 'below') {
    return amount < rule.threshold ? 'approve' : 'deny';
  }
  return amount > rule.threshold ? 'approve' : 'deny';
}

function selectThresholdPriceCandidate(
  result: AiReviewResult,
  rule: ThresholdRule,
): ThresholdPriceCandidate | undefined {
  const candidates = extractThresholdPriceCandidates(result, rule.threshold);
  if (!candidates.length) return undefined;
  const currentPrice = candidates.find((candidate) => /current price|cheapest|monthly plan|air plan|including taxes|taxes\/fees/i.test(candidate.label));
  if (currentPrice) return currentPrice;
  if (candidates.length === 1) return candidates[0];
  const nonThresholdCandidates = candidates.filter((candidate) => candidate.amount !== rule.threshold);
  return nonThresholdCandidates.length === 1 ? nonThresholdCandidates[0] : undefined;
}

function extractThresholdPriceCandidates(
  result: AiReviewResult,
  threshold: number,
): ThresholdPriceCandidate[] {
  const fields: Array<{ label: string; text: string }> = [
    { label: 'reason', text: result.reason },
    { label: 'summary', text: result.summary },
    ...evidenceTextFields(result.evidence),
  ];
  const candidates: ThresholdPriceCandidate[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    for (const sentence of field.text.split(/(?<=[.!?])\s+|\n+/)) {
      if (!/\$/.test(sentence)) continue;
      if (/\b(threshold|limit|rule)\b/i.test(sentence) && !/\b(cost|costs|price|priced|plan|monthly|per\s+month|tax|fee|current)\b/i.test(sentence)) {
        continue;
      }
      if (!/\b(cost|costs|price|priced|plan|monthly|per\s+month|tax|fee|current|cheapest|air|infinity)\b/i.test(sentence)) {
        continue;
      }
      for (const match of sentence.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)) {
        const amount = Number.parseFloat(match[1] ?? '');
        if (!Number.isFinite(amount)) continue;
        if (amount === threshold && !/\b(cost|costs|price|priced|plan|monthly|per\s+month|tax|fee|current|cheapest|air|infinity)\b/i.test(sentence.slice(0, Math.max(0, match.index ?? 0)))) {
          continue;
        }
        const key = `${amount}:${sentence.trim().toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ amount, label: field.label, text: sentence.trim() });
      }
    }
  }
  return candidates;
}

function evidenceTextFields(evidence: Record<string, unknown>): Array<{ label: string; text: string }> {
  const fields: Array<{ label: string; text: string }> = [];
  const findings = Array.isArray(evidence.findings) ? evidence.findings : [];
  for (const entry of findings) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const label = typeof record.label === 'string' ? record.label : 'finding';
    const value = typeof record.value === 'string' ? record.value : '';
    if (value.trim()) fields.push({ label, text: value });
  }
  if (evidence.research && typeof evidence.research === 'object' && !Array.isArray(evidence.research)) {
    const summary = (evidence.research as Record<string, unknown>).summary;
    if (typeof summary === 'string' && summary.trim()) {
      fields.push({ label: 'research', text: summary });
    }
  }
  return fields;
}

function appendReviewFinding(
  evidence: Record<string, unknown>,
  finding: { label: string; value: string; tone: 'good' | 'warn' | 'neutral' | 'fail' },
): Record<string, unknown> {
  const findings = Array.isArray(evidence.findings)
    ? evidence.findings.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  return {
    ...evidence,
    findings: [...findings, finding],
  };
}

function formatDollar(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

function withResearchCitations(
  evidence: Record<string, unknown>,
  citations: AiResearchCitation[],
): Record<string, unknown> {
  if (!citations.length) return evidence;
  const existing = Array.isArray(evidence.sources)
    ? evidence.sources.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    : [];
  const seen = new Set<string>();
  const sources: AiResearchCitation[] = [];
  for (const entry of [...existing, ...citations]) {
    const record = entry as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title.trim() } : {}),
      url,
      ...(typeof record.citedText === 'string' && record.citedText.trim() ? { citedText: record.citedText.trim() } : {}),
    });
    if (sources.length >= 8) break;
  }
  return {
    ...evidence,
    sources: sortResearchCitations(sources),
    research: evidence.research ?? { status: 'checked' },
  };
}

function sortResearchCitations<T extends { url: string }>(citations: T[]): T[] {
  return [...citations].sort((a, b) => researchSourcePriority(a.url) - researchSourcePriority(b.url));
}

function researchSourcePriority(url: string): number {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'hellohelium.com' || host.endsWith('.hellohelium.com')) return 0;
    if (host === 'heliummobile.com' || host.endsWith('.heliummobile.com')) return 0;
  } catch {
    return 10;
  }
  return 5;
}

function normalizeReviewers(value: unknown): AiReviewerEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: AiReviewerEntry[] = [];
  const seenIds = new Set<string>();
  const roleLabels: Record<string, string> = {
    risk: 'Risk reviewer',
    quote: 'Quote reviewer',
    policy: 'Policy reviewer',
    protocol: 'Protocol reviewer',
  };
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const idRaw = typeof record.id === 'string' ? record.id.trim().toLowerCase() : '';
    if (!['risk', 'quote', 'policy', 'protocol'].includes(idRaw)) continue;
    if (seenIds.has(idRaw)) continue;
    const decisionValue = reviewDecisionOrUndefined(record.decision);
    if (!decisionValue) continue;
    const reasonText = typeof record.reason === 'string' ? record.reason : '';
    if (!reasonText.trim()) continue;
    const summaryText = typeof record.summary === 'string' ? record.summary : '';
    const label = typeof record.label === 'string' && record.label.trim()
      ? record.label.trim()
      : roleLabels[idRaw] ?? idRaw;
    entries.push({
      id: idRaw,
      label,
      decision: decisionValue,
      reason: compactReviewText(reasonText, 220),
      ...(summaryText ? { summary: compactReviewText(summaryText, 140) } : {}),
      checkedAt: new Date().toISOString(),
    });
    seenIds.add(idRaw);
    if (entries.length >= 4) break;
  }
  return entries.length ? entries : undefined;
}

function aggregateReviewerDecision(reviewers: AiReviewerEntry[], fallback: AiReviewDecision): AiReviewDecision {
  if (reviewers.some((reviewer) => reviewer.decision === 'deny')) return 'deny';
  if (reviewers.some((reviewer) => reviewer.decision === 'needs_input')) return 'needs_input';
  if (reviewers.every((reviewer) => reviewer.decision === 'approve')) return 'approve';
  return fallback;
}

function assertAiDraftRequestAllowed(request: Required<AiPlanRequest>): void {
  try {
    assertPlanGuardrails({
      source: 'ai',
      category: request.template.category,
      actionType: request.template.actionType,
      templateId: request.template.id,
      templateTitle: request.template.title,
      parameters: request.parameters,
      userNotes: request.userNotes,
      prompt: request.prompt,
      plan: {
        source: 'ai',
        category: request.template.category,
        actionType: request.template.actionType,
        templateId: request.template.id,
        templateTitle: request.template.title,
        parameters: request.parameters,
        prompt: request.prompt,
        userNotes: request.userNotes,
        intent: request.prompt,
        route: 'AI draft only. Wallet approval is required later.',
        risk: `Requested risk level ${request.template.risk}.`,
        approval: 'Wallet approval is required before signing or submitting.',
      },
    });
  } catch (err) {
    if (err instanceof Error) {
      throw new ProtocolError('invalid_request', err.message);
    }
    throw err;
  }
}

function assertAiReviewRequestAllowed(request: Required<AiReviewRequest>): void {
  try {
    assertPlanGuardrails({
      source: request.plan.source,
      category: request.plan.category,
      actionType: request.plan.actionType,
      templateTitle: request.plan.templateTitle,
      parameters: request.plan.parameters,
      fields: request.plan.fields,
      userNotes: request.plan.userNotes,
      prompt: request.instruction,
      plan: {
        ...request.plan,
        reviewInstruction: request.instruction,
        reviewContext: request.context,
      },
    });
  } catch (err) {
    if (err instanceof Error) {
      throw new ProtocolError('invalid_request', err.message);
    }
    throw err;
  }
}

function withGuardrailReport(plan: AiPlan, request: Required<AiPlanRequest>): AiPlan {
  try {
    const report = assertPlanGuardrails({
      plan: { ...plan },
      source: plan.source,
      category: plan.category,
      actionType: plan.actionType,
      templateId: request.template.id,
      templateTitle: plan.templateTitle,
      parameters: plan.parameters,
      fields: plan.fields,
      userNotes: plan.userNotes,
      prompt: request.prompt,
    });
    return {
      ...plan,
      guardrailReport: report,
      constraintFingerprint: report.constraintFingerprint,
      ...(report.constraintHash ? { constraintHash: report.constraintHash } : {}),
    };
  } catch (err) {
    if (err instanceof Error) {
      throw new ProtocolError('invalid_request', err.message);
    }
    throw err;
  }
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

function isReviewJson(value: Record<string, unknown>): boolean {
  return (
    (value.decision === 'approve' || value.decision === 'deny' || value.decision === 'needs_input') &&
    typeof value.reason === 'string' &&
    typeof value.summary === 'string' &&
    Boolean(value.evidence) &&
    typeof value.evidence === 'object' &&
    !Array.isArray(value.evidence)
  );
}

function reviewDecisionOrUndefined(value: unknown): AiReviewDecision | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['approve', 'approved', 'allow', 'allowed', 'pass', 'passed', 'ok'].includes(normalized)) {
    return 'approve';
  }
  if (['needs_input', 'needs-input', 'need_input', 'need-input', 'ask', 'clarify', 'needs_clarification'].includes(normalized)) {
    return 'needs_input';
  }
  if (['deny', 'denied', 'block', 'blocked', 'fail', 'failed', 'reject', 'rejected'].includes(normalized)) {
    return 'deny';
  }
  return undefined;
}

function normalizeReviewQuestions(value: unknown): AiReviewQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions: AiReviewQuestion[] = [];
  for (let index = 0; index < value.length && questions.length < 3; index += 1) {
    const entry = value[index];
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const prompt = typeof record.prompt === 'string'
      ? record.prompt
      : typeof record.question === 'string'
        ? record.question
        : '';
    if (!prompt.trim()) continue;
    const inputKind = record.inputKind === 'select' || record.inputKind === 'number'
      ? (record.inputKind as AiReviewQuestion['inputKind'])
      : 'text';
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim()
      : `q${questions.length + 1}`;
    const options = Array.isArray(record.options)
      ? record.options.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 8)
      : undefined;
    const hint = typeof record.hint === 'string' && record.hint.trim() ? record.hint.trim() : undefined;
    questions.push({
      id,
      prompt: compactReviewText(prompt, 200),
      inputKind,
      required: record.required !== false,
      ...(options?.length ? { options } : {}),
      ...(hint ? { hint } : {}),
    });
  }
  return questions.length ? questions : undefined;
}

function jsonObjectOr(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return fallback;
}

function compactReviewText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function normalizeSafeguards(value: unknown, extraWarning?: string | null): string[] {
  const entries = Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .slice(0, 8)
    : [];
  const prefix = extraWarning ? [extraWarning] : [];
  return [...prefix, ...SHARED_SAFEGUARDS, ...entries];
}

function normalizeApiFormat(value: string | undefined, provider: string): AiApiFormat {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'anthropic') return 'anthropic';
  if (/anthropic|claude/i.test(provider)) return 'anthropic';
  return 'openai-compatible';
}

export function normalizeAiApiKey(value: string): string {
  return value.replace(AI_KEY_COPY_PASTE_ARTIFACTS, '');
}

function assertAiApiKeyHeaderSafe(value: string): void {
  const invalid = firstInvalidAiApiKeyCharacter(value);
  if (!invalid) return;
  throw new ProtocolError(
    'invalid_request',
    `AI API key contains unsupported characters at index ${invalid.index}. Paste the key again as plain text and remove hidden separators or non-ASCII characters.`,
  );
}

function firstInvalidAiApiKeyCharacter(value: string): { index: number; codePoint: number } | null {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) continue;
    if (codePoint < 0x21 || codePoint > 0x7e) {
      return { index, codePoint };
    }
    if (codePoint > 0xffff) {
      index += 1;
    }
  }
  return null;
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

function extractResearchCitations(payload: unknown): AiResearchCitation[] {
  const citations: AiResearchCitation[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 10 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    const citationType = typeof record.type === 'string' ? record.type : '';
    const hasCitationShape = citationType.includes('citation') ||
      citationType.includes('web_search') ||
      typeof record.title === 'string' ||
      typeof record.cited_text === 'string' ||
      typeof record.citedText === 'string';
    if (url && hasCitationShape && /^https?:\/\//i.test(url) && !seen.has(url)) {
      seen.add(url);
      const citedText = typeof record.citedText === 'string'
        ? record.citedText
        : typeof record.cited_text === 'string'
          ? record.cited_text
          : undefined;
      citations.push({
        url,
        ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title.trim() } : {}),
        ...(citedText && citedText.trim() ? { citedText: citedText.trim() } : {}),
      });
      if (citations.length >= 8) return;
    }
    for (const entry of Object.values(record)) {
      if (citations.length >= 8) return;
      visit(entry, depth + 1);
    }
  };
  visit(payload, 0);
  return citations;
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
  if (!trimmed) return {};
  const candidates = [
    trimmed,
    ...jsonCodeFenceCandidates(trimmed),
    ...balancedJsonObjectCandidates(trimmed),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return {};
}

function jsonCodeFenceCandidates(content: string): string[] {
  const candidates: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(content))) {
    const candidate = match[1]?.trim();
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function balancedJsonObjectCandidates(content: string): string[] {
  const candidates: string[] = [];
  for (let start = content.indexOf('{'); start >= 0; start = content.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < content.length; index += 1) {
      const char = content[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(content.slice(start, index + 1));
          break;
        }
      }
    }
    if (candidates.length >= 4) break;
  }
  return candidates;
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
