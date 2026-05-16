import { DEVICE_AGENT_ERROR_CODES } from '@solana-agent-wallet-adapter/workflow';

const STORAGE_UNAVAILABLE = DEVICE_AGENT_ERROR_CODES.STORAGE_UNAVAILABLE;

export interface ObjectStoreSchema {
  readonly name: string;
  readonly keyPath: string;
}

function readIndexedDbFactory(): IDBFactory | null {
  try {
    const candidate = (globalThis as { indexedDB?: IDBFactory | null }).indexedDB;
    if (candidate && typeof candidate.open === 'function') return candidate;
  } catch {
    // Some environments throw when accessing indexedDB (e.g., disabled storage).
  }
  return null;
}

export function isIndexedDbAvailable(): boolean {
  return readIndexedDbFactory() !== null;
}

function describeReason(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string') {
      if (name === 'QuotaExceededError') return `quota_exceeded: ${fallback}`;
      if (name) return `${name}: ${fallback}`;
    }
  }
  return fallback;
}

export function storageUnavailableError(reason: string, cause?: unknown): Error {
  const message = `${STORAGE_UNAVAILABLE}: ${reason}`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

export function openDb(
  name: string,
  version: number,
  stores: ReadonlyArray<ObjectStoreSchema>,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const factory = readIndexedDbFactory();
    if (!factory) {
      reject(storageUnavailableError('indexeddb unavailable'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, version);
    } catch (err) {
      reject(storageUnavailableError(describeReason(err, `open failed for ${name}`), err));
      return;
    }
    request.onupgradeneeded = () => {
      try {
        const db = request.result;
        for (const schema of stores) {
          if (!db.objectStoreNames.contains(schema.name)) {
            db.createObjectStore(schema.name, { keyPath: schema.keyPath });
          }
        }
      } catch {
        // Upgrade errors surface via request.onerror after the upgrade tx aborts.
      }
    };
    request.onblocked = () => {
      reject(storageUnavailableError('blocked_by_other_tab'));
    };
    request.onsuccess = () => {
      const db = request.result;
      for (const schema of stores) {
        if (!db.objectStoreNames.contains(schema.name)) {
          try { db.close(); } catch { /* ignore */ }
          reject(storageUnavailableError(`missing store: ${schema.name}`));
          return;
        }
      }
      resolve(db);
    };
    request.onerror = () => {
      const err = request.error;
      reject(storageUnavailableError(describeReason(err, `open error for ${name}`), err ?? undefined));
    };
  });
}

function awaitTransaction(tx: IDBTransaction, reason: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(storageUnavailableError(describeReason(err, reason), err));
    };
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });
}

function openTransaction(db: IDBDatabase, store: string, mode: IDBTransactionMode): IDBTransaction {
  try {
    return db.transaction(store, mode);
  } catch (err) {
    throw storageUnavailableError(describeReason(err, `transaction failed for ${store}`), err);
  }
}

export async function putRecord(db: IDBDatabase, store: string, record: unknown): Promise<void> {
  const tx = openTransaction(db, store, 'readwrite');
  const done = awaitTransaction(tx, `put failed in ${store}`);
  try {
    const req = tx.objectStore(store).put(record as never);
    req.onerror = () => {
      // Surfaces via tx.onerror/onabort; swallow here so the event is not "unhandled".
    };
  } catch (err) {
    await done.catch(() => undefined);
    throw storageUnavailableError(describeReason(err, `put threw in ${store}`), err);
  }
  await done;
}

export async function getRecord<T = unknown>(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  const tx = openTransaction(db, store, 'readonly');
  const done = awaitTransaction(tx, `get failed in ${store}`);
  let captured: T | undefined;
  try {
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => {
      captured = req.result as T | undefined;
    };
    req.onerror = () => {
      // Surfaces via tx.onerror/onabort.
    };
  } catch (err) {
    await done.catch(() => undefined);
    throw storageUnavailableError(describeReason(err, `get threw in ${store}`), err);
  }
  await done;
  return captured;
}

export async function deleteRecord(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  const tx = openTransaction(db, store, 'readwrite');
  const done = awaitTransaction(tx, `delete failed in ${store}`);
  try {
    const req = tx.objectStore(store).delete(key);
    req.onerror = () => {
      // Surfaces via tx.onerror/onabort.
    };
  } catch (err) {
    await done.catch(() => undefined);
    throw storageUnavailableError(describeReason(err, `delete threw in ${store}`), err);
  }
  await done;
}

export async function clearStore(db: IDBDatabase, store: string): Promise<void> {
  const tx = openTransaction(db, store, 'readwrite');
  const done = awaitTransaction(tx, `clear failed in ${store}`);
  try {
    const req = tx.objectStore(store).clear();
    req.onerror = () => {
      // Surfaces via tx.onerror/onabort.
    };
  } catch (err) {
    await done.catch(() => undefined);
    throw storageUnavailableError(describeReason(err, `clear threw in ${store}`), err);
  }
  await done;
}

export async function closeDb(db: IDBDatabase): Promise<void> {
  try { db.close(); } catch { /* ignore */ }
}

export async function withDb<T>(
  name: string,
  version: number,
  stores: ReadonlyArray<ObjectStoreSchema>,
  fn: (db: IDBDatabase) => Promise<T>,
): Promise<T> {
  const db = await openDb(name, version, stores);
  try {
    return await fn(db);
  } finally {
    await closeDb(db);
  }
}
