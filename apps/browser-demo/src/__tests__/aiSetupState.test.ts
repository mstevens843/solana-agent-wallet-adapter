import { describe, expect, it } from 'vitest';

import {
  bridgeAiSetupSnapshot,
  buildAiSetupInventory,
  deviceAgentSetupSnapshot,
  directAiKeyStaged,
} from '../aiSetupState.js';

describe('AI setup state helpers', () => {
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
});
