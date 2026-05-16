export interface SessionMemoryStore {
  put(key: string, plaintext: string): void;
  get(key: string): string | undefined;
  delete(key: string): void;
  clear(): void;
  dispose(): void;
}

interface EventTargetLike {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export interface CreateSessionMemoryStoreOptions {
  readonly unloadTarget?: EventTargetLike | null;
}

function detectDefaultUnloadTarget(): EventTargetLike | null {
  try {
    const win = (globalThis as { window?: unknown }).window as EventTargetLike | undefined;
    if (
      win
      && typeof win.addEventListener === 'function'
      && typeof win.removeEventListener === 'function'
    ) {
      return win;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function createSessionMemoryStore(
  options: CreateSessionMemoryStoreOptions = {},
): SessionMemoryStore {
  const records = new Map<string, string>();
  const target = options.unloadTarget === undefined
    ? detectDefaultUnloadTarget()
    : options.unloadTarget;
  const onUnload = (): void => { records.clear(); };
  if (target) target.addEventListener('beforeunload', onUnload);

  let disposed = false;
  return {
    put(key, plaintext) {
      records.set(key, plaintext);
    },
    get(key) {
      return records.get(key);
    },
    delete(key) {
      records.delete(key);
    },
    clear() {
      records.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      records.clear();
      if (target) {
        try { target.removeEventListener('beforeunload', onUnload); } catch { /* ignore */ }
      }
    },
  };
}
