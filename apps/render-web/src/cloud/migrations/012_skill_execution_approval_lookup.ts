export const migration012SkillExecutionApprovalLookup = {
  id: '012_skill_execution_approval_lookup',
  sql: `
    CREATE INDEX IF NOT EXISTS skill_executions_wallet_approval_idx
      ON skill_executions(wallet_address, approval_request_id)
      WHERE approval_request_id IS NOT NULL;
  `,
};
