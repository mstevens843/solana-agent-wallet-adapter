import { VulcanUpstreamClient, type VulcanUpstreamClientOptions } from './vulcanClient.js';

/**
 * Multi-wallet registry for Vulcan upstream clients.
 *
 * Vulcan binds a single wallet per subprocess (selected by `VULCAN_WALLET_NAME` at spawn). To support multiple
 * concurrent wallets (e.g., one Agentic process serving several users), this registry lazily spawns a separate
 * `VulcanUpstreamClient` per wallet name. Each wallet's subprocess stays alive once started; `stopAll()` tears
 * everything down on shutdown.
 *
 * Wallet-password resolution: defaults to a single `walletPassword` shared across all wallets. For per-wallet
 * passwords, pass `walletPasswordsByName` mapping each wallet to its password. Missing passwords fall through to
 * the base `walletPassword`; when neither is present and `allowDangerous` is true, `getOrStart` throws.
 */
export interface VulcanWalletRegistryOptions {
  /** Base options applied to every spawned client (binaryPath, allowDangerous, timeouts, etc.). */
  baseOptions: Omit<VulcanUpstreamClientOptions, 'walletName' | 'walletPassword'>;
  /**
   * Default wallet name used when callers don't specify one. Optional — callers can always pass an explicit name.
   * If unset and a call has no `walletName`, the registry throws.
   */
  defaultWalletName?: string;
  /**
   * Per-wallet password override. When a wallet name appears here, this password is used (overriding
   * `defaultWalletPassword`). Useful for serving multiple users from one Agentic process.
   */
  walletPasswordsByName?: Record<string, string>;
  /** Fallback password used for any wallet not listed in `walletPasswordsByName`. */
  defaultWalletPassword?: string;
  /**
   * T2.4: allowlist of wallet names. When set, `getOrStart(name)` rejects names outside the list.
   * Cloud multi-tenant safety — prevents agents from spawning unconfigured wallets via injected `vulcanWalletName`.
   */
  allowedWallets?: readonly string[];
  /**
   * Construction hook for tests — lets a test swap `VulcanUpstreamClient` for a stub. Defaults to `new VulcanUpstreamClient`.
   */
  clientFactory?: (options: VulcanUpstreamClientOptions) => VulcanUpstreamClient;
}

export class VulcanWalletRegistry {
  private readonly opts: VulcanWalletRegistryOptions;
  private readonly clients = new Map<string, VulcanUpstreamClient>();
  private readonly clientFactory: (options: VulcanUpstreamClientOptions) => VulcanUpstreamClient;

  constructor(opts: VulcanWalletRegistryOptions) {
    this.opts = opts;
    this.clientFactory = opts.clientFactory ?? ((o) => new VulcanUpstreamClient(o));
  }

  /** Default wallet name (if any). Surfaced via `solana_vulcan_status`. */
  getDefaultWalletName(): string | undefined {
    return this.opts.defaultWalletName;
  }

  /** Snapshot of wallets that have been started (lazily) in this process. */
  listActiveWallets(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Get a client for the given wallet, lazy-starting one if it doesn't exist yet. Idempotent — repeated calls for
   * the same wallet return the same instance.
   *
   * When `walletName` is omitted, falls back to `defaultWalletName`. When neither is available, throws.
   */
  async getOrStart(walletName?: string): Promise<VulcanUpstreamClient> {
    const resolvedName = walletName?.trim() || this.opts.defaultWalletName;
    if (!resolvedName) {
      throw new Error(
        'Vulcan wallet registry: no walletName provided and no defaultWalletName configured. Pass one explicitly or set defaultWalletName.',
      );
    }
    if (this.opts.allowedWallets && !this.opts.allowedWallets.includes(resolvedName)) {
      throw new Error(
        `Vulcan wallet "${resolvedName}" is not in the configured allowlist (${this.opts.allowedWallets.join(', ')}).`,
      );
    }
    const existing = this.clients.get(resolvedName);
    if (existing) {
      if (!existing.isRunning()) await existing.start();
      return existing;
    }
    const password = this.opts.walletPasswordsByName?.[resolvedName] ?? this.opts.defaultWalletPassword;
    if (this.opts.baseOptions.allowDangerous && !password) {
      throw new Error(
        `Vulcan wallet registry: wallet "${resolvedName}" has no password configured and allowDangerous is true. Add it to walletPasswordsByName or set defaultWalletPassword.`,
      );
    }
    const clientOpts: VulcanUpstreamClientOptions = {
      ...this.opts.baseOptions,
      walletName: resolvedName,
      ...(password ? { walletPassword: password } : {}),
    };
    const client = this.clientFactory(clientOpts);
    this.clients.set(resolvedName, client);
    try {
      await client.start();
    } catch (err) {
      // Leave the failed client in the map so subsequent `getOrStart` calls will surface the last error via
      // `client.getLastError()`. The caller can decide whether to retry.
      throw err;
    }
    return client;
  }

  /** Tear down every started subprocess. Safe to call multiple times. */
  async stopAll(): Promise<void> {
    const stops: Promise<unknown>[] = [];
    for (const client of this.clients.values()) {
      stops.push(client.stop().catch(() => undefined));
    }
    await Promise.all(stops);
    this.clients.clear();
  }
}
