import { afterEach, describe, expect, it } from 'vitest';

import {
  callStreamingBridge,
  hasNativeStreamingBridge,
  nativeStreamingRuntime,
} from '../androidBridgeShim.js';

type StreamingWindow = typeof globalThis & {
  __agenticIosStreamingBridge?: {
    prepareSessionSigner?: (options?: { metadata?: Record<string, unknown> }) => Promise<unknown>;
    bindPreparedSession?: (options: { sessionId: string; signerId: string; metadata?: Record<string, unknown> }) => Promise<unknown>;
    signVoucher?: (options: { sessionId: string; voucherJson: string }) => Promise<unknown>;
  };
  AgenticAndroid?: {
    streamingRequest?: (requestId: string, method: string, payloadJson: string) => string | void;
  };
};

const originalWindow = (globalThis as unknown as { window?: unknown }).window;

function installWindow(): StreamingWindow {
  const win = globalThis as StreamingWindow;
  (globalThis as unknown as { window?: unknown }).window = win;
  return win;
}

afterEach(() => {
  const win = globalThis as StreamingWindow;
  delete win.__agenticIosStreamingBridge;
  delete win.AgenticAndroid;
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

describe('native streaming bridge routing', () => {
  it('detects the iOS Capacitor streaming bridge', () => {
    const win = installWindow();
    win.__agenticIosStreamingBridge = {
      signVoucher: async () => ({ signature: 'sig' }),
    };
    expect(hasNativeStreamingBridge()).toBe(true);
    expect(nativeStreamingRuntime()).toBe('ios-native');
  });

  it('adapts createSession with a prepared signer to iOS bindPreparedSession', async () => {
    const win = installWindow();
    const calls: unknown[] = [];
    win.__agenticIosStreamingBridge = {
      signVoucher: async () => ({ signature: 'sig' }),
      bindPreparedSession: async (options) => {
        calls.push(options);
        return { sessionId: options.sessionId, signerRuntime: 'ios-native' };
      },
    };
    const envelope = await callStreamingBridge('createSession', {
      sessionId: 'session-1',
      signerId: 'signer-1',
      tokenMint: 'USDC',
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe('ios_native');
    expect(calls).toEqual([
      {
        sessionId: 'session-1',
        signerId: 'signer-1',
        metadata: {
          sessionId: 'session-1',
          signerId: 'signer-1',
          tokenMint: 'USDC',
        },
      },
    ]);
  });

  it('serializes voucher objects for the iOS signer', async () => {
    const win = installWindow();
    const calls: unknown[] = [];
    win.__agenticIosStreamingBridge = {
      signVoucher: async (options) => {
        calls.push(options);
        return { signature: 'sig', signerRuntime: 'ios-native' };
      },
    };
    const envelope = await callStreamingBridge('signVoucher', {
      sessionId: 'session-1',
      voucher: { sessionId: 'session-1', amount: '1', recipient: 'recipient' },
    });
    expect(envelope.ok).toBe(true);
    expect(calls).toEqual([
      {
        sessionId: 'session-1',
        voucherJson: '{"sessionId":"session-1","amount":"1","recipient":"recipient"}',
      },
    ]);
  });
});
