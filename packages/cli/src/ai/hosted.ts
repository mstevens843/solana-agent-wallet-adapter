import type { GlobalOptions } from '../shared/types.js';
import { loadSession, sessionStatusSummary } from '../auth/sessionStore.js';
import { bridgeRequest, fetchWithTimeout, renderWebRequest, renderWebUrl, tryBridgeRequest } from '../http/index.js';

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

export type AgentAiRoute =
  | { kind: 'hosted-managed'; status: HostedAiStatus }
  | { kind: 'bridge'; status: BridgeAiStatus }
  | { kind: 'none'; hosted: HostedAiStatus | null; bridge: BridgeAiStatus | null; signedIn: boolean };

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
  const [hosted, bridge, session] = await Promise.all([
    getHostedAiStatus(options),
    tryBridgeRequest<BridgeAiStatus>(options, '/bridge/ai/status'),
    loadSession(options).catch(() => null),
  ]);
  const signedIn = sessionStatusSummary(session).authenticated;
  if (signedIn && hostedManagedAvailable(hosted)) {
    return { kind: 'hosted-managed', status: hosted as HostedAiStatus };
  }
  if (bridge.ok && bridge.value.available) {
    return { kind: 'bridge', status: bridge.value };
  }
  return {
    kind: 'none',
    hosted,
    bridge: bridge.ok ? bridge.value : null,
    signedIn,
  };
}

export function agentAiRouteLabel(route: AgentAiRoute): string {
  if (route.kind === 'hosted-managed') return `Agentic hosted AI (${hostedManagedLabel(route.status)})`;
  if (route.kind === 'bridge') {
    const provider = route.status.provider?.trim() || route.status.apiFormat?.trim() || 'local bridge AI';
    const model = route.status.model?.trim();
    return model ? `${provider} - ${model}` : provider;
  }
  if (hostedManagedAvailable(route.hosted) && !route.signedIn) {
    return 'Agentic hosted AI available after /sign-in';
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
  if (hostedManagedAvailable(route.hosted) && !route.signedIn) {
    return 'Agentic hosted AI is available. Run /sign-in, then try /agent again.';
  }
  return 'Agent is not configured. Run /agent-setup to use Agentic hosted AI or add a local provider key.';
}
