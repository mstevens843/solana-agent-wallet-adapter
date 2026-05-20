import { Connection } from '@solana/web3.js';
import {
  AgentWalletActionService,
  DEFAULT_CONFIG,
  type ConnectorFactReadInput,
  type ConnectorSecretsLoader,
  type DAppAdapterContext,
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
      config: {
        ...DEFAULT_CONFIG,
        cluster,
        rpcUrl,
      },
      connection: new Connection(rpcUrl, 'confirmed'),
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
