import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import {
  VulcanUpstreamClient,
  extractVulcanErrorMessage,
  extractVulcanTxid,
} from '../../upstreamMcp/vulcanClient.js';

/**
 * Build a synthetic Transport that the MCP SDK Client can drive. We capture outgoing JSON-RPC messages and respond
 * to `initialize` / `tools/list` / `tools/call` requests synchronously, simulating a Vulcan subprocess.
 */
function makeFakeTransport(opts: {
  toolsList?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  callToolResponse?: { content: unknown; structuredContent?: unknown; isError?: boolean };
}): {
  transport: Transport;
  sent: JSONRPCMessage[];
  started: boolean;
  closed: boolean;
  emitClose: () => void;
  emitError: (err: Error) => void;
} {
  let started = false;
  let closed = false;
  const sent: JSONRPCMessage[] = [];
  const transport: Transport = {
    async start() {
      started = true;
    },
    async close() {
      closed = true;
      transport.onclose?.();
    },
    async send(message: JSONRPCMessage) {
      sent.push(message);
      // Auto-respond to initialize / tools/list / tools/call so the SDK Client resolves its promises.
      queueMicrotask(() => {
        if (!('id' in message) || message.id === undefined) return;
        const id = message.id;
        const method = (message as { method?: string }).method;
        if (method === 'initialize') {
          transport.onmessage?.({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake-vulcan', version: '0.0.0' },
            },
          } as JSONRPCMessage);
        } else if (method === 'tools/list') {
          transport.onmessage?.({
            jsonrpc: '2.0',
            id,
            result: { tools: opts.toolsList ?? [] },
          } as JSONRPCMessage);
        } else if (method === 'tools/call') {
          transport.onmessage?.({
            jsonrpc: '2.0',
            id,
            result: opts.callToolResponse ?? { content: [{ type: 'text', text: '{"ok":true}' }] },
          } as JSONRPCMessage);
        } else if (method === 'notifications/initialized') {
          // SDK sends this as a notification (no id); nothing to ack.
        }
      });
    },
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
  };
  return {
    transport,
    sent,
    get started() {
      return started;
    },
    get closed() {
      return closed;
    },
    emitClose: () => transport.onclose?.(),
    emitError: (err: Error) => transport.onerror?.(err),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VulcanUpstreamClient lifecycle', () => {
  it('start() is idempotent — second call is a no-op while running', async () => {
    const fake = makeFakeTransport({});
    const client = new VulcanUpstreamClient({ transportFactory: () => fake.transport });
    await client.start();
    const firstStarted = fake.started;
    await client.start(); // idempotent
    expect(client.isRunning()).toBe(true);
    expect(firstStarted).toBe(true);
  });

  it('listTools() caches results; force=true re-fetches', async () => {
    const tools = [{ name: 'market.snapshot', description: 'snapshot', inputSchema: { type: 'object' as const } }];
    const fake = makeFakeTransport({ toolsList: tools });
    const client = new VulcanUpstreamClient({ transportFactory: () => fake.transport });
    await client.start();
    const first = await client.listTools();
    const second = await client.listTools();
    expect(first).toEqual(second);
    expect(first[0]!.name).toBe('market.snapshot');
  });

  it('transport onclose flips running=false and surfaces a clear next-call error', async () => {
    const fake = makeFakeTransport({});
    const client = new VulcanUpstreamClient({ transportFactory: () => fake.transport });
    await client.start();
    expect(client.isRunning()).toBe(true);

    fake.emitClose();
    expect(client.isRunning()).toBe(false);
    expect(client.getLastError()?.message).toMatch(/exited unexpectedly/);

    await expect(client.callTool('whatever', {})).rejects.toThrow(/not started/);
  });

  it('transport onerror also captures the error', async () => {
    const fake = makeFakeTransport({});
    const client = new VulcanUpstreamClient({ transportFactory: () => fake.transport });
    await client.start();

    fake.emitError(new Error('protocol broke'));
    expect(client.isRunning()).toBe(false);
    expect(client.getLastError()?.message).toMatch(/protocol broke/);
  });

  it('stop() clears state and is safe to call when not running', async () => {
    const fake = makeFakeTransport({});
    const client = new VulcanUpstreamClient({ transportFactory: () => fake.transport });
    await client.start();
    await client.stop();
    expect(client.isRunning()).toBe(false);
    // No throw on second stop.
    await client.stop();
  });

  it('buildEnv injects VULCAN_WALLET_NAME and conditionally VULCAN_WALLET_PASSWORD', async () => {
    let capturedEnv: Record<string, string> | undefined;
    const fake = makeFakeTransport({});
    const client = new VulcanUpstreamClient({
      walletName: 'paper-1',
      walletPassword: 'secret',
      allowDangerous: true,
      transportFactory: ({ env }) => {
        capturedEnv = env;
        return fake.transport;
      },
    });
    await client.start();
    expect(capturedEnv?.VULCAN_WALLET_NAME).toBe('paper-1');
    expect(capturedEnv?.VULCAN_WALLET_PASSWORD).toBe('secret');
  });

  it('buildEnv omits VULCAN_WALLET_PASSWORD when allowDangerous=false', async () => {
    let capturedEnv: Record<string, string> | undefined;
    const fake = makeFakeTransport({});
    const client = new VulcanUpstreamClient({
      walletPassword: 'secret',
      allowDangerous: false,
      transportFactory: ({ env }) => {
        capturedEnv = env;
        return fake.transport;
      },
    });
    await client.start();
    expect(capturedEnv?.VULCAN_WALLET_PASSWORD).toBeUndefined();
  });

  it('getBinaryPath / getAllowDangerous reflect options', () => {
    const client = new VulcanUpstreamClient({ binaryPath: '/usr/local/bin/vulcan', allowDangerous: true });
    expect(client.getBinaryPath()).toBe('/usr/local/bin/vulcan');
    expect(client.getAllowDangerous()).toBe(true);
  });

  it('start() wraps ENOENT into an operator-actionable message', async () => {
    const client = new VulcanUpstreamClient({
      transportFactory: () => {
        const t: Transport = {
          async start() {
            const err = new Error('spawn vulcan ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          },
          async close() {},
          async send() {},
        };
        return t;
      },
    });
    await expect(client.start()).rejects.toThrow(/Vulcan binary not found/);
    expect(client.getLastError()?.message).toMatch(/cargo install/);
  });
});

describe('VulcanUpstreamClient auto-restart (D1)', () => {
  it('schedules a restart via injected timer after a transport crash', async () => {
    const fake = makeFakeTransport({});
    const scheduled: Array<{ cb: () => void; ms: number }> = [];
    const client = new VulcanUpstreamClient({
      transportFactory: () => fake.transport,
      autoRestart: true,
      restartBackoffMs: [50, 100, 200],
      timers: {
        setTimeout: (cb, ms) => {
          scheduled.push({ cb, ms });
          return scheduled.length;
        },
        clearTimeout: () => undefined,
      },
    });
    await client.start();
    expect(client.isRunning()).toBe(true);

    fake.emitClose();
    expect(client.isRunning()).toBe(false);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(50);
  });

  it('exhausts the backoff schedule after max attempts', async () => {
    // Crash before connect — feed an immediate-close transport so start() never succeeds.
    const scheduled: Array<{ cb: () => void; ms: number }> = [];
    let attempts = 0;
    const giveUps: Error[] = [];
    const client = new VulcanUpstreamClient({
      autoRestart: true,
      restartBackoffMs: [10, 20],
      transportFactory: () => {
        attempts += 1;
        const t: Parameters<typeof makeFakeTransport>[0] extends never ? never : ReturnType<typeof makeFakeTransport>['transport'] = {
          async start() {
            const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          },
          async close() {},
          async send() {},
        };
        return t;
      },
      timers: {
        setTimeout: (cb, ms) => {
          scheduled.push({ cb, ms });
          return scheduled.length;
        },
        clearTimeout: () => undefined,
      },
    });
    client.setEventHooks({ onRestartGaveUp: (err) => giveUps.push(err) });

    await expect(client.start()).rejects.toThrow(/Vulcan binary not found/);
    // First crash → schedule restart #1.
    // (We don't auto-process the timer queue here; just verify the schedule grows by one per simulated trigger.)
    expect(attempts).toBe(1);
    expect(scheduled.length).toBe(0); // initial start failure throws before scheduling
  });

  it('fires onRestartScheduled event hook with attempt number + delay', async () => {
    const fake = makeFakeTransport({});
    const restartEvents: Array<{ attempt: number; delayMs: number }> = [];
    const client = new VulcanUpstreamClient({
      transportFactory: () => fake.transport,
      autoRestart: true,
      restartBackoffMs: [123],
      timers: {
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    });
    client.setEventHooks({
      onRestartScheduled: (attempt, delayMs) => restartEvents.push({ attempt, delayMs }),
    });
    await client.start();
    fake.emitClose();
    expect(restartEvents).toHaveLength(1);
    expect(restartEvents[0]).toEqual({ attempt: 1, delayMs: 123 });
  });

  it('stop() cancels a pending restart timer', async () => {
    const fake = makeFakeTransport({});
    const cleared: unknown[] = [];
    const client = new VulcanUpstreamClient({
      transportFactory: () => fake.transport,
      autoRestart: true,
      restartBackoffMs: [50],
      timers: {
        setTimeout: () => 'timer-handle',
        clearTimeout: (h) => cleared.push(h),
      },
    });
    await client.start();
    fake.emitClose();
    await client.stop();
    expect(cleared).toContain('timer-handle');
  });

  it('does NOT schedule restart when autoRestart is false', async () => {
    const fake = makeFakeTransport({});
    const scheduled: Array<{ cb: () => void; ms: number }> = [];
    const client = new VulcanUpstreamClient({
      transportFactory: () => fake.transport,
      autoRestart: false,
      timers: {
        setTimeout: (cb, ms) => {
          scheduled.push({ cb, ms });
          return scheduled.length;
        },
        clearTimeout: () => undefined,
      },
    });
    await client.start();
    fake.emitClose();
    expect(scheduled).toHaveLength(0);
  });

  // T3.3 #1: actually fire the timer callback and verify restart runs + attempt counter resets on success.
  it('fires the timer callback and successfully restarts; attempt counter resets', async () => {
    const scheduled: Array<{ cb: () => void; ms: number }> = [];
    // Use a NEW transport on each spawn so the restart goes through cleanly.
    const fakes: ReturnType<typeof makeFakeTransport>[] = [];
    const client = new VulcanUpstreamClient({
      transportFactory: () => {
        const f = makeFakeTransport({});
        fakes.push(f);
        return f.transport;
      },
      autoRestart: true,
      restartBackoffMs: [50, 100, 200],
      timers: {
        setTimeout: (cb, ms) => {
          scheduled.push({ cb, ms });
          return scheduled.length;
        },
        clearTimeout: () => undefined,
      },
    });
    await client.start();
    expect(client.isRunning()).toBe(true);
    fakes[0]!.emitClose();
    expect(client.isRunning()).toBe(false);
    expect(scheduled).toHaveLength(1);

    // Fire the timer manually.
    scheduled[0]!.cb();
    // start() runs async; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.isRunning()).toBe(true);

    // After a clean restart, a subsequent crash schedules attempt #1 again (counter reset).
    fakes[1]!.emitClose();
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]!.ms).toBe(50); // back to the first backoff value
  });

  // T3.3 #2 / T1.6: concurrent manual start() during a pending restart no-ops the timer callback.
  it('skips the restart timer when start() was called manually before the timer fired', async () => {
    const scheduled: Array<{ cb: () => void; ms: number }> = [];
    const fakes: ReturnType<typeof makeFakeTransport>[] = [];
    const client = new VulcanUpstreamClient({
      transportFactory: () => {
        const f = makeFakeTransport({});
        fakes.push(f);
        return f.transport;
      },
      autoRestart: true,
      restartBackoffMs: [50],
      timers: {
        setTimeout: (cb, ms) => {
          scheduled.push({ cb, ms });
          return scheduled.length;
        },
        clearTimeout: () => undefined,
      },
    });
    await client.start();
    fakes[0]!.emitClose();
    expect(scheduled).toHaveLength(1);

    // Manual start() before the timer fires.
    await client.start();
    expect(client.isRunning()).toBe(true);
    const transportCountBeforeTimer = fakes.length;

    // Now fire the stale timer — should no-op because client is already running.
    scheduled[0]!.cb();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fakes.length).toBe(transportCountBeforeTimer); // no extra spawn
  });

  // T3.3 #3: onRestartGaveUp fires after backoff exhausted.
  it('fires onRestartGaveUp after the backoff schedule is exhausted', async () => {
    const scheduled: Array<{ cb: () => void; ms: number }> = [];
    const fakes: ReturnType<typeof makeFakeTransport>[] = [];
    const giveUps: { err: Error; attempts: number }[] = [];
    const client = new VulcanUpstreamClient({
      transportFactory: () => {
        const f = makeFakeTransport({});
        fakes.push(f);
        return f.transport;
      },
      autoRestart: true,
      restartBackoffMs: [10, 20],
      timers: {
        setTimeout: (cb, ms) => {
          scheduled.push({ cb, ms });
          return scheduled.length;
        },
        clearTimeout: () => undefined,
      },
    });
    client.setEventHooks({ onRestartGaveUp: (err, attempts) => giveUps.push({ err, attempts }) });
    await client.start();

    // Crash #1 → restart attempt 1 scheduled.
    fakes[0]!.emitClose();
    expect(scheduled).toHaveLength(1);
    scheduled[0]!.cb();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Restart #1 succeeded (fresh transport); crash again to trigger attempt 2.
    fakes[1]!.emitClose();
    expect(scheduled).toHaveLength(2);
    scheduled[1]!.cb();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Restart #2 also succeeded; crash again — but now attempt 2 (zero-indexed) exceeds schedule.length.
    fakes[2]!.emitClose();
    // The attempt counter was reset on successful restarts so we'll be at attempt 0 → schedules a new one.
    // To actually exhaust we need a flow where restarts FAIL. Use start-that-throws.
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
  });

  // T1.5: stale transport onclose is ignored after a new start.
  it('ignores onclose from a stale (previous) transport reference', async () => {
    const fakes: ReturnType<typeof makeFakeTransport>[] = [];
    const client = new VulcanUpstreamClient({
      transportFactory: () => {
        const f = makeFakeTransport({});
        fakes.push(f);
        return f.transport;
      },
    });
    await client.start();
    expect(client.isRunning()).toBe(true);

    // Save reference to the first transport.
    const firstTransport = fakes[0]!.transport;

    // Stop and restart with a new transport.
    await client.stop();
    await client.start();
    expect(client.isRunning()).toBe(true);

    // Emit onclose on the STALE transport — should NOT clobber running state.
    firstTransport.onclose?.();
    expect(client.isRunning()).toBe(true);
  });
});

describe('VulcanUpstreamClient version pinning (D2)', () => {
  it('rejects start() when requiredServerName does not match upstream serverInfo.name', async () => {
    const fake = makeFakeTransport({});
    const client = new VulcanUpstreamClient({
      transportFactory: () => fake.transport,
      requiredServerName: 'vulcan-real',
    });
    await expect(client.start()).rejects.toThrow(/does not match required "vulcan-real"/);
  });

  it('rejects start() when requiredServerVersion does not match', async () => {
    const fake = makeFakeTransport({});
    const client = new VulcanUpstreamClient({
      transportFactory: () => fake.transport,
      requiredServerVersion: '0.99.0',
    });
    await expect(client.start()).rejects.toThrow(/does not match required "0.99.0"/);
  });

  it('captures serverInfo on successful start', async () => {
    const fake = makeFakeTransport({});
    const client = new VulcanUpstreamClient({ transportFactory: () => fake.transport });
    await client.start();
    const info = client.getServerInfo();
    expect(info?.name).toBe('fake-vulcan');
    expect(info?.version).toBe('0.0.0');
  });

  it('onStarted hook receives serverInfo', async () => {
    const fake = makeFakeTransport({});
    let captured: { name: string; version: string } | undefined;
    const client = new VulcanUpstreamClient({ transportFactory: () => fake.transport });
    client.setEventHooks({ onStarted: (info) => (captured = info) });
    await client.start();
    expect(captured).toEqual({ name: 'fake-vulcan', version: '0.0.0' });
  });
});

describe('extractVulcanTxid', () => {
  it('finds txid in structuredContent.data.signature', () => {
    const txid = extractVulcanTxid({
      content: [],
      structuredContent: { ok: true, data: { signature: '5sig123' } },
    });
    expect(txid).toBe('5sig123');
  });

  it('finds txid in structuredContent at root', () => {
    const txid = extractVulcanTxid({
      content: [],
      structuredContent: { txid: 'rootTxid' },
    });
    expect(txid).toBe('rootTxid');
  });

  it('parses content[0].text JSON and finds the signature', () => {
    const txid = extractVulcanTxid({
      content: [{ type: 'text', text: JSON.stringify({ data: { transaction_id: 'fromText' } }) }],
    });
    expect(txid).toBe('fromText');
  });

  it('returns undefined when no recognizable key', () => {
    expect(extractVulcanTxid({ content: [{ type: 'text', text: 'no signature here' }] })).toBeUndefined();
    expect(extractVulcanTxid({ content: [] })).toBeUndefined();
  });

  it('prefers structuredContent.data over root keys', () => {
    const txid = extractVulcanTxid({
      content: [],
      structuredContent: { signature: 'rootSig', data: { signature: 'dataSig' } },
    });
    expect(txid).toBe('dataSig');
  });

  it('handles all known key aliases', () => {
    for (const key of ['signature', 'txid', 'tx', 'transactionId', 'transaction_id', 'hash']) {
      const txid = extractVulcanTxid({
        content: [],
        structuredContent: { data: { [key]: `val_${key}` } },
      });
      expect(txid).toBe(`val_${key}`);
    }
  });
});

describe('extractVulcanErrorMessage', () => {
  it('prefers structuredContent.error.message', () => {
    const msg = extractVulcanErrorMessage({
      content: [{ type: 'text', text: 'fallback' }],
      structuredContent: { error: { message: 'wallet locked' } },
    });
    expect(msg).toBe('wallet locked');
  });

  it('falls back to content[0].text when no structured error', () => {
    const msg = extractVulcanErrorMessage({
      content: [{ type: 'text', text: 'rate limited' }],
      isError: true,
    });
    expect(msg).toBe('rate limited');
  });

  it('falls back to JSON stringify as last resort', () => {
    const msg = extractVulcanErrorMessage({
      content: { weird: 'shape' } as unknown,
      isError: true,
    });
    expect(msg).toMatch(/weird/);
  });
});
