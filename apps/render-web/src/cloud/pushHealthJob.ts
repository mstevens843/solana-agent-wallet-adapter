import { createStatelessConnectorFactsReader, type StatelessConnectorFactsReader } from './connectorFactsReader.js';
import type { CloudPreferencesStore } from './store.js';
import type { PushNotificationService } from './pushNotificationService.js';
import type { PushStore } from './pushTypes.js';

/**
 * Borrow-health poll.
 *
 * This is the ONE event that genuinely needs polling: "your loan needs repayment" is caused by a PRICE
 * move, not by a transaction on your wallet, so no Helius webhook will ever fire for it. Everything
 * else (limit fills, DCA fills, tx confirms) arrives via the webhook and is not re-read here.
 *
 * Reads go through the keyless public reader — Jupiter borrow positions need no per-wallet key (unlike
 * Trigger, which needs a signed JWT and is therefore unpollable server-side).
 *
 * Wallets come from push_devices, NOT users: polling every account that ever signed in would burn the
 * Jupiter quota on people who never asked for a notification.
 */
export const PUSH_HEALTH_NAMESPACE = 'push-state';

/** Jupiter's own liquidation buckets, ordered by severity. Only an UPWARD move notifies. */
const SEVERITY: Record<string, number> = { safe: 0, unknown: 0, at_risk: 1, liquidatable: 2, liquidated: 3 };

export interface PushHealthState {
  /** Last notified bucket per connector, so a position sitting at_risk doesn't re-buzz every 5 min. */
  lastStatus?: Record<string, string>;
}

export interface RunPushHealthTickOptions {
  store: PushStore & CloudPreferencesStore;
  pushService: PushNotificationService;
  reader?: StatelessConnectorFactsReader;
  cluster?: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
  walletLimit?: number;
  onError?: (walletAddress: string, err: unknown) => void;
}

export interface PushHealthTickResult {
  wallets: number;
  enqueued: number;
  errors: number;
}

export async function runPushHealthTick(options: RunPushHealthTickOptions): Promise<PushHealthTickResult> {
  const reader = options.reader ?? createStatelessConnectorFactsReader();
  const cluster = options.cluster ?? 'mainnet-beta';
  const wallets = (await options.store.listPushWallets()).slice(0, options.walletLimit ?? 500);
  const result: PushHealthTickResult = { wallets: wallets.length, enqueued: 0, errors: 0 };

  for (const walletAddress of wallets) {
    try {
      const facts = await reader({ connectorId: 'jupiter', capability: 'positions', cluster, walletAddress });
      const positions = readPositions(facts);
      if (!positions.length) continue;
      const state = await loadState(options.store, walletAddress);
      const nextStatus: Record<string, string> = { ...(state.lastStatus ?? {}) };
      let changed = false;

      for (const position of positions) {
        const key = String(position.key);
        const status = String(position.status);
        const previous = nextStatus[key] ?? 'safe';
        if (!shouldNotify(previous, status)) {
          // Still record the current bucket so RECOVERY re-arms the alert: a position that goes
          // at_risk → safe → at_risk must notify the second time too.
          if (nextStatus[key] !== status) { nextStatus[key] = status; changed = true; }
          continue;
        }
        const record = await options.pushService.enqueue({
          walletAddress,
          type: 'lend.borrow.at_risk',
          // The transition, not the wallet: crossing safe→at_risk→liquidatable must be able to notify
          // twice, but re-reading the same bucket must not.
          dedupeKey: `${key}:${status}`,
          title: status === 'liquidatable' ? 'Borrow position liquidatable' : 'Borrow position at risk',
          body: healthBody(position),
          data: { tab: 'positions', section: 'borrowing' },
        });
        if (record) result.enqueued += 1;
        nextStatus[key] = status;
        changed = true;
      }
      if (changed) await saveState(options.store, walletAddress, { lastStatus: nextStatus }, new Date().toISOString());
    } catch (err) {
      // One wallet's read failing (rate limit, unknown position shape) must not stop the batch.
      result.errors += 1;
      options.onError?.(walletAddress, err);
    }
  }
  return result;
}

/** Only an increase in severity is news. safe→at_risk yes; at_risk→at_risk no; at_risk→safe no. */
export function shouldNotify(previous: string, next: string): boolean {
  return (SEVERITY[next] ?? 0) > (SEVERITY[previous] ?? 0);
}

interface HealthPosition {
  key: string;
  status: string;
  healthRatio?: number;
}

export function readPositions(facts: unknown): HealthPosition[] {
  const source = (facts as { positions?: unknown })?.positions
    ?? ((facts as { result?: { positions?: unknown } })?.result?.positions);
  if (!Array.isArray(source)) return [];
  const out: HealthPosition[] = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const status = typeof record.liquidationStatus === 'string' ? record.liquidationStatus : undefined;
    if (!status) continue;
    const key = String(record.positionId ?? record.address ?? record.vaultId ?? 'jupiter-borrow');
    const healthRatio = typeof record.healthRatio === 'number' ? record.healthRatio : undefined;
    out.push({ key, status, ...(healthRatio !== undefined ? { healthRatio } : {}) });
  }
  return out;
}

function healthBody(position: HealthPosition): string {
  if (typeof position.healthRatio === 'number') {
    return `Health ${position.healthRatio.toFixed(2)} — repay to avoid liquidation.`;
  }
  return 'Repay or add collateral to avoid liquidation.';
}

async function loadState(store: CloudPreferencesStore, walletAddress: string): Promise<PushHealthState> {
  const record = await store.getPreference(walletAddress, PUSH_HEALTH_NAMESPACE);
  const payload = record?.payload;
  return payload && typeof payload === 'object' ? (payload as PushHealthState) : {};
}

async function saveState(
  store: CloudPreferencesStore,
  walletAddress: string,
  state: PushHealthState,
  now: string,
): Promise<void> {
  await store.savePreference(walletAddress, {
    namespace: PUSH_HEALTH_NAMESPACE,
    payload: state,
    updatedAt: now,
    version: 1,
  });
}
