import type { GlobalOptions } from '../shared/types.js';
import { renderWebRequest } from '../http/index.js';
import {
  isByoKeyConnectorId,
  listConnectors,
  type ByoKeyConnectorId,
  type ConnectorSummary,
} from '../forms/connectorMeta.js';

export interface ProtocolConnectorEntry {
  enabled: boolean;
  enabledAt?: string;
  disabledAt?: string;
}

export interface ProtocolConnectorState {
  schemaVersion: 2;
  entries: Record<string, ProtocolConnectorEntry>;
}

export interface ConnectorSecretMaterial {
  apiKey: string;
  baseUrl?: string;
}

export type ConnectorSecretsMap = Partial<Record<ByoKeyConnectorId, ConnectorSecretMaterial>>;

let sessionConnectorState: ProtocolConnectorState | null = null;
let sessionConnectorStateDirty = false;
let sessionConnectorSecrets: ConnectorSecretsMap = {};

export function emptyProtocolConnectorState(connectors: ConnectorSummary[] = listConnectors()): ProtocolConnectorState {
  const entries: Record<string, ProtocolConnectorEntry> = {};
  for (const connector of connectors) entries[connector.id] = { enabled: false };
  return { schemaVersion: 2, entries };
}

export function normalizeProtocolConnectorState(raw: unknown, connectors: ConnectorSummary[] = listConnectors()): ProtocolConnectorState {
  const payload = extractPreferencePayload(raw);
  const sourceEntries = extractEntries(payload);
  const entries: Record<string, ProtocolConnectorEntry> = {};
  for (const connector of connectors) {
    const candidate = sourceEntries[connector.id];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      entries[connector.id] = {
        enabled: Boolean(record.enabled),
        ...(typeof record.enabledAt === 'string' ? { enabledAt: record.enabledAt } : {}),
        ...(typeof record.disabledAt === 'string' ? { disabledAt: record.disabledAt } : {}),
      };
    } else {
      entries[connector.id] = { enabled: candidate === true };
    }
  }
  return { schemaVersion: 2, entries };
}

export async function loadConnectorState(options: GlobalOptions): Promise<ProtocolConnectorState> {
  try {
    const raw = await renderWebRequest<unknown>(options, '/api/preferences/protocol-connectors', undefined, {
      label: 'Render-web preferences',
      requireAuth: true,
    });
    const cloud = normalizeProtocolConnectorState(raw);
    if (sessionConnectorStateDirty && sessionConnectorState) {
      await saveConnectorState(options, sessionConnectorState);
      return sessionConnectorState;
    }
    sessionConnectorState = cloud;
    return cloud;
  } catch {
    if (!sessionConnectorState) sessionConnectorState = emptyProtocolConnectorState();
    return sessionConnectorState;
  }
}

export async function saveConnectorState(options: GlobalOptions, state: ProtocolConnectorState): Promise<{ cloud: boolean; error?: unknown }> {
  const normalized = normalizeProtocolConnectorState(state);
  sessionConnectorState = normalized;
  try {
    await renderWebRequest(options, '/api/preferences/protocol-connectors', {
      method: 'PUT',
      body: JSON.stringify({ payload: normalized }),
    }, { label: 'Render-web preferences', requireAuth: true });
    sessionConnectorStateDirty = false;
    return { cloud: true };
  } catch (error) {
    sessionConnectorStateDirty = true;
    return { cloud: false, error };
  }
}

export function setConnectorEnabled(
  state: ProtocolConnectorState,
  connectorId: string,
  enabled: boolean,
  now: Date = new Date(),
): ProtocolConnectorState {
  const normalized = normalizeProtocolConnectorState(state);
  const previous = normalized.entries[connectorId] ?? { enabled: false };
  return {
    schemaVersion: 2,
    entries: {
      ...normalized.entries,
      [connectorId]: enabled
        ? {
            enabled: true,
            enabledAt: now.toISOString(),
            ...(previous.disabledAt ? { disabledAt: previous.disabledAt } : {}),
          }
        : {
            enabled: false,
            disabledAt: now.toISOString(),
            ...(previous.enabledAt ? { enabledAt: previous.enabledAt } : {}),
          },
    },
  };
}

export function enabledConnectorIds(state: ProtocolConnectorState): Set<string> {
  const normalized = normalizeProtocolConnectorState(state);
  return new Set(
    Object.entries(normalized.entries)
      .filter(([, entry]) => entry.enabled === true)
      .map(([id]) => id),
  );
}

export function countEnabledConnectors(raw: unknown): number {
  return enabledConnectorIds(normalizeProtocolConnectorState(raw)).size;
}

export async function listInstalledConnectorKeys(options: GlobalOptions): Promise<Set<string>> {
  const installed = sessionInstalledConnectorKeys();
  try {
    const raw = await renderWebRequest<unknown>(options, '/api/connector-secrets', undefined, {
      label: 'Render-web connector secrets',
      requireAuth: true,
    });
    for (const id of extractInstalledConnectorKeyIds(raw)) installed.add(id);
  } catch {
    // Cloud sign-in is optional; session keys still count for this process.
  }
  return installed;
}

export function extractInstalledConnectorKeyIds(raw: unknown): Set<string> {
  const ids = new Set<string>();
  const addFromArray = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const id = (item as { connectorId?: unknown }).connectorId;
      const hasKey = (item as { hasKey?: unknown }).hasKey;
      if (typeof id === 'string' && (hasKey === undefined || hasKey === true)) ids.add(id);
    }
  };
  if (Array.isArray(raw)) {
    addFromArray(raw);
    return ids;
  }
  if (!raw || typeof raw !== 'object') return ids;
  const record = raw as Record<string, unknown>;
  addFromArray(record.items);
  const secrets = record.secrets;
  if (Array.isArray(secrets)) {
    addFromArray(secrets);
    return ids;
  }
  if (secrets && typeof secrets === 'object') {
    for (const [id, value] of Object.entries(secrets as Record<string, unknown>)) {
      if (value && typeof value === 'object' && (value as { hasKey?: unknown }).hasKey === true) ids.add(id);
    }
  }
  return ids;
}

export function saveSessionConnectorSecret(connectorId: string, secret: ConnectorSecretMaterial): void {
  if (!isByoKeyConnectorId(connectorId)) return;
  sessionConnectorSecrets = {
    ...sessionConnectorSecrets,
    [connectorId]: {
      apiKey: secret.apiKey,
      ...(secret.baseUrl ? { baseUrl: secret.baseUrl } : {}),
    },
  };
}

export function removeSessionConnectorSecret(connectorId: string): void {
  if (!isByoKeyConnectorId(connectorId)) return;
  const next = { ...sessionConnectorSecrets };
  delete next[connectorId];
  sessionConnectorSecrets = next;
}

export function connectorSecretsForRequest(connectorId: string): ConnectorSecretsMap | undefined {
  if (!isByoKeyConnectorId(connectorId)) return undefined;
  const secret = sessionConnectorSecrets[connectorId];
  if (!secret?.apiKey.trim()) return undefined;
  return { [connectorId]: secret };
}

function sessionInstalledConnectorKeys(): Set<string> {
  return new Set(Object.entries(sessionConnectorSecrets)
    .filter(([, secret]) => Boolean(secret?.apiKey.trim()))
    .map(([id]) => id));
}

function extractPreferencePayload(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  if ('payload' in raw) return (raw as { payload?: unknown }).payload;
  return raw;
}

function extractEntries(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  if (record.entries && typeof record.entries === 'object' && !Array.isArray(record.entries)) {
    return record.entries as Record<string, unknown>;
  }
  return record;
}
