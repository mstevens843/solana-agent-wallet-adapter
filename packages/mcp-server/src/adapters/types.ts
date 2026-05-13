import type { Connection, PublicKey } from '@solana/web3.js';

import type { Cluster, WalletBackend } from '@solana-agent-wallet-adapter/core';

import type { AgentWalletConfig } from '../config.js';
import type {
  AddPreparedActionInput,
  PreparedAction,
  PreparedActionKind,
  PreparedActionStore,
} from '../preparedActions.js';

export type DAppAdapterId =
  | 'kamino'
  | 'meteora'
  | 'orca'
  | 'marginfi'
  | 'drift'
  | 'save'
  | 'jito'
  | 'marinade'
  | 'lulo'
  | 'raydium'
  | 'magiceden'
  | 'tensor'
  | 'sanctum'
  | 'pyth'
  | 'realms'
  | 'squads'
  | 'wormhole';

export interface DAppAdapterContext {
  backend: WalletBackend;
  config: AgentWalletConfig;
  connection: Connection;
  signTransaction?: (transactionBase64: string, summary: string) => Promise<string>;
  signAndBroadcast: (transactionBase64: string, summary: string) => Promise<string>;
  store: PreparedActionStore;
}

export interface AdapterPrepareResult {
  addInput: AddPreparedActionInput;
  preview: Record<string, unknown>;
}

export interface AdapterExecuteResult {
  txid: string;
  signedAt: string;
  preview?: Record<string, unknown>;
}

export interface AdapterAction<TInput = unknown> {
  id: string;
  kind: PreparedActionKind;
  prepare(input: TInput, ctx: DAppAdapterContext): Promise<AdapterPrepareResult>;
  execute(action: PreparedAction, ctx: DAppAdapterContext): Promise<AdapterExecuteResult>;
}

export interface AdapterRead<TInput = unknown, TResult = unknown> {
  id: string;
  read(input: TInput, ctx: DAppAdapterContext): Promise<TResult>;
}

export interface DAppAdapter {
  id: DAppAdapterId;
  name: string;
  website: string;
  description: string;
  supportedClusters: Cluster[];
  programIds: PublicKey[];
  actions: Record<string, AdapterAction>;
  reads: Record<string, AdapterRead>;
}

export class AdapterError extends Error {
  readonly code: string;
  readonly adapterId: string;

  constructor(adapterId: string, code: string, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.adapterId = adapterId;
  }
}

export function assertSupportedCluster(adapter: DAppAdapter, cluster: Cluster): void {
  if (!adapter.supportedClusters.includes(cluster)) {
    throw new AdapterError(
      adapter.id,
      'unsupported_cluster',
      `${adapter.name} is only available on ${adapter.supportedClusters.join(', ')}; current cluster is ${cluster}.`,
    );
  }
}
