// Push notifications: the device registry + the delivery outbox.
//
// Why this is NOT a reuse of recurring_notification_deliveries (migration 006): that table's
// schedule_id/occurrence_id are NOT NULL FKs into recurring_schedules/recurring_occurrences, so it
// structurally cannot hold a "limit order filled" or "transaction confirmed" event. This is its
// sibling, keyed by an opaque dedupe_key instead of an occurrence.
//
// Prior-state watermarks (last-seen borrow health, webhook address drift) deliberately live in
// wallet_preferences under their own namespaces rather than here — migration 007 already accepts
// arbitrary TEXT namespaces, so they cost no schema (see the 015/019 precedent).
export const migration020PushNotifications = {
  id: '020_push_notifications',
  sql: `
    CREATE TABLE IF NOT EXISTS push_devices (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      token TEXT NOT NULL,
      -- Enabled categories for THIS device, so two phones on one wallet can differ.
      categories JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      -- Sessions expire every 7 days but a device must keep receiving push across that, so the row
      -- outlives the session and is re-attested on the next sign-in.
      last_seen_at TIMESTAMPTZ NOT NULL,
      -- Set when FCM/APNs reports the token dead (410 Gone / UNREGISTERED). Reaped, never retried.
      disabled_at TIMESTAMPTZ,
      disabled_reason TEXT
    );

    -- A device token is globally unique per platform: re-registering the same token (app reinstall,
    -- wallet switch) must UPDATE the row and re-point it at the new wallet, never fan out duplicates.
    CREATE UNIQUE INDEX IF NOT EXISTS push_devices_platform_token_idx
      ON push_devices(platform, token);

    -- The fan-out lookup: every live device for a wallet.
    CREATE INDEX IF NOT EXISTS push_devices_wallet_active_idx
      ON push_devices(wallet_address) WHERE disabled_at IS NULL;

    CREATE TABLE IF NOT EXISTS push_deliveries (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      type TEXT NOT NULL,
      -- Whatever makes this event unique for its type: an occurrence id, a tx signature, an order id,
      -- or a health-state transition. Opaque on purpose so new event types need no schema change.
      dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    -- Idempotency. Helius re-delivers webhooks on our non-2xx, and the health poll re-reads the same
    -- state every 5 minutes; both must collapse onto one row rather than buzzing the phone repeatedly.
    CREATE UNIQUE INDEX IF NOT EXISTS push_deliveries_dedupe_idx
      ON push_deliveries(wallet_address, type, dedupe_key);

    -- The drain scan: pending rows whose backoff has elapsed.
    CREATE INDEX IF NOT EXISTS push_deliveries_due_idx
      ON push_deliveries(status, next_attempt_at);
  `,
  down: `
    DROP INDEX IF EXISTS push_deliveries_due_idx;
    DROP INDEX IF EXISTS push_deliveries_dedupe_idx;
    DROP TABLE IF EXISTS push_deliveries CASCADE;
    DROP INDEX IF EXISTS push_devices_wallet_active_idx;
    DROP INDEX IF EXISTS push_devices_platform_token_idx;
    DROP TABLE IF EXISTS push_devices CASCADE;
    DELETE FROM wallet_preferences WHERE namespace IN ('push-state', 'push-webhook');
  `,
};
