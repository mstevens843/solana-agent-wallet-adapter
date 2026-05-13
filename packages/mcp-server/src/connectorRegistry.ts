import type { Cluster } from '@solana-agent-wallet-adapter/core';

import type { AgentWalletConfig } from './config.js';
import { describeKaminoUnavailableReason } from './adapters/kamino/client.js';

export type ConnectorId =
  | 'kamino'
  | 'jupiter'
  | 'meteora'
  | 'raydium'
  | 'orca'
  | 'marginfi'
  | 'drift'
  | 'lulo'
  | 'save';

export type ConnectorCapability =
  | 'positions'
  | 'rewards'
  | 'markets'
  | 'blinks'
  | 'swap'
  | 'earn'
  | 'borrow'
  | 'withdraw'
  | 'repay'
  | 'add_liquidity'
  | 'close';

export type ConnectorExecutionMode =
  | 'first_class_prepare'
  | 'wallet_approval'
  | 'read_only'
  | 'unavailable';

export interface ConnectorRegistryEntry {
  id: ConnectorId;
  name: string;
  aliases: string[];
  supportedClusters: Cluster[];
  readCapabilities: ConnectorCapability[];
  writeCapabilities: ConnectorCapability[];
  readTools: string[];
  actionTools: string[];
  requiresClientKey: boolean;
  requiredConfig: string[];
  executionMode: ConnectorExecutionMode;
  approvalBoundary: string;
  limitations: string[];
  examples: string[];
}

export interface ConnectorReadiness {
  ready: boolean;
  reason?: string;
}

export interface ConnectorCapabilityView extends ConnectorRegistryEntry {
  readiness: {
    reads: ConnectorReadiness;
    actions: ConnectorReadiness;
  };
}

export const CONNECTOR_APPROVAL_BOUNDARY =
  'This prepares a wallet approval request; it does not sign, submit, or grant delegated authority.';

const UNAVAILABLE_ACTION_BOUNDARY =
  'This connector is registered for discovery, but this MCP runtime does not expose approval preparation for it yet.';

export const CONNECTOR_REGISTRY: ConnectorRegistryEntry[] = [
  {
    id: 'kamino',
    name: 'Kamino Finance',
    aliases: ['kamino', 'kamino finance', 'klend', 'kamino lend'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'rewards', 'markets'],
    writeCapabilities: ['earn', 'withdraw'],
    readTools: [
      'solana_connector_read_facts',
      'solana_kamino_reserve_snapshot',
      'solana_kamino_get_positions',
      'solana_kamino_prepare_earnings_proof',
    ],
    actionTools: [
      'solana_prepare_kamino_deposit',
      'solana_prepare_kamino_withdraw',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['Kamino client factory or @kamino-finance/klend-sdk integration'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'Reads and prepared actions require the Kamino client to be wired by the host process.',
      'Deposits and withdrawals become prepared approval inbox items until the wallet signs.',
    ],
    examples: [
      'show my Kamino positions',
      'show the SOL Kamino reserve APY',
      'prepare an earnings proof for Kamino',
      'supply 0.1 SOL to Kamino',
      'withdraw 0.05 SOL from Kamino',
    ],
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    aliases: ['jupiter', 'jup', 'jupiter swap', 'jupiter ultra', 'jupiter lend'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['swap'],
    writeCapabilities: ['swap'],
    readTools: [
      'solana_connector_read_facts',
      'solana_jupiter_order_preview',
      'solana_get_swap_quote',
    ],
    actionTools: [
      'solana_prepare_swap',
      'solana_swap',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: true,
    requiredConfig: ['JUPITER_API_KEY or JUP_API_KEY'],
    executionMode: 'wallet_approval',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Uses the configured Jupiter Ultra endpoint.',
      'Order previews require a Jupiter API key.',
      'Prepared swaps can be staged without an API key, but quote preview, direct execution, and approval-time quote refresh require a Jupiter API key.',
    ],
    examples: [
      'quote swapping 0.1 SOL to USDC',
      'prepare a swap from SOL to USDC',
      'swap 0.25 SOL to USDC with wallet approval',
      'DCA SOL to USDC weekly',
    ],
  },
  unavailableConnector({
    id: 'meteora',
    name: 'Meteora',
    aliases: ['meteora', 'dlmm', 'meteora dlmm'],
    examples: ['check my Meteora position', 'claim Meteora fees', 'add liquidity to a Meteora DLMM pool'],
  }),
  unavailableConnector({
    id: 'raydium',
    name: 'Raydium',
    aliases: ['raydium', 'ray'],
    examples: ['check a Raydium pool', 'farm on Raydium', 'prepare a Raydium liquidity action'],
  }),
  unavailableConnector({
    id: 'orca',
    name: 'Orca',
    aliases: ['orca', 'whirlpools', 'orca whirlpools'],
    examples: ['check an Orca Whirlpool', 'add liquidity to Orca', 'claim Orca fees'],
  }),
  unavailableConnector({
    id: 'marginfi',
    name: 'MarginFi',
    aliases: ['marginfi', 'mrgn'],
    examples: ['show my MarginFi positions', 'borrow on MarginFi', 'repay a MarginFi loan'],
  }),
  unavailableConnector({
    id: 'drift',
    name: 'Drift',
    aliases: ['drift', 'drift vaults', 'strategy vaults'],
    examples: ['show my Drift vaults', 'deposit into a Drift vault', 'withdraw from Drift'],
  }),
  unavailableConnector({
    id: 'lulo',
    name: 'Lulo',
    aliases: ['lulo'],
    examples: ['show my Lulo deposits', 'deposit into Lulo', 'withdraw from Lulo'],
  }),
  unavailableConnector({
    id: 'save',
    name: 'Save',
    aliases: ['save', 'save finance'],
    examples: ['show my Save positions', 'deposit into Save', 'withdraw from Save'],
  }),
];

export function listConnectorCapabilities(
  config?: AgentWalletConfig,
): ConnectorCapabilityView[] {
  return CONNECTOR_REGISTRY.map((connector) => connectorCapabilityView(connector, config));
}

export function getConnector(idOrAlias: string): ConnectorRegistryEntry | undefined {
  const normalized = normalizeConnectorSearch(idOrAlias);
  if (!normalized) return undefined;
  return CONNECTOR_REGISTRY.find((connector) =>
    connector.id === normalized ||
    connector.aliases.some((alias) => normalizeConnectorSearch(alias) === normalized) ||
    normalizeConnectorSearch(connector.name) === normalized,
  );
}

export function requireConnector(idOrAlias: string): ConnectorRegistryEntry {
  const connector = getConnector(idOrAlias);
  if (!connector) {
    throw new Error(`Unknown connector: ${idOrAlias}`);
  }
  return connector;
}

export function connectorRegistryPromptContext(
  config?: AgentWalletConfig,
): Array<Record<string, unknown>> {
  return listConnectorCapabilities(config).map((connector) => ({
    id: connector.id,
    name: connector.name,
    aliases: connector.aliases,
    readCapabilities: connector.readCapabilities,
    writeCapabilities: connector.writeCapabilities,
    readTools: connector.readTools,
    actionTools: connector.actionTools,
    requiresClientKey: connector.requiresClientKey,
    requiredConfig: connector.requiredConfig,
    executionMode: connector.executionMode,
    readiness: connector.readiness,
    limitations: connector.limitations,
    examples: connector.examples,
    approvalBoundary: connector.approvalBoundary,
    agentUse:
      'Use reads as facts. Use write capabilities only as prepare-only wallet approval work. If a capability is unavailable, say what is missing instead of inventing support.',
  }));
}

export function connectorCapabilityView(
  connector: ConnectorRegistryEntry,
  config?: AgentWalletConfig,
): ConnectorCapabilityView {
  const clusterAllowed = !config || connector.supportedClusters.includes(config.cluster);
  const clusterReason = config && !clusterAllowed
    ? `${connector.name} is only available on ${connector.supportedClusters.join(', ')}; current cluster is ${config.cluster}.`
    : undefined;
  const readConfigReason = clusterReason ? undefined : runtimeConfigBlockReason(connector, config, 'reads');
  const actionConfigReason = clusterReason ? undefined : runtimeConfigBlockReason(connector, config, 'actions');
  const readsReady = clusterAllowed && !readConfigReason && connector.readCapabilities.length > 0 && connector.readTools.length > 0;
  const actionsReady = clusterAllowed && !actionConfigReason && connector.writeCapabilities.length > 0 && connector.actionTools.length > 0;
  return {
    ...connector,
    readiness: {
      reads: {
        ready: readsReady,
        ...(clusterReason
          ? { reason: clusterReason }
          : readConfigReason
            ? { reason: readConfigReason }
          : !readsReady
            ? { reason: `${connector.name} does not expose MCP fact reads yet.` }
            : {}),
      },
      actions: {
        ready: actionsReady,
        ...(clusterReason
          ? { reason: clusterReason }
          : actionConfigReason
            ? { reason: actionConfigReason }
          : !actionsReady
            ? { reason: `${connector.name} does not expose MCP prepared actions yet.` }
            : {}),
      },
    },
  };
}

function runtimeConfigBlockReason(
  connector: ConnectorRegistryEntry,
  config?: AgentWalletConfig,
  target: 'reads' | 'actions' = 'reads',
): string | undefined {
  if (connector.id === 'jupiter' && config && target === 'reads') {
    const hasKey = Boolean(process.env[config.jupiter.apiKeyEnv]?.trim() || process.env.JUP_API_KEY?.trim());
    return hasKey ? undefined : `Missing Jupiter API key. Set ${config.jupiter.apiKeyEnv} or JUP_API_KEY.`;
  }
  if (connector.id === 'kamino') {
    const reason = describeKaminoUnavailableReason();
    return reason ? `Kamino client is not configured: ${reason}` : undefined;
  }
  return undefined;
}

function unavailableConnector(input: {
  id: ConnectorId;
  name: string;
  aliases: string[];
  examples: string[];
}): ConnectorRegistryEntry {
  return {
    id: input.id,
    name: input.name,
    aliases: input.aliases,
    supportedClusters: ['mainnet-beta'],
    readCapabilities: [],
    writeCapabilities: [],
    readTools: [],
    actionTools: [],
    requiresClientKey: true,
    requiredConfig: ['Connector-specific read API or Blink/Solana Action URL is not wired in MCP runtime'],
    executionMode: 'unavailable',
    approvalBoundary: UNAVAILABLE_ACTION_BOUNDARY,
    limitations: [
      'Registered for discovery and honest denials only.',
      'This MCP runtime does not expose first-class reads or prepared actions for this connector yet.',
      'Use an explicit Blink/Solana Action URL only after a supported MCP helper is added.',
    ],
    examples: input.examples,
  };
}

function normalizeConnectorSearch(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
