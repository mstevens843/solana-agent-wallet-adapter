import { pathToFileURL } from 'node:url';

import { isRecurringNotificationStore, RecurringNotificationService } from './notificationService.js';
import { PostgresWorkflowStore } from './postgresStore.js';
import { createRecurringApprovalSink, createRecurringApprovalStatusReader } from './recurringApprovalSink.js';
import { createRecurringPolicyEnforcer, loadRecurringPolicyFromEnv } from './recurringPolicy.js';
import { RecurringService } from './recurringService.js';
import { RecurringScheduler } from './scheduler.js';
import { WorkflowService } from './workflowService.js';

type Command = 'migrate' | 'materialize-due' | 'notifications-deliver';

export async function runCloudCommand(command: Command): Promise<void> {
  const store = new PostgresWorkflowStore();
  try {
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
  if (value === 'migrate' || value === 'materialize-due' || value === 'notifications-deliver') return value;
  throw new Error('Usage: node dist/cloud/cli.js <migrate|materialize-due|notifications-deliver>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloudCommand(parseCommand(process.argv[2])).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
