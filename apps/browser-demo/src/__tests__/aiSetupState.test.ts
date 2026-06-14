import { describe, expect, it } from 'vitest';

import {
  aiRailQuickActionKind,
  aiProviderLogoHint,
  bridgeAiSetupSnapshot,
  buildAiRailIdentity,
  buildAiSetupInventory,
  deviceAgentSetupSnapshot,
  directAiKeyStaged,
  selectAiKeyClearTarget,
  type AiPathClearability,
  type AiSetupInventory,
} from '../aiSetupState.js';

describe('AI setup state helpers', () => {
  const noClearablePaths: AiPathClearability = {
    hosted: false,
    session: false,
    bridge: false,
    'device-agent': false,
  };
  const pathLabels = {
    hosted: 'Hosted BYOK',
    session: 'Browser Session',
    bridge: 'Local Bridge',
    'device-agent': 'Device Agent',
  };

  function railIdentity(inventory: AiSetupInventory, confirmed = false) {
    return buildAiRailIdentity({
      inventory,
      pathLabels,
      activeFallback: {
        provider: 'OpenAI',
        model: 'gpt-5',
        logoHint: 'codex',
      },
      readinessLabel: 'Device Agent running',
      confirmationLabel: 'Runtime ready',
      confirmed,
    });
  }

  it('stages a direct AI key from provider/model/key readiness', () => {
    expect(directAiKeyStaged({
      apiKey: 'provider-key',
      model: 'gpt-5',
      providerReady: true,
    })).toBe(true);

    expect(directAiKeyStaged({
      apiKey: 'provider-key',
      model: 'gpt-5',
      providerReady: false,
    })).toBe(false);

    expect(directAiKeyStaged({
      apiKey: '   ',
      model: 'gpt-5',
      providerReady: true,
    })).toBe(false);
  });

  it('treats Hosted BYOK as configured but not runnable until Cloud sign-in', () => {
    const inventory = buildAiSetupInventory({
      activeMode: 'hosted',
      hosted: {
        configured: true,
        runnable: false,
        provider: 'OpenAI',
        model: 'gpt-5',
      },
      session: { configured: false, runnable: false },
      bridge: { configured: false, runnable: false },
      deviceAgent: { configured: false, runnable: false },
    });

    expect(inventory.active).toMatchObject({
      mode: 'hosted',
      configured: true,
      runnable: false,
    });
    expect(inventory.anyConfigured).toBe(true);
  });

  it('targets inactive Hosted BYOK for clearing when Local Bridge is selected', () => {
    expect(selectAiKeyClearTarget({
      activeMode: 'bridge',
      inactiveConfigured: [{ mode: 'hosted' }],
      clearableByMode: {
        ...noClearablePaths,
        hosted: true,
      },
    })).toBe('hosted');
  });

  it('prefers the active path when it has a clearable key', () => {
    expect(selectAiKeyClearTarget({
      activeMode: 'bridge',
      inactiveConfigured: [{ mode: 'hosted' }],
      clearableByMode: {
        ...noClearablePaths,
        hosted: true,
        bridge: true,
      },
    })).toBe('bridge');
  });

  it('returns null when no active or inactive path is clearable', () => {
    expect(selectAiKeyClearTarget({
      activeMode: 'bridge',
      inactiveConfigured: [{ mode: 'hosted' }],
      clearableByMode: noClearablePaths,
    })).toBeNull();
  });

  it('keeps mobile rail quick actions mutually exclusive', () => {
    expect(aiRailQuickActionKind({
      pairedBridge: true,
      configured: false,
      inactive: false,
      clearTarget: null,
    })).toBe('disconnect-plan-connector');

    expect(aiRailQuickActionKind({
      pairedBridge: false,
      configured: true,
      inactive: false,
      clearTarget: 'device-agent',
    })).toBe('clear-key');

    expect(aiRailQuickActionKind({
      pairedBridge: false,
      configured: false,
      inactive: false,
      clearTarget: null,
    })).toBe('setup');

    expect(aiRailQuickActionKind({
      pairedBridge: false,
      configured: true,
      inactive: false,
      clearTarget: null,
    })).toBe('none');
  });

  it('tracks configured inactive Device Agent while Hosted BYOK is selected', () => {
    const inventory = buildAiSetupInventory({
      activeMode: 'hosted',
      hosted: { configured: false, runnable: false },
      session: { configured: false, runnable: false },
      bridge: { configured: false, runnable: false },
      deviceAgent: {
        configured: true,
        runnable: true,
        provider: 'openai',
        model: 'gpt-5',
      },
    });

    expect(inventory.active.mode).toBe('hosted');
    expect(inventory.active.configured).toBe(false);
    expect(inventory.inactiveConfigured).toEqual([
      expect.objectContaining({
        mode: 'device-agent',
        configured: true,
        runnable: true,
      }),
    ]);
    expect(inventory.anyConfigured).toBe(true);
  });

  it('normalizes bridge and Device Agent status payloads into setup snapshots', () => {
    expect(bridgeAiSetupSnapshot({
      status: {
        available: false,
        configured: true,
        source: 'session',
        provider: 'openai',
        model: 'gpt-5',
      },
    })).toMatchObject({
      configured: true,
      runnable: false,
      provider: 'openai',
      model: 'gpt-5',
    });

    expect(deviceAgentSetupSnapshot({
      visible: true,
      status: {
        available: true,
        enabled: true,
        configured: true,
        state: 'running',
        runtime: 'browser-native',
        provider: 'openai',
        model: 'gpt-5',
      },
    })).toMatchObject({
      configured: true,
      runnable: true,
      provider: 'openai',
      model: 'gpt-5',
    });
  });

  it('normalizes bridge connector status into connector setup labels', () => {
    expect(bridgeAiSetupSnapshot({
      status: {
        available: true,
        configured: true,
        source: 'session',
        engine: 'connector',
        connector: 'codex',
        connectorLabel: 'Codex (ChatGPT plan)',
        connectorAuthStatus: 'connected',
      },
    })).toMatchObject({
      configured: true,
      runnable: true,
      provider: 'Codex (ChatGPT plan)',
      model: 'signed in',
      detail: 'Codex (ChatGPT plan) - signed in',
      logoHint: 'codex',
    });

    expect(bridgeAiSetupSnapshot({
      status: {
        available: false,
        configured: true,
        source: 'session',
        engine: 'connector',
        connector: 'gemini',
        connectorLabel: 'Gemini (Google AI Pro/Ultra)',
        connectorAuthStatus: 'binary-not-found',
      },
    })).toMatchObject({
      configured: true,
      runnable: false,
      provider: 'Gemini (Google AI Pro/Ultra)',
      model: 'CLI not installed',
      detail: 'Gemini (Google AI Pro/Ultra) - CLI not installed',
      logoHint: 'gemini',
    });
  });

  it('treats iOS configured/stopped Device Agent as runnable from Keychain', () => {
    expect(deviceAgentSetupSnapshot({
      visible: true,
      status: {
        available: true,
        enabled: true,
        configured: true,
        state: 'stopped',
        runtime: 'ios-native',
        provider: 'anthropic',
        model: 'claude-opus-4-1',
      },
    })).toMatchObject({
      configured: true,
      runnable: true,
      provider: 'anthropic',
      model: 'claude-opus-4-1',
    });

    expect(deviceAgentSetupSnapshot({
      visible: true,
      status: {
        available: true,
        enabled: true,
        configured: true,
        state: 'stopped',
        runtime: 'android-native',
      },
    }).runnable).toBe(false);
  });

  it('treats a paired Plan Connector as configured before runtime status catches up', () => {
    const inventory = buildAiSetupInventory({
      activeMode: 'device-agent',
      hosted: { configured: false, runnable: false },
      session: { configured: false, runnable: false },
      bridge: { configured: false, runnable: false },
      deviceAgent: deviceAgentSetupSnapshot({
        visible: false,
        status: null,
        pairedBridge: true,
        pairedProvider: 'Plan Connector - Codex',
        pairedModel: 'ChatGPT plan',
        pairedLogoHint: 'codex',
      }),
    });

    expect(inventory.active).toMatchObject({
      mode: 'device-agent',
      configured: true,
      runnable: true,
      provider: 'Plan Connector - Codex',
      model: 'ChatGPT plan',
      logoHint: 'codex',
    });
    expect(railIdentity(inventory)).toMatchObject({
      configured: true,
      inactive: false,
      statusLabel: 'configured',
      statusTone: 'configured',
      provider: 'Plan Connector - Codex',
    });
  });

  it('builds the rail identity from active configured Device Agent details', () => {
    const inventory = buildAiSetupInventory({
      activeMode: 'device-agent',
      hosted: { configured: false, runnable: false },
      session: { configured: false, runnable: false },
      bridge: { configured: false, runnable: false },
      deviceAgent: {
        configured: true,
        runnable: true,
        provider: 'openai',
        model: 'gpt-5',
        logoHint: 'codex',
      },
    });

    expect(railIdentity(inventory, true)).toMatchObject({
      path: 'device-agent',
      pathLabel: 'Device Agent',
      provider: 'openai',
      model: 'gpt-5',
      detail: 'gpt-5 - Device Agent',
      statusLabel: 'confirmed',
      statusTone: 'confirmed',
      logoHint: 'codex',
    });
  });

  it('shows inactive configured AI path details when the selected path is not configured', () => {
    const inventory = buildAiSetupInventory({
      activeMode: 'hosted',
      hosted: {
        configured: false,
        runnable: false,
        provider: 'OpenAI',
        model: 'gpt-5',
        logoHint: 'codex',
      },
      session: { configured: false, runnable: false },
      bridge: { configured: false, runnable: false },
      deviceAgent: {
        configured: true,
        runnable: true,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        logoHint: 'claude',
      },
    });

    expect(railIdentity(inventory)).toMatchObject({
      path: 'device-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      detail: 'claude-sonnet-4-5 - Device Agent',
      inactive: true,
      statusLabel: 'configured inactive',
      statusTone: 'inactive',
      logoHint: 'claude',
    });
  });

  it('falls back to selected provider and model when no AI path is configured', () => {
    const inventory = buildAiSetupInventory({
      activeMode: 'bridge',
      hosted: { configured: false, runnable: false },
      session: { configured: false, runnable: false },
      bridge: { configured: false, runnable: false },
      deviceAgent: { configured: false, runnable: false },
    });

    expect(railIdentity(inventory)).toMatchObject({
      path: 'bridge',
      provider: 'OpenAI',
      model: 'gpt-5',
      detail: 'gpt-5 - Local Bridge',
      statusLabel: 'not configured',
      statusTone: 'optional',
      logoHint: 'codex',
    });
  });

  it('keeps the selected-provider logo when the active device-agent path is unconfigured', () => {
    const inventory = buildAiSetupInventory({
      activeMode: 'device-agent',
      hosted: { configured: false, runnable: false },
      session: { configured: false, runnable: false },
      bridge: { configured: false, runnable: false },
      deviceAgent: deviceAgentSetupSnapshot({ visible: true, status: null }),
    });

    expect(inventory.active.logoHint).toBe('agentic');

    expect(buildAiRailIdentity({
      inventory,
      pathLabels,
      activeFallback: {
        provider: 'Claude / Anthropic',
        model: 'claude-opus-4-1-20250805',
        logoHint: 'claude',
      },
      readinessLabel: 'Device Agent running',
      confirmationLabel: 'Runtime ready',
      confirmed: false,
    })).toMatchObject({
      provider: 'Claude / Anthropic',
      statusLabel: 'not configured',
      logoHint: 'claude',
    });
  });

  it('maps AI providers and connector labels to bundled logo hints', () => {
    expect(aiProviderLogoHint({ provider: 'openai', model: 'gpt-5' })).toBe('codex');
    expect(aiProviderLogoHint({ provider: 'anthropic', model: 'claude-sonnet-4-5' })).toBe('claude');
    expect(aiProviderLogoHint({ provider: 'gemini', model: 'gemini-2.5-pro' })).toBe('gemini');
    expect(aiProviderLogoHint({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })).toBe('agentRouter');
    expect(aiProviderLogoHint({ engine: 'connector', connector: 'claude' })).toBe('claude');
  });
});
