import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { redactSecrets } from './trace.js';

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
  parameters: Record<string, string>;
  fields: Array<{ label: string; value: string }>;
  safeguards: string[];
}

interface AiRuntimeConfig {
  provider: string;
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
  baseUrl?: string;
  model?: string;
}

const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_AI_MODEL = 'gpt-5';
const SHARED_SAFEGUARDS = [
  'Wallet approval is required before any signature or transaction leaves the device.',
  'The agent never receives the wallet private key or seed phrase.',
  'Amounts, recipients, routes, and policy notes must be visible before signing.',
];

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
      baseUrl: stripKeyFromUrl(config.baseUrl),
      model: config.model,
    };
  }

  setSessionKey(input: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    provider?: string;
    clear?: boolean;
  }): AiStatus {
    if (input.clear) {
      this.#sessionConfig = null;
      return this.status();
    }
    if (!input.apiKey?.trim()) {
      throw new ProtocolError('invalid_request', 'Missing AI API key.');
    }
    this.#sessionConfig = {
      provider: input.provider?.trim() || 'openai-compatible',
      baseUrl: normalizeBaseUrl(input.baseUrl || DEFAULT_AI_BASE_URL),
      model: input.model?.trim() || DEFAULT_AI_MODEL,
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
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        response_format: { type: 'json_object' },
        messages: aiMessages(normalizedRequest),
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
        redactText(extractProviderError(payload) || `AI provider returned HTTP ${response.status}.`),
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
  return {
    provider: process.env.AGENTIC_AI_PROVIDER?.trim() || 'openai-compatible',
    baseUrl: normalizeBaseUrl(process.env.AGENTIC_AI_BASE_URL || DEFAULT_AI_BASE_URL),
    model: process.env.AGENTIC_AI_MODEL?.trim() || DEFAULT_AI_MODEL,
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
        template: request.template,
        parameters: request.parameters,
        requiredBoundary: 'AI drafts a plan only. Wallet approval and signing happen later in the user wallet.',
      }),
    },
  ];
}

function normalizeAiPlan(payload: unknown, request: Required<AiPlanRequest>): AiPlan {
  const parsed = parsePlanJson(extractModelText(payload));
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
    parameters,
    fields: Object.entries(parameters)
      .filter(([, value]) => value.trim().length > 0)
      .map(([key, value]) => ({ label: titleCase(key), value })),
    safeguards: normalizeSafeguards(parsed.safeguards),
  };
}

function normalizeSafeguards(value: unknown): string[] {
  if (!Array.isArray(value)) return SHARED_SAFEGUARDS;
  const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return [...SHARED_SAFEGUARDS, ...entries.slice(0, 8)];
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_AI_BASE_URL;
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
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

function extractModelText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const outputText = record.output_text;
  if (typeof outputText === 'string') return outputText;
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
