import type {
  RegistrySnapshotPersist,
  RuntimePersistence,
} from '../runtime/registry.js';
import { isRuntimeStateWire, type RuntimeError, type RuntimeStateWire } from '../runtime/state.js';
import { getRecord, putRecord, withDb } from './indexedDbStore.js';
import {
  SECRETS_DB_NAME,
  SECRETS_DB_VERSION,
  SECRETS_STORES_SCHEMA,
  STATE_META_STORE,
} from './secretStore.js';

export type { RegistrySnapshotPersist, RuntimePersistence } from '../runtime/registry.js';

const STATE_RECORD_ID = 'state';

interface StateMetaRecord {
  id: typeof STATE_RECORD_ID;
  state: RuntimeStateWire;
  lastTransitionAtMs: number;
  errorCode?: string;
  errorSubcode?: string;
  errorMessage?: string;
}

function defaultSnapshot(): RegistrySnapshotPersist {
  return { state: 'stopped', error: null, lastTransitionAtMs: 0 };
}

function reconstructError(record: StateMetaRecord): RuntimeError | null {
  const code = typeof record.errorCode === 'string' ? record.errorCode.trim() : '';
  if (!code) return null;
  const message = typeof record.errorMessage === 'string' ? record.errorMessage : '';
  const subcodeRaw = typeof record.errorSubcode === 'string' ? record.errorSubcode.trim() : '';
  if (subcodeRaw) {
    return { code, subcode: subcodeRaw, message };
  }
  return { code, message };
}

function snapshotFromRecord(record: StateMetaRecord | undefined): RegistrySnapshotPersist {
  if (!record) return defaultSnapshot();
  const state = isRuntimeStateWire(record.state) ? record.state : 'stopped';
  const lastTransitionAtMs = typeof record.lastTransitionAtMs === 'number' && Number.isFinite(record.lastTransitionAtMs)
    ? record.lastTransitionAtMs
    : 0;
  return {
    state,
    error: reconstructError(record),
    lastTransitionAtMs,
  };
}

function buildRecord(
  state: RuntimeStateWire,
  error: RuntimeError | null,
  now: number,
): StateMetaRecord {
  const record: StateMetaRecord = {
    id: STATE_RECORD_ID,
    state,
    lastTransitionAtMs: now,
  };
  if (error) {
    record.errorCode = error.code;
    record.errorMessage = error.message;
    if (typeof error.subcode === 'string' && error.subcode.trim().length > 0) {
      record.errorSubcode = error.subcode;
    }
  }
  return record;
}

export function createIndexedDbPersistence(): RuntimePersistence {
  return {
    async load() {
      try {
        return await withDb(
          SECRETS_DB_NAME,
          SECRETS_DB_VERSION,
          SECRETS_STORES_SCHEMA,
          async (db) => {
            const record = await getRecord<StateMetaRecord>(db, STATE_META_STORE, STATE_RECORD_ID);
            return snapshotFromRecord(record);
          },
        );
      } catch {
        // The registry hydrate path treats load() as never-rejecting; degrade gracefully.
        return defaultSnapshot();
      }
    },
    async save(state, error) {
      const record = buildRecord(state, error, Date.now());
      await withDb(
        SECRETS_DB_NAME,
        SECRETS_DB_VERSION,
        SECRETS_STORES_SCHEMA,
        async (db) => {
          await putRecord(db, STATE_META_STORE, record);
        },
      );
    },
  };
}

export function createMemoryPersistence(): RuntimePersistence {
  let snapshot: RegistrySnapshotPersist = defaultSnapshot();
  return {
    async load() {
      return { ...snapshot, error: snapshot.error ? { ...snapshot.error } : null };
    },
    async save(state, error) {
      snapshot = {
        state,
        error: error
          ? (typeof error.subcode === 'string' && error.subcode.trim().length > 0
              ? { code: error.code, subcode: error.subcode, message: error.message }
              : { code: error.code, message: error.message })
          : null,
        lastTransitionAtMs: Date.now(),
      };
    },
  };
}
