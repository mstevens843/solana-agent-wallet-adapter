export const migration005RecurringExpiresAt = {
  id: '005_recurring_expires_at',
  sql: `
    ALTER TABLE recurring_schedules
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;

    UPDATE recurring_schedules
      SET expires_at = (record->>'expiresAt')::TIMESTAMPTZ
      WHERE expires_at IS NULL
        AND record ? 'expiresAt'
        AND record->>'expiresAt' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?Z$';

    CREATE INDEX IF NOT EXISTS recurring_schedules_expires_at_idx
      ON recurring_schedules(expires_at) WHERE expires_at IS NOT NULL;
  `,
} as const;
