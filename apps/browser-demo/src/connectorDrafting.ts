import type { AgentPlanTemplate } from './planner.js';
import {
  PROTOCOL_CONNECTORS,
  connectorHasCapability,
  findProtocolConnectorByInput,
  getAdapterMeta,
  isClusterSupported,
  isDappEnabled,
  protocolConnectorPlannerContext,
  type ConnectedDappsState,
  type ProtocolConnector,
  type ProtocolConnectorId,
} from './connectedDapps.js';
import { normalizeBlinkUrl } from './protocolActions.js';

export type ConnectorDraftMode = 'template' | 'ai';

export interface ConnectorDraftEnvironment {
  connectedDapps: ConnectedDappsState;
  cluster: string;
  dialectClientKeyConfigured?: boolean;
}

export interface ConnectorDraftValidationResult {
  connector?: ProtocolConnector;
  parameters: Record<string, string>;
  errors: Record<string, string>;
  missingFacts: string[];
}

export function isConnectorCapableTemplate(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'>,
): boolean {
  return template.id === 'protocol-blink-action' ||
    template.actionType === 'blink_action' ||
    template.connectorCapability === 'blink_actions';
}

export function selectedConnectorForDraftParameters(
  parameters: Record<string, string>,
): ProtocolConnector | undefined {
  const protocol = parameters.protocol?.trim();
  const byProtocol = protocolConnectorById(protocol) ?? findProtocolConnectorByInput(protocol);
  if (byProtocol) return byProtocol;
  const byConnectorId = protocolConnectorById(parameters.connectorId?.trim());
  if (byConnectorId) return byConnectorId;
  return findProtocolConnectorByInput(
    parameters.dapp || parameters.provider || parameters.route,
  );
}

export function connectorDraftConnectors(
  env: ConnectorDraftEnvironment,
): ProtocolConnector[] {
  return PROTOCOL_CONNECTORS
    .filter((connector) => connectorHasCapability(connector, 'blink_actions'))
    .slice()
    .sort((left, right) => {
      const leftRank = connectorDraftRank(left, env);
      const rightRank = connectorDraftRank(right, env);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.name.localeCompare(right.name);
    });
}

export function connectorDraftStatus(
  connector: ProtocolConnector,
  env: ConnectorDraftEnvironment,
): {
  selectable: boolean;
  enabled: boolean;
  clusterSupported: boolean;
  label: string;
  detail: string;
  meta: string;
} {
  const clusterSupported = isClusterSupported(connector, env.cluster);
  const enabled = isDappEnabled(connector.id, env.connectedDapps, env.cluster);
  const hasBlink = connectorHasCapability(connector, 'blink_actions');
  if (!hasBlink) {
    return {
      selectable: false,
      enabled: false,
      clusterSupported,
      label: 'Unavailable',
      meta: 'Unsupported',
      detail: `${connector.name} does not expose Blink actions in this connector catalog.`,
    };
  }
  if (!clusterSupported) {
    return {
      selectable: false,
      enabled: false,
      clusterSupported,
      label: 'Wrong cluster',
      meta: 'Unavailable',
      detail: `${connector.name} is available on ${connector.supportedClusters.join(', ')} only.`,
    };
  }
  if (!enabled) {
    return {
      selectable: false,
      enabled: false,
      clusterSupported,
      label: 'Connector disabled',
      meta: 'Off',
      detail: `${connector.name} is disabled. Enable it in Protocol Connectors before preparing executable work.`,
    };
  }
  return {
    selectable: true,
    enabled: true,
    clusterSupported,
    label: connector.actionSource === 'first-class-adapter' ? 'First-class adapter' : 'Blink-backed',
    meta: connector.actionSource === 'first-class-adapter' ? 'First-class' : 'Blink connector',
    detail: connector.actionSource === 'first-class-adapter'
      ? 'First-class adapter. Agentic can prepare connector-backed work; wallet still signs after review.'
      : 'Blink-backed. Requires an action URL. Wallet signs only after review.',
  };
}

export function normalizeConnectorDraftParameters(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'>,
  parameters: Record<string, string>,
): Record<string, string> {
  if (!isConnectorCapableTemplate(template)) return { ...parameters };
  const connector = selectedConnectorForDraftParameters(parameters);
  if (!connector) return { ...parameters };
  const operation = normalizedConnectorOperation(connector, parameters.operation);
  return {
    ...parameters,
    connectorId: connector.id,
    protocol: connector.name,
    operation,
    connectorActionSource: connector.actionSource ?? 'blink',
  };
}

export function stripConnectorDraftExtras(
  template: Pick<AgentPlanTemplate, 'fields'>,
  parameters: Record<string, string>,
): Record<string, string> {
  const next = { ...parameters };
  const fieldIds = new Set(template.fields.map((field) => field.id));
  for (const key of ['connectorId', 'connectorActionSource', 'dapp', 'provider', 'actionUrl']) {
    if (!fieldIds.has(key)) delete next[key];
  }
  for (const key of ['protocol', 'operation', 'blinkUrl', 'position']) {
    if (!fieldIds.has(key)) delete next[key];
  }
  return next;
}

export function validateConnectorDraftParameters(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'>,
  parameters: Record<string, string>,
  env: ConnectorDraftEnvironment,
  mode: ConnectorDraftMode,
): ConnectorDraftValidationResult {
  const normalized = normalizeConnectorDraftParameters(template, parameters);
  if (!isConnectorCapableTemplate(template)) {
    return { parameters: normalized, errors: {}, missingFacts: [] };
  }

  const errors: Record<string, string> = {};
  const missingFacts: string[] = [];
  const connector = selectedConnectorForDraftParameters(normalized);
  if (!connector) {
    errors.protocol = 'Choose one enabled Protocol Connector before preparing a Blink action.';
    missingFacts.push('protocol connector');
    return { parameters: normalized, errors, missingFacts };
  }
  if (!connectorHasCapability(connector, 'blink_actions')) {
    errors.protocol = `${connector.name} does not expose Blink actions in this connector catalog.`;
  } else if (!isClusterSupported(connector, env.cluster)) {
    errors.protocol = `${connector.name} is only available on ${connector.supportedClusters.join(', ')}; current cluster is ${env.cluster}.`;
  } else if (!isDappEnabled(connector.id, env.connectedDapps, env.cluster)) {
    errors.protocol = `${connector.name} is not enabled. Enable it in Protocol Connectors before sending.`;
  }

  const url = normalized.blinkUrl?.trim() || normalized.actionUrl?.trim() || '';
  if (!url) {
    missingFacts.push('Blink/Solana Action URL');
    if (mode === 'template') {
      errors.blinkUrl = `${connector.name} requires a Blink/Solana Action URL for executable work.`;
    }
  } else {
    try {
      normalized.blinkUrl = normalizeBlinkUrl(url);
    } catch (err) {
      errors.blinkUrl = err instanceof Error ? err.message : 'Blink/Solana Action URL is invalid.';
    }
  }

  if (!normalized.operation?.trim()) missingFacts.push('operation');
  return { connector, parameters: normalized, errors, missingFacts };
}

export function connectorAiPlannerContext(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'>,
  parameters: Record<string, string>,
  env: ConnectorDraftEnvironment,
): Array<Record<string, unknown>> {
  if (!isConnectorCapableTemplate(template)) {
    return protocolConnectorPlannerContext(env.connectedDapps, env.cluster, {
      dialectClientKeyConfigured: Boolean(env.dialectClientKeyConfigured),
      includeDisabled: true,
    });
  }
  const selected = selectedConnectorForDraftParameters(parameters);
  if (!selected) return [];
  const validation = validateConnectorDraftParameters(template, parameters, env, 'ai');
  const base = protocolConnectorPlannerContext(env.connectedDapps, env.cluster, {
    dialectClientKeyConfigured: Boolean(env.dialectClientKeyConfigured),
    includeDisabled: true,
  }).find((entry) => entry.id === selected.id) ?? {};
  return [{
    ...base,
    selected: true,
    selectedOnly: true,
    id: selected.id,
    name: selected.name,
    selectedOperation: validation.parameters.operation || '',
    selectedActionSource: selected.actionSource ?? 'blink',
    suppliedFields: {
      blinkUrl: validation.parameters.blinkUrl || validation.parameters.actionUrl || '',
      position: validation.parameters.position || '',
      amount: validation.parameters.amount || '',
      memo: validation.parameters.memo || '',
    },
    missingFacts: validation.missingFacts,
    strictInstruction:
      'Use the selected protocol connector only. Do not switch protocols. If required connector facts are missing, ask for the missing facts instead of inventing execution. Do not claim the action is signed, submitted, approved, or safe. The wallet owner must approve separately.',
  }];
}

export function connectorAiUserNotes(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'>,
  parameters: Record<string, string>,
  userNotes: string,
): string {
  if (!isConnectorCapableTemplate(template)) return userNotes;
  const connector = selectedConnectorForDraftParameters(parameters);
  if (!connector) return userNotes;
  const steering = [
    `Selected protocol connector: ${connector.name} (${connector.id}).`,
    `Selected operation: ${parameters.operation || 'not supplied'}.`,
    'Use this connector only; do not switch protocols.',
    'If the Blink/Solana Action URL, position, amount, or other required fact is missing, ask for that fact instead of inventing execution.',
    'Wallet approval remains separate.',
  ].join(' ');
  return [steering, userNotes.trim()].filter(Boolean).join('\n\n');
}

function connectorDraftRank(connector: ProtocolConnector, env: ConnectorDraftEnvironment): number {
  const status = connectorDraftStatus(connector, env);
  if (status.selectable) return 0;
  if (status.clusterSupported) return 1;
  return 2;
}

function normalizedConnectorOperation(connector: ProtocolConnector, value: string | undefined): string {
  const requested = value?.trim() ?? '';
  if (!requested) return connector.supportedActions[0] ?? '';
  const normalized = normalizeActionLabel(requested);
  return connector.supportedActions.find((action) => normalizeActionLabel(action) === normalized) ??
    requested;
}

function protocolConnectorById(value: string | undefined): ProtocolConnector | undefined {
  const id = value?.trim() ?? '';
  if (!id) return undefined;
  return getAdapterMeta(id as ProtocolConnectorId);
}

function normalizeActionLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
