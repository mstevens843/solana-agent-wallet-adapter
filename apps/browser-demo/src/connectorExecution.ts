import { PROTOCOL_CONNECTORS } from './connectedDapps.js';

export const CONNECTOR_APPROVAL_ACTION_TYPES: ReadonlySet<string> = new Set(
  PROTOCOL_CONNECTORS
    .flatMap((connector) => connector.actionKinds)
    .filter((kind) => kind !== 'swap'),
);

export const BROWSER_PROOF_ONLY_KINDS: ReadonlySet<string> = new Set([
  'manual_review',
  'read_only',
  'custom',
]);

export function isConnectorApprovalKind(action: { kind: string }): boolean {
  return CONNECTOR_APPROVAL_ACTION_TYPES.has(action.kind);
}

export function isProofOnlyApprovalKind(action: { kind: string }): boolean {
  return BROWSER_PROOF_ONLY_KINDS.has(action.kind);
}

export function connectorExecutionUnsupportedMessage(action: { kind: string }): string {
  const label = action.kind.replace(/_/g, ' ');
  return `${label} cannot execute from this device. The connected wallet must support transaction signing in this browser.`;
}

export interface ConnectorExecutionAvailability {
  bridgeActive: boolean;
  cloudSessionMatchesWallet: boolean;
}

export function connectorPrepareEndpointAvailable(input: ConnectorExecutionAvailability): boolean {
  return input.bridgeActive || input.cloudSessionMatchesWallet;
}

export interface ConnectorReceiptShape {
  txid?: string;
  proofSignature?: string;
  kind: string;
}

export type ConnectorReceiptOutcome =
  | 'transaction_submitted'   // real on-chain tx; txid present
  | 'decision_proof_only'     // proof signature only (audit-only kind)
  | 'unsubmitted_connector'   // connector kind that never reached the chain (legacy bug)
  | 'unknown';

export function classifyConnectorReceipt(receipt: ConnectorReceiptShape): ConnectorReceiptOutcome {
  if (receipt.txid && receipt.txid.trim()) return 'transaction_submitted';
  if (receipt.proofSignature && receipt.proofSignature.trim()) {
    if (isProofOnlyApprovalKind(receipt)) return 'decision_proof_only';
    if (isConnectorApprovalKind(receipt)) return 'unsubmitted_connector';
    return 'decision_proof_only';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Connector execution dispatcher (Phase D2)
// ---------------------------------------------------------------------------

export interface ConnectorExecutionToastContext {
  toastId: number;
  actionId?: string;
  cluster: string;
}

export interface ConnectorActionExecutionTarget {
  id: string;
  kind: string;
  cluster: string;
  walletAddress: string;
  workflowSource?: string;
  params?: Record<string, unknown>;
}

export interface PreparedTransactionResponse {
  transactionBase64: string;
  summary: string;
  preview?: Record<string, unknown>;
  cluster?: string;
  expiresAt?: string;
}

export interface BrowserTransactionExecutionResult {
  txid: string;
  txStatus: string;
  explorerUrl: string;
  preview?: Record<string, unknown>;
}

export interface ConnectorExecutionInit {
  method: 'POST';
  body?: string;
}

export interface ConnectorExecutionDeps<TAction extends ConnectorActionExecutionTarget> {
  cloudRequest: <T>(path: string, init: ConnectorExecutionInit) => Promise<T>;
  bridgeRequest: <T>(path: string, init: ConnectorExecutionInit) => Promise<T>;
  signAndBroadcast: (
    action: TAction,
    transactionBase64: string,
    summary: string,
    toastContext: ConnectorExecutionToastContext,
  ) => Promise<string>;
  resolveStatus: (
    cluster: string,
    txid: string,
    toastContext?: ConnectorExecutionToastContext,
  ) => Promise<string>;
  capabilitiesSupportSignTransaction: () => boolean;
  explorerUrl: (txid: string, cluster: string) => string;
  availability: ConnectorExecutionAvailability;
}

function requireConnectorString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`Connector prepare-transaction response is missing ${label}.`);
}

export async function executeBrowserConnectorAction<TAction extends ConnectorActionExecutionTarget & { params?: Record<string, unknown> }>(
  action: TAction,
  toastContext: ConnectorExecutionToastContext,
  deps: ConnectorExecutionDeps<TAction>,
): Promise<BrowserTransactionExecutionResult> {
  if (!isConnectorApprovalKind(action)) {
    throw new Error(`executeBrowserConnectorAction called for non-connector kind '${action.kind}'.`);
  }
  if (!deps.capabilitiesSupportSignTransaction()) {
    throw new Error('Selected wallet cannot sign connector transactions from this browser.');
  }
  const route = pickConnectorPrepareRoute(action, deps.availability);
  if (!route) {
    throw new Error(connectorExecutionUnsupportedMessage(action));
  }
  const response = await fetchPreparedTransaction(action, route, deps);
  const transactionBase64 = requireConnectorString(response?.transactionBase64, 'transactionBase64');
  const summary = requireConnectorString(response?.summary, 'summary');
  const txid = await deps.signAndBroadcast(action, transactionBase64, summary, toastContext);
  const txStatus = await deps.resolveStatus(action.cluster, txid, toastContext);
  const explorerUrlValue = deps.explorerUrl(txid, action.cluster);
  return {
    txid,
    txStatus,
    explorerUrl: explorerUrlValue,
    ...(response?.preview ? { preview: response.preview } : {}),
  };
}

async function fetchPreparedTransaction<TAction extends ConnectorActionExecutionTarget & { params?: Record<string, unknown> }>(
  action: TAction,
  route: ConnectorPrepareRoute,
  deps: ConnectorExecutionDeps<TAction>,
): Promise<PreparedTransactionResponse> {
  if (route.kind === 'bridge') {
    return deps.bridgeRequest<PreparedTransactionResponse>(
      `/bridge/prepared-actions/${encodeURIComponent(action.id)}/prepare-transaction`,
      { method: 'POST' },
    );
  }
  if (route.kind === 'cloud-approval') {
    return deps.cloudRequest<PreparedTransactionResponse>(
      `/api/approvals/${encodeURIComponent(action.id)}/prepare-transaction`,
      { method: 'POST' },
    );
  }
  // Stateless route: no stored approval needed. Send raw kind+params+wallet+cluster.
  return deps.cloudRequest<PreparedTransactionResponse>(
    '/api/connector/prepare-transaction',
    {
      method: 'POST',
      body: JSON.stringify({
        kind: action.kind,
        params: action.params ?? {},
        walletAddress: action.walletAddress,
        cluster: action.cluster,
      }),
    },
  );
}

export type ConnectorPrepareRoute =
  | { kind: 'bridge' }
  | { kind: 'cloud-approval' }
  | { kind: 'cloud-stateless' };

export function pickConnectorPrepareRoute(
  action: ConnectorActionExecutionTarget,
  availability: ConnectorExecutionAvailability,
): ConnectorPrepareRoute | undefined {
  // Honor where the action actually lives — local-bridge and cloud-stored approvals
  // must be prepared by the backend that holds them so the auth + lookup work.
  if (action.workflowSource === 'local-bridge' && availability.bridgeActive) {
    return { kind: 'bridge' };
  }
  if (action.workflowSource === 'cloud' && availability.cloudSessionMatchesWallet) {
    return { kind: 'cloud-approval' };
  }
  // Browser-workflow (and source-less) actions live only in the user's localStorage:
  // the bridge has no record of their `browser-action_*` IDs and 404s on lookup. Send
  // them through the stateless public cloud endpoint, which builds the unsigned tx
  // from raw kind + params + wallet + cluster. The browser still signs locally, so
  // funds never leave the user's control. Works for wallet-only, wallet+cloud,
  // wallet+AI, or any combination — including when a local bridge is also active.
  return { kind: 'cloud-stateless' };
}
