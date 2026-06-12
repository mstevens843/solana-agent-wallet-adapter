import { describe, expect, it } from 'vitest';

import {
  aiConnectorWebsiteSetupState,
  aiConnectorsCommand,
  aiConnectorsPairingCodeActionState,
  aiConnectorsQrActionButtons,
  aiConnectorsReadinessFromBridgeStatus,
  aiConnectorsWebsiteCommand,
  normalizeAiConnectorsConnector,
} from '../aiConnectorsSetup.js';

const PAIRING_CODE =
  '{"v":2,"relay":"https://agentic-signer.com","uuid":"u","token":"t","e2ee":{"alg":"x","desktopPub":"d","pairSecret":"p"}}';

describe('aiConnectorsCommand', () => {
  it('builds the hosted Android connector setup command', () => {
    expect(aiConnectorsCommand('codex')).toBe(
      'npm exec --yes --package @solana-agent-wallet-adapter/cli -- solana-agent-wallet aiconnectors --connector codex',
    );
    expect(aiConnectorsCommand('claude')).toBe(
      'npm exec --yes --package @solana-agent-wallet-adapter/cli -- solana-agent-wallet aiconnectors --connector claude',
    );
    expect(aiConnectorsCommand('gemini')).toBe(
      'npm exec --yes --package @solana-agent-wallet-adapter/cli -- solana-agent-wallet aiconnectors --connector gemini',
    );
  });
});

describe('aiConnectorsWebsiteCommand', () => {
  it('builds the website connector setup command without opening the Android QR page', () => {
    expect(aiConnectorsWebsiteCommand('codex')).toBe(
      'npm exec --yes --package @solana-agent-wallet-adapter/cli -- solana-agent-wallet agent-setup --engine connector --connector codex',
    );
    expect(aiConnectorsWebsiteCommand('claude')).toBe(
      'npm exec --yes --package @solana-agent-wallet-adapter/cli -- solana-agent-wallet agent-setup --engine connector --connector claude',
    );
    expect(aiConnectorsWebsiteCommand('gemini')).toBe(
      'npm exec --yes --package @solana-agent-wallet-adapter/cli -- solana-agent-wallet agent-setup --engine connector --connector gemini',
    );
  });
});

describe('normalizeAiConnectorsConnector', () => {
  it('accepts only the Android connector setup pilot connectors', () => {
    expect(normalizeAiConnectorsConnector('codex')).toBe('codex');
    expect(normalizeAiConnectorsConnector('gemini')).toBe('gemini');
    expect(normalizeAiConnectorsConnector('claude')).toBe('claude');
    expect(normalizeAiConnectorsConnector('antigravity')).toBeNull();
    expect(normalizeAiConnectorsConnector('openai')).toBeNull();
  });
});

describe('aiConnectorsPairingCodeActionState', () => {
  it('shows generate-and-copy when the connector is ready but no pairing code exists', () => {
    expect(aiConnectorsPairingCodeActionState({
      canStartPairing: true,
      pairingCode: '',
      pairingStatus: 'idle',
    })).toEqual({
      visible: true,
      disabled: false,
      label: 'Generate & copy pairing code',
    });
  });

  it('keeps copy visible for an existing code even after pairing expires or readiness changes', () => {
    expect(aiConnectorsPairingCodeActionState({
      canStartPairing: false,
      pairingCode: '{"v":2,"relay":"https://agentic-signer.com","uuid":"u","token":"t","e2ee":{"alg":"x","desktopPub":"d","pairSecret":"p"}}',
      pairingStatus: 'expired',
    })).toEqual({
      visible: true,
      disabled: false,
      label: 'Copy pairing code',
    });
  });

  it('disables copy only while a pairing payload is being minted', () => {
    expect(aiConnectorsPairingCodeActionState({
      canStartPairing: true,
      pairingCode: '',
      pairingStatus: 'starting',
    })).toMatchObject({ visible: true, disabled: true });
  });

  it('hides copy when the connector is not ready and no pairing code exists', () => {
    expect(aiConnectorsPairingCodeActionState({
      canStartPairing: false,
      pairingCode: '',
      pairingStatus: 'idle',
    })).toEqual({
      visible: false,
      disabled: false,
      label: 'Generate & copy pairing code',
    });
  });
});

describe('aiConnectorsQrActionButtons', () => {
  it('shows Start QR pairing then Generate & copy pairing code when ready before any QR exists', () => {
    expect(aiConnectorsQrActionButtons({
      canStartPairing: true,
      pairingStatus: 'idle',
      pairingCode: '',
    })).toEqual([
      { action: 'start-pairing', label: 'Start QR pairing', kind: 'primary', disabled: false },
      { action: 'copy-pairing-code', label: 'Generate & copy pairing code', kind: 'utility', disabled: false },
    ]);
  });

  it('shows Refresh QR, Copy pairing code, then Stop pairing once a QR is waiting to be scanned', () => {
    expect(aiConnectorsQrActionButtons({
      canStartPairing: true,
      pairingStatus: 'waiting',
      pairingCode: PAIRING_CODE,
    })).toEqual([
      { action: 'start-pairing', label: 'Refresh QR', kind: 'primary', disabled: false },
      { action: 'copy-pairing-code', label: 'Copy pairing code', kind: 'utility', disabled: false },
      { action: 'stop-pairing', label: 'Stop pairing', kind: 'utility', disabled: false },
    ]);
  });

  it('keeps both actions present but disabled while a pairing payload is being minted', () => {
    expect(aiConnectorsQrActionButtons({
      canStartPairing: true,
      pairingStatus: 'starting',
      pairingCode: '',
    })).toEqual([
      { action: 'start-pairing', label: 'Start QR pairing', kind: 'primary', disabled: true },
      { action: 'copy-pairing-code', label: 'Generate & copy pairing code', kind: 'utility', disabled: true },
    ]);
  });

  it('keeps the copy action available for an existing code even when readiness drops', () => {
    expect(aiConnectorsQrActionButtons({
      canStartPairing: false,
      pairingStatus: 'expired',
      pairingCode: PAIRING_CODE,
    })).toEqual([
      { action: 'start-pairing', label: 'Start QR pairing', kind: 'primary', disabled: true },
      { action: 'copy-pairing-code', label: 'Copy pairing code', kind: 'utility', disabled: false },
    ]);
  });

  it('drops the copy action only when the connector is not ready and no pairing code exists', () => {
    expect(aiConnectorsQrActionButtons({
      canStartPairing: false,
      pairingStatus: 'idle',
      pairingCode: '',
    })).toEqual([
      { action: 'start-pairing', label: 'Start QR pairing', kind: 'primary', disabled: true },
    ]);
  });
});

describe('aiConnectorWebsiteSetupState', () => {
  it('reports connected only when the selected connector is connected on the bridge', () => {
    const state = aiConnectorWebsiteSetupState({
      connector: 'codex',
      hasBridgeCredentials: true,
      status: {
        available: true,
        configured: true,
        source: 'session',
        engine: 'connector',
        connector: 'codex',
        connectorLabel: 'Codex (ChatGPT plan)',
        connectorAuthStatus: 'connected',
      },
    });

    expect(state).toMatchObject({
      status: 'ready',
      connected: true,
      tone: 'ready',
      title: 'Codex (ChatGPT plan) is connected.',
    });
  });

  it('keeps the website connector panel actionable while the bridge is offline', () => {
    const state = aiConnectorWebsiteSetupState({
      connector: 'claude',
      hasBridgeCredentials: true,
      failure: 'offline',
    });

    expect(state.status).toBe('offline');
    expect(state.connected).toBe(false);
    expect(state.detail).toContain('Terminal');
  });

  it('distinguishes wrong connector, missing CLI, and sign-in-needed states', () => {
    const wrongConnector = aiConnectorWebsiteSetupState({
      connector: 'codex',
      hasBridgeCredentials: true,
      status: {
        available: true,
        configured: true,
        source: 'session',
        engine: 'connector',
        connector: 'gemini',
        connectorAuthStatus: 'connected',
      },
    });
    const missingCli = aiConnectorWebsiteSetupState({
      connector: 'gemini',
      hasBridgeCredentials: true,
      status: {
        available: false,
        configured: true,
        source: 'session',
        engine: 'connector',
        connector: 'gemini',
        connectorAuthStatus: 'binary-not-found',
      },
    });
    const needsAuth = aiConnectorWebsiteSetupState({
      connector: 'claude',
      hasBridgeCredentials: true,
      status: {
        available: false,
        configured: true,
        source: 'session',
        engine: 'connector',
        connector: 'claude',
        connectorAuthStatus: 'needs-auth',
      },
    });

    expect(wrongConnector.status).toBe('wrong-connector');
    expect(missingCli.status).toBe('binary-not-found');
    expect(needsAuth.status).toBe('needs-auth');
  });
});

describe('aiConnectorsReadinessFromBridgeStatus', () => {
  it('blocks QR generation until local bridge credentials are present', () => {
    const readiness = aiConnectorsReadinessFromBridgeStatus({
      connector: 'codex',
      hasBridgeCredentials: false,
    });

    expect(readiness.status).toBe('missing-credentials');
    expect(readiness.canStartPairing).toBe(false);
    expect(readiness.detail).toContain('local bridge credentials');
  });

  it('blocks QR generation while connector status is being checked', () => {
    const readiness = aiConnectorsReadinessFromBridgeStatus({
      connector: 'codex',
      hasBridgeCredentials: true,
      checking: true,
    });

    expect(readiness.status).toBe('checking');
    expect(readiness.canStartPairing).toBe(false);
  });

  it('enables QR generation only when the selected connector is connected', () => {
    const readiness = aiConnectorsReadinessFromBridgeStatus({
      connector: 'codex',
      hasBridgeCredentials: true,
      status: {
        available: true,
        configured: true,
        source: 'session',
        engine: 'connector',
        connector: 'codex',
        connectorLabel: 'Codex (ChatGPT plan)',
        connectorAuthStatus: 'connected',
      },
    });

    expect(readiness.status).toBe('ready');
    expect(readiness.canStartPairing).toBe(true);
  });

  it('blocks QR generation when the connector needs auth or the CLI is missing', () => {
    const needsAuth = aiConnectorsReadinessFromBridgeStatus({
      connector: 'claude',
      hasBridgeCredentials: true,
      status: {
        available: false,
        configured: true,
        source: 'session',
        engine: 'connector',
        connector: 'claude',
        connectorAuthStatus: 'needs-auth',
      },
    });
    const missingCli = aiConnectorsReadinessFromBridgeStatus({
      connector: 'gemini',
      hasBridgeCredentials: true,
      status: {
        available: false,
        configured: true,
        source: 'session',
        engine: 'connector',
        connector: 'gemini',
        connectorAuthStatus: 'binary-not-found',
      },
    });

    expect(needsAuth.status).toBe('needs-auth');
    expect(needsAuth.canStartPairing).toBe(false);
    expect(missingCli.status).toBe('binary-not-found');
    expect(missingCli.canStartPairing).toBe(false);
  });

  it('blocks QR generation when the bridge is configured for another AI path', () => {
    const apiKey = aiConnectorsReadinessFromBridgeStatus({
      connector: 'codex',
      hasBridgeCredentials: true,
      status: {
        available: true,
        configured: true,
        source: 'session',
        engine: 'api-key',
        provider: 'openrouter',
      },
    });
    const wrongConnector = aiConnectorsReadinessFromBridgeStatus({
      connector: 'codex',
      hasBridgeCredentials: true,
      status: {
        available: true,
        configured: true,
        source: 'session',
        engine: 'connector',
        connector: 'gemini',
        connectorAuthStatus: 'connected',
      },
    });

    expect(apiKey.status).toBe('not-configured');
    expect(apiKey.canStartPairing).toBe(false);
    expect(wrongConnector.status).toBe('wrong-connector');
    expect(wrongConnector.canStartPairing).toBe(false);
  });
});
