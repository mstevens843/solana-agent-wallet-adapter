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
    const apiKey = normalizeAiApiKey(input.apiKey ?? '');
    if (!apiKey) {
      throw new ProtocolError('invalid_request', 'Missing AI API key.');
    }
    assertAiApiKeyHeaderSafe(apiKey);
    const provider = input.provider?.trim() || 'openai-compatible';
    const apiFormat = normalizeApiFormat(input.apiFormat, provider);
    const baseUrl = normalizeBaseUrl(input.baseUrl || defaultBaseUrl(apiFormat), apiFormat);
    assertAiBaseUrlAllowed(baseUrl);
    this.#sessionConfig = {
      provider,
      apiFormat,
      baseUrl,
      model: input.model?.trim() || defaultModel(apiFormat),
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
    if (config.apiFormat === 'anthropic') {
      return this.generateAnthropicAsk(config, normalizedRequest);
    }
    return this.generateOpenAiCompatibleAsk(config, normalizedRequest);
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
    const messages = aiReviewMessages(normalizedRequest);
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
    return normalizeStrictAiReview(payload, normalizedRequest, 'OpenAI');
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
    const messages = aiReviewMessages(normalizedRequest);
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
    return normalizeAiReview(payload, normalizedRequest);
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

function aiAskMessages(request: Required<AiAskRequest>): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You answer the user\'s question about a Solana wallet action plan. Be concise: 1 to 4 sentences, plain English. Use plan fields, context.facts, executionPath, protocolConnectors, and connector read/write capability notes when present. Cite plan fields you reference by name (e.g., recipient, amount, slippageBps) or connector facts by label. Never claim anything is signed, submitted, guaranteed safe, or already approved. Never request private keys. If the question cannot be answered from the plan or facts, say so plainly and state what fact is missing.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: request.question,
        plan: request.plan,
        walletAddress: request.walletAddress || 'not_connected',
        cluster: request.cluster || 'unknown',
        context: request.context,
        requiredBoundary: 'This is conversational Q&A about a draft. It cannot sign or submit a transaction.',
      }),
    },
  ];
}

function aiAskFromPayload(payload: unknown): AiAskResult {
  const text = extractModelText(payload).trim();
  if (!text) {
    throw new ProtocolError('wallet_unreachable', 'Agent did not return any answer text. Try again.');
  }
  return {
    answer: compactReviewText(text, 800),
    checkedAt: new Date().toISOString(),
    source: 'ai',
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

function aiReviewMessages(request: Required<AiReviewRequest>): Array<{ role: 'system' | 'user'; content: string }> {
  const multi = request.mode === 'multi';
  const baseSystem = 'You review a Solana wallet action draft before it is sent for wallet approval. Return only JSON with: decision ("approve", "deny", or "needs_input"); reason as one or two concise sentences; summary as one short sentence; evidence as an object. Put flexible user-facing findings in evidence.findings as an array of {label,value,tone}, where tone is good, warn, neutral, or fail. Findings must match the user request and connector facts; do not force route/quote/slippage rows when they do not apply. When you cannot decide because user intent is genuinely ambiguous, return decision "needs_input" plus a "questions" array with 1-3 short, specific questions answerable in under 20 words. Use "needs_input" only when the missing information is something the user must supply, such as a missing amount, missing token, or missing recipient. Do not use "needs_input" for facts that are present in the plan, context.facts, context.executionPath, or facts you can infer. For browser swap or recurring-swap drafts, Jupiter is the execution aggregator unless context says otherwise; do not ask the user which DEX/protocol will execute it. If a token mint address is present, review that mint address; do not ask the user what token it is or whether they verified it. If token metadata is missing, return approve or deny with a warning, not needs_input. If context includes protocolConnectors or connector facts, use reads as evidence and treat writes as prepare-only wallet-approval actions. If the context includes "userPolicies", treat each as a soft rule the user wants you to honor: factor them into your decision and cite the relevant policy id in evidence.policiesApplied when one influences the outcome. Be flexible: use the user instruction and available facts, not a fixed checklist. Never claim anything is signed, submitted, guaranteed safe, or already approved. Never request private keys. The wallet user must still approve separately.';
  const multiSystem = multi
    ? ' Additionally, fill the "reviewers" array with one entry per role (risk, quote, policy, protocol). Each reviewer evaluates the draft from their perspective independently and reports their own decision ("approve", "deny", or "needs_input") and a 1-sentence reason. The top-level decision should reflect the most severe verdict: any "deny" > any "needs_input" > all "approve". Risk inspects authority changes, unknown programs, and dangerous semantics. Quote checks slippage, output amount, and route freshness for swaps. Policy applies the user policies from context.userPolicies. Protocol identifies the protocol/aggregator and flags unknowns. Skip reviewers whose role does not apply (e.g., no quote role on a read-only plan).'
    : '';
  return [
    {
      role: 'system',
      content: `${baseSystem}${multiSystem}`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: request.instruction,
        walletAddress: request.walletAddress || 'not_connected',
        cluster: request.cluster || 'unknown',
        plan: request.plan,
        context: request.context,
        reviewMode: request.mode,
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

function normalizeAiReview(payload: unknown, request: Required<AiReviewRequest>): AiReviewResult {
  const parsed = parsePlanJson(extractModelText(payload));
  return aiReviewFromParsed(parsed, request);
}

function normalizeStrictAiReview(
  payload: unknown,
  request: Required<AiReviewRequest>,
  providerLabel: string,
): AiReviewResult {
  const content = extractModelText(payload).trim();
  if (!content) {
    throw new ProtocolError(
      'wallet_unreachable',
      `${providerLabel} returned no review text. Try again or choose a model with enough output tokens for structured JSON.`,
    );
  }
  const parsed = parsePlanJson(content);
  if (!isReviewJson(parsed)) {
    throw new ProtocolError(
      'wallet_unreachable',
      `${providerLabel} returned a response that was not a valid Agentic review JSON.`,
    );
  }
  return aiReviewFromParsed(parsed, request);
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

function aiReviewFromParsed(parsed: Record<string, unknown>, request: Required<AiReviewRequest>): AiReviewResult {
  const rawDecision = normalizeReviewDecision(parsed.decision);
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
  return {
    decision,
    reason: compactReviewText(reason, 280),
    summary: compactReviewText(stringOr(parsed.summary, reason), 160),
    evidence: jsonObjectOr(parsed.evidence, {
      actionType: request.plan.actionType,
      templateTitle: request.plan.templateTitle,
    }),
    checkedAt: new Date().toISOString(),
    source: 'ai',
    ...(questions ? { questions } : {}),
    ...(reviewers && reviewers.length ? { reviewers } : {}),
  };
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
    const decisionValue = normalizeReviewDecision(record.decision);
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

function normalizeReviewDecision(value: unknown): AiReviewDecision {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['approve', 'approved', 'allow', 'allowed', 'pass', 'passed', 'ok'].includes(normalized)) {
    return 'approve';
  }
  if (['needs_input', 'needs-input', 'need_input', 'need-input', 'ask', 'clarify', 'needs_clarification'].includes(normalized)) {
    return 'needs_input';
  }
  return 'deny';
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
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
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
