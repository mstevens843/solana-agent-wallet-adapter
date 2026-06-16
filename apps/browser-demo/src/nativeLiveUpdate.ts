export interface AppBuildMetadata {
  commit: string;
  deployedAt: string | null;
}

export interface NativeLiveUpdateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface NativeLiveUpdateLocation {
  href: string;
  origin: string;
  pathname: string;
  search: string;
  replace(url: string): void;
  reload(): void;
}

export interface NativeLiveUpdateOptions {
  enabled: boolean;
  currentBuildCommit?: string;
  liveOrigin?: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  storage: NativeLiveUpdateStorage;
  location: NativeLiveUpdateLocation;
  nowMs: () => number;
  walletRequestActive: () => boolean;
  logger?: Pick<Console, 'info' | 'warn'>;
  minCheckIntervalMs?: number;
  requestTimeoutMs?: number;
  maxReloadAttemptsPerCommit?: number;
}

const BUILD_COMMIT_STORAGE_KEY = 'agentic:lastSeenBuildCommit';
const RELOAD_COMMIT_STORAGE_KEY = 'agentic:lastReloadBuildCommit';
const RELOAD_ATTEMPT_STORAGE_KEY = 'agentic:nativeLiveUpdateReloadAttempt';
const DEFAULT_MIN_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_RELOAD_ATTEMPTS_PER_COMMIT = 5;
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000, 300_000];

interface ReloadAttemptState {
  commit: string;
  count: number;
  nextRetryAtMs: number;
}

let lastCheckAtMs = 0;
let checkInFlight: Promise<'skipped' | 'current' | 'reloading' | 'error'> | null = null;

export function resetNativeLiveUpdateStateForTests(): void {
  lastCheckAtMs = 0;
  checkInFlight = null;
}

export async function checkNativeLiveUpdate(
  options: NativeLiveUpdateOptions,
): Promise<'skipped' | 'current' | 'reloading' | 'error'> {
  if (!options.enabled) return 'skipped';
  if (options.walletRequestActive()) return 'skipped';
  if (checkInFlight) return checkInFlight;

  const now = options.nowMs();
  const minInterval = options.minCheckIntervalMs ?? DEFAULT_MIN_CHECK_INTERVAL_MS;
  if (lastCheckAtMs > 0 && now - lastCheckAtMs < minInterval) return 'skipped';
  lastCheckAtMs = now;

  checkInFlight = runNativeLiveUpdateCheck(options).finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

async function runNativeLiveUpdateCheck(
  options: NativeLiveUpdateOptions,
): Promise<'skipped' | 'current' | 'reloading' | 'error'> {
  try {
    const response = await fetchWithTimeout(options);
    if (!response.ok) return 'error';
    const build = parseAppBuildMetadata(await response.json().catch(() => null));
    if (!build?.commit || build.commit === 'unknown') return 'current';

    const now = options.nowMs();
    const currentBuildCommit = normalizeBuildCommit(options.currentBuildCommit);
    const previous = options.storage.getItem(BUILD_COMMIT_STORAGE_KEY) ?? '';
    if (currentBuildCommit && currentBuildCommit === build.commit) {
      options.storage.setItem(BUILD_COMMIT_STORAGE_KEY, build.commit);
      clearReloadAttempt(options.storage);
      return 'current';
    }
    const changedFromCurrentBundle = Boolean(currentBuildCommit && currentBuildCommit !== build.commit);
    const changedFromStoredCommit = Boolean(previous && previous !== build.commit);
    if (!changedFromCurrentBundle && !changedFromStoredCommit) {
      options.storage.setItem(BUILD_COMMIT_STORAGE_KEY, build.commit);
      clearReloadAttempt(options.storage);
      return 'current';
    }

    if (options.walletRequestActive()) return 'skipped';
    const attempt = nextReloadAttempt(options, build.commit, now);
    if (!attempt.ready) {
      options.logger?.warn?.('[native-live-update] deployed build is stale but reload retry is throttled', {
        previous,
        next: build.commit,
        currentBuildCommit,
        attemptCount: attempt.state.count,
        nextRetryAtMs: attempt.state.nextRetryAtMs,
      });
      return 'skipped';
    }
    if (attempt.exhausted) {
      options.logger?.warn?.('[native-live-update] deployed build is stale but reload retry budget is exhausted', {
        previous,
        next: build.commit,
        currentBuildCommit,
        attemptCount: attempt.state.count,
      });
      return 'error';
    }
    options.storage.setItem(BUILD_COMMIT_STORAGE_KEY, build.commit);
    options.storage.setItem(RELOAD_COMMIT_STORAGE_KEY, build.commit);
    options.storage.setItem(RELOAD_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt.state));
    options.logger?.info?.('[native-live-update] deployed build changed; reloading', {
      previous,
      next: build.commit,
      deployedAt: build.deployedAt,
      currentBuildCommit,
      attemptCount: attempt.state.count,
    });
    options.location.replace(cacheBustedUrl(options.location, build.commit, options.liveOrigin));
    return 'reloading';
  } catch (err) {
    options.logger?.warn?.('[native-live-update] build check failed', err);
    return 'error';
  }
}

async function fetchWithTimeout(options: NativeLiveUpdateOptions): Promise<Response> {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (timeoutMs <= 0 || typeof AbortController === 'undefined') {
    return options.fetch('/api/app-build', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
    });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await options.fetch('/api/app-build', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function parseAppBuildMetadata(value: unknown): AppBuildMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const commit = typeof record.commit === 'string' ? record.commit.trim() : '';
  if (!commit) return null;
  return {
    commit,
    deployedAt: typeof record.deployedAt === 'string' ? record.deployedAt : null,
  };
}

function normalizeBuildCommit(value: string | undefined): string {
  return (value ?? '').trim();
}

function cacheBustedUrl(location: NativeLiveUpdateLocation, commit: string, liveOrigin?: string): string {
  const current = new URL(location.href);
  const base = liveOriginForReload(location, liveOrigin);
  const url = new URL(`${current.pathname}${current.search}${current.hash}`, base ?? current.origin);
  url.searchParams.set('agentic_build', commit);
  return base ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

function liveOriginForReload(location: NativeLiveUpdateLocation, liveOrigin?: string): string | null {
  const normalized = normalizeLiveOrigin(liveOrigin);
  if (!normalized) return null;
  const origin = location.origin.toLowerCase();
  if (origin === normalized.toLowerCase()) return null;
  if (origin === 'capacitor://localhost' || origin === 'https://agentic.local' || origin === 'http://agentic.local') {
    return normalized;
  }
  return null;
}

function normalizeLiveOrigin(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function nextReloadAttempt(
  options: NativeLiveUpdateOptions,
  commit: string,
  nowMs: number,
): { ready: true; exhausted: false; state: ReloadAttemptState } |
  { ready: true; exhausted: true; state: ReloadAttemptState } |
  { ready: false; exhausted: false; state: ReloadAttemptState } {
  const maxAttempts = Math.max(1, options.maxReloadAttemptsPerCommit ?? DEFAULT_MAX_RELOAD_ATTEMPTS_PER_COMMIT);
  const existing = parseReloadAttempt(options.storage.getItem(RELOAD_ATTEMPT_STORAGE_KEY));
  const current = existing?.commit === commit ? existing : { commit, count: 0, nextRetryAtMs: 0 };
  if (current.count >= maxAttempts) {
    return { ready: true, exhausted: true, state: current };
  }
  if (current.nextRetryAtMs > nowMs) {
    return { ready: false, exhausted: false, state: current };
  }
  const nextCount = current.count + 1;
  const delay = RETRY_DELAYS_MS[Math.min(nextCount, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
  return {
    ready: true,
    exhausted: false,
    state: {
      commit,
      count: nextCount,
      nextRetryAtMs: nowMs + delay,
    },
  };
}

function parseReloadAttempt(raw: string | null): ReloadAttemptState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReloadAttemptState>;
    const commit = typeof parsed.commit === 'string' ? parsed.commit.trim() : '';
    const count = typeof parsed.count === 'number' && Number.isFinite(parsed.count) ? Math.max(0, parsed.count) : 0;
    const nextRetryAtMs =
      typeof parsed.nextRetryAtMs === 'number' && Number.isFinite(parsed.nextRetryAtMs)
        ? Math.max(0, parsed.nextRetryAtMs)
        : 0;
    if (!commit) return null;
    return { commit, count, nextRetryAtMs };
  } catch {
    return null;
  }
}

function clearReloadAttempt(storage: NativeLiveUpdateStorage): void {
  if (typeof storage.removeItem === 'function') {
    storage.removeItem(RELOAD_ATTEMPT_STORAGE_KEY);
    return;
  }
  storage.setItem(RELOAD_ATTEMPT_STORAGE_KEY, '');
}
