import { readFile } from 'node:fs/promises';

import type { GlobalOptions } from '../shared/types.js';
import { loadSession, sessionStatusSummary } from '../auth/sessionStore.js';
import { bridgeRequest, fetchWithTimeout, renderWebRequest, renderWebUrl, tryBridgeRequest } from '../http/index.js';
import {
  aiProviderPresetById,
  normalizeAgentAiPath,
  normalizeAgentApiFormat,
  type AgentAiPath,
  type AiApiFormat,
} from './presets.js';

export interface BridgeAiStatus {
  available?: boolean;
  configured?: boolean;
  source?: string;
  provider?: string;
  apiFormat?: string;
  baseUrl?: string;
  model?: string;
}

export interface HostedAiStatus {
  available?: boolean;
  mode?: string;
  managed?: {
    available?: boolean;
    provider?: string;
    apiFormat?: string;
    model?: string;
  };
}

interface AgentAiConfig {
  apiKey: string;
  path: AgentAiPath;
  provider: string;
  apiFormat: AiApiFormat;
  baseUrl: string;
  model: string;
}

export type AgentAiRoute =
  | { kind: 'hosted-managed'; status: HostedAiStatus }
  | { kind: 'hosted-byok'; config: AgentAiConfig; status: HostedAiStatus | null }
  | { kind: 'bridge'; status: BridgeAiStatus }
  | { kind: 'none'; hosted: HostedAiStatus | null; bridge: BridgeAiStatus | null; signedIn: boolean; config: AgentAiConfig | null };

export async function getHostedAiStatus(options: GlobalOptions, timeoutMs = 5_000): Promise<HostedAiStatus | null> {
  try {
    const response = await fetchWithTimeout(renderWebUrl(options, '/api/ai/status'), {
      headers: {
        Accept: 'application/json',
        'x-agentic-client': 'cli-bundled',
      },
    }, timeoutMs);
    if (!response.ok) return null;
    return await response.json() as HostedAiStatus;
  } catch {
    return null;
  }
}

export function hostedManagedAvailable(status: HostedAiStatus | null): boolean {
  return Boolean(status?.managed?.available);
}

export function hostedManagedLabel(status: HostedAiStatus | null): string {
  const managed = status?.managed;
  if (!managed?.available) return 'Hosted AI unavailable';
  const provider = managed.provider?.trim() || 'Agentic hosted AI';
  const model = managed.model?.trim();
  return model ? `${provider} - ${model}` : provider;
}

export async function resolveAgentAiRoute(options: GlobalOptions): Promise<AgentAiRoute> {
  const [hosted, session, config] = await Promise.all([
    getHostedAiStatus(options),
    loadSession(options).catch(() => null),
    loadAgentAiConfig(options),
  ]);
  const signedIn = sessionStatusSummary(session).authenticated;
  if (config?.path === 'hosted-byok') {
    if (signedIn && hosted?.available) {
      return { kind: 'hosted-byok', config, status: hosted };
    }
    return {
      kind: 'none',
      hosted,
      bridge: null,
      signedIn,
      config,
    };
  }
  const bridge = await tryBridgeRequest<BridgeAiStatus>(options, '/bridge/ai/status');
  if (bridge.ok && bridge.value.available) {
    return { kind: 'bridge', status: bridge.value };
  }
  return {
    kind: 'none',
    hosted,
    bridge: bridge.ok ? bridge.value : null,
    signedIn,
    config,
  };
}

export function agentAiRouteLabel(route: AgentAiRoute): string {
  if (route.kind === 'hosted-managed') return `Agentic hosted AI (${hostedManagedLabel(route.status)})`;
  if (route.kind === 'hosted-byok') {
    return `Hosted BYOK (${agentProviderLabel(route.config.provider)} - ${route.config.model})`;
  }
  if (route.kind === 'bridge') {
    const provider = route.status.provider?.trim() || route.status.apiFormat?.trim() || 'local bridge AI';
    const model = route.status.model?.trim();
    return model ? `${provider} - ${model}` : provider;
  }
  if (route.config?.path === 'hosted-byok') {
    return route.signedIn ? 'Hosted BYOK not reachable' : 'Hosted BYOK requires /sign-in';
  }
  return 'not configured';
}

export async function generateAgentPlan<T = unknown>(
  options: GlobalOptions,
  route: AgentAiRoute,
  request: Record<string, unknown>,
): Promise<T> {
  if (route.kind === 'hosted-managed') {
    return renderWebRequest<T>(options, '/api/ai/generate-plan', {
      method: 'POST',
      body: JSON.stringify({
        settings: { mode: 'hosted-managed' },
        request,
      }),
    }, { label: 'Agentic hosted AI', requireAuth: true });
  }
  if (route.kind === 'hosted-byok') {
    return renderWebRequest<T>(options, '/api/ai/generate-plan', {
      method: 'POST',
      body: JSON.stringify({
        settings: hostedByokSettings(route.config),
        request,
      }),
    }, { label: 'Hosted BYOK AI', requireAuth: true });
  }
  if (route.kind === 'bridge') {
    return bridgeRequest<T>(options, '/bridge/ai/generate-plan', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
  throw new Error(agentAiSetupHint(route));
}

export async function reviewAgentPlan<T = unknown>(
  options: GlobalOptions,
  route: AgentAiRoute,
  request: Record<string, unknown>,
): Promise<T> {
  if (route.kind === 'hosted-managed') {
    return renderWebRequest<T>(options, '/api/ai/review-plan', {
      method: 'POST',
      body: JSON.stringify({
        settings: { mode: 'hosted-managed' },
        request,
      }),
    }, { label: 'Agentic hosted AI', requireAuth: true });
  }
  if (route.kind === 'hosted-byok') {
    return renderWebRequest<T>(options, '/api/ai/review-plan', {
      method: 'POST',
      body: JSON.stringify({
        settings: hostedByokSettings(route.config),
        request,
      }),
    }, { label: 'Hosted BYOK AI', requireAuth: true });
  }
  if (route.kind === 'bridge') {
    return bridgeRequest<T>(options, '/bridge/ai/review-plan', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
  throw new Error(agentAiSetupHint(route));
}

export async function askAgentPlan<T = unknown>(
  options: GlobalOptions,
  route: AgentAiRoute,
  request: Record<string, unknown>,
): Promise<T> {
  if (route.kind === 'hosted-managed') {
    return renderWebRequest<T>(options, '/api/ai/ask-about-plan', {
      method: 'POST',
      body: JSON.stringify({
        settings: { mode: 'hosted-managed' },
        request,
      }),
    }, { label: 'Agentic hosted AI', requireAuth: true });
  }
  if (route.kind === 'hosted-byok') {
    return renderWebRequest<T>(options, '/api/ai/ask-about-plan', {
      method: 'POST',
      body: JSON.stringify({
        settings: hostedByokSettings(route.config),
        request,
      }),
    }, { label: 'Hosted BYOK AI', requireAuth: true });
  }
  if (route.kind === 'bridge') {
    return bridgeRequest<T>(options, '/bridge/ai/ask-about-plan', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
  throw new Error(agentAiSetupHint(route));
}

export function agentAiSetupHint(route: AgentAiRoute): string {
  if (route.kind !== 'none') return '';
  if (route.config?.path === 'hosted-byok') {
    if (!route.signedIn) {
      return 'Hosted BYOK is configured. Run /sign-in, then try /agent again.';
    }
    return 'Hosted BYOK is configured, but the hosted AI API is not reachable. Run /agent-setup and choose Local Bridge, or try again later.';
  }
  return 'Agent is not configured. Run /agent-setup to add a provider key.';
}

function hostedByokSettings(config: AgentAiConfig): Record<string, string> {
  return {
    apiKey: config.apiKey,
    provider: config.provider,
    apiFormat: config.apiFormat,
    baseUrl: config.baseUrl,
    model: config.model,
  };
}

async function loadAgentAiConfig(options: GlobalOptions): Promise<AgentAiConfig | null> {
  const fileValues = await readAgentEnvValues(options.envPath);
  const value = (key: string): string => {
    const fromProcess = process.env[key]?.trim();
    if (fromProcess) return fromProcess;
    return fileValues[key]?.trim() ?? '';
  };
  const apiKey = normalizeAgentApiKey(value('AGENTIC_AI_API_KEY'));
  if (!apiKey) return null;
  const providerRaw = value('AGENTIC_AI_PROVIDER') || 'openai';
  const preset = aiProviderPresetById(providerRaw);
  const provider = providerRaw || preset.id;
  const apiFormat = normalizeAgentApiFormat(value('AGENTIC_AI_API_FORMAT'), preset.apiFormat);
  const baseUrl = value('AGENTIC_AI_BASE_URL') || preset.baseUrl;
  const model = value('AGENTIC_AI_MODEL') || preset.model;
  return {
    apiKey,
    path: normalizeAgentAiPath(value('AGENTIC_AI_PATH')),
    provider,
    apiFormat,
    baseUrl,
    model,
  };
}

async function readAgentEnvValues(path: string): Promise<Record<string, string>> {
  try {
    return parseAgentEnvValues(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

function parseAgentEnvValues(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]!] = unquoteAgentEnvValue(match[2] ?? '');
  }
  return values;
}

function unquoteAgentEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeAgentApiKey(value: string): string {
  return value.replace(/[\s\u200B-\u200D\u2060\uFEFF]+/gu, '');
}

function agentProviderLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'anthropic') return 'Anthropic';
  if (normalized === 'gemini') return 'Gemini';
  if (normalized === 'openrouter') return 'OpenRouter';
  if (normalized === 'custom-openai-compatible') return 'Custom OpenAI-compatible';
  if (normalized === 'openai') return 'OpenAI';
  return provider.trim() || 'AI';
}
