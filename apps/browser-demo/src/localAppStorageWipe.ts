import { SECRETS_DB_NAME } from './deviceAgent/storage/secretStore.js';

export const LAB_ARCHIVE_INDEXED_DB_NAME = 'solana-agent-wallet-lab-artifacts';

export const KNOWN_LOCAL_APP_INDEXED_DB_NAMES = Object.freeze([
  SECRETS_DB_NAME,
  LAB_ARCHIVE_INDEXED_DB_NAME,
]);

export interface LocalAppStorageWipeResult {
  localStorageCleared: boolean;
  sessionStorageCleared: boolean;
  indexedDbDeleted: string[];
  indexedDbFailed: string[];
  cachesDeleted: string[];
  cachesFailed: string[];
  errors: string[];
}

type IndexedDbFactoryWithDatabases = IDBFactory & {
  databases?: () => Promise<Array<{ name?: string | null }>>;
};

function emptyResult(): LocalAppStorageWipeResult {
  return {
    localStorageCleared: false,
    sessionStorageCleared: false,
    indexedDbDeleted: [],
    indexedDbFailed: [],
    cachesDeleted: [],
    cachesFailed: [],
    errors: [],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readStorage(name: 'localStorage' | 'sessionStorage'): Storage | undefined {
  try {
    const globalStorage = (globalThis as unknown as Record<typeof name, Storage | undefined>)[name];
    if (globalStorage && typeof globalStorage.clear === 'function') return globalStorage;
  } catch {
    // Fall through to window lookup.
  }
  try {
    const win = (globalThis as { window?: Record<typeof name, Storage | undefined> }).window;
    const windowStorage = win?.[name];
    if (windowStorage && typeof windowStorage.clear === 'function') return windowStorage;
  } catch {
    // Storage can throw when disabled by browser policy.
  }
  return undefined;
}

function readIndexedDbFactory(): IndexedDbFactoryWithDatabases | undefined {
  try {
    const factory = (globalThis as { indexedDB?: IndexedDbFactoryWithDatabases }).indexedDB;
    if (factory && typeof factory.deleteDatabase === 'function') return factory;
  } catch {
    // IndexedDB can throw when disabled by browser policy.
  }
  try {
    const factory = (globalThis as { window?: { indexedDB?: IndexedDbFactoryWithDatabases } }).window?.indexedDB;
    if (factory && typeof factory.deleteDatabase === 'function') return factory;
  } catch {
    // IndexedDB can throw when disabled by browser policy.
  }
  return undefined;
}

function readCacheStorage(): CacheStorage | undefined {
  try {
    const cacheStorage = (globalThis as { caches?: CacheStorage }).caches;
    if (cacheStorage && typeof cacheStorage.keys === 'function' && typeof cacheStorage.delete === 'function') {
      return cacheStorage;
    }
  } catch {
    // CacheStorage can be unavailable in restricted contexts.
  }
  try {
    const cacheStorage = (globalThis as { window?: { caches?: CacheStorage } }).window?.caches;
    if (cacheStorage && typeof cacheStorage.keys === 'function' && typeof cacheStorage.delete === 'function') {
      return cacheStorage;
    }
  } catch {
    // CacheStorage can be unavailable in restricted contexts.
  }
  return undefined;
}

async function indexedDbNames(factory: IndexedDbFactoryWithDatabases, result: LocalAppStorageWipeResult): Promise<string[]> {
  const names = new Set<string>(KNOWN_LOCAL_APP_INDEXED_DB_NAMES);
  if (typeof factory.databases !== 'function') {
    return [...names];
  }
  try {
    const databases = await factory.databases();
    for (const db of databases) {
      const name = typeof db.name === 'string' ? db.name.trim() : '';
      if (name) names.add(name);
    }
  } catch (err) {
    result.errors.push(`indexedDB.databases failed: ${errorMessage(err)}`);
  }
  return [...names];
}

function deleteIndexedDb(factory: IndexedDbFactoryWithDatabases, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function clearIndexedDb(result: LocalAppStorageWipeResult): Promise<void> {
  const factory = readIndexedDbFactory();
  if (!factory) return;
  for (const name of await indexedDbNames(factory, result)) {
    if (await deleteIndexedDb(factory, name)) {
      result.indexedDbDeleted.push(name);
    } else {
      result.indexedDbFailed.push(name);
    }
  }
}

async function clearCaches(result: LocalAppStorageWipeResult): Promise<void> {
  const cacheStorage = readCacheStorage();
  if (!cacheStorage) return;
  let keys: string[];
  try {
    keys = await cacheStorage.keys();
  } catch (err) {
    result.errors.push(`CacheStorage.keys failed: ${errorMessage(err)}`);
    return;
  }
  for (const key of keys) {
    try {
      if (await cacheStorage.delete(key)) {
        result.cachesDeleted.push(key);
      } else {
        result.cachesFailed.push(key);
      }
    } catch (err) {
      result.cachesFailed.push(key);
      result.errors.push(`CacheStorage.delete failed for ${key}: ${errorMessage(err)}`);
    }
  }
}

export async function wipeLocalAppStorage(): Promise<LocalAppStorageWipeResult> {
  const result = emptyResult();
  const localStorage = readStorage('localStorage');
  if (localStorage) {
    try {
      localStorage.clear();
      result.localStorageCleared = true;
    } catch (err) {
      result.errors.push(`localStorage.clear failed: ${errorMessage(err)}`);
    }
  }

  const sessionStorage = readStorage('sessionStorage');
  if (sessionStorage) {
    try {
      sessionStorage.clear();
      result.sessionStorageCleared = true;
    } catch (err) {
      result.errors.push(`sessionStorage.clear failed: ${errorMessage(err)}`);
    }
  }

  await clearIndexedDb(result);
  await clearCaches(result);
  return result;
}
