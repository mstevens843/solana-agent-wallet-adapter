export const migration010SkillInstallsReinstallIndex = {
  id: '010_skill_installs_reinstall_index',
  sql: `
    ALTER TABLE skill_installs
      DROP CONSTRAINT IF EXISTS skill_installs_wallet_address_skill_id_key;

    CREATE UNIQUE INDEX IF NOT EXISTS skill_installs_wallet_skill_active_idx
      ON skill_installs(wallet_address, skill_id)
      WHERE status <> 'revoked';
  `,
} as const;
