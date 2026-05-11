import { kaminoAdapter } from './kamino/index.js';
import type { DAppAdapter, DAppAdapterId } from './types.js';

const ADAPTERS: Record<DAppAdapterId, DAppAdapter> = {
  kamino: kaminoAdapter,
};

export function listAdapters(): DAppAdapter[] {
  return Object.values(ADAPTERS);
}

export function getAdapter(id: string): DAppAdapter | undefined {
  return (ADAPTERS as Record<string, DAppAdapter | undefined>)[id];
}

export function requireAdapter(id: string): DAppAdapter {
  const adapter = getAdapter(id);
  if (!adapter) {
    throw new Error(`Unknown dApp adapter: ${id}`);
  }
  return adapter;
}

export function adapterForActionKind(kind: string): DAppAdapter | undefined {
  for (const adapter of Object.values(ADAPTERS)) {
    for (const action of Object.values(adapter.actions)) {
      if (action.kind === kind) return adapter;
    }
  }
  return undefined;
}

export function actionForKind(kind: string): { adapter: DAppAdapter; action: { execute: DAppAdapter['actions'][string]['execute']; id: string } } | undefined {
  for (const adapter of Object.values(ADAPTERS)) {
    for (const action of Object.values(adapter.actions)) {
      if (action.kind === kind) {
        return { adapter, action: { execute: action.execute, id: action.id } };
      }
    }
  }
  return undefined;
}
