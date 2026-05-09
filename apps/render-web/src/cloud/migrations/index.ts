import { migration001Initial } from './001_initial.js';
import { migration002NonceWithoutVerifiedUser } from './002_nonce_without_verified_user.js';
import { migration003ActiveApprovalUniquePlan } from './003_active_approval_unique_plan.js';
import { migration004TransactionFinalizations } from './004_transaction_finalizations.js';
import { migration005RecurringExpiresAt } from './005_recurring_expires_at.js';
import { migration006RecurringNotificationDeliveries } from './006_recurring_notification_deliveries.js';

export interface PostgresMigration {
  id: string;
  sql: string;
}

export const postgresMigrations: PostgresMigration[] = [
  migration001Initial,
  migration002NonceWithoutVerifiedUser,
  migration003ActiveApprovalUniquePlan,
  migration004TransactionFinalizations,
  migration005RecurringExpiresAt,
  migration006RecurringNotificationDeliveries,
];
