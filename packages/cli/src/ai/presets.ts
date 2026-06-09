export {
  assertCustomOpenAiCompatibleBaseUrl,
  customOpenAiCompatibleBaseUrlError,
  isCustomOpenAiCompatibleProvider,
} from '@solana-agent-wallet-adapter/core';

export type AiApiFormat = 'openai-compatible' | 'anthropic';

export type AgentSetupProvider =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'custom-openai-compatible';

export type AgentAiPath = 'bridge' | 'hosted-byok';

export interface AiProviderModel {
  id: string;
  label: string;
  tokenRateLabel?: string;
  tokensPerMinute?: number;
}

export interface AiProviderPreset {
  id: AgentSetupProvider;
  label: string;
  detail: string;
  apiFormat: AiApiFormat;
  baseUrl: string;
  model: string;
  models: AiProviderModel[];
  hostedByok: boolean;
  // When true the preset stays usable via --provider / config but is NOT offered in the
  // interactive picker. Mirrors planner.ts in the web app.
  hiddenFromPicker?: boolean;
}

export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_AI_MODEL = 'gpt-5';
export const DEFAULT_AI_PROVIDER_ID: AgentSetupProvider = 'anthropic';

// Anthropic is listed and defaulted before OpenAI so agent reviews default to the
// Anthropic Messages family. OpenRouter exposes explicit Anthropic/OpenAI models only
// (no Auto, no Gemini); direct Gemini routes natively (see resolveAiTransport).
export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Claude / Anthropic',
    detail: 'Claude models through the Anthropic Messages API.',
    apiFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-opus-4-1-20250805',
    hostedByok: true,
    models: [
      { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'claude-3-5-haiku-20241022', label: 'Claude Haiku 3.5', tokenRateLabel: '50K', tokensPerMinute: 50_000 },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tokenRateLabel: '30K', tokensPerMinute: 30_000 },
      { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 snapshot', tokenRateLabel: '30K', tokensPerMinute: 30_000 },
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', tokenRateLabel: '30K', tokensPerMinute: 30_000 },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    detail: 'GPT models through Hosted BYOK or Local Bridge.',
    apiFormat: 'openai-compatible',
    baseUrl: DEFAULT_AI_BASE_URL,
    model: 'gpt-5.5',
    hostedByok: true,
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5.4', label: 'GPT-5.4', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: DEFAULT_AI_MODEL, label: 'GPT-5', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5.2', label: 'GPT-5.2', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5.1', label: 'GPT-5.1', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5-mini', label: 'GPT-5 mini', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', tokenRateLabel: '200K', tokensPerMinute: 200_000 },
      { id: 'gpt-5-nano', label: 'GPT-5 nano', tokenRateLabel: '200K', tokensPerMinute: 200_000 },
      { id: 'gpt-4.1', label: 'GPT-4.1', tokenRateLabel: '30K', tokensPerMinute: 30_000 },
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    detail: 'Google Gemini through its native generateContent API.',
    // apiFormat stays 'openai-compatible' (the only non-anthropic format the type allows) and the
    // baseUrl keeps the '/openai' suffix by convention — routing is by provider id, and the Gemini
    // transport strips '/openai' to call the native :generateContent endpoint.
    apiFormat: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash-lite',
    hostedByok: true,
    models: [
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', tokenRateLabel: '4M', tokensPerMinute: 4_000_000 },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', tokenRateLabel: '4M', tokensPerMinute: 4_000_000 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tokenRateLabel: '2M', tokensPerMinute: 2_000_000 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tokenRateLabel: '1M', tokensPerMinute: 1_000_000 },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    detail: 'OpenRouter gateway with an explicit routed model. Auto routing is disabled for agent reviews.',
    apiFormat: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4.5',
    hostedByok: true,
    models: [
      // Auto Router is intentionally hidden until routed model selection is deterministic
      // before the review request. Gemini stays on the direct provider for native Gemini
      // formatting.
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { id: 'openai/gpt-5', label: 'OpenAI GPT-5' },
    ],
  },
  {
    id: 'custom-openai-compatible',
    label: 'Custom OpenAI-compatible',
    detail: 'Vercel AI Gateway, Cloudflare AI Gateway, or a self-hosted proxy.',
    apiFormat: 'openai-compatible',
    baseUrl: DEFAULT_AI_BASE_URL,
    model: DEFAULT_AI_MODEL,
    hostedByok: false,
    models: [
      { id: DEFAULT_AI_MODEL, label: 'GPT-5 compatible default' },
    ],
    // Hidden from the interactive picker (raw OpenAI-compatible gateways have no web-search tool);
    // still resolvable via --provider custom-openai-compatible / config.
    hiddenFromPicker: true,
  },
];

export function aiProviderPresetById(id: string | undefined): AiProviderPreset {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? AI_PROVIDER_PRESETS[0]!;
}

// Presets offered in the interactive `/agent` setup picker. Excludes hiddenFromPicker presets;
// AI_PROVIDER_PRESETS still holds every preset for --provider/config resolution.
export function visibleAiProviderPresets(): AiProviderPreset[] {
  return AI_PROVIDER_PRESETS.filter((preset) => !preset.hiddenFromPicker);
}

export function agentProviderFromArg(value: string | undefined): AgentSetupProvider {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
  if (normalized === 'openai' || normalized === 'gpt') return 'openai';
  if (normalized === 'gemini' || normalized === 'google') return 'gemini';
  if (normalized === 'openrouter') return 'openrouter';
  if (normalized === 'custom' || normalized === 'openai-compatible' || normalized === 'custom-openai-compatible') {
    return 'custom-openai-compatible';
  }
  return DEFAULT_AI_PROVIDER_ID;
}

export function normalizeAgentAiPath(value: string | undefined): AgentAiPath {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'hosted' || normalized === 'hosted-byok' || normalized === 'byok') return 'hosted-byok';
  return 'bridge';
}

export function normalizeAgentApiFormat(value: string | undefined, fallback: AiApiFormat): AiApiFormat {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'anthropic') return 'anthropic';
  if (normalized === 'openai' || normalized === 'openai-compatible') return 'openai-compatible';
  return fallback;
}

export function modelDisplay(model: AiProviderModel): string {
  return model.tokenRateLabel
    ? `${model.label} (${model.tokenRateLabel} tokens/min)`
    : model.label;
}
