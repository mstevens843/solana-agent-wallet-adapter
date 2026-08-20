import { pathToFileURL } from 'node:url';

import { bootstrapHostConnectorFactories } from '@solana-agent-wallet-adapter/mcp-server';

import { isRecurringNotificationStore, RecurringNotificationService } from './notificationService.js';
import { PostgresWorkflowStore } from './postgresStore.js';
import { createRecurringApprovalSink, createRecurringApprovalStatusReader } from './recurringApprovalSink.js';
import { createRecurringPolicyEnforcer, loadRecurringPolicyFromEnv } from './recurringPolicy.js';
import { RecurringService } from './recurringService.js';
import { RecurringScheduler } from './scheduler.js';
import { isSignalsStore, systemClock } from './store.js';
import { WorkflowService } from './workflowService.js';

type Command =
  | 'migrate'
  | 'rollback'
  | 'materialize-due'
  | 'notifications-deliver'
  | 'push-deliver'
  | 'push-health'
  | 'push-webhook-sync'
  | 'skills-execute'
  | 'aggregator-roll'
  | 'signals-fanout'
  | 'streaming-settle';

const DATABASE_STARTUP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

export async function runCloudCommand(command: Command, args: readonly string[] = []): Promise<void> {
  // Wire the connector SDK client factories once per process, exactly as the web server does in its
  // ensureConnectorSdksConfigured(). Without this a cron that reads a keyless lender (Kamino/Save/
  // MarginFi) — e.g. push:health reading borrow positions — gets "adapter is not configured" for
  // every wallet, because those factories are otherwise only set inside the HTTP router's boot path.
  bootstrapHostConnectorFactories({
    rpcUrl: (process.env.SOLANA_RPC_URL ?? process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com').trim(),
  });
  const store = new PostgresWorkflowStore();
  try {
    // Rollback runs against the existing schema; we must NOT call migrate()
    // first because that would re-apply the migration we're trying to undo.
    if (command === 'rollback') {
      const targetId = args[0]?.trim();
      if (!targetId) {
        throw new Error('Usage: node dist/cloud/cli.js rollback <migration-id>');
      }
      const result = await store.rollbackOne(targetId);
      console.log(
        `Agentic Cloud rollback complete. id=${result.rolledBack} downApplied=${result.downApplied}`,
      );
      return;
    }
    await withDatabaseStartupRetry('migration', () => store.migrate());
    if (command === 'migrate') {
      console.log('Agentic Cloud database migrations complete.');
      return;
    }
    if (command === 'notifications-deliver') {
      if (!isRecurringNotificationStore(store)) {
        throw new Error('Configured store does not support recurring notification deliveries.');
      }
      const service = new RecurringNotificationService(store);
      const result = await service.deliverDue();
      console.log(
        `Agentic recurring notifications delivered=${result.delivered} failed=${result.failed} abandoned=${result.abandoned}`,
      );
      return;
    }
    if (command === 'push-deliver') {
      const { PushNotificationService } = await import('./pushNotificationService.js');
      const { isPushStore } = await import('./pushTypes.js');
      if (!isPushStore(store)) throw new Error('Configured store does not support push deliveries.');
      const result = await new PushNotificationService(store).deliverDue();
      // `skipped` is the interesting one in ops: a non-zero skipped with zero delivered means the
      // FCM/APNs credentials aren't provisioned yet — the queue is intact and waiting, not broken.
      console.log(
        `Agentic push deliver delivered=${result.delivered} failed=${result.failed} abandoned=${result.abandoned} skipped=${result.skipped}`,
      );
      return;
    }
    if (command === 'push-health') {
      const { PushNotificationService } = await import('./pushNotificationService.js');
      const { isPushStore } = await import('./pushTypes.js');
      const { runPushHealthTick } = await import('./pushHealthJob.js');
      if (!isPushStore(store)) throw new Error('Configured store does not support push deliveries.');
      const result = await runPushHealthTick({
        store,
        pushService: new PushNotificationService(store),
        onError: (walletAddress, err) => {
          console.warn(
            `push_health_read_failed walletAddress=${walletAddress} err=${err instanceof Error ? err.message : String(err)}`,
          );
        },
      });
      console.log(
        `Agentic push health wallets=${result.wallets} enqueued=${result.enqueued} errors=${result.errors}`,
      );
      return;
    }
    if (command === 'push-webhook-sync') {
      const { isPushStore } = await import('./pushTypes.js');
      const { heliusPushWebhookConfig, syncHeliusPushWebhook } = await import('./heliusWebhooks.js');
      if (!isPushStore(store)) throw new Error('Configured store does not support push deliveries.');
      const config = heliusPushWebhookConfig();
      if (!config) {
        console.log('Agentic push webhook sync skipped: HELIUS_API_KEY/HELIUS_WEBHOOK_SECRET/PUBLIC_WEB_ORIGIN not all set.');
        return;
      }
      // Reconciles Helius's address list against our DB, so drift self-heals (a webhook deleted in the
      // dashboard, a half-failed create, an address left behind by a failed unregister).
      const result = await syncHeliusPushWebhook(await store.listPushWallets(), config);
      console.log(
        `Agentic push webhook sync action=${result.action} addresses=${result.addressCount}${result.webhookId ? ` webhookId=${result.webhookId}` : ''}`,
      );
      return;
    }
    if (command === 'skills-execute') {
      const { runSkillsExecuteTick } = await import('./skillExecutorService.js');
      const result = await runSkillsExecuteTick({ store, clock: systemClock });
      console.log(
        `Agentic skills execute evaluated=${result.evaluated} proposed=${result.proposed} skipped=${result.skipped}`,
      );
      return;
    }
    if (command === 'aggregator-roll') {
      const { runAggregatorRoll } = await import('./aggregatorJob.js');
      const result = await runAggregatorRoll({ store, clock: systemClock });
      console.log(
        `Agentic aggregator roll skill_snapshots=${result.skillSnapshots} wallet_snapshots=${result.walletSnapshots}`,
      );
      return;
    }
    if (command === 'signals-fanout') {
      if (!isSignalsStore(store)) {
        throw new Error('Configured store does not support Layer 2 Signals (copy-trading).');
      }
      const { runSignalsFanoutTick } = await import('./signalsFanoutService.js');
      const result = await runSignalsFanoutTick({ store, clock: systemClock });
      console.log(
        `Agentic signals fanout emissions=${result.emissionsProcessed} followers=${result.followersFannedOut} skipped=${result.skipped} errors=${result.errors}`,
      );
      return;
    }
    if (command === 'streaming-settle') {
      const { materializeStreamingSettlements } = await import('./settlementService.js');
      const result = await materializeStreamingSettlements({ store, clock: systemClock });
      console.log(
        `Agentic streaming settlement settled=${result.settled} failed=${result.failed} skipped=${result.skipped}`,
      );
      return;
    }

    await store.cleanupExpired(new Date().toISOString());
    const workflowService = new WorkflowService(store);
    const service = new RecurringService(store, {
      approvalSink: createRecurringApprovalSink(workflowService),
      approvalStatusReader: createRecurringApprovalStatusReader(store),
      policyEnforcer: createRecurringPolicyEnforcer(loadRecurringPolicyFromEnv()),
    });
    const scheduler = new RecurringScheduler({
      service,
      store,
      enabled: false,
      onTick: (result) => {
        const created = result.walletResults.reduce((count, wallet) => {
          return count + wallet.results.filter((entry) => entry.reason === 'created').length;
        }, 0);
        console.log(`Agentic recurring materialization complete. wallets=${result.walletResults.length} created=${created}`);
      },
    });
    await scheduler.tick();
  } finally {
    await store.close();
  }
}

async function withDatabaseStartupRetry<T>(
  operationName: string,
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      const delayMs = DATABASE_STARTUP_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isTransientDatabaseStartupError(err)) {
        throw err;
      }
      console.warn(
        `Agentic Cloud ${operationName} database unavailable (${databaseStartupErrorLabel(err)}); ` +
        `retrying in ${Math.round(delayMs / 1000)}s ` +
        `(attempt ${attempt + 2}/${DATABASE_STARTUP_RETRY_DELAYS_MS.length + 1})`,
      );
      await sleep(delayMs);
    }
  }
}

function isTransientDatabaseStartupError(err: unknown): boolean {
  const code = databaseErrorCode(err);
  if (/^(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|ECONNRESET|57P01|57P02|57P03|08000|08001|08003|08004|08006|53300|53400)$/.test(code)) {
    return true;
  }
  const message = databaseErrorMessage(err).toLowerCase();
  return message.includes('database system is starting up') ||
    message.includes('database system is shutting down') ||
    message.includes('terminating connection due to administrator command') ||
    message.includes('connection terminated unexpectedly');
}

function databaseStartupErrorLabel(err: unknown): string {
  return databaseErrorCode(err) || 'transient_error';
}

function databaseErrorCode(err: unknown): string {
  const error = err as { code?: unknown; cause?: unknown } | undefined;
  const cause = error?.cause as { code?: unknown } | undefined;
  return String(error?.code ?? cause?.code ?? '');
}

function databaseErrorMessage(err: unknown): string {
  const error = err as { message?: unknown; cause?: unknown } | undefined;
  const cause = error?.cause as { message?: unknown } | undefined;
  return String(error?.message ?? cause?.message ?? '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCommand(value: string | undefined): Command {
  if (
    value === 'migrate' ||
    value === 'rollback' ||
    value === 'materialize-due' ||
    value === 'notifications-deliver' ||
    value === 'push-deliver' ||
    value === 'push-health' ||
    value === 'push-webhook-sync' ||
    value === 'skills-execute' ||
    value === 'aggregator-roll' ||
    value === 'signals-fanout' ||
    value === 'streaming-settle'
  ) {
    return value;
  }
  throw new Error(
    'Usage: node dist/cloud/cli.js <migrate|rollback <id>|materialize-due|notifications-deliver|push-deliver|push-health|push-webhook-sync|skills-execute|aggregator-roll|signals-fanout|streaming-settle>',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloudCommand(parseCommand(process.argv[2]), process.argv.slice(3)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
