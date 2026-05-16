import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetWrappingKeyCacheForTests,
  getOrCreateWrappingKey,
} from '../storage/cryptoKey.js';
import { openDb } from '../storage/indexedDbStore.js';
import {
  CIPHERTEXT_STORE,
  SECRETS_DB_NAME,
  SECRETS_DB_VERSION,
  SECRETS_STORES_SCHEMA,
  WRAPPING_KEY_STORE,
  createSecretStore,
} from '../storage/secretStore.js';
import { createSessionMemoryStore } from '../storage/sessionMemoryStore.js';

import { createFakeIndexedDb, type FakeIndexedDbHarness } from './fakeIndexedDb.js';

interface CiphertextRecord {
  key: string;
  iv: Uint8Array;
  ct: Uint8Array;
}

async function openSecretsDbForTest(): Promise<IDBDatabase> {
  return openDb(SECRETS_DB_NAME, SECRETS_DB_VERSION, SECRETS_STORES_SCHEMA);
}

describe('Phase 2 storage layer', () => {
  let fake: FakeIndexedDbHarness;

  beforeEach(() => {
    fake = createFakeIndexedDb();
    fake.install();
    __resetWrappingKeyCacheForTests();
  });

  afterEach(() => {
    fake.uninstall();
  });

  describe('environment sanity', () => {
    it('exposes a WebCrypto subtle implementation', () => {
      const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
      expect(typeof subtle?.generateKey).toBe('function');
      expect(typeof subtle?.encrypt).toBe('function');
      expect(typeof subtle?.decrypt).toBe('function');
    });
  });

  describe('cryptoKey.getOrCreateWrappingKey', () => {
    it('generates a non-extractable AES-GCM 256-bit key', async () => {
      const db = await openSecretsDbForTest();
      try {
        const key = await getOrCreateWrappingKey(db, WRAPPING_KEY_STORE);
        expect(key.extractable).toBe(false);
        expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
        expect(key.usages).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));
      } finally {
        db.close();
      }
    });

    it('caches the wrapping key across calls', async () => {
      const db = await openSecretsDbForTest();
      try {
        const a = await getOrCreateWrappingKey(db, WRAPPING_KEY_STORE);
        const b = await getOrCreateWrappingKey(db, WRAPPING_KEY_STORE);
        expect(a).toBe(b);
      } finally {
        db.close();
      }
    });

    it('serializes concurrent first-time calls so only one key is generated', async () => {
      const db = await openSecretsDbForTest();
      try {
        const [a, b, c] = await Promise.all([
          getOrCreateWrappingKey(db, WRAPPING_KEY_STORE),
          getOrCreateWrappingKey(db, WRAPPING_KEY_STORE),
          getOrCreateWrappingKey(db, WRAPPING_KEY_STORE),
        ]);
        expect(a).toBe(b);
        expect(b).toBe(c);
      } finally {
        db.close();
      }
    });

    it('evicts the cache when generation fails so retries can succeed', async () => {
      fake.failNextOp('SimulatedError', 'first read fails');
      const db = await openSecretsDbForTest();
      try {
        await expect(getOrCreateWrappingKey(db, WRAPPING_KEY_STORE)).rejects.toThrow(/^storage_unavailable:/);
        const key = await getOrCreateWrappingKey(db, WRAPPING_KEY_STORE);
        expect(key).toBeDefined();
        expect(key.extractable).toBe(false);
      } finally {
        db.close();
      }
    });
  });

  describe('secretStore — encrypted-indexeddb mode', () => {
    it('round-trips plaintext via AES-GCM', async () => {
      const store = createSecretStore('encrypted-indexeddb');
      try {
        await store.put('apiKey:openai', 'sk-test-1234567890abcdef');
        expect(await store.get('apiKey:openai')).toBe('sk-test-1234567890abcdef');
      } finally {
        store.dispose();
      }
    });

    it('returns undefined for missing keys', async () => {
      const store = createSecretStore('encrypted-indexeddb');
      try {
        expect(await store.get('missing')).toBeUndefined();
      } finally {
        store.dispose();
      }
    });

    it('uses a fresh non-zero 12-byte IV for every write', async () => {
      const store = createSecretStore('encrypted-indexeddb');
      try {
        await store.put('apiKey:openai', 'sk-secret-payload');
        const first = fake.peek(SECRETS_DB_NAME, CIPHERTEXT_STORE, 'apiKey:openai') as CiphertextRecord;
        await store.put('apiKey:openai', 'sk-secret-payload');
        const second = fake.peek(SECRETS_DB_NAME, CIPHERTEXT_STORE, 'apiKey:openai') as CiphertextRecord;

        expect(first.iv).toBeInstanceOf(Uint8Array);
        expect(first.iv.byteLength).toBe(12);
        expect(second.iv.byteLength).toBe(12);
        expect(Array.from(first.iv)).not.toEqual(Array.from(second.iv));
        expect(Array.from(first.ct)).not.toEqual(Array.from(second.ct));
        // Pin: a stubbed-out crypto.getRandomValues would leave IVs all-zero.
        expect(Array.from(first.iv).some((byte) => byte !== 0)).toBe(true);
        expect(Array.from(second.iv).some((byte) => byte !== 0)).toBe(true);
      } finally {
        store.dispose();
      }
    });

    it('removes the record on delete', async () => {
      const store = createSecretStore('encrypted-indexeddb');
      try {
        await store.put('apiKey:gemini', 'gemini-token');
        await store.delete('apiKey:gemini');
        expect(await store.get('apiKey:gemini')).toBeUndefined();
        expect(fake.peek(SECRETS_DB_NAME, CIPHERTEXT_STORE, 'apiKey:gemini')).toBeUndefined();
      } finally {
        store.dispose();
      }
    });

    it('clear erases ciphertext and regenerates the wrapping key', async () => {
      const store = createSecretStore('encrypted-indexeddb');
      try {
        await store.put('apiKey:openai', 'sk-first-value');

        const dbBefore = await openSecretsDbForTest();
        const keyBefore = await getOrCreateWrappingKey(dbBefore, WRAPPING_KEY_STORE);
        dbBefore.close();

        await store.clear();
        __resetWrappingKeyCacheForTests();

        const dbAfter = await openSecretsDbForTest();
        const keyAfter = await getOrCreateWrappingKey(dbAfter, WRAPPING_KEY_STORE);
        dbAfter.close();

        expect(keyAfter).not.toBe(keyBefore);
        expect(await store.get('apiKey:openai')).toBeUndefined();
      } finally {
        store.dispose();
      }
    });

    it('wraps an IDB open failure as storage_unavailable with cause', async () => {
      const store = createSecretStore('encrypted-indexeddb');
      try {
        fake.failNextOpen('UnknownError', 'simulated open failure');
        let caught: unknown;
        try {
          await store.put('apiKey:openai', 'sk-must-not-leak');
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        const error = caught as Error;
        expect(error.message).toMatch(/^storage_unavailable:/);
        expect(error.message).not.toContain('sk-');
        expect(error.message).not.toContain('Bearer');
        expect(error.cause).toBeDefined();
      } finally {
        store.dispose();
      }
    });

    it('wraps an IDB delete failure as storage_unavailable with cause', async () => {
      const store = createSecretStore('encrypted-indexeddb');
      try {
        await store.put('apiKey:openai', 'sk-existing');
        fake.failNextOp('UnknownError', 'simulated delete failure');
        let caught: Error | null = null;
        try {
          await store.delete('apiKey:openai');
        } catch (err) {
          caught = err as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message).toMatch(/^storage_unavailable:/);
        expect(caught!.cause).toBeDefined();
      } finally {
        store.dispose();
      }
    });

    it('dispose() is a safe no-op in encrypted-indexeddb mode', () => {
      const store = createSecretStore('encrypted-indexeddb');
      expect(() => store.dispose()).not.toThrow();
      expect(() => store.dispose()).not.toThrow(); // idempotent
    });

    it('reports mode() === "encrypted-indexeddb"', () => {
      const store = createSecretStore('encrypted-indexeddb');
      try {
        expect(store.mode()).toBe('encrypted-indexeddb');
      } finally {
        store.dispose();
      }
    });
  });

  describe('secretStore — session-memory mode', () => {
    it('never touches IndexedDB', async () => {
      const store = createSecretStore('session-memory');
      try {
        await store.put('apiKey:openai', 'sk-in-memory');
        expect(await store.get('apiKey:openai')).toBe('sk-in-memory');
        expect(fake.dbCount()).toBe(0);
      } finally {
        store.dispose();
      }
    });

    it('reports mode() === "session-memory"', () => {
      const store = createSecretStore('session-memory');
      try {
        expect(store.mode()).toBe('session-memory');
      } finally {
        store.dispose();
      }
    });

    it('clears records on dispose', async () => {
      const store = createSecretStore('session-memory');
      await store.put('x', 'y');
      store.dispose();
      await expect(store.put('x', 'y')).rejects.toThrow(/^storage_unavailable:/);
    });
  });

  describe('sessionMemoryStore beforeunload listener', () => {
    it('registers a beforeunload listener and clears on dispatch', () => {
      const target = new EventTarget();
      let addCount = 0;
      let removeCount = 0;
      const adapter = {
        addEventListener(type: string, listener: () => void) {
          addCount += 1;
          target.addEventListener(type, listener);
        },
        removeEventListener(type: string, listener: () => void) {
          removeCount += 1;
          target.removeEventListener(type, listener);
        },
      };

      const store = createSessionMemoryStore({ unloadTarget: adapter });
      store.put('a', 'one');
      expect(store.get('a')).toBe('one');
      expect(addCount).toBe(1);

      target.dispatchEvent(new Event('beforeunload'));
      expect(store.get('a')).toBeUndefined();

      store.dispose();
      expect(removeCount).toBe(1);
    });

    it('skips listener registration when no target is provided', () => {
      const store = createSessionMemoryStore({ unloadTarget: null });
      store.put('a', 'one');
      expect(store.get('a')).toBe('one');
      store.dispose();
      expect(store.get('a')).toBeUndefined();
    });

    it('dispose() is idempotent and only removes its listener once', () => {
      const target = new EventTarget();
      let removeCount = 0;
      const adapter = {
        addEventListener(type: string, listener: () => void) {
          target.addEventListener(type, listener);
        },
        removeEventListener(type: string, listener: () => void) {
          removeCount += 1;
          target.removeEventListener(type, listener);
        },
      };
      const store = createSessionMemoryStore({ unloadTarget: adapter });
      store.put('a', 'one');
      expect(() => store.dispose()).not.toThrow();
      expect(() => store.dispose()).not.toThrow();
      expect(() => store.dispose()).not.toThrow();
      expect(removeCount).toBe(1);
    });
  });

  describe('secretStore — none mode', () => {
    it('get returns undefined; writes throw storage_unavailable', async () => {
      const store = createSecretStore('none');
      try {
        expect(store.mode()).toBe('none');
        expect(await store.get('anything')).toBeUndefined();
        await expect(store.put('a', 'x')).rejects.toThrow(/^storage_unavailable:/);
        await expect(store.delete('a')).rejects.toThrow(/^storage_unavailable:/);
        await expect(store.clear()).rejects.toThrow(/^storage_unavailable:/);
      } finally {
        store.dispose();
      }
    });
  });

  describe('redaction sanity', () => {
    it('errors triggered by storage failures never expose the plaintext secret', async () => {
      const store = createSecretStore('encrypted-indexeddb');
      try {
        const secret = 'sk-prod-abcdefghijklmnop';
        fake.failNextOp('UnknownError', 'forced');
        let caught: Error | null = null;
        try {
          await store.put('apiKey:openai', secret);
        } catch (err) {
          caught = err as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message).not.toContain(secret);
        expect(caught!.message).not.toContain('sk-');
        expect(caught!.message).not.toContain('Bearer');
      } finally {
        store.dispose();
      }
    });
  });
});
