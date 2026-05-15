import type { IncomingMessage, ServerResponse } from 'node:http';

import type { EvidenceStore } from './evidenceService.js';
import type { Clock, WorkflowStore as SessionWorkflowStore } from './store.js';
import type { WorkflowService, WorkflowStore as OneTimeWorkflowStore } from './workflowService.js';

export interface DevApiHandler {
  prefix: string;
  methods: readonly string[];
  publicRoute?: boolean;
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    context: DevApiHandlerContext,
  ) => Promise<boolean>;
}

export interface DevApiHandlerContext {
  walletAddress: string | undefined;
  workflowService: WorkflowService;
  workflowStore: SessionWorkflowStore & OneTimeWorkflowStore;
  evidenceStore: EvidenceStore;
  clock: Clock;
}

const handlers: DevApiHandler[] = [];

export function registerDevApiHandler(handler: DevApiHandler): void {
  if (handlers.some((existing) => existing.prefix === handler.prefix)) return;
  handlers.push(handler);
}

export function listDevApiHandlers(): readonly DevApiHandler[] {
  return handlers;
}

export function clearDevApiHandlersForTesting(): void {
  handlers.length = 0;
}
