export const migration011SignalsFanoutHardening = {
  id: '011_signals_fanout_hardening',
  sql: `
    ALTER TABLE signal_emissions
      ADD COLUMN IF NOT EXISTS fanout_processed_at TIMESTAMPTZ;

    UPDATE signal_emissions
    SET fanout_processed_at = emitted_at
    WHERE fanout_processed_at IS NULL
      AND delivered > 0;

    CREATE INDEX IF NOT EXISTS signal_emissions_unprocessed_idx
      ON signal_emissions(emitted_at)
      WHERE fanout_processed_at IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_active_signal_fanout_idx
      ON approval_requests (
        wallet_address,
        ((record->'metadata'->>'signalEmissionId')),
        ((record->'metadata'->>'signalSubscriptionId'))
      )
      WHERE record->'metadata'->>'signalEmissionId' IS NOT NULL
        AND record->'metadata'->>'signalSubscriptionId' IS NOT NULL
        AND status IN ('pending', 'scheduled', 'ready', 'overdue', 'approval_pending');
  `,
} as const;
