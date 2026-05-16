import { getOrCreateWrappingKey, invalidateWrappingKeyCache } from './cryptoKey.js';
import {
  clearStore,
  deleteRecord,
  getRecord,
  type ObjectStoreSchema,
  putRecord,
  storageUnavailableError,
  withDb,
} from './indexedDbStore.js';
import { createSessionMemoryStore, type SessionMemoryStore } from './sessionMemoryStore.js';

export type SecretStoreMode = 'encrypted-indexeddb' | 'session-memory' | 'none';

export interface SecretStore {
  put(key: string, plaintext: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  mode(): SecretStoreMode;
  dispose(): void;
}

export const SECRETS_DB_NAME = 'agentic-device-agent-secrets';
export const SECRETS_DB_VERSION = 1;
export const WRAPPING_KEY_STORE = 'wrappingKey';
export const CIPHERTEXT_STORE = 'ciphertext';
export const STATE_META_STORE = 'stateMeta';

export const SECRETS_STORES_SCHEMA: readonly ObjectStoreSchema[] = Object.freeze([
  { name: WRAPPING_KEY_STORE, keyPath: 'id' },
  { name: CIPHERTEXT_STORE, keyPath: 'key' },
  { name: STATE_META_STORE, keyPath: 'id' },
]);

export const SECRETS_STORES: ReadonlyArray<string> = Object.freeze(
  SECRETS_STORES_SCHEMA.map((schema) => schema.name),
);

interface CiphertextRecord {
  readonly key: string;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ct: Uint8Array<ArrayBuffer>;
}

function readSubtle(): SubtleCrypto {
  try {
    const candidate = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (candidate && typeof candidate.encrypt === 'function') return candidate;
  } catch {
    /* fall through */
  }
  throw storageUnavailableError('webcrypto unavailable');
}

function readRandom(): (size: number) => Uint8Array<ArrayBuffer> {
  try {
    const value = (globalThis as { crypto?: Crypto }).crypto;
    if (value && typeof value.getRandomValues === 'function') {
      return (size) => {
        const buf = new Uint8Array(size);
        value.getRandomValues(buf);
        return buf;
      };
    }
  } catch {
    /* fall through */
  }
  throw storageUnavailableError('webcrypto unavailable');
}

function rethrowAsStorageUnavailable(err: unknown, reason: string): never {
  if (err instanceof Error && err.message.startsWith('storage_unavailable:')) {
    throw err;
  }
  throw storageUnavailableError(reason, err);
}

function createEncryptedIndexedDbStore(): SecretStore {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  return {
    mode: () => 'encrypted-indexeddb',
    dispose: () => {
      /* No persistent state to release; DB connections are opened per-op. */
    },
    async put(key, plaintext) {
      try {
        await withDb(SECRETS_DB_NAME, SECRETS_DB_VERSION, SECRETS_STORES_SCHEMA, async (db) => {
          const wrappingKey = await getOrCreateWrappingKey(db, WRAPPING_KEY_STORE);
          const iv = readRandom()(12);
          const subtle = readSubtle();
          const ctBuffer = await subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, textEncoder.encode(plaintext));
          const record: CiphertextRecord = { key, iv, ct: new Uint8Array(ctBuffer) };
          await putRecord(db, CIPHERTEXT_STORE, record);
        });
      } catch (err) {
        rethrowAsStorageUnavailable(err, 'secret put failed');
      }
    },
    async get(key) {
      try {
        return await withDb(SECRETS_DB_NAME, SECRETS_DB_VERSION, SECRETS_STORES_SCHEMA, async (db) => {
          const record = await getRecord<CiphertextRecord>(db, CIPHERTEXT_STORE, key);
          if (!record) return undefined;
          const wrappingKey = await getOrCreateWrappingKey(db, WRAPPING_KEY_STORE);
          const subtle = readSubtle();
          const ptBuffer = await subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, wrappingKey, record.ct);
          return textDecoder.decode(ptBuffer);
        });
      } catch (err) {
        rethrowAsStorageUnavailable(err, 'secret get failed');
      }
    },
    async delete(key) {
      try {
        await withDb(SECRETS_DB_NAME, SECRETS_DB_VERSION, SECRETS_STORES_SCHEMA, async (db) => {
          await deleteRecord(db, CIPHERTEXT_STORE, key);
        });
      } catch (err) {
        rethrowAsStorageUnavailable(err, 'secret delete failed');
      }
    },
    async clear() {
      try {
        await withDb(SECRETS_DB_NAME, SECRETS_DB_VERSION, SECRETS_STORES_SCHEMA, async (db) => {
          await clearStore(db, CIPHERTEXT_STORE);
          await deleteRecord(db, WRAPPING_KEY_STORE, 'v1');
        });
        invalidateWrappingKeyCache(SECRETS_DB_NAME, WRAPPING_KEY_STORE);
      } catch (err) {
        rethrowAsStorageUnavailable(err, 'secret clear failed');
      }
    },
  };
}

function createSessionMemorySecretStore(): SecretStore {
  let backing: SessionMemoryStore | null = createSessionMemoryStore();
  const ensure = (): SessionMemoryStore => {
    if (!backing) throw storageUnavailableError('secret store disposed');
    return backing;
  };
  return {
    mode: () => 'session-memory',
    dispose: () => {
      if (!backing) return;
      backing.dispose();
      backing = null;
    },
    async put(key, plaintext) {
      ensure().put(key, plaintext);
    },
    async get(key) {
      return ensure().get(key);
    },
    async delete(key) {
      ensure().delete(key);
    },
    async clear() {
      ensure().clear();
    },
  };
}

function createNoneSecretStore(): SecretStore {
  return {
    mode: () => 'none',
    dispose: () => {
      /* no-op */
    },
    async put() {
      throw storageUnavailableError('secret store disabled');
    },
    async get() {
      return undefined;
    },
    async delete() {
      throw storageUnavailableError('secret store disabled');
    },
    async clear() {
      throw storageUnavailableError('secret store disabled');
    },
  };
}

export function createSecretStore(mode: SecretStoreMode): SecretStore {
  switch (mode) {
    case 'encrypted-indexeddb':
      return createEncryptedIndexedDbStore();
    case 'session-memory':
      return createSessionMemorySecretStore();
    case 'none':
      return createNoneSecretStore();
    default: {
      const exhaustive: never = mode;
      throw new Error(`unsupported secret store mode: ${String(exhaustive)}`);
    }
  }
}
