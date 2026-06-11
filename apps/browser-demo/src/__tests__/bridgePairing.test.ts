import { describe, expect, it, vi } from 'vitest';

import {
  parsePairingPayload,
  pairTag,
  startDesktopPairing,
  pollDesktopPairStatus,
  startPhonePairing,
  readPhonePairStatus,
  phonePairingEnabled,
  unpairPhone,
  pairedBridgeDeviceAgentConfig,
  type NativePairBridge,
  type BridgeRequestFn,
} from '../bridgePairing.js';

describe('parsePairingPayload', () => {
  it('parses a well-formed QR payload', () => {
    const payload = parsePairingPayload(JSON.stringify({ v: 1, relay: 'https://agentic-signer.com', uuid: 'u-1', token: 't-1' }));
    expect(payload).toEqual({ relay: 'https://agentic-signer.com', uuid: 'u-1', token: 't-1' });
  });

  it('rejects missing fields, bad JSON, and empty input', () => {
    expect(parsePairingPayload(JSON.stringify({ relay: 'x', uuid: 'y' }))).toBeNull();
    expect(parsePairingPayload('not json')).toBeNull();
    expect(parsePairingPayload('')).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ relay: '', uuid: 'y', token: 'z' }))).toBeNull();
  });
});

describe('pairTag', () => {
  it('is deterministic and 8 hex chars', async () => {
    const a = await pairTag('01234567-89ab-4def-8123-456789abcdef');
    const b = await pairTag('01234567-89ab-4def-8123-456789abcdef');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('desktop pairing', () => {
  it('startDesktopPairing returns the bridge state', async () => {
    const state = { active: true, paired: false, pairUuid: 'uuid-1', relayBaseUrl: 'https://agentic-signer.com', qrPayload: '{"v":1}', startedAt: 1 };
    const bridgeRequest = vi.fn(async () => state) as unknown as BridgeRequestFn;
    const result = await startDesktopPairing(bridgeRequest);
    expect(bridgeRequest).toHaveBeenCalledWith('/bridge/pair/start', { method: 'POST' });
    expect(result.qrPayload).toBe('{"v":1}');
  });

  it('pollDesktopPairStatus reads /bridge/pair/status', async () => {
    const bridgeRequest = vi.fn(async () => ({ active: true, paired: true, pairUuid: 'uuid-1', relayBaseUrl: 'r', qrPayload: null, startedAt: 1 })) as unknown as BridgeRequestFn;
    const result = await pollDesktopPairStatus(bridgeRequest);
    expect(bridgeRequest).toHaveBeenCalledWith('/bridge/pair/status', { method: 'GET' });
    expect(result.paired).toBe(true);
  });
});

describe('phone pairing', () => {
  const payload = { relay: 'https://agentic-signer.com', uuid: 'uuid-1', token: 'token-1' };

  it('reports enabled from the native flag', () => {
    expect(phonePairingEnabled({ bridgePairEnabled: () => true })).toBe(true);
    expect(phonePairingEnabled({ bridgePairEnabled: () => false })).toBe(false);
    expect(phonePairingEnabled(undefined)).toBe(false);
  });

  it('startPhonePairing forwards the payload to native and returns ok', async () => {
    const bridgePair = vi.fn((_json: string) => JSON.stringify({ ok: true, status: 'pairing' }));
    const bridge: NativePairBridge = { bridgePair };
    const result = await startPhonePairing(bridge, payload);
    expect(result.ok).toBe(true);
    expect(JSON.parse(bridgePair.mock.calls[0]![0])).toEqual(payload);
  });

  it('startPhonePairing surfaces a missing bridge and native throws', async () => {
    expect((await startPhonePairing(undefined, payload)).error).toBe('bridge_unavailable');
    const throwing: NativePairBridge = { bridgePair: () => { throw new Error('boom'); } };
    expect((await startPhonePairing(throwing, payload)).error).toBe('native_threw');
  });

  it('startPhonePairing returns the native error envelope', async () => {
    const bridge: NativePairBridge = { bridgePair: () => JSON.stringify({ ok: false, error: 'relay_not_allowed' }) };
    const result = await startPhonePairing(bridge, payload);
    expect(result).toEqual({ ok: false, error: 'relay_not_allowed' });
  });

  it('readPhonePairStatus normalizes the native status', () => {
    const bridge: NativePairBridge = { bridgePairStatus: () => JSON.stringify({ paired: true, pairing: false, enabled: true, error: null }) };
    expect(readPhonePairStatus(bridge)).toEqual({ paired: true, pairing: false, enabled: true, error: null });
    expect(readPhonePairStatus(undefined)).toEqual({ paired: false, pairing: false, enabled: false, error: null });
  });

  it('unpairPhone calls native and reports success', () => {
    const bridgeUnpair = vi.fn(() => '{"ok":true}');
    expect(unpairPhone({ bridgeUnpair })).toBe(true);
    expect(bridgeUnpair).toHaveBeenCalled();
    expect(unpairPhone(undefined)).toBe(false);
  });
});

describe('pairedBridgeDeviceAgentConfig', () => {
  it('produces a paired-bridge device-agent config', () => {
    expect(JSON.parse(pairedBridgeDeviceAgentConfig())).toEqual({ provider: 'paired-bridge', apiFormat: 'paired-bridge', model: 'connector' });
  });
});
