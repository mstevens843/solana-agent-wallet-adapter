import { Connection } from '@solana/web3.js';
import {
  AdapterError,
  CONNECTOR_APPROVAL_ACTION_TYPES,
  DEFAULT_CONFIG,
  prepareTransactionForApproval,
  type ConnectorSecretsMap,
  type DAppAdapterContext,
  type PreparedAction,
  type PreparedActionKind,
  type PreparedActionStore,
  type PreparedTransactionPayload,
} from '@solana-agent-wallet-adapter/mcp-server';
import type {
  ApprovalRequestRecord,
  WorkflowCluster,
} from '@solana-agent-wallet-adapter/workflow';

export { AdapterError, CONNECTOR_APPROVAL_ACTION_TYPES };
export type { PreparedTransactionPayload };

export type ConnectorSecretsLoader = (walletAddress: string) => Promise<ConnectorSecretsMap>;

export type ConnectorTransactionPreparer = (
  approval: ApprovalRequestRecord,
) => Promise<PreparedTransactionPayload>;

export interface StatelessConnectorPrepareInput {
  kind: string;
  params: Record<string, unknown>;
  walletAddress: string;
  cluster: WorkflowCluster;
  summary?: string;
}

export type StatelessConnectorTransactionPreparer = (
  input: StatelessConnectorPrepareInput,
) => Promise<PreparedTransactionPayload>;

type PrepareOnlyBackend = DAppAdapterContext['backend'];

export interface ConnectorPreparerOptions {
  secretsLoader?: ConnectorSecretsLoader;
}

export function createDefaultConnectorPreparer(
  options: ConnectorPreparerOptions = {},
): ConnectorTransactionPreparer {
  return async (approval) => {
    const cluster: WorkflowCluster = approval.cluster ?? 'devnet';
    const rpcUrl = resolveRpcUrl(cluster);
    const connectorSecrets = options.secretsLoader
      ? await options.secretsLoader(approval.walletAddress)
      : undefined;
    const ctx = buildPrepareOnlyContext({
      walletAddress: approval.walletAddress,
      cluster,
      rpcUrl,
      ...(connectorSecrets ? { connectorSecrets } : {}),
    });
    const action = approvalRecordToPreparedAction(approval, cluster);
    return prepareTransactionForApproval(action, ctx);
  };
}

export function createStatelessConnectorPreparer(
  options: ConnectorPreparerOptions = {},
): StatelessConnectorTransactionPreparer {
  return async (input) => {
    const cluster: WorkflowCluster = input.cluster;
    const rpcUrl = resolveRpcUrl(cluster);
    const connectorSecrets = options.secretsLoader
      ? await options.secretsLoader(input.walletAddress)
      : undefined;
    const ctx = buildPrepareOnlyContext({
      walletAddress: input.walletAddress,
      cluster,
      rpcUrl,
      ...(connectorSecrets ? { connectorSecrets } : {}),
    });
    const now = new Date().toISOString();
    const action: PreparedAction = {
      id: `stateless_${now}`,
      kind: input.kind as PreparedActionKind,
      status: 'ready',
      walletAddress: input.walletAddress,
      cluster,
      summary: input.summary ?? `Prepare ${input.kind.replace(/_/g, ' ')}`,
      params: input.params,
      dueAt: now,
      createdAt: now,
      updatedAt: now,
    };
    return prepareTransactionForApproval(action, ctx);
  };
}

function approvalRecordToPreparedAction(
  approval: ApprovalRequestRecord,
  cluster: WorkflowCluster,
): PreparedAction {
  return {
    id: approval.id,
    kind: approval.kind as PreparedActionKind,
    status: 'approval_pending',
    walletAddress: approval.walletAddress,
    cluster,
    summary: approval.summary,
    params: approval.params as Record<string, unknown>,
    dueAt: approval.dueAt,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    ...(approval.activeRequestId ? { activeRequestId: approval.activeRequestId } : {}),
  };
}

function buildPrepareOnlyContext(args: {
  walletAddress: string;
  cluster: WorkflowCluster;
  rpcUrl: string;
  connectorSecrets?: ConnectorSecretsMap;
}): DAppAdapterContext {
  const { walletAddress, cluster, rpcUrl, connectorSecrets } = args;
  return {
    backend: prepareOnlyBackend(walletAddress, cluster),
    config: { ...DEFAULT_CONFIG, cluster, rpcUrl },
    connection: new Connection(rpcUrl, 'confirmed'),
    signTransaction: throwInPrepareOnly('signTransaction'),
    signAndBroadcast: throwInPrepareOnly('signAndBroadcast'),
    signMessage: throwInPrepareOnly('signMessage'),
    store: prepareOnlyStore(),
    ...(connectorSecrets ? { connectorSecrets } : {}),
  };
}

function prepareOnlyBackend(address: string, cluster: WorkflowCluster): PrepareOnlyBackend {
  return {
    async capabilities() {
      return {
        backend: 'render-web-prepare',
        cluster: [cluster],
        supports: {
          signMessage: false,
          signTransaction: false,
          signAndSendTransaction: false,
          multiSign: false,
          simulationPreview: false,
        },
        address,
      };
    },
    async getAddress() {
      return address;
    },
    async submit() {
      throw new Error('Prepare-only backend cannot submit signing requests.');
    },
    async poll() {
      throw new Error('Prepare-only backend cannot poll signing requests.');
    },
  };
}

function prepareOnlyStore(): PreparedActionStore {
  const unavailable = (method: string): never => {
    throw new Error(
      `PreparedActionStore.${method} is not available in cloud prepare-only context.`,
    );
  };
  return {
    addAction: async () => unavailable('addAction'),
    listActions: async () => unavailable('listActions'),
    getAction: async () => unavailable('getAction'),
    updateAction: async () => unavailable('updateAction'),
    deleteAction: async () => unavailable('deleteAction'),
    archiveAction: async () => unavailable('archiveAction'),
    addRecurringPayment: async () => unavailable('addRecurringPayment'),
    listRecurringPayments: async () => unavailable('listRecurringPayments'),
    listRecurringPaymentViews: async () => unavailable('listRecurringPaymentViews'),
    updateRecurringPayment: async () => unavailable('updateRecurringPayment'),
    deleteRecurringPayment: async () => unavailable('deleteRecurringPayment'),
    materializeDueRecurring: async () => unavailable('materializeDueRecurring'),
    listReceipts: async () => unavailable('listReceipts'),
  };
}

function throwInPrepareOnly(method: string) {
  return async (): Promise<string> => {
    throw new Error(`${method} is not available in cloud prepare-only context.`);
  };
}

function resolveRpcUrl(cluster: WorkflowCluster): string {
  if (process.env.SOLANA_RPC_URL?.trim()) return process.env.SOLANA_RPC_URL.trim();
  if (process.env.HELIUS_RPC_URL?.trim()) return process.env.HELIUS_RPC_URL.trim();
  switch (cluster) {
    case 'mainnet-beta':
      return 'https://api.mainnet-beta.solana.com';
    case 'testnet':
      return 'https://api.testnet.solana.com';
    case 'localnet':
      return 'http://127.0.0.1:8899';
    case 'devnet':
    default:
      return 'https://api.devnet.solana.com';
  }
}
