import type { ActionCategory } from './connectorDrafting.js';
import type { ConnectedDappAdapter, ConnectedDappId } from './connectedDapps.js';

export const CONNECTOR_CREDENTIAL_IDS = ['magiceden', 'tensor', 'sanctum', 'lulo', 'phoenix'] as const;
export type ConnectorCredentialId = (typeof CONNECTOR_CREDENTIAL_IDS)[number];

export type ConnectorReadinessKind =
  | 'ready'
  | 'needs_wallet'
  | 'needs_credential'
  | 'setup_available'
  | 'missing_account'
  | 'membership_required'
  | 'position_required'
  | 'planned_unavailable'
  | 'wrong_cluster'
  | 'read_only_ok';

export interface ConnectorReadinessInput {
  connector: ConnectedDappAdapter;
  clusterSupported: boolean;
  walletAddress?: string;
  hasCredential?: boolean;
  actionCategory?: ActionCategory | null;
}

export interface ConnectorReadinessResult {
  kind: ConnectorReadinessKind;
  label: string;
  detail: string;
  blocksAction: boolean;
  canEnable: boolean;
  requiresWallet: boolean;
  requiresCredential: boolean;
  notes: string[];
}

export function connectorNeedsCredential(id: string): id is ConnectorCredentialId {
  return (CONNECTOR_CREDENTIAL_IDS as readonly string[]).includes(id);
}

export function connectorReadiness(input: ConnectorReadinessInput): ConnectorReadinessResult {
  const { connector, clusterSupported, walletAddress, actionCategory } = input;
  const requiresCredential = connectorNeedsCredential(connector.id);
  const hasCredential = !requiresCredential || input.hasCredential === true;
  const actionScoped = Boolean(actionCategory);
  const baseNotes = connectorReadinessNotes(connector.id);

  if (!clusterSupported) {
    return {
      kind: 'wrong_cluster',
      label: 'Wrong cluster',
      detail: `${connector.name} is available on ${connector.supportedClusters.join(', ')} only.`,
      blocksAction: true,
      canEnable: false,
      requiresWallet: false,
      requiresCredential,
      notes: baseNotes,
    };
  }

  if (connector.id === 'mayan' || (!connector.actionSource && connector.actionKinds.length === 0 && connector.readTools.length === 0)) {
    return {
      kind: 'planned_unavailable',
      label: 'Planned',
      detail: `${connector.name} is cataloged, but runtime tools are not wired yet.`,
      blocksAction: true,
      canEnable: false,
      requiresWallet: false,
      requiresCredential,
      notes: baseNotes,
    };
  }

  if (requiresCredential && !hasCredential) {
    return {
      kind: 'needs_credential',
      label: connector.id === 'phoenix' ? 'Needs access code' : 'Needs API key',
      detail: `${connector.name} needs a connector credential before Agentic can use its runtime APIs.`,
      blocksAction: true,
      canEnable: true,
      requiresWallet: false,
      requiresCredential: true,
      notes: baseNotes,
    };
  }

  if (!walletAddress) {
    return {
      kind: connector.readTools.length > 0 && !actionScoped ? 'read_only_ok' : 'needs_wallet',
      label: actionScoped ? 'Needs wallet' : 'Enable now',
      detail: actionScoped
        ? `Connect a wallet before preparing ${connector.name} actions.`
        : `You can enable ${connector.name} now; wallet-specific account checks run after a wallet is connected.`,
      blocksAction: actionScoped,
      canEnable: true,
      requiresWallet: true,
      requiresCredential,
      notes: baseNotes,
    };
  }

  const protocolKind = connectorProtocolReadinessKind(connector.id);
  if (protocolKind) {
    return {
      ...protocolKind,
      requiresWallet: true,
      requiresCredential,
      notes: baseNotes,
    };
  }

  return {
    kind: 'ready',
    label: 'Ready',
    detail: `${connector.name} can be enabled for Agentic. Wallet prompts happen only when a prepared transaction needs approval.`,
    blocksAction: false,
    canEnable: true,
    requiresWallet: true,
    requiresCredential,
    notes: baseNotes,
  };
}

function connectorProtocolReadinessKind(id: ConnectedDappId): Omit<ConnectorReadinessResult, 'requiresWallet' | 'requiresCredential' | 'notes'> | null {
  switch (id) {
    case 'project0':
      return {
        kind: 'setup_available',
        label: 'Setup available',
        detail: 'If this wallet has no Project 0 account, Agentic can prepare the Project 0 create-account transaction for wallet approval.',
        blocksAction: false,
        canEnable: true,
      };
    case 'drift':
      return {
        kind: 'setup_available',
        label: 'Setup opt-in',
        detail: 'First Drift vault deposits may need depositor initialization. Agentic only includes that setup when the action explicitly opts in.',
        blocksAction: false,
        canEnable: true,
      };
    case 'marginfi':
      return {
        kind: 'missing_account',
        label: 'Account required',
        detail: 'MarginFi requires an existing account. If Agentic cannot discover it, the action will ask for the marginfiAccount address or direct the user to MarginFi.',
        blocksAction: false,
        canEnable: true,
      };
    case 'squads':
    case 'realms':
      return {
        kind: 'membership_required',
        label: 'Membership required',
        detail: 'Governance and multisig actions require the wallet to already have the relevant authority, membership, or voting power.',
        blocksAction: false,
        canEnable: true,
      };
    case 'raydium':
    case 'orca':
    case 'meteora':
      return {
        kind: 'position_required',
        label: 'Position checks',
        detail: 'Liquidity-management actions require the wallet to have the relevant LP or position state; first add-liquidity actions are reviewed as normal transactions.',
        blocksAction: false,
        canEnable: true,
      };
    case 'pyth':
      return {
        kind: 'read_only_ok',
        label: 'Reads available',
        detail: 'Pyth reads do not need protocol setup. Posting an on-chain price update still requires normal wallet approval.',
        blocksAction: false,
        canEnable: true,
      };
    default:
      return null;
  }
}

function connectorReadinessNotes(id: ConnectedDappId): string[] {
  const common = [
    'Enablement is an Agentic preference only.',
    'No wallet signature or protocol approval is requested here.',
  ];
  switch (id) {
    case 'kamino':
      return [...common, 'A first Kamino deposit can include obligation initialization inside the signed deposit transaction.'];
    case 'save':
      return [...common, 'Borrow and withdraw actions still run obligation and health checks before wallet approval.'];
    case 'lulo':
      return [...common, 'Regular withdrawals may require a later completion step.'];
    case 'wormhole':
      return [...common, 'Destination-chain signing is not performed by this Solana connector.'];
    default:
      return common;
  }
}
