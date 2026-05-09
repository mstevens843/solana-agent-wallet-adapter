export const migration002NonceWithoutVerifiedUser = {
  id: '002_nonce_without_verified_user',
  sql: `
    DO $$
    DECLARE
      nonce_wallet_fk TEXT;
    BEGIN
      SELECT con.conname INTO nonce_wallet_fk
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
      WHERE nsp.nspname = current_schema()
        AND rel.relname = 'nonces'
        AND con.contype = 'f'
        AND att.attname = 'wallet_address'
      LIMIT 1;

      IF nonce_wallet_fk IS NOT NULL THEN
        EXECUTE format('ALTER TABLE nonces DROP CONSTRAINT %I', nonce_wallet_fk);
      END IF;
    END $$;
  `,
} as const;
