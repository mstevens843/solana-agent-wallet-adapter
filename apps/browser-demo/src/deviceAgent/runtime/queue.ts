import type { RuntimeConfig } from './config.js';
import {
  ProviderFailedError,
  ProviderUnavailableError,
  RUNTIME_CONFIG_SUBCODES,
  RUNTIME_ERROR_CODES,
} from './errors.js';
import type {
  RuntimeRequest,
  RuntimeResult,
  RuntimeResultFailed,
  RuntimeResultOk,
} from './request.js';
import type { RuntimeError } from './state.js';

export const DEFAULT_QUEUE_CAPACITY = 64;

export interface ProviderExecutor {
  generatePlan(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  reviewPlan(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  ask(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface RequestQueueOptions {
  readonly capacity?: number;
  readonly executorProvider: () => ProviderExecutor;
  readonly configProvider: () => RuntimeConfig | null;
  readonly clock?: () => number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  const deferred: Deferred<T> = {
    promise,
    settled: false,
    resolve(value: T) {
      if (deferred.settled) return;
      deferred.settled = true;
      resolveFn(value);
    },
  };
  return deferred;
}

interface PendingEntry {
  readonly request: RuntimeRequest;
  readonly deferred: Deferred<RuntimeResult>;
}

interface InflightEntry extends PendingEntry {
  readonly controller: AbortController;
}

export class RequestQueue {
  private readonly capacity: number;
  private readonly executorProvider: () => ProviderExecutor;
  private readonly configProvider: () => RuntimeConfig | null;
  private readonly clock: () => number;

  private stopped = false;
  private readonly pending: PendingEntry[] = [];
  private inflight: InflightEntry | null = null;
  private workerRunning = false;

  constructor(options: RequestQueueOptions) {
    this.capacity = options.capacity ?? DEFAULT_QUEUE_CAPACITY;
    this.executorProvider = options.executorProvider;
    this.configProvider = options.configProvider;
    this.clock = options.clock ?? Date.now;
  }

  start(): void {
    // No-op marker for API parity with the Kotlin runtime. The worker is kicked on submit().
  }

  submit(request: RuntimeRequest): Promise<RuntimeResult> {
    const deferred = createDeferred<RuntimeResult>();

    if (this.stopped) {
      deferred.resolve(this.makeFailed(request, {
        code: RUNTIME_ERROR_CODES.RUNTIME_NOT_RUNNING,
        message: 'Device Agent runtime queue is closed.',
      }));
      return deferred.promise;
    }

    const queued = this.pending.length + (this.inflight ? 1 : 0);
    if (queued >= this.capacity) {
      deferred.resolve(this.makeFailed(request, {
        code: RUNTIME_ERROR_CODES.RUNTIME_BUSY,
        message: 'Device Agent runtime queue is full; retry shortly.',
      }));
      return deferred.promise;
    }

    this.pending.push({ request, deferred });
    this.kickWorker();
    return deferred.promise;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    const inflight = this.inflight;
    if (inflight) {
      try {
        inflight.controller.abort();
      } catch {
        // AbortController.abort() never throws in standard environments; defensive only.
      }
      inflight.deferred.resolve(this.canceledResult(inflight.request));
    }

    const drained = this.pending.splice(0);
    for (const entry of drained) {
      entry.deferred.resolve(this.canceledResult(entry.request));
    }
  }

  private kickWorker(): void {
    if (this.workerRunning) return;
    this.workerRunning = true;
    void this.runWorker();
  }

  private async runWorker(): Promise<void> {
    try {
      while (!this.stopped && this.pending.length > 0) {
        const entry = this.pending.shift();
        if (!entry) break;
        if (entry.deferred.settled) continue;

        const controller = new AbortController();
        this.inflight = { ...entry, controller };

        const result = await this.runRequest(entry.request, controller.signal);
        entry.deferred.resolve(result);

        if (this.inflight && this.inflight.request === entry.request) {
          this.inflight = null;
        }
      }
    } finally {
      this.workerRunning = false;
    }
  }

  private async runRequest(request: RuntimeRequest, signal: AbortSignal): Promise<RuntimeResult> {
    const config = this.configProvider();
    if (!config) {
      return this.makeFailed(request, {
        code: RUNTIME_ERROR_CODES.INVALID_CONFIG,
        subcode: RUNTIME_CONFIG_SUBCODES.MISSING_PROVIDER,
        message: 'Device Agent config disappeared while runtime was running.',
      });
    }

    try {
      const executor = this.executorProvider();
      const data = await this.callMethod(executor, config, request, signal);
      return this.makeOk(request, data);
    } catch (err) {
      return this.makeFailed(request, this.mapError(err, signal.aborted));
    }
  }

  private callMethod(
    executor: ProviderExecutor,
    config: RuntimeConfig,
    request: RuntimeRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (request.method) {
      case 'generatePlan':
        return executor.generatePlan(config, request.payload, signal);
      case 'reviewPlan':
        return executor.reviewPlan(config, request.payload, signal);
      case 'ask':
        return executor.ask(config, request.payload, signal);
    }
  }

  private mapError(err: unknown, aborted: boolean): RuntimeError {
    if (err instanceof ProviderUnavailableError) return err.error;
    if (err instanceof ProviderFailedError) return err.error;
    if (aborted || (err instanceof Error && err.name === 'AbortError')) {
      return {
        code: RUNTIME_ERROR_CODES.RUNTIME_CANCELED,
        message: 'Device Agent runtime stopped before this request executed.',
      };
    }
    const message =
      err instanceof Error
        ? err.message || err.constructor.name
        : typeof err === 'string'
          ? err
          : 'unknown';
    return {
      code: RUNTIME_ERROR_CODES.RUNTIME_INTERNAL,
      message,
    };
  }

  private makeOk(request: RuntimeRequest, data: unknown): RuntimeResultOk {
    return {
      kind: 'ok',
      requestId: request.requestId,
      method: request.method,
      data,
      completedAtMs: this.clock(),
    };
  }

  private makeFailed(request: RuntimeRequest, error: RuntimeError): RuntimeResultFailed {
    return {
      kind: 'failed',
      requestId: request.requestId,
      method: request.method,
      error,
      completedAtMs: this.clock(),
    };
  }

  private canceledResult(request: RuntimeRequest): RuntimeResultFailed {
    return this.makeFailed(request, {
      code: RUNTIME_ERROR_CODES.RUNTIME_CANCELED,
      message: 'Device Agent runtime stopped before this request executed.',
    });
  }
}
