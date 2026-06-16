export interface AppBuildMetadata {
  commit: string;
  deployedAt: string | null;
}

export interface NativeLiveUpdateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  storage: NativeLiveUpdateStorage;
  location: NativeLiveUpdateLocation;
  nowMs: () => number;
  walletRequestActive: () => boolean;
  logger?: Pick<Console, 'info' | 'warn'>;
  minCheckIntervalMs?: number;
}

const BUILD_COMMIT_STORAGE_KEY = 'agentic:lastSeenBuildCommit';
const RELOAD_COMMIT_STORAGE_KEY = 'agentic:lastReloadBuildCommit';
const DEFAULT_MIN_CHECK_INTERVAL_MS = 60_000;

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
    const response = await options.fetch('/api/app-build', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) return 'error';
    const build = parseAppBuildMetadata(await response.json().catch(() => null));
    if (!build?.commit || build.commit === 'unknown') return 'current';

    const previous = options.storage.getItem(BUILD_COMMIT_STORAGE_KEY) ?? '';
    if (!previous || previous === build.commit) {
      options.storage.setItem(BUILD_COMMIT_STORAGE_KEY, build.commit);
      return 'current';
    }
    if (options.walletRequestActive()) return 'skipped';

    const lastReloaded = options.storage.getItem(RELOAD_COMMIT_STORAGE_KEY) ?? '';
    if (lastReloaded === build.commit) {
      options.storage.setItem(BUILD_COMMIT_STORAGE_KEY, build.commit);
      return 'current';
    }
    options.storage.setItem(BUILD_COMMIT_STORAGE_KEY, build.commit);
    options.storage.setItem(RELOAD_COMMIT_STORAGE_KEY, build.commit);
    options.logger?.info?.('[native-live-update] deployed build changed; reloading', {
      previous,
      next: build.commit,
      deployedAt: build.deployedAt,
    });
    options.location.replace(cacheBustedUrl(options.location, build.commit));
    return 'reloading';
  } catch (err) {
    options.logger?.warn?.('[native-live-update] build check failed', err);
    return 'error';
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

function cacheBustedUrl(location: NativeLiveUpdateLocation, commit: string): string {
  const url = new URL(location.href);
  url.searchParams.set('agentic_build', commit);
  return `${url.pathname}${url.search}${url.hash}`;
}
