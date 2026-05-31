import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KNOWN_LOCAL_APP_INDEXED_DB_NAMES,
  wipeLocalAppStorage,
} from '../localAppStorageWipe.js';

const STORAGE_GLOBALS = ['localStorage', 'sessionStorage', 'indexedDB', 'caches'] as const;
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

function restoreGlobals(): void {
  for (const name of STORAGE_GLOBALS) {
    const descriptor = originalDescriptors.get(name);
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      try {
        delete (globalThis as Record<string, unknown>)[name];
      } catch {
        // Ignore non-configurable test environments.
      }
    }
  }
}

function installStorage(name: 'localStorage' | 'sessionStorage'): Storage {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => {
      values.clear();
    }),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, String(value));
    }),
  } as Storage;
  Object.defineProperty(globalThis, name, {
    value: storage,
    configurable: true,
    writable: true,
  });
  return storage;
}

function asyncIdbRequest(success: boolean): IDBOpenDBRequest {
  const request = {
    error: success ? null : new Error('delete failed'),
    onsuccess: null,
    onerror: null,
    onblocked: null,
  } as unknown as IDBOpenDBRequest;
  queueMicrotask(() => {
    if (success) {
      request.onsuccess?.(new Event('success'));
    } else {
      request.onerror?.(new Event('error'));
    }
  });
  return request;
}

beforeEach(() => {
  originalDescriptors.clear();
  for (const name of STORAGE_GLOBALS) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
});

afterEach(() => {
  restoreGlobals();
  vi.restoreAllMocks();
});

describe('wipeLocalAppStorage', () => {
  it('clears web storage, IndexedDB databases, and CacheStorage', async () => {
    const localStorage = installStorage('localStorage');
    const sessionStorage = installStorage('sessionStorage');
    localStorage.setItem('plan', 'draft');
    sessionStorage.setItem('api-key', 'secret');

    const indexedDbDeleted: string[] = [];
    const indexedDB = {
      databases: vi.fn(async () => [
        { name: 'walletconnect-v2' },
        { name: '' },
        {},
      ]),
      deleteDatabase: vi.fn((name: string) => {
        indexedDbDeleted.push(name);
        return asyncIdbRequest(true);
      }),
    };
    Object.defineProperty(globalThis, 'indexedDB', {
      value: indexedDB,
      configurable: true,
      writable: true,
    });

    const caches = {
      keys: vi.fn(async () => ['asset-cache', 'api-cache']),
      delete: vi.fn(async (name: string) => name !== 'api-cache'),
    };
    Object.defineProperty(globalThis, 'caches', {
      value: caches,
      configurable: true,
      writable: true,
    });

    const result = await wipeLocalAppStorage();

    expect(result.localStorageCleared).toBe(true);
    expect(result.sessionStorageCleared).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(indexedDbDeleted).toEqual(expect.arrayContaining([
      ...KNOWN_LOCAL_APP_INDEXED_DB_NAMES,
      'walletconnect-v2',
    ]));
    expect(result.indexedDbFailed).toEqual([]);
    expect(result.cachesDeleted).toEqual(['asset-cache']);
    expect(result.cachesFailed).toEqual(['api-cache']);
  });

  it('is best-effort when storage APIs are unavailable or throwing', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new Error('local denied');
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: {
        clear() {
          throw new Error('session denied');
        },
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        databases: vi.fn(async () => {
          throw new Error('list denied');
        }),
        deleteDatabase: vi.fn(() => {
          throw new Error('delete denied');
        }),
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'caches', {
      value: {
        keys: vi.fn(async () => {
          throw new Error('cache denied');
        }),
        delete: vi.fn(),
      },
      configurable: true,
    });

    const result = await wipeLocalAppStorage();

    expect(result.localStorageCleared).toBe(false);
    expect(result.sessionStorageCleared).toBe(false);
    expect(result.indexedDbFailed).toEqual([...KNOWN_LOCAL_APP_INDEXED_DB_NAMES]);
    expect(result.errors.join('\n')).toContain('indexedDB.databases failed');
    expect(result.errors.join('\n')).toContain('sessionStorage.clear failed');
    expect(result.errors.join('\n')).toContain('CacheStorage.keys failed');
  });
});
