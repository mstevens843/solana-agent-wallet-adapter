import { readFile } from 'node:fs/promises';

import type { GlobalOptions } from '../shared/types.js';
import { loadSession, sessionStatusSummary } from '../auth/sessionStore.js';
import { bridgeRequest, fetchWithTimeout, renderWebRequest, renderWebUrl, tryBridgeRequest } from '../http/index.js';
import {
  connectorLabel,
  normalizeAgentConnector,
  type AgentConnector,
} from '@solana-agent-wallet-adapter/mcp-server';
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
  engine?: 'api-key' | 'connector';
  connector?: string;
  connectorLabel?: string;
  connectorBilling?: 'plan-included' | 'metered-credits';
  connectorAuthStatus?: 'connected' | 'needs-auth' | 'binary-not-found';
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

export interface AgentAiConfig {
  apiKey: string;
  path: AgentAiPath;
  provider: string;
  apiFormat: AiApiFormat;
  baseUrl: string;
  model: string;
  engine?: 'api-key' | 'connector';
  connector?: AgentConnector;
  connectorPath?: string;
}

export type AgentAiRoute =
  | { kind: 'hosted-managed'; status: HostedAiStatus }
  | { kind: 'hosted-byok'; config: AgentAiConfig; status: HostedAiStatus | null }
  | { kind: 'bridge'; status: BridgeAiStatus }
  | { kind: 'none'; hosted: HostedAiStatus | null; bridge: BridgeAiStatus | null; signedIn: boolean; config: AgentAiConfig | null };

export interface AgentAiRouteInputs {
  hosted: HostedAiStatus | null;
  bridge: BridgeAiStatus | null;
  signedIn: boolean;
  config: AgentAiConfig | null;
}

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
  const bridge = config?.path === 'hosted-byok'
    ? null
    : await tryBridgeRequest<BridgeAiStatus>(options, '/bridge/ai/status')
        .then((result) => result.ok ? result.value : null);
  return chooseAgentAiRoute({
    hosted,
    bridge,
    signedIn,
    config,
  });
}

export function chooseAgentAiRoute(input: AgentAiRouteInputs): AgentAiRoute {
  const { hosted, bridge, signedIn, config } = input;
  if (config?.path === 'hosted-byok') {
    if (signedIn && hosted?.available) {
      return { kind: 'hosted-byok', config, status: hosted };
    }
    return { kind: 'none', hosted, bridge: null, signedIn, config };
  }
  if (bridge?.available) {
    return { kind: 'bridge', status: bridge };
  }
  if (config?.engine === 'connector') {
    return { kind: 'none', hosted, bridge, signedIn, config };
  }
  if (signedIn && hostedManagedAvailable(hosted)) {
    return { kind: 'hosted-managed', status: hosted ?? {} };
  }
  return { kind: 'none', hosted, bridge, signedIn, config };
}

export function agentAiRouteLabel(route: AgentAiRoute): string {
  if (route.kind === 'hosted-managed') return `Agentic hosted AI (${hostedManagedLabel(route.status)})`;
  if (route.kind === 'hosted-byok') {
    return `Hosted BYOK (${agentProviderLabel(route.config.provider)} - ${route.config.model})`;
  }
  if (route.kind === 'bridge') {
    if (route.status.engine === 'connector' && route.status.connectorLabel) {
      return `Connector · ${route.status.connectorLabel}`;
    }
    const provider = route.status.provider?.trim() || route.status.apiFormat?.trim() || 'local bridge AI';
    const model = route.status.model?.trim();
    return model ? `${provider} - ${model}` : provider;
  }
  // Connector configured on the bridge but not usable yet (CLI missing / not signed in).
  if (route.bridge?.engine === 'connector' && route.bridge.connectorLabel) {
    return route.bridge.connectorAuthStatus === 'binary-not-found'
      ? `Connector · ${route.bridge.connectorLabel} (CLI not installed - run /agent-setup)`
      : `Connector · ${route.bridge.connectorLabel} (sign-in needed - run /agent-setup)`;
  }
  if (route.config?.path === 'hosted-byok') {
    return route.signedIn ? 'Hosted BYOK not reachable' : 'Hosted BYOK requires /sign-in';
  }
  if (route.config?.engine === 'connector' && route.config.connector) {
    return `Connector · ${connectorLabel(route.config.connector)} (local bridge not ready)`;
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

export async function chatAgent<T = unknown>(
  options: GlobalOptions,
  route: AgentAiRoute,
  request: Record<string, unknown>,
): Promise<T> {
  if (route.kind === 'hosted-managed') {
    return renderWebRequest<T>(options, '/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({
        settings: { mode: 'hosted-managed' },
        request,
      }),
    }, { label: 'Agentic hosted AI', requireAuth: true });
  }
  if (route.kind === 'hosted-byok') {
    return renderWebRequest<T>(options, '/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({
        settings: hostedByokSettings(route.config),
        request,
      }),
    }, { label: 'Hosted BYOK AI', requireAuth: true });
  }
  if (route.kind === 'bridge') {
    return bridgeRequest<T>(options, '/bridge/ai/chat', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
  throw new Error(agentAiSetupHint(route));
}

export function agentAiSetupHint(route: AgentAiRoute): string {
  if (route.kind !== 'none') return '';
  if (route.bridge?.engine === 'connector' && route.bridge.connectorLabel) {
    return route.bridge.connectorAuthStatus === 'binary-not-found'
      ? `${route.bridge.connectorLabel} CLI is not installed on the bridge machine. Run /agent-setup or install the CLI.`
      : `${route.bridge.connectorLabel} needs sign-in on the bridge machine. Run /agent-setup to sign in.`;
  }
  if (route.config?.engine === 'connector' && route.config.connector) {
    return `${connectorLabel(route.config.connector)} connector is configured, but the local bridge is not ready. Start the bridge or run /agent-setup.`;
  }
  if (route.config?.path === 'hosted-byok') {
    if (!route.signedIn) {
      return 'Hosted BYOK is configured. Run /sign-in, then try /agent again.';
    }
    return 'Hosted BYOK is configured, but the hosted AI API is not reachable. Run /agent-setup and choose Local Bridge, or try again later.';
  }
  if (!route.signedIn && hostedManagedAvailable(route.hosted)) {
    return 'Agentic hosted AI is available. Run /sign-in, then try /agent again.';
  }
  return 'Agent is not configured. Run /agent-setup to add a provider key or subscription connector.';
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
  if (value('AGENTIC_AI_ENGINE').toLowerCase() === 'connector') {
    const connector = normalizeAgentConnector(value('AGENTIC_AI_CONNECTOR'));
    if (!connector) return null;
    const connectorPath = value('AGENTIC_AI_CONNECTOR_PATH');
    return {
      apiKey: '',
      path: 'bridge',
      provider: `connector:${connector}`,
      apiFormat: 'openai-compatible',
      baseUrl: '',
      model: '',
      engine: 'connector',
      connector,
      ...(connectorPath ? { connectorPath } : {}),
    };
  }
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
