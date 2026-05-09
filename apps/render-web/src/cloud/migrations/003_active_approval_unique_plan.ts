export const migration003ActiveApprovalUniquePlan = {
  id: '003_active_approval_unique_plan',
  sql: `
    WITH ranked_plan_approvals AS (
      SELECT
        id,
        row_number() OVER (
          PARTITION BY wallet_address, COALESCE(record->>'planDraftId', record->>'planId')
          ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS active_rank
      FROM approval_requests
      WHERE COALESCE(record->>'planDraftId', record->>'planId') IS NOT NULL
        AND status IN ('pending', 'scheduled', 'ready', 'overdue', 'approval_pending')
    )
    UPDATE approval_requests AS approval
    SET
      status = 'cancelled',
      updated_at = now(),
      record = jsonb_set(
        jsonb_set(approval.record, '{status}', to_jsonb('cancelled'::text), true),
        '{metadata}',
        COALESCE(approval.record->'metadata', '{}'::jsonb) || jsonb_build_object(
          'dedupedByMigration', '003_active_approval_unique_plan',
          'dedupedAt', now()::text,
          'dedupeReason', 'duplicate_active_plan_approval'
        ),
        true
      )
    FROM ranked_plan_approvals AS ranked
    WHERE approval.id = ranked.id
      AND ranked.active_rank > 1;

    CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_active_plan_draft_idx
    ON approval_requests (
      wallet_address,
      ((COALESCE(record->>'planDraftId', record->>'planId')))
    )
    WHERE COALESCE(record->>'planDraftId', record->>'planId') IS NOT NULL
      AND status IN ('pending', 'scheduled', 'ready', 'overdue', 'approval_pending');

    WITH ranked_recurring_approvals AS (
      SELECT
        id,
        row_number() OVER (
          PARTITION BY wallet_address, record->>'recurringOccurrenceId'
          ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS active_rank
      FROM approval_requests
      WHERE record->>'recurringOccurrenceId' IS NOT NULL
        AND status IN ('pending', 'scheduled', 'ready', 'overdue', 'approval_pending')
    )
    UPDATE approval_requests AS approval
    SET
      status = 'cancelled',
      updated_at = now(),
      record = jsonb_set(
        jsonb_set(approval.record, '{status}', to_jsonb('cancelled'::text), true),
        '{metadata}',
        COALESCE(approval.record->'metadata', '{}'::jsonb) || jsonb_build_object(
          'dedupedByMigration', '003_active_approval_unique_plan',
          'dedupedAt', now()::text,
          'dedupeReason', 'duplicate_active_recurring_occurrence_approval'
        ),
        true
      )
    FROM ranked_recurring_approvals AS ranked
    WHERE approval.id = ranked.id
      AND ranked.active_rank > 1;

    CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_active_recurring_occurrence_idx
    ON approval_requests (
      wallet_address,
      ((record->>'recurringOccurrenceId'))
    )
    WHERE record->>'recurringOccurrenceId' IS NOT NULL
      AND status IN ('pending', 'scheduled', 'ready', 'overdue', 'approval_pending')
  `,
} as const;
