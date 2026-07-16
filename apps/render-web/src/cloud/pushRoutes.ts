import { randomUUID } from 'node:crypto';

import { isPushEventType, type PushCategoryMap, type PushDeviceRecord, type PushPlatform, type PushStore } from './pushTypes.js';

/**
 * Device registration for push.
 *
 *   POST /api/push/register-device    { platform, token, categories }
 *   POST /api/push/unregister-device  { platform, token }
 *   GET  /api/push/devices
 *
 * The wallet ALWAYS comes from the session, never the body. The session is already a
 * signature-proven binding to a wallet (SIWS → verify-wallet), so a device registered on an
 * authenticated request is provably the session owner's. Trusting a body-supplied wallet would let
 * anyone point our push at someone else's address — the same reason /api/helius/das ignores its body
 * address.
 *
 * This is why push is a signed-in feature while local alerts are not: there is no wallet↔device
 * binding without it.
 */

export interface PushRegisterResult {
  device: { id: string; platform: PushPlatform; categories: PushCategoryMap };
}

export function parsePlatform(value: unknown): PushPlatform | undefined {
  return value === 'ios' || value === 'android' ? value : undefined;
}

/** Only known event types survive, and only as real booleans — an unknown key is dropped, not stored. */
export function parseCategories(value: unknown): PushCategoryMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: PushCategoryMap = {};
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (isPushEventType(key) && typeof enabled === 'boolean') out[key] = enabled;
  }
  return out;
}

export function parseToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // APNs hex tokens are 64 chars; FCM tokens are long opaque strings. Bound it so a junk body can't
  // write megabytes into the table.
  if (trimmed.length < 8 || trimmed.length > 4096) return undefined;
  return trimmed;
}

export interface RegisterPushDeviceInput {
  store: PushStore;
  walletAddress: string;
  platform: PushPlatform;
  token: string;
  categories: PushCategoryMap;
  now: string;
  idFactory?: () => string;
}

export async function registerPushDevice(input: RegisterPushDeviceInput): Promise<PushDeviceRecord> {
  const existing = await input.store.findPushDeviceByToken(input.platform, input.token);
  const record: PushDeviceRecord = {
    // Reuse the existing row id when this token is already known: the same phone re-registering after
    // a reinstall or a wallet switch must UPDATE, and re-registering clears disabledAt so a token that
    // came back to life recovers on its own.
    id: existing?.id ?? `pushdev_${(input.idFactory ?? randomUUID)()}`,
    walletAddress: input.walletAddress,
    platform: input.platform,
    token: input.token,
    categories: input.categories,
    createdAt: existing?.createdAt ?? input.now,
    updatedAt: input.now,
    lastSeenAt: input.now,
  };
  await input.store.savePushDevice(record);
  return record;
}

export async function unregisterPushDevice(
  store: PushStore,
  walletAddress: string,
  platform: PushPlatform,
  token: string,
): Promise<boolean> {
  const existing = await store.findPushDeviceByToken(platform, token);
  // Scope the delete to the session's wallet: knowing a token must not let one account unregister
  // another's device.
  if (!existing || existing.walletAddress !== walletAddress) return false;
  await store.deletePushDevice(walletAddress, existing.id);
  return true;
}
