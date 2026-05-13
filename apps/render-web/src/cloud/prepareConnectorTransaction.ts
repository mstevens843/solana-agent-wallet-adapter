import { Connection } from '@solana/web3.js';
import {
  AdapterError,
  CONNECTOR_APPROVAL_ACTION_TYPES,
  DEFAULT_CONFIG,
  prepareTransactionForApproval,
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

export type ConnectorTransactionPreparer = (
  approval: ApprovalRequestRecord,
) => Promise<PreparedTransactionPayload>;

type PrepareOnlyBackend = DAppAdapterContext['backend'];

export function createDefaultConnectorPreparer(): ConnectorTransactionPreparer {
  return async (approval) => {
    const cluster: WorkflowCluster = approval.cluster ?? 'devnet';
    const rpcUrl = resolveRpcUrl(cluster);
    const ctx = buildPrepareOnlyContext({ approval, cluster, rpcUrl });
    const action = approvalRecordToPreparedAction(approval, cluster);
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
  approval: ApprovalRequestRecord;
  cluster: WorkflowCluster;
  rpcUrl: string;
}): DAppAdapterContext {
  const { approval, cluster, rpcUrl } = args;
  return {
    backend: prepareOnlyBackend(approval.walletAddress, cluster),
    config: { ...DEFAULT_CONFIG, cluster, rpcUrl },
    connection: new Connection(rpcUrl, 'confirmed'),
    signTransaction: throwInPrepareOnly('signTransaction'),
    signAndBroadcast: throwInPrepareOnly('signAndBroadcast'),
    signMessage: throwInPrepareOnly('signMessage'),
    store: prepareOnlyStore(),
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
