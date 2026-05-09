import { migration001Initial } from './001_initial.js';
import { migration002NonceWithoutVerifiedUser } from './002_nonce_without_verified_user.js';
import { migration003ActiveApprovalUniquePlan } from './003_active_approval_unique_plan.js';

export interface PostgresMigration {
  id: string;
  sql: string;
}

export const postgresMigrations: PostgresMigration[] = [
  migration001Initial,
  migration002NonceWithoutVerifiedUser,
  migration003ActiveApprovalUniquePlan,
];
