import type { AiSettings, BridgeAiStatus } from './planner.js';
import {
  deviceAgentStatusReadyForDrafts,
  type DeviceAgentStatus,
} from './deviceAgentClient.js';

export type AiPathMode = AiSettings['mode'];

export interface AiPathSetupSnapshot {
  mode: AiPathMode;
  active: boolean;
  configured: boolean;
  runnable: boolean;
  provider?: string;
  apiFormat?: string;
  baseUrl?: string;
  model?: string;
  detail?: string;
}

export interface AiSetupInventory {
  active: AiPathSetupSnapshot;
  paths: AiPathSetupSnapshot[];
  inactiveConfigured: AiPathSetupSnapshot[];
  anyConfigured: boolean;
}

export type AiPathClearability = Record<AiPathMode, boolean>;

export function directAiKeyStaged(input: {
  apiKey: string;
  model: string;
  providerReady: boolean;
}): boolean {
  return Boolean(input.apiKey.trim() && input.model.trim() && input.providerReady);
}

export function buildAiSetupInventory(input: {
  activeMode: AiPathMode;
  hosted: Omit<AiPathSetupSnapshot, 'mode' | 'active'>;
  session: Omit<AiPathSetupSnapshot, 'mode' | 'active'>;
  bridge: Omit<AiPathSetupSnapshot, 'mode' | 'active'>;
  deviceAgent: Omit<AiPathSetupSnapshot, 'mode' | 'active'>;
}): AiSetupInventory {
  const paths: AiPathSetupSnapshot[] = [
    { mode: 'hosted', active: input.activeMode === 'hosted', ...input.hosted },
    { mode: 'session', active: input.activeMode === 'session', ...input.session },
    { mode: 'bridge', active: input.activeMode === 'bridge', ...input.bridge },
    { mode: 'device-agent', active: input.activeMode === 'device-agent', ...input.deviceAgent },
  ];
  const active = paths.find((path) => path.active) ?? paths[0]!;
  const inactiveConfigured = paths.filter((path) => !path.active && path.configured);
  return {
    active,
    paths,
    inactiveConfigured,
    anyConfigured: active.configured || inactiveConfigured.length > 0,
  };
}

export function selectAiKeyClearTarget(input: {
  activeMode: AiPathMode;
  inactiveConfigured: Array<Pick<AiPathSetupSnapshot, 'mode'>>;
  clearableByMode: AiPathClearability;
  requestedMode?: AiPathMode;
}): AiPathMode | null {
  if (input.requestedMode) {
    return input.clearableByMode[input.requestedMode] ? input.requestedMode : null;
  }
  if (input.clearableByMode[input.activeMode]) {
    return input.activeMode;
  }
  return input.inactiveConfigured.find((path) => input.clearableByMode[path.mode])?.mode ?? null;
}

export function bridgeAiSetupSnapshot(input: {
  status: BridgeAiStatus | null;
}): Omit<AiPathSetupSnapshot, 'mode' | 'active'> {
  const configured = Boolean(input.status?.configured || input.status?.available);
  if (input.status?.engine === 'connector') {
    const provider = bridgeConnectorDisplayLabel(input.status);
    const model = bridgeConnectorStatusDetail(input.status);
    return {
      configured,
      runnable: Boolean(input.status.available),
      provider,
      model,
      detail: configured ? `${provider} - ${model}` : undefined,
    };
  }
  return {
    configured,
    runnable: Boolean(input.status?.available),
    provider: input.status?.provider ?? input.status?.apiFormat,
    apiFormat: input.status?.apiFormat,
    baseUrl: input.status?.baseUrl,
    model: input.status?.model,
    detail: configured
      ? `${input.status?.provider ?? input.status?.apiFormat ?? 'AI'} - ${input.status?.model ?? 'model configured'}`
      : undefined,
  };
}

export function bridgeConnectorDisplayLabel(status: Pick<BridgeAiStatus, 'connector' | 'connectorLabel'> | null): string {
  if (status?.connectorLabel?.trim()) return status.connectorLabel.trim();
  switch (status?.connector) {
    case 'codex':
      return 'Codex (ChatGPT plan)';
    case 'gemini':
      return 'Gemini (Google AI Pro/Ultra)';
    case 'claude':
      return 'Claude (Agent-SDK credits)';
    default:
      return 'Subscription connector';
  }
}

export function bridgeConnectorStatusDetail(
  status: Pick<BridgeAiStatus, 'connectorAuthStatus'> | null,
): string {
  switch (status?.connectorAuthStatus) {
    case 'connected':
      return 'signed in';
    case 'binary-not-found':
      return 'CLI not installed';
    case 'needs-auth':
      return 'sign-in needed';
    default:
      return 'not checked';
  }
}

export function deviceAgentSetupSnapshot(input: {
  status: DeviceAgentStatus | null;
  visible: boolean;
}): Omit<AiPathSetupSnapshot, 'mode' | 'active'> {
  const configured = Boolean(input.visible && input.status?.available && input.status.configured);
  return {
    configured,
    runnable: configured && deviceAgentStatusReadyForDrafts(input.status),
    provider: input.status?.provider ?? input.status?.apiFormat,
    apiFormat: input.status?.apiFormat,
    baseUrl: input.status?.baseUrl,
    model: input.status?.model,
    detail: configured
      ? `${input.status?.provider ?? input.status?.apiFormat ?? 'AI'} - ${input.status?.model ?? 'model configured'}`
      : undefined,
  };
}
