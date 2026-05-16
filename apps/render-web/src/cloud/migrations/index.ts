import { migration001Initial } from './001_initial.js';
import { migration002NonceWithoutVerifiedUser } from './002_nonce_without_verified_user.js';
import { migration003ActiveApprovalUniquePlan } from './003_active_approval_unique_plan.js';
import { migration004TransactionFinalizations } from './004_transaction_finalizations.js';
import { migration005RecurringExpiresAt } from './005_recurring_expires_at.js';
import { migration006RecurringNotificationDeliveries } from './006_recurring_notification_deliveries.js';
import { migration007WalletPreferences } from './007_wallet_preferences.js';
import { migration008SkillsLayer2 } from './008_skills_layer2.js';
import { migration009SignalSubscriptionActiveUnique } from './009_signal_subscription_active_unique.js';
import { migration010SkillInstallsReinstallIndex } from './010_skill_installs_reinstall_index.js';
import { migration011SignalsFanoutHardening } from './011_signals_fanout_hardening.js';
import { migration012SkillExecutionApprovalLookup } from './012_skill_execution_approval_lookup.js';
import { migration013StreamingSessions } from './013_streaming_sessions.js';
import { migration014StreamingVouchers } from './014_streaming_vouchers.js';
import { migration015MppWalletPreferencesNamespace } from './015_mpp_wallet_preferences_namespace.js';

export interface PostgresMigration {
  id: string;
  sql: string;
  /**
   * Optional rollback SQL that reverses {@link sql}. Phase 5.10: pure ratchet
   * migrations may omit this, but every new migration that mutates schema
   * SHOULD provide a `down` so operators can run
   * `pnpm -F render-web db:rollback <id>` to recover from a bad apply.
   *
   * Idempotent rollbacks (e.g. `DROP TABLE IF EXISTS …`) are preferred so
   * partial-apply states can be cleaned up safely.
   */
  down?: string;
}

export const postgresMigrations: PostgresMigration[] = [
  migration001Initial,
  migration002NonceWithoutVerifiedUser,
  migration003ActiveApprovalUniquePlan,
  migration004TransactionFinalizations,
  migration005RecurringExpiresAt,
  migration006RecurringNotificationDeliveries,
  migration007WalletPreferences,
  migration008SkillsLayer2,
  migration009SignalSubscriptionActiveUnique,
  migration010SkillInstallsReinstallIndex,
  migration011SignalsFanoutHardening,
  migration012SkillExecutionApprovalLookup,
  migration013StreamingSessions,
  migration014StreamingVouchers,
  migration015MppWalletPreferencesNamespace,
];
