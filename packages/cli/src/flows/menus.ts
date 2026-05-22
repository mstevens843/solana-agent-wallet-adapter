// Tiny umbrella pickers for /inbox and /done. The actual rendering lives in
// the existing index.ts helpers (printInbox, printReceipts, runScheduleCommand);
// these just route through a friendly menu.

import { select } from '../tui/index.js';
import type { DoneFilter } from './done.js';

export type InboxChoice = 'new' | 'repeat';

export async function pickInbox(): Promise<InboxChoice> {
  return select<InboxChoice>({
    message: 'Which inbox?',
    choices: [
      { name: 'Needs approval (one-time)',  value: 'new',    description: 'Prepared actions awaiting wallet signature' },
      { name: 'Active repeats (schedules)', value: 'repeat', description: 'Recurring payments and DCA orders' },
    ],
  });
}

export async function pickDoneFilter(): Promise<DoneFilter> {
  return select<DoneFilter>({
    message: 'Show which done items?',
    choices: [
      { name: 'All',       value: 'all' },
      { name: 'One-time',  value: 'one-time',  description: 'Approved one-off transactions' },
      { name: 'Repeats',   value: 'repeats',   description: 'Occurrences from recurring schedules' },
      { name: 'Proofs',    value: 'proofs',    description: 'Wallet-signed evidence records' },
      { name: 'Receipts',  value: 'receipts',  description: 'On-chain transactions with explorer links' },
    ],
  });
}
