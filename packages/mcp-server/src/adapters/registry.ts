import type { PreparedActionKind } from '../preparedActions.js';
import { driftAdapter } from './drift/index.js';
import { jitoAdapter } from './jito/index.js';
import { jupiterAdapter } from './jupiter/index.js';
import { kaminoAdapter } from './kamino/index.js';
import { luloAdapter } from './lulo/index.js';
import { magicedenAdapter } from './magiceden/index.js';
import { marinadeAdapter } from './marinade/index.js';
import { marginfiAdapter } from './marginfi/index.js';
import { meteoraAdapter } from './meteora/index.js';
import { orcaAdapter } from './orca/index.js';
import { project0Adapter } from './project0/index.js';
import { pythAdapter } from './pyth/index.js';
import { raydiumAdapter } from './raydium/index.js';
import { realmsAdapter } from './realms/index.js';
import { saveAdapter } from './save/index.js';
import { sanctumAdapter } from './sanctum/index.js';
import { squadsAdapter } from './squads/index.js';
import { phoenixAdapter } from './phoenix/index.js';
import { tensorAdapter } from './tensor/index.js';
import { wormholeAdapter } from './wormhole/index.js';
import type { AdapterAction, DAppAdapter, DAppAdapterId } from './types.js';

const ADAPTERS: Partial<Record<DAppAdapterId, DAppAdapter>> = {
  jupiter: jupiterAdapter,
  kamino: kaminoAdapter,
  meteora: meteoraAdapter,
  orca: orcaAdapter,
  raydium: raydiumAdapter,
  marginfi: marginfiAdapter,
  project0: project0Adapter,
  drift: driftAdapter,
  save: saveAdapter,
  jito: jitoAdapter,
  marinade: marinadeAdapter,
  lulo: luloAdapter,
  magiceden: magicedenAdapter,
  tensor: tensorAdapter,
  sanctum: sanctumAdapter,
  pyth: pythAdapter,
  realms: realmsAdapter,
  squads: squadsAdapter,
  wormhole: wormholeAdapter,
  phoenix: phoenixAdapter,
};

export function listAdapters(): DAppAdapter[] {
  return Object.values(ADAPTERS).filter((adapter): adapter is DAppAdapter => adapter !== undefined);
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
  for (const adapter of listAdapters()) {
    for (const action of Object.values(adapter.actions)) {
      if (action.kind === kind) return adapter;
    }
  }
  return undefined;
}

export function actionForKind(kind: string): { adapter: DAppAdapter; action: { execute: DAppAdapter['actions'][string]['execute']; id: string } } | undefined {
  for (const adapter of listAdapters()) {
    for (const action of Object.values(adapter.actions)) {
      if (action.kind === kind) {
        return { adapter, action: { execute: action.execute, id: action.id } };
      }
    }
  }
  return undefined;
}

export function adapterForKind(kind: PreparedActionKind): AdapterAction<unknown> | undefined {
  for (const adapter of listAdapters()) {
    for (const action of Object.values(adapter.actions)) {
      if (action.kind === kind) return action;
    }
  }
  return undefined;
}

function buildConnectorApprovalActionTypes(): ReadonlySet<PreparedActionKind> {
  const kinds = new Set<PreparedActionKind>();
  for (const adapter of listAdapters()) {
    for (const action of Object.values(adapter.actions)) {
      kinds.add(action.kind);
    }
  }
  return kinds;
}

export const CONNECTOR_APPROVAL_ACTION_TYPES: ReadonlySet<PreparedActionKind> =
  buildConnectorApprovalActionTypes();
