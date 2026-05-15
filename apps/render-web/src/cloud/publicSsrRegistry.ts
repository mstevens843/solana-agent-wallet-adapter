import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Clock, WorkflowStore } from './store.js';

export interface PublicSsrContext {
  store: WorkflowStore;
  clock: Clock;
}

export interface PublicSsrHandler {
  pattern: RegExp;
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    match: RegExpMatchArray,
    ctx: PublicSsrContext,
  ) => Promise<boolean>;
}

const handlers: PublicSsrHandler[] = [];

export function registerPublicSsrHandler(handler: PublicSsrHandler): void {
  if (handlers.some((existing) => existing.pattern.source === handler.pattern.source)) return;
  handlers.push(handler);
}

export function listPublicSsrHandlers(): readonly PublicSsrHandler[] {
  return handlers;
}

export function clearPublicSsrHandlersForTesting(): void {
  handlers.length = 0;
}
