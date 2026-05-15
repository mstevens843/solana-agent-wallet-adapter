// Shared connection-state cache used by dev-only Layer 1 tabs (Pay Out,
// External Agents, Agent Card) to know the connected wallet's full pubkey
// synchronously from a tab `guard()`. main.ts holds the authoritative value
// in module-private `state.address` and exports nothing, so we derive the
// same signal from the cloud session cookie that every cloud-aware feature
// already uses. When the cached value changes, we click the active tab
// button so main.ts re-runs render() and dev-tab guards re-evaluate.

let cachedAddress: string | null = null;
let inflight: Promise<void> | null = null;
let initialized = false;

interface SessionEnvelope {
  signedIn?: boolean;
  session?: { walletAddress?: string };
}

async function fetchSessionOnce(): Promise<void> {
  try {
    const res = await fetch('/api/session', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      updateCached(null);
      return;
    }
    const body = (await res.json()) as SessionEnvelope;
    const addr = body.signedIn && body.session?.walletAddress ? body.session.walletAddress : null;
    updateCached(addr);
  } catch {
    // Network blip — keep last value; the next poll retries.
  }
}

function updateCached(next: string | null): void {
  if (next === cachedAddress) return;
  cachedAddress = next;
  triggerHostRerender();
}

function triggerHostRerender(): void {
  if (typeof document === 'undefined') return;
  // Clicking the currently-active workspace tab re-runs main.ts's render(),
  // which re-evaluates every dev-tab guard().
  const active = document.querySelector<HTMLButtonElement>('button[data-tab].active');
  active?.click();
}

export function currentAddress(): string | null {
  return cachedAddress;
}

export function refreshConnection(): Promise<void> {
  if (!inflight) {
    inflight = fetchSessionOnce().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

// Visible for tests; resets the cache so each test gets a clean slate.
export function __resetConnectionStateForTests(value: string | null = null): void {
  cachedAddress = value;
  inflight = null;
}

function initPolling(): void {
  if (initialized) return;
  if (typeof window === 'undefined') return;
  initialized = true;
  void refreshConnection();
  window.addEventListener('focus', () => {
    void refreshConnection();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshConnection();
  });
  setInterval(() => {
    void refreshConnection();
  }, 10_000);
}

initPolling();
