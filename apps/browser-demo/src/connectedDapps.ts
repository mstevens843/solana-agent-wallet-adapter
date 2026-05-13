// Protocol Connectors — client-side catalog of protocol integrations the
// planner may use before preparing wallet work. First-class adapters map to
// local/MCP actions. Blink connectors map to Solana Actions/Blinks plus read
// APIs, when available.

export const CONNECTED_DAPPS_STORAGE_KEY = 'solana-agent-wallet-connected-dapps-v1';
export const PROTOCOL_CONNECTORS_STORAGE_KEY = 'solana-agent-wallet-protocol-connectors-v2';

export type ProtocolConnectorId =
  | 'kamino'
  | 'jupiter'
  | 'raydium'
  | 'orca'
  | 'meteora'
  | 'marginfi'
  | 'drift'
  | 'lulo'
  | 'save';

export type ConnectedDappId = ProtocolConnectorId;

export type ProtocolConnectorCluster = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
export type ConnectedDappCluster = ProtocolConnectorCluster;

export type ProtocolConnectorCapabilityId =
  | 'first_class_adapter'
  | 'read_positions'
  | 'read_rewards'
  | 'blink_actions'
  | 'read_markets';

export interface ProtocolConnectorCapability {
  id: ProtocolConnectorCapabilityId;
  label: string;
  description: string;
}

export interface ProtocolConnector {
  id: ProtocolConnectorId;
  name: string;
  aliases: string[];
  website: string;
  description: string;
  supportedClusters: ProtocolConnectorCluster[];
  capabilities: ProtocolConnectorCapabilityId[];
  /** Action labels users see in the panel chip list. */
  supportedActions: string[];
  /** Prepared-action kinds owned by this adapter — used for gating. */
  actionKinds: string[];
  /** Read tool names that belong to this adapter — also gated. */
  readTools: string[];
  /** Initial value of `enabled` when the user has not interacted yet. */
  enabledByDefault: boolean;
  /** Two-character logo placeholder. */
  initials: string;
  /** Generic read layer used by the agent, if the connector can read facts. */
  readSource?: 'dialect-markets' | 'meteora-api' | 'first-class-adapter';
  /** Generic transaction layer used by the agent, if the connector can prepare actions. */
  actionSource?: 'blink' | 'first-class-adapter';
  /** Whether read APIs need a configured client key before use. */
  requiresClientKey?: boolean;
}

export type ConnectedDappAdapter = ProtocolConnector;

export interface ProtocolConnectorEntry {
  enabled: boolean;
  enabledAt?: string;
  disabledAt?: string;
}

export type ConnectedDappEntry = ProtocolConnectorEntry;

export interface ProtocolConnectorsState {
  schemaVersion: 2;
  entries: Record<ProtocolConnectorId, ProtocolConnectorEntry>;
}

export type ConnectedDappsState = ProtocolConnectorsState;

export const PROTOCOL_CONNECTOR_CAPABILITIES: Record<
  ProtocolConnectorCapabilityId,
  ProtocolConnectorCapability
> = {
  first_class_adapter: {
    id: 'first_class_adapter',
    label: 'First-class adapter',
    description: 'Agentic owns protocol-specific reads, checks, and prepared actions.',
  },
  read_positions: {
    id: 'read_positions',
    label: 'Read positions',
    description: 'The agent can fetch wallet-specific positions from a connector API.',
  },
  read_rewards: {
    id: 'read_rewards',
    label: 'Read rewards',
    description: 'The agent can show claimable or accrued reward facts when the connector exposes them.',
  },
  blink_actions: {
    id: 'blink_actions',
    label: 'Blink actions',
    description: 'The connector can prepare ready-to-sign transactions through Solana Actions/Blinks.',
  },
  read_markets: {
    id: 'read_markets',
    label: 'Read markets',
    description: 'The agent can fetch market metadata such as APY, liquidity, and action URLs.',
  },
};

export const PROTOCOL_CONNECTORS: ProtocolConnector[] = [
  {
    id: 'kamino',
    name: 'Kamino Finance',
    aliases: ['kamino', 'kamino finance', 'klend', 'kamino lend'],
    website: 'https://app.kamino.finance',
    description:
      'Supply, withdraw, inspect positions, and prepare earnings proof checks for Kamino Lend.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_rewards', 'blink_actions', 'read_markets'],
    supportedActions: ['Deposit', 'Withdraw', 'Positions', 'Earnings proof', 'Claim rewards'],
    actionKinds: ['kamino_deposit', 'kamino_withdraw'],
    readTools: [
      'solana_kamino_get_positions',
      'solana_kamino_prepare_earnings_proof',
      'solana_kamino_reserve_snapshot',
    ],
    enabledByDefault: false,
    initials: 'KM',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    aliases: ['jupiter', 'jup', 'jupiter lend', 'jupiter swap'],
    website: 'https://jup.ag',
    description: 'Swap and lending actions through Blink endpoints, with market and position reads where available.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['read_positions', 'read_rewards', 'blink_actions', 'read_markets'],
    supportedActions: ['Swap', 'Lend earn', 'Lend borrow', 'Withdraw', 'Repay'],
    actionKinds: ['blink_action'],
    readTools: ['dialect_positions', 'dialect_markets'],
    enabledByDefault: false,
    initials: 'JU',
    readSource: 'dialect-markets',
    actionSource: 'blink',
    requiresClientKey: true,
  },
  {
    id: 'raydium',
    name: 'Raydium',
    aliases: ['raydium', 'ray'],
    website: 'https://raydium.io',
    description: 'AMM, CLMM, farm, and staking actions when a supported Blink endpoint is available.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['blink_actions', 'read_markets'],
    supportedActions: ['AMM', 'CLMM', 'Farm', 'Stake RAY'],
    actionKinds: ['blink_action'],
    readTools: ['dialect_markets'],
    enabledByDefault: false,
    initials: 'RY',
    readSource: 'dialect-markets',
    actionSource: 'blink',
    requiresClientKey: true,
  },
  {
    id: 'orca',
    name: 'Orca',
    aliases: ['orca', 'whirlpools', 'orca whirlpools'],
    website: 'https://www.orca.so',
    description: 'Whirlpool liquidity actions through supported Blink endpoints.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['blink_actions', 'read_markets'],
    supportedActions: ['Pools', 'Liquidity', 'Fees'],
    actionKinds: ['blink_action'],
    readTools: ['dialect_markets'],
    enabledByDefault: false,
    initials: 'OR',
    readSource: 'dialect-markets',
    actionSource: 'blink',
    requiresClientKey: true,
  },
  {
    id: 'meteora',
    name: 'Meteora',
    aliases: ['meteora', 'dlmm', 'meteora dlmm'],
    website: 'https://app.meteora.ag',
    description: 'DLMM position status, fee/reward reads, and liquidity actions when connector endpoints expose them.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['read_positions', 'read_rewards', 'blink_actions', 'read_markets'],
    supportedActions: ['DLMM positions', 'Claim fees', 'Add liquidity', 'Withdraw liquidity', 'Close position'],
    actionKinds: ['blink_action'],
    readTools: ['meteora_dlmm_position', 'dialect_positions', 'dialect_markets'],
    enabledByDefault: false,
    initials: 'MT',
    readSource: 'meteora-api',
    actionSource: 'blink',
    requiresClientKey: true,
  },
  {
    id: 'marginfi',
    name: 'MarginFi',
    aliases: ['marginfi', 'mrgn'],
    website: 'https://app.marginfi.com',
    description: 'Lending position reads and borrow/repay/deposit/withdraw actions where available.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['read_positions', 'read_rewards', 'blink_actions', 'read_markets'],
    supportedActions: ['Deposit', 'Withdraw', 'Borrow', 'Repay'],
    actionKinds: ['blink_action'],
    readTools: ['dialect_positions', 'dialect_markets'],
    enabledByDefault: false,
    initials: 'MF',
    readSource: 'dialect-markets',
    actionSource: 'blink',
    requiresClientKey: true,
  },
  {
    id: 'drift',
    name: 'Drift',
    aliases: ['drift', 'drift vaults', 'strategy vaults'],
    website: 'https://app.drift.trade',
    description: 'Strategy vault actions through supported Blink endpoints.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['blink_actions', 'read_markets'],
    supportedActions: ['Strategy vaults', 'Deposit', 'Withdraw'],
    actionKinds: ['blink_action'],
    readTools: ['dialect_markets'],
    enabledByDefault: false,
    initials: 'DF',
    readSource: 'dialect-markets',
    actionSource: 'blink',
    requiresClientKey: true,
  },
  {
    id: 'lulo',
    name: 'Lulo',
    aliases: ['lulo'],
    website: 'https://app.lulo.fi',
    description: 'Protected and boosted deposit positions with available deposit/withdraw Blink actions.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['read_positions', 'read_rewards', 'blink_actions', 'read_markets'],
    supportedActions: ['Deposit', 'Withdraw', 'Rewards'],
    actionKinds: ['blink_action'],
    readTools: ['dialect_positions', 'dialect_markets'],
    enabledByDefault: false,
    initials: 'LU',
    readSource: 'dialect-markets',
    actionSource: 'blink',
    requiresClientKey: true,
  },
  {
    id: 'save',
    name: 'Save',
    aliases: ['save', 'save finance'],
    website: 'https://save.finance',
    description: 'Protected and boosted deposit reads/actions when connector endpoints expose them.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['read_positions', 'read_rewards', 'blink_actions', 'read_markets'],
    supportedActions: ['Deposit', 'Withdraw', 'Rewards'],
    actionKinds: ['blink_action'],
    readTools: ['dialect_positions', 'dialect_markets'],
    enabledByDefault: false,
    initials: 'SV',
    readSource: 'dialect-markets',
    actionSource: 'blink',
    requiresClientKey: true,
  },
];

export const KNOWN_CONNECTED_DAPPS = PROTOCOL_CONNECTORS;

export function emptyConnectedDapps(): ConnectedDappsState {
  const entries = {} as Record<ProtocolConnectorId, ProtocolConnectorEntry>;
  for (const connector of PROTOCOL_CONNECTORS) {
    entries[connector.id] = {
      enabled: connector.enabledByDefault,
      ...(connector.enabledByDefault ? { enabledAt: new Date().toISOString() } : {}),
    };
  }
  return { schemaVersion: 2, entries };
}

export function loadConnectedDapps(): ConnectedDappsState {
  if (typeof window === 'undefined') return emptyConnectedDapps();
  try {
    const raw = window.localStorage.getItem(PROTOCOL_CONNECTORS_STORAGE_KEY);
    if (raw) return normalizeConnectedDapps(JSON.parse(raw));
    const legacyRaw = window.localStorage.getItem(CONNECTED_DAPPS_STORAGE_KEY);
    if (legacyRaw) return normalizeConnectedDapps(JSON.parse(legacyRaw));
    return emptyConnectedDapps();
  } catch {
    return emptyConnectedDapps();
  }
}

export function saveConnectedDapps(state: ConnectedDappsState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PROTOCOL_CONNECTORS_STORAGE_KEY, JSON.stringify(normalizeConnectedDapps(state)));
  } catch {
    // Best-effort browser persistence.
  }
}

export function normalizeConnectedDapps(raw: unknown): ConnectedDappsState {
  if (!raw || typeof raw !== 'object') return emptyConnectedDapps();
  const rawEntries = (raw as { entries?: unknown }).entries;
  const result: Record<ProtocolConnectorId, ProtocolConnectorEntry> = {} as Record<
    ProtocolConnectorId,
    ProtocolConnectorEntry
  >;
  for (const connector of PROTOCOL_CONNECTORS) {
    const candidate =
      rawEntries && typeof rawEntries === 'object'
        ? (rawEntries as Record<string, unknown>)[connector.id]
        : undefined;
    const enabled =
      candidate && typeof candidate === 'object' && 'enabled' in candidate
        ? Boolean((candidate as { enabled?: unknown }).enabled)
        : connector.enabledByDefault;
    const enabledAt =
      candidate && typeof candidate === 'object' && typeof (candidate as { enabledAt?: unknown }).enabledAt === 'string'
        ? ((candidate as { enabledAt: string }).enabledAt)
        : undefined;
    const disabledAt =
      candidate && typeof candidate === 'object' && typeof (candidate as { disabledAt?: unknown }).disabledAt === 'string'
        ? ((candidate as { disabledAt: string }).disabledAt)
        : undefined;
    result[connector.id] = {
      enabled,
      ...(enabledAt && { enabledAt }),
      ...(disabledAt && { disabledAt }),
    };
  }
  return { schemaVersion: 2, entries: result };
}

export function getAdapterMeta(id: ConnectedDappId): ConnectedDappAdapter | undefined {
  return PROTOCOL_CONNECTORS.find((connector) => connector.id === id);
}

export function findAdapterByActionKind(kind: string): ConnectedDappAdapter | undefined {
  return PROTOCOL_CONNECTORS.find((connector) => connector.actionKinds.includes(kind));
}

export function findAdapterByReadTool(tool: string): ConnectedDappAdapter | undefined {
  return PROTOCOL_CONNECTORS.find((connector) => connector.readTools.includes(tool));
}

export function findAdapterForActionOrTool(actionKindOrTool: string): ConnectedDappAdapter | undefined {
  return findAdapterByActionKind(actionKindOrTool) ?? findAdapterByReadTool(actionKindOrTool);
}

export function findProtocolConnectorByInput(value: string | undefined): ProtocolConnector | undefined {
  const normalized = normalizeConnectorSearch(value);
  if (!normalized) return undefined;
  return PROTOCOL_CONNECTORS.find((connector) =>
    connector.id === normalized ||
    connector.aliases.some((alias) => {
      const aliasKey = normalizeConnectorSearch(alias);
      return aliasKey === normalized || normalized.includes(aliasKey);
    }) ||
    normalizeConnectorSearch(connector.name) === normalized ||
    normalized.includes(normalizeConnectorSearch(connector.name)),
  );
}

export function isClusterSupported(adapter: ConnectedDappAdapter, cluster: string): boolean {
  return adapter.supportedClusters.includes(cluster as ConnectedDappCluster);
}

export function connectorHasCapability(
  connector: ConnectedDappAdapter,
  capability: ProtocolConnectorCapabilityId,
): boolean {
  return connector.capabilities.includes(capability);
}

export function isDappEnabled(
  id: ConnectedDappId,
  state: ConnectedDappsState,
  cluster: string,
): boolean {
  const connector = getAdapterMeta(id);
  if (!connector) return false;
  if (!isClusterSupported(connector, cluster)) return false;
  return state.entries[id]?.enabled === true;
}

export interface ConnectedDappCheckOk {
  ok: true;
  adapter: ConnectedDappAdapter;
}

export interface ConnectedDappCheckBlocked {
  ok: false;
  reason: 'disabled' | 'unsupported_cluster' | 'unknown_adapter' | 'missing_capability';
  adapter?: ConnectedDappAdapter;
  message: string;
}

export type ConnectedDappCheck = ConnectedDappCheckOk | ConnectedDappCheckBlocked;

export function checkDappForKind(
  actionKindOrTool: string,
  state: ConnectedDappsState,
  cluster: string,
): ConnectedDappCheck {
  const connector = findAdapterForActionOrTool(actionKindOrTool);
  if (!connector) {
    return {
      ok: false,
      reason: 'unknown_adapter',
      message: `No Protocol Connector is registered for ${actionKindOrTool}.`,
    };
  }
  return checkProtocolConnector(connector.id, state, cluster);
}

export function checkProtocolConnector(
  id: ProtocolConnectorId,
  state: ConnectedDappsState,
  cluster: string,
  capability?: ProtocolConnectorCapabilityId,
): ConnectedDappCheck {
  const connector = getAdapterMeta(id);
  if (!connector) {
    return {
      ok: false,
      reason: 'unknown_adapter',
      message: `No Protocol Connector is registered for ${id}.`,
    };
  }
  if (!isClusterSupported(connector, cluster)) {
    return {
      ok: false,
      reason: 'unsupported_cluster',
      adapter: connector,
      message: `${connector.name} is only available on ${connector.supportedClusters.join(', ')}; current cluster is ${cluster}.`,
    };
  }
  if (state.entries[connector.id]?.enabled !== true) {
    return {
      ok: false,
      reason: 'disabled',
      adapter: connector,
      message: `${connector.name} is not enabled. Enable it in Protocol Connectors before continuing.`,
    };
  }
  if (capability && !connectorHasCapability(connector, capability)) {
    return {
      ok: false,
      reason: 'missing_capability',
      adapter: connector,
      message: `${connector.name} does not expose ${PROTOCOL_CONNECTOR_CAPABILITIES[capability].label}.`,
    };
  }
  return { ok: true, adapter: connector };
}

export function enabledProtocolConnectors(
  state: ConnectedDappsState,
  cluster: string,
): ProtocolConnector[] {
  return PROTOCOL_CONNECTORS.filter((connector) => isDappEnabled(connector.id, state, cluster));
}

export function disabledProtocolConnectors(
  state: ConnectedDappsState,
  cluster: string,
): ProtocolConnector[] {
  return PROTOCOL_CONNECTORS.filter((connector) => !isDappEnabled(connector.id, state, cluster));
}

export function connectedDappsSummary(state: ConnectedDappsState, cluster: string): string {
  const enabled = enabledProtocolConnectors(state, cluster);
  if (enabled.length === 0) {
    return `No protocol connectors enabled · ${PROTOCOL_CONNECTORS.length} available`;
  }
  if (enabled.length === 1) return `${enabled[0]!.name} connector enabled`;
  return `${enabled.length} of ${PROTOCOL_CONNECTORS.length} protocol connectors enabled`;
}

export function protocolConnectorPlannerContext(
  state: ConnectedDappsState,
  cluster: string,
  opts: { dialectClientKeyConfigured?: boolean; includeDisabled?: boolean } = {},
): Array<Record<string, unknown>> {
  const connectors = opts.includeDisabled
    ? PROTOCOL_CONNECTORS.filter((connector) => isClusterSupported(connector, cluster))
    : enabledProtocolConnectors(state, cluster);
  return connectors.map((connector) => {
    const enabled = isDappEnabled(connector.id, state, cluster);
    const readReady = enabled && (connector.requiresClientKey ? Boolean(opts.dialectClientKeyConfigured) : true);
    return {
      id: connector.id,
      name: connector.name,
      enabled,
      aliases: connector.aliases,
      capabilities: connector.capabilities,
      supportedActions: connector.supportedActions,
      readActions: connector.readTools.map((tool) => ({
        tool,
        requiresClientKey: Boolean(connector.requiresClientKey),
        ready: readReady,
      })),
      writeActions: connector.actionKinds.map((kind) => ({
        kind,
        executionMode: connector.actionSource ?? 'none',
        ready: enabled && Boolean(connector.actionSource),
        approvalBoundary: 'prepare_only_wallet_approval_required',
      })),
      readSource: connector.readSource ?? 'none',
      actionSource: connector.actionSource ?? 'none',
      agentUse:
        'Use read actions as facts for answers/reviews. Use write actions only to prepare approval-bound wallet work; never claim the connector can sign or submit without the wallet.',
      readApiReady: readReady,
      readiness: enabled
        ? readReady
          ? 'ready'
          : 'needs_client_key'
        : 'disabled',
      limitation: !enabled
        ? `${connector.name} is not enabled in Protocol Connectors.`
        : connector.requiresClientKey && !opts.dialectClientKeyConfigured
          ? 'Read APIs need a Dialect client key; Blink/action URLs can still be reviewed if supplied.'
          : undefined,
    };
  });
}

export function setConnectedDappEnabled(
  state: ConnectedDappsState,
  id: ConnectedDappId,
  enabled: boolean,
  now: Date = new Date(),
): ConnectedDappsState {
  const connector = getAdapterMeta(id);
  if (!connector) return state;
  const normalized = normalizeConnectedDapps(state);
  const previous = normalized.entries[id] ?? { enabled: connector.enabledByDefault };
  const nextEntry: ConnectedDappEntry = enabled
    ? { enabled: true, enabledAt: now.toISOString(), ...(previous.disabledAt ? { disabledAt: previous.disabledAt } : {}) }
    : { enabled: false, disabledAt: now.toISOString(), ...(previous.enabledAt ? { enabledAt: previous.enabledAt } : {}) };
  return {
    schemaVersion: 2,
    entries: {
      ...normalized.entries,
      [id]: nextEntry,
    },
  };
}

function normalizeConnectorSearch(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
