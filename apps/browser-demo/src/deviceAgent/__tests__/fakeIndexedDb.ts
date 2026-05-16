/**
 * Minimal in-memory IndexedDB shim used by storage/persistence tests only.
 * Not a production dependency. Skips structured-clone semantics by passing
 * record references through unchanged — which lets CryptoKey instances
 * survive a put/get round-trip in tests.
 */

type Listener = ((event?: unknown) => void) | null;

interface FakeStoreState {
  keyPath: string;
  records: Map<unknown, Record<string, unknown>>;
}

interface FakeDbState {
  version: number;
  stores: Map<string, FakeStoreState>;
}

interface FaultConfig {
  nextOpReason?: { name: string; message: string };
  nextOpenReason?: { name: string; message: string };
  nextTransactionReason?: { name: string; message: string };
}

function makeDomError(name: string, message: string): { name: string; message: string } {
  return { name, message };
}

class FakeIDBRequest<T = unknown> {
  result: T | undefined = undefined;
  error: { name: string; message: string } | null = null;
  onsuccess: Listener = null;
  onerror: Listener = null;
}

class FakeIDBOpenDBRequest extends FakeIDBRequest<FakeIDBDatabase> {
  onupgradeneeded: Listener = null;
  onblocked: Listener = null;
  transaction: FakeIDBTransaction | null = null;
}

class FakeIDBObjectStore {
  constructor(
    public name: string,
    private state: FakeStoreState,
    private tx: FakeIDBTransaction | null,
    private fault: FaultConfig,
  ) {}

  put(value: Record<string, unknown>): FakeIDBRequest {
    return this.runOp(() => {
      const key = value[this.state.keyPath];
      this.state.records.set(key, value);
      return key as unknown;
    });
  }

  get(key: unknown): FakeIDBRequest {
    return this.runOp(() => this.state.records.get(key));
  }

  delete(key: unknown): FakeIDBRequest {
    return this.runOp(() => {
      this.state.records.delete(key);
      return undefined;
    });
  }

  clear(): FakeIDBRequest {
    return this.runOp(() => {
      this.state.records.clear();
      return undefined;
    });
  }

  private runOp(action: () => unknown): FakeIDBRequest {
    const req = new FakeIDBRequest();
    if (!this.tx) {
      // Upgrade-context use only allows createObjectStore; out-of-tx ops are bugs.
      throw new Error('object store used outside transaction');
    }
    this.tx.trackOp(req, () => {
      if (this.fault.nextOpReason) {
        const reason = this.fault.nextOpReason;
        this.fault.nextOpReason = undefined;
        throw reason;
      }
      return action();
    });
    return req;
  }
}

class FakeIDBTransaction {
  oncomplete: Listener = null;
  onerror: Listener = null;
  onabort: Listener = null;
  error: { name: string; message: string } | null = null;
  private pending = 0;
  private settled = false;
  private aborted = false;
  private autoCompletePending = true;

  constructor(
    private dbState: FakeDbState,
    private storeNames: ReadonlyArray<string>,
    public mode: 'readonly' | 'readwrite',
    private fault: FaultConfig,
  ) {
    // If no ops are queued, complete naturally after a microtask drain.
    queueMicrotask(() => {
      this.autoCompletePending = false;
      this.tryComplete();
    });
  }

  objectStore(name: string): FakeIDBObjectStore {
    if (!this.storeNames.includes(name)) {
      throw makeDomError('NotFoundError', `store ${name} not in transaction`) as unknown as Error;
    }
    const store = this.dbState.stores.get(name);
    if (!store) {
      throw makeDomError('NotFoundError', `store ${name} missing`) as unknown as Error;
    }
    return new FakeIDBObjectStore(name, store, this, this.fault);
  }

  abort(): void {
    if (this.settled) return;
    this.aborted = true;
    this.error = makeDomError('AbortError', 'transaction aborted');
    queueMicrotask(() => {
      if (this.settled) return;
      this.settled = true;
      this.onabort?.();
    });
  }

  trackOp(req: FakeIDBRequest, action: () => unknown): void {
    this.pending += 1;
    queueMicrotask(() => {
      try {
        req.result = action() as never;
        req.onsuccess?.();
      } catch (err) {
        const errored = err as { name?: string; message?: string };
        req.error = makeDomError(errored.name ?? 'Error', errored.message ?? String(err));
        this.error = req.error;
        this.aborted = true;
        req.onerror?.();
      }
      this.pending -= 1;
      this.tryComplete();
    });
  }

  private tryComplete(): void {
    if (this.settled) return;
    if (this.autoCompletePending) return;
    if (this.pending > 0) return;
    if (this.aborted) {
      this.settled = true;
      // Fire onerror then onabort to mirror real IDB sequencing.
      this.onerror?.();
      this.onabort?.();
      return;
    }
    this.settled = true;
    this.oncomplete?.();
  }
}

class FakeIDBDatabase {
  closed = false;
  storeNames: Set<string>;

  constructor(
    public name: string,
    public version: number,
    private dbState: FakeDbState,
    private fault: FaultConfig,
  ) {
    this.storeNames = new Set(dbState.stores.keys());
  }

  get objectStoreNames(): { contains: (name: string) => boolean; length: number } {
    const names = this.storeNames;
    return {
      contains: (name: string) => names.has(name),
      get length() { return names.size; },
    };
  }

  createObjectStore(name: string, options: { keyPath: string }): FakeIDBObjectStore {
    if (this.dbState.stores.has(name)) {
      throw makeDomError('ConstraintError', `store ${name} exists`) as unknown as Error;
    }
    const store: FakeStoreState = { keyPath: options.keyPath, records: new Map() };
    this.dbState.stores.set(name, store);
    this.storeNames.add(name);
    return new FakeIDBObjectStore(name, store, null, this.fault);
  }

  transaction(stores: string | string[], mode: 'readonly' | 'readwrite' = 'readonly'): FakeIDBTransaction {
    if (this.fault.nextTransactionReason) {
      const reason = this.fault.nextTransactionReason;
      this.fault.nextTransactionReason = undefined;
      throw reason as unknown as Error;
    }
    const names = Array.isArray(stores) ? stores : [stores];
    for (const n of names) {
      if (!this.dbState.stores.has(n)) {
        throw makeDomError('NotFoundError', `store ${n} missing`) as unknown as Error;
      }
    }
    return new FakeIDBTransaction(this.dbState, names, mode, this.fault);
  }

  close(): void {
    this.closed = true;
  }
}

class FakeIDBFactory {
  readonly dbs = new Map<string, FakeDbState>();
  readonly fault: FaultConfig = {};

  open(name: string, version: number): FakeIDBOpenDBRequest {
    const req = new FakeIDBOpenDBRequest();
    queueMicrotask(() => {
      if (this.fault.nextOpenReason) {
        const reason = this.fault.nextOpenReason;
        this.fault.nextOpenReason = undefined;
        req.error = reason;
        req.onerror?.();
        return;
      }
      let state = this.dbs.get(name);
      let isUpgrade = false;
      if (!state) {
        state = { version, stores: new Map() };
        this.dbs.set(name, state);
        isUpgrade = true;
      } else if (state.version < version) {
        state.version = version;
        isUpgrade = true;
      } else if (state.version > version) {
        req.error = makeDomError('VersionError', `existing version ${state.version} > requested ${version}`);
        req.onerror?.();
        return;
      }
      const db = new FakeIDBDatabase(name, state.version, state, this.fault);
      req.result = db;
      if (isUpgrade) {
        req.transaction = { abort: () => undefined } as unknown as FakeIDBTransaction;
        req.onupgradeneeded?.();
        req.transaction = null;
      }
      req.onsuccess?.();
    });
    return req;
  }

  deleteDatabase(name: string): FakeIDBRequest {
    const req = new FakeIDBRequest();
    queueMicrotask(() => {
      this.dbs.delete(name);
      req.onsuccess?.();
    });
    return req;
  }
}

export interface FakeIndexedDbHarness {
  install(): void;
  uninstall(): void;
  reset(): void;
  failNextOp(name: string, message: string): void;
  failNextOpen(name: string, message: string): void;
  failNextTransaction(name: string, message: string): void;
  peek(dbName: string, storeName: string, key: unknown): unknown;
  dbCount(): number;
}

export function createFakeIndexedDb(): FakeIndexedDbHarness {
  let factory: FakeIDBFactory | null = null;
  let originalDescriptor: PropertyDescriptor | undefined;

  return {
    install() {
      factory = new FakeIDBFactory();
      const target = globalThis as { indexedDB?: unknown };
      originalDescriptor = Object.getOwnPropertyDescriptor(target, 'indexedDB');
      Object.defineProperty(target, 'indexedDB', {
        value: factory,
        configurable: true,
        writable: true,
      });
    },
    uninstall() {
      const target = globalThis as { indexedDB?: unknown };
      if (originalDescriptor) {
        Object.defineProperty(target, 'indexedDB', originalDescriptor);
      } else {
        try { delete target.indexedDB; } catch { /* ignore */ }
      }
      factory = null;
      originalDescriptor = undefined;
    },
    reset() {
      if (factory) {
        factory.dbs.clear();
        factory.fault.nextOpReason = undefined;
        factory.fault.nextOpenReason = undefined;
        factory.fault.nextTransactionReason = undefined;
      }
    },
    failNextOp(name, message) {
      if (factory) factory.fault.nextOpReason = { name, message };
    },
    failNextOpen(name, message) {
      if (factory) factory.fault.nextOpenReason = { name, message };
    },
    failNextTransaction(name, message) {
      if (factory) factory.fault.nextTransactionReason = { name, message };
    },
    peek(dbName, storeName, key) {
      const db = factory?.dbs.get(dbName);
      if (!db) return undefined;
      const store = db.stores.get(storeName);
      if (!store) return undefined;
      return store.records.get(key);
    },
    dbCount() {
      return factory?.dbs.size ?? 0;
    },
  };
}
