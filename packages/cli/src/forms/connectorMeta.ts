import { CONNECTOR_SPECS, type ConnectorSpec, type ConnectorSpecInput, type ConnectorReadCapability } from './connectorSpecs.generated.js';

// Connectors that require a BYO API key (or an activation code in Phoenix's
// case). Surfaced in /connectors so the user can paste a key, and in
// /new-connector so disabled keyed connectors prompt setup first.
const KEY_REQUIRED: Record<string, { envVar: string; label: string }> = {
  lulo:      { envVar: 'LULO_API_KEY',        label: 'Lulo API key' },
  sanctum:   { envVar: 'SANCTUM_API_KEY',     label: 'Sanctum API key' },
  magiceden: { envVar: 'MAGICEDEN_API_KEY',   label: 'Magic Eden API key' },
  tensor:    { envVar: 'TENSOR_API_KEY',      label: 'Tensor API key' },
  phoenix:   { envVar: 'PHOENIX_ACCESS_CODE', label: 'Phoenix activation code' },
};

export const BYO_KEY_CONNECTOR_IDS = ['magiceden', 'tensor', 'sanctum', 'lulo', 'phoenix'] as const;
export type ByoKeyConnectorId = (typeof BYO_KEY_CONNECTOR_IDS)[number];

export function isByoKeyConnectorId(value: string): value is ByoKeyConnectorId {
  return (BYO_KEY_CONNECTOR_IDS as readonly string[]).includes(value);
}

// Derived from spec: any connector whose writeCapabilities include an action
// whose kind matches /recurring/. Today that's Jupiter (recurring create/cancel
// /deposit/withdraw orders); new entries flow in automatically when the spec
// is regenerated.
function deriveRecurringCapable(): Set<string> {
  const ids = new Set<string>();
  for (const spec of CONNECTOR_SPECS) {
    if (spec.writeCapabilities.some((w) => /recurring/i.test(w.actionKind))) {
      ids.add(spec.id);
    }
  }
  return ids;
}
const RECURRING_CAPABLE: Set<string> = deriveRecurringCapable();

// Display order — the order /new-connector and /connectors render the list.
// Keeps high-traffic connectors at the top.
const DISPLAY_ORDER = [
  'jupiter',
  'marinade',
  'jito',
  'sanctum',
  'lulo',
  'kamino',
  'marginfi',
  'project0',
  'save',
  'raydium',
  'orca',
  'meteora',
  'magiceden',
  'tensor',
  'realms',
  'squads',
  'wormhole',
  'phoenix',
  'pyth',
  'drift',
];

export interface ConnectorSummary {
  id: string;
  name: string;
  status: string;
  needsKey: boolean;
  keyLabel?: string;
  envVar?: string;
  recurringCapable: boolean;
  actionCount: number;
}

export type ActionTier = 'first_class' | 'blink' | 'read_only';

export interface ConnectorAction {
  actionKind: string;
  label: string;
  implemented: boolean;
  summary: string;
  tier: ActionTier;
  /** Set when tier === 'read_only'; identifies the bridge tool that produces the read snapshot. */
  toolName?: string;
}

export function listConnectors(): ConnectorSummary[] {
  const byId = new Map<string, ConnectorSpec>(CONNECTOR_SPECS.map((s) => [s.id, s]));
  const ordered: ConnectorSummary[] = [];
  for (const id of DISPLAY_ORDER) {
    const spec = byId.get(id);
    if (!spec) continue;
    ordered.push(summarize(spec));
    byId.delete(id);
  }
  for (const spec of byId.values()) {
    ordered.push(summarize(spec));
  }
  return ordered;
}

export function getConnector(connectorId: string): ConnectorSpec | undefined {
  return CONNECTOR_SPECS.find((s) => s.id === connectorId);
}

export function listActions(connectorId: string, implementedOnly = true): ConnectorAction[] {
  const spec = getConnector(connectorId);
  if (!spec) return [];
  const writes: ConnectorAction[] = spec.writeCapabilities
    .filter((w) => (implementedOnly ? w.implemented : true))
    .map((w) => ({
      actionKind: w.actionKind,
      label: humanizeActionKind(w.actionKind, spec.id),
      implemented: w.implemented,
      summary: w.summary,
      tier: w.executionMode === 'blink' ? ('blink' as ActionTier) : ('first_class' as ActionTier),
    }));
  const reads: ConnectorAction[] = spec.readCapabilities
    .filter((r) => (implementedOnly ? r.implemented : true))
    .map((r) => ({
      actionKind: r.toolName,
      label: humanizeToolName(r.toolName, spec.id),
      implemented: r.implemented,
      summary: r.summary,
      tier: 'read_only' as ActionTier,
      toolName: r.toolName,
    }));
  return [...writes, ...reads];
}

export function listReadCapabilities(connectorId: string): ConnectorReadCapability[] {
  const spec = getConnector(connectorId);
  return spec?.readCapabilities ?? [];
}

export function requiredUserInputsForAction(connectorId: string, actionKind: string): ConnectorSpecInput[] {
  const spec = getConnector(connectorId);
  if (!spec) return [];
  return spec.requiredUserInputs.filter((i) => i.appliesTo.includes(actionKind));
}

export function listRecurringConnectors(): ConnectorSummary[] {
  return listConnectors().filter((c) => c.recurringCapable);
}

function summarize(spec: ConnectorSpec): ConnectorSummary {
  const key = KEY_REQUIRED[spec.id];
  return {
    id: spec.id,
    name: spec.name,
    status: spec.status,
    needsKey: Boolean(key),
    ...(key?.label ? { keyLabel: key.label } : {}),
    ...(key?.envVar ? { envVar: key.envVar } : {}),
    recurringCapable: RECURRING_CAPABLE.has(spec.id),
    actionCount: spec.writeCapabilities.filter((w) => w.implemented).length,
  };
}

export function humanizeActionKind(actionKind: string, connectorId?: string): string {
  let label = actionKind;
  if (connectorId && label.startsWith(`${connectorId}_`)) {
    label = label.slice(connectorId.length + 1);
  }
  return label
    .split('_')
    .map((part) => (part.length === 0 ? '' : part[0]!.toUpperCase() + part.slice(1)))
    .join(' ');
}

// MCP tool names look like `solana_<connector>_<rest>`; strip the prefix and
// humanize the suffix so "solana_drift_user_snapshot" → "User Snapshot".
export function humanizeToolName(toolName: string, connectorId?: string): string {
  let label = toolName;
  if (label.startsWith('solana_')) label = label.slice('solana_'.length);
  if (connectorId && label.startsWith(`${connectorId}_`)) {
    label = label.slice(connectorId.length + 1);
  }
  return label
    .split('_')
    .map((part) => (part.length === 0 ? '' : part[0]!.toUpperCase() + part.slice(1)))
    .join(' ');
}
