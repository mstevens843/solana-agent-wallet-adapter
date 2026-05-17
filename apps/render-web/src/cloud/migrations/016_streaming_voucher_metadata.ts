export const migration016StreamingVoucherMetadata = {
  id: '016_streaming_voucher_metadata',
  sql: `
    ALTER TABLE streaming_vouchers
      ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
  `,
  down: `
    ALTER TABLE streaming_vouchers
      DROP COLUMN IF EXISTS metadata;
  `,
};
