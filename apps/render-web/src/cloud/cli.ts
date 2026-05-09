import { pathToFileURL } from 'node:url';

import { PostgresWorkflowStore } from './postgresStore.js';
import { createRecurringApprovalSink, createRecurringApprovalStatusReader } from './recurringApprovalSink.js';
import { RecurringService } from './recurringService.js';
import { RecurringScheduler } from './scheduler.js';
import { WorkflowService } from './workflowService.js';

type Command = 'migrate' | 'materialize-due';

export async function runCloudCommand(command: Command): Promise<void> {
  const store = new PostgresWorkflowStore();
  try {
    await store.migrate();
    if (command === 'migrate') {
      console.log('Agentic Cloud database migrations complete.');
      return;
    }

    await store.cleanupExpired(new Date().toISOString());
    const workflowService = new WorkflowService(store);
    const service = new RecurringService(store, {
      approvalSink: createRecurringApprovalSink(workflowService),
      approvalStatusReader: createRecurringApprovalStatusReader(store),
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
  if (value === 'migrate' || value === 'materialize-due') return value;
  throw new Error('Usage: node dist/cloud/cli.js <migrate|materialize-due>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloudCommand(parseCommand(process.argv[2])).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
