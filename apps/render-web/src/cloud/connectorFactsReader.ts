import { Connection } from '@solana/web3.js';
import {
  AgentWalletActionService,
  normalizeConfig,
  type ConnectorFactReadInput,
  type ConnectorSecretsLoader,
  type DAppAdapterContext,
  type PreparedActionStore,
} from '@solana-agent-wallet-adapter/mcp-server';
import type { WorkflowCluster } from '@solana-agent-wallet-adapter/workflow';

export type ConnectorReadFactsRequest = ConnectorFactReadInput & {
  cluster: WorkflowCluster;
  walletAddress: string;
};

export type StatelessConnectorFactsReader = (
  input: ConnectorReadFactsRequest,
) => Promise<Record<string, unknown>>;

export interface CreateStatelessConnectorFactsReaderOptions {
  /**
   * Optional per-wallet BYO secret loader. When set, cloud reads pass `ctx.connectorSecrets` into the adapter so
   * BYO-key connectors (Magic Eden, Tensor, Sanctum, Lulo, Phoenix) can authenticate with the user's saved
   * credentials instead of falling back to env vars.
   */
  secretsLoader?: ConnectorSecretsLoader;
}

type WalletBackend = DAppAdapterContext['backend'];

export function createStatelessConnectorFactsReader(
  options: CreateStatelessConnectorFactsReaderOptions = {},
): StatelessConnectorFactsReader {
  return async ({ cluster, walletAddress, ...input }) => {
    const rpcUrl = solanaRpcUrl(cluster);
    const service = new AgentWalletActionService({
      backend: readOnlyWalletBackend(walletAddress, cluster),
      // normalizeConfig, NOT a `{ ...DEFAULT_CONFIG }` spread: the CONNECTORS_JUPITER_*_ENABLED env
      // overrides are applied inside normalizeConfig only. Spreading the defaults directly pinned
      // jupiter.trigger/recurring to `enabled: false` forever, so read-facts threw `unsupported_method`
      // for limit orders and DCA no matter what was set on the service — which is why the Orders
      // positions section could never load live rows through the cloud path.
      config: normalizeConfig({ cluster, rpcUrl }),
      connection: new Connection(rpcUrl, 'confirmed'),
      // AgentWalletActionService.adapterContext() builds `store: this.store()` unconditionally — even
      // for pure reads that never touch it — and store() throws when no prepared-action store is
      // configured. Without this, every adapter-backed read through the cloud (Jupiter borrow
      // `positions`, and so the Positions → Borrowing card) died with "Prepared action store is not
      // configured." Reads never write, so this satisfies the context and refuses writes loudly.
      preparedActions: readOnlyPreparedActionStore(),
      ...(options.secretsLoader ? { connectorSecretsLoader: options.secretsLoader } : {}),
    });
    return service.connectorReadFacts({
      ...input,
      walletAddress,
    });
  };
}

export function solanaRpcUrl(cluster: WorkflowCluster): string {
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

/**
 * A prepared-action store for a path that must never prepare an action. Reads return empty; every
 * write throws, mirroring `readOnlyWalletBackend`'s refusal to sign. If a read path ever starts
 * writing here, it fails loudly instead of silently persisting into a per-request store that vanishes.
 */
function readOnlyPreparedActionStore(): PreparedActionStore {
  const refuse = (): never => {
    throw new Error('Cloud connector reads cannot create or mutate prepared actions.');
  };
  return {
    addAction: refuse,
    async listActions() { return []; },
    async getAction() { return null; },
    updateAction: refuse,
    deleteAction: refuse,
    archiveAction: refuse,
    addRecurringPayment: refuse,
    async listRecurringPayments() { return []; },
    async listRecurringPaymentViews() { return []; },
    updateRecurringPayment: refuse,
    deleteRecurringPayment: refuse,
    async materializeDueRecurring() { return []; },
    async listReceipts() { return []; },
  };
}

function readOnlyWalletBackend(walletAddress: string, cluster: WorkflowCluster): WalletBackend {
  return {
    async capabilities() {
      return {
        backend: 'agentic-cloud-readonly',
        cluster: [cluster],
        address: walletAddress,
        supports: {
          signMessage: false,
          signTransaction: false,
          signAndSendTransaction: false,
          multiSign: false,
          simulationPreview: false,
        },
      };
    },
    async getAddress() {
      return walletAddress;
    },
    async submit() {
      throw new Error('Cloud connector reads cannot request wallet signatures.');
    },
    async poll() {
      throw new Error('Cloud connector reads cannot poll wallet approvals.');
    },
  };
}
