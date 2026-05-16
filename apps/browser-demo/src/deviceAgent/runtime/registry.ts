import { validateRuntimeConfig, type RuntimeConfig } from './config.js';
import { RUNTIME_ERROR_CODES } from './errors.js';
import { type ProviderExecutor, RequestQueue } from './queue.js';
import type { RuntimeRequest, RuntimeResult } from './request.js';
import type { RuntimeError, RuntimeStateWire } from './state.js';

export interface RegistrySnapshotPersist {
  state: RuntimeStateWire;
  error: RuntimeError | null;
  lastTransitionAtMs: number;
}

export interface RuntimePersistence {
  load(): Promise<RegistrySnapshotPersist>;
  save(state: RuntimeStateWire, error: RuntimeError | null): Promise<void>;
}

export interface RegistryDependencies {
  readonly persistence: RuntimePersistence;
  readonly executorProvider: () => ProviderExecutor;
  readonly clock?: () => number;
}

export interface RegistrySnapshot {
  readonly state: RuntimeStateWire;
  readonly lastError: RuntimeError | null;
  readonly config: RuntimeConfig | null;
  readonly lastTransitionAtMs: number;
}

export class BrowserRuntimeRegistry {
  private readonly persistence: RuntimePersistence;
  private readonly clock: () => number;

  private executor: ProviderExecutor | null = null;
  private readonly executorProvider: () => ProviderExecutor;

  private hydrated = false;
  private state: RuntimeStateWire = 'stopped';
  private lastError: RuntimeError | null = null;
  private activeConfig: RuntimeConfig | null = null;
  private lastTransitionAtMs = 0;
  private queue: RequestQueue | null = null;

  private mutex: Promise<unknown> = Promise.resolve();

  constructor(deps: RegistryDependencies) {
    this.persistence = deps.persistence;
    this.executorProvider = deps.executorProvider;
    this.clock = deps.clock ?? Date.now;
  }

  setExecutor(executor: ProviderExecutor): void {
    this.executor = executor;
  }

  snapshot(): RegistrySnapshot {
    return {
      state: this.state,
      lastError: this.lastError,
      config: this.activeConfig,
      lastTransitionAtMs: this.lastTransitionAtMs,
    };
  }

  async hydrate(): Promise<void> {
    await this.withLock(async () => {
      if (this.hydrated) return;
      const snap = await this.persistence.load();
      const downgraded = snap.state === 'running' || snap.state === 'starting' ? 'stopped' : snap.state;
      this.state = downgraded;
      this.lastError = downgraded === 'error' ? snap.error : null;
      this.lastTransitionAtMs = snap.lastTransitionAtMs;
      if (downgraded !== snap.state) {
        await this.persistAndStamp(this.state, this.lastError);
      }
      this.hydrated = true;
    });
  }

  async start(config: RuntimeConfig | null): Promise<RuntimeStateWire> {
    return this.withLock(async () => {
      this.teardownQueue();

      const validation = validateRuntimeConfig(config);
      if (validation) {
        this.state = 'error';
        this.lastError = validation;
        this.activeConfig = null;
        await this.persistAndStamp(this.state, this.lastError);
        return this.state;
      }

      this.state = 'starting';
      this.lastError = null;
      this.activeConfig = config;
      await this.persistAndStamp(this.state, this.lastError);

      const nextQueue = new RequestQueue({
        executorProvider: () => this.resolveExecutor(),
        configProvider: () => this.activeConfig,
        clock: this.clock,
      });
      nextQueue.start();
      this.queue = nextQueue;

      this.state = 'running';
      await this.persistAndStamp(this.state, null);
      return this.state;
    });
  }

  async stop(): Promise<RuntimeStateWire> {
    return this.withLock(async () => {
      this.teardownQueue();
      this.state = 'stopped';
      this.lastError = null;
      this.activeConfig = null;
      await this.persistAndStamp(this.state, null);
      return this.state;
    });
  }

  async recordError(error: RuntimeError): Promise<RuntimeStateWire> {
    return this.withLock(async () => {
      this.teardownQueue();
      this.state = 'error';
      this.lastError = error;
      this.activeConfig = null;
      await this.persistAndStamp(this.state, this.lastError);
      return this.state;
    });
  }

  async submit(request: RuntimeRequest): Promise<RuntimeResult> {
    const activeQueue = this.queue;
    if (this.state !== 'running' || !activeQueue) {
      return {
        kind: 'failed',
        requestId: request.requestId,
        method: request.method,
        error: {
          code: RUNTIME_ERROR_CODES.RUNTIME_NOT_RUNNING,
          message: 'Device Agent runtime is not running.',
        },
        completedAtMs: this.clock(),
      };
    }
    return activeQueue.submit(request);
  }

  private resolveExecutor(): ProviderExecutor {
    if (this.executor) return this.executor;
    return this.executorProvider();
  }

  private teardownQueue(): void {
    const current = this.queue;
    this.queue = null;
    if (current) current.stop();
  }

  private async persistAndStamp(state: RuntimeStateWire, error: RuntimeError | null): Promise<void> {
    this.lastTransitionAtMs = this.clock();
    await this.persistence.save(state, error);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(() => fn());
    this.mutex = next.catch(() => undefined);
    return next;
  }
}
