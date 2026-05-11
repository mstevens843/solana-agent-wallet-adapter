// Connected dApps — client-only registry mirroring the per-protocol adapter
// framework on the MCP server side. Toggle Kamino (and future Marinade, Jito,
// Drift, ...) on/off, with cluster gating and a friendly guard that the
// planner consults before dispatching adapter-routed tool calls.
//
// Design notes:
//   * Storage and gating are client-side only — same model as Recipient Rules.
//   * The server-side adapter framework also enforces cluster support, but the
//     client gate gives us a clean refusal card *before* an MCP call leaves
//     the device, which is the better UX.
//   * The action-kind → adapter map is duplicated here intentionally: keeping
//     the browser a thin runtime free of the MCP-server type tree avoids
//     bundling the SDK and Node deps into the demo bundle.

export const CONNECTED_DAPPS_STORAGE_KEY = 'solana-agent-wallet-connected-dapps-v1';

export type ConnectedDappId = 'kamino';

export type ConnectedDappCluster = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';

export interface ConnectedDappAdapter {
  id: ConnectedDappId;
  name: string;
  website: string;
  description: string;
  supportedClusters: ConnectedDappCluster[];
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
}

export interface ConnectedDappEntry {
  enabled: boolean;
  enabledAt?: string;
  disabledAt?: string;
}

export interface ConnectedDappsState {
  entries: Record<ConnectedDappId, ConnectedDappEntry>;
}

export const KNOWN_CONNECTED_DAPPS: ConnectedDappAdapter[] = [
  {
    id: 'kamino',
    name: 'Kamino Finance',
    website: 'https://app.kamino.finance',
    description:
      "Supply SOL or SPL tokens to a Kamino Lend reserve and earn supply APY. Plain-English presign review with pool health.",
    supportedClusters: ['mainnet-beta'],
    supportedActions: ['Deposit', 'Withdraw', 'Positions', 'Earnings proof'],
    actionKinds: ['kamino_deposit', 'kamino_withdraw'],
    readTools: [
      'solana_kamino_get_positions',
      'solana_kamino_prepare_earnings_proof',
      'solana_kamino_reserve_snapshot',
    ],
    enabledByDefault: false,
    initials: 'KM',
  },
];

export function emptyConnectedDapps(): ConnectedDappsState {
  const entries = {} as Record<ConnectedDappId, ConnectedDappEntry>;
  for (const adapter of KNOWN_CONNECTED_DAPPS) {
    entries[adapter.id] = {
      enabled: adapter.enabledByDefault,
      ...(adapter.enabledByDefault ? { enabledAt: new Date().toISOString() } : {}),
    };
  }
  return { entries };
}

export function loadConnectedDapps(): ConnectedDappsState {
  if (typeof window === 'undefined') return emptyConnectedDapps();
  try {
    const raw = window.localStorage.getItem(CONNECTED_DAPPS_STORAGE_KEY);
    if (!raw) return emptyConnectedDapps();
    return normalizeConnectedDapps(JSON.parse(raw));
  } catch {
    return emptyConnectedDapps();
  }
}

export function saveConnectedDapps(state: ConnectedDappsState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONNECTED_DAPPS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort browser persistence.
  }
}

export function normalizeConnectedDapps(raw: unknown): ConnectedDappsState {
  if (!raw || typeof raw !== 'object') return emptyConnectedDapps();
  const rawEntries = (raw as { entries?: unknown }).entries;
  const result: Record<ConnectedDappId, ConnectedDappEntry> = {} as Record<
    ConnectedDappId,
    ConnectedDappEntry
  >;
  for (const adapter of KNOWN_CONNECTED_DAPPS) {
    const candidate =
      rawEntries && typeof rawEntries === 'object'
        ? (rawEntries as Record<string, unknown>)[adapter.id]
        : undefined;
    const enabled =
      candidate && typeof candidate === 'object' && 'enabled' in candidate
        ? Boolean((candidate as { enabled?: unknown }).enabled)
        : adapter.enabledByDefault;
    const enabledAt =
      candidate && typeof candidate === 'object' && typeof (candidate as { enabledAt?: unknown }).enabledAt === 'string'
        ? ((candidate as { enabledAt: string }).enabledAt)
        : undefined;
    const disabledAt =
      candidate && typeof candidate === 'object' && typeof (candidate as { disabledAt?: unknown }).disabledAt === 'string'
        ? ((candidate as { disabledAt: string }).disabledAt)
        : undefined;
    result[adapter.id] = {
      enabled,
      ...(enabledAt && { enabledAt }),
      ...(disabledAt && { disabledAt }),
    };
  }
  return { entries: result };
}

export function getAdapterMeta(id: ConnectedDappId): ConnectedDappAdapter | undefined {
  return KNOWN_CONNECTED_DAPPS.find((adapter) => adapter.id === id);
}

export function findAdapterByActionKind(kind: string): ConnectedDappAdapter | undefined {
  return KNOWN_CONNECTED_DAPPS.find((adapter) => adapter.actionKinds.includes(kind));
}

export function findAdapterByReadTool(tool: string): ConnectedDappAdapter | undefined {
  return KNOWN_CONNECTED_DAPPS.find((adapter) => adapter.readTools.includes(tool));
}

export function findAdapterForActionOrTool(actionKindOrTool: string): ConnectedDappAdapter | undefined {
  return findAdapterByActionKind(actionKindOrTool) ?? findAdapterByReadTool(actionKindOrTool);
}

export function isClusterSupported(adapter: ConnectedDappAdapter, cluster: string): boolean {
  return adapter.supportedClusters.includes(cluster as ConnectedDappCluster);
}

export function isDappEnabled(
  id: ConnectedDappId,
  state: ConnectedDappsState,
  cluster: string,
): boolean {
  const adapter = getAdapterMeta(id);
  if (!adapter) return false;
  if (!isClusterSupported(adapter, cluster)) return false;
  return state.entries[id]?.enabled === true;
}

export interface ConnectedDappCheckOk {
  ok: true;
  adapter: ConnectedDappAdapter;
}

export interface ConnectedDappCheckBlocked {
  ok: false;
  reason: 'disabled' | 'unsupported_cluster' | 'unknown_adapter';
  adapter?: ConnectedDappAdapter;
  message: string;
}

export type ConnectedDappCheck = ConnectedDappCheckOk | ConnectedDappCheckBlocked;

export function checkDappForKind(
  actionKindOrTool: string,
  state: ConnectedDappsState,
  cluster: string,
): ConnectedDappCheck {
  const adapter = findAdapterForActionOrTool(actionKindOrTool);
  if (!adapter) {
    return {
      ok: false,
      reason: 'unknown_adapter',
      message: `No Connected dApp is registered for ${actionKindOrTool}.`,
    };
  }
  if (!isClusterSupported(adapter, cluster)) {
    return {
      ok: false,
      reason: 'unsupported_cluster',
      adapter,
      message: `${adapter.name} is only available on ${adapter.supportedClusters.join(', ')}; current cluster is ${cluster}.`,
    };
  }
  if (state.entries[adapter.id]?.enabled !== true) {
    return {
      ok: false,
      reason: 'disabled',
      adapter,
      message: `${adapter.name} is not connected. Enable it in Connected dApps before continuing.`,
    };
  }
  return { ok: true, adapter };
}

export function connectedDappsSummary(state: ConnectedDappsState, cluster: string): string {
  const enabled = KNOWN_CONNECTED_DAPPS.filter((adapter) =>
    isDappEnabled(adapter.id, state, cluster),
  );
  if (enabled.length === 0) {
    return KNOWN_CONNECTED_DAPPS.length === 1
      ? `No dApps connected · ${KNOWN_CONNECTED_DAPPS[0]!.name} available`
      : `No dApps connected · ${KNOWN_CONNECTED_DAPPS.length} available`;
  }
  if (enabled.length === 1) return `${enabled[0]!.name} connected`;
  return `${enabled.length} of ${KNOWN_CONNECTED_DAPPS.length} dApps connected`;
}

export function setConnectedDappEnabled(
  state: ConnectedDappsState,
  id: ConnectedDappId,
  enabled: boolean,
  now: Date = new Date(),
): ConnectedDappsState {
  const adapter = getAdapterMeta(id);
  if (!adapter) return state;
  const previous = state.entries[id] ?? { enabled: adapter.enabledByDefault };
  const nextEntry: ConnectedDappEntry = enabled
    ? { enabled: true, enabledAt: now.toISOString(), ...(previous.disabledAt ? { disabledAt: previous.disabledAt } : {}) }
    : { enabled: false, disabledAt: now.toISOString(), ...(previous.enabledAt ? { enabledAt: previous.enabledAt } : {}) };
  return {
    entries: {
      ...state.entries,
      [id]: nextEntry,
    },
  };
}
