import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import type {
  CloudPreferenceRecord,
  CloudPreferencesStore,
  Clock,
} from './store.js';
import { systemClock } from './store.js';

export const BYO_KEY_CONNECTOR_IDS = ['magiceden', 'tensor', 'sanctum', 'lulo', 'phoenix'] as const;
export type ByoKeyConnectorId = (typeof BYO_KEY_CONNECTOR_IDS)[number];

export interface ConnectorSecret {
  apiKey: string;
  baseUrl?: string;
}

export interface ConnectorSecretSummary {
  hasKey: boolean;
  baseUrl?: string;
  savedAt?: string;
}

export type ConnectorSecretsSummary = Record<ByoKeyConnectorId, ConnectorSecretSummary>;
export type ConnectorSecretsMap = Partial<Record<ByoKeyConnectorId, ConnectorSecret>>;

interface EncryptedSecretRecord {
  ciphertext: string;
  iv: string;
  tag: string;
  salt: string;
  savedAt: string;
  baseUrl?: string;
}

interface ConnectorSecretsPayload {
  version: 1;
  secrets: Partial<Record<ByoKeyConnectorId, EncryptedSecretRecord>>;
}

const NAMESPACE = 'protocol-connector-secrets' as const;
const HKDF_INFO_PREFIX = 'agentic.connector-secret:v1';
const AES_KEY_LENGTH = 32;
const GCM_IV_LENGTH = 12;
const SALT_LENGTH = 16;

export class ConnectorSecretsError extends Error {
  constructor(message: string, readonly code: 'kek_missing' | 'decrypt_failed' | 'invalid_payload') {
    super(message);
    this.name = 'ConnectorSecretsError';
  }
}

export function isByoKeyConnectorId(id: string): id is ByoKeyConnectorId {
  return (BYO_KEY_CONNECTOR_IDS as readonly string[]).includes(id);
}

export function emptyConnectorSecretsSummary(): ConnectorSecretsSummary {
  return Object.fromEntries(
    BYO_KEY_CONNECTOR_IDS.map((id) => [id, { hasKey: false }]),
  ) as ConnectorSecretsSummary;
}

export interface ConnectorSecretsServiceOptions {
  store: CloudPreferencesStore;
  kek: Buffer;
  clock?: Clock;
}

export interface ConnectorSecretsService {
  loadAll(walletAddress: string): Promise<ConnectorSecretsMap>;
  list(walletAddress: string): Promise<ConnectorSecretsSummary>;
  save(
    walletAddress: string,
    connector: ByoKeyConnectorId,
    secret: ConnectorSecret,
  ): Promise<ConnectorSecretSummary>;
  delete(walletAddress: string, connector: ByoKeyConnectorId): Promise<boolean>;
}

export function createConnectorSecretsService(
  options: ConnectorSecretsServiceOptions,
): ConnectorSecretsService {
  const { store, kek } = options;
  const clock = options.clock ?? systemClock;

  return {
    async loadAll(walletAddress) {
      const payload = await readPayload(store, walletAddress);
      if (!payload) return {};
      const out: ConnectorSecretsMap = {};
      for (const id of BYO_KEY_CONNECTOR_IDS) {
        const record = payload.secrets[id];
        if (!record) continue;
        try {
          out[id] = decryptSecret(record, walletAddress, id, kek);
        } catch {
          // Silent skip — a corrupt record shouldn't break unrelated connectors.
          // The list() endpoint will still show it as present so the user can re-enter.
        }
      }
      return out;
    },

    async list(walletAddress) {
      const summary = emptyConnectorSecretsSummary();
      const payload = await readPayload(store, walletAddress);
      if (!payload) return summary;
      for (const id of BYO_KEY_CONNECTOR_IDS) {
        const record = payload.secrets[id];
        if (!record) continue;
        summary[id] = {
          hasKey: true,
          savedAt: record.savedAt,
          ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        };
      }
      return summary;
    },

    async save(walletAddress, connector, secret) {
      const record = await store.getPreference(walletAddress, NAMESPACE);
      const existing = record ? parsePayload(record) : undefined;
      const now = clock.now().toISOString();
      const encrypted = encryptSecret(secret, walletAddress, connector, kek, now);
      const nextSecrets = { ...(existing?.secrets ?? {}), [connector]: encrypted };
      const payload: ConnectorSecretsPayload = { version: 1, secrets: nextSecrets };
      await store.savePreference(walletAddress, {
        namespace: NAMESPACE,
        payload,
        updatedAt: now,
        version: (record?.version ?? 0) + 1,
      });
      return {
        hasKey: true,
        savedAt: now,
        ...(secret.baseUrl ? { baseUrl: secret.baseUrl } : {}),
      };
    },

    async delete(walletAddress, connector) {
      const record = await store.getPreference(walletAddress, NAMESPACE);
      if (!record) return false;
      const existing = parsePayload(record);
      if (!existing.secrets[connector]) return false;
      const nextSecrets: ConnectorSecretsPayload['secrets'] = { ...existing.secrets };
      delete nextSecrets[connector];
      const now = clock.now().toISOString();
      await store.savePreference(walletAddress, {
        namespace: NAMESPACE,
        payload: { version: 1, secrets: nextSecrets },
        updatedAt: now,
        version: record.version + 1,
      });
      return true;
    },
  };
}

async function readPayload(
  store: CloudPreferencesStore,
  walletAddress: string,
): Promise<ConnectorSecretsPayload | undefined> {
  const record = await store.getPreference(walletAddress, NAMESPACE);
  if (!record) return undefined;
  return parsePayload(record);
}

function parsePayload(record: CloudPreferenceRecord): ConnectorSecretsPayload {
  const payload = record.payload as ConnectorSecretsPayload | undefined;
  if (!payload || typeof payload !== 'object' || payload.version !== 1 || !payload.secrets) {
    return { version: 1, secrets: {} };
  }
  return payload;
}

function encryptSecret(
  secret: ConnectorSecret,
  walletAddress: string,
  connector: ByoKeyConnectorId,
  kek: Buffer,
  savedAt: string,
): EncryptedSecretRecord {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(GCM_IV_LENGTH);
  const key = deriveDataKey(kek, salt, walletAddress, connector);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(secret.apiKey, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    salt: salt.toString('base64'),
    savedAt,
    ...(secret.baseUrl ? { baseUrl: secret.baseUrl } : {}),
  };
}

function decryptSecret(
  record: EncryptedSecretRecord,
  walletAddress: string,
  connector: ByoKeyConnectorId,
  kek: Buffer,
): ConnectorSecret {
  const salt = Buffer.from(record.salt, 'base64');
  const iv = Buffer.from(record.iv, 'base64');
  const tag = Buffer.from(record.tag, 'base64');
  const ciphertext = Buffer.from(record.ciphertext, 'base64');
  const key = deriveDataKey(kek, salt, walletAddress, connector);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new ConnectorSecretsError(
      `Failed to decrypt connector secret for ${connector}: ${err instanceof Error ? err.message : 'unknown'}`,
      'decrypt_failed',
    );
  }
  return {
    apiKey: plaintext.toString('utf8'),
    ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
  };
}

function deriveDataKey(
  kek: Buffer,
  salt: Buffer,
  walletAddress: string,
  connector: ByoKeyConnectorId,
): Buffer {
  const info = Buffer.from(`${HKDF_INFO_PREFIX}:${walletAddress}:${connector}`, 'utf8');
  const derived = hkdfSync('sha256', kek, salt, info, AES_KEY_LENGTH) as ArrayBuffer;
  return Buffer.from(derived);
}

export function resolveConnectorSecretsKek(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.CONNECTOR_SECRET_KEY?.trim() || env.SESSION_SECRET?.trim();
  if (!raw) {
    throw new ConnectorSecretsError(
      'CONNECTOR_SECRET_KEY (or SESSION_SECRET fallback) must be set to manage connector API keys.',
      'kek_missing',
    );
  }
  if (raw.length < 32) {
    throw new ConnectorSecretsError(
      'CONNECTOR_SECRET_KEY must be at least 32 characters.',
      'kek_missing',
    );
  }
  return Buffer.from(raw, 'utf8');
}
