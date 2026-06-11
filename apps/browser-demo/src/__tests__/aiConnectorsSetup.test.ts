import { describe, expect, it } from 'vitest';

import {
  aiConnectorsCommand,
  aiConnectorsReadinessFromBridgeStatus,
  normalizeAiConnectorsConnector,
} from '../aiConnectorsSetup.js';

describe('aiConnectorsCommand', () => {
  it('builds the hosted Android connector setup command', () => {
    expect(aiConnectorsCommand('codex')).toBe(
      'npm exec @solana-agent-wallet-adapter/cli -- aiconnectors --connector codex',
    );
    expect(aiConnectorsCommand('claude')).toBe(
      'npm exec @solana-agent-wallet-adapter/cli -- aiconnectors --connector claude',
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
