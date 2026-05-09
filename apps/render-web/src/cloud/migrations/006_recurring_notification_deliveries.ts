export const migration006RecurringNotificationDeliveries = {
  id: '006_recurring_notification_deliveries',
  sql: `
    CREATE TABLE IF NOT EXISTS recurring_notification_deliveries (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      type TEXT NOT NULL,
      schedule_id TEXT NOT NULL REFERENCES recurring_schedules(id) ON DELETE CASCADE,
      occurrence_id TEXT NOT NULL REFERENCES recurring_occurrences(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS recurring_notification_deliveries_occurrence_type_idx
      ON recurring_notification_deliveries(occurrence_id, type);

    CREATE INDEX IF NOT EXISTS recurring_notification_deliveries_due_idx
      ON recurring_notification_deliveries(status, next_attempt_at);

    CREATE INDEX IF NOT EXISTS recurring_notification_deliveries_wallet_idx
      ON recurring_notification_deliveries(wallet_address);
  `,
} as const;
