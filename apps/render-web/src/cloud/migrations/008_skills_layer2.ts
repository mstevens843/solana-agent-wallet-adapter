export const migration008SkillsLayer2 = {
  id: '008_skills_layer2',
  sql: `
    CREATE TABLE IF NOT EXISTS skill_manifests (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      author_wallet TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS skill_manifests_author_idx ON skill_manifests(author_wallet);
    CREATE INDEX IF NOT EXISTS skill_manifests_updated_at_idx ON skill_manifests(updated_at);

    CREATE TABLE IF NOT EXISTS skill_installs (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      status TEXT NOT NULL,
      installed_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS skill_installs_wallet_idx ON skill_installs(wallet_address);
    CREATE INDEX IF NOT EXISTS skill_installs_status_idx ON skill_installs(status);
    CREATE INDEX IF NOT EXISTS skill_installs_skill_id_idx ON skill_installs(skill_id);
    CREATE UNIQUE INDEX IF NOT EXISTS skill_installs_wallet_skill_active_idx
      ON skill_installs(wallet_address, skill_id)
      WHERE status <> 'revoked';

    CREATE TABLE IF NOT EXISTS skill_executions (
      id TEXT PRIMARY KEY,
      install_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      proposed_at TIMESTAMPTZ NOT NULL,
      result TEXT,
      approval_request_id TEXT,
      evidence_receipt_id TEXT,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS skill_executions_install_idx ON skill_executions(install_id);
    CREATE INDEX IF NOT EXISTS skill_executions_skill_id_idx ON skill_executions(skill_id);
    CREATE INDEX IF NOT EXISTS skill_executions_wallet_idx ON skill_executions(wallet_address);
    CREATE INDEX IF NOT EXISTS skill_executions_proposed_at_idx ON skill_executions(proposed_at);

    CREATE TABLE IF NOT EXISTS signal_feeds (
      id TEXT PRIMARY KEY,
      publisher_wallet TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS signal_feeds_publisher_idx ON signal_feeds(publisher_wallet);

    CREATE TABLE IF NOT EXISTS signal_subscriptions (
      id TEXT PRIMARY KEY,
      follower_wallet TEXT NOT NULL,
      feed_id TEXT NOT NULL,
      status TEXT NOT NULL,
      subscribed_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS signal_subscriptions_follower_idx ON signal_subscriptions(follower_wallet);
    CREATE INDEX IF NOT EXISTS signal_subscriptions_feed_idx ON signal_subscriptions(feed_id);
    CREATE UNIQUE INDEX IF NOT EXISTS signal_subscriptions_active_unique_idx
      ON signal_subscriptions(follower_wallet, feed_id)
      WHERE status <> 'revoked';

    CREATE TABLE IF NOT EXISTS signal_emissions (
      id TEXT PRIMARY KEY,
      feed_id TEXT NOT NULL,
      publisher_wallet TEXT NOT NULL,
      emitted_at TIMESTAMPTZ NOT NULL,
      source_txid TEXT NOT NULL,
      delivered INT NOT NULL DEFAULT 0,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS signal_emissions_feed_idx ON signal_emissions(feed_id);
    CREATE INDEX IF NOT EXISTS signal_emissions_emitted_at_idx ON signal_emissions(emitted_at);

    CREATE TABLE IF NOT EXISTS aggregator_snapshots (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS aggregator_snapshots_kind_idx ON aggregator_snapshots(kind);
    CREATE INDEX IF NOT EXISTS aggregator_snapshots_computed_at_idx ON aggregator_snapshots(computed_at);
  `,
};
