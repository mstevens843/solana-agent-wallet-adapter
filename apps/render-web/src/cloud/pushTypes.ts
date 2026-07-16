import type { JsonObject } from '@solana-agent-wallet-adapter/workflow';

/**
 * Wallet events worth buzzing a phone for.
 *
 * Split by how the server LEARNS about them, because that dictates whether they can reach a closed
 * app at all:
 *  - `recurring.*` — our own DB clock. The scheduler already materializes these (notificationSink).
 *  - `jupiter.*` / `tx.*` — on-chain. A Helius webhook on the wallet delivers the tx as it lands.
 *    Jupiter's own API is NOT an option for limit orders: listOrders requires a per-wallet JWT minted
 *    from a live wallet signature and held in process memory, which a cron can never have.
 *  - `lend.borrow.at_risk` — a PRICE move, not a transaction. No webhook will ever fire for it, so it
 *    is the one event that genuinely needs a poll.
 */
export type PushEventType =
  | 'recurring.occurrence.ready'
  | 'recurring.occurrence.overdue'
  | 'jupiter.trigger.filled'
  | 'jupiter.recurring.filled'
  | 'tx.confirmed'
  | 'tx.failed'
  | 'lend.borrow.at_risk';

export const PUSH_EVENT_TYPES: readonly PushEventType[] = [
  'recurring.occurrence.ready',
  'recurring.occurrence.overdue',
  'jupiter.trigger.filled',
  'jupiter.recurring.filled',
  'tx.confirmed',
  'tx.failed',
  'lend.borrow.at_risk',
];

export function isPushEventType(value: unknown): value is PushEventType {
  return typeof value === 'string' && (PUSH_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The per-device opt-in map. Keys are PushEventType; a missing key means OFF — a device must never
 * receive a category it did not ask for, so the default is silence.
 */
export type PushCategoryMap = Partial<Record<PushEventType, boolean>>;

export type PushPlatform = 'ios' | 'android';

export interface PushDeviceRecord {
  id: string;
  walletAddress: string;
  platform: PushPlatform;
  /** APNs device token (hex) or FCM registration token. */
  token: string;
  categories: PushCategoryMap;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  /** Set when FCM/APNs reports the token permanently dead. Never delivered to again. */
  disabledAt?: string;
  disabledReason?: string;
}

export type PushDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'abandoned';

export interface PushDeliveryRecord {
  id: string;
  walletAddress: string;
  type: PushEventType;
  /**
   * What makes this event unique for its type — an occurrence id, a tx signature, an order id, a
   * health transition. Opaque so a new event type needs no schema change, and UNIQUE per
   * (wallet, type, dedupeKey) so a Helius re-delivery or a repeated health read collapses onto one
   * row instead of buzzing the phone again.
   */
  dedupeKey: string;
  /** Rendered once at enqueue: the server owns the wording, so old binaries render new events fine. */
  title: string;
  body: string;
  /** Routing hint for the tap handler, e.g. { tab: 'positions', section: 'orders' }. */
  data: JsonObject;
  status: PushDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PushStore {
  savePushDevice(record: PushDeviceRecord): Promise<void>;
  findPushDeviceByToken(platform: PushPlatform, token: string): Promise<PushDeviceRecord | undefined>;
  listPushDevices(walletAddress: string): Promise<PushDeviceRecord[]>;
  /** Every wallet with at least one live device — the fan-out and poll enumeration set. */
  listPushWallets(): Promise<string[]>;
  disablePushDevice(id: string, reason: string, disabledAt: string): Promise<void>;
  deletePushDevice(walletAddress: string, id: string): Promise<void>;
  savePushDelivery(record: PushDeliveryRecord): Promise<void>;
  findPushDelivery(
    walletAddress: string,
    type: PushEventType,
    dedupeKey: string,
  ): Promise<PushDeliveryRecord | undefined>;
  listDuePushDeliveries(nowIso: string, limit: number): Promise<PushDeliveryRecord[]>;
}

export function isPushStore(value: unknown): value is PushStore {
  const candidate = value as Partial<PushStore> | undefined;
  return Boolean(
    candidate &&
    typeof candidate.savePushDevice === 'function' &&
    typeof candidate.listPushDevices === 'function' &&
    typeof candidate.savePushDelivery === 'function' &&
    typeof candidate.listDuePushDeliveries === 'function',
  );
}
