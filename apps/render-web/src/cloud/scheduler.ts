import type { MaterializeResult, RecurringService, RecurringStore } from './recurringService.js';

export interface RecurringSchedulerOptions {
  service: RecurringService;
  store: RecurringStore;
  intervalMs?: number;
  enabled?: boolean;
  onTick?: (results: TickResult) => void;
  onError?: (err: unknown, walletAddress?: string) => void;
}

export interface TickResult {
  ranAt: string;
  walletResults: Array<{ walletAddress: string; results: MaterializeResult[] }>;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class RecurringScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inflight: Promise<TickResult> | undefined;
  private readonly intervalMs: number;
  private readonly enabled: boolean;

  constructor(private readonly options: RecurringSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.enabled = options.enabled ?? defaultEnabled();
  }

  start(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<TickResult> {
    if (this.inflight) return this.inflight;
    const ranAt = new Date().toISOString();
    const wallets = await this.collectWallets();
    const walletResults: TickResult['walletResults'] = [];
    const promise = (async () => {
      for (const walletAddress of wallets) {
        try {
          const results = await this.options.service.materializeDueOccurrences({ walletAddress });
          walletResults.push({ walletAddress, results });
        } catch (err) {
          this.options.onError?.(err, walletAddress);
        }
      }
      const tickResult: TickResult = { ranAt, walletResults };
      this.options.onTick?.(tickResult);
      return tickResult;
    })();
    this.inflight = promise;
    try {
      return await promise;
    } finally {
      this.inflight = undefined;
    }
  }

  private async collectWallets(): Promise<string[]> {
    if (!this.options.store.listKnownWallets) return [];
    try {
      return await this.options.store.listKnownWallets();
    } catch (err) {
      this.options.onError?.(err);
      return [];
    }
  }
}

function defaultEnabled(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.AGW_DISABLE_SCHEDULER === '1') return false;
  return true;
}
