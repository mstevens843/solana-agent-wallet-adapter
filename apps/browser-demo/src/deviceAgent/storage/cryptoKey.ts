import { getRecord, putRecord, storageUnavailableError } from './indexedDbStore.js';

interface WrappingKeyRecord {
  readonly id: 'v1';
  readonly key: CryptoKey;
}

const WRAPPING_KEY_ID = 'v1';

const cache = new Map<string, Promise<CryptoKey>>();

function cacheKey(dbName: string, storeName: string): string {
  return `${dbName}::${storeName}`;
}

function readSubtle(): SubtleCrypto {
  try {
    const candidate = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (candidate && typeof candidate.generateKey === 'function') return candidate;
  } catch {
    /* fall through */
  }
  throw storageUnavailableError('webcrypto unavailable');
}

async function generateAesGcmKey(): Promise<CryptoKey> {
  const subtle = readSubtle();
  try {
    return await subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch (err) {
    throw storageUnavailableError('generateKey failed', err);
  }
}

async function loadOrCreate(db: IDBDatabase, storeName: string): Promise<CryptoKey> {
  try {
    const existing = await getRecord<WrappingKeyRecord>(db, storeName, WRAPPING_KEY_ID);
    if (existing && existing.key) return existing.key;
  } catch (err) {
    throw err instanceof Error && err.message.startsWith('storage_unavailable:')
      ? err
      : storageUnavailableError('wrapping key read failed', err);
  }
  const key = await generateAesGcmKey();
  try {
    await putRecord(db, storeName, { id: WRAPPING_KEY_ID, key });
  } catch (err) {
    throw err instanceof Error && err.message.startsWith('storage_unavailable:')
      ? err
      : storageUnavailableError('wrapping key persist failed', err);
  }
  return key;
}

export function getOrCreateWrappingKey(db: IDBDatabase, storeName: string): Promise<CryptoKey> {
  const key = cacheKey(db.name, storeName);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = loadOrCreate(db, storeName);
  cache.set(key, promise);
  // Evict on failure so retries can re-attempt cleanly.
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  return promise;
}

export function invalidateWrappingKeyCache(dbName: string, storeName: string): void {
  cache.delete(cacheKey(dbName, storeName));
}

export function __resetWrappingKeyCacheForTests(): void {
  cache.clear();
}
