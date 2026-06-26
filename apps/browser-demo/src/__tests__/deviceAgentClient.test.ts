import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEVICE_AGENT_MAX_PAYLOAD_CHARS,
  DEVICE_AGENT_MAX_SECURE_VALUE_CHARS,
  DEVICE_AGENT_REQUEST_ID_PATTERN,
  DeviceAgentClientError,
  __resetDeviceAgentClientForTests,
  deviceAgentRequest,
  deviceAgentRequestOrThrow,
  iosDeviceAgentRequestOrThrow,
  isDeviceAgentBridgeAvailable,
  isIosDeviceAgentBridgeAvailable,
  parseDeviceAgentResponseEnvelope,
  parseDeviceAgentStatus,
  type DeviceAgentResponseEnvelope,
} from '../deviceAgentClient.js';

interface BridgeStub {
  deviceAgentRequest: (requestId: string, method: string, payloadJson: string) => void;
  __resolve(requestId: string, payload: unknown): void;
  __reject(requestId: string, error: unknown): void;
  __captured: Array<{ requestId: string; method: string; payloadJson: string }>;
}

type AndroidGlobal = typeof globalThis & {
  AgenticAndroid?: {
    deviceAgentRequest?: (requestId: string, method: string, payloadJson: string) => void;
    isDebugBuild?: () => boolean;
  };
  __agenticIosDeviceAgentBridge?: {
    deviceAgentRequest?: (payload: {
      requestId: string;
      method: string;
      payloadJson: string;
      debugBaseUrl?: string;
    }) => Promise<unknown>;
    status?: () => Promise<unknown>;
    configure?: (payload?: Record<string, unknown>) => Promise<unknown>;
    start?: (payload?: Record<string, unknown>) => Promise<unknown>;
    stop?: () => Promise<unknown>;
    generatePlan?: (payload?: Record<string, unknown>) => Promise<unknown>;
    reviewPlan?: (payload?: Record<string, unknown>) => Promise<unknown>;
    ask?: (payload?: Record<string, unknown>) => Promise<unknown>;
  };
  __agenticAndroidDeviceAgentBridge?: {
    resolve: (requestId: string, payload: unknown) => void;
    reject: (requestId: string, error: unknown) => void;
  };
};

function installBridgeStub(autoResolve?: (requestId: string, method: string, payloadJson: string) => unknown): BridgeStub {
  const captured: BridgeStub['__captured'] = [];
  const stub: BridgeStub = {
    __captured: captured,
    deviceAgentRequest(requestId, method, payloadJson) {
      captured.push({ requestId, method, payloadJson });
      if (autoResolve) {
        const response = autoResolve(requestId, method, payloadJson);
        setTimeout(() => stub.__resolve(requestId, response), 0);
      }
    },
    __resolve(requestId, payload) {
      const win = globalThis as AndroidGlobal;
      win.__agenticAndroidDeviceAgentBridge?.resolve(requestId, payload);
    },
    __reject(requestId, error) {
      const win = globalThis as AndroidGlobal;
      win.__agenticAndroidDeviceAgentBridge?.reject(requestId, error);
    },
  };
  (globalThis as AndroidGlobal).AgenticAndroid = { deviceAgentRequest: stub.deviceAgentRequest };
  return stub;
}

function clearAndroidBridge(): void {
  delete (globalThis as AndroidGlobal).AgenticAndroid;
}

function clearIosBridge(): void {
  delete (globalThis as AndroidGlobal).__agenticIosDeviceAgentBridge;
}

type ConsoleMethod = 'info' | 'warn' | 'error' | 'log';

function captureConsole(methods: ConsoleMethod[]): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originals: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
  for (const method of methods) {
    originals[method] = console[method] as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]) => { lines.push(String(args[0])); };
  }
  return {
    lines,
    restore() {
      for (const method of methods) {
        const fn = originals[method];
        if (fn) console[method] = fn;
      }
    },
  };
}

const successStatus = {
  available: true,
  enabled: true,
  configured: true,
  state: 'running',
  runtime: 'android-native',
  provider: 'anthropic',
  apiFormat: 'anthropic',
  model: 'claude-sonnet-4-5',
};

describe('deviceAgentClient', () => {
  beforeEach(() => {
    __resetDeviceAgentClientForTests();
    clearAndroidBridge();
    clearIosBridge();
  });

  afterEach(() => {
    __resetDeviceAgentClientForTests();
    clearAndroidBridge();
    clearIosBridge();
  });

  describe('isDeviceAgentBridgeAvailable', () => {
    it('returns false when AgenticAndroid is missing', () => {
      expect(isDeviceAgentBridgeAvailable()).toBe(false);
    });

    it('returns false when AgenticAndroid lacks deviceAgentRequest', () => {
      (globalThis as AndroidGlobal).AgenticAndroid = {};
      expect(isDeviceAgentBridgeAvailable()).toBe(false);
    });

    it('returns true when the native bridge is installed', () => {
      installBridgeStub();
      expect(isDeviceAgentBridgeAvailable()).toBe(true);
    });
  });

  describe('iOS Device Agent bridge', () => {
    it('detects the Capacitor iOS bridge when all methods are installed', () => {
      expect(isIosDeviceAgentBridgeAvailable()).toBe(false);
      (globalThis as AndroidGlobal).__agenticIosDeviceAgentBridge = {
        status: async () => successStatus,
        configure: async () => successStatus,
        start: async () => successStatus,
        stop: async () => successStatus,
        generatePlan: async () => ({ text: '{"intent":"ok"}' }),
        reviewPlan: async () => ({ text: '{"decision":"approve","reason":"ok"}' }),
        ask: async () => ({ text: '{"answer":"ok"}' }),
      };
      expect(isIosDeviceAgentBridgeAvailable()).toBe(true);
    });

    it('detects the Capacitor iOS envelope bridge without direct LLM methods', () => {
      expect(isIosDeviceAgentBridgeAvailable()).toBe(false);
      (globalThis as AndroidGlobal).__agenticIosDeviceAgentBridge = {
        deviceAgentRequest: async () => ({
          ok: true,
          status: { ...successStatus, runtime: 'ios-native' },
        }),
      };
      expect(isIosDeviceAgentBridgeAvailable()).toBe(true);
    });

    it('sends iOS reviewPlan over the scalar payloadJson envelope and parses the result', async () => {
      let captured: {
        requestId: string;
        method: string;
        payloadJson: string;
        debugBaseUrl?: string;
      } | undefined;
      (globalThis as AndroidGlobal).__agenticIosDeviceAgentBridge = {
        deviceAgentRequest: async (payload) => {
          captured = payload;
          return {
            ok: true,
            status: { ...successStatus, runtime: 'ios-native', state: 'stopped' },
            result: {
              decision: 'approve',
              reason: 'ok',
              evidence: { checked: true },
            },
          };
        },
        reviewPlan: async () => {
          throw new Error('direct reviewPlan should not be used when deviceAgentRequest exists');
        },
      };

      const largeTransaction = 'A'.repeat(96_000);
      const { status, result } = await iosDeviceAgentRequestOrThrow<{
        decision: string;
        reason: string;
      }>('reviewPlan', {
        instruction: 'only approve if current facts pass',
        plan: { actionType: 'swap', route: 'SOL -> USDC' },
        context: {
          transactionBase64: largeTransaction,
          policyBundle: { hasBlockingFailure: false },
        },
      });

      expect(status.runtime).toBe('ios-native');
      expect(status.state).toBe('stopped');
      expect(result?.decision).toBe('approve');
      expect(captured?.requestId).toMatch(/^device-agent-/);
      expect(captured?.method).toBe('reviewPlan');
      expect(typeof captured?.payloadJson).toBe('string');
      const parsed = JSON.parse(captured!.payloadJson);
      expect(parsed.context.transactionBase64).toBe(largeTransaction);
      expect(parsed.__agenticRequestId).toBe(captured?.requestId);
      expect(parsed.__agenticPayloadChars).toEqual(expect.any(Number));
    });

    it('throws a DeviceAgentClientError from iOS envelope failures with status attached', async () => {
      (globalThis as AndroidGlobal).__agenticIosDeviceAgentBridge = {
        deviceAgentRequest: async () => ({
          ok: false,
          status: { ...successStatus, runtime: 'ios-native', state: 'error' },
          error: {
            code: 'provider_auth',
            subcode: 'invalid_key',
            message: 'Bad key.',
          },
        }),
      };

      await expect(iosDeviceAgentRequestOrThrow('reviewPlan', {
        instruction: 'review',
        plan: { actionType: 'swap' },
      })).rejects.toMatchObject({
        code: 'provider_auth',
        subcode: 'invalid_key',
        status: {
          runtime: 'ios-native',
          state: 'error',
        },
      });
    });

    it('wraps iOS native model text as output_text and returns ios-native status', async () => {
      let capturedPayload: Record<string, unknown> | undefined;
      (globalThis as AndroidGlobal).__agenticIosDeviceAgentBridge = {
        status: async () => ({ ...successStatus, runtime: 'ios-native', checkedAt: 1_700_000_000_000 }),
        configure: async () => successStatus,
        start: async () => successStatus,
        stop: async () => successStatus,
        generatePlan: async (payload) => {
          capturedPayload = payload;
          return { provider: 'gemini', text: JSON.stringify({ intent: payload?.prompt }) };
        },
        reviewPlan: async () => ({ text: '{"decision":"approve","reason":"ok"}' }),
        ask: async () => ({ text: '{"answer":"ok"}' }),
      };
      const { status, result } = await iosDeviceAgentRequestOrThrow<{ output_text?: string }>('generatePlan', { prompt: 'swap' });
      expect(status.runtime).toBe('ios-native');
      expect(status.checkedAt).toBe('2023-11-14T22:13:20.000Z');
      expect(result?.output_text).toBe('{"intent":"swap"}');
      expect(capturedPayload?.__agenticRequestId).toMatch(/^device-agent-/);
      expect(capturedPayload?.__agenticPayloadChars).toEqual(expect.any(Number));
    });

    it('times out unresolved iOS native requests with a deterministic client error', async () => {
      (globalThis as AndroidGlobal).__agenticIosDeviceAgentBridge = {
        status: async () => ({ ...successStatus, runtime: 'ios-native' }),
        configure: async () => successStatus,
        start: async () => successStatus,
        stop: async () => successStatus,
        generatePlan: async () => new Promise(() => undefined),
        reviewPlan: async () => ({ text: '{"decision":"approve","reason":"ok"}' }),
        ask: async () => ({ text: '{"answer":"ok"}' }),
      };
      await expect(iosDeviceAgentRequestOrThrow('generatePlan', { prompt: 'swap' }, { timeoutMs: 1 }))
        .rejects
        .toMatchObject({ code: 'request_timeout' });
    });
  });

  describe('deviceAgentRequest', () => {
    it('rejects with bridge_unavailable when no Android bridge is present', async () => {
      await expect(deviceAgentRequest('status')).rejects.toMatchObject({
        name: 'DeviceAgentClientError',
        code: 'bridge_unavailable',
      });
    });

    it('forwards method and payload to AgenticAndroid.deviceAgentRequest', async () => {
      const stub = installBridgeStub((id) => ({ ok: true, status: successStatus, result: { received: id } }));
      await deviceAgentRequest('generatePlan', { prompt: 'transfer 0.01 SOL' });
      expect(stub.__captured).toHaveLength(1);
      const recorded = stub.__captured[0]!;
      expect(recorded.method).toBe('generatePlan');
      expect(JSON.parse(recorded.payloadJson)).toEqual({ prompt: 'transfer 0.01 SOL' });
      expect(recorded.requestId).toMatch(/^device-agent-/);
    });

    it('round-trips a stop request with an empty payload and a stopped status envelope', async () => {
      const stoppedStatus = { ...successStatus, state: 'stopped' as const };
      const stub = installBridgeStub(() => ({ ok: true, status: stoppedStatus }));
      const envelope = await deviceAgentRequest('stop', {});
      expect(stub.__captured).toHaveLength(1);
      const recorded = stub.__captured[0]!;
      expect(recorded.method).toBe('stop');
      expect(JSON.parse(recorded.payloadJson)).toEqual({});
      expect(envelope.ok).toBe(true);
      if (envelope.ok) {
        expect(envelope.status.state).toBe('stopped');
      }
    });

    it('resolves with the success envelope when the bridge resolves', async () => {
      installBridgeStub((id) => ({ ok: true, status: successStatus, result: { plan: id } }));
      const envelope = await deviceAgentRequest<{ plan: string }>('generatePlan', {});
      expect(envelope.ok).toBe(true);
      if (envelope.ok) {
        expect(envelope.result?.plan).toMatch(/^device-agent-/);
        expect(envelope.status.runtime).toBe('android-native');
      }
    });

    it('resolves with the failure envelope when the bridge returns ok:false', async () => {
      installBridgeStub((_id) => ({
        ok: false,
        status: { ...successStatus, state: 'error' },
        error: { code: 'provider_auth', message: 'Bad key.' },
      }));
      const envelope = await deviceAgentRequest('generatePlan', {});
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error.code).toBe('provider_auth');
        expect(envelope.error.message).toBe('Bad key.');
        expect(envelope.status.state).toBe('error');
      }
    });

    it('rejects with bridge_error when the bridge calls reject', async () => {
      const stub = installBridgeStub();
      const promise = deviceAgentRequest('status').catch((err) => err);
      await Promise.resolve();
      const captured = stub.__captured[0]!;
      stub.__reject(captured.requestId, { code: 'native_failure', message: 'Bridge crashed.' });
      const err = await promise;
      expect(err).toBeInstanceOf(DeviceAgentClientError);
      expect((err as DeviceAgentClientError).code).toBe('native_failure');
      expect((err as DeviceAgentClientError).message).toBe('Bridge crashed.');
    });

    it('preserves status when the bridge rejects with a failure envelope', async () => {
      const stub = installBridgeStub();
      const promise = deviceAgentRequest('generatePlan').catch((err) => err);
      await Promise.resolve();
      const captured = stub.__captured[0]!;
      stub.__reject(captured.requestId, {
        ok: false,
        status: { ...successStatus, state: 'running' },
        error: { code: 'provider_auth', message: 'Bad key.' },
      });
      const err = await promise;
      expect(err).toBeInstanceOf(DeviceAgentClientError);
      expect((err as DeviceAgentClientError).code).toBe('provider_auth');
      expect((err as DeviceAgentClientError).status?.runtime).toBe('android-native');
    });

    it('rejects with request_timeout when the bridge never responds', async () => {
      installBridgeStub();
      await expect(deviceAgentRequest('status', {}, { timeoutMs: 5 })).rejects.toMatchObject({
        name: 'DeviceAgentClientError',
        code: 'request_timeout',
      });
    });

    it('rejects pending requests when an AbortSignal is aborted mid-flight', async () => {
      installBridgeStub();
      const controller = new AbortController();
      const promise = deviceAgentRequest('status', {}, { signal: controller.signal });
      controller.abort();
      await expect(promise).rejects.toMatchObject({
        name: 'DeviceAgentClientError',
        code: 'aborted',
      });
    });

    it('rejects immediately when the signal is already aborted before issuing the request', async () => {
      installBridgeStub();
      const controller = new AbortController();
      controller.abort();
      await expect(deviceAgentRequest('status', {}, { signal: controller.signal })).rejects.toMatchObject({
        code: 'aborted',
      });
    });

    it('uses unique request IDs for concurrent calls', async () => {
      const stub = installBridgeStub();
      void deviceAgentRequest('status').catch(() => {});
      void deviceAgentRequest('status').catch(() => {});
      await Promise.resolve();
      expect(stub.__captured).toHaveLength(2);
      expect(stub.__captured[0]!.requestId).not.toBe(stub.__captured[1]!.requestId);
    });

    it('rejects with invalid_response when the bridge returns an unparseable payload', async () => {
      const stub = installBridgeStub();
      const promise = deviceAgentRequest('status').catch((err) => err);
      await Promise.resolve();
      const captured = stub.__captured[0]!;
      stub.__resolve(captured.requestId, 'not-a-json-object');
      const err = await promise;
      expect(err).toBeInstanceOf(DeviceAgentClientError);
      expect((err as DeviceAgentClientError).code).toBe('invalid_response');
    });
  });

  describe('deviceAgentRequestOrThrow', () => {
    it('returns the result on success envelopes', async () => {
      installBridgeStub(() => ({ ok: true, status: successStatus, result: { hello: 'world' } }));
      const { status, result } = await deviceAgentRequestOrThrow<{ hello: string }>('generatePlan', {});
      expect(status.state).toBe('running');
      expect(result?.hello).toBe('world');
    });

    it('throws DeviceAgentClientError on failure envelopes and attaches the parsed status', async () => {
      installBridgeStub(() => ({
        ok: false,
        status: { ...successStatus, state: 'error', configured: true },
        error: { code: 'provider_rate_limited', message: 'Slow down.' },
      }));
      let caught: unknown;
      try {
        await deviceAgentRequestOrThrow('generatePlan', {});
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DeviceAgentClientError);
      const error = caught as DeviceAgentClientError;
      expect(error.code).toBe('provider_rate_limited');
      expect(error.status?.state).toBe('error');
    });
  });

  describe('parseDeviceAgentStatus', () => {
    it('normalizes a valid status payload', () => {
      const status = parseDeviceAgentStatus({
        available: true,
        enabled: true,
        configured: true,
        state: 'running',
        runtime: 'android-native',
        provider: '  anthropic  ',
        apiFormat: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        model: '  claude-sonnet-4-5  ',
        walletAddress: '7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w',
        message: 'ready',
        checkedAt: '2026-05-15T12:00:00.000Z',
        updatedAt: '2026-05-15T12:01:00.000Z',
      });
      expect(status).toMatchObject({
        available: true,
        enabled: true,
        configured: true,
        state: 'running',
        runtime: 'android-native',
        provider: 'anthropic',
        apiFormat: 'anthropic',
        model: 'claude-sonnet-4-5',
        checkedAt: '2026-05-15T12:00:00.000Z',
        updatedAt: '2026-05-15T12:01:00.000Z',
      });
    });

    it('canonicalizes legacy openai apiFormat and legacy transition timestamp', () => {
      const status = parseDeviceAgentStatus({
        available: true,
        enabled: true,
        configured: true,
        state: 'running',
        runtime: 'android-native',
        apiFormat: 'openai',
        lastTransitionAt: '2026-05-15T12:03:00.000Z',
      });

      expect(status.apiFormat).toBe('openai-compatible');
      expect(status.updatedAt).toBe('2026-05-15T12:03:00.000Z');
    });

    it('falls back to browser-dev runtime for unknown runtime values', () => {
      const status = parseDeviceAgentStatus({ available: false, runtime: 'mystery' });
      expect(status.runtime).toBe('browser-dev');
      expect(status.state).toBe('unavailable');
    });

    it('returns an unavailable status for non-object payloads', () => {
      const status = parseDeviceAgentStatus('not-json');
      expect(status.available).toBe(false);
      expect(status.state).toBe('unavailable');
      expect(status.runtime).toBe('browser-dev');
    });

    it('parses status payloads delivered as JSON strings', () => {
      const status = parseDeviceAgentStatus(JSON.stringify({
        available: true,
        enabled: true,
        configured: false,
        state: 'stopped',
        runtime: 'render-gated',
      }));
      expect(status).toMatchObject({ configured: false, state: 'stopped', runtime: 'render-gated' });
    });

    it('passes through the richer native chat capabilities', () => {
      const status = parseDeviceAgentStatus({
        available: true,
        state: 'running',
        runtime: 'android-native',
        capabilities: {
          chatComplete: true,
          chatCompleteGeneric: true,
          chatCompleteStream: false,
          version: '1',
          supportedTransports: ['openai-compatible', 'anthropic-messages', 'gemini-native'],
        },
      });
      expect(status.capabilities).toEqual({
        chatComplete: true,
        chatCompleteGeneric: true,
        version: '1',
        supportedTransports: ['openai-compatible', 'anthropic-messages', 'gemini-native'],
      });
    });

    it('omits the capabilities object entirely for an old binary that sends none', () => {
      const status = parseDeviceAgentStatus({ available: true, state: 'running', runtime: 'android-native' });
      expect(status.capabilities).toBeUndefined();
    });

    it('preserves a well-formed lastError object on the status', () => {
      const status = parseDeviceAgentStatus({
        available: true,
        state: 'error',
        runtime: 'android-native',
        lastError: {
          code: 'provider_invalid_response',
          message: 'bad json from upstream',
          subcode: 'json_parse',
        },
      });
      expect(status.lastError).toEqual({
        code: 'provider_invalid_response',
        message: 'bad json from upstream',
        subcode: 'json_parse',
      });
    });

    it('treats lastError: null as an explicit clear (preserved on the status)', () => {
      const status = parseDeviceAgentStatus({
        available: true,
        state: 'running',
        runtime: 'android-native',
        lastError: null,
      });
      expect(status.lastError).toBeNull();
    });

    it('omits lastError when the payload is malformed (missing code or message)', () => {
      const missingMessage = parseDeviceAgentStatus({
        available: true,
        state: 'error',
        runtime: 'android-native',
        lastError: { code: 'provider_auth' },
      });
      expect(missingMessage.lastError).toBeUndefined();

      const missingCode = parseDeviceAgentStatus({
        available: true,
        state: 'error',
        runtime: 'android-native',
        lastError: { message: 'no code' },
      });
      expect(missingCode.lastError).toBeUndefined();
    });
  });

  describe('parseDeviceAgentResponseEnvelope', () => {
    it('parses success envelopes including the result field', () => {
      const envelope = parseDeviceAgentResponseEnvelope<{ plan: number }>({
        ok: true,
        status: { available: true, enabled: true, configured: true, state: 'running', runtime: 'android-native' },
        result: { plan: 42 },
      });
      expect(envelope.ok).toBe(true);
      if (envelope.ok) {
        expect(envelope.result?.plan).toBe(42);
      }
    });

    it('parses failure envelopes and normalizes missing error codes', () => {
      const envelope = parseDeviceAgentResponseEnvelope({
        ok: false,
        status: { available: false, state: 'error', runtime: 'android-native' },
        error: { message: 'something broke' },
      });
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error.code).toBe('unknown_error');
        expect(envelope.error.message).toBe('something broke');
      }
    });

    it('preserves the optional error subcode when present', () => {
      const envelope = parseDeviceAgentResponseEnvelope({
        ok: false,
        status: { available: true, state: 'error', runtime: 'android-native' },
        error: { code: 'provider_invalid_response', message: 'bad json', subcode: 'json_parse' },
      });
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error.subcode).toBe('json_parse');
      }
    });

    it('uses the defaultRuntime hint when the envelope status is missing a runtime', () => {
      const envelope = parseDeviceAgentResponseEnvelope({
        ok: true,
        status: { available: true, state: 'running' },
        result: { ok: 1 },
      }, 'render-gated');
      expect(envelope.ok).toBe(true);
      if (envelope.ok) {
        expect(envelope.status.runtime).toBe('render-gated');
      }
    });

    it('throws DeviceAgentClientError on non-object payloads', () => {
      expect(() => parseDeviceAgentResponseEnvelope(7)).toThrow(DeviceAgentClientError);
    });
  });

  describe('contract constants', () => {
    it('exports the Phase 2 request-ID regex literal', () => {
      expect(DEVICE_AGENT_REQUEST_ID_PATTERN.source).toBe('^[A-Za-z0-9_.:-]{1,160}$');
    });

    it('exports the Phase 2 payload size limits', () => {
      expect(DEVICE_AGENT_MAX_SECURE_VALUE_CHARS).toBe(8192);
      expect(DEVICE_AGENT_MAX_PAYLOAD_CHARS).toBe(2_000_000);
    });

    it('generates request IDs that match the contract pattern', async () => {
      const stub = installBridgeStub();
      for (let i = 0; i < 8; i += 1) {
        void deviceAgentRequest('status').catch(() => {});
      }
      await Promise.resolve();
      for (const captured of stub.__captured) {
        expect(captured.requestId).toMatch(DEVICE_AGENT_REQUEST_ID_PATTERN);
      }
    });
  });

  describe('eager bridge install', () => {
    it('installs the JS callback bridge immediately on module load', () => {
      const win = globalThis as AndroidGlobal;
      expect(typeof win.__agenticAndroidDeviceAgentBridge?.resolve).toBe('function');
      expect(typeof win.__agenticAndroidDeviceAgentBridge?.reject).toBe('function');
    });

    it('reinstalls the bridge after a reset', () => {
      __resetDeviceAgentClientForTests();
      const win = globalThis as AndroidGlobal;
      expect(typeof win.__agenticAndroidDeviceAgentBridge?.resolve).toBe('function');
      expect(typeof win.__agenticAndroidDeviceAgentBridge?.reject).toBe('function');
    });
  });

  describe('reject envelope fallbacks', () => {
    it('falls back to bare { code, message } when no envelope wrapper is present', async () => {
      const stub = installBridgeStub();
      const promise = deviceAgentRequest('status').catch((err) => err);
      await Promise.resolve();
      const captured = stub.__captured[0]!;
      stub.__reject(captured.requestId, { code: 'legacy_failure', message: 'old-style payload' });
      const err = await promise;
      expect(err).toBeInstanceOf(DeviceAgentClientError);
      expect((err as DeviceAgentClientError).code).toBe('legacy_failure');
    });

    it('reads nested error.code when payload wraps without an ok flag', async () => {
      const stub = installBridgeStub();
      const promise = deviceAgentRequest('status').catch((err) => err);
      await Promise.resolve();
      const captured = stub.__captured[0]!;
      stub.__reject(captured.requestId, {
        error: { code: 'wrapped_failure', message: 'half-envelope' },
      });
      const err = await promise;
      expect(err).toBeInstanceOf(DeviceAgentClientError);
      expect((err as DeviceAgentClientError).code).toBe('wrapped_failure');
    });

    it('parses JSON-string failure envelopes delivered by reject', async () => {
      const stub = installBridgeStub();
      const promise = deviceAgentRequest('generatePlan').catch((err) => err);
      await Promise.resolve();
      const captured = stub.__captured[0]!;
      stub.__reject(captured.requestId, JSON.stringify({
        ok: false,
        status: { available: true, state: 'error', runtime: 'android-native' },
        error: { code: 'provider_auth', message: 'Bad key.' },
      }));
      const err = await promise;
      expect(err).toBeInstanceOf(DeviceAgentClientError);
      expect((err as DeviceAgentClientError).code).toBe('provider_auth');
      expect((err as DeviceAgentClientError).status?.runtime).toBe('android-native');
    });

    it('falls back to bridge_error on malformed reject payloads', async () => {
      const stub = installBridgeStub();
      const promise = deviceAgentRequest('status').catch((err) => err);
      await Promise.resolve();
      const captured = stub.__captured[0]!;
      stub.__reject(captured.requestId, null);
      const err = await promise;
      expect(err).toBeInstanceOf(DeviceAgentClientError);
      expect((err as DeviceAgentClientError).code).toBe('bridge_error');
    });

    it('preserves error.subcode from a full reject envelope', async () => {
      const stub = installBridgeStub();
      const promise = deviceAgentRequest('generatePlan').catch((err) => err);
      await Promise.resolve();
      const captured = stub.__captured[0]!;
      stub.__reject(captured.requestId, {
        ok: false,
        status: { ...successStatus, state: 'error' },
        error: {
          code: 'provider_invalid_response',
          message: 'bad json',
          subcode: 'json_parse',
        },
      });
      const err = await promise;
      expect(err).toBeInstanceOf(DeviceAgentClientError);
      expect((err as DeviceAgentClientError).code).toBe('provider_invalid_response');
      expect((err as DeviceAgentClientError).subcode).toBe('json_parse');
    });

    it('preserves subcode from bare legacy reject payloads', async () => {
      const stub = installBridgeStub();
      const promise = deviceAgentRequest('status').catch((err) => err);
      await Promise.resolve();
      const captured = stub.__captured[0]!;
      stub.__reject(captured.requestId, { code: 'legacy', message: 'x', subcode: 'shim' });
      const err = await promise;
      expect(err).toBeInstanceOf(DeviceAgentClientError);
      expect((err as DeviceAgentClientError).subcode).toBe('shim');
    });
  });

  describe('deviceAgentRequestOrThrow subcode propagation', () => {
    it('attaches the envelope.error.subcode to the thrown DeviceAgentClientError', async () => {
      installBridgeStub(() => ({
        ok: false,
        status: { ...successStatus, state: 'error' },
        error: {
          code: 'provider_invalid_response',
          message: 'bad json',
          subcode: 'json_parse',
        },
      }));
      let caught: DeviceAgentClientError | undefined;
      try {
        await deviceAgentRequestOrThrow('generatePlan', {});
      } catch (err) {
        caught = err as DeviceAgentClientError;
      }
      expect(caught).toBeInstanceOf(DeviceAgentClientError);
      expect(caught?.code).toBe('provider_invalid_response');
      expect(caught?.subcode).toBe('json_parse');
    });

    it('leaves subcode undefined when the envelope error omits it', async () => {
      installBridgeStub(() => ({
        ok: false,
        status: { ...successStatus, state: 'error' },
        error: { code: 'provider_auth', message: 'Bad key.' },
      }));
      let caught: DeviceAgentClientError | undefined;
      try {
        await deviceAgentRequestOrThrow('generatePlan', {});
      } catch (err) {
        caught = err as DeviceAgentClientError;
      }
      expect(caught?.subcode).toBeUndefined();
    });
  });

  describe('payload size preflight', () => {
    it('rejects configure payloads larger than MAX_SECURE_VALUE_CHARS', async () => {
      installBridgeStub();
      const apiKey = 'k'.repeat(DEVICE_AGENT_MAX_SECURE_VALUE_CHARS + 100);
      await expect(deviceAgentRequest('configure', { apiKey })).rejects.toMatchObject({
        name: 'DeviceAgentClientError',
        code: 'payload_too_large',
      });
    });

    it('rejects start payloads larger than MAX_SECURE_VALUE_CHARS', async () => {
      installBridgeStub();
      const big = { blob: 'k'.repeat(DEVICE_AGENT_MAX_SECURE_VALUE_CHARS + 50) };
      await expect(deviceAgentRequest('start', big)).rejects.toMatchObject({
        code: 'payload_too_large',
      });
    });

    it('rejects generatePlan payloads larger than MAX_PAYLOAD_CHARS', async () => {
      installBridgeStub();
      const big = { blob: 'x'.repeat(DEVICE_AGENT_MAX_PAYLOAD_CHARS + 16) };
      await expect(deviceAgentRequest('generatePlan', big)).rejects.toMatchObject({
        code: 'payload_too_large',
      });
    });

    it('accepts configure payloads at or below the secure-value limit', async () => {
      installBridgeStub((id) => ({ ok: true, status: { ...successStatus }, result: { id } }));
      // Stay well under 8192 chars after JSON.stringify overhead.
      const ok = { apiKey: 'k'.repeat(1024), model: 'gpt-5' };
      await expect(deviceAgentRequest('configure', ok)).resolves.toBeDefined();
    });

    it('accepts generatePlan payloads under the payload-cap limit', async () => {
      installBridgeStub((id) => ({ ok: true, status: { ...successStatus }, result: { id } }));
      const ok = { prompt: 'p'.repeat(50_000) };
      await expect(deviceAgentRequest('generatePlan', ok)).resolves.toBeDefined();
    });
  });

  describe('parseDeviceAgentStatus defaultRuntime', () => {
    it('uses the explicit defaultRuntime when payload omits the runtime field', () => {
      const status = parseDeviceAgentStatus({ available: true }, 'android-native');
      expect(status.runtime).toBe('android-native');
    });

    it('passes through a valid runtime regardless of the defaultRuntime hint', () => {
      const status = parseDeviceAgentStatus({ runtime: 'render-gated' }, 'android-native');
      expect(status.runtime).toBe('render-gated');
    });

    it('defaults to browser-dev when neither payload nor hint specify a runtime', () => {
      const status = parseDeviceAgentStatus({ available: false });
      expect(status.runtime).toBe('browser-dev');
    });
  });

  describe('logDeviceAgent telemetry', () => {
    it('emits START + SUCCESS info lines when the bridge reports debug enabled', async () => {
      const stub = installBridgeStub((id) => ({ ok: true, status: { ...successStatus }, result: { id } }));
      (globalThis as AndroidGlobal).AgenticAndroid = {
        deviceAgentRequest: stub.deviceAgentRequest,
        isDebugBuild: () => true,
      };
      const captured = captureConsole(['info']);
      try {
        await deviceAgentRequest('generatePlan', { prompt: 'hi' });
      } finally {
        captured.restore();
      }
      expect(captured.lines.some((line) => line.startsWith('[AgentDeviceAgent] request | START'))).toBe(true);
      expect(captured.lines.some((line) => line.includes('| SUCCESS') && line.includes('statusState=running'))).toBe(true);
    });

    it('suppresses telemetry when isDebugBuild returns false', async () => {
      const stub = installBridgeStub((id) => ({ ok: true, status: { ...successStatus }, result: { id } }));
      (globalThis as AndroidGlobal).AgenticAndroid = {
        deviceAgentRequest: stub.deviceAgentRequest,
        isDebugBuild: () => false,
      };
      const captured = captureConsole(['info', 'warn']);
      try {
        await deviceAgentRequest('generatePlan', { prompt: 'hi' });
      } finally {
        captured.restore();
      }
      const deviceAgentLines = captured.lines.filter((line) => line.startsWith('[AgentDeviceAgent]'));
      expect(deviceAgentLines).toHaveLength(0);
    });

    it('redacts apiKey from configure payload previews in debug builds', async () => {
      const stub = installBridgeStub((id) => ({ ok: true, status: { ...successStatus }, result: { id } }));
      (globalThis as AndroidGlobal).AgenticAndroid = {
        deviceAgentRequest: stub.deviceAgentRequest,
        isDebugBuild: () => true,
      };
      const captured = captureConsole(['info']);
      try {
        await deviceAgentRequest('configure', { apiKey: 'sk-test-secret-123', model: 'gpt-5' });
      } finally {
        captured.restore();
      }
      const startLine = captured.lines.find((line) => line.startsWith('[AgentDeviceAgent] request | START')) ?? '';
      expect(startLine).not.toContain('sk-test-secret-123');
      expect(startLine).toContain('[redacted]');
    });

    it('redacts LLM-bound iOS payload previews in debug builds', async () => {
      (globalThis as AndroidGlobal).__agenticIosDeviceAgentBridge = {
        status: async () => ({ ...successStatus, runtime: 'ios-native' }),
        configure: async () => successStatus,
        start: async () => successStatus,
        stop: async () => successStatus,
        generatePlan: async () => ({ intent: 'ok' }),
        reviewPlan: async () => ({
          decision: 'approve',
          reason: 'ok',
          summary: 'ok',
          evidence: {},
        }),
        ask: async () => ({ output_text: 'ok' }),
      };
      const captured = captureConsole(['info']);
      try {
        await iosDeviceAgentRequestOrThrow('reviewPlan', {
          instruction: 'only approve if the private note is true',
          apiKey: 'sk-test-secret-456',
          plan: { actionType: 'swap', route: 'Jupiter private route' },
          context: {
            transactionBase64: 'base64-transaction-secret',
            policyBundle: { hasBlockingFailure: false },
          },
        });
      } finally {
        captured.restore();
      }
      const startLine = captured.lines.find((line) => line.startsWith('[AgentDeviceAgent] ios-request | START')) ?? '';
      expect(startLine).toContain('hasInstruction');
      expect(startLine).toContain('hasTransactionBase64');
      expect(startLine).toContain('actionType');
      expect(startLine).not.toContain('private note');
      expect(startLine).not.toContain('Jupiter private route');
      expect(startLine).not.toContain('base64-transaction-secret');
      expect(startLine).not.toContain('sk-test-secret-456');
    });

    it('emits a FAIL warn line for payload_too_large preflight in debug builds', async () => {
      const stub = installBridgeStub();
      (globalThis as AndroidGlobal).AgenticAndroid = {
        deviceAgentRequest: stub.deviceAgentRequest,
        isDebugBuild: () => true,
      };
      const captured = captureConsole(['warn']);
      try {
        await deviceAgentRequest('configure', {
          apiKey: 'k'.repeat(DEVICE_AGENT_MAX_SECURE_VALUE_CHARS + 100),
        }).catch(() => {});
      } finally {
        captured.restore();
      }
      const failLine = captured.lines.find((line) =>
        line.startsWith('[AgentDeviceAgent] request | FAIL')
        && line.includes('code=payload_too_large'),
      ) ?? '';
      expect(failLine).toContain('payloadChars=');
      expect(failLine).toContain('limit=8192');
      // Should not leak any payload content (no apiKey value, no payload= field).
      expect(failLine).not.toContain('payload=');
    });

    it('emits a FAIL warn line when reject envelopes arrive in debug builds', async () => {
      const stub = installBridgeStub();
      (globalThis as AndroidGlobal).AgenticAndroid = {
        deviceAgentRequest: stub.deviceAgentRequest,
        isDebugBuild: () => true,
      };
      const captured = captureConsole(['warn']);
      try {
        const promise = deviceAgentRequest('status').catch(() => {});
        await Promise.resolve();
        const recorded = stub.__captured[0]!;
        stub.__reject(recorded.requestId, {
          ok: false,
          status: { ...successStatus, state: 'error' },
          error: { code: 'provider_rate_limited', message: 'slow down' },
        });
        await promise;
      } finally {
        captured.restore();
      }
      expect(captured.lines.some((line) =>
        line.startsWith('[AgentDeviceAgent] request | FAIL')
        && line.includes('code=provider_rate_limited'),
      )).toBe(true);
    });
  });
});

// Compile-time guard: the envelope type narrows on `ok`.
function _typeGuards(envelope: DeviceAgentResponseEnvelope<{ plan: string }>) {
  if (envelope.ok) {
    return envelope.result?.plan ?? '';
  }
  return envelope.error.code;
}
void _typeGuards;
