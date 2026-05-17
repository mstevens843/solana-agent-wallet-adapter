export const migration017MppSessionPaymentUniqueness = {
  id: '017_mpp_session_payment_uniqueness',
  sql: `
    CREATE UNIQUE INDEX IF NOT EXISTS streaming_vouchers_mpp_approval_uidx
      ON streaming_vouchers ((metadata #>> '{mppSessionPayment,approvalId}'))
      WHERE metadata #>> '{mppSessionPayment,approvalId}' IS NOT NULL
        AND metadata->>'source' = 'mpp_session_payment';
  `,
  down: `
    DROP INDEX IF EXISTS streaming_vouchers_mpp_approval_uidx;
  `,
};
