import { pathToFileURL } from 'node:url';

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
  | 'skills-execute'
  | 'aggregator-roll'
  | 'signals-fanout'
  | 'streaming-settle';

export async function runCloudCommand(command: Command, args: readonly string[] = []): Promise<void> {
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
    await store.migrate();
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

function parseCommand(value: string | undefined): Command {
  if (
    value === 'migrate' ||
    value === 'rollback' ||
    value === 'materialize-due' ||
    value === 'notifications-deliver' ||
    value === 'skills-execute' ||
    value === 'aggregator-roll' ||
    value === 'signals-fanout' ||
    value === 'streaming-settle'
  ) {
    return value;
  }
  throw new Error(
    'Usage: node dist/cloud/cli.js <migrate|rollback <id>|materialize-due|notifications-deliver|skills-execute|aggregator-roll|signals-fanout|streaming-settle>',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloudCommand(parseCommand(process.argv[2]), process.argv.slice(3)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
