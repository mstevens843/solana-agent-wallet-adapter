export const migration009SignalSubscriptionActiveUnique = {
  id: '009_signal_subscription_active_unique',
  sql: `
    ALTER TABLE signal_subscriptions
      DROP CONSTRAINT IF EXISTS signal_subscriptions_follower_wallet_feed_id_key;

    CREATE UNIQUE INDEX IF NOT EXISTS signal_subscriptions_active_unique_idx
      ON signal_subscriptions(follower_wallet, feed_id)
      WHERE status <> 'revoked';
  `,
} as const;
