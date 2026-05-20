import { describe, expect, it, vi } from 'vitest';

import { VulcanWalletRegistry } from '../../upstreamMcp/vulcanWalletRegistry.js';
import type { VulcanUpstreamClient, VulcanUpstreamClientOptions } from '../../upstreamMcp/vulcanClient.js';

/** Builds a stub VulcanUpstreamClient that records the options it was constructed with and tracks lifecycle. */
function makeStubClient(options: VulcanUpstreamClientOptions): VulcanUpstreamClient {
  let running = false;
  const stub = {
    options,
    isRunning: () => running,
    async start() {
      running = true;
    },
    async stop() {
      running = false;
    },
    async listTools() {
      return [];
    },
    async callTool() {
      return { content: [] };
    },
    getServerInfo: () => undefined,
    getLastError: () => undefined,
    getBinaryPath: () => options.binaryPath ?? 'vulcan',
    getAllowDangerous: () => options.allowDangerous ?? false,
    getWalletName: () => options.walletName,
    setEventHooks: () => undefined,
  };
  return stub as unknown as VulcanUpstreamClient;
}

describe('VulcanWalletRegistry', () => {
  it('lazy-spawns a client per wallet name', async () => {
    const factory = vi.fn(makeStubClient);
    const registry = new VulcanWalletRegistry({
      baseOptions: { binaryPath: 'vulcan' },
      defaultWalletPassword: undefined,
      clientFactory: factory,
    });
    const a = await registry.getOrStart('alice');
    const b = await registry.getOrStart('bob');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
    expect(registry.listActiveWallets().sort()).toEqual(['alice', 'bob']);
  });

  it('returns the same client for repeat calls with the same wallet', async () => {
    const factory = vi.fn(makeStubClient);
    const registry = new VulcanWalletRegistry({ baseOptions: {}, clientFactory: factory });
    const first = await registry.getOrStart('alice');
    const second = await registry.getOrStart('alice');
    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('falls back to defaultWalletName when no name provided', async () => {
    const factory = vi.fn(makeStubClient);
    const registry = new VulcanWalletRegistry({
      baseOptions: {},
      defaultWalletName: 'default-wallet',
      clientFactory: factory,
    });
    await registry.getOrStart();
    expect(registry.listActiveWallets()).toEqual(['default-wallet']);
  });

  it('throws when no wallet name and no default', async () => {
    const registry = new VulcanWalletRegistry({ baseOptions: {}, clientFactory: makeStubClient });
    await expect(registry.getOrStart()).rejects.toThrow(/no walletName provided/);
  });

  it('routes wallet-specific passwords via walletPasswordsByName', async () => {
    let captured: VulcanUpstreamClientOptions | undefined;
    const registry = new VulcanWalletRegistry({
      baseOptions: { allowDangerous: true },
      defaultWalletPassword: 'default-pass',
      walletPasswordsByName: { alice: 'alice-pass' },
      clientFactory: (opts) => {
        captured = opts;
        return makeStubClient(opts);
      },
    });
    await registry.getOrStart('alice');
    expect(captured?.walletPassword).toBe('alice-pass');
  });

  it('falls back to defaultWalletPassword when wallet has no override', async () => {
    let captured: VulcanUpstreamClientOptions | undefined;
    const registry = new VulcanWalletRegistry({
      baseOptions: { allowDangerous: true },
      defaultWalletPassword: 'default-pass',
      clientFactory: (opts) => {
        captured = opts;
        return makeStubClient(opts);
      },
    });
    await registry.getOrStart('bob');
    expect(captured?.walletPassword).toBe('default-pass');
  });

  it('throws when allowDangerous=true but no password is available', async () => {
    const registry = new VulcanWalletRegistry({
      baseOptions: { allowDangerous: true },
      clientFactory: makeStubClient,
    });
    await expect(registry.getOrStart('alice')).rejects.toThrow(/no password configured/);
  });

  it('allows missing password when allowDangerous=false (read-only mode)', async () => {
    const registry = new VulcanWalletRegistry({
      baseOptions: { allowDangerous: false },
      clientFactory: makeStubClient,
    });
    await expect(registry.getOrStart('alice')).resolves.toBeDefined();
  });

  it('stopAll() tears down every started client', async () => {
    const clients: VulcanUpstreamClient[] = [];
    const registry = new VulcanWalletRegistry({
      baseOptions: {},
      clientFactory: (opts) => {
        const c = makeStubClient(opts);
        clients.push(c);
        return c;
      },
    });
    await registry.getOrStart('alice');
    await registry.getOrStart('bob');
    expect(clients.every((c) => c.isRunning())).toBe(true);
    await registry.stopAll();
    expect(clients.every((c) => !c.isRunning())).toBe(true);
    expect(registry.listActiveWallets()).toEqual([]);
  });

  it('exposes the default wallet name', () => {
    const registry = new VulcanWalletRegistry({
      baseOptions: {},
      defaultWalletName: 'paper-1',
      clientFactory: makeStubClient,
    });
    expect(registry.getDefaultWalletName()).toBe('paper-1');
  });

  // T2.4: allowlist enforcement.
  it('rejects wallet names outside the configured allowlist', async () => {
    const registry = new VulcanWalletRegistry({
      baseOptions: {},
      allowedWallets: ['alice', 'bob'],
      clientFactory: makeStubClient,
    });
    await expect(registry.getOrStart('evil-wallet')).rejects.toThrow(/not in the configured allowlist/);
    await expect(registry.getOrStart('evil-wallet')).rejects.toThrow(/alice, bob/);
  });

  it('accepts wallet names that match the allowlist', async () => {
    const registry = new VulcanWalletRegistry({
      baseOptions: {},
      allowedWallets: ['alice', 'bob'],
      clientFactory: makeStubClient,
    });
    await expect(registry.getOrStart('alice')).resolves.toBeDefined();
    await expect(registry.getOrStart('bob')).resolves.toBeDefined();
  });

  it('allows any wallet when no allowlist is configured', async () => {
    const registry = new VulcanWalletRegistry({
      baseOptions: {},
      clientFactory: makeStubClient,
    });
    await expect(registry.getOrStart('any-name-works')).resolves.toBeDefined();
  });
});
