import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PublicSsrContext,
  PublicSsrHandler,
} from '../cloud/publicSsrRegistry.js';
import type {
  AggregatorSnapshotStoreRecord,
  SkillInstallStoreRecord,
  SkillManifestStoreRecord,
} from '../cloud/store.js';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const OTHER_WALLET = 'So11111111111111111111111111111111111111112';

const ENV_KEYS = [
  'AGENTIC_DEV_AP2_ACP',
  'AGENTIC_DEV_WALLET_ALLOWLIST',
  'AGENTIC_PUBLIC_ORIGIN',
] as const;

type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

interface TestResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

interface RoutesModule {
  __testing: {
    WALLET_PATTERN: RegExp;
    SKILL_PATTERN: RegExp;
    walletProfileHandler: PublicSsrHandler;
    skillProfileHandler: PublicSsrHandler;
    renderWalletPage: (input: {
      walletAddress: string;
      snapshot: unknown;
      installs: readonly unknown[];
      origin: string;
    }) => string;
    renderSkillPage: (input: {
      manifest: unknown;
      snapshot: unknown;
      origin: string;
    }) => string;
    escapeHtml: (value: string) => string;
  };
}

interface RegistryModule {
  listPublicSsrHandlers: () => readonly PublicSsrHandler[];
  clearPublicSsrHandlersForTesting: () => void;
}

interface MemoryStoreModule {
  MemoryWorkflowStore: new () => {
    saveSkillManifest: (record: SkillManifestStoreRecord) => Promise<SkillManifestStoreRecord>;
    saveSkillInstall: (record: SkillInstallStoreRecord) => Promise<SkillInstallStoreRecord>;
    saveAggregatorSnapshot: (
      record: AggregatorSnapshotStoreRecord,
    ) => Promise<AggregatorSnapshotStoreRecord>;
  };
}

interface StoreCtorModule {
  systemClock: { now: () => Date };
}

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const key of ENV_KEYS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snap[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const [key, value] of Object.entries(env) as Array<
    [(typeof ENV_KEYS)[number], string | undefined]
  >) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

interface LoadedRoutes {
  routes: RoutesModule;
  handlers: readonly PublicSsrHandler[];
  registry: RegistryModule;
  storeCtor: MemoryStoreModule['MemoryWorkflowStore'];
  systemClock: { now: () => Date };
  createRenderWebServer: typeof import('../server.js')['createRenderWebServer'];
}

async function loadFreshRoutes(): Promise<LoadedRoutes> {
  vi.resetModules();
  const registry = (await import('../cloud/publicSsrRegistry.js')) as unknown as RegistryModule;
  registry.clearPublicSsrHandlersForTesting();
  const routes = (await import('../cloud/publicProfileRoutes.js')) as unknown as RoutesModule;
  const server = await import('../server.js');
  const memory = (await import('../cloud/memoryStore.js')) as unknown as MemoryStoreModule;
  const storeMod = (await import('../cloud/store.js')) as unknown as StoreCtorModule;
  return {
    routes,
    handlers: registry.listPublicSsrHandlers(),
    registry,
    storeCtor: memory.MemoryWorkflowStore,
    systemClock: storeMod.systemClock,
    createRenderWebServer: server.createRenderWebServer,
  };
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: readonly PublicSsrHandler[],
  ctx: PublicSsrContext,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end();
    return;
  }
  for (const handler of handlers) {
    const match = url.pathname.match(handler.pattern);
    if (match) {
      const handled = await handler.handle(req, res, match, ctx);
      if (handled) return;
    }
  }
  res.statusCode = 404;
  res.setHeader('content-type', 'text/plain');
  res.end('not_found');
}

async function withServer(
  env: EnvSnapshot,
  seed: (
    store: InstanceType<MemoryStoreModule['MemoryWorkflowStore']>,
  ) => Promise<void> | void,
  callback: (input: {
    port: number;
    loaded: LoadedRoutes;
  }) => Promise<void>,
): Promise<void> {
  setEnv(env);
  const loaded = await loadFreshRoutes();
  const store = new loaded.storeCtor();
  await seed(store);
  const ctx: PublicSsrContext = {
    store: store as unknown as PublicSsrContext['store'],
    clock: loaded.systemClock,
  };
  const server = createServer((req, res) => {
    void dispatch(req, res, loaded.handlers, ctx);
  });
  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind a TCP port.');
    }
    await callback({ port: address.port, loaded });
  } finally {
    await close(server);
  }
}

async function withRenderWebServer(
  env: EnvSnapshot,
  seed: (
    store: InstanceType<MemoryStoreModule['MemoryWorkflowStore']>,
  ) => Promise<void> | void,
  callback: (input: {
    port: number;
    loaded: LoadedRoutes;
  }) => Promise<void>,
): Promise<void> {
  setEnv(env);
  const loaded = await loadFreshRoutes();
  const store = new loaded.storeCtor();
  await seed(store);

  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-render-web-public-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(staticDir, 'app'));
  await writeFile(join(staticDir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');

  const server = loaded.createRenderWebServer({
    staticDir,
    store: store as unknown as PublicSsrContext['store'],
  });
  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind a TCP port.');
    }
    await callback({ port: address.port, loaded });
  } finally {
    await close(server);
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let envSnapshot: EnvSnapshot;

beforeEach(() => {
  envSnapshot = snapshotEnv();
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

const SAMPLE_MANIFEST = {
  id: 'friday-dca',
  name: 'Friday DCA',
  version: '1.0.0',
  authorWallet: DEV_WALLET,
  description: 'Buy $50 of SOL every Friday at noon.',
  category: 'dca' as const,
  schedule: { kind: 'cron' as const, spec: '0 12 * * 5' },
  action: { connectorAction: 'jupiter.swap', paramsTemplate: {} },
  caps: {
    perRunMaxAmount: '50',
    lifetimeMaxAmount: '5000',
    allowlistedTokens: ['USDC', 'SOL'],
  },
};

const SAMPLE_INSTALL = {
  id: 'install-1',
  walletAddress: DEV_WALLET,
  skillId: 'friday-dca',
  manifestVersion: '1.0.0',
  caps: SAMPLE_MANIFEST.caps,
  installedAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  status: 'active' as const,
};

const SAMPLE_WALLET_SNAPSHOT = {
  walletAddress: DEV_WALLET,
  totalSkillsInstalled: 1,
  totalExecutions: 10,
  successRate: 0.9,
  totalProfitUsd: '42.50',
  totalGasUsd: '1.25',
  installedSkillIds: ['friday-dca'],
  computedAt: '2026-05-13T12:00:00.000Z',
};

const SAMPLE_SKILL_SNAPSHOT = {
  skillId: 'friday-dca',
  installs: 5,
  totalExecutions: 50,
  successRate: 0.94,
  medianGasUsd: '0.20',
  medianApyPercent: '11.2',
  maxDrawdownPercent: '3.4',
  lastExecutionAt: '2026-05-13T11:00:00.000Z',
  computedAt: '2026-05-13T12:00:00.000Z',
};

describe('public profile SSR routes', () => {
  it('serves wallet SSR through createRenderWebServer before the SPA fallback', async () => {
    await withRenderWebServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
      async () => {},
      async ({ port }) => {
        const res = await rawRequest(port, 'GET', `/u/${DEV_WALLET}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.headers['cache-control']).toBe('public, max-age=60');
        expect(res.body).toContain('Verified on-chain track record');
        expect(res.body).not.toContain('<div id="app"></div>');
      },
    );
  }, 15_000);

  it('renders a 200 HTML page with og tags for a dev-allowlisted wallet', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET, AGENTIC_PUBLIC_ORIGIN: 'https://agentic-signer.com' },
      async () => {},
      async ({ port }) => {
        const res = await rawRequest(port, 'GET', `/u/${DEV_WALLET}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.headers['cache-control']).toBe('public, max-age=60');
        expect(res.body).toContain('<title>');
        expect(res.body).toContain('og:url');
        expect(res.body).toContain(`https://agentic-signer.com/u/${DEV_WALLET}`);
        expect(res.body).toContain(DEV_WALLET);
      },
    );
  });

  it('renders WalletStatsSnapshot data when a snapshot is seeded', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
      async (store) => {
        await store.saveAggregatorSnapshot({
          key: `wallet:${DEV_WALLET}`,
          kind: 'wallet',
          computedAt: SAMPLE_WALLET_SNAPSHOT.computedAt,
          snapshot: SAMPLE_WALLET_SNAPSHOT,
        });
      },
      async ({ port }) => {
        const res = await rawRequest(port, 'GET', `/u/${DEV_WALLET}`);
        expect(res.status).toBe(200);
        expect(res.body).toContain('90.0%');
        expect(res.body).toContain('>10<');
        expect(res.body).toContain('$42.50');
        expect(res.body).toContain('2026-05-13T12:00:00.000Z');
        expect(res.body).not.toContain('No track record yet');
      },
    );
  });

  it('renders empty-state when wallet has no snapshot yet', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
      async () => {},
      async ({ port }) => {
        const res = await rawRequest(port, 'GET', `/u/${DEV_WALLET}`);
        expect(res.status).toBe(200);
        expect(res.body).toContain('No track record yet');
      },
    );
  });

  it('lists installed skills with deep links to the skill page', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
      async (store) => {
        await store.saveSkillInstall({
          id: SAMPLE_INSTALL.id,
          walletAddress: SAMPLE_INSTALL.walletAddress,
          skillId: SAMPLE_INSTALL.skillId,
          status: SAMPLE_INSTALL.status,
          installedAt: SAMPLE_INSTALL.installedAt,
          updatedAt: SAMPLE_INSTALL.updatedAt,
          install: SAMPLE_INSTALL,
        });
      },
      async ({ port }) => {
        const res = await rawRequest(port, 'GET', `/u/${DEV_WALLET}`);
        expect(res.status).toBe(200);
        expect(res.body).toContain('<a href="/skills/friday-dca">');
      },
    );
  });

  it('renders an empty public page for a wallet outside the old dev allowlist', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
      async () => {},
      async ({ port }) => {
        const res = await rawRequest(port, 'GET', `/u/${OTHER_WALLET}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.headers['cache-control']).toBe('public, max-age=60');
        expect(res.body).toContain('No skills installed yet.');
      },
    );
  });

  it('does not intercept malformed wallet paths', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
      async () => {},
      async ({ port, loaded }) => {
        // Regex must reject obviously malformed addresses (too short, contains '0'/'O'/'I'/'l').
        expect('foo'.match(loaded.routes.__testing.WALLET_PATTERN)).toBeNull();
        expect('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'.match(
          loaded.routes.__testing.WALLET_PATTERN,
        )).toBeNull();
        const res = await rawRequest(port, 'GET', '/u/foo');
        expect(res.status).toBe(404);
        // Test dispatcher's default 404 (not the SSR 404 page) — proves SSR didn't intercept.
        expect(res.headers['content-type']).toBe('text/plain');
      },
    );
  });

  it('renders a skill page for a dev-authored manifest', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET, AGENTIC_PUBLIC_ORIGIN: 'https://agentic-signer.com' },
      async (store) => {
        await store.saveSkillManifest({
          id: SAMPLE_MANIFEST.id,
          version: SAMPLE_MANIFEST.version,
          authorWallet: SAMPLE_MANIFEST.authorWallet,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
          manifest: SAMPLE_MANIFEST,
        });
        await store.saveAggregatorSnapshot({
          key: `skill:${SAMPLE_MANIFEST.id}`,
          kind: 'skill',
          computedAt: SAMPLE_SKILL_SNAPSHOT.computedAt,
          snapshot: SAMPLE_SKILL_SNAPSHOT,
        });
      },
      async ({ port }) => {
        const res = await rawRequest(port, 'GET', `/skills/${SAMPLE_MANIFEST.id}`);
        expect(res.status).toBe(200);
        expect(res.body).toContain('Friday DCA');
        expect(res.body).toContain('Buy $50 of SOL every Friday at noon.');
        expect(res.body).toContain('/app#skills/install/friday-dca');
        expect(res.body).toContain(`/u/${DEV_WALLET}`);
        expect(res.body).toContain('94.0%');
        expect(res.body).toContain(
          `<link rel="canonical" href="https://agentic-signer.com/skills/friday-dca" />`,
        );
      },
    );
  });

  it('returns 404 for an unseeded skill id', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
      async () => {},
      async ({ port }) => {
        const res = await rawRequest(port, 'GET', '/skills/nonexistent');
        expect(res.status).toBe(404);
        expect(res.body).toContain('Not found');
      },
    );
  });

  it('seeds launch skills before serving public skill pages', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET, AGENTIC_PUBLIC_ORIGIN: 'https://agentic-signer.com' },
      async () => {},
      async ({ port }) => {
        const res = await rawRequest(port, 'GET', '/skills/friday-dca');
        expect(res.status).toBe(200);
        expect(res.body).toContain('Friday DCA');
        expect(res.body).toContain(
          `<link rel="canonical" href="https://agentic-signer.com/skills/friday-dca" />`,
        );
      },
    );
  });

  it('renders a skill page when the manifest author is outside the old dev allowlist', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
      async (store) => {
        await store.saveSkillManifest({
          id: 'shady-skill',
          version: '0.1.0',
          authorWallet: OTHER_WALLET,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
          manifest: { ...SAMPLE_MANIFEST, id: 'shady-skill', authorWallet: OTHER_WALLET },
        });
      },
      async ({ port }) => {
        const res = await rawRequest(port, 'GET', '/skills/shady-skill');
        expect(res.status).toBe(200);
        expect(res.body).toContain('shady-skill');
      },
    );
  });

  it('HTML-escapes manifest fields to prevent XSS', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
      async (store) => {
        const evilManifest = {
          ...SAMPLE_MANIFEST,
          id: 'friday-dca',
          name: '<script>alert(1)</script>',
          description: '"><img src=x onerror=alert(2)>',
        };
        await store.saveSkillManifest({
          id: evilManifest.id,
          version: evilManifest.version,
          authorWallet: evilManifest.authorWallet,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
          manifest: evilManifest,
        });
      },
      async ({ port }) => {
        const res = await rawRequest(port, 'GET', '/skills/friday-dca');
        expect(res.status).toBe(200);
        expect(res.body).not.toContain('<script>alert(1)</script>');
        expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(res.body).not.toContain('"><img src=x');
        expect(res.body).not.toContain('<img src=x onerror=');
        expect(res.body).toContain('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;');
      },
    );
  });

  it('responds to HEAD with headers but no body', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
      async () => {},
      async ({ port }) => {
        const res = await rawRequest(port, 'HEAD', `/u/${DEV_WALLET}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.headers['cache-control']).toBe('public, max-age=60');
        expect(res.body).toBe('');
      },
    );
  });

  it('produces byte-identical HTML for identical inputs (output stability)', async () => {
    await withServer(
      { AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET },
      async () => {},
      async ({ loaded }) => {
        const args = {
          walletAddress: DEV_WALLET,
          snapshot: SAMPLE_WALLET_SNAPSHOT,
          installs: [SAMPLE_INSTALL],
          origin: 'https://agentic-signer.com',
        };
        const first = loaded.routes.__testing.renderWalletPage(args);
        const second = loaded.routes.__testing.renderWalletPage(args);
        expect(first).toBe(second);

        const skillArgs = {
          manifest: SAMPLE_MANIFEST,
          snapshot: SAMPLE_SKILL_SNAPSHOT,
          origin: 'https://agentic-signer.com',
        };
        const skillFirst = loaded.routes.__testing.renderSkillPage(skillArgs);
        const skillSecond = loaded.routes.__testing.renderSkillPage(skillArgs);
        expect(skillFirst).toBe(skillSecond);
      },
    );
  });
});
