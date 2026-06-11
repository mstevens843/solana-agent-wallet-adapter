import { aiConnectorPreset, type AiConnector, type BridgeAiStatus } from './planner.js';

export const AI_CONNECTORS_DEFAULT_COMMAND =
  'npm exec @solana-agent-wallet-adapter/cli -- aiconnectors --connector codex';

export type AiConnectorsReadinessStatus =
  | 'missing-credentials'
  | 'checking'
  | 'ready'
  | 'needs-auth'
  | 'binary-not-found'
  | 'wrong-connector'
  | 'not-configured'
  | 'offline'
  | 'unauthorized'
  | 'error';

export type AiConnectorsReadinessTone = 'pending' | 'ready' | 'warn' | 'error';

export interface AiConnectorsReadiness {
  status: AiConnectorsReadinessStatus;
  connector: AiConnector;
  title: string;
  detail: string;
  canStartPairing: boolean;
  tone: AiConnectorsReadinessTone;
}

export function normalizeAiConnectorsConnector(value: string | null | undefined): AiConnector | null {
  return value === 'codex' || value === 'gemini' || value === 'claude' ? value : null;
}

export function aiConnectorsCommand(connector: AiConnector): string {
  return connector === 'codex'
    ? AI_CONNECTORS_DEFAULT_COMMAND
    : `npm exec @solana-agent-wallet-adapter/cli -- aiconnectors --connector ${connector}`;
}

export function aiConnectorsReadinessFromBridgeStatus(input: {
  connector: AiConnector;
  hasBridgeCredentials: boolean;
  status?: BridgeAiStatus | null;
  checking?: boolean;
  failure?: 'offline' | 'unauthorized' | 'error';
  failureMessage?: string;
}): AiConnectorsReadiness {
  const selectedLabel = aiConnectorPreset(input.connector).label;
  if (!input.hasBridgeCredentials) {
    return {
      status: 'missing-credentials',
      connector: input.connector,
      title: 'Run the command first.',
      detail: 'After the lightweight connector opens this page with local bridge credentials, this panel can check status and generate the Android QR.',
      canStartPairing: false,
      tone: 'pending',
    };
  }

  if (input.checking) {
    return {
      status: 'checking',
      connector: input.connector,
      title: `Checking ${selectedLabel}.`,
      detail: 'Confirming the local connector bridge is running and signed in on this computer.',
      canStartPairing: false,
      tone: 'pending',
    };
  }

  if (input.failure === 'unauthorized') {
    return {
      status: 'unauthorized',
      connector: input.connector,
      title: 'Connector credentials expired.',
      detail: 'Rerun the lightweight connector command so this page gets a fresh local bridge token.',
      canStartPairing: false,
      tone: 'error',
    };
  }

  if (input.failure === 'offline') {
    return {
      status: 'offline',
      connector: input.connector,
      title: 'Connector bridge not reachable.',
      detail: 'Rerun the lightweight connector command, keep this computer awake, then refresh status.',
      canStartPairing: false,
      tone: 'error',
    };
  }

  if (input.failure === 'error') {
    return {
      status: 'error',
      connector: input.connector,
      title: 'Could not check connector.',
      detail: input.failureMessage || 'Refresh status after rerunning the lightweight connector command.',
      canStartPairing: false,
      tone: 'error',
    };
  }

  const status = input.status;
  if (!status || status.engine !== 'connector' || !status.configured) {
    return {
      status: 'not-configured',
      connector: input.connector,
      title: 'Connector is not selected.',
      detail: `Rerun the command for ${selectedLabel} so the local bridge uses a subscription connector instead of an API key.`,
      canStartPairing: false,
      tone: 'warn',
    };
  }

  if (status.connector !== input.connector) {
    const actualLabel = status.connector ? aiConnectorPreset(status.connector).label : 'another connector';
    return {
      status: 'wrong-connector',
      connector: input.connector,
      title: `Bridge is set to ${actualLabel}.`,
      detail: `Rerun the command for ${selectedLabel}, then refresh status before generating the Android QR.`,
      canStartPairing: false,
      tone: 'warn',
    };
  }

  if (status.connectorAuthStatus === 'binary-not-found') {
    return {
      status: 'binary-not-found',
      connector: input.connector,
      title: `${selectedLabel} CLI not found.`,
      detail: `Install or repair ${selectedLabel} on this computer, then rerun the lightweight connector command.`,
      canStartPairing: false,
      tone: 'warn',
    };
  }

  if (status.available && status.connectorAuthStatus === 'connected') {
    return {
      status: 'ready',
      connector: input.connector,
      title: `${status.connectorLabel || selectedLabel} is ready.`,
      detail: 'Connector ready. Generate the QR, then scan it from Agentic Android.',
      canStartPairing: true,
      tone: 'ready',
    };
  }

  return {
    status: 'needs-auth',
    connector: input.connector,
    title: `${selectedLabel} sign-in needed.`,
    detail: `Sign in to ${selectedLabel} on this computer, then refresh status before generating the Android QR.`,
    canStartPairing: false,
    tone: 'warn',
  };
}
