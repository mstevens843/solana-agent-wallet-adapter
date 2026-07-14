import { aiConnectorPreset, type AiConnector, type BridgeAiStatus } from './planner.js';

export const AI_CONNECTORS_DEFAULT_COMMAND =
  'npm exec --yes --package @solana-agent-wallet-adapter/cli -- solana-agent-wallet aiconnectors --connector codex';

export const AI_CONNECTORS_WEBSITE_DEFAULT_COMMAND =
  'npm exec --yes --package @solana-agent-wallet-adapter/cli -- solana-agent-wallet agent-setup --engine connector --connector codex';

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

export interface AiConnectorWebsiteSetupState {
  status: AiConnectorsReadinessStatus;
  connector: AiConnector;
  title: string;
  detail: string;
  connected: boolean;
  tone: AiConnectorsReadinessTone;
}

export interface AiConnectorsPairingCodeActionState {
  visible: boolean;
  disabled: boolean;
  label: 'Copy pairing code' | 'Generate & copy pairing code';
}

export function aiConnectorsPairingCodeActionState(input: {
  canStartPairing: boolean;
  pairingCode: string;
  pairingStatus: string;
}): AiConnectorsPairingCodeActionState {
  const hasPairingCode = input.pairingCode.trim().length > 0;
  return {
    visible: input.canStartPairing || hasPairingCode,
    disabled: input.pairingStatus === 'starting',
    label: hasPairingCode ? 'Copy pairing code' : 'Generate & copy pairing code',
  };
}

export type AiConnectorsQrAction = 'start-pairing' | 'copy-pairing-code' | 'stop-pairing';

export interface AiConnectorsQrActionButton {
  action: AiConnectorsQrAction;
  label: string;
  kind: 'primary' | 'utility';
  disabled: boolean;
}

/**
 * Single source of truth for the ordered button row beside the connector QR.
 * Both `aiConnectorsQrPanel()` (rendering) and the unit tests consume this so the
 * "Generate & copy pairing code" / "Copy pairing code" fallback can never silently
 * drop out of the row again. Order is the on-screen (top-to-bottom) order.
 */
export function aiConnectorsQrActionButtons(input: {
  canStartPairing: boolean;
  pairingStatus: string;
  pairingCode: string;
}): AiConnectorsQrActionButton[] {
  const isWaiting = input.pairingStatus === 'waiting';
  const buttons: AiConnectorsQrActionButton[] = [
    {
      action: 'start-pairing',
      label: isWaiting ? 'Refresh QR' : 'Start QR pairing',
      kind: 'primary',
      disabled: !input.canStartPairing || input.pairingStatus === 'starting',
    },
  ];

  const copy = aiConnectorsPairingCodeActionState({
    canStartPairing: input.canStartPairing,
    pairingCode: input.pairingCode,
    pairingStatus: input.pairingStatus,
  });
  if (copy.visible) {
    buttons.push({
      action: 'copy-pairing-code',
      label: copy.label,
      kind: 'utility',
      disabled: copy.disabled,
    });
  }

  if (isWaiting) {
    buttons.push({
      action: 'stop-pairing',
      label: 'Stop pairing',
      kind: 'utility',
      disabled: false,
    });
  }

  return buttons;
}

export function normalizeAiConnectorsConnector(value: string | null | undefined): AiConnector | null {
  return value === 'codex' || value === 'gemini' || value === 'claude' || value === 'antigravity' ? value : null;
}

export function aiConnectorsCommand(connector: AiConnector): string {
  return connector === 'codex'
    ? AI_CONNECTORS_DEFAULT_COMMAND
    : `npm exec --yes --package @solana-agent-wallet-adapter/cli -- solana-agent-wallet aiconnectors --connector ${connector}`;
}

export function aiConnectorsWebsiteCommand(connector: AiConnector): string {
  return connector === 'codex'
    ? AI_CONNECTORS_WEBSITE_DEFAULT_COMMAND
    : `npm exec --yes --package @solana-agent-wallet-adapter/cli -- solana-agent-wallet agent-setup --engine connector --connector ${connector}`;
}

export function aiConnectorWebsiteSetupState(input: {
  connector: AiConnector;
  hasBridgeCredentials: boolean;
  status?: BridgeAiStatus | null;
  checking?: boolean;
  failure?: 'offline' | 'unauthorized' | 'error';
  failureMessage?: string;
}): AiConnectorWebsiteSetupState {
  const selectedLabel = aiConnectorPreset(input.connector).label;
  if (!input.hasBridgeCredentials) {
    return {
      status: 'missing-credentials',
      connector: input.connector,
      title: 'Run the command first.',
      detail: 'Run the copied connector command in Terminal, then refresh status here.',
      connected: false,
      tone: 'pending',
    };
  }

  if (input.checking) {
    return {
      status: 'checking',
      connector: input.connector,
      title: `Checking ${selectedLabel}.`,
      detail: 'Confirming the local bridge is running and set to this subscription connector.',
      connected: false,
      tone: 'pending',
    };
  }

  if (input.failure === 'unauthorized') {
    return {
      status: 'unauthorized',
      connector: input.connector,
      title: 'Connector credentials expired.',
      detail: 'Rerun the connector command so this page and the local bridge use the same token.',
      connected: false,
      tone: 'error',
    };
  }

  if (input.failure === 'offline') {
    return {
      status: 'offline',
      connector: input.connector,
      title: 'Connector bridge not reachable.',
      detail: 'Paste the connector command in Terminal, keep it running, then refresh status.',
      connected: false,
      tone: 'error',
    };
  }

  if (input.failure === 'error') {
    return {
      status: 'error',
      connector: input.connector,
      title: 'Could not check connector.',
      detail: input.failureMessage || 'Refresh status after rerunning the connector command.',
      connected: false,
      tone: 'error',
    };
  }

  const status = input.status;
  if (!status || status.engine !== 'connector' || !status.configured) {
    return {
      status: 'not-configured',
      connector: input.connector,
      title: 'Plan Connector is not selected.',
      detail: `Run the command for ${selectedLabel} so the local bridge uses a subscription connector instead of an API key.`,
      connected: false,
      tone: 'warn',
    };
  }

  if (status.connector !== input.connector) {
    const actualLabel = status.connector ? aiConnectorPreset(status.connector).label : 'another connector';
    return {
      status: 'wrong-connector',
      connector: input.connector,
      title: `Bridge is set to ${actualLabel}.`,
      detail: `Run the command for ${selectedLabel}, then refresh status here.`,
      connected: false,
      tone: 'warn',
    };
  }

  if (status.connectorAuthStatus === 'binary-not-found') {
    return {
      status: 'binary-not-found',
      connector: input.connector,
      title: `${selectedLabel} CLI not found.`,
      detail: `Install or repair ${selectedLabel} on this computer, then rerun the connector command.`,
      connected: false,
      tone: 'warn',
    };
  }

  if (status.available && status.connectorAuthStatus === 'connected') {
    return {
      status: 'ready',
      connector: input.connector,
      title: `${status.connectorLabel || selectedLabel} is connected.`,
      detail: 'Website AI Connector will use this computer connector. Workflow approval and signing stay separate.',
      connected: true,
      tone: 'ready',
    };
  }

  return {
    status: 'needs-auth',
    connector: input.connector,
    title: `${selectedLabel} sign-in needed.`,
    detail: `Sign in to ${selectedLabel} on this computer, then refresh status here.`,
    connected: false,
    tone: 'warn',
  };
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
