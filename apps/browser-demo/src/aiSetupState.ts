import type { AiSettings, BridgeAiStatus } from './planner.js';
import {
  deviceAgentStatusReadyForDrafts,
  type DeviceAgentStatus,
} from './deviceAgentClient.js';

export type AiPathMode = AiSettings['mode'];

export interface AiPathSetupSnapshot {
  mode: AiPathMode;
  active: boolean;
  staged?: boolean;
  configured: boolean;
  runnable: boolean;
  provider?: string;
  apiFormat?: string;
  baseUrl?: string;
  model?: string;
  detail?: string;
  logoHint?: AiRailLogoHint;
}

export interface AiSetupInventory {
  active: AiPathSetupSnapshot;
  paths: AiPathSetupSnapshot[];
  inactiveConfigured: AiPathSetupSnapshot[];
  anyConfigured: boolean;
}

export type AiPathClearability = Record<AiPathMode, boolean>;
export type AiRailLogoHint = 'agentRouter' | 'agentic' | 'antigravity' | 'claude' | 'codex' | 'gemini';

export interface AiRailIdentity {
  path: AiPathMode;
  pathLabel: string;
  provider: string;
  model: string;
  detail: string;
  configured: boolean;
  staged: boolean;
  inactive: boolean;
  statusLabel: string;
  statusTone: 'confirmed' | 'configured' | 'staged' | 'inactive' | 'optional';
  statusTitle: string;
  logoHint: AiRailLogoHint;
}

export type AiRailQuickActionKind = 'setup' | 'clear-key' | 'disconnect-plan-connector' | 'none';

export function directAiKeyStaged(input: {
  apiKey: string;
  model: string;
  providerReady: boolean;
}): boolean {
  return Boolean(input.apiKey.trim() && input.model.trim() && input.providerReady);
}

export function deviceAgentConfiguredForRequests(input: {
  status: DeviceAgentStatus | null | undefined;
  visible: boolean;
}): boolean {
  return Boolean(input.visible && input.status?.available && input.status.configured);
}

export function deviceAgentNeedsStartForRequests(input: {
  status: DeviceAgentStatus | null | undefined;
  visible: boolean;
}): boolean {
  return deviceAgentConfiguredForRequests(input) && !deviceAgentStatusReadyForDrafts(input.status);
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
  const inactiveConfigured = paths.filter((path) => !path.active && (path.configured || path.staged));
  return {
    active,
    paths,
    inactiveConfigured,
    anyConfigured: active.configured || Boolean(active.staged) || inactiveConfigured.length > 0,
  };
}

export function chatTabEnabledByAiConnection(input: {
  inventory: AiSetupInventory;
  plannerConfirmed: boolean;
  bridgeStatus: BridgeAiStatus | null | undefined;
  pairedBridge: boolean;
}): boolean {
  if (input.pairedBridge) return true;
  if (bridgeStatusIsConnectedPlanConnector(input.bridgeStatus)) return true;
  const active = input.inventory.active;
  if (!input.plannerConfirmed || !active.configured) return false;
  return !(active.mode === 'bridge' && input.bridgeStatus?.engine === 'connector');
}

function bridgeStatusIsConnectedPlanConnector(status: BridgeAiStatus | null | undefined): boolean {
  return Boolean(
    status?.engine === 'connector' &&
      status.available &&
      status.connectorAuthStatus === 'connected',
  );
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

export function aiRailQuickActionKind(input: {
  pairedBridge: boolean;
  configured: boolean;
  inactive: boolean;
  clearTarget: AiPathMode | null;
}): AiRailQuickActionKind {
  if (input.pairedBridge) return 'disconnect-plan-connector';
  if (input.configured || input.inactive) {
    return input.clearTarget ? 'clear-key' : 'none';
  }
  return 'setup';
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
      logoHint: aiProviderLogoHint({
        engine: input.status.engine,
        connector: input.status.connector,
      }),
    };
  }
  const provider = input.status?.provider ?? input.status?.apiFormat;
  const model = input.status?.model;
  return {
    configured,
    runnable: Boolean(input.status?.available),
    provider,
    apiFormat: input.status?.apiFormat,
    baseUrl: input.status?.baseUrl,
    model,
    detail: configured
      ? `${provider ?? 'AI'} - ${model ?? 'model configured'}`
      : undefined,
    logoHint: aiProviderLogoHint({
      provider,
      baseUrl: input.status?.baseUrl,
      model,
    }),
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
  pairedBridge?: boolean;
  stagedKey?: boolean;
  stagedProvider?: string;
  stagedModel?: string;
  stagedLogoHint?: AiRailLogoHint;
  pairedProvider?: string;
  pairedModel?: string;
  pairedLogoHint?: AiRailLogoHint;
}): Omit<AiPathSetupSnapshot, 'mode' | 'active'> {
  if (input.pairedBridge) {
    const provider = cleanAiRailValue(input.pairedProvider)
      ?? cleanAiRailValue(input.status?.provider)
      ?? 'Plan Connector';
    const model = cleanAiRailValue(input.pairedModel)
      ?? cleanAiRailValue(input.status?.model)
      ?? 'computer plan connected';
    return {
      configured: true,
      runnable: true,
      provider,
      apiFormat: input.status?.apiFormat,
      baseUrl: input.status?.baseUrl,
      model,
      detail: `${provider} - ${model}`,
      logoHint: input.pairedLogoHint ?? aiProviderLogoHint({ provider, model }),
    };
  }
  const configured = deviceAgentConfiguredForRequests(input);
  const provider = input.status?.provider ?? input.status?.apiFormat;
  const model = input.status?.model;
  if (!configured && input.stagedKey) {
    const stagedProvider = cleanAiRailValue(input.stagedProvider) ?? cleanAiRailValue(provider) ?? 'AI provider';
    const stagedModel = cleanAiRailValue(input.stagedModel) ?? cleanAiRailValue(model) ?? 'model selected';
    return {
      staged: true,
      configured: false,
      runnable: false,
      provider: stagedProvider,
      apiFormat: input.status?.apiFormat,
      baseUrl: input.status?.baseUrl,
      model: stagedModel,
      detail: `${stagedProvider} - ${stagedModel}`,
      logoHint: input.stagedLogoHint ?? aiProviderLogoHint({ provider: stagedProvider, model: stagedModel }),
    };
  }
  return {
    configured,
    runnable: configured && deviceAgentStatusReadyForDrafts(input.status),
    provider,
    apiFormat: input.status?.apiFormat,
    baseUrl: input.status?.baseUrl,
    model,
    detail: configured
      ? `${provider ?? 'AI'} - ${model ?? 'model configured'}`
      : undefined,
    logoHint: aiProviderLogoHint({
      provider,
      baseUrl: input.status?.baseUrl,
      model,
    }),
  };
}

export function aiProviderLogoHint(input: {
  provider?: string;
  baseUrl?: string;
  model?: string;
  engine?: BridgeAiStatus['engine'];
  connector?: BridgeAiStatus['connector'];
}): AiRailLogoHint {
  if (input.engine === 'connector') {
    switch (input.connector) {
      case 'codex':
        return 'codex';
      case 'gemini':
        return 'gemini';
      case 'antigravity':
        return 'antigravity';
      case 'claude':
        return 'claude';
      default:
        return 'agentRouter';
    }
  }

  const provider = normalizeAiRailText(input.provider);
  const baseUrl = normalizeAiRailText(input.baseUrl);
  const model = normalizeAiRailText(input.model);
  const joined = `${provider} ${baseUrl} ${model}`.trim();

  if (/\b(anthropic|claude)\b/u.test(joined)) return 'claude';
  if (/\b(gemini|google|antigravity)\b/u.test(joined)) return 'gemini';
  if (/\b(openrouter|openai compatible|openai-compatible|custom)\b/u.test(joined)) return 'agentRouter';
  if (/\b(openai|codex|gpt-[\w.-]+)\b/u.test(joined)) return 'codex';
  return 'agentic';
}

export function buildAiRailIdentity(input: {
  inventory: AiSetupInventory;
  pathLabels: Record<AiPathMode, string>;
  activeFallback: {
    provider?: string;
    model?: string;
    logoHint?: AiRailLogoHint;
  };
  readinessLabel: string;
  confirmationLabel: string;
  confirmed: boolean;
}): AiRailIdentity {
  const active = input.inventory.active;
  const inactiveConfigured = input.inventory.inactiveConfigured[0];
  const activeReadyOrStaged = active.configured || Boolean(active.staged);
  const display = activeReadyOrStaged ? active : inactiveConfigured ?? active;
  const inactive = !activeReadyOrStaged && Boolean(inactiveConfigured);
  const pathLabel = input.pathLabels[display.mode] ?? display.mode;
  const activePathLabel = input.pathLabels[active.mode] ?? active.mode;
  const provider = cleanAiRailValue(display.provider)
    ?? cleanAiRailValue(input.activeFallback.provider)
    ?? 'AI provider';
  const model = cleanAiRailValue(display.model)
    ?? cleanAiRailValue(input.activeFallback.model)
    ?? 'model not selected';
  const configured = Boolean(display.configured);
  const staged = Boolean(display.staged);
  const statusLabel = input.confirmed && active.configured && !inactive
    ? 'confirmed'
    : active.configured
      ? 'configured'
      : active.staged
        ? 'key staged'
      : inactive
        ? display.staged ? 'key staged inactive' : 'configured inactive'
        : 'not configured';
  const statusTone = statusLabel === 'confirmed'
    ? 'confirmed'
    : statusLabel === 'configured'
      ? 'configured'
      : statusLabel === 'key staged'
        ? 'staged'
      : statusLabel === 'configured inactive' || statusLabel === 'key staged inactive'
        ? 'inactive'
        : 'optional';
  const statusTitle = active.configured
    ? `${input.readinessLabel} - ${input.confirmationLabel}`
    : active.staged
      ? `API key staged for ${activePathLabel}. Set and confirm it to configure the runtime.`
    : inactive
      ? display.staged
        ? `${pathLabel} key staged; ${activePathLabel} selected.`
        : `${pathLabel} configured; ${activePathLabel} selected.`
      : 'AI connector optional';

  return {
    path: display.mode,
    pathLabel,
    provider,
    model,
    detail: `${model} - ${pathLabel}`,
    configured,
    staged,
    inactive,
    statusLabel,
    statusTone,
    statusTitle,
    logoHint: (display.configured || display.staged ? display.logoHint : undefined)
      ?? input.activeFallback.logoHint
      ?? aiProviderLogoHint({ provider, model }),
  };
}

function cleanAiRailValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeAiRailText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[_./:-]+/gu, ' ');
}
